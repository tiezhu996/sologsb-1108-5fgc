<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import DilutionInput from '../components/common/DilutionInput.vue'
import EmptyPanel from '../components/common/EmptyPanel.vue'
import StatBadge from '../components/common/StatBadge.vue'
import { useDeveloperStore } from '../stores/developerStore'
import { useLedgerStore } from '../stores/ledgerStore'
import type { Developer, DeveloperCategory, DeveloperState, Dilution } from '../types/developer'
import type { LiquidLedgerEntry } from '../types/liquid-ledger'
import { calculateStockVolume, remainingRolls } from '../utils/ratio'

interface DeveloperForm {
  name: string
  category: DeveloperCategory
  dilution: Dilution
  volumeMl: number
  mixedAt: string
  maxRolls: number
  usedRolls: number
  state: DeveloperState
}

const developerStore = useDeveloperStore()
const ledgerStore = useLedgerStore()
const showForm = ref(false)
const saving = ref(false)
const form = reactive<DeveloperForm>({
  name: '',
  category: 'D-76',
  dilution: '1:1',
  volumeMl: 1000,
  mixedAt: new Date().toISOString().slice(0, 10),
  maxRolls: 12,
  usedRolls: 0,
  state: '新配'
})

// 台账净占用为余量的唯一真相；developer.usedRolls 只是账面缓存
function usedOf(developer: Developer): number {
  return ledgerStore.usedByDeveloper(developer.id!)
}

function remainingOf(developer: Developer): number {
  return remainingRolls(developer.maxRolls, usedOf(developer))
}

const ledgerFlow = computed(() => ledgerStore.recentEntries.slice(0, 8))

function developerName(developerId: number | null): string {
  if (developerId === null) return '未知来源'
  return developerStore.developers.find((item) => item.id === developerId)?.name ?? '未知来源'
}

const entryKindMeta: Record<LiquidLedgerEntry['kind'], { label: string, tone: 'cyan' | 'rose' | 'amber' }> = {
  occupy: { label: '占用', tone: 'amber' },
  opening: { label: '期初', tone: 'cyan' },
  reverse: { label: '冲正', tone: 'rose' }
}

function entryKindLabel(entry: LiquidLedgerEntry): string {
  return entry.source === 'unknown' ? '未知来源' : entryKindMeta[entry.kind].label
}

function entryKindTone(entry: LiquidLedgerEntry): 'cyan' | 'rose' | 'amber' {
  return entry.source === 'unknown' ? 'amber' : entryKindMeta[entry.kind].tone
}

function formatEntryTime(createdAt: string): string {
  const text = createdAt.replace('T', ' ')
  return text.length > 16 ? text.slice(0, 16) : text
}

function stateTone(developer: Developer): 'cyan' | 'amber' | 'rose' {
  if (developer.state === '报废') return 'rose'
  if (developer.state === '新配') return 'cyan'
  return 'amber'
}

async function submitDeveloper(): Promise<void> {
  if (!form.name.trim() || !form.mixedAt) {
    ElMessage.warning('请填写显影液名称与配制日期')
    return
  }
  saving.value = true
  try {
    await developerStore.addDeveloper({
      ...form,
      name: form.name.trim(),
      volumeMl: Math.max(0, form.volumeMl),
      maxRolls: Math.max(1, form.maxRolls),
      usedRolls: Math.max(0, form.usedRolls)
    })
    ElMessage.success('显影液工作液已登记')
    form.name = ''
    form.mixedAt = new Date().toISOString().slice(0, 10)
    form.maxRolls = 12
    form.usedRolls = 0
    form.state = '新配'
    showForm.value = false
  } finally {
    saving.value = false
  }
}

async function scrapDeveloper(id?: number): Promise<void> {
  if (id === undefined) return
  await developerStore.scrap(id)
  ElMessage.success('该工作液已标记为报废')
}

