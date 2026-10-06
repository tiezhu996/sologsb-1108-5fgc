import { defineStore } from 'pinia'
import { db } from '../utils/db'
import type { ChemLedgerEntry } from '../types/chem-ledger'

export interface LedgerSummary {
  occupied: number
  reversed: number
  count: number
}

export const useLedgerStore = defineStore('ledger', {
  state: () => ({
    entries: [] as ChemLedgerEntry[],
    loading: false
  }),
  getters: {
    sortedEntries: (state) => [...state.entries].sort((a, b) => {
      const byTime = b.createdAt.localeCompare(a.createdAt)
      return byTime !== 0 ? byTime : (b.id ?? 0) - (a.id ?? 0)
    }),
    netUsedByDeveloper: (state) => (developerId: number): number => state.entries
      .filter((entry) => entry.developerId === developerId)
      .reduce((sum, entry) => sum + entry.rolls, 0),
    summaryByDeveloper: (state) => (developerId: number): LedgerSummary => {
      const related = state.entries.filter((entry) => entry.developerId === developerId)
      return {
        occupied: related.filter((entry) => entry.kind === '占用').reduce((sum, entry) => sum + entry.rolls, 0),
        reversed: related.filter((entry) => entry.kind === '冲正').reduce((sum, entry) => sum + Math.abs(entry.rolls), 0),
        count: related.length
      }
    }
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.entries = await db.chemLedger.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    }
  }
})
