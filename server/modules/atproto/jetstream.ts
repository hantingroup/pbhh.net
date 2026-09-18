import type { MirrorOutcome, Tx } from './mirror'
import { and, eq } from 'drizzle-orm'
import { atprotoCursor, db, postLikes, posts } from 'server/database'
import { bus } from '../events/bus'
import { backfillFromPds } from './backfill'
import { atUri, LIKE_COLLECTION, mirrorDelete, mirrorRecord, POST_COLLECTION, publishMirrored } from './mirror'
import { retractStaleLike } from './outbox'
import * as AtprotoService from './service'

/**
 * 读路径：消费 JetStream，把用户发在 Bluesky 的帖子镜像进本站 `posts` 表、把用户点的
 * 赞镜像进 `post_likes`。
 *
 * **两件事的可达性是同一堵墙决定的**：`dids` 按**事件来源 repo** 过滤，所以我们只看得
 * 到绑定用户自己 repo 里的东西。用户自己的帖 ✅、用户自己的赞 ✅（like 记录住在点赞者
 * 的 repo 里）；**别人**对我们用户帖子的赞 ❌、别人的回复 ❌。后两者要另想办法，不在
 * 这个模块的射程内。
 *
 * 手写而不是引 `@bsky/jetstream`：那个包声明 `engines: node >=22.15.0`、依赖 `ws`，
 * 而本服务是**单个 Bun 进程** —— 为一个 socket 引入第二个 Node 进程是重大运维改动。
 * v2 线上协议就是「带 query 过滤的 JSON over WebSocket」，无 CBOR、不强制 zstd。
 * 本仓已有同类先例：为绕开 `@atproto-labs/fetch-node` 在 Bun 上炸掉，手写了
 * `AtprotoHandleResolver`（见 `client.ts`）。
 *
 * **参数名只允许出现在 `buildSubscribeUrl` 一个函数里**，其他任何地方不许出现字面量。
 * 线上实测过两个坑，两条都写成反向断言测过：
 * - `kinds` 是**重复传参**，逗号拼会 400 `unknown kind "commit,identity"`；
 * - 有 `collections` 时 `kinds` **必须含 `commit`**，否则 400
 *   `collections filter can never apply`。
 */

const JETSTREAM_ORIGIN = 'wss://jetstream.us-east.bsky.network'
const SUBSCRIBE_PATH = '/xrpc/network.bsky.jetstream.subscribeEvents'
/**
 * 两种 collection。**like 也能订到，是 `dids` 过滤方式的直接结果**：JetStream 按**事件来源
 * repo** 过滤，而一条 like 记录住在**点赞的人**的 repo 里 —— 所以绑定用户在 Bluesky
 * 上的赞拿得到，陌生人对我们用户帖子的赞拿不到（那是另一堵墙，与「别人的回复」
 * 同一堵，本轮不动）。见 `mirrorLike`。
 */
const WANTED_COLLECTIONS = [POST_COLLECTION, LIKE_COLLECTION]
/**
 * `identity` 是免费的：`collections` 只约束 commit 事件，它会照常流过。
 *
 * `sync` 必须显式订，且 **v1 从来没有这个 kind** —— 它是 v2 独有的，漏订的后果是
 * **静默缺帖**（见 `queueResync` 的说明）。lexicon 给 `kinds` 的上限正好是 4，这里是满的。
 */
const WANTED_KINDS = ['commit', 'identity', 'account', 'sync']
const CURSOR_KEY = 'jetstream'

/**
 * 无帧多久就把连接当成半开、主动重连。不能靠 `ws.ping()` 保活 —— 端点声明「任何
 * 客户端数据帧都会关连接」，而且 Bun 客户端**看不见 pong**：实测 `ws.ping()` 发得出去、
 * 对端也照回，但 `onpong` 根本不触发（`onping`/`onpong` 是服务端那套 API）。链路死没死
 * 只能靠「还收不收得到帧」判断。
 */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
/**
 * Cap on the idle bound, which grows while the stream stays quiet.
 *
 * A subscription filtered to a few DIDs is silent by default — one person posts a few
 * times a day, so five quiet minutes is the norm, not evidence of a half-open socket.
 * Probing every five minutes on that assumption tore down a healthy connection ~243
 * times a day and wrote ~486 error lines doing it. So back the probe off as the silence
 * lasts, and snap back to `IDLE_TIMEOUT_MS` the moment a frame arrives: right after
 * activity is exactly when a missed event costs something.
 *
 * Loosening this is bounded by the cursor: a reconnect replays from it, so anything
 * published while the socket was silently dead comes back by itself as long as the
 * cursor is still inside the relay's lookback window — and when it is not, the
 * `cursor-too-old` branch queues a resync. The worst case is a stale *like*, which the
 * backfill cannot recover (see `backfill.ts`).
 */
const MAX_IDLE_TIMEOUT_MS = 30 * 60 * 1000
/**
 * 没有已绑定身份时的复查间隔。
 *
 * 空 DID 列表是硬闸门：`dids` 为空会退化成全网 firehose（100–160 事件/秒、
 * 1–3 GB/天），这台 2 vCPU / 958 MB 的机器会当场出事。
 */
