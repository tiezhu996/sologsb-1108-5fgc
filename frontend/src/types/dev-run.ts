export type TankType = '双联罐' | '深罐'
export type RunStatus = '已确认' | '已撤销'

export interface DevRun {
  id?: number
  batchNo: string
  recipeId: number
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  runDate: string
  result: string
  /** 旧数据缺省视为已确认；撤销只追加冲正台账，不删除记录 */
  status?: RunStatus
  schemaRev?: number
}
