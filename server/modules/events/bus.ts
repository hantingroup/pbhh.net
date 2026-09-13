import { EventEmitter } from 'node:events'

/**
 * topic 就是 NSID 形状的全局地址（反向域名 `pbhh.net` → `net.pbhh`）。
 * 站内事件是 `net.pbhh.*`；经 JetStream 流入的 atproto 事件保留其原生
 * NSID（`app.bsky.*`）——那是别人的命名空间，不可改写。两者共用同一套
 * 通配符匹配（见 `deliver.ts` 的 `matchesTopic`），所以不需要映射层。
 *
 * **总线只跑广播事件**，也就是「谁都可以知道」的那些。只该给一个人的事件走
 * `deliverToUser`，见下面的 `UserEventMap`。
 */
export interface AppEventMap {
  'net.pbhh.user.registered': {
    username: string
  }
  'net.pbhh.post.created': {
    username: string
    postId: number
  }
  'net.pbhh.post.liked': {
    postId: number
    actorUsername: string
    liked: boolean
  }
  'net.pbhh.post.replied': {
    parentId: number
    actorUsername: string
    replyId: number
  }
  // ── atproto ────────────────────────────────────────────────────────────────
  // `app.bsky.feed.post` 是对方 repo 里的 collection NSID，原样使用。删除在
  // JetStream 里是同一个 collection 上的一次 `operation=delete`，没有独立
  // NSID，这里按站内约定补 `.deleted` 后缀，好让 `app.bsky.feed.post.*` 通配
  // 一次订阅一拍。`like`/`follow` 暂不订阅（见 jetstream.ts），订阅时再补类型。
  'app.bsky.feed.post': {
    /** at://did:plc:xxx/app.bsky.feed.post/<rkey> */
    uri: string
    cid: string
    did: string
    /** 作者的 atproto handle，解析失败时为 undefined */
    handle?: string
    /** 若该 DID 已绑定本站账号，这里是本地用户名 */
    username?: string
    rkey: string
    /** JetStream 的 `time`，ISO 8601 */
    time: string
    /** 原始 `app.bsky.feed.post` record，未做规范化 */
    record: Record<string, unknown>
  }
  'app.bsky.feed.post.deleted': {
    uri: string
    did: string
    handle?: string
    username?: string
    rkey: string
    time: string
  }
}

export type AppEvent = {
  [K in keyof AppEventMap]: { topic: K, payload: AppEventMap[K], timestamp: number }
}[keyof AppEventMap]

/**
 * 点对点事件：**只投给收件人自己的连接，永不进入总线**（见 `deliver.ts` 的
 * `deliverToUser`）。
 *
 * 刻意不放进 `AppEventMap`，这不是分类洁癖：放进去就等于承认它是一个**可订阅的
 * 话题**，而任何订阅者只要 pattern 写对（`net.pbhh.notify.*`，或者干脆 `*`）就能
 * 收到全站每个人的通知 —— payload 里带着收件人的 QQ 号（`recipientBindings`），
 * 等于把 PII 广播出去。没有可订阅的话题，就不存在「订阅错话题」这回事，也就不需要
 * 靠一条命名约定去拦住它。
 *
 * `topic` 字段保留：投递出去的事件形状与广播事件一致，所以前端不用改。
 */
export interface UserEventMap {
  'net.pbhh.notify.post.liked': {
    recipientUsername: string
    recipientBindings: Record<string, string>
    actorUsername: string
    actorNickname: string
    actorAvatar?: string
    postId: number
    postContent: string
  }
  'net.pbhh.notify.post.created': {
    recipientUsername: string
    recipientBindings: Record<string, string>
    actorUsername: string
    actorNickname: string
    actorAvatar?: string
    postId: number
    postContent?: string
  }
  'net.pbhh.notify.post.replied': {
    recipientUsername: string
    recipientBindings: Record<string, string>
    actorUsername: string
    actorNickname: string
    actorAvatar?: string
    postId: number
    postContent: string
    replyId: number
    replyContent?: string
  }
  'net.pbhh.notify.mail.received': {
    recipientUsername: string
    emailId: number
    fromAddress: string
    subject: string
  }
}

export type UserEvent = {
  [K in keyof UserEventMap]: { topic: K, payload: UserEventMap[K], timestamp: number }
}[keyof UserEventMap]

/**
 * 投递层的通用形状：广播事件与点对点事件共用。`deliver.ts` 只依赖它，不区分来源。
 */
export interface DeliveredEvent {
  topic: string
  payload: unknown
  timestamp: number
}

class EventBus extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(0)
  }

  publish<T extends keyof AppEventMap>(topic: T, payload: AppEventMap[T]): void
  publish(topic: string, payload: unknown): void
  publish(topic: string, payload: unknown): void {
    const event = { topic, payload, timestamp: Date.now() }
    this.emit('event', event)
  }
}

export const bus = new EventBus()
