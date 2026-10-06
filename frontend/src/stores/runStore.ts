import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import { confirmRun, revokeRun, type ConfirmRunPayload, type RevokeResult } from '../utils/ledger'
import type { DevRun } from '../types/dev-run'

type NewRun = ConfirmRunPayload

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
    async addRun(payload: NewRun): Promise<number> {
      const id = await confirmRun(payload)
      await this.load()
      return id
    },
    async revokeRun(runId: number): Promise<RevokeResult> {
      const result = await revokeRun(runId)
      await this.load()
      return result
    },
    async writeBackNote(runId: number, recipeId: number): Promise<void> {
      const run = await db.runs.get(runId)
      if (!run) return
      const note = `${run.runDate} 实冲 ${run.actualTempC}°C / ${run.actualMinutes} 分钟：${run.result}`
      await db.recipes.update(recipeId, plain({ note }))
    }
  }
})
