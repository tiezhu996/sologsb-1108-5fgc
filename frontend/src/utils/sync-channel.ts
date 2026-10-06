// 跨标签页数据变更通知：A 标签页写入后，B 标签页重新从 Dexie 拉取，
// 始终以数据库（含台账）为准。BroadcastChannel 不可用时退化为 storage 事件。

export type SyncTopic = 'run' | 'developer' | 'recipe' | 'ledger'

type SyncMessage = {
  channel: 'gbfilmdev-sync'
  topic: SyncTopic
}

const CHANNEL_NAME = 'gbfilmdev-sync'
const STORAGE_KEY = 'gbfilmdev-sync-ping'

let channel: BroadcastChannel | null = null
const listeners = new Set<(topic: SyncTopic) => void>()

if (typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = (event: MessageEvent<SyncMessage>) => {
    if (event.data?.channel === CHANNEL_NAME) {
      listeners.forEach((listener) => listener(event.data.topic))
    }
  }
} else if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    try {
      const data = JSON.parse(event.newValue) as SyncMessage
      if (data.channel === CHANNEL_NAME) {
        listeners.forEach((listener) => listener(data.topic))
      }
    } catch {
      // 忽略无法解析的跨页信号
    }
  })
}

export function publishSync(topic: SyncTopic): void {
  const payload: SyncMessage = { channel: CHANNEL_NAME, topic }
  if (channel) {
    channel.postMessage(payload)
  } else if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...payload, at: Date.now() }))
  }
}

export function onSync(listener: (topic: SyncTopic) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
