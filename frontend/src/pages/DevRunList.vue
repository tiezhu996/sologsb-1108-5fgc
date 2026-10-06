<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRoute } from 'vue-router'
import EmptyPanel from '../components/common/EmptyPanel.vue'
import FilterBar from '../components/common/FilterBar.vue'
import PushPullTag from '../components/common/PushPullTag.vue'
import { useTempCompensate } from '../hooks/useTempCompensate'
import { useDeveloperStore } from '../stores/developerStore'
import { useFilmStore } from '../stores/filmStore'
import { useLedgerStore } from '../stores/ledgerStore'
import { useRecipeStore } from '../stores/recipeStore'
import { useRunStore } from '../stores/runStore'
import type { TankType } from '../types/dev-run'
import { LiquidLedgerError } from '../types/liquid-ledger'
import { remainingRolls } from '../utils/ratio'

interface FilterValue {
  keyword: string
  selections: Record<string, string[]>
}

interface RunForm {
  batchNo: string
  recipeId: number
  actualTempC: number
  actualMinutes: number
  tankType: TankType
  runDate: string
  result: string
}

const route = useRoute()
const filmStore = useFilmStore()
const developerStore = useDeveloperStore()
const ledgerStore = useLedgerStore()
const recipeStore = useRecipeStore()
const runStore = useRunStore()
const showForm = ref(false)
const saving = ref(false)
const reversingId = ref<number | null>(null)
const today = new Date().toISOString().slice(0, 10)

const querySelections = (key: string): string[] => {
  const value = route.query[key]
  return typeof value === 'string' && value ? value.split(',') : []
}

const filterValue = ref<FilterValue>({
  keyword: typeof route.query.q === 'string' ? route.query.q : '',
  selections: {
    tankType: querySelections('tankType'),
    result: querySelections('result')
  }
})

const form = reactive<RunForm>({
  batchNo: `R-${today.replace(/-/g, '')}-01`,
  recipeId: 1,
  actualTempC: 20,
  actualMinutes: 8,
  tankType: '双联罐',
  runDate: today,
  result: '密度均匀，中间调细腻'
})

const selectedRecipe = computed(() => recipeStore.recipes.find((recipe) => recipe.id === form.recipeId))
const referenceTemp = computed(() => selectedRecipe.value?.tempC ?? 20)

// 当前配方对应工作液的台账视角：余量以台账净占用为准
const selectedDeveloperInfo = computed(() => {
  const recipe = selectedRecipe.value
  const developer = developerStore.developers.find((item) => item.id === recipe?.developerId)
  if (!recipe || !developer || developer.id === undefined) {
    return { developer: null, used: 0, remaining: 0 }
  }
  const used = ledgerStore.usedByDeveloper(developer.id)
  return { developer, used, remaining: remainingRolls(developer.maxRolls, used) }
})

// 仍有余量的其他在用工作液，供到上限时给出改选提示
const alternativeCount = computed(() => {
  const currentId = selectedDeveloperInfo.value.developer?.id
  return developerStore.developers.filter((item) => {
    if (item.id === undefined || item.id === currentId || item.state === '报废') return false
    return ledgerStore.usedByDeveloper(item.id) < item.maxRolls
  }).length
})
const { suggest } = useTempCompensate(referenceTemp)
const suggestion = computed(() => {
  const recipe = selectedRecipe.value
  if (!recipe) return null
  return suggest(recipe.devMinutes, form.actualTempC)
})

watch(selectedRecipe, (recipe) => {
  if (!recipe) return
  form.actualTempC = recipe.tempC
  form.actualMinutes = recipe.devMinutes
}, { immediate: true })

const filteredRuns = computed(() => {
  const keyword = filterValue.value.keyword.trim().toLowerCase()
  const tankTypes = filterValue.value.selections.tankType ?? []
  const results = filterValue.value.selections.result ?? []
  return runStore.runs.filter((run) => {
    const recipe = recipeStore.recipes.find((item) => item.id === run.recipeId)
    const film = filmStore.films.find((item) => item.id === recipe?.filmId)
    const haystack = `${run.batchNo} ${run.result} ${film?.model ?? ''}`.toLowerCase()
    const matchesKeyword = !keyword || haystack.includes(keyword)
    const matchesTank = tankTypes.length === 0 || tankTypes.includes(run.tankType)
    const matchesResult = results.length === 0 || results.some((item) => run.result.includes(item))
    return matchesKeyword && matchesTank && matchesResult
  })
})

