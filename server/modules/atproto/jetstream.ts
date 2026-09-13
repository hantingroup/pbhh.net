import { and, eq } from 'drizzle-orm'
import { atprotoCursor, db, posts } from 'server/database'
import { bus } from '../events/bus'
import * as AtprotoService from './service'

/**
 * 读路径：消费 JetStream，把用户发在 Bluesky 的帖子镜像进本站 `posts` 表。
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
const WANTED_COLLECTIONS = ['app.bsky.feed.post']
/** `identity` 是免费的：`collections` 只约束 commit 事件，它会照常流过。 */
const WANTED_KINDS = ['commit', 'identity', 'account']
const CURSOR_KEY = 'jetstream'

/**
 * 无帧多久就把连接当成半开、主动重连。不能靠 `ws.ping()` 保活 —— 端点声明「任何
 * 客户端数据帧都会关连接」，而 Bun 是否自动回 pong 未知，没必要冒这个险。
 */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
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
/** `record.createdAt` 的可信窗口，之外一律回退事件自身的 `time`。 */
const MAX_FUTURE_MS = 5 * 60 * 1000
const MAX_PAST_MS = 365 * 24 * 60 * 60 * 1000

// ─── 类型 ─────────────────────────────────────────────────────────────────────

/** drizzle 事务对象。用 `Parameters` 推导而不是手写泛型，省掉 schema 类型参数。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

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

/**
 * 镜像成功后要补发的事件。收集起来在**事务提交之后**再发 —— 事务里发会在回滚时
 * 留下幽灵事件。
 */
