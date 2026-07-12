<script setup lang="ts">
import { Minus, Plus } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import PostItem from '@/components/PostItem.vue'

interface ThreadNode {
  id: number
  parentId: number
  title?: string
  content: string
  username: string
  nickname: string
  avatar: string
  createdAt: number
  likeCount: number
  replyCount?: number
  liked: boolean
  children: ThreadNode[]
  parentUsername?: string
  parentNickname?: string
  parentContent?: string
}

const props = withDefaults(defineProps<{
  node: ThreadNode
  depth: number
  replyingToId: number | null
  visibleDepthLimit: number
  maxVisibleDepth?: number | null
  visualDepthLimit?: number
  expandStep?: number
}>(), {
  maxVisibleDepth: null,
  visualDepthLimit: 4,
  expandStep: 3,
})

const emit = defineEmits<{
  reply: [id: number]
  deleted: [id: number]
  quoteClick: [id: number]
}>()

defineSlots<{
  composer: (props: { node: ThreadNode }) => any
}>()

function countDescendants(node: ThreadNode): number {
  return node.children.reduce((total, child) => total + 1 + countDescendants(child), 0)
}

const hasChildren = computed(() => props.node.children.length > 0)
const descendantCount = computed(() => countDescendants(props.node))
const subtreeVisibleDepthLimit = ref(props.visibleDepthLimit)
const manuallyCollapsed = ref(false)

watch(() => props.visibleDepthLimit, (value) => {
  subtreeVisibleDepthLimit.value = value
})

const reachesVisibleLimit = computed(() => hasChildren.value && props.depth >= subtreeVisibleDepthLimit.value)
const canExpandDeeper = computed(() => {
  if (!reachesVisibleLimit.value)
    return false
  if (props.maxVisibleDepth == null)
    return true
  return subtreeVisibleDepthLimit.value < props.maxVisibleDepth
})
const continueThread = computed(() => reachesVisibleLimit.value && !canExpandDeeper.value)
const showChildren = computed(() => hasChildren.value && !manuallyCollapsed.value && !reachesVisibleLimit.value)
const isCompressedDepth = computed(() => props.depth > props.visualDepthLimit)
const compressChildren = computed(() => props.depth >= props.visualDepthLimit)
const postItemProps = computed(() => {
  const { children, parentId, parentUsername, parentNickname, parentContent, ...rest } = props.node
  return rest
})

function toggleChildren() {
  if (!hasChildren.value || reachesVisibleLimit.value)
    return
  if (subtreeVisibleDepthLimit.value > props.visibleDepthLimit) {
    subtreeVisibleDepthLimit.value = props.visibleDepthLimit
    manuallyCollapsed.value = false
    return
  }
  manuallyCollapsed.value = !manuallyCollapsed.value
}

function expandDeeper() {
  if (!canExpandDeeper.value)
    return
  subtreeVisibleDepthLimit.value += props.expandStep
  manuallyCollapsed.value = false
}
</script>

<template>
  <div
    class="thread-node"
    :class="{
      'thread-node-nested': depth > 1,
      'thread-node-compressed': isCompressedDepth,
    }"
  >
    <span v-if="depth > 1" class="thread-branch" aria-hidden="true">
      <button
        v-if="hasChildren && !continueThread"
        type="button"
        class="thread-toggle"
        @click="reachesVisibleLimit ? expandDeeper() : toggleChildren()"
      >
        <Minus v-if="showChildren" class="size-3.5" />
        <Plus v-else class="size-3.5" />
      </button>
    </span>

    <div class="thread-body">
      <PostItem
        v-bind="postItemProps"
        expanded
        replyable
        @reply="emit('reply', node.id)"
        @deleted="emit('deleted', node.id)"
        @quote-click="emit('quoteClick', $event)"
      />

      <div v-if="replyingToId === node.id" class="thread-compose">
        <slot name="composer" :node="node" />
      </div>

      <button
        v-if="canExpandDeeper"
        type="button"
        class="thread-more"
        @click="expandDeeper"
      >
        <span class="thread-more-icon">
          <Plus class="size-3.5" />
        </span>
        展开 {{ descendantCount }} 条更深回复
      </button>

      <RouterLink
        v-if="continueThread"
        :to="`/post/${node.id}`"
        class="thread-continue"
      >
        <span class="thread-more-icon">
          <Plus class="size-3.5" />
        </span>
        查看后续 {{ descendantCount }} 条回复
      </RouterLink>

      <div
        v-if="showChildren"
        class="thread-children"
        :class="{ 'thread-children-compressed': compressChildren }"
      >
        <div
          v-for="(child, index) in node.children"
          :key="child.id"
          class="thread-child"
          :class="{ 'thread-child-last': index === node.children.length - 1 }"
        >
          <PostThreadNode
            :node="child"
            :depth="depth + 1"
            :replying-to-id="replyingToId"
            :visible-depth-limit="subtreeVisibleDepthLimit"
            :max-visible-depth="maxVisibleDepth"
            :visual-depth-limit="visualDepthLimit"
            :expand-step="expandStep"
            @reply="emit('reply', $event)"
            @deleted="emit('deleted', $event)"
            @quote-click="emit('quoteClick', $event)"
          >
            <template #composer="slotProps">
              <slot name="composer" :node="slotProps.node" />
            </template>
          </PostThreadNode>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.thread-node {
  min-width: 0;
}