function recipeLabel(id: number): string {
  const recipe = recipeStore.recipes.find((item) => item.id === id)
  if (!recipe) return '未知配方'
  const film = filmStore.films.find((item) => item.id === recipe.filmId)
  const developer = developerStore.developers.find((item) => item.id === recipe.developerId)
  return `${film?.model ?? '未知胶片'} · ${developer?.name ?? '未知显影液'} · ${recipe.tempC}°C`
}

function recipeForRun(id: number) {
  return recipeStore.recipes.find((item) => item.id === id)
}

function applySuggestion(): void {
  if (!suggestion.value) return
  form.actualMinutes = suggestion.value.minutes
}

async function submitRun(): Promise<void> {
  if (!form.batchNo.trim() || !form.recipeId || !form.result.trim()) {
    ElMessage.warning('请填写批次号、配方与结果评价')
    return
  }
  // 提交前先以台账视角拦一道：报废 / 已达上限都不允许新开记录
  const { developer, used, remaining } = selectedDeveloperInfo.value
  if (!developer) {
    ElMessage.error('该配方关联的工作液来源缺失，无法占用余量，请改选来源明确的配方')
    return
  }
  if (developer.state === '报废') {
    ElMessage.error(`工作液「${developer.name}」已报废，不能再占用；请改用其他在用工作液或先报废当前瓶后改选配方`)
    return
  }
  if (remaining < 1) {
    ElMessage.error(
      `工作液「${developer.name}」已达可冲上限（${used}/${developer.maxRolls}），已拦住新记录。` +
      (alternativeCount.value > 0 ? `可改用其他 ${alternativeCount.value} 个仍有余量的在用工作液` : '请先报废当前瓶并重新配制')
    )
    return
  }

  saving.value = true
  try {
    await runStore.addRun({
      batchNo: form.batchNo.trim(),
      recipeId: Number(form.recipeId),
      actualTempC: Number(form.actualTempC),
      actualMinutes: Number(form.actualMinutes),
      tankType: form.tankType,
      runDate: form.runDate,
      result: form.result.trim()
    })
    ElMessage.success('冲洗记录已确认，用液台账已占用一卷，余量同步更新')
    form.batchNo = `R-${today.replace(/-/g, '')}-${String(runStore.runs.length + 1).padStart(2, '0')}`
    form.result = ''
    showForm.value = false
  } catch (error) {
    if (error instanceof LiquidLedgerError) {
      // 冲突/拦截发生时以数据库为准重新拉取，后提交方看到已被占用的最新状态
      await Promise.all([runStore.load(), ledgerStore.load(), developerStore.load()])
      ElMessage.error(error.message)
    } else {
      // 事务已整体回滚到写入前状态；表单内容保留，可直接重试
      ElMessage.error('写入失败，数据已恢复到提交前状态，请重试或检查浏览器存储权限')
    }
  } finally {
    saving.value = false
  }
}

function runIsReversed(batchNo: string): boolean {
  return ledgerStore.reversedBatches.has(batchNo)
}

// 未知来源（迁移缺失 / 配方找不到工作液）的占用在台账中 developerId 为空
function runSourceUnknown(batchNo: string): boolean {
  return ledgerStore.entries.some(
    (entry) => entry.batchNo === batchNo && entry.kind === 'occupy' && entry.source === 'unknown'
  )
}

