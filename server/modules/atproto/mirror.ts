import type { db } from 'server/database'
import { and, eq } from 'drizzle-orm'
import { posts } from 'server/database'
import { bus } from '../events/bus'
import * as AtprotoService from './service'

/**
 * 入站镜像引擎：把一条 atproto `app.bsky.feed.post` 记录落进本站 `posts`。
 *
 * 单独成模块是因为它有**两个调用方**，而方案要求它们行为完全一致：
 * - `jetstream.ts` —— 实时事件流；
 * - `backfill.ts` —— 绑定时的历史帖回填。
 *
 * 放在同一个函数里，「完全相同的规则」就是结构事实，而不是两处实现靠人工保持同步。
 */

/** 只镜像这一种 collection。like / follow / repost 不进本站。 */
export const POST_COLLECTION = 'app.bsky.feed.post'

/** `record.createdAt` 的可信窗口，之外一律回退观测时刻。 */
const MAX_FUTURE_MS = 5 * 60 * 1000
const MAX_PAST_MS = 365 * 24 * 60 * 60 * 1000
/**
 * 回填历史帖时放宽**过去**侧。实时事件里「创建于两年前」必是伪造（那条记录刚刚
 * 才被创建），但回填时它完全正常 —— 沿用 1 年窗口会把 2022 年的帖伪造成「现在」，
 * 反而制造出一条假时间线。未来侧不放宽：那个闸门防的是 `createdAt: "2099-01-01"`
 * 永久钉在题壁流顶部。
 */
export const BACKFILL_MAX_PAST_MS = 10 * 365 * 24 * 60 * 60 * 1000

/** drizzle 事务对象。用 `Parameters` 推导而不是手写泛型，省掉 schema 类型参数。 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * 镜像成功后要补发的事件。收集起来在**事务提交之后**再发 —— 事务里发会在回滚时
 * 留下幽灵事件。
 */
export interface MirrorOutcome {
  username: string
  postId: number
  uri: string
  cid: string
  /**
   * **夹取之后**、真正写进 `posts.created_at` 的那个时刻。
   *
   * 与 `record.createdAt` 不是一回事：后者是不可信输入，可能是 `"2099-01-01"`，
   * 也可能整个缺失而回退到观测时刻。调用方要按「这条帖有多新」做决定时（比如
   * 重同步要不要惊动粉丝），必须用这个值。
   */
  createdAt: Date
  did: string
  handle?: string
  rkey: string
  time: string
  record: Record<string, unknown>
}

export interface RecordInput {
  did: string
  rkey: string
  cid?: string | null
  /** `unknown` 而不是 `Record` —— 形状校验在函数内做，调用方不必先证明。 */
  record: unknown
  /** 观测时刻，`createdAt` 不可信时回退到它。JetStream 传 `payload.time`。 */
  observedAt: string
  /**
   * `true` 表示这是一条 update 事件：命中已有行时**只改正文**，不动 title。
   * 回填恒为 `false`（`listRecords` 只会给出当前存在的记录）。
   */
  isUpdate?: boolean
  /** 覆盖过去侧窗口，见 `BACKFILL_MAX_PAST_MS`。 */
  maxPastMs?: number
}