.thread-node-nested {
  position: relative;
}

.thread-body {
  min-width: 0;
  width: 100%;
  max-width: 100%;
}

.thread-branch {
  position: absolute;
  left: -1.45rem;
  top: 1.15rem;
  z-index: 2;
  width: 1.45rem;
  height: 1.1rem;
}

.thread-toggle {
  position: absolute;
  top: 0;
  left: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.15rem;
  height: 1.15rem;
  transform: translate(-50%, -50%);
  border: 1px solid color-mix(in oklch, var(--border) 90%, transparent);
  border-radius: 999px;
  background: color-mix(in oklch, var(--background) 96%, white);
  color: color-mix(in oklch, var(--foreground) 78%, transparent);
  transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease;
}

.thread-toggle:hover {
  background: color-mix(in oklch, var(--muted) 86%, white);
  color: var(--foreground);
}

.thread-compose {
  margin-top: 0.9rem;
}

.thread-more,
.thread-continue {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  margin-top: 0.8rem;
  border: 0;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 0.875rem;
  text-decoration: none;
  transition: color 150ms ease;
}

.thread-more:hover,
.thread-continue:hover {
  color: var(--foreground);
}

.thread-more-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.15rem;
  height: 1.15rem;
  border: 1px solid color-mix(in oklch, var(--border) 90%, transparent);
  border-radius: 999px;
  background: color-mix(in oklch, var(--background) 96%, white);
}

.thread-children {
  position: relative;
  margin-top: 1rem;
  padding-left: 2rem;
}

.thread-children-compressed {
  padding-left: 1rem;
}

.thread-child {
  position: relative;
  min-width: 0;
}

.thread-child + .thread-child {
  margin-top: 1rem;
}

.thread-child::before {
  content: "";
  position: absolute;
  left: -1.45rem;
  top: -1rem;
  bottom: -1rem;
  width: 2px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--border) 82%, transparent);
}

.thread-child::after {
  content: "";
  position: absolute;
  left: -1.45rem;
  top: 1.15rem;
  width: 1.45rem;
  height: 1.1rem;
  border-left: 2px solid color-mix(in oklch, var(--border) 82%, transparent);
  border-bottom: 2px solid color-mix(in oklch, var(--border) 82%, transparent);
  border-bottom-left-radius: 0.92rem;
}

.thread-child-last::before {
  bottom: auto;
  height: 2.35rem;
}

.thread-node-compressed .thread-branch {
  left: -0.95rem;
  width: 0.95rem;
}

.thread-node-compressed .thread-toggle {
  width: 1rem;
  height: 1rem;
}

.thread-children-compressed > .thread-child::before,
.thread-children-compressed > .thread-child::after {
  left: -0.95rem;
}

.thread-children-compressed > .thread-child::after {
  width: 0.95rem;
  border-bottom-left-radius: 0.72rem;
}

@media (max-width: 640px) {
  .thread-children {
    padding-left: 1.35rem;
  }

  .thread-children-compressed {
    padding-left: 0.75rem;
  }

  .thread-branch {
    left: -1rem;
    width: 1rem;
  }

  .thread-child::before,
  .thread-child::after {
    left: -1rem;
  }

  .thread-child::after {
    width: 1rem;
  }

  .thread-more,
  .thread-continue {
    max-width: 100%;
    line-height: 1.45;
    white-space: normal;
    word-break: break-word;
  }
}
</style>
