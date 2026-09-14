<script setup lang="ts">
import { Minus, Plus } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
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

const { t } = useI18n()

function countDescendants(node: ThreadNode): number {
  return node.children.reduce((total, child) => total + 1 + countDescendants(child), 0)
}

const hasChildren = computed(() => props.node.children.length > 0)
const descendantCount = computed(() => countDescendants(props.node))

/**
 * 本节点额外放开的层数。**存相对量，不存绝对上限的副本。**
 *
 * 副本必须在 `visibleDepthLimit` 变化时用 watch 同步回来，而祖先任何一次展开或收起都会
 * 触发那个 watch，于是本节点自己放开的层数被一起抹掉 —— 表现是「在深层展开过的东西会莫
 * 名收回」。相对量没有这个问题：祖先怎么变都只是换一个基数。
 */
const extraDepth = ref(0)
/** 用户主动收起本节点的回复。与 `extraDepth` 分开存：收起再展开要回到原来的层级。 */
const collapsed = ref(false)

/** 这一支当前显示到第几层。 */
const depthLimit = computed(() => props.visibleDepthLimit + extraDepth.value)
/** 子节点是被层级上限挡住的（不是被用户收的）。 */
const cutByLimit = computed(() => props.depth >= depthLimit.value)
const repliesVisible = computed(() => hasChildren.value && !collapsed.value && !cutByLimit.value)
const canExpandDeeper = computed(() => cutByLimit.value
  && (props.maxVisibleDepth == null || depthLimit.value < props.maxVisibleDepth))
const continueThread = computed(() => cutByLimit.value && !canExpandDeeper.value)
/** 到这一层开始收窄缩进，让深层回复别把宽度吃光。 */
const tightIndent = computed(() => props.depth >= props.visualDepthLimit)

const toggleLabel = computed(() => {
  if (repliesVisible.value)
    return t('post.thread.collapse', { n: descendantCount.value })
  if (cutByLimit.value)
    return t('post.thread.expandDeeper', { n: descendantCount.value })
  return t('post.thread.expand', { n: descendantCount.value })
})

const postItemProps = computed(() => {
  const { children, parentId, parentUsername, parentNickname, parentContent, ...rest } = props.node
  return rest
})

/**
 * 一个按钮管三件事，动作按**回复现在为什么看不见**分岔：
 * - 看得见 → 收起来；
 * - 被层级上限挡住 → 再放开 `expandStep` 层；
 * - 只是被用户收起来了 → 原样放回来。
 *
 * 分岔依据刻意不是图标 —— 「现在看得见/看不见」是显示状态，拿它当判据的话，图标一有偏差
 * 动作就跟着错。这里两个条件都直接来自状态本身，图标只是它们的呈现。
 */
function toggleReplies() {
  if (!hasChildren.value)
    return
  if (repliesVisible.value) {
    collapsed.value = true
    return
  }
  if (cutByLimit.value) {
    extraDepth.value += props.expandStep
    // 上限放开之后回复就该出现，所以顺手清掉用户的收起状态 —— 否则点一下毫无反应。
    collapsed.value = false
    return
  }
  collapsed.value = false
}
</script>

<template>
  <div class="thread-node">
    <div class="thread-body">
      <PostItem
        v-bind="postItemProps"
        expanded
        repliable
        @reply="emit('reply', node.id)"
        @deleted="emit('deleted', node.id)"
        @quote-click="emit('quoteClick', $event)"
      />

      <div v-if="replyingToId === node.id" class="thread-compose">
        <slot name="composer" :node="node" />
      </div>

      <!--
        回复区。折叠开关长在**这里**，不在节点自己的左侧。
        它管的是这个节点的回复，所以必须和回复排在一起 —— 贴在节点头像旁边时，它看起来
        像是收这条评论本身，而它实际收的是下面那一整串。
        它同时是竖线的起点：默认层级用完之后，竖线到徽章为止，下面什么都不画。
      -->
      <div v-if="hasChildren" class="thread-replies">
        <RouterLink
          v-if="continueThread"
          :to="`/post/${node.id}`"
          class="thread-replies-toggle"
        >
          <span class="thread-badge">
            <Plus class="size-3.5" />
          </span>
          {{ t('post.thread.continue', { n: descendantCount }) }}
        </RouterLink>

        <button
          v-else
          type="button"
          class="thread-replies-toggle"
          :aria-expanded="repliesVisible"
          @click="toggleReplies"
        >
          <span class="thread-badge">
            <Minus v-if="repliesVisible" class="size-3.5" />
            <Plus v-else class="size-3.5" />
          </span>
          {{ toggleLabel }}
        </button>

        <div
          v-if="repliesVisible"
          class="thread-children"
          :class="{ 'thread-children-tight': tightIndent }"
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
              :visible-depth-limit="depthLimit"
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
  </div>