export function atUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`
}

/**
 * `record.createdAt` 是客户端声明的发帖时间，事件里的 `time` 是服务端观测时刻
 * （实测差 1.7 秒），所以优先用前者。但**必须夹取**：一条 `createdAt: "2099-01-01"`
 * 的帖会永久钉在题壁流顶部，而解析失败也不能让 `NaN` 进库。
 */
function clampCreatedAt(value: unknown, fallbackIso: string, maxPastMs: number): Date {
  const fallback = new Date(fallbackIso)
  const base = Number.isNaN(fallback.getTime()) ? new Date() : fallback
  if (typeof value !== 'string')
    return base
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()))
    return base
  const delta = parsed.getTime() - Date.now()
  if (delta > MAX_FUTURE_MS || delta < -maxPastMs)
    return base
  return parsed
}

/** 回复的父锚点 URI；`undefined` = 不是回复。形状不对时返回 `null`（调用方跳过）。 */
function readReplyParentUri(record: Record<string, unknown>): string | null | undefined {
  if (record.reply === undefined)
    return undefined
  const reply = record.reply
  if (typeof reply !== 'object' || reply === null)
    return null
  const parent = (reply as { parent?: unknown }).parent
  if (typeof parent !== 'object' || parent === null)
    return null
  const uri = (parent as { uri?: unknown }).uri
  return typeof uri === 'string' && uri ? uri : null
}

/** delete 事件按**构造出的 URI** 软删（幂等）。删除事件不带 record，且 cid 不可靠。 */
export function mirrorDelete(tx: Tx, did: string, rkey: string): void {
  tx.update(posts)
    .set({ deleted: true })
    .where(eq(posts.atprotoUri, atUri(did, POST_COLLECTION, rkey)))
    .run()
}

/**
 * 一条记录 → 一行 `posts`（或 `undefined` 表示按规则跳过）。
 *
 * 跳过规则（每一条都对应一个真实场景，不是防御性代码）：
 * - DID 未绑定本站账号 —— 只订了已绑定身份的 repo，但解绑与事件到达可以并发。
 * - 正文为空 —— `app.bsky.feed.post` 的 `text` 允许为空串（纯图片帖），而本站不
 *   支持图片；镜像成一张空白卡片比不镜像更糟。
 * - 是回复但父帖不在本地 —— 否则它会错误地冒到题壁流顶层。
 */
export function mirrorRecord(tx: Tx, input: RecordInput): MirrorOutcome | undefined {
  const identity = AtprotoService.getIdentityByDid(input.did)
  if (!identity)
    return undefined
  const username = identity.username
  const uri = atUri(input.did, POST_COLLECTION, input.rkey)

  const record = input.record
  if (!record || typeof record !== 'object')
    return undefined
  const text = typeof (record as { text?: unknown }).text === 'string'
    ? (record as { text: string }).text
    : ''
  if (!text.trim())
    return undefined

  if (input.isUpdate) {
    const hit = tx
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.atprotoUri, uri))
      .get()
    // 命中则只更新正文。**不动 title** —— 那个字段是本站的，不属于这条记录。
    if (hit) {
      tx.update(posts).set({ content: text }).where(eq(posts.id, hit.id)).run()
      return undefined
    }
    // 未命中按 create 处理（下面继续）。
  }

  const parentUri = readReplyParentUri(record as Record<string, unknown>)
  let parentId: number | null = null
  if (parentUri !== undefined) {
    if (!parentUri)
      return undefined
    const parent = tx
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.atprotoUri, parentUri), eq(posts.deleted, false)))
      .get()
    if (!parent)
      return undefined
    parentId = parent.id
  }

  const createdAt = clampCreatedAt(
    (record as { createdAt?: unknown }).createdAt,
    input.observedAt,
    input.maxPastMs ?? MAX_PAST_MS,
  )

  // `on conflict do nothing` 是**回环吸收点**：写路径发出去的记录会被 JetStream
  // 送回来，靠 `posts.atproto_uri` 上的唯一索引在这里被吃掉。回填与实时流抢同一条
  // URI 时也走这里。
  const inserted = tx
    .insert(posts)
    .values({
      username,
      content: text,
      parentId,
      createdAt,
      atprotoUri: uri,
      atprotoCid: input.cid ?? null,
    })
    .onConflictDoNothing({ target: posts.atprotoUri })
    .returning({ id: posts.id })
    .get()

  if (!inserted)
    return undefined

  return {
    username,
    postId: inserted.id,
    uri,
    cid: input.cid ?? '',
    createdAt,
    did: input.did,
    handle: identity.handle,
    rkey: input.rkey,
    time: input.observedAt,
    record: record as Record<string, unknown>,
  }
}

/**
 * 事务提交后补发事件。第一条让 `PostPage.vue` 的实时刷新与粉丝通知零改动地继续
 * 工作。
 *
 * **回填默认不调用它**（绑定时的历史帖回填尤其不能调）；只有「重同步」这种
 * 「这些帖本该由实时流过来说一遍」的场景才调，判断在 `backfill.ts` 里。
 */
export function publishMirrored(outcome: MirrorOutcome): void {
  bus.publish('net.pbhh.post.created', { username: outcome.username, postId: outcome.postId })
  bus.publish('app.bsky.feed.post', {
    uri: outcome.uri,
    cid: outcome.cid,
    did: outcome.did,
    handle: outcome.handle,
    username: outcome.username,
    rkey: outcome.rkey,
    time: outcome.time,
    record: outcome.record,
  })
}
