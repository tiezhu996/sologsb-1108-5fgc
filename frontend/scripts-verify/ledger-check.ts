import 'fake-indexeddb/auto'
import { strict as assert } from 'node:assert'
import { setActivePinia, createPinia } from 'pinia'
import Dexie from 'dexie'
import { db, FilmDevDatabase, CURRENT_SCHEMA_REV } from '../src/utils/db'
import { useRunStore } from '../src/stores/runStore'
import { useDeveloperStore } from '../src/stores/developerStore'
import { useLedgerStore } from '../src/stores/ledgerStore'
import type { DevRun } from '../src/types/dev-run'
import type { Developer } from '../src/types/developer'
import type { DevRecipe } from '../src/types/dev-recipe'
import { LiquidLedgerError } from '../src/types/liquid-ledger'

setActivePinia(createPinia())
const runStore = useRunStore()
const developerStore = useDeveloperStore()
const ledgerStore = useLedgerStore()

let passed = 0
function ok(name: string) {
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function counts() {
  return {
    runs: await db.runs.count(),
    ledger: await db.ledger.count(),
    developers: await db.developers.count(),
    recipes: await db.recipes.count()
  }
}

async function resetDb() {
  db.close()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('gbfilmdev-db')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('delete blocked'))
  })
}

// ---------- 场景 A：全新数据库（populate 种子即带台账） ----------
{
  await Promise.all([runStore.load(), developerStore.load(), ledgerStore.load()])
  const expectUsed: Record<number, number> = { 1: 3, 2: 1, 3: 2, 4: 1, 5: 0 }
  for (const [id, used] of Object.entries(expectUsed)) {
    assert.equal(ledgerStore.usedByDeveloper(Number(id)), used, `dev${id} ledger used`)
    const dev = (await db.developers.get(Number(id)))!
    assert.equal(dev.usedRolls, used, `dev${id} 账面应与台账一致`)
  }
  assert.equal(await db.ledger.count(), 7, '种子 7 条冲洗记录对应 7 条占用')
  assert.equal(developerStore.availableRolls, (12 - 3) + (16 - 1) + (10 - 2) + (12 - 1) + 0)
  ok('全新库：种子余量全部来自台账占用')
}

// ---------- 场景 B：确认实冲，占用一次 ----------
{
  const before = await counts()
  const id = await runStore.addRun({
    batchNo: 'R-T-0001', recipeId: 4, actualTempC: 20, actualMinutes: 11,
    tankType: '双联罐', runDate: '2026-10-01', result: '测试卷'
  })
  assert.equal(await db.runs.count(), before.runs + 1)
  assert.equal(await db.ledger.count(), before.ledger + 1)
  assert.equal(ledgerStore.usedByDeveloper(3), 3, 'dev3 台账 +1（2→3）')
  const dev3 = (await db.developers.get(3))!
  assert.equal(dev3.usedRolls, 3)
  assert.ok(typeof id === 'number')
  ok('确认实冲：run 与占用同事务落账')
}

// ---------- 场景 C：同批次重复提交不能多扣 ----------
{
  const before = await counts()
  const usedBefore = ledgerStore.usedByDeveloper(3)
  await assert.rejects(
    runStore.addRun({
      batchNo: 'R-T-0001', recipeId: 4, actualTempC: 20, actualMinutes: 11,
      tankType: '双联罐', runDate: '2026-10-01', result: '重复批次'
    }),
    (e: unknown) => e instanceof LiquidLedgerError && e.code === 'BATCH_OCCUPIED'
  )
  const after = await counts()
  assert.equal(after.runs, before.runs, '重复批次不新增 run')
  assert.equal(after.ledger, before.ledger, '重复批次不新增台账')
  assert.equal(ledgerStore.usedByDeveloper(3), usedBefore, '余量未多扣')
  ok('重复批次：拒绝写入且不多扣')
}

// ---------- 场景 D：两个并发提交同一批号，仅一个成功 ----------
{
  const before = await counts()
  const payload = {
    batchNo: 'R-T-RACE', recipeId: 2, actualTempC: 20, actualMinutes: 7,
    tankType: '双联罐', runDate: '2026-10-02', result: '竞争'
  }
  const results = await Promise.allSettled([runStore.addRun({ ...payload }), runStore.addRun({ ...payload })])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1, '恰好一方成功')
  assert.equal(rejected.length, 1)
  const reason = (rejected[0] as PromiseRejectedResult).reason
  assert.ok(reason instanceof LiquidLedgerError && reason.code === 'BATCH_OCCUPIED')
  const after = await counts()
  assert.equal(after.runs, before.runs + 1, '只写入一条 run')
  assert.equal(after.ledger, before.ledger + 1, '只落一条占用')
  ok('并发同批号：唯一索引拦截后提交方')
}

