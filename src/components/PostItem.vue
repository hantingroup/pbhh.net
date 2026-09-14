<script setup lang="ts">
import { Heart, MessageSquare } from 'lucide-vue-next'
import { computed, onMounted, ref, watch } from 'vue'
import { Translation, useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import DeleteConfirmDialog from '@/components/DeleteConfirmDialog.vue'
import { Button } from '@/components/ui/button'
import UserAvatar from '@/components/UserAvatar.vue'
import { useMarkdown } from '@/composables/useMarkdown'
import useTimeStr from '@/composables/useTimeStr'
import { api, user } from '@/lib/api'

const props = defineProps<{
  id: number
  title?: string
  content: string
  username: string
  nickname: string
  avatar: string
  createdAt: number
  likeCount: number
  replyCount?: number
  liked: boolean
  expanded?: boolean
  repliable?: boolean
  disableUserLink?: boolean
  parentId?: number
  parentNickname?: string
  parentContent?: string
  isMirrored?: boolean
  bskyUrl?: string | null
}>()

const emit = defineEmits<{
  deleted: [id: number]
  liked: [id: number, liked: boolean, likeCount: number]
  reply: []
  quoteClick: [id: number]
}>()

const { t } = useI18n()
const router = useRouter()
const timeStr = useTimeStr()

function openPost() {
  sessionStorage.setItem('scrollToPost', `post-${props.id}`)
  router.push(`/post/${props.id}`)
}

const renderedContent = useMarkdown(() => props.content)
const isOwn = computed(() => user.value?.username === props.username)

const contentRef = ref<HTMLElement | null>(null)
const overflows = ref(false)
const deleting = ref(false)
const localLiked = ref(props.liked)
const localLikeCount = ref(props.likeCount)

watch(() => props.liked, v => (localLiked.value = v))
watch(() => props.likeCount, v => (localLikeCount.value = v))

onMounted(() => {
  if (!props.expanded) {
    requestAnimationFrame(() => {
      if (contentRef.value)
        overflows.value = contentRef.value.scrollHeight > contentRef.value.clientHeight
    })
  }
})

async function handleLike() {
  if (!user.value) {
    router.push('/login')
    return
  }
  const { data } = await api.posts({ id: props.id }).like.post()
  if (data) {
    localLikeCount.value += data.liked ? 1 : -1
    localLiked.value = data.liked
    emit('liked', props.id, localLiked.value, localLikeCount.value)
  }
}

async function confirmDelete() {
  deleting.value = true
  await api.posts({ id: props.id }).delete()
  deleting.value = false
  emit('deleted', props.id)
}

function handleReplyClick() {
  if (props.expanded || props.repliable)
    emit('reply')
  else
    router.push(`/post/${props.id}#reply`)
}
</script>

<template>
  <div>
    <div
      v-if="parentId && parentNickname"
      class="px-3 py-2 border rounded-lg text-sm text-muted-foreground cursor-pointer bg-muted/30 hover:bg-muted/50 transition-colors truncate"
      @click.stop="emit('quoteClick', parentId!)"
    >
      <Translation v-if="parentContent" keypath="post.quote" tag="span">
        <template #nickname>
          <span class="font-medium text-foreground">{{ parentNickname }}</span>
        </template>
        <template #content>{{ parentContent }}</template>
      </Translation>
      <span v-else class="font-medium text-foreground">{{ parentNickname }}</span>
    </div>
    <div v-if="parentId && parentNickname" class="ml-5 w-0.5 h-3 bg-border" />
    <article
      :id="`post-${id}`"
      class="px-4 py-3 border rounded-xl bg-card transition-[colors,box-shadow]"
      :class="{ 'hover:bg-muted/40 cursor-pointer': !expanded }"
      @click="!expanded && openPost()"
    >
      <div class="flex items-center gap-2 min-w-0">
        <component :is="disableUserLink ? 'span' : RouterLink" :to="`/@${username}`" class="shrink-0" @click.stop>
          <UserAvatar :username="username" :nickname="nickname" :avatar="avatar" size="size-7" />
        </component>
        <component
          :is="disableUserLink ? 'span' : RouterLink"
          :to="`/@${username}`"
          class="font-bold text-sm shrink-0"
          :class="{ 'hover:underline': !disableUserLink }"
          @click.stop
        >
          {{ nickname }}
        </component>
        <span class="text-sm text-muted-foreground truncate">@{{ username }}</span>
        <span class="text-muted-foreground text-sm shrink-0">· {{ timeStr(createdAt) }}</span>
        <!--
          来源标记。`@click.stop` 是必需的：整张卡片就是一次「打开详情」的点击，
          不拦住的话点标记会同时开新标签页和跳详情。

          文案**不做响应式隐藏**：`title` 里的那句「点赞只留在站内」在触屏上根本没有
          hover 可触发，窄屏只留一个图标就等于把这句话删了。
        -->
        <a
          v-if="isMirrored && bskyUrl"
          :href="bskyUrl"
          target="_blank"
          rel="noopener noreferrer"
          :title="t('post.mirroredHint')"
          class="shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-xs text-muted-foreground transition-colors hover:text-sky-500 hover:border-sky-500/40"
          @click.stop
        >
          <!-- Bluesky 蝴蝶标（simple-icons，CC0）。`fill-current` 让它跟随链接的文字色。 -->
          <svg viewBox="0 0 24 24" class="size-3 fill-current" aria-hidden="true">
            <path d="M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026" />
          </svg>
          {{ t('post.mirrored') }}
        </a>
      </div>

      <div class="mt-2">
        <p v-if="title" class="font-bold text-sm mb-1">{{ title }}</p>
        <div
          ref="contentRef"
          class="prose prose-sm max-w-none wrap-break-word"
          :class="{ 'line-clamp-6': !expanded }"
          v-html="renderedContent"
        />
        <span
          v-if="overflows"
          class="text-xs text-muted-foreground hover:underline cursor-pointer mt-0.5 inline-block"
        >
          {{ t('post.readMore') }}
        </span>
      </div>

      <!--
        `flex-wrap`：线程节点会往这一行塞第四个按钮（折叠开关，带计数），
        而按钮是 `whitespace-nowrap` 的，窄屏上四个并排有顶破卡片的风险。宁可换行，不要溢出。
      -->
      <div class="flex flex-wrap items-center mt-2 -ml-2 select-none">
        <Button
          variant="ghost"
          size="sm"
          class="gap-1.5 h-8 px-2 text-sm text-muted-foreground rounded-full hover:text-sky-500 hover:bg-sky-500/10"
          @click.stop="handleReplyClick"
        >
          <MessageSquare class="size-4" />
          <span v-if="replyCount !== undefined" class="tabular-nums">{{ replyCount }}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class="gap-1.5 h-8 px-2 text-sm rounded-full transition-colors"
          :class="localLiked
            ? 'text-rose-500 hover:bg-rose-500/10'
            : 'text-muted-foreground hover:text-rose-500 hover:bg-rose-500/10'"
          @click.stop="handleLike"
        >
          <Heart class="size-4" :class="{ 'fill-current': localLiked }" />
          <span v-if="localLikeCount" class="tabular-nums">{{ localLikeCount }}</span>
        </Button>
        <span v-if="isOwn" @click.stop>
          <DeleteConfirmDialog
            :deleting="deleting"
            button-class="h-8 px-2 rounded-full"
            @confirm="confirmDelete"
          />
        </span>
        <!-- 操作栏的扩展位。`PostThreadNode` 把折叠开关放这里，让它和「回复」「点赞」并排。 -->
        <slot name="actions" />
      </div>
    </article>
  </div>
</template>