async function reverseRun(runId?: number): Promise<void> {
  if (runId === undefined) return
  const run = runStore.runs.find((item) => item.id === runId)
  try {
    await ElMessageBox.confirm(
      `将保留批次「${run?.batchNo ?? runId}」的原始冲洗记录，并在用液台账追加一条冲正返还余量，确定撤销？`,
      '撤销本次实冲',
      { confirmButtonText: '追加冲正', cancelButtonText: '再想想', type: 'warning' }
    )
  } catch {
    return
  }
  reversingId.value = runId
  try {
    await runStore.reverseRun(runId)
    ElMessage.success('已追加冲正记录，原冲洗记录保留，余量已返还')
  } catch (error) {
    if (error instanceof LiquidLedgerError) {
      await Promise.all([runStore.load(), ledgerStore.load(), developerStore.load()])
      ElMessage.error(error.message)
    } else {
      ElMessage.error('写入失败，数据已恢复到撤销前状态，请重试')
    }
  } finally {
    reversingId.value = null
  }
}

async function writeBack(recipeId?: number, runId?: number): Promise<void> {
  if (recipeId === undefined || runId === undefined) return
  await runStore.writeBackNote(runId, recipeId)
  await recipeStore.load()
  ElMessage.success('本次实冲结果已回写配方注释')
}