const EMPTY_DID_RETRY_MS = 60 * 1000
/** 兜底轮询：绑定/解绑后 `scheduleJetstreamReconnect()` 会立刻重连，这个只是防漏。 */
const DID_POLL_MS = 60 * 1000
/** 绑定/解绑的重连合并窗口，避免连续操作引发重连风暴。 */
const RECONNECT_DEBOUNCE_MS = 5 * 1000
/** 预检拿到非 426 的 400（疑似代码 bug）后的退避。见 `connect()` 里的说明。 */
const FATAL_RETRY_MS = 30 * 60 * 1000
const MAX_BACKOFF_MS = 60 * 1000
/** 同一个 seq 反复失败多少次后放弃重放、直接跳过。防毒丸事件把读路径钉死在重连循环里。 */
const MAX_REPLAYS = 5

// ─── 类型 ─────────────────────────────────────────────────────────────────────

interface CommitPayload {
  $type?: string
  seq: number
  did: string
  time: string
  operation: 'create' | 'update' | 'delete'
  collection: string
  rkey: string
  /** delete 事件不带 record，且 cid 不可靠 —— 按构造出的 URI 删，不要依赖它。 */
  cid?: string
  record?: Record<string, unknown>
}

interface IdentityPayload {
  $type?: string
  seq: number
  did: string
  time: string
  identity?: { did?: string, handle?: string }
}

/** v2 独有：仓库的 commit 链断裂，上游让消费者重新同步这个仓库。 */
interface SyncPayload {
  $type?: string
  seq: number
  did: string
  time: string
  sync?: { seq?: number, rev?: string }
}

// ─── URL 拼装（参数名唯一的出口）───────────────────────────────────────────────

export function buildSubscribeUrl(dids: string[], cursor?: number): string {
  // 这一条是硬闸门，不是保险：`dids` 缺席时端点语义是「全网」，不是「什么都不订」。
  if (!dids.length)
    throw new Error('buildSubscribeUrl: 空 DID 列表会退化成全网 firehose，拒绝连接')

  const params = new URLSearchParams()
  for (const did of dids)
    params.append('dids', did)
  for (const collection of WANTED_COLLECTIONS)
    params.append('collections', collection)
  for (const kind of WANTED_KINDS)
    params.append('kinds', kind)
  if (cursor !== undefined)
    params.set('cursor', String(cursor))

  return `${JETSTREAM_ORIGIN}${SUBSCRIBE_PATH}?${params}`
}

// ─── 预检 ─────────────────────────────────────────────────────────────────────

type Preflight =
  | { kind: 'ok' }
  | { kind: 'cursor-too-old', floor: number }
  | { kind: 'fatal', reason: string }
  | { kind: 'unavailable', reason: string }
  | { kind: 'network', reason: string }

/**
 * 用纯 HTTP GET 预检同一个 URL。这**不是**可选的优化：
 *
 * Bun 里原生 `new WebSocket()` 握手被拒时**拿不到 HTTP 状态码和响应体**，只有
 * `close code 1002 / "Expected 101 status code"`。没有预检就分不清「代码 bug 参数
 * 拼错」和「停机太久游标过期」—— 而这两者的处置完全相反。
 *
 * 期望 426（参数合法，只差协议升级）。
 */
export async function preflight(url: string): Promise<Preflight> {
  const httpUrl = url.replace(/^wss:/, 'https:')
  let res: Response
  try {
    res = await fetch(httpUrl)
  }
  catch (err) {
    return { kind: 'network', reason: String(err) }
  }

  if (res.status === 426)
    return { kind: 'ok' }

  // A 5xx/429 is the relay failing, not our request: with no healthy backend, HAProxy
  // answers 503 *for every path on the host*, error page and all. Retryable, and the
  // body is an HTML error page, so don't bother reading it.
  if (res.status >= 500 || res.status === 429)
    return { kind: 'unavailable', reason: `HTTP ${res.status}` }

  const body = await res.text().catch(() => '')
  if (res.status === 400 && body.includes('CursorTooOld')) {
    const match = /below lookback floor (\d+)/.exec(body)
    return { kind: 'cursor-too-old', floor: match?.[1] ? Number(match[1]) : 0 }
  }

  return { kind: 'fatal', reason: `HTTP ${res.status}: ${body.slice(0, 300)}` }
}

// ─── 游标 ─────────────────────────────────────────────────────────────────────

/** 内存游标是持久状态的镜像；**绝不允许跑在持久状态前面**，否则静默丢事件。 */
let currentCursor: number | undefined

function loadCursor(): number | undefined {
  const row = db
    .select({ value: atprotoCursor.value })
    .from(atprotoCursor)
    .where(eq(atprotoCursor.key, CURSOR_KEY))
    .get()
  const parsed = row ? Number(row.value) : Number.NaN
  currentCursor = Number.isFinite(parsed) ? parsed : undefined
  return currentCursor
}

/** 与镜像写在**同一个事务**里，这是「不静默丢事件」的唯一防线。 */
function advanceCursor(tx: Tx, seq: number): void {
  if (currentCursor !== undefined && seq <= currentCursor)
    return
  tx.insert(atprotoCursor)
    .values({ key: CURSOR_KEY, value: String(seq) })
    .onConflictDoUpdate({ target: atprotoCursor.key, set: { value: String(seq) } })
    .run()
  currentCursor = seq
}

function resetCursor(floor: number): void {
  const value = String(floor)
  db.insert(atprotoCursor)
    .values({ key: CURSOR_KEY, value })
    .onConflictDoUpdate({ target: atprotoCursor.key, set: { value } })
    .run()
  currentCursor = floor
}

