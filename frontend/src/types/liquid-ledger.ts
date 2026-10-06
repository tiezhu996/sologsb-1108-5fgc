// 用液台账（用液流水）：工作液余量以本表净占用为准。
// 一次确认实冲 = 一条 occupy；撤销不删除记录，而是追加一条 reverse 冲正。

export type LedgerKind = 'occupy' | 'reverse' | 'opening'

// run：由冲洗记录确认产生；migration：旧数据升级按历史冲洗记录补齐；
// initial：登记工作液时手工录入的期初已用；unknown：来源缺失（不扣减）
export type LedgerSource = 'run' | 'migration' | 'initial' | 'unknown'

export interface LiquidLedgerEntry {
  id?: number
  /** 业务批次号：实冲记录的 batchNo；期初占用为 INIT-<developerId> */
  batchNo: string
  /** 条目录类型，与 batchNo 组成唯一索引，保证同批次重复提交不会多扣 */
  kind: LedgerKind
  developerId: number | null
  /** 关联的冲洗记录 id（期初/未知来源可空） */
  runId: number | null
  /** 占用卷数：occupy/opening 为正，reverse 为负 */
  rolls: number
  source: LedgerSource
  createdAt: string
  note: string
  schemaRev?: number
}

export type LiquidErrorCode =
  | 'BATCH_OCCUPIED'
  | 'ALREADY_REVERSED'
  | 'DEVELOPER_FULL'
  | 'DEVELOPER_SCRAPPED'
  | 'SOURCE_MISSING'
  | 'RUN_NOT_FOUND'

export class LiquidLedgerError extends Error {
  code: LiquidErrorCode
  alternatives: number

  constructor(code: LiquidErrorCode, message: string, alternatives = 0) {
    super(message)
    this.name = 'LiquidLedgerError'
    this.code = code
    this.alternatives = alternatives
  }
}