// ---------- 场景 E：到上限拦住新记录 ----------
{
  const devId = await developerStore.addDeveloper({
    name: '极限测试液', category: 'D-76', dilution: '1:1', volumeMl: 300,
    mixedAt: '2026-10-01', maxRolls: 1, usedRolls: 0, state: '在用'
  })
  await ledgerStore.load()
  const recipeId = await db.recipes.add({
    filmId: 1, developerId: devId, dilution: '1:1', tempC: 20, devMinutes: 9,
    agitation: 'x', stopBath: 'x', fixer: 'x', washMinutes: 10, pushPull: 'N',
    schemaRev: CURRENT_SCHEMA_REV
  }) as number
  const base = { recipeId, actualTempC: 20, actualMinutes: 9, tankType: '双联罐' as const }
  await runStore.addRun({ ...base, batchNo: 'R-T-FULL1', runDate: '2026-10-03', result: '第一卷' })
  assert.equal(ledgerStore.usedByDeveloper(devId), 1)
  await assert.rejects(
    runStore.addRun({ ...base, batchNo: 'R-T-FULL2', runDate: '2026-10-03', result: '第二卷应被拦' }),
    (e: unknown) => e instanceof LiquidLedgerError && e.code === 'DEVELOPER_FULL' && e.alternatives > 0,
    '应提示有其他在用工作液'
  )
  const dev = (await db.developers.get(devId))!
  assert.equal(dev.usedRolls, 1, '拦截后余量不变')
  const runCount = await db.runs.where('recipeId').equals(recipeId).count()
  assert.equal(runCount, 1, '拦截后不落 run')
  ok('达上限：硬拦截并提示改用其他在用工作液')
}

// ---------- 场景 F：撤销保留原记录并追加冲正，可再次占用 ----------
{
  const ledgerBefore = await db.ledger.count()
  const runId = (await db.runs.filter((r) => r.batchNo === 'R-T-FULL1').first())!.id!
  await runStore.reverseRun(runId)
  assert.ok(await db.runs.get(runId), '原冲洗记录保留')
  assert.equal(await db.ledger.count(), ledgerBefore + 1, '只追加一条冲正')
  const entries = await db.ledger.filter((e) => e.batchNo === 'R-T-FULL1').toArray()
  assert.deepEqual(entries.map((e) => e.kind).sort(), ['occupy', 'reverse'])
  assert.equal(entries.find((e) => e.kind === 'reverse')!.rolls, -1)

  // 场景 E 中的 1 卷上限工作液：冲正后净占用归零，可以再冲
  const devId = (await db.developers.filter((d) => d.name === '极限测试液').first())!.id!
  assert.equal(ledgerStore.usedByDeveloper(devId), 0)

  // 重复撤销不重复返还
  await assert.rejects(
    runStore.reverseRun(runId),
    (e: unknown) => e instanceof LiquidLedgerError && e.code === 'ALREADY_REVERSED'
  )
  assert.equal(ledgerStore.usedByDeveloper(devId), 0, '重复冲正不多返还')
  assert.equal(await db.ledger.filter((e) => e.batchNo === 'R-T-FULL1').count(), 2)
  ok('撤销：保留原记录 + 追加冲正 + 幂等不重复返还')
}

// ---------- 场景 G：报废瓶不能占用 ----------
{
  const devId = (await db.developers.filter((d) => d.name === '极限测试液').first())!.id!
  await developerStore.scrap(devId)
  const recipeId = (await db.recipes.where('developerId').equals(devId).first())!.id!
  await assert.rejects(
    runStore.addRun({
      batchNo: 'R-T-SCRAP', recipeId, actualTempC: 20, actualMinutes: 9,
      tankType: '双联罐', runDate: '2026-10-04', result: '报废液'
    }),
    (e: unknown) => e instanceof LiquidLedgerError && e.code === 'DEVELOPER_SCRAPPED'
  )
  ok('报废工作液：拒绝占用')
}

// ---------- 场景 H：登记工作液的期初已用写入 opening ----------
{
  const id = await developerStore.addDeveloper({
    name: '期初测试液', category: 'Rodinal', dilution: '1:3', volumeMl: 500,
    mixedAt: '2026-10-01', maxRolls: 10, usedRolls: 3, state: '在用'
  })
  const opening = await db.ledger.where('[batchNo+kind]').equals([`INIT-${id}`, 'opening']).first()
  assert.ok(opening, '期初占用落账')
  assert.equal(opening!.rolls, 3)
  assert.equal(ledgerStore.usedByDeveloper(id), 3)
  ok('期初已用：以 opening 流水入账')
}