// ─── 镜像规则 ─────────────────────────────────────────────────────────────────

/**
 * 帖的镜像。规则本身住在 `mirror.ts`（回填与实时流共用同一份，见那里的说明）。这里
 * 只做「commit 事件 → 记录」的翻译：delete 走软删，update 带 `isUpdate` 标记，其余
 * 一律按 create。
 *
 * **只管 `app.bsky.feed.post`，按 collection 的分派在 `handleFrame` 里做**（like 走
 * `mirrorLike`，它不落 `posts`）。这里的闸门是它自己的契约，不是防御性代码：
 * `mirrorRecord` 对一条 like 记录会造出一张空白卡片 —— 它把非空的 `record.text` 当作
 * 唯一门槛，而 like 没有 `text`，结果是一条内容为空的帖被插进题壁流。
 */
function mirrorCommit(tx: Tx, payload: CommitPayload): MirrorOutcome[] {
  if (payload.collection !== POST_COLLECTION)
    return []

  if (payload.operation === 'delete') {
    mirrorDelete(tx, payload.did, payload.rkey)
    return []
  }

  const outcome = mirrorRecord(tx, {
    did: payload.did,
    rkey: payload.rkey,
    cid: payload.cid,
    record: payload.record,
    observedAt: payload.time,
    isUpdate: payload.operation === 'update',
  })
  return outcome ? [outcome] : []
}

/**
 * 入站的赞要补发的事件。与 `MirrorOutcome` **分开表达**是因为处置完全不同：
 * `publishMirrored` 会按**帖**的形状发一个 `app.bsky.feed.post` 公共事件，一个 like
 * 的 outcome 混进那个数组就会发出结构错误的帧。赞补发的是本站自己的
 * `net.pbhh.post.liked` —— 与用户在本站点赞时**逐字同一个话题、同一个 payload 形状**，
 * 所以通知链路（`notification/service.ts` 的 `onPostLiked`）一行都不用改。
 */
interface LikeOutcome {
  postId: number
  actorUsername: string
  liked: boolean
}

/**
 * `record.subject.uri`。形状不对一律返回 `null`，**调用方必须静默跳过**。
 *
 * 为什么不能直接写 `record.subject.uri`：那条路径上抛出的 TypeError 会一路走到
 * `handleFrame` 的 catch，而那里的处置是**断开 socket + 从游标重放整条事件** —— 别人
 * 写的一条畸形记录就能让整条读路径抖动。更糟的是 `console.error(..., err)` 会把异常
 * 文本落盘，而异常文本里可能带着那个 subject uri，正好违反下面的隐私规则。
 */
function readLikeSubjectUri(record: Record<string, unknown>): string | null {
  const subject = record.subject
  if (typeof subject !== 'object' || subject === null)
    return null
  const uri = (subject as { uri?: unknown }).uri
  return typeof uri === 'string' && uri ? uri : null
}

/**
 * 入站的赞（`app.bsky.feed.like`）。**必须是个不抛异常的 total 函数**，原因同
 * `readLikeSubjectUri`：抛出去 = 断连重放 + 异常文本落盘。
 *
 * 「按规则跳过」与「SQL 失败」两类必须分开对待：
 * - **形状不合法 / subject 不在本地 / did 不是我们的绑定用户 → 静默返回**，不写任何
 *   日志、不抛异常。我们会收到绑定用户的**全部**点赞活动，其中绝大多数与 pbhh.net
 *   毫无关系，它们不许留下任何痕迹。
 * - **SQL 执行失败照常抛**（insert 撞 FK、列不存在、唯一索引冲突）。那是我们的 bug，
 *   不是对方的隐私；为了「不记日志」把它吞成 `return undefined` 等于把真 bug 变成
 *   静默丢数据。
 *
 * **这一轮明确不做回填**：绑定之前的赞一条都进不来，`sync` 触发的重同步复用
 * `backfillFromPds`（只拉 `POST_COLLECTION`），同样不修 like。所以站内的赞数必然长期
 * 低于 Bluesky 的真实赞数。要修得加一张 pending 表或给绑定流程加一次
 * `listRecords(collection=app.bsky.feed.like)`，是另一个量级的改动。
 */
