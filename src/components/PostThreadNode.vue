<script setup lang="ts">
import { Minus, Plus } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import PostItem from '@/components/PostItem.vue'
import { Button } from '@/components/ui/button'

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
 * 本节点额外放开的层数。**存相对量，不存绝对上限的副本** —— 副本得跟着 `visibleDepthLimit`
 * 用 watch 同步，而祖先每次展开或收起都会触发那个 watch，本节点自己放开的层数就被一起抹掉。
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

/** 文案只按「现在看不看得见」分，不解释「为什么看不见」—— 读者要知道的只有下面还压着几条。 */
const toggleLabel = computed(() => repliesVisible.value
  ? t('post.thread.collapse', { n: descendantCount.value })
  : t('post.thread.expand', { n: descendantCount.value }))

const postItemProps = computed(() => {
  const { children, parentId, parentUsername, parentNickname, parentContent, ...rest } = props.node
  return rest
})

/**
 * 一个按钮管三件事，按**回复现在为什么看不见**分岔：看得见 → 收起；被层级上限挡住 →
 * 再放开 `expandStep` 层；只是被用户收起来 → 原样放回。判据取自状态本身，不是图标。
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
      >
        <!--
          折叠开关放进父帖自己的操作栏（`PostItem` 的 `actions` 插槽），和「回复」「点赞」并排：
          它管的本来就是这条下面的回复，挂在回复区左边时位置和作用是错开的。
        -->
        <template v-if="hasChildren" #actions>
          <!-- 超过上限、没法在原位再展开了，只能去详情页接着看。 -->
          <Button
            v-if="continueThread"
            as-child
            variant="ghost"
            size="sm"
            class="gap-1.5 h-8 px-2 text-sm text-muted-foreground rounded-full hover:text-foreground"
          >
            <RouterLink :to="`/post/${node.id}`" @click.stop>
              <Plus />
              {{ t('post.thread.continue', { n: descendantCount }) }}
            </RouterLink>
          </Button>

          <Button
            v-else
            variant="ghost"
            size="sm"
            class="gap-1.5 h-8 px-2 text-sm text-muted-foreground rounded-full hover:text-foreground"
            :aria-expanded="repliesVisible"
            @click.stop="toggleReplies"
          >
            <Minus v-if="repliesVisible" />
            <Plus v-else />
            {{ toggleLabel }}
          </Button>
        </template>
      </PostItem>

      <div v-if="replyingToId === node.id" class="thread-compose">
        <slot name="composer" :node="node" />
      </div>

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
</template>

<style scoped>
/*
  整棵树的自由量只有三个，都定义在 `.thread-node` 上：
  - `--thread-gap`    节点内部各块之间、以及同级回复之间的距离；
  - `--thread-indent` 每一层回复的缩进（**唯一需要按层级和屏宽改的量**）；
  - `--thread-gutter` 竖线距节点左边缘的位置。
  竖线和肘部的位置全部由它们算出来，不各自硬编码。
*/
.thread-node {
  --thread-gap: 0.75rem;
  --thread-gutter: 0.55rem;
  --thread-elbow-top: 1.15rem;
  --thread-indent: 2rem;
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

/* 与上方卡片留一个 `--thread-gap`，和同级回复之间的距离是同一个值。 */
.thread-children {
  margin-top: var(--thread-gap);
  padding-left: var(--thread-indent);
}

/*
  深层收窄。缩进改了竖线与肘部会自动跟随，但 gutter 必须跟着一起收：固定 0.55rem 时，
  缩进降到 0.75rem 那一档只剩 0.2rem 余量，肘部的 0.92rem 圆角放不下，线就贴在卡片边上。
*/
.thread-children-tight {
  --thread-indent: 1rem;
  --thread-gutter: 0.3rem;
}

.thread-child {
  position: relative;
  min-width: 0;
}

.thread-child + .thread-child {
  margin-top: var(--thread-gap);
}

/* 顶端向上多画一个 `--thread-gap`，正好搭在父帖卡片的下边缘上，否则线会悬空一截。 */
.thread-child::before {
  content: "";
  position: absolute;
  left: calc(var(--thread-gutter) - var(--thread-indent));
  top: calc(-1 * var(--thread-gap));
  bottom: calc(-1 * var(--thread-gap));
  width: 2px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--border) 82%, transparent);
}

/* 最后一个只画到肘部为止，否则线会拖过这条回复的最低处。 */
.thread-child-last::before {
  bottom: auto;
  height: calc(var(--thread-gap) + var(--thread-elbow-top));
}

/* 肘部：竖线拐进这条回复的左边。宽度即缩进减去竖线到节点左边缘的距离。 */
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
  .thread-node {
    --thread-indent: 1.35rem;
  }

  .thread-children-tight {
    --thread-indent: 0.75rem;
  }
}
</style>
