import { defineStore } from 'pinia'
import { db, plain, CURRENT_SCHEMA_REV } from '../utils/db'
import { publishSync } from '../utils/sync-channel'
import type { DevRun } from '../types/dev-run'
import type { LiquidLedgerEntry } from '../types/liquid-ledger'
import { LiquidLedgerError } from '../types/liquid-ledger'
import { summarizeUsed, useLedgerStore } from './ledgerStore'
import { useDeveloperStore } from './developerStore'

type NewRun = Omit<DevRun, 'id' | 'schemaRev'>

const COMMIT_ATTEMPTS = 3
const RETRY_DELAYS_MS = [80, 220]

// 仅对瞬时性 IndexedDB 错误重试；唯一约束冲突等业务错误直接抛出。
function isTransientWriteError(error: unknown): boolean {
  if (error instanceof LiquidLedgerError) return false
  const name = (error as { name?: string })?.name ?? ''
  return name === 'TransactionInactiveError' || name === 'UnknownError' || name === 'DatabaseClosedError'
}

async function withWriteRetry<T>(task: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt += 1) {
    try {
      // 每次尝试都开启全新事务；上一次失败时 IndexedDB 已整体回滚到写入前状态
      return await task()
    } catch (error) {
      lastError = error
      if (!isTransientWriteError(error) || attempt === COMMIT_ATTEMPTS - 1) break
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
    }
  }
  throw lastError
}

function mapConstraintError(error: unknown, batchNo: string): never {
  const name = (error as { name?: string })?.name ?? ''
  if (name === 'ConstraintError') {
    throw new LiquidLedgerError(
      'BATCH_OCCUPIED',
      `批次号 ${batchNo} 已被占用（可能在其他标签页已提交），本次写入已停止`
    )
  }
  throw error as Error
}