function mirrorLike(tx: Tx, payload: CommitPayload): LikeOutcome | undefined {
  const identity = AtprotoService.getIdentityByDid(payload.did)
  if (!identity)
    return undefined

  // 事件自己的地址。取消赞的 commit 事件**不带 `record`**（见 `CommitPayload.cid`
  // 上面的注释），所以读不到 `subject` —— 只能靠这个地址反查这是哪一行。这就是
  // `post_likes.atproto_uri` 非有不可的原因。
  const incoming = atUri(payload.did, LIKE_COLLECTION, payload.rkey)

  if (payload.operation === 'delete') {
    // **取消不受 `syncLikesEnabled` 约束**，与出站侧「`publishEnabled` 不闸撤回」
    // 逐字同理（见 `mirrorLocalLike`）：开关管的是要不要把**新的**赞拉进来，而一条
    // 已经拉进来的赞在 Bluesky 上被取消之后，留在本站就是一句永远无法自愈的假话。
    //
    // **这里也不能带 `deleted = false` 那个条件** —— 那是 create 侧的闸门（帖子已被
    // 删掉就不该再新增赞），套到这里会让旧行永远删不掉。
    const hit = tx
      .select({ postId: postLikes.postId, username: postLikes.username })
      .from(postLikes)
      .where(eq(postLikes.atprotoUri, incoming))
      .get()
    if (!hit)
      return undefined
    // 按主键删，不按 uri：`atproto_uri` 只是「最近观测到的地址」，主键才是身份。
    tx.delete(postLikes)
      .where(and(eq(postLikes.postId, hit.postId), eq(postLikes.username, hit.username)))
      .run()
    // `liked: false` **也必须产出**，否则 `onPostLiked` 的撤销分支永远不会被入站触发，
    // 那条通知会一直留在收件箱里。
    return { postId: hit.postId, actorUsername: hit.username, liked: false }
  }

  // create 与 update 走同一条路径。**update 必须和 create 一样处理**：我们自己
  // `putRecord` 覆盖同 rkey 时发出的**就是** update（今天不会发生，但 `Republish` 之类
  // 的操作会），不一起处理就会让自己发出去的记录漏掉一类。like 没有可更新的内容，
  // 语义上 update ≡ create。
  if (!identity.syncLikesEnabled)
    return undefined

  const record = payload.record
  if (!record || typeof record !== 'object')
    return undefined
  const subjectUri = readLikeSubjectUri(record)
  if (!subjectUri)
    return undefined

  const post = tx
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.atprotoUri, subjectUri), eq(posts.deleted, false)))
    .get()
  // **绝大多数事件走到这里就结束了**（赞的是一条与 pbhh.net 无关的帖）。静默。
  if (!post)
    return undefined

  const existing = tx
    .select({ atprotoUri: postLikes.atprotoUri })
    .from(postLikes)
    .where(and(eq(postLikes.postId, post.id), eq(postLikes.username, identity.username)))
    .get()

  if (!existing) {
    tx.insert(postLikes)
      .values({ postId: post.id, username: identity.username, atprotoUri: incoming })
      .run()
    return { postId: post.id, actorUsername: identity.username, liked: true }
  }

  // 已存在且地址相同 = **回环吸收点**：我们自己发出去的那条赞被 JetStream 送了回来。
  // 无操作、无 outcome ⇒ 不发通知，用户在本地看到的状态一个字都没变。
  if (existing.atprotoUri === incoming)
    return undefined

  // ── 认领 ───────────────────────────────────────────────────────────────────
  // 本地这一行的 `atproto_uri` 不等于刚观测到的地址：为 NULL（未绑定或关掉开关时点
  // 的赞），或者是一个别的地址（见下面的场景）。`atproto_uri` 的含义是「这条赞目前
  // 对应的、**最近观测到的真实记录地址**」，不是「我们发出去的那条」—— 这个语义是
  // 必需的，因为**客户端只会删掉它自己知道的那条记录**，我们存错一条就等于用户的取消
  // 永远落不了地。
  //
  // 最隐蔽的那个场景（比 NULL 更常见）：
  //   1. 用户在本站点赞 → 行指向 `U`，put 投递成功，但 **AppView 还没索引到 `U`**，
  //      官方客户端因此显示「未赞」；
  //   2. 用户手快，在客户端又点了一下 → repo 里产生**第二条**记录 `R2`；
  //   3. 这条 `R2` 的 create 事件到达。若「不认领」，行仍指向 `U`；
  //   4. 用户在客户端取消 → 客户端删的是它知道的 `R2` → 入站 delete 按 `R2` 查不到
  //      → **本地仍显示已赞**，而用户的取消在两边都没生效。
  //
  // 所以：**无条件认领**，并把旧地址收敛掉。收敛不需要知道 `U` 到底投递成功没有 ——
  // 两步各自幂等，见 `retractStaleLike`。
  tx.update(postLikes)
    .set({ atprotoUri: incoming })
    .where(and(eq(postLikes.postId, post.id), eq(postLikes.username, identity.username)))
    .run()
  if (existing.atprotoUri) {
    retractStaleLike(tx, {
      did: identity.did,
      username: identity.username,
      uri: existing.atprotoUri,
    })
  }
  // **刻意不产出 outcome**：本地这一行本来就在，用户看到的状态没变。产出会经
  // `onPostLiked` 的 `liked: true` 分支**再插一条通知**（那个 insert 没有去重，每次
  // 都插），于是「在客户端重复点一下」就等于给作者多发一条通知。
  return undefined
}

/**
 * `identity` 事件是 handle 的保鲜来源 —— commit 事件不带作者 handle，所以
 * `getIdentityByDid(did)?.handle` 是镜像时唯一能拿到 handle 的地方，靠这条保持新鲜。
 *
 * 这里走 `AtprotoService`（内部用 `db`）而不是传入的 `tx`：`bun:sqlite` 是单连接，
 * drizzle 的 `db.transaction` 只是在同一连接上发 BEGIN/COMMIT，所以这次写**确实**在
 * 事务内。写成 `tx` 反而会把 service 的接口拆开。
 */
function applyIdentity(payload: IdentityPayload): void {
  const did = payload.identity?.did ?? payload.did
  const handle = payload.identity?.handle
  if (typeof handle !== 'string' || !handle)
    return
  const identity = AtprotoService.getIdentityByDid(did)
  if (!identity)
    return
  AtprotoService.updateObservedHandle(identity.username, handle)
}

// ─── 可变状态 ─────────────────────────────────────────────────────────────────

