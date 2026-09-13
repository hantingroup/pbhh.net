import { t } from 'elysia'

/**
 * 用户自发的 topic（`POST /events/publish` 与 WS `publish`）只给**后缀**，服务端
 * 拼成 `net.pbhh.custom.<username>.<后缀>`。
 *
 * **防冒充靠的是这层前缀嵌套，不是下面的语法校验。** 校验的 pattern 本身**接受**
 * `net.pbhh.post.created` 与 `app.bsky.feed.post`（实测过，它们本来就是合法的点
 * 分标识符）；挡住冒充的是「用户输入永远被裹在 `net.pbhh.custom.<他自己的用户名>.`
 * 之后」，所以拼出来的 topic 不可能等于任何系统话题或 `app.bsky.*`。改这段代码
 * 前先想清这一点：拿掉前缀嵌套，下面这个校验一点都拦不住。
 *
 * 那校验管什么？管**形状卫生**——拒掉空串、`*` / `a.*` 这类通配形状、前导或尾随
 * 的 `-`，让自定义话题与系统话题长得一样规整。
 *
 * 语法与 atproto NSID 一致（点分、段首为字母数字、`-` 只能在段内），只多放开一
 * 个 `_`。用户名本身已不含下划线（用户名现在就是 `*.pbhh.net` 的 DNS label），
 * 这个放宽纯属**兼容存量**：外部发布者可能已经在用带 `_` 的后缀，收掉会静默
 * 弄坏他们。该放宽只作用于本站自定义 topic 的后缀，`app.bsky.*` 事件由
 * jetstream.ts 直接发布，不经过这里。
 */
const SEGMENT = '\\w(?:[\\w-]*\\w)?'
const topicSuffixPattern = `^${SEGMENT}(?:\\.${SEGMENT})*$`

const topicSuffixRegex = new RegExp(topicSuffixPattern)

/** NSID 的总长上限，顺手用作后缀上限。 */
export const TOPIC_MAX_LENGTH = 317

export function isValidTopicSuffix(topic: string): boolean {
  return topic.length <= TOPIC_MAX_LENGTH && topicSuffixRegex.test(topic)
}

export const subscribeBody = t.Object({
  url: t.String({ minLength: 1, pattern: '^https?://' }),
  topics: t.Optional(t.Array(t.String({ minLength: 1 }))),
})

export const pushBody = t.Object({
  topic: t.String({ minLength: 1, maxLength: TOPIC_MAX_LENGTH, pattern: topicSuffixPattern }),
  payload: t.Unknown(),
})

export type PushBody = typeof pushBody.static