onMounted(async () => {
  await Promise.all([filmStore.load(), developerStore.load(), ledgerStore.load(), recipeStore.load(), runStore.load()])
  if (recipeStore.recipes[0]?.id !== undefined) {
    form.recipeId = recipeStore.recipes[0].id
  }
})
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">RUN JOURNAL</span>
        <h1>冲洗记录与结果评价</h1>
        <p>记录每一次实测温度、实际时间与样片结果，让下一批参数来自真实经验。</p>
      </div>
      <button type="button" class="primary-button" data-testid="new-run" @click="showForm = !showForm">
        {{ showForm ? '收起表单' : '新建冲洗记录' }}
      </button>
    </header>

    <form v-if="showForm" class="inline-form" data-testid="form-run" @submit.prevent="submitRun">
      <div class="inline-form__head">
        <div>
          <h2>录入本次实冲</h2>
          <p>选择配方后会自动带入基准条件，可依据实测温度一键采用修正时间。</p>
        </div>
        <PushPullTag v-if="selectedRecipe" :value="selectedRecipe.pushPull" show-hint />
      </div>
      <div class="form-grid form-grid--three">
        <label>
          <span>批次号</span>
          <input v-model="form.batchNo" data-testid="field-batchNo" type="text" />
        </label>
        <label class="span-2">
          <span>冲洗配方</span>
          <select v-model.number="form.recipeId" data-testid="field-recipeId">
            <option v-for="recipe in recipeStore.recipes" :key="recipe.id" :value="recipe.id">
              {{ recipeLabel(recipe.id ?? 0) }}
            </option>
          </select>
        </label>
        <label>
          <span>实测温度</span>
          <input v-model.number="form.actualTempC" data-testid="field-actualTempC" type="number" min="10" max="50" step="0.1" />
        </label>
        <label>
          <span>实际时间</span>
          <input v-model.number="form.actualMinutes" data-testid="field-actualMinutes" type="number" min="0.25" max="90" step="0.25" />
        </label>
        <label>
          <span>罐型</span>
          <select v-model="form.tankType" data-testid="field-tankType">
            <option value="双联罐">双联罐</option>
            <option value="深罐">深罐</option>
          </select>
        </label>
        <label>
          <span>冲洗日期</span>
          <input v-model="form.runDate" data-testid="field-runDate" type="date" />
        </label>
        <label class="span-2">
          <span>结果评价</span>
          <input v-model="form.result" data-testid="field-result" type="text" placeholder="记录反差、灰雾与密度表现" />
        </label>
        <div class="span-3 compensation-callout">
          <div>
            <strong>温度补偿建议与用液台账</strong>
            <p v-if="suggestion">{{ suggestion.advice }}；确认保存后用液台账占用一卷。</p>
            <p v-else>请选择一条配方后查看修正建议。</p>
            <p v-if="selectedDeveloperInfo.developer" class="liquid-hint">
              工作液「{{ selectedDeveloperInfo.developer.name }}」台账余量：
              <strong :class="{ 'text-danger': selectedDeveloperInfo.remaining < 1 }">
                剩 {{ selectedDeveloperInfo.remaining }} 卷（已占 {{ selectedDeveloperInfo.used }}/{{ selectedDeveloperInfo.developer.maxRolls }}）
              </strong>
              <template v-if="selectedDeveloperInfo.developer.state === '报废'">· 该瓶已报废，新记录会被拦下</template>
              <template v-else-if="selectedDeveloperInfo.remaining < 1">· 已达上限，请改用其他在用工作液或先报废当前瓶</template>
            </p>
          </div>
          <button type="button" class="ghost-button" :disabled="!suggestion" @click="applySuggestion">采用修正时间</button>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="ghost-button" @click="showForm = false">取消</button>
        <button type="submit" class="primary-button" data-testid="submit-run" :disabled="saving">
          {{ saving ? '保存中…' : '保存冲洗记录' }}
        </button>
      </div>
    </form>

    <div class="stat-strip">
      <div class="simple-stat"><span>记录总数</span><strong data-testid="count-run">{{ runStore.runs.length }}</strong><small>次</small></div>
      <div class="simple-stat"><span>当前筛选</span><strong>{{ filteredRuns.length }}</strong><small>次</small></div>
      <div class="simple-stat"><span>回写配方</span><strong>{{ recipeStore.recipes.filter((item) => item.note).length }}</strong><small>条</small></div>
    </div>

    <FilterBar
      v-model="filterValue"
      :fields="[
        { key: 'tankType', label: '罐型', options: ['双联罐', '深罐'] },
        { key: 'result', label: '结果特点', options: ['密度均匀', '暗部略薄', '反差稍强', '高光保留', '灰雾'] }
      ]"
    />

    <div v-if="filteredRuns.length" class="run-list">
      <article v-for="run in filteredRuns" :key="run.id" class="run-card" data-testid="row-run">
        <div class="run-card__date">
          <strong>{{ run.runDate.slice(5) }}</strong>
          <span>{{ run.runDate.slice(0, 4) }}</span>
        </div>
        <div class="run-card__body">
          <div class="entity-card__title">
            <div>
              <h2>
                {{ run.batchNo }}
                <span v-if="runIsReversed(run.batchNo)" class="status-chip status--rose">已冲正</span>
                <span v-else-if="runSourceUnknown(run.batchNo)" class="status-chip status--amber">未知来源</span>
              </h2>
              <p>{{ recipeLabel(run.recipeId) }}</p>
            </div>
            <PushPullTag v-if="recipeForRun(run.recipeId)" :value="recipeForRun(run.recipeId)?.pushPull ?? 'N'" />
          </div>
          <div class="run-parameters">
            <span><small>实测温度</small><strong>{{ run.actualTempC }}°C</strong></span>
            <span><small>实际时间</small><strong>{{ run.actualMinutes }} 分钟</strong></span>
            <span><small>罐型</small><strong>{{ run.tankType }}</strong></span>
          </div>
          <blockquote>{{ run.result }}</blockquote>
          <div class="run-card__foot">
            <small v-if="runIsReversed(run.batchNo)">台账已追加冲正，本记录保留且余量已返还</small>
            <small v-else-if="runSourceUnknown(run.batchNo)">占用来源缺失，按未知来源保留、未扣减余量</small>
            <small v-else-if="recipeForRun(run.recipeId)?.note">配方注释：{{ recipeForRun(run.recipeId)?.note }}</small>
            <span class="run-card__actions">
              <button type="button" class="text-button" @click="writeBack(run.recipeId, run.id)">回写配方注释</button>
              <button
                type="button"
                class="text-button text-button--danger"
                :disabled="runIsReversed(run.batchNo) || reversingId === run.id"
                @click="reverseRun(run.id)"
              >{{ reversingId === run.id ? '冲正中…' : '撤销（追加冲正）' }}</button>
            </span>
          </div>
        </div>
      </article>
    </div>
    <EmptyPanel v-else title="没有符合条件的冲洗记录" description="调整罐型、结果特点或关键字后重新查看。" />
  </section>
</template>
