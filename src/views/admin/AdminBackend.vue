<script setup lang="ts">
import type { LogEntry } from './AdminLog.vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { API_BASE, user } from '@/lib/api'
import { hasCapability } from '@/lib/capabilities'
import AdminLog from './AdminLog.vue'

interface UpdateStatus {
  running: boolean
  status: 'idle' | 'running' | 'success' | 'failed'
  scriptPath: string | null
  cwd: string
  pid: number | null
  startedAt: number | null
  finishedAt: number | null
  exitCode: number | null
  signal: string | null
  lastOutput: string[]
  error: string | null
}

const canRunUpdate = computed(() => hasCapability(user.value?.capabilities, 'admin:update'))
const LOG_PAGE_SIZE = 500
const backendLogs = ref<LogEntry[]>([])
const autoScroll = ref(true)
const logPage = ref(0)
const logDates = ref<string[]>([])
const selectedDate = ref('')
const historyLogs = ref<LogEntry[]>([])
const historyLoading = ref(false)
const updateSubmitting = ref(false)
const updateError = ref('')
const updateState = ref<UpdateStatus | null>(null)

/**
 * 生产环境 API 在另一个子域，凭据是 cookie 而不是请求头。
 * `credentials: 'include'` 两个方向都要：不带它，浏览器既不会发出 cookie，
 * 也不会收下响应里的 `Set-Cookie`。
 */
const credentials = { credentials: 'include' } as const

const displayLogs = computed(() => selectedDate.value ? historyLogs.value : backendLogs.value)
const totalLogPages = computed(() => Math.max(1, Math.ceil(displayLogs.value.length / LOG_PAGE_SIZE)))
const pagedLogs = computed(() => displayLogs.value.slice(logPage.value * LOG_PAGE_SIZE, (logPage.value + 1) * LOG_PAGE_SIZE))
const isUpdateBusy = computed(() => updateSubmitting.value || updateState.value?.running === true)
const latestUpdateLine = computed(() => {
  const lines = updateState.value?.lastOutput
  return lines?.[lines.length - 1] ?? ''
})

const updateSummary = computed(() => {
  const state = updateState.value

  if (state?.running)
    return `update.sh running${state.startedAt ? ` · ${formatTimestamp(state.startedAt)}` : ''}`
  if (updateError.value)
    return updateError.value
  if (state?.status === 'success')
    return `update.sh succeeded${state.finishedAt ? ` · ${formatTimestamp(state.finishedAt)}` : ''}`
  if (state?.status === 'failed')
    return `update.sh failed${state.finishedAt ? ` · ${formatTimestamp(state.finishedAt)}` : ''}`
  return ''
})

const updateDetail = computed(() => {
  const state = updateState.value
  if (!state)
    return ''

  if (state.running)
    return latestUpdateLine.value || (state.pid ? `PID ${state.pid}` : 'waiting for output')
  if (updateError.value)
    return ''
  if (state.status === 'failed')
    return state.error || latestUpdateLine.value || getExitSummary(state)
  if (state.status === 'success')
    return latestUpdateLine.value || getExitSummary(state)
  return ''
})

function formatTimestamp(value: number | null) {
  if (!value)
    return ''

  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value)
}

function getExitSummary(state: UpdateStatus) {
  if (state.exitCode !== null)
    return `exit code ${state.exitCode}`
  if (state.signal)
    return `signal ${state.signal}`
  return ''
}

function applyUpdateState(payload: unknown) {
  if (!payload || typeof payload !== 'object')
    return

  updateState.value = payload as UpdateStatus
}

async function loadLogDates() {
  const res = await fetch(`${API_BASE}/admin/log-dates`, credentials)
  if (res.ok)
    logDates.value = await res.json()
}

async function loadHistoryLogs(date: string) {
  historyLoading.value = true
  historyLogs.value = []
  logPage.value = 0

  const res = await fetch(`${API_BASE}/admin/logs/${date}`, credentials)
  if (res.ok)
    historyLogs.value = await res.json()

  historyLoading.value = false
  logPage.value = totalLogPages.value - 1
}

async function loadUpdateStatus() {
  const res = await fetch(`${API_BASE}/admin/update`, credentials)
  if (!res.ok)
    return

  const body = await res.json()
  applyUpdateState(body)
  if (body?.status && body.status !== 'idle')
    updateError.value = ''
}

