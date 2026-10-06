export type LedgerKind = '占用' | '冲正'
export type LedgerSource = '实冲确认' | '撤销冲正' | '历史迁移' | '未知来源'

export interface ChemLedgerEntry {
  id?: number
  /** 台账唯一编号（幂等键）：占用 OCC-{批次号}，冲正 REV-{批次号}，旧账补齐 OCC-LEGACY-D{工作液ID} */
  entryNo: string
  batchNo: string
  /** 来源冲洗记录；缺失（null）表示未知来源 */
  runId: number | null
  /** 占用的工作液；无法确认归属时为 null */
  developerId: number | null
  kind: LedgerKind
  /** 占用为正，冲正为负，净用量按 rolls 求和 */
  rolls: number
  source: LedgerSource
  createdAt: string
  schemaRev?: number
}
