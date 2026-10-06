import { defineStore } from 'pinia'
import { db } from '../utils/db'
import type { LiquidLedgerEntry } from '../types/liquid-ledger'

// 台账净占用：occupy/opening 为正、reverse 为负；未知来源 rolls 为 0。
// 工作液余量一律以本汇总为准，developer.usedRolls 仅作账面缓存。
export function summarizeUsed(entries: LiquidLedgerEntry[], developerId: number): number {
  const net = entries
    .filter((entry) => entry.developerId === developerId)
    .reduce((sum, entry) => sum + entry.rolls, 0)
  return Math.max(0, net)
}

export const useLedgerStore = defineStore('ledger', {
  state: () => ({
    entries: [] as LiquidLedgerEntry[],
    loading: false
  }),
  getters: {
    // 按写入时间倒序展示流水
    recentEntries(state): LiquidLedgerEntry[] {
      return [...state.entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    usedByDeveloper(state): (developerId: number) => number {
      return (developerId: number) => summarizeUsed(state.entries, developerId)
    },
    // 已冲正（存在 reverse）的批次号集合，供冲洗记录页标记与禁用按钮
    reversedBatches(state): Set<string> {
      return new Set(
        state.entries.filter((entry) => entry.kind === 'reverse').map((entry) => entry.batchNo)
      )
    }
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.entries = await db.ledger.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    }
  }
})