async function runUpdate() {
  if (isUpdateBusy.value)
    return

  updateSubmitting.value = true
  updateError.value = ''
  selectedDate.value = ''
  autoScroll.value = true

  try {
    const res = await fetch(`${API_BASE}/admin/update`, {
      method: 'POST',
      ...credentials,
    })
    const body = await res.json().catch(() => ({}))

    if (!res.ok) {
      applyUpdateState(body.update)
      updateError.value = body.message === 'error.updateScriptMissing'
        ? 'update.sh not found'
        : body.message === 'error.updateAlreadyRunning'
          ? ''
          : 'failed to run update.sh'
      if (!body.update)
        await loadUpdateStatus()
      return
    }

    applyUpdateState(body.update)
    await loadUpdateStatus()
  }
  catch {
    updateError.value = 'failed to run update.sh'
  }
  finally {
    updateSubmitting.value = false
  }
}

watch(selectedDate, (date) => {
  logPage.value = 0
  if (date)
    loadHistoryLogs(date)
  else
    logPage.value = totalLogPages.value - 1
})

watch(() => backendLogs.value.length, () => {
  if (autoScroll.value && !selectedDate.value)
    logPage.value = totalLogPages.value - 1
})

watch(autoScroll, (value) => {
  if (value && !selectedDate.value)
    logPage.value = totalLogPages.value - 1
})

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let updatePollTimer: ReturnType<typeof setInterval> | null = null
let disposed = false

function startUpdatePolling() {
  if (updatePollTimer)
    return

  updatePollTimer = setInterval(() => {
    loadUpdateStatus().catch(() => {})
  }, 2000)
}

function stopUpdatePolling() {
  if (!updatePollTimer)
    return

  clearInterval(updatePollTimer)
  updatePollTimer = null
}

watch(() => updateState.value?.running, async (running, previous) => {
  if (running)
    startUpdatePolling()
  else
    stopUpdatePolling()

  if (previous && !running)
    await loadLogDates()
}, { immediate: true })

function connectWS() {
  // 凭据走 cookie —— `WebSocket` 构造器设不了 `Authorization` 头，这正是它以前
  // 不得不把 token 塞进 query 的原因。
  ws = new WebSocket(`${API_BASE.replace(/^http/, 'ws')}/admin/ws`)
  ws.onmessage = ({ data }) => {
    try {
      const parsed = JSON.parse(data)
      if (parsed.type === 'ping' || parsed.type === 'event')
        return
      backendLogs.value.push(parsed)
      if (backendLogs.value.length > 1000)
        backendLogs.value.shift()
    }
    catch {}
  }
  ws.onclose = () => {
    if (!disposed)
      reconnectTimer = setTimeout(connectWS, 3000)
  }
}

onMounted(async () => {
  if (!hasCapability(user.value?.capabilities, 'admin:view'))
    return

  connectWS()
  await Promise.allSettled([
    loadLogDates(),
    loadUpdateStatus(),
  ])
})

onUnmounted(() => {
  disposed = true
  ws?.close()
  if (reconnectTimer)
    clearTimeout(reconnectTimer)
  stopUpdatePolling()
})
</script>

<template>
  <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
    <div class="px-4 py-3 flex items-center gap-4 overflow-x-auto border-b bg-background">
      <div class="flex items-center gap-2 shrink-0">
        <div v-if="updateSummary || updateDetail" class="text-right leading-4">
          <div v-if="updateSummary" class="text-xs text-muted-foreground">
            {{ updateSummary }}
          </div>
          <div v-if="updateDetail" class="text-xs text-muted-foreground max-w-md truncate">
            {{ updateDetail }}
          </div>
        </div>
        <Button
          v-if="canRunUpdate"
          variant="outline"
          size="sm"
          :disabled="isUpdateBusy"
          @click="runUpdate"
        >
          {{ isUpdateBusy ? 'Running…' : 'update.sh' }}
        </Button>
      </div>
      <div class="ml-auto flex items-center gap-2 shrink-0">
        <select
          v-model="selectedDate"
          class="text-xs border rounded px-2 py-1 bg-background text-foreground"
        >
          <option value="">
            Live
          </option>
          <option v-for="d in logDates" :key="d" :value="d">
            {{ d }}
          </option>
        </select>
        <template v-if="!selectedDate">
          <label class="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input v-model="autoScroll" type="checkbox" class="size-3">
            Auto-scroll
          </label>
        </template>
        <template v-if="totalLogPages > 1">
          <Button variant="ghost" size="sm" :disabled="logPage === 0" @click="logPage--">
            Previous
          </Button>
          <span class="text-xs text-muted-foreground">{{ logPage + 1 }}/{{ totalLogPages }}</span>
          <Button variant="ghost" size="sm" :disabled="logPage >= totalLogPages - 1" @click="logPage++">
            Next
          </Button>
        </template>
        <Button v-if="!selectedDate" variant="outline" size="sm" @click="backendLogs = []">
          Clear
        </Button>
      </div>
    </div>

    <AdminLog
      :logs="pagedLogs"
      :auto-scroll="autoScroll && !selectedDate"
      :empty-text="historyLoading ? 'Loading…' : 'Waiting for logs…'"
    />
  </div>
</template>