/**
 * 全部集中在这里，而不是各自贴着用它的函数。两个原因：`handleFrame` 要用
 * `socket` / `lastEventAt`，把它们声明在 `handleFrame` 后面会被
 * `no-use-before-define` 拦下；集中摆放也让「谁在改这些状态」一眼看得全。
 */
let started = false
let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let watchdogTimer: ReturnType<typeof setTimeout> | null = null
let didPollTimer: ReturnType<typeof setInterval> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let backoffAttempt = 0
/** Whether the current run of failed preflights has already been logged. See `connect()`. */
let preflightLogged = false
/** Idle bound for the current quiet stretch; grows while silent, snaps back on a frame. */
let idleTimeoutMs = IDLE_TIMEOUT_MS
/** Set when *we* close the socket, so `onclose` does not report our own teardown as a failure. */
let closingByUs = false
let didSignature = ''
let lastEventAt: number | undefined
let connected = false
let resyncTimer: ReturnType<typeof setTimeout> | null = null
/**
 * `sync` 的频率我们没有任何实测数据（lexicon 只说它是归档期的），所以先把它记成
 * 一个可观测的数字：状态端点上能看到「到底发生过几次」。
 */
let syncEventCount = 0
let lastSyncAt: number | undefined

// ─── 帧处理 ───────────────────────────────────────────────────────────────────

type FrameKind = 'commit' | 'identity' | 'account' | 'sync'

function frameKind(payload: Record<string, unknown>): FrameKind | undefined {
  const type = payload.$type
  if (typeof type === 'string') {
    const hash = type.lastIndexOf('#')
    const kind = hash >= 0 ? type.slice(hash + 1) : type
    if (kind === 'commit' || kind === 'identity' || kind === 'account' || kind === 'sync')
      return kind
  }
  // 兜底：形状判断（`$type` 缺失时）。
  if (typeof payload.operation === 'string' && typeof payload.collection === 'string')
    return 'commit'
  if (payload.identity)
    return 'identity'
  if (payload.account)
    return 'account'
  if (payload.sync)
    return 'sync'
  return undefined
}

// ─── `sync` 事件的重同步 ──────────────────────────────────────────────────────

/**
 * 上游说「这个仓库的 commit 链断了，你自己重新同步一遍」。**只有 v2 会发这个事件**，
 * v1 的线上协议里根本不存在 —— 这就是当初漏掉它的原因。
 *
 * 漏掉的后果不是报错，是**静默缺帖**：链断期间那些 commit 事件压根不会流过来，用户
 * 在 Bluesky 发的帖永远不出现在本站，而日志里一个错都没有。所以这条路径存在的主要
 * 价值是「把静默变成不静默」。
 *
 * lexicon 的措辞是 **archived** —— 它来自归档重放（停机后追赶），不在实时流末尾。
 * 也就是说**平时不会看到它**，只在补历史的时候才可能出现。触发频率我们没有任何实测
 * 数据，所以下面的冷却与批量上限是按「可能很频繁」设的：宁可少同步一次，也不能让一个
 * 反复断裂的仓库把服务端变成回填机器（每轮回填是一次 `listRecords`，走的是用户的 PDS）。
 *
 * 重同步复用 `backfillFromPds` —— 与绑定回填**同一个函数、同一套镜像规则**，所以
 * 这里不需要第二套实现来保持同步。它按 `atproto_uri` 去重，已经镜像过的帖不会重复。
 */
const resyncQueue = new Set<string>()
/** 合并窗口：一次追赶可能连着来好几个 sync，没必要一个一个回填。 */
const RESYNC_DEBOUNCE_MS = 30 * 1000
/** 同一个仓库的两次重同步之间至少隔这么久。 */
const RESYNC_COOLDOWN_MS = 60 * 60 * 1000
/** 一轮 drain 最多处理几个仓库，其余的留给下一轮。 */
const RESYNC_BATCH = 3
const lastResyncAt = new Map<string, number>()

/**
 * **读循环里唯一允许做的事**：入队。所有 `await` 都在 `drainResync` 里。
 *
 * 未绑定 / 非本站用户的 DID 直接丢掉 —— `sync` 是按 `dids` 过滤后送来的，正常情况下
 * 不会有别人的，但解绑与事件之间本来就存在竞态窗口。
 */
function queueResync(did: string): void {
  if (!AtprotoService.getIdentityByDid(did))
    return
  const last = lastResyncAt.get(did)
  if (last !== undefined && Date.now() - last < RESYNC_COOLDOWN_MS) {
    console.warn(`[jetstream] ${did} 在冷却期内（${RESYNC_COOLDOWN_MS / 60000} 分钟内已重同步过），忽略这次 sync`)
    return
  }
  resyncQueue.add(did)
  armResync()
}

function armResync(): void {
  if (resyncTimer || !resyncQueue.size || !started)
    return
  resyncTimer = setTimeout(() => {
    resyncTimer = null
    void drainResync()
  }, RESYNC_DEBOUNCE_MS)
  resyncTimer.unref?.()
}

/**
 * 导出是为了让探针能直接驱动它 —— 否则唯一的触发途径是「网络上来一个 sync 帧、
 * 再等 30 秒防抖」，本地复现不出来。
 *
 * 逐条 `await`：回填是网络 I/O，同时打几个用户的 PDS 没有好处，而队列本来就有上限。
 */
