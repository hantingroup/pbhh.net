<script setup lang="ts">
import { onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'
import { Translation, useI18n } from 'vue-i18n'
import PostCompose from '@/components/PostCompose.vue'
import PostList from '@/components/PostList.vue'
import { useScrollRestore } from '@/composables/useScrollRestore'
import { API_BASE, user } from '@/lib/api'

defineOptions({ name: 'PostPage' })

const { t } = useI18n()

const postList = ref<InstanceType<typeof PostList> | null>(null)

let sse: EventSource | null = null

/** 这个话题在服务端的匿名白名单里，所以未登录也能收。 */
const FEED_TOPIC = 'net.pbhh.post.created'

const SSE_URL = `${API_BASE}/events/sse?topics=${FEED_TOPIC}`

/** `withCredentials: false` 在跨源时等同于「不带凭据」，也就是匿名连接。 */
function connect(withCredentials: boolean) {
  sse = new EventSource(SSE_URL, { withCredentials })
  sse.onmessage = (e) => {
    const { topic } = JSON.parse(e.data) as { topic: string }
    if (topic === FEED_TOPIC)
      postList.value?.reload()
  }
  return sse
}

function openSse() {
  // 凭据失效（过期、或在别处登出过）时服务端回 401，而 EventSource 把非 200 响应
  // 视为**致命**错误、不会自动重连 —— 实时刷新会就此静默停摆到下次刷新页面。
  // 这个话题本身在匿名白名单里，所以退回不带凭据的连接。
  //
  // **只退一次**：再失败说明问题不在凭据，继续重连就是 401 → 重连 → 401 的死循环。
  // 同理只在浏览器彻底放弃时接手 —— 瞬时断网时 readyState 还是 CONNECTING，
  // EventSource 自己会重连，不该被我们抢过去关掉。
  let retried = false
  const open = (withCredentials: boolean) => {
    const es = connect(withCredentials)
    es.onerror = () => {
      if (sse !== es || es.readyState !== EventSource.CLOSED)
        return
      es.close()
      if (!retried) {
        retried = true
        // dev 下 API 与页面同源，而 `withCredentials` 只影响跨源请求，这条退路
        // 在那里退不掉 cookie；`retried` 就是为这种情况兜底的。
        open(false)
      }
    }
  }
  open(true)
}

function closeSse() {
  sse?.close()
  sse = null
}

onMounted(openSse)
onUnmounted(closeSse)
onActivated(openSse)
onDeactivated(closeSse)
useScrollRestore()
</script>

<template>
  <div class="w-full mb-auto max-w-2xl px-4 py-8 space-y-4">
    <PostCompose v-if="user" @posted="postList?.reload()" />
    <div v-else class="text-center text-muted-foreground text-sm pb-4">
      <Translation keypath="post.loginRequired">
        <template #login>
          <RouterLink to="/login" class="link">
            {{ t('home.loginLink') }}
          </RouterLink>
        </template>
      </Translation>
    </div>
    <PostList ref="postList" />
  </div>
</template>