export const useRunStore = defineStore('run', {
  state: () => ({
    runs: [] as DevRun[],
    loading: false
  }),
  getters: {
    recentRuns: (state) => [...state.runs]
      .sort((a, b) => b.runDate.localeCompare(a.runDate))
      .slice(0, 6)
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.runs = await db.runs.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    },

    // 确认一次实冲：run、台账占用、工作液账面在同一个事务内提交，
    // 任一步失败整体回滚；batchNo+kind 唯一约束保证同批次不重复扣减。
    async addRun(payload: NewRun): Promise<number> {
      const batchNo = payload.batchNo.trim()
      const runId = await withWriteRetry(() => db.transaction(
        'rw',
        [db.runs, db.ledger, db.developers, db.recipes],
        async () => {
          const duplicated = await db.ledger
            .where('[batchNo+kind]')
            .equals([batchNo, 'occupy'])
            .first()
          if (duplicated) {
            throw new LiquidLedgerError(
              'BATCH_OCCUPIED',
              `批次号 ${batchNo} 已被占用（可能在其他标签页已提交），本次写入已停止`
            )
          }

          const recipe = await db.recipes.get(payload.recipeId)
          const developer = recipe ? await db.developers.get(recipe.developerId) : undefined
          if (!recipe || !developer || developer.id === undefined) {
            throw new LiquidLedgerError(
              'SOURCE_MISSING',
              '该配方关联的工作液不存在，无法占用余量，请改用来源明确的配方'
            )
          }

          const entries = await db.ledger.toArray()
          const alternatives = await this.countAlternatives(developer.id, entries)

          if (developer.state === '报废') {
            throw new LiquidLedgerError(
              'DEVELOPER_SCRAPPED',
              `工作液「${developer.name}」已报废，不能再占用；${
                alternatives > 0 ? `当前有 ${alternatives} 个在用工作液仍有余量，可改用后再提交` : '请先报废当前瓶后改选其他配方'
              }`,
              alternatives
            )
          }

          const used = summarizeUsed(entries, developer.id!)
          if (used + 1 > developer.maxRolls) {
            throw new LiquidLedgerError(
              'DEVELOPER_FULL',
              `工作液「${developer.name}」已达可冲上限（${used}/${developer.maxRolls}），本次记录已拦下；${
                alternatives > 0 ? `有 ${alternatives} 个在用工作液仍有余量，可改用后再提交` : '请先报废当前瓶并重新配制'
              }`,
              alternatives
            )
          }

          const nextRun: DevRun = { ...payload, batchNo, schemaRev: CURRENT_SCHEMA_REV }
          const newRunId = await db.runs.add(plain(nextRun))

          const entry: LiquidLedgerEntry = {
            batchNo,
            kind: 'occupy',
            developerId: developer.id,
            runId: newRunId as number,
            rolls: 1,
            source: 'run',
            createdAt: new Date().toISOString(),
            note: `实冲确认占用 ${developer.name}`,
            schemaRev: CURRENT_SCHEMA_REV
          }
          await db.ledger.add(plain(entry))
          // 账面缓存与台账保持一致；真实余量始终以台账净占用计算
          await db.developers.update(developer.id, plain({ usedRolls: used + 1 }))
          return newRunId as number
        }
      ).catch((error) => mapConstraintError(error, batchNo)))

      await Promise.all([this.load(), useLedgerStore().load(), useDeveloperStore().load()])
      publishSync('run')
      publishSync('ledger')
      publishSync('developer')
      return runId
    },

    // 在事务上下文里统计仍有余量的其他在用工作液数量，用于拦截提示
    async countAlternatives(currentDeveloperId: number, entries: LiquidLedgerEntry[]): Promise<number> {
      const developers = await db.developers.toArray()
      return developers.filter((item) => {
        if (item.id === undefined || item.id === currentDeveloperId || item.state === '报废') return false
        return summarizeUsed(entries, item.id) < item.maxRolls
      }).length
    },

    // 撤销实冲：不删除原记录，追加一条冲正（rolls 为负），余量自动返还
    async reverseRun(runId: number): Promise<void> {
      const run = await db.runs.get(runId)
      if (!run) {
        throw new LiquidLedgerError('RUN_NOT_FOUND', '冲洗记录不存在，无法撤销')
      }
      await withWriteRetry(() => db.transaction(
        'rw',
        [db.runs, db.ledger, db.developers],
        async () => {
          const occupy = await db.ledger
            .where('[batchNo+kind]')
            .equals([run.batchNo, 'occupy'])
            .first()
          if (!occupy) {
            throw new LiquidLedgerError(
              'SOURCE_MISSING',
              `批次号 ${run.batchNo} 缺少占用记录，无法冲正（台账中无对应占用）`
            )
          }
          const reversed = await db.ledger
            .where('[batchNo+kind]')
            .equals([run.batchNo, 'reverse'])
            .first()
          if (reversed) {
            throw new LiquidLedgerError(
              'ALREADY_REVERSED',
              `批次号 ${run.batchNo} 已冲正过，重复撤销不会重复返还余量`
            )
          }

          const reverseEntry: LiquidLedgerEntry = {
            batchNo: run.batchNo,
            kind: 'reverse',
            developerId: occupy.developerId,
            runId: run.id ?? null,
            rolls: -Math.abs(occupy.rolls),
            source: 'run',
            createdAt: new Date().toISOString(),
            note: `撤销实冲，冲正「${occupy.note}」；原冲洗记录保留`,
            schemaRev: CURRENT_SCHEMA_REV
          }
          await db.ledger.add(plain(reverseEntry))

          if (occupy.developerId !== null) {
            const entries = await db.ledger.toArray()
            const net = summarizeUsed(entries, occupy.developerId)
            await db.developers.update(occupy.developerId, plain({ usedRolls: net }))
          }
        }
      ).catch((error) => mapConstraintError(error, run.batchNo)))

      await Promise.all([this.load(), useLedgerStore().load(), useDeveloperStore().load()])
      publishSync('run')
      publishSync('ledger')
      publishSync('developer')
    },

    async writeBackNote(runId: number, recipeId: number): Promise<void> {
      const note = await db.transaction('r', [db.runs], async () => {
        const run = await db.runs.get(runId)
        if (!run) return null
        return `${run.runDate} 实冲 ${run.actualTempC}°C / ${run.actualMinutes} 分钟：${run.result}`
      })
      if (note === null) return
      await db.recipes.update(recipeId, plain({ note }))
      publishSync('recipe')
    }
  }
})
