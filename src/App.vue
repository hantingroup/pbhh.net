<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import NavBrand from '@/components/NavBrand.vue'
import NavUser from '@/components/NavUser.vue'
import { ScrollArea } from '@/components/ui/scroll-area'
import { API_BASE, unreadCount, user } from '@/lib/api'

let sse: EventSource | null = null

onMounted(() => {
  if (!user.value)
    return
  sse = new EventSource(`${API_BASE}/events/sse`)
  sse.onmessage = (e) => {
    const event = JSON.parse(e.data) as { topic: string, payload: { recipientUsername?: string } }
    if (event.topic.startsWith('net.pbhh.notify.') && event.payload.recipientUsername === user.value?.username)
      unreadCount.value++
  }
})

onUnmounted(() => {
  sse?.close()
  sse = null
})

function getViewport(): HTMLElement | null {
  return document.querySelector('[data-reka-scroll-area-viewport]')
}

const scrollPositions = new Map<string, number>()
const router = useRouter()

const keepAlivePatterns = [/^\/post$/, /^\/@/]
const keepAliveIncludes = ['PostPage', 'UserPage']

function isKeepAlive(path: string) {
  return keepAlivePatterns.some(pattern => pattern.test(path))
}

router.beforeEach((_, from) => {
  if (isKeepAlive(from.path))
    return
  const el = getViewport()
  if (el)
    scrollPositions.set(from.path, el.scrollTop)
})

router.afterEach((to) => {
  if (isKeepAlive(to.path))
    return
  const saved = scrollPositions.get(to.path)
  requestAnimationFrame(() => {
    const el = getViewport()
    if (el)
      el.scrollTop = saved ?? 0
  })
})
</script>

<template>
  <div class="flex flex-col min-h-screen">
    <header class="h-16 px-8 border-b w-full flex justify-between items-center select-none">
      <NavBrand />
      <NavUser v-if="user" v-bind="user" />
    </header>
    <ScrollArea class="h-[calc(100vh-4rem)] w-full">
      <main class="flex flex-col items-center min-h-[calc(100vh-4rem)]">
        <RouterView v-slot="{ Component }">
          <KeepAlive :include="keepAliveIncludes">
            <component :is="Component" />
          </KeepAlive>
        </RouterView>
      </main>
    </ScrollArea>
  </div>
</template>