onMounted(() => {
  void Promise.all([developerStore.load(), ledgerStore.load()])
})
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">CHEMISTRY DESK</span>
        <h1>显影液配制与余量</h1>
        <p>记录配制日期与可冲卷数；余量以用液台账净占用为准，归零前及时安排补充或标记报废。</p>
      </div>
      <button type="button" class="primary-button" data-testid="new-developer" @click="showForm = !showForm">
        {{ showForm ? '收起表单' : '新建显影液' }}
      </button>
    </header>

    <div class="stat-strip">
      <StatBadge label="工作液总数" :value="developerStore.developers.length" hint="含新配与报废记录" tone="cyan" />
      <StatBadge label="可用余量" :value="developerStore.availableRolls" hint="按用液台账净占用合计" tone="amber" />
      <StatBadge label="已报废" :value="developerStore.developers.filter((item) => item.state === '报废').length" hint="不再计入可用余量" tone="rose" />
    </div>

    <form v-if="showForm" class="inline-form" data-testid="form-developer" @submit.prevent="submitDeveloper">
      <div class="inline-form__head">
        <div>
          <h2>登记显影液工作液</h2>
          <p>容量按工作液总量记录，稀释换算会同步估算单卷用量。</p>
        </div>
      </div>
      <div class="form-grid form-grid--three">
        <label>
          <span>名称</span>
          <input v-model="form.name" data-testid="field-name" type="text" placeholder="如 柯达 D-76 工作液 A" />
        </label>
        <label>
          <span>类型</span>
          <select v-model="form.category" data-testid="field-category">
            <option value="D-76">D-76</option>
            <option value="HC-110">HC-110</option>
            <option value="Rodinal">Rodinal</option>
            <option value="C-41">C-41</option>
          </select>
        </label>
        <label>
          <span>状态</span>
          <select v-model="form.state" data-testid="field-state">
            <option value="新配">新配</option>
            <option value="在用">在用</option>
            <option value="报废">报废</option>
          </select>
        </label>
        <div class="span-2">
          <DilutionInput
            v-model:ratio="form.dilution"
            v-model:working-volume-ml="form.volumeMl"
            ratio-test-id="field-dilution"
            volume-test-id="field-volumeMl"
          />
        </div>
        <label>
          <span>配制日期</span>
          <input v-model="form.mixedAt" data-testid="field-mixedAt" type="date" />
        </label>
        <label>
          <span>可冲上限</span>
          <input v-model.number="form.maxRolls" data-testid="field-maxRolls" type="number" min="1" max="100" />
        </label>
        <label>
          <span>期初已冲卷数</span>
          <input v-model.number="form.usedRolls" data-testid="field-usedRolls" type="number" min="0" max="100" />
          <small class="field-hint">登记后写入台账期初占用，之后余量以台账为准</small>
        </label>
      </div>
      <div class="form-actions">
        <button type="button" class="ghost-button" @click="showForm = false">取消</button>
        <button type="submit" class="primary-button" data-testid="submit-developer" :disabled="saving">
          {{ saving ? '保存中…' : '保存工作液' }}
        </button>
      </div>
    </form>

    <div class="dev-grid">
      <div class="panel dev-count-panel">
        <span>台账记录</span>
        <strong data-testid="count-developer">{{ developerStore.developers.length }}</strong>
        <small>条工作液记录</small>
      </div>
      <article
        v-for="developer in developerStore.developers"
        :key="developer.id"
        class="entity-card developer-card"
        data-testid="row-developer"
      >
        <div class="entity-card__main">
          <div class="entity-card__title">
            <div>
              <span class="status-chip" :class="`status--${stateTone(developer)}`">{{ developer.state }}</span>
              <h2>{{ developer.name }}</h2>
            </div>
            <button
              v-if="developer.state !== '报废'"
              type="button"
              class="text-button text-button--danger"
              @click="scrapDeveloper(developer.id)"
            >
              标记报废
            </button>
          </div>
          <dl class="data-pairs">
            <div><dt>类型 / 稀释</dt><dd>{{ developer.category }} · {{ developer.dilution }}</dd></div>
            <div><dt>工作液容量</dt><dd>{{ developer.volumeMl }} mL</dd></div>
            <div><dt>配制日期</dt><dd>{{ developer.mixedAt }}</dd></div>
            <div><dt>所需浓缩液</dt><dd>{{ calculateStockVolume(developer.volumeMl, developer.dilution) }} mL</dd></div>
          </dl>
          <div class="life-meter">
            <div class="life-meter__head">
              <span>剩余 {{ remainingOf(developer) }} 卷</span>
              <span>台账已用 {{ usedOf(developer) }} / {{ developer.maxRolls }}</span>
            </div>
            <div class="life-meter__track">
              <i :style="{ width: `${Math.min(100, usedOf(developer) / developer.maxRolls * 100)}%` }"></i>
            </div>
            <small v-if="remainingOf(developer) === 0">台账余量已耗尽，新冲洗记录会被拦下；可改用其他在用工作液，或报废当前瓶后重新配制。</small>
          </div>
        </div>
      </article>
    </div>

    <section class="ledger-panel" data-testid="ledger-panel">
      <header class="ledger-panel__head">
        <div>
          <h2>用液台账</h2>
          <p>每次确认实冲占用一卷，撤销保留原记录并追加冲正；余量有争议时以本台账净占用为准。</p>
        </div>
        <span class="status-chip status--cyan">共 {{ ledgerStore.entries.length }} 条流水</span>
      </header>
      <table v-if="ledgerFlow.length" class="ledger-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>批次号</th>
            <th>类型</th>
            <th>工作液</th>
            <th class="num">卷数</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in ledgerFlow" :key="entry.id" data-testid="row-ledger">
            <td>{{ formatEntryTime(entry.createdAt) }}</td>
            <td>{{ entry.batchNo }}</td>
            <td><span class="status-chip" :class="`status--${entryKindTone(entry)}`">{{ entryKindLabel(entry) }}</span></td>
            <td>{{ developerName(entry.developerId) }}</td>
            <td class="num" :class="{ 'text-danger': entry.rolls < 0 }">{{ entry.rolls > 0 ? `+${entry.rolls}` : entry.rolls }}</td>
            <td class="ledger-note">{{ entry.note }}</td>
          </tr>
        </tbody>
      </table>
      <EmptyPanel v-else title="暂无台账流水" description="确认第一条冲洗记录后会在此生成占用记录。" />
    </section>
  </section>
</template>