export async function drainResync(): Promise<void> {
  const batch = [...resyncQueue].slice(0, RESYNC_BATCH)
  for (const did of batch) {
    resyncQueue.delete(did)
    lastResyncAt.set(did, Date.now())
    // `publish: true` —— 断链漏掉的正是「本该由实时流通知过一遍」的那几条，粉丝本来
    // 该收到通知却没收到。窗口与静默规则在 `backfill.ts` 里。
    //
    // 身份可能刚好在这一刻被解绑：`restore` 会失败，而 `backfillFromPds` 自己吞掉
    // 所有异常只记日志，所以这里不需要额外保护。
    await backfillFromPds(did, { publish: true })
  }
  if (resyncQueue.size)
    armResync()
}

let failureSeq: number | undefined
let failureCount = 0

/**
 * **这个函数里不允许出现任何 `await`。** `ConsumerTooSlow` 是终态断连，所以一个帧只
 * 做三件事：解析 JSON → 一个同步事务 → `bus.publish`。handle 刷新之类的网络操作
 * 不在这里（identity 事件是纯本地写）。
 *
 * 导出是为了让镜像规则表能被**合成帧**驱动 —— 这是本模块唯一不依赖真 socket 的入口，
 * 而规则表里的分支（空正文、父帖不在本地、update 未命中）从真实账号上按需制造不出来。
 */
export function handleFrame(raw: string): void {
  let frame: { $type?: string, payload?: Record<string, unknown> }
  try {
    frame = JSON.parse(raw)
  }
  catch {
    return
  }
  if (!frame || frame.$type !== 'message' || !frame.payload)
    return

  const payload = frame.payload
  const seq = payload.seq
  if (typeof seq !== 'number')
    return
  const kind = frameKind(payload)
  if (!kind)
    return

  lastEventAt = Date.now()
  const outcomes: MirrorOutcome[] = []
  /**
   * 赞的结果**并列一个数组**，绝不混进 `outcomes` —— `publishMirrored` 会按帖的形状
   * 发 `app.bsky.feed.post`。两者在同一个提交后循环里发布。
   */
  const likes: LikeOutcome[] = []
  /** 事务提交之后才入队，与 `outcomes` 同一个道理：回滚了就不该留下副作用。 */
  const syncs: string[] = []

  try {
    db.transaction((tx) => {
      if (kind === 'commit') {
        // **按 collection 分派**。改之前这里是一条「非 post 一律静默丢弃」的闸门 ——
        // 也就是说 like 事件一直在流进来、一直被吞掉，站点上没有任何痕迹说明这件事
        // 发生过。现在两条路各自有名字。
        const commit = payload as unknown as CommitPayload
        if (commit.collection === LIKE_COLLECTION) {
          const like = mirrorLike(tx, commit)
          if (like)
            likes.push(like)
        }
        else {
          outcomes.push(...mirrorCommit(tx, commit))
        }
      }
      else if (kind === 'identity') {
        applyIdentity(payload as unknown as IdentityPayload)
      }
      else if (kind === 'sync') {
        // **只收集，不在这里做任何网络请求**（这个函数里不允许有 await）。
        // 没带 did 的帧也照样收进来：计数器要的是「这个事件多久发生一次」，
        // 而不是「其中几次是可用的」—— 频率观测不能被过滤吃掉。
        const sync = payload as unknown as SyncPayload
        syncs.push(typeof sync.did === 'string' ? sync.did : '')
      }
      else {
        // v1 **只记日志**：`#account` 未必等于「账号删了」（可能是远端审核动作），
        // 因一次远端动作删用户本地内容不可逆。
        console.warn(`[jetstream] account 事件（未处理）did=${payload.did} status=${JSON.stringify((payload.account as { status?: string } | undefined)?.status)}`)
      }

      advanceCursor(tx, seq)
    })
    failureSeq = undefined
    failureCount = 0
  }
  catch (err) {
    // 事务回滚 = 游标没推进。若直接继续，下一个事件的 advanceCursor 会跨过它，
    // 那就是**静默缺口**。所以断开重连，从持久游标重放。
    if (failureSeq === seq) {
      failureCount++
    }
    else {
      failureSeq = seq
      failureCount = 1
    }
    if (failureCount >= MAX_REPLAYS) {
      // 毒丸事件：再重放只会把读路径钉死在重连循环里。跳过它并大声记日志 ——
      // 跳过一个已知的坏事件，好过整条读路径永久停摆。
      console.error(`[jetstream] seq=${seq} 连续失败 ${failureCount} 次，跳过该事件以恢复读取:`, err)
      try {
        db.transaction((tx) => {
          advanceCursor(tx, seq)
        })
      }
      catch (advanceErr) {
        console.error('[jetstream] 跳过时推进游标也失败了:', advanceErr)
      }
      failureSeq = undefined
      failureCount = 0
      return
    }
    console.error(`[jetstream] seq=${seq} 处理失败（第 ${failureCount} 次），断开以从游标重放:`, err)
    socket?.close()
    return
  }

  for (const outcome of outcomes)
    publishMirrored(outcome)

  // 与本站点一次赞**逐字同一个话题、同一个 payload 形状**，所以通知链路零改动。
  //
  // **payload 里永远不加 did / at-uri**：这个话题在 `PUBLIC_TOPICS` 里，匿名 SSE 与
  // 所有注册的第三方 webhook 都收得到。
  for (const like of likes) {
    bus.publish('net.pbhh.post.liked', {
      postId: like.postId,
      actorUsername: like.actorUsername,
      liked: like.liked,
    })
  }

  // 事务已提交。`sync` 是「我们可能已经漏了帖」的唯一信号，所以即使没绑定的 DID
  // 被 queueResync 丢掉，也要留下一条日志 —— 这个事件本身的出现就值得知道。
  if (syncs.length) {
    syncEventCount += syncs.length
    lastSyncAt = Date.now()
    for (const did of syncs) {
      if (!did) {
        // 按 lexicon 这不合法（`did` 是 required），真出现就是协议变了。
        console.warn('[jetstream] sync 事件没有带 did，无法判断该重新同步哪个仓库')
        continue
      }
      console.warn(`[jetstream] sync 事件：${did} 的 commit 链断裂，已排队重新同步（若已绑定）`)
      queueResync(did)
    }
  }
}

