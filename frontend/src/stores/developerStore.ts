import { defineStore } from 'pinia'
import { db, plain, CURRENT_SCHEMA_REV } from '../utils/db'
import { publishSync } from '../utils/sync-channel'
import type { Developer } from '../types/developer'
import type { LiquidLedgerEntry } from '../types/liquid-ledger'
import { remainingRolls } from '../utils/ratio'
import { useLedgerStore } from './ledgerStore'

type NewDeveloper = Omit<Developer, 'id' | 'schemaRev'>

export const useDeveloperStore = defineStore('developer', {
  state: () => ({
    developers: [] as Developer[],
    loading: false
  }),
  getters: {
    activeDevelopers: (state) => state.developers.filter((developer) => developer.state !== '报废'),
    // 工作液已用卷数以台账净占用为准（账面 usedRolls 有争议时以台账覆盖）
    usedByDeveloper(): (developerId?: number) => number {
      const ledgerStore = useLedgerStore()
      return (developerId?: number) => {
        if (developerId === undefined) return 0
        return ledgerStore.usedByDeveloper(developerId)
      }
    },
    availableRolls(): number {
      const ledgerStore = useLedgerStore()
      return this.activeDevelopers.reduce(
        (sum, developer) => sum + remainingRolls(
          developer.maxRolls,
          ledgerStore.usedByDeveloper(developer.id!)
        ),
        0
      )
    }
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.developers = await db.developers.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    },

    // 登记工作液与期初占用在同一事务内提交，失败整体回滚
    async addDeveloper(payload: NewDeveloper): Promise<number> {
      const id = await db.transaction('rw', [db.developers, db.ledger], async () => {
        const next: Developer = { ...payload, schemaRev: CURRENT_SCHEMA_REV }
        const newId = await db.developers.add(plain(next)) as number
        const openingRolls = Math.max(0, Math.floor(payload.usedRolls))
        if (openingRolls > 0) {
          const entry: LiquidLedgerEntry = {
            batchNo: `INIT-${newId}`,
            kind: 'opening',
            developerId: newId,
            runId: null,
            rolls: openingRolls,
            source: 'initial',
            createdAt: new Date().toISOString(),
            note: `登记工作液时录入期初已用 ${openingRolls} 卷`,
            schemaRev: CURRENT_SCHEMA_REV
          }
          await db.ledger.add(plain(entry))
        }
        return newId
      })
      await Promise.all([this.load(), useLedgerStore().load()])
      publishSync('developer')
      publishSync('ledger')
      return id
    },

    async scrap(id: number): Promise<void> {
      await db.developers.update(id, plain({ state: '报废' }))
      await this.load()
      publishSync('developer')
    }
  }
})