// ---------- 场景 I：旧数据 v2 → v3 升级 ----------
await resetDb()
{
  // 用仅含 v1/v2 的临时实例构造旧库
  class LegacyDb extends Dexie {
    films!: Dexie.Table<unknown, number>
    developers!: Dexie.Table<Developer, number>
    recipes!: Dexie.Table<DevRecipe, number>
    runs!: Dexie.Table<DevRun, number>
    constructor() {
      super('gbfilmdev-db')
      this.version(1).stores({
        films: '++id',
        developers: '++id, category, state, mixedAt',
        recipes: '++id, filmId, developerId',
        runs: '++id, recipeId, runDate, tankType'
      })
      this.version(2).stores({
        films: '++id',
        developers: '++id, category, state, mixedAt',
        recipes: '++id, filmId, developerId',
        runs: '++id, recipeId, runDate, tankType'
      })
    }
  }
  const legacy = new LegacyDb()
  await legacy.developers.bulkAdd([
    { id: 1, name: '旧液A', category: 'D-76', dilution: '1:1', volumeMl: 1000, mixedAt: '2026-08-01', maxRolls: 10, usedRolls: 9, state: '在用', schemaRev: 2 },
    { id: 2, name: '旧液B', category: 'HC-110', dilution: '1:3', volumeMl: 1000, mixedAt: '2026-08-02', maxRolls: 16, usedRolls: 0, state: '新配', schemaRev: 2 }
  ])
  await legacy.recipes.bulkAdd([
    { id: 1, filmId: 1, developerId: 1, dilution: '1:1', tempC: 20, devMinutes: 9, agitation: 'x', stopBath: 'x', fixer: 'x', washMinutes: 10, pushPull: 'N', schemaRev: 2 },
    { id: 2, filmId: 1, developerId: 2, dilution: '1:3', tempC: 20, devMinutes: 7, agitation: 'x', stopBath: 'x', fixer: 'x', washMinutes: 10, pushPull: 'N', schemaRev: 2 }
  ])
  await legacy.runs.bulkAdd([
    { id: 1, batchNo: 'OLD-1', recipeId: 1, actualTempC: 20, actualMinutes: 9, tankType: '双联罐', runDate: '2026-09-01', result: 'a', schemaRev: 2 },
    { id: 2, batchNo: 'OLD-1', recipeId: 1, actualTempC: 20, actualMinutes: 9, tankType: '双联罐', runDate: '2026-09-01', result: 'a 重复批次', schemaRev: 2 },
    { id: 3, batchNo: 'OLD-2', recipeId: 2, actualTempC: 20, actualMinutes: 7, tankType: '深罐', runDate: '2026-09-02', result: 'b', schemaRev: 2 },
    { id: 4, batchNo: 'OLD-3', recipeId: 999, actualTempC: 20, actualMinutes: 7, tankType: '深罐', runDate: '2026-09-03', result: '来源缺失', schemaRev: 2 }
  ])
  await legacy.close()

  const upgraded = new FilmDevDatabase()
  const entries = await upgraded.ledger.toArray()
  // 4 条 run，其中 OLD-1 重复只补一次 → 3 条占用（OLD-1 / OLD-2 / OLD-3）
  assert.equal(entries.length, 3, '同批次只补齐一次')
  const old1 = entries.find((e) => e.batchNo === 'OLD-1')!
  const old2 = entries.find((e) => e.batchNo === 'OLD-2')!
  const old3 = entries.find((e) => e.batchNo === 'OLD-3')!
  assert.equal(old1.source, 'migration')
  assert.equal(old1.developerId, 1)
  assert.equal(old1.rolls, 1)
  assert.equal(old3.source, 'unknown', '来源缺失按未知来源保留')
  assert.equal(old3.developerId, null)
  assert.equal(old3.rolls, 0, '未知来源不扣减')

  const dev1 = await upgraded.developers.get(1)
  const dev2 = await upgraded.developers.get(2)
  assert.equal(dev1!.usedRolls, 1, '账面 9 被台账净占用 1 覆盖（以台账为准）')
  assert.equal(dev2!.usedRolls, 1)
  assert.equal(dev1!.schemaRev, CURRENT_SCHEMA_REV)
  await upgraded.close()
  ok('v2→v3 升级：按历史记录补齐、未知来源保留不扣、不重复扣减、账面以台账为准')
}

console.log(`\n全部 ${passed} 项运行时校验通过`)
process.exit(0)