interface MirrorOutcome {
  username: string
  postId: number
  uri: string
  cid: string
  did: string
  handle?: string
  rkey: string
  time: string
  record: Record<string, unknown>
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

function atUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`
}

/**
 * `record.createdAt` 是客户端声明的发帖时间，`payload.time` 是服务端观测时刻
 * （实测差 1.7 秒），所以优先用前者。但**必须夹取**：一条 `createdAt: "2099-01-01"`
 * 的帖会永久钉在题壁流顶部，而解析失败也不能让 `NaN` 进库。
 */
function clampCreatedAt(value: unknown, fallbackIso: string): Date {
  const fallback = new Date(fallbackIso)
  const base = Number.isNaN(fallback.getTime()) ? new Date() : fallback
  if (typeof value !== 'string')
    return base
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()))
    return base
  const delta = parsed.getTime() - Date.now()
  if (delta > MAX_FUTURE_MS || delta < -MAX_PAST_MS)
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

function mirrorCommit(tx: Tx, payload: CommitPayload): MirrorOutcome[] {
  if (payload.collection !== 'app.bsky.feed.post')
    return []

  // 只订了已绑定身份的 repo，但解绑与事件到达可以并发，所以要再确认一次。
  const identity = AtprotoService.getIdentityByDid(payload.did)
  if (!identity)
    return []
  const username = identity.username
  const uri = atUri(payload.did, payload.collection, payload.rkey)

  if (payload.operation === 'delete') {
    // 删除事件不带 record 且 cid 不可靠，按构造出的 URI 删（幂等）。
    tx.update(posts).set({ deleted: true }).where(eq(posts.atprotoUri, uri)).run()
    return []
  }

  const record = payload.record
  if (!record || typeof record !== 'object')
    return []
  const text = typeof record.text === 'string' ? record.text : ''
  // `app.bsky.feed.post` 的 text 允许为空串（纯图片帖），而本站不支持图片 ——
  // 镜像成一张空白卡片比不镜像更糟。
  if (!text.trim())
    return []

  if (payload.operation === 'update') {
    const hit = tx
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.atprotoUri, uri))
      .get()
    // 命中则只更新正文。**不动 title** —— 那个字段是本站的，不属于这条记录。
    if (hit) {
      tx.update(posts).set({ content: text }).where(eq(posts.id, hit.id)).run()
      return []
    }
    // 未命中按 create 处理（下面继续）。
  }

  const parentUri = readReplyParentUri(record)
  let parentId: number | null = null
  if (parentUri !== undefined) {
    // 是回复，但父帖不在本地 —— 跳过，否则它会错误地冒到题壁流顶层。
    if (!parentUri)
      return []
    const parent = tx
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.atprotoUri, parentUri), eq(posts.deleted, false)))
      .get()
    if (!parent)
      return []
    parentId = parent.id
  }

  // `on conflict do nothing` 是**回环吸收点**：写路径发出去的记录会被 JetStream
  // 送回来，靠 `posts.atproto_uri` 上的唯一索引在这里被吃掉。
  const inserted = tx
    .insert(posts)
    .values({
      username,
      content: text,
      parentId,
      createdAt: clampCreatedAt(record.createdAt, payload.time),
      atprotoUri: uri,
      atprotoCid: payload.cid ?? null,
    })
    .onConflictDoNothing({ target: posts.atprotoUri })
    .returning({ id: posts.id })
    .get()

  if (!inserted)
    return []

  return [{
    username,
    postId: inserted.id,
    uri,
    cid: payload.cid ?? '',
    did: payload.did,
    handle: identity.handle,
    rkey: payload.rkey,
    time: payload.time,
    record,
  }]
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
let didSignature = ''
let lastEventAt: number | undefined
let connected = false

// ─── 帧处理 ───────────────────────────────────────────────────────────────────

function frameKind(payload: Record<string, unknown>): 'commit' | 'identity' | 'account' | undefined {
  const type = payload.$type
  if (typeof type === 'string') {
    const hash = type.lastIndexOf('#')
    const kind = hash >= 0 ? type.slice(hash + 1) : type
    if (kind === 'commit' || kind === 'identity' || kind === 'account')
      return kind
  }
  // 兜底：形状判断（`$type` 缺失时）。
  if (typeof payload.operation === 'string' && typeof payload.collection === 'string')
    return 'commit'
  if (payload.identity)
    return 'identity'
  if (payload.account)
    return 'account'
  return undefined
}

function publishMirrored(outcome: MirrorOutcome): void {
  // 第一条让 `PostPage.vue` 的 reload() 与粉丝通知自动工作，前端零改动。
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

  try {
    db.transaction((tx) => {
      if (kind === 'commit')
        outcomes.push(...mirrorCommit(tx, payload as unknown as CommitPayload))
      else if (kind === 'identity')
        applyIdentity(payload as unknown as IdentityPayload)
      else
        // v1 **只记日志**：`#account` 未必等于「账号删了」（可能是远端审核动作），
        // 因一次远端动作删用户本地内容不可逆。
        console.warn(`[jetstream] account 事件（未处理）did=${payload.did} status=${JSON.stringify((payload.account as { status?: string } | undefined)?.status)}`)

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
  clearWatchdog()
  watchdogTimer = setTimeout(() => {
    console.error(`[jetstream] ${IDLE_TIMEOUT_MS / 60000} 分钟无帧，判定连接半开，主动重连`)
    socket?.close()
    // 重连一次 close() 不一定立刻触发 onclose（半开连接正是如此），再武装一轮；
    // 真正的 onclose 会把它清掉。
    resetWatchdog()
  }, IDLE_TIMEOUT_MS)
  watchdogTimer.unref?.()
}

function currentDidSignature(): string {
  return AtprotoService.getBoundDids().slice().sort().join(',')
}

function openSocket(url: string, didCount: number): void {
  const ws = new WebSocket(url)
  socket = ws

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
    socket = null
    connected = false
    clearWatchdog()
    if (!started)
      return
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
      break
    case 'cursor-too-old':
      // 停机超过 relay 的 lookback 窗口。重置到 floor 会留下一个已知缺口，
      // 只能靠日志说明 —— 但比重连轰炸或永久停摆都好。
      console.error(`[jetstream] 游标超期（lookback floor ${result.floor}），重置游标后重连；这段时间的事件已缺失`)
      resetCursor(result.floor)
      scheduleConnect(0)
      return
    case 'fatal':
      // 非 426 的 400 基本只可能是代码 bug（参数名/形状写错）。「停止重连轰炸」不等于
      // 放弃：用长退避代替停机，既不会刷屏，又保留了服务端行为变化后的自愈能力，
      // 且每次仍记 error。
      console.error(`[jetstream] 预检失败，疑似代码 bug（${FATAL_RETRY_MS / 60000} 分钟内不重试）: ${result.reason}`)
      scheduleConnect(FATAL_RETRY_MS)
      return
    case 'network':
      console.error(`[jetstream] 预检网络错误，退避重试: ${result.reason}`)
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
    if (socket)
      socket.close()
    else
      scheduleConnect(0)
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
  if (socket)
    socket.close()
  else
    scheduleConnect(0)
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
  }
}
