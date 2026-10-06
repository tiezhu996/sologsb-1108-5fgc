import { db, plain } from './db'
import type { ChemLedgerEntry, LedgerSource } from '../types/chem-ledger'
import type { Developer } from '../types/developer'
import type { DevRun } from '../types/dev-run'

export type LedgerRejectionCode =
  | 'BATCH_OCCUPIED'
  | 'LIMIT_REACHED'
  | 'DEVELOPER_SCRAPPED'
  | 'RECIPE_MISSING'
  | 'RUN_MISSING'

/** 业务拦截：不自动重试，直接反馈给操作者 */
export class LedgerRejection extends Error {
  readonly code: LedgerRejectionCode

  constructor(code: LedgerRejectionCode, message: string) {
    super(message)
    this.name = 'LedgerRejection'
    this.code = code
  }
}

export function isLedgerRejection(error: unknown): error is LedgerRejection {
  return error instanceof LedgerRejection
    || (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'LedgerRejection')
}

export const occupyEntryNo = (batchNo: string): string => `OCC-${batchNo}`
export const reverseEntryNo = (batchNo: string): string => `REV-${batchNo}`
export const legacyEntryNo = (developerId: number): string => `OCC-LEGACY-D${developerId}`

export type ConfirmRunPayload = Omit<DevRun, 'id' | 'schemaRev' | 'status'>
export type NewDeveloperPayload = Omit<Developer, 'id' | 'schemaRev'>
export type RevokeResult = 'revoked' | 'already-revoked'

const MAX_ATTEMPTS = 2

/**
 * 事务失败时 Dexie 会自动回滚到写入前状态；
 * 非业务错误（如并发冲突）自动重试一次，业务拦截直接抛出。
 */
async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (isLedgerRejection(error)) throw error
      lastError = error
    }
  }
  throw lastError
}

async function netUsedInTx(developerId: number): Promise<number> {
  const entries = await db.chemLedger.where('developerId').equals(developerId).toArray()
  return entries.reduce((sum, entry) => sum + entry.rolls, 0)
}

/** 以台账净额回写工作液账面已用，余量有争议时以台账为准 */
async function syncUsedRollsInTx(developerId: number): Promise<void> {
  const used = await netUsedInTx(developerId)
  await db.developers.update(developerId, plain({ usedRolls: Math.max(0, used) }))
}

async function occupyOnceInTx(input: {
  entryNo: string
  batchNo: string
  runId: number | null
  developerId: number | null
  rolls: number
  source: LedgerSource
}): Promise<void> {
  const existing = await db.chemLedger.where('entryNo').equals(input.entryNo).first()
  if (existing) return
  const entry: ChemLedgerEntry = {
    entryNo: input.entryNo,
    batchNo: input.batchNo,
    runId: input.runId,
    developerId: input.developerId,
    kind: '占用',
    rolls: input.rolls,
    source: input.source,
    createdAt: new Date().toISOString(),
    schemaRev: 3
  }
  await db.chemLedger.add(plain(entry))
}

/**
 * 确认实冲：同一事务内完成批次查重、余量校验、写入冲洗记录与台账占用。
 * 两个标签页同时提交同一批号时，后进入事务的一方会读到已提交的记录并被拦截。
 */
export async function confirmRun(payload: ConfirmRunPayload): Promise<number> {
  return withRetry(async () => db.transaction('rw', [db.runs, db.chemLedger, db.recipes, db.developers], async () => {
    const duplicated = await db.runs.where('batchNo').equals(payload.batchNo).first()
    if (duplicated) {
      throw new LedgerRejection('BATCH_OCCUPIED', `批次号 ${payload.batchNo} 已被占用，本次提交未写入，请更换批次号`)
    }
    const recipe = await db.recipes.get(payload.recipeId)
    if (!recipe) {
      throw new LedgerRejection('RECIPE_MISSING', '所选配方不存在，请刷新后重试')
    }
    let developerId: number | null = null
    const developer = await db.developers.get(recipe.developerId)
    if (developer && developer.id !== undefined) {
      if (developer.state === '报废') {
        throw new LedgerRejection('DEVELOPER_SCRAPPED', `工作液「${developer.name}」已报废，请改用其他在用工作液`)
      }
      const used = await netUsedInTx(developer.id)
      if (used + 1 > developer.maxRolls) {
        throw new LedgerRejection(
          'LIMIT_REACHED',
          `工作液「${developer.name}」余量已达上限（${used}/${developer.maxRolls} 卷），新记录已拦截：请改用其他在用工作液，或先报废当前瓶`
        )
      }
      developerId = developer.id
    }
    const run: DevRun = { ...payload, status: '已确认', schemaRev: 3 }
    const runId = await db.runs.add(plain(run))
    await occupyOnceInTx({
      entryNo: occupyEntryNo(payload.batchNo),
      batchNo: payload.batchNo,
      runId,
      developerId,
      rolls: 1,
      source: developerId === null ? '未知来源' : '实冲确认'
    })
    if (developerId !== null) await syncUsedRollsInTx(developerId)
    return runId
  }))
}

/** 撤销实冲：保留原冲洗记录与占用台账，追加一笔冲正，重复撤销不会重复冲正 */
export async function revokeRun(runId: number): Promise<RevokeResult> {
  return withRetry(async () => db.transaction('rw', [db.runs, db.chemLedger, db.developers], async () => {
    const run = await db.runs.get(runId)
    if (!run) {
      throw new LedgerRejection('RUN_MISSING', '冲洗记录不存在或已被移除')
    }
    if (run.status === '已撤销') return 'already-revoked' as const
    const occupation = await db.chemLedger.where('entryNo').equals(occupyEntryNo(run.batchNo)).first()
    const entryNo = reverseEntryNo(run.batchNo)
    const existing = await db.chemLedger.where('entryNo').equals(entryNo).first()
    if (!existing) {
      const entry: ChemLedgerEntry = {
        entryNo,
        batchNo: run.batchNo,
        runId: run.id ?? null,
        developerId: occupation?.developerId ?? null,
        kind: '冲正',
        rolls: -1,
        source: '撤销冲正',
        createdAt: new Date().toISOString(),
        schemaRev: 3
      }
      await db.chemLedger.add(plain(entry))
    }
    await db.runs.update(runId, plain({ status: '已撤销' as const }))
    if (occupation && occupation.developerId !== null) await syncUsedRollsInTx(occupation.developerId)
    return 'revoked' as const
  }))
}

/** 登记工作液：携带的历史已冲卷数以未知来源占用入账，保持台账与账面一致 */
export async function registerDeveloper(payload: NewDeveloperPayload): Promise<number> {
  return withRetry(async () => db.transaction('rw', [db.developers, db.chemLedger], async () => {
    const developer: Developer = { ...payload, schemaRev: 3 }
    const id = await db.developers.add(plain(developer))
    const initialUsed = Math.max(0, Math.floor(payload.usedRolls))
    if (initialUsed > 0) {
      await occupyOnceInTx({
        entryNo: legacyEntryNo(id),
        batchNo: `旧账补齐-D${id}`,
        runId: null,
        developerId: id,
        rolls: initialUsed,
        source: '未知来源'
      })
      await syncUsedRollsInTx(id)
    }
    return id
  }))
}
