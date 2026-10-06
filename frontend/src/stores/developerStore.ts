import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import { registerDeveloper, type NewDeveloperPayload } from '../utils/ledger'
import { useLedgerStore } from './ledgerStore'
import type { Developer } from '../types/developer'
import { remainingRolls } from '../utils/ratio'

type NewDeveloper = NewDeveloperPayload

export const useDeveloperStore = defineStore('developer', {
  state: () => ({
    developers: [] as Developer[],
    loading: false
  }),
  getters: {
    activeDevelopers: (state) => state.developers.filter((developer) => developer.state !== '报废'),
    /** 已用卷数以用液台账净额为准，账面字段仅作回写缓存 */
    ledgerUsedRolls(): (developer: Developer) => number {
      const ledgerStore = useLedgerStore()
      return (developer) => developer.id === undefined
        ? developer.usedRolls
        : Math.max(0, ledgerStore.netUsedByDeveloper(developer.id))
    },
    ledgerRemainingRolls(): (developer: Developer) => number {
      return (developer) => remainingRolls(developer.maxRolls, this.ledgerUsedRolls(developer))
    },
    availableRolls(): number {
      return this.activeDevelopers.reduce(
        (sum, developer) => sum + this.ledgerRemainingRolls(developer),
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
    async addDeveloper(payload: NewDeveloper): Promise<number> {
      const id = await registerDeveloper(payload)
      await this.load()
      return id
    },
    async scrap(id: number): Promise<void> {
      await db.developers.update(id, plain({ state: '报废' }))
      await this.load()
    }
  }
})