</template>

<style scoped>
/*
  整棵树只有两个自由量，都定义在 `.thread-node` 上：
  - `--thread-gap`  节点内部各块之间、以及同级回复之间的距离；
  - `--thread-indent`（见 `.thread-replies`）每一层回复的缩进。
  竖线、肘部、折叠徽章的位置**全部由它们算出来**，不各自硬编码。上一版是反过来的：
  缩进和竖线各有一串常量（2rem/1rem/1.35rem/0.75rem 配 -1.45/-0.95/-1rem），移动端
  与深层层级叠在一起时两组值就对不上，线会跑到缩进框外面。
*/
.thread-node {
  --thread-gap: 0.75rem;
  min-width: 0;
}

.thread-body {
  min-width: 0;
  width: 100%;
  max-width: 100%;
}

.thread-compose {
  margin-top: var(--thread-gap);
}

.thread-replies {
  /* 竖线固定在距回复区左边 `--thread-gutter` 处，与缩进无关 —— 这样缩进怎么变，线都
     不会越出回复区；肘部的横向长度才是跟着缩进伸缩的那个量。 */
  --thread-gutter: 0.55rem;
  --thread-badge: 1.15rem;
  /* 每一层回复的缩进。**唯一需要改的量**，见 `.thread-children-tight` 与媒体查询。 */
  --thread-indent: 2rem;
  --thread-elbow-top: 1.15rem;
  position: relative;
  margin-top: var(--thread-gap);
}

/* 深层收窄。只改缩进，竖线与肘部自动跟随。 */
.thread-children-tight {
  --thread-indent: 1rem;
}

.thread-replies-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  /* 让徽章中心正落在竖线上（回复区左边 --thread-gutter 处）。 */
  margin-left: calc(var(--thread-gutter) - var(--thread-badge) / 2);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 0.875rem;
  text-decoration: none;
  transition: color 150ms ease;
}

.thread-replies-toggle:hover {
  color: var(--foreground);
}

/* 折叠徽章与「查看更多」的图标共用这一个类，尺寸因此不可能不一致。 */
.thread-badge {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--thread-badge);
  height: var(--thread-badge);
  border: 1px solid color-mix(in oklch, var(--border) 90%, transparent);
  border-radius: 999px;
  background: color-mix(in oklch, var(--background) 96%, white);
  transition: background-color 150ms ease, border-color 150ms ease;
}

.thread-replies-toggle:hover .thread-badge {
  background: color-mix(in oklch, var(--muted) 86%, white);
}

.thread-children {
  padding-left: var(--thread-indent);
}

.thread-child {
  position: relative;
  min-width: 0;
}

.thread-child + .thread-child {
  margin-top: var(--thread-gap);
}

/* 竖线：从回复区顶端（折叠徽章下方）一直画到最后一个子节点的肘部。 */
.thread-child::before {
  content: "";
  position: absolute;
  left: calc(var(--thread-gutter) - var(--thread-indent));
  top: 0;
  bottom: calc(-1 * var(--thread-gap));
  width: 2px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--border) 82%, transparent);
}

/* 非首个兄弟要把线接上去，补上它上面那段间距。 */
.thread-child + .thread-child::before {
  top: calc(-1 * var(--thread-gap));
}

/* 最后一个只画到肘部为止，否则线会拖过这条回复的最低处。 */
.thread-child-last::before {
  bottom: auto;
  height: var(--thread-elbow-top);
}

.thread-child + .thread-child-last::before {
  height: calc(var(--thread-gap) + var(--thread-elbow-top));
}

/* 肘部：竖线拐进这条回复的左边。宽度即缩进减去竖线到回复区左边的距离。 */
.thread-child::after {
  content: "";
  position: absolute;
  left: calc(var(--thread-gutter) - var(--thread-indent));
  top: var(--thread-elbow-top);
  width: calc(var(--thread-indent) - var(--thread-gutter));
  height: 1.1rem;
  border-left: 2px solid color-mix(in oklch, var(--border) 82%, transparent);
  border-bottom: 2px solid color-mix(in oklch, var(--border) 82%, transparent);
  border-bottom-left-radius: 0.92rem;
}

@media (max-width: 640px) {
  .thread-replies {
    --thread-indent: 1.35rem;
  }

  .thread-children-tight {
    --thread-indent: 0.75rem;
  }

  .thread-replies-toggle {
    max-width: 100%;
    line-height: 1.45;
    white-space: normal;
    word-break: break-word;
  }
}
</style>
