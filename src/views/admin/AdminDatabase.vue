<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

interface StudioStatus {
  ready: boolean
  status: 'idle' | 'starting' | 'running' | 'failed'
  pid: number | null
  lastOutput: string[]
  error: string | null
}

/**
 * 刻意用同源相对路径而不是 API_BASE：这里挂的是一个 iframe，里面跑的是打过补丁的
 * studio 前端，它请求的是**页面自己这个源**上的 `/api/admin/studio/api`（补丁把
 * 上游写死的 `local.drizzle.studio` 换成了这个相对路径）。两个环境都会把 `/api`
 * 前缀转给服务端（nginx 与 vite proxy 都是剥掉前缀转发）。
 *
 * 凭据不用管：会话是 cookie，同源请求默认就带。这也是这里一次 `credentials`
 * 都不需要写的原因 —— 以前要靠 `POST /session` 换一张同源 cookie，现在不必了。
 */
const BASE = '/api/admin/studio'
const READY_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 1000

const status = ref<StudioStatus | null>(null)
const error = ref('')
const showStudio = ref(false)

let timer: ReturnType<typeof setInterval> | null = null
let deadline = 0

const headline = computed(() => {
  if (error.value)
    return error.value
  if (status.value?.status === 'failed')
    return status.value.error ?? 'Drizzle Studio 启动失败'
  if (status.value?.status === 'starting')
    return '正在启动 Drizzle Studio…'
  return '正在连接 Drizzle Studio…'
})

function stopPolling() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function poll(): Promise<'ready' | 'pending' | 'stop'> {
  if (Date.now() > deadline) {
    error.value = status.value?.error ?? 'Drizzle Studio 启动超时'
    return Promise.resolve('stop')
  }

  return fetch(`${BASE}/status`)
    .then(async (res) => {
      if (!res.ok) {
        error.value = '无法获取 Drizzle Studio 状态'
        return 'stop' as const
      }
      status.value = await res.json()
      if (status.value?.ready) {
        showStudio.value = true
        return 'ready' as const
      }
      return 'pending' as const
    })
    .catch(() => {
      error.value = '无法获取 Drizzle Studio 状态'
      return 'stop' as const
    })
}

async function start() {
  stopPolling()
  error.value = ''
  status.value = null
  showStudio.value = false
  deadline = Date.now() + READY_TIMEOUT_MS

  // 凭据就是会话 cookie 本身，同源请求自己会带上 —— `/status` 顺便会催一下
  // drizzle-kit studio 启动，所以这一次调用同时是「探活」和「拉起」。
  if (await poll() === 'pending') {
    timer = setInterval(async () => {
      if (await poll() !== 'pending')
        stopPolling()
    }, POLL_INTERVAL_MS)
  }
}

onMounted(start)
onUnmounted(stopPolling)
</script>

<template>
  <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
    <iframe
      v-if="showStudio"
      :src="`${BASE}/ui/`"
      class="flex-1 w-full min-h-0 bg-background"
      title="Drizzle Studio"
    />

    <div v-else class="flex-1 min-h-0 flex items-center justify-center p-6 overflow-auto">
      <div class="w-full max-w-lg space-y-3">
        <div class="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner v-if="!error" />
          <span>{{ headline }}</span>
        </div>

        <pre
          v-if="!showStudio && status?.lastOutput?.length"
          class="text-left text-xs bg-muted/40 rounded p-3 max-h-60 overflow-auto whitespace-pre-wrap break-all"
        >{{ status.lastOutput.join('\n') }}</pre>

        <div v-if="error" class="flex justify-center">
          <Button variant="outline" size="sm" @click="start">
            重试
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
