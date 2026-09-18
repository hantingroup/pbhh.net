import type { AppEvent, DeliveredEvent, UserEventMap } from './bus'
import { Buffer } from 'node:buffer'
import { bus } from './bus'

/**
 * 事件的投递层。两条路径刻意分开：
 *
 * - **广播**：总线事件（`AppEventMap`）推给所有订阅者，按 topic pattern 筛。
 * - **点对点**：用户事件（`UserEventMap`）只推给收件人自己的连接，见 `deliverToUser`。
 *
 * 分开的理由是安全而不是整洁：总线是个广播原语，而通知只该给一个人。把通知放上
 * 总线，就等于让「谁能收到别人的通知」取决于订阅者 pattern 写得对不对。
 */

// ─── 订阅者 ──────────────────────────────────────────────────────────────────

/** `wants` 只需要这两样，webhook 与长连接都能满足。 */
interface TopicFilter {
  /** topic 通配 pattern，语义见 `matchesTopic`。 */
  topics: string[]
  /**
   * pattern 命中之后再判一次的第二道闸门。匿名 SSE 用它把自己锁在 `PUBLIC_TOPICS`
   * 里 —— `topics` 来自 query，是用户可控的（`?topics=*`），只有这道闸门拦得住
   * 显式通配。
   */
  allow?: (topic: string) => boolean
}

export interface Subscriber extends TopicFilter {
  /**
   * 已认证订阅者的用户名。点对点事件只投给 username 相等的连接，所以**匿名的 SSE
   * 连接天然收不到任何通知**，不需要额外判断。
   */
  username?: string
  send: (data: string) => void
}

interface WebhookSub extends TopicFilter {
  url: string
  failures: number
}

/** username → 该用户的 webhook。 */
const webhooks = new Map<string, WebhookSub>()
const wsClients = new Map<object, Subscriber>()
const sseClients = new Map<object, Subscriber>()

export function registerWs(key: object, client: Subscriber): void {
  wsClients.set(key, client)
}

export function registerSse(key: object, client: Subscriber): void {
  sseClients.set(key, client)
}

/** 连接断开时调用。key 只存在于其中一个表里，两个都删是幂等的。 */
export function unregister(key: object): void {
  wsClients.delete(key)
  sseClients.delete(key)
}

/** WS 的 `message` 处理器要拿回自己的 username 才能拼自定义 topic。 */
export function getSubscriber(key: object): Subscriber | undefined {
  return wsClients.get(key) ?? sseClients.get(key)
}

export function setWebhook(username: string, url: string, topics: string[]): void {
  webhooks.set(username, { url, topics, failures: 0 })
}

export function clearWebhook(username: string): void {
  webhooks.delete(username)
}

// ─── 匹配 ────────────────────────────────────────────────────────────────────

function matchesTopic(pattern: string, topic: string): boolean {
  if (pattern === '*')
    return true
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2)
    return topic === prefix || topic.startsWith(`${prefix}.`)
  }
  return pattern === topic
}

function wants(sub: TopicFilter, topic: string): boolean {
  return sub.topics.some(p => matchesTopic(p, topic)) && (sub.allow?.(topic) ?? true)
}

// ─── Webhook 投递 ────────────────────────────────────────────────────────────

const MAX_FAILURES = 5

async function postWebhook(username: string, sub: WebhookSub, event: DeliveredEvent, attempt = 1): Promise<void> {
  const auth = `Basic ${Buffer.from(`${username}:`).toString('base64')}`
  try {
    const res = await fetch(sub.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify(event),
    })
    if (!res.ok)
      throw new Error(`HTTP ${res.status}`)
    sub.failures = 0
  }
  catch (err) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * attempt))
      return postWebhook(username, sub, event, attempt + 1)
    }
    sub.failures++
    if (sub.failures >= MAX_FAILURES) {
      webhooks.delete(username)
      console.error(`[webhook:${username}] removed after ${MAX_FAILURES} consecutive failures`)
      return
    }
    console.error(`[webhook:${username}] delivery failed (failures=${sub.failures}):`, err)
  }
}

function toWebhook(username: string, sub: WebhookSub, event: DeliveredEvent): void {
  if (!wants(sub, event.topic))
    return
  console.info(`[webhook:${username}] delivering topic=${event.topic} to ${sub.url}`)
  // 刻意不 await：投递失败会自己重试，调用方（事件发布者）不该被它拖住。
  postWebhook(username, sub, event)
}

// ─── 广播：总线事件 ───────────────────────────────────────────────────────────

/**
 * 点对点话题的命名空间，**永不允许出现在总线上**。
 *
 * 类型系统其实已经拦住了正常路径 —— `bus.publish` 的签名只接受 `AppEventMap` 的
 * key，通知话题不在其中，写上去就编译不过。这里拦的是有人 `as any` 绕过去的情况：
 * 一旦绕过去，`net.pbhh.notify.*` 的订阅者（任何已认证用户都能这么订）就会收到
 * 别人的通知，而 payload 里有收件人的 QQ 号。与其静默泄漏，不如丢弃并留下日志。
 */
const POINT_TO_POINT_PREFIX = 'net.pbhh.notify.'

bus.on('event', (event: AppEvent) => {
  if (event.topic.startsWith(POINT_TO_POINT_PREFIX)) {
    console.error(`[events] point-to-point topic ${event.topic} showed up on the bus, dropped (use deliverToUser)`)
    return
  }

  const msg = JSON.stringify(event)

  for (const [username, sub] of webhooks)
    toWebhook(username, sub, event)

  for (const client of wsClients.values()) {
    if (wants(client, event.topic))
      client.send(msg)
  }

  for (const client of sseClients.values()) {
    if (wants(client, event.topic))
      client.send(msg)
  }
})

// ─── 点对点：用户事件 ─────────────────────────────────────────────────────────

/**
 * 只推给 `username` 自己的连接，**不经过总线**。这是通知唯一的出口。
 *
 * 订阅者的 pattern 照常生效（App.vue 就是按 `net.pbhh.notify.*` 订的），变的只是
 * 事件来源：从「广播出去再按 pattern 筛」变成「按收件人定向」。于是那个 pattern
 * 从此不可能匹配到别人的通知 —— 别人的通知根本不会走到这条路径上。
 *
 * 顺带补一条与总线事件同格式的日志：`admin/logger.ts` 是挂总线上的，这条路径不经
 * 总线，不补就看不到通知了。
 */
export function deliverToUser<T extends keyof UserEventMap>(
  username: string,
  topic: T,
  payload: UserEventMap[T],
): void {
  const event: DeliveredEvent = { topic, payload, timestamp: Date.now() }
  const msg = JSON.stringify(event)

  console.info(`[event] ${topic}`, payload)

  const hook = webhooks.get(username)
  if (hook)
    toWebhook(username, hook, event)

  for (const client of wsClients.values()) {
    if (client.username === username && wants(client, topic))
      client.send(msg)
  }
  for (const client of sseClients.values()) {
    if (client.username === username && wants(client, topic))
      client.send(msg)
  }
}
