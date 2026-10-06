<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useDeveloperStore } from './stores/developerStore'
import { useFilmStore } from './stores/filmStore'
import { useLedgerStore } from './stores/ledgerStore'
import { useRecipeStore } from './stores/recipeStore'
import { useRunStore } from './stores/runStore'
import { onSync, type SyncTopic } from './utils/sync-channel'
import { CURRENT_SCHEMA_REV } from './utils/db'
import { downloadJson } from './utils/export'

const route = useRoute()
const filmStore = useFilmStore()
const developerStore = useDeveloperStore()
const ledgerStore = useLedgerStore()
const recipeStore = useRecipeStore()
const runStore = useRunStore()

const navItems = [
  { path: '/', label: '参数速查' },
  { path: '/films', label: '胶片台账' },
  { path: '/developers', label: '显影液' },
  { path: '/recipes', label: '配方表' },
  { path: '/runs', label: '冲洗记录' }
]

function isActive(path: string): boolean {
  return path === '/' ? route.path === '/' : route.path.startsWith(path)
}

function exportAll(): void {
  downloadJson(`gbfilmdev-backup-${new Date().toISOString().slice(0, 10)}.json`, {
    exportedAt: new Date().toISOString(),
    schemaRev: CURRENT_SCHEMA_REV,
    films: filmStore.films,
    developers: developerStore.developers,
    recipes: recipeStore.recipes,
    runs: runStore.runs,
    ledger: ledgerStore.entries
  })
}

// 其他标签页写入后，本页以数据库为准重新拉取，避免按旧余量重复提交
function reloadTopic(topic: SyncTopic): void {
  if (topic === 'developer') void developerStore.load()
  if (topic === 'ledger') void ledgerStore.load()
  if (topic === 'recipe') void recipeStore.load()
  if (topic === 'run') void runStore.load()
}

let stopSync: (() => void) | null = null

onMounted(async () => {
  await Promise.all([
    filmStore.load(),
    developerStore.load(),
    ledgerStore.load(),
    recipeStore.load(),
    runStore.load()
  ])
  stopSync = onSync(reloadTopic)
})

onUnmounted(() => {
  stopSync?.()
})
</script>