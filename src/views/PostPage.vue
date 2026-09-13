<script setup lang="ts">
import { onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'
import { Translation, useI18n } from 'vue-i18n'
import PostCompose from '@/components/PostCompose.vue'
import PostList from '@/components/PostList.vue'
import { useScrollRestore } from '@/composables/useScrollRestore'
import { API_BASE, TOKEN, user } from '@/lib/api'

defineOptions({ name: 'PostPage' })

const { t } = useI18n()

const postList = ref<InstanceType<typeof PostList> | null>(null)

let sse: EventSource | null = null

/** 这个话题在服务端的匿名白名单里，所以未登录也能收。 */
const FEED_TOPIC = 'net.pbhh.post.created'

function connect(params: URLSearchParams) {
  sse = new EventSource(`${API_BASE}/events/sse?${params}`)
  sse.onmessage = (e) => {
    const { topic } = JSON.parse(e.data) as { topic: string }
    if (topic === FEED_TOPIC)
      postList.value?.reload()
  }
  return sse
}

function openSse() {
  const params = new URLSearchParams({ topics: FEED_TOPIC })
  // EventSource 不能设请求头，token 只能走 query。这里不是非带不可，但带上就走
  // 已认证路径，将来这个话题若移出白名单也不用改这里。
  if (TOKEN.value)
    params.set('token', TOKEN.value)
  const es = connect(params)
  // token 失效时服务端回 401，而 EventSource 把非 200 响应视为**致命**错误、不会
  // 自动重连 —— 实时刷新会就此静默停摆到下次刷新页面。订阅的话题本身是公开的，
  // 所以直接退回匿名连接。
  es.onerror = () => {
    if (!TOKEN.value)
      return
    es.close()
    if (sse === es)
      connect(new URLSearchParams({ topics: FEED_TOPIC }))
  }
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
