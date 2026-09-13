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

function openSse() {
  sse = new EventSource(`${API_BASE}/events/sse`)
  sse.onmessage = (e) => {
    const { topic } = JSON.parse(e.data) as { topic: string }
    if (topic === 'net.pbhh.post.created')
      postList.value?.reload()
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