// ─── 连接生命周期 ─────────────────────────────────────────────────────────────

function nextBackoff(): number {
  backoffAttempt++
  const base = Math.min(1000 * 2 ** backoffAttempt, MAX_BACKOFF_MS)
  return base + Math.floor(Math.random() * 1000)
}

function scheduleConnect(delayMs: number): void {
  if (!started)
    return
  if (reconnectTimer)
    clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connect()
  }, delayMs)
  reconnectTimer.unref?.()
}

function clearWatchdog(): void {
  if (watchdogTimer)
    clearTimeout(watchdogTimer)
  watchdogTimer = null
}

/** 收到任何帧就重置。超时说明连接半开（socket 静默死亡、`lastEventAt` 停更但无错误）。 */
function resetWatchdog(): void {
  // A frame arrived, so tighten back up — this is the stretch where silence is news.
  idleTimeoutMs = IDLE_TIMEOUT_MS
  armWatchdog()
}

/** Re-arm without touching the bound; the watchdog itself uses this while silence lasts. */
function armWatchdog(): void {
  clearWatchdog()
  // Read the bound now: it is the delay this timer is actually armed with, and the
  // callback below has already doubled it by the time it runs.
  const bound = idleTimeoutMs
  watchdogTimer = setTimeout(() => {
    idleTimeoutMs = Math.min(bound * 2, MAX_IDLE_TIMEOUT_MS)
    // Not an error: for a quiet subscription this is the designed steady state, and the
    // paired "已连接" line is what actually reports the outcome.
    console.debug(`[jetstream] ${Math.round(bound / 60000)} 分钟无帧，判定连接半开，主动重连`)
    closingByUs = true
    socket?.close()
    // 重连一次 close() 不一定立刻触发 onclose（半开连接正是如此），再武装一轮；
    // 真正的 onclose 会把它清掉。
    armWatchdog()
  }, bound)
  watchdogTimer.unref?.()
}

function currentDidSignature(): string {
  return AtprotoService.getBoundDids().slice().sort().join(',')
}

function openSocket(url: string, didCount: number): void {
  const ws = new WebSocket(url)
  socket = ws
  // A fresh socket must not inherit the flag from the close that led here — a stop or a
  // close that never fired `onclose` would otherwise have the next real failure read as
  // our own doing and drop to debug.
  closingByUs = false

  ws.onopen = () => {
    connected = true
    backoffAttempt = 0
    console.info(`[jetstream] 已连接（${didCount} 个 did，cursor=${currentCursor ?? '无'}）`)
    resetWatchdog()
  }

  ws.onmessage = (event) => {
    resetWatchdog()
    if (typeof event.data === 'string')
      handleFrame(event.data)
  }

  // 错误细节由紧随其后的 onclose 记录（Bun 的 error 事件不带 HTTP 状态码）。
  ws.onerror = () => {}

  ws.onclose = (event) => {
    if (socket !== ws)
      return
    const expected = closingByUs
    closingByUs = false
    socket = null
    connected = false
    clearWatchdog()
    if (!started)
      return
    // A close we asked for (idle watchdog, DID rebind) is routine — it happened ~243
    // times a day at error level, which buries everything else in /admin/log. Only a
    // close nobody asked for is a failure.
    if (expected)
      console.debug(`[jetstream] 连接关闭（主动）code=${event.code} reason=${event.reason || '-'}`)
    else
      console.error(`[jetstream] 连接关闭 code=${event.code} reason=${event.reason || '-'}，退避重连`)
    scheduleConnect(nextBackoff())
  }
}

async function connect(): Promise<void> {
  if (!started)
    return

  const dids = AtprotoService.getBoundDids()
  if (!dids.length) {
    // 硬闸门。**没有这一条，`dids=` 为空会退化成全网 firehose。**
    console.info(`[jetstream] 没有已绑定身份，暂不连接（${EMPTY_DID_RETRY_MS / 1000} 秒后再看）`)
    scheduleConnect(EMPTY_DID_RETRY_MS)
    return
  }

  loadCursor()
  const url = buildSubscribeUrl(dids, currentCursor)
  const result = await preflight(url)
  if (!started)
    return

  switch (result.kind) {
    case 'ok':
      // A clean preflight means the relay is up, so the next failure is a new run and
      // gets its own line. Not reset on open: a failed handshake would stick the flag.
      preflightLogged = false
      break
    case 'cursor-too-old':
      // 停机超过 relay 的 lookback 窗口。重置到 floor 会留下一个已知缺口，
      // 只能靠日志说明 —— 但比重连轰炸或永久停摆都好。
      console.error(`[jetstream] 游标超期（lookback floor ${result.floor}），重置游标后重连；这段时间的事件已缺失`)
      resetCursor(result.floor)
      // Nothing else will ever tell us what the skipped range held: `sync` events only
      // turn up on archived replay, and we just rejoined at the live tail — the very
      // signal that exists to say "you missed something" cannot fire for a range we
      // jumped over. So ask every bound repo for its recent records instead; that is
      // the same repair `sync` triggers, and it costs one `listRecords` per DID.
      //
      // Usually a no-op: if the DID was merely quiet, every record is already mirrored
      // and dedupes away. It only earns its keep when the reset really did skip events.
      for (const did of dids)
        queueResync(did)
      scheduleConnect(0)
      return
    case 'fatal':
      // 非 426 的 400 基本只可能是代码 bug（参数名/形状写错）。「停止重连轰炸」不等于
      // 放弃：用长退避代替停机，既不会刷屏，又保留了服务端行为变化后的自愈能力，
      // 且每次仍记 error。
      console.error(`[jetstream] 预检失败，疑似代码 bug（${FATAL_RETRY_MS / 60000} 分钟内不重试）: ${result.reason}`)
      scheduleConnect(FATAL_RETRY_MS)
      return
    case 'unavailable':
    case 'network':
      // The relay is unreachable — a 5xx/429 is its failure, a thrown fetch is the
      // link's — so neither means our request shape is wrong and both take the
      // 60s-capped backoff. They must NOT take fatal's 30 minutes: that turns one
      // upstream blip into half an hour of a dead read path, and the log would blame
      // our own parameters for it.
      //
      // Only the first line of a run: at a 60s cap a long outage would write 1440 lines
      // a day and flush the 500-entry ring behind /admin/log. onopen logs the recovery.
      if (!preflightLogged) {
        preflightLogged = true
        console.error(`[jetstream] 预检失败（中继不可达），退避重试: ${result.reason}`)
      }
      scheduleConnect(nextBackoff())
      return
  }

  openSocket(url, dids.length)
}

/** 幂等。绑定/解绑、以及看门狗都走这里。 */
export function scheduleJetstreamReconnect(): void {
  if (!started || debounceTimer)
    return
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    backoffAttempt = 0
    if (socket) {
      // Ours, not a failure: `onclose` logs it at debug.
      closingByUs = true
      socket.close()
    }
    else {
      scheduleConnect(0)
    }
  }, RECONNECT_DEBOUNCE_MS)
  debounceTimer.unref?.()
}

function pollDids(): void {
  const signature = currentDidSignature()
  if (signature === didSignature)
    return
  didSignature = signature
  console.info('[jetstream] 绑定列表变化，重连')
  backoffAttempt = 0
  if (socket) {
    // The `console.info` above already announced this one, so keep `onclose` quiet about it.
    closingByUs = true
    socket.close()
  }
  else {
    scheduleConnect(0)
  }
}

/** 启动点（`atproto/index.ts` 模块加载处）。**必须幂等** —— 重复调用不许开出第二条连接。 */
export function startJetstream(): void {
  if (started)
    return
  if ((Bun.env.JETSTREAM_ENABLED ?? 'on') === 'off') {
    console.info('[jetstream] JETSTREAM_ENABLED=off，读路径未启动')
    return
  }
  started = true
  didSignature = currentDidSignature()
  didPollTimer = setInterval(pollDids, DID_POLL_MS)
  didPollTimer.unref?.()
  // `stopJetstream` 会清掉重同步的定时器但**保留队列**，所以这里要把它重新武装起来，
  // 否则停机期间排上的重同步要等到下一个 sync 事件才有人管。
  armResync()
  void connect()
}

/**
 * 幂等可调用，形状上备好；**刻意不接 SIGTERM/SIGINT** —— 游标是事务性的，硬杀最多
 * 丢一次 in-flight 重试，正确性上不需要，而给这个至今零信号处理器的仓库引入全局
 * 处理器会改变进程行为。
 */
export function stopJetstream(): void {
  started = false
  clearWatchdog()
  if (reconnectTimer)
    clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (didPollTimer)
    clearInterval(didPollTimer)
  didPollTimer = null
  if (debounceTimer)
    clearTimeout(debounceTimer)
  debounceTimer = null
  // 队列**不清空**：重同步是本地状态修复，与连接无关，重连后接着做才对。
  if (resyncTimer)
    clearTimeout(resyncTimer)
  resyncTimer = null
  socket?.close()
  socket = null
  connected = false
}

export function getJetstreamStatus() {
  return {
    enabled: (Bun.env.JETSTREAM_ENABLED ?? 'on') !== 'off',
    connected,
    cursor: currentCursor ?? null,
    lastEventAt: lastEventAt ?? null,
    boundDidCount: AtprotoService.getBoundDids().length,
    /**
     * `sync` 的频率。**这两个数字是用来决定要不要保留整个重同步机制的**：
     * 一直是 0 就说明它只在极罕见的情况下出现，代价可以忽略；若是常态，
     * 那说明「链断裂」这件事本身需要单独看。
     */
    syncEventCount,
    lastSyncAt: lastSyncAt ?? null,
    resyncQueued: resyncQueue.size,
  }
}
