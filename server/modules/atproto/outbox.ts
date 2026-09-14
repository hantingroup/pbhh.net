import type { Tx } from './mirror'
import { Agent, RichText, XRPCError } from '@atproto/api'
import { and, asc, count, eq, lte } from 'drizzle-orm'
import { atprotoOutbox, db, posts } from 'server/database'
// rkey 的格式与「哪条帖是镜像来的」是同一个约定，两个方向共用一份定义。
// 放在 `posts/rkey.ts` 而不是这里，因为 `posts/service.ts` 不能 import atproto。
import { localRkey } from '../posts/rkey'
import { getOAuthClient } from './client'
import { atUri, POST_COLLECTION } from './mirror'
import * as AtprotoService from './service'

/**
 * 写路径：把本站的题壁（及其删除）通过 outbox 投进用户自己的 PDS。
 *
 * 四条设计约束，每条都对应一个具体的坏结果：
 *
 * 1. **路由显式调用，不订阅总线** —— `posts/index.ts` 建完帖直接调 `mirrorLocalPost`。
 *    订阅要额外写「这条事件是我自己发的还是镜像进来的」判别，而显式调用意图清楚。
 * 2. **不变量 L**：`posts.atproto_uri` 一定先于任何网络调用写好（见 `mirrorLocalPost`）。
 *    出站记录会被 JetStream 送回读路径，靠 `atproto_uri` 上的唯一索引 + `on conflict
 *    do nothing` 吸收 —— 只要本地行先存在，回环就是一次无操作；反过来先发后写，
 *    回环回来时找不到本地行，会凭空多出一条镜像帖。
 * 3. **超长不截断，宁可不发**。本站正文允许 1000 字，Bluesky 的 `text` 上限是 300
 *    字素。截断意味着用户的公开身份上出现半句话，比发不出去糟得多。
 * 4. **确定性 rkey**：`pbhh-<本地 id>`。URI 在建帖那一刻就可计算，`putRecord` 对同
 *    rkey 是覆盖语义因而重试天然幂等，回环也才能被第 2 条吸收。
 *
 * 依赖方向：`posts/index.ts → atproto/outbox.ts → posts/service.ts`；`posts/service.ts`
 * **完全不 import atproto**，无环。这里也不 import `posts/service` —— 需要的字段
 * （`atproto_uri` / `atproto_cid` / `parentId`）`toItem` 都不给，直接查表更短。
 *
 * 唯一的例外是 `posts/rkey.ts`：它自己不 import 任何东西，且 rkey 的格式是读写两侧
 * 共用的约定（写侧生成、读侧用来判断来源），必须只有一份定义。它不牵出依赖图。
 */

/** `app.bsky.feed.post` 的 `text` 上限（lexicon：maxGraphemes 300）。 */
const MAX_GRAPHEMES = 300

/** 一次 tick 最多处理多少行。单行是一次网络往返，串行发送。 */
const BATCH_SIZE = 20
const TICK_MS = 3000

/**
 * 放弃前的最大尝试次数。配合下面的指数退避（上限 1 小时）大约是**一天**：
 * 前 10 次 5s→2560s 合计约 1.4 小时，之后每小时一次。
 *
 * 不做错误分类（「这个是永久的、那个是临时的」全靠猜，猜错的方向都很糟），改用
 * 这个时间上限兜底。用尽后行**保留**并标 `dead`，供 `sqlite3` 排查。
 */
const MAX_ATTEMPTS = 30
const BASE_BACKOFF_MS = 5 * 1000
const MAX_BACKOFF_MS = 60 * 60 * 1000

/**
 * 走父链的上限。本地建帖保证 `parentId` 一定指向更早的行，链必然有尽头；这个上限
 * 只是防一手手工改库造出的环把后台循环挂死。
 */
const MAX_ANCESTOR_WALK = 64

/**
 * `ATPROTO_OUTBOUND`：
 * - `on`（默认）正常投递；
 * - `dry` 只 `console.log` 将要发出的 XRPC 调用与 record JSON，不发请求；
 * - `off` 完全不启动 worker。
 *
 * **`dry` 会照常出队**（否则队列永远堵着，后面的行一行都看不到），所以它只是本地
 * 演练用的开关 —— **别在生产上开**。
 */
type OutboundMode = 'on' | 'dry' | 'off'

function outboundMode(): OutboundMode {
  const raw = Bun.env.ATPROTO_OUTBOUND
  return raw === 'dry' || raw === 'off' ? raw : 'on'
}

// ─── 读取本地行 ───────────────────────────────────────────────────────────────

function loadPostRef(id: number) {
  return db
    .select({
      id: posts.id,
      parentId: posts.parentId,
      atprotoUri: posts.atprotoUri,
      atprotoCid: posts.atprotoCid,
    })
    .from(posts)
    .where(eq(posts.id, id))
    .get()
}

type PostRefRow = NonNullable<ReturnType<typeof loadPostRef>>

interface StrongRef { uri: string, cid: string }

/**
 * 回复锚点的解析结果。**三种结局的处置完全不同**，所以必须分开表达：
 * - `ok` 可以发；
 * - `unpublished` 链上有一环**根本不在 Bluesky 上**（`atproto_uri` 为空），这条回复
 *   永远发不出去 —— 终态，不重试；
 * - `pending` 链上有一环**正在投递中**（uri 有了、cid 还没有），过一会儿再来就行。
 */
type ReplyRefs =
  | { kind: 'ok', parent: StrongRef, root: StrongRef }
  | { kind: 'unpublished', postId: number }
  | { kind: 'pending', postId: number }

/**
 * `reply.parent` 与 `reply.root` 都必须带 `{uri, cid}` —— 光有 uri 不足以构成
 * strongRef（实测：JetStream 帧里 `reply.parent` 两样都带）。所以闸门是 **cid 非空**：
 * cid 只有 `putRecord` 成功返回后才有，于是「两列都非空」天然等价于「这一环已成功
 * 发布」。
 *
 * 一路走到顶就是 root。父帖可以是**镜像进来的 Bluesky 原帖**（它带着原记录的
 * uri+cid），所以本地用户回复镜像来的帖能正确发到 Bluesky。
 */
function resolveReplyRefs(parentId: number): ReplyRefs {
  const chain: PostRefRow[] = []
  let cursor: number | null = parentId
  while (cursor !== null) {
    if (chain.length >= MAX_ANCESTOR_WALK)
      return { kind: 'unpublished', postId: cursor }
    const row: PostRefRow | undefined = loadPostRef(cursor)
    // 行不存在 = 链断了。断链与「不在 Bluesky 上」是同一件事：锚不住。
    if (!row)
      return { kind: 'unpublished', postId: cursor }
    chain.push(row)
    cursor = row.parentId
  }

  // 两趟而不是一趟：`unpublished` 压过 `pending`。近处那一环在投递中、但根那一环
  // 根本不在 Bluesky 上时，等多久都没用。
  const missing = chain.find(row => !row.atprotoUri)
  if (missing)
    return { kind: 'unpublished', postId: missing.id }
  const inflight = chain.find(row => !row.atprotoCid)
  if (inflight)
    return { kind: 'pending', postId: inflight.id }

  const parent = chain[0]!
  const root = chain[chain.length - 1]!
  return {
    kind: 'ok',
    parent: { uri: parent.atprotoUri!, cid: parent.atprotoCid! },
    root: { uri: root.atprotoUri!, cid: root.atprotoCid! },
  }
}

// ─── 造记录 ───────────────────────────────────────────────────────────────────

type BuiltRecord =
  | { ok: true, record: Record<string, unknown> }
  | { ok: false, reason: string }

/**
 * 本地校验 + 造记录，一处收口。**失败即终态**：不重试、不入队，只记 warn。
 * 这些错误重试一万次也还是同样的错误，留在队列里只会喂大日志。
 *
 * 校验的是「Bluesky 收不收」，不是「本站允不允许」：正文为空、超过 300 字素、
 * 回复锚点不完整。`createdAt` 不需要校验 —— 它直接来自 `posts.created_at`，
 * 一定是个有效 Date。
 *
 * **`title` 直接丢弃。** 它不会丢：记录回环回来时按 `atproto_uri` 命中已存在的本地
 * 行、`on conflict do nothing`，本地 `title` 原样保留。拼进正文则会污染用户的公开
 * 文本，`#` 开头还会被当成 hashtag。
 */
function buildRecord(post: PostRefRow & { content: string, createdAt: Date }): BuiltRecord {
  const text = post.content
  if (!text.trim())
    return { ok: false, reason: '正文为空' }

  const rich = new RichText({ text })
  if (rich.graphemeLength > MAX_GRAPHEMES) {
    return {
      ok: false,
      reason: `正文 ${rich.graphemeLength} 字素，超过 Bluesky 的 ${MAX_GRAPHEMES} 字素上限（不截断，见模块说明）`,
    }
  }

  // facets 只做**不发网络请求**的检测：链接和 tag 能识别出来，mention 会退化成纯文本
  // （要拿到 DID 必须查 handle，那是一次网络调用，不能出现在后台循环里）。这是明确
  // 的取舍：宁可少认一种 facet，也不要让投递被别人的 PDS 拖住。
  rich.detectFacetsWithoutResolution()

  return {
    ok: true,
    record: {
      $type: POST_COLLECTION,
      text: rich.text,
      createdAt: post.createdAt.toISOString(),
      ...(rich.facets?.length ? { facets: rich.facets } : {}),
      // 不写 `langs`：语言判定是另一件事，猜错等于把帖子塞进错误的语言流。
    },
  }
}

/**
 * `permanent` 不是给日志看的措辞，而是**处置方式**：终态的失败不该重试（重试一万次
 * 也还是同样的结果，只会喂大日志），暂时的不该丢弃。让类型把它带上，调用方就不必
 * 去嗅探 reason 字符串。
 */
type AttachedReply =
  | { ok: true, record: Record<string, unknown> }
  | { ok: false, permanent: boolean, reason: string }

/**
 * 给回复补上锚点。**必须在发送时刻做**，不能只在入队时做完就完事 ——
 * 父帖的 cid 只有它自己投递成功之后才有（见 `resolveReplyRefs`）。
 *
 * 入队时也算过一次（能算出来就直接写进 `record`），这里是覆盖重算：两次结果一样，
 * 但只有这一次是权威的。存的那份留着是为了排查时一眼能看出要发什么。
 */
function attachReply(record: Record<string, unknown>, parentId: number | null): AttachedReply {
  if (parentId === null)
    return { ok: true, record }

  const refs = resolveReplyRefs(parentId)
  switch (refs.kind) {
    case 'ok':
      return { ok: true, record: { ...record, reply: { parent: refs.parent, root: refs.root } } }
    case 'unpublished':
      return {
        ok: false,
        permanent: true,
        reason: `父帖 #${refs.postId} 不在 Bluesky 上（没有 atproto_uri），回复锚不住`,
      }
    case 'pending':
      return {
        ok: false,
        permanent: false,
        reason: `父帖 #${refs.postId} 还没有 cid（投递中），稍后重试`,
      }
  }
}

// ─── 入队 ─────────────────────────────────────────────────────────────────────

/**
 * 建帖后调用。内部顺序**不能调换**（方案里的不变量 L）：
 *
 * 1. 未绑定 → 返回；2. 关掉了发布 → 返回；3. 该行已有 `atproto_uri` → 返回（幂等）；
 * 4. 本地校验，失败 → 终态，记 warn 不重试；5. **先**写 `atproto_uri`；6. **再**入队。
 *
 * 第 5、6 步在同一个事务里、都在任何网络调用之前。崩在中间只是「这条帖没发出去」，
 * 不产生重复或脏数据。
 *
 * 同步函数，没有 await —— 调用它的路由不必改成 async，也就不会出现「响应先于入队
 * 返回、进程被杀就丢一条删除」的窗口。
 */
export function mirrorLocalPost(input: { username: string, postId: number }): void {
  const identity = AtprotoService.getIdentity(input.username)
  if (!identity)
    return
  if (!identity.publishEnabled)
    return

  const post = db
    .select({
      id: posts.id,
      parentId: posts.parentId,
      content: posts.content,
      createdAt: posts.createdAt,
      atprotoUri: posts.atprotoUri,
      atprotoCid: posts.atprotoCid,
    })
    .from(posts)
    .where(eq(posts.id, input.postId))
    .get()
  if (!post || post.atprotoUri)
    return

  const built = buildRecord(post)
  if (!built.ok) {
    console.warn(`[outbox] 帖 #${post.id} 不发送：${built.reason}`)
    return
  }

  // 回复在入队时就把锚点算一遍：父帖根本不在 Bluesky 上就没必要入队，直接在这里
  // 终态掉（省掉一天的无谓重试）；父帖还在投递中则照常入队，worker 会在轮到它时
  // 重算，那时 FIFO 已经保证父帖要么成功要么已死。
  let record = built.record
  if (post.parentId !== null) {
    const withReply = attachReply(record, post.parentId)
    if (withReply.ok) {
      record = withReply.record
    }
    else if (withReply.permanent) {
      console.warn(`[outbox] 回复 #${post.id} 不发送：${withReply.reason}`)
      return
    }
  }

  const rkey = localRkey(post.id)
  const uri = atUri(identity.did, POST_COLLECTION, rkey)

  db.transaction((tx) => {
    tx.update(posts).set({ atprotoUri: uri }).where(eq(posts.id, post.id)).run()
    tx.insert(atprotoOutbox)
      .values({
        did: identity.did,
        username: identity.username,
        kind: 'put',
        rkey,
        uri,
        record: JSON.stringify(record),
      })
      .onConflictDoNothing({ target: [atprotoOutbox.uri, atprotoOutbox.kind] })
      .run()
  })
}

export interface OutboundDelete { id: number, atprotoUri: string }

/**
 * 删帖后调用。`rows` 是 `PostService.remove` 挑出来的**可出站**行。
 *
 * **刻意不看 `publishEnabled`**：那个开关管的是「要不要往 Bluesky 发新东西」，而这里
 * 是用户刚在站内删了一条已经发出去的帖 —— 这时留在 Bluesky 上才是意外的结果。
 */
export function enqueueDeletes(username: string, rows: OutboundDelete[]): void {
  if (!rows.length)
    return
  const identity = AtprotoService.getIdentity(username)
  if (!identity)
    return

  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(atprotoOutbox)
        .values({
          // 用**当前绑定**的 did。解绑会连同会话一起撤销，投进旧 repo 本来也做不到；
          // 而重绑到同一个 Bluesky 账号时 did 不变，这是绝大多数情况。
          did: identity.did,
          username,
          kind: 'delete',
          rkey: row.atprotoUri.slice(row.atprotoUri.lastIndexOf('/') + 1),
          uri: row.atprotoUri,
          record: null,
        })
        .onConflictDoNothing({ target: [atprotoOutbox.uri, atprotoOutbox.kind] })
        .run()
    }
  })
}

// ─── 投递 ─────────────────────────────────────────────────────────────────────

type OutboxRow = typeof atprotoOutbox.$inferSelect

let started = false
let timer: ReturnType<typeof setInterval> | null = null
/** 单进程内串行。`tick` 本身是 async，没有它两次 tick 会并发投同一批行。 */
let running = false

function claim(): OutboxRow[] {
  return db
    .select()
    .from(atprotoOutbox)
    .where(and(
      eq(atprotoOutbox.status, 'pending'),
      lte(atprotoOutbox.nextAttemptAt, new Date()),
    ))
    // **按 id 升序 = FIFO**：put 一定先于同一 URI 的 delete，父帖一定先于回复。
    // 这是回复锚点能在发送时刻解析出来的前提。
    .orderBy(asc(atprotoOutbox.id))
    .limit(BATCH_SIZE)
    .all()
}

/** 成功即删行 —— 所以没有 `'done'` 状态。 */
function succeed(row: OutboxRow, cid: string | null): void {
  db.transaction((tx: Tx) => {
    // 「两列都非空」等价于「这条帖已成功发布」（见 schema）。cid 只有 putRecord 返回
    // 之后才有，所以在这里补，而不是入队时乐观写。
    if (row.kind === 'put' && cid)
      tx.update(posts).set({ atprotoCid: cid }).where(eq(posts.atprotoUri, row.uri)).run()
    tx.delete(atprotoOutbox).where(eq(atprotoOutbox.id, row.id)).run()
  })
  console.info(`[outbox] 已投递 ${row.kind} ${row.uri}`)
}

/** 这一行没有意义了（帖子已在本地删掉），直接丢弃。 */
function drop(row: OutboxRow, reason: string): void {
  db.delete(atprotoOutbox).where(eq(atprotoOutbox.id, row.id)).run()
  console.info(`[outbox] 丢弃 ${row.kind} ${row.uri}：${reason}`)
}

/**
 * `permanent` 用于「重试一万次也还是这个结果」的失败（如回复的父帖根本不在 Bluesky
 * 上）。其余一律走退避重试，不做错误分类。
 */
function fail(row: OutboxRow, err: unknown, permanent = false): void {
  const attempts = row.attempts + 1
  const dead = permanent || attempts >= MAX_ATTEMPTS
  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS)

  db.update(atprotoOutbox)
    .set({
      attempts,
      lastError: String(err).slice(0, 500),
      status: dead ? 'dead' : 'pending',
      // **推到未来，而不是原地立刻重试**：队列是按 id 升序取的，一条坏行留在队头
      // 会把后面所有的行一起卡住（队头阻塞）。
      ...(dead ? {} : { nextAttemptAt: new Date(Date.now() + backoff + Math.floor(Math.random() * 1000)) }),
    })
    .where(eq(atprotoOutbox.id, row.id))
    .run()

  if (dead) {
    console.error(`[outbox] ${row.kind} ${row.uri} 失败 ${attempts} 次，标记为 dead（行保留供排查）:`, err)
    return
  }
  console.warn(`[outbox] ${row.kind} ${row.uri} 第 ${attempts} 次失败，${Math.round(backoff / 1000)} 秒后重试:`, err)
}

async function deliver(row: OutboxRow): Promise<void> {
  if (row.kind === 'put') {
    const post = db
      .select({ id: posts.id, parentId: posts.parentId, deleted: posts.deleted })
      .from(posts)
      .where(eq(posts.atprotoUri, row.uri))
      .get()
    // `remove` 会连带软删所有后代，而那些后代的 put 行可能还在队列里。先把一条已经
    // 删掉的回复发出去、再发一条删除，等于无谓地把它短暂公开一次。delete 行不受此
    // 影响 —— 它本来就要发。
    if (!post || post.deleted) {
      drop(row, '本地帖子已删除或不存在')
      return
    }

    if (!row.record) {
      fail(row, new Error('put 行没有 record'), true)
      return
    }

    const parsed = JSON.parse(row.record) as Record<string, unknown>
    const built = attachReply(parsed, post.parentId)
    if (!built.ok) {
      fail(row, new Error(built.reason), built.permanent)
      return
    }

    if (outboundMode() === 'dry') {
      console.warn(`[outbox] 【干跑·未发送】putRecord ${row.uri} ${JSON.stringify(built.record)}`)
      succeed(row, null)
      return
    }

    const agent = await agentFor(row.did)
    const { data } = await agent.com.atproto.repo.putRecord({
      repo: row.did,
      collection: POST_COLLECTION,
      rkey: row.rkey,
      record: built.record,
    })
    succeed(row, data.cid ?? null)
    return
  }

  if (row.kind !== 'delete') {
    fail(row, new Error(`未知的 kind: ${row.kind}`), true)
    return
  }

  if (outboundMode() === 'dry') {
    console.warn(`[outbox] 【干跑·未发送】deleteRecord ${row.uri}`)
    succeed(row, null)
    return
  }

  const agent = await agentFor(row.did)
  try {
    await agent.com.atproto.repo.deleteRecord({
      repo: row.did,
      collection: POST_COLLECTION,
      rkey: row.rkey,
    })
  }
  catch (err) {
    // 记录本来就不在 = 正是我们想要的状态。幂等，算成功 —— 否则重试会一直失败到死。
    if (err instanceof XRPCError && err.error === 'RecordNotFound') {
      succeed(row, null)
      return
    }
    throw err
  }
  succeed(row, null)
}

/**
 * 每次都重新 `restore`，**不自己缓存 `OAuthSession`**：库内部已经按 DID 缓存，并且
 * `client.ts` 的 `requestLock` 让同一 DID 上的会话刷新天然串行。自己再缓存一层只会
 * 引入「DPoP nonce 过期」这类只在长时间运行后才暴露的问题。
 */
async function agentFor(did: string): Promise<Agent> {
  const client = await getOAuthClient()
  return new Agent(await client.restore(did))
}

async function tick(): Promise<void> {
  if (running)
    return
  running = true
  try {
    for (const row of claim()) {
      // 每行之间重新看一眼：`stopOutbox()` 之后不该继续往下发。
      if (!started)
        return
      try {
        await deliver(row)
      }
      catch (err) {
        fail(row, err)
      }
    }
  }
  finally {
    running = false
  }
}

/** 启动点（`atproto/index.ts` 模块加载处）。**必须幂等** —— 重复调用不许开出第二个循环。 */
export function startOutbox(): void {
  if (started)
    return
  const mode = outboundMode()
  if (mode === 'off') {
    console.info('[outbox] ATPROTO_OUTBOUND=off，写路径未启动')
    return
  }
  started = true
  if (mode === 'dry')
    console.warn('[outbox] ATPROTO_OUTBOUND=dry：只打印将要发出的 XRPC 调用，不发请求（且照常出队）')
  timer = setInterval(() => {
    void tick()
  }, TICK_MS)
  timer.unref?.()
  // 重启后立刻排空积压，不用等第一个 tick。
  void tick()
}

/**
 * 幂等可调用，形状上备好；**刻意不接 SIGTERM/SIGINT**，理由与 `stopJetstream` 相同。
 * 在途的那一行会被发完 —— 它已经出队了，硬杀也只是让它留到下轮重试（putRecord 幂等）。
 */
export function stopOutbox(): void {
  started = false
  if (timer)
    clearInterval(timer)
  timer = null
}

export function getOutboxStatus() {
  const stat = (status: string) => db
    .select({ n: count() })
    .from(atprotoOutbox)
    .where(eq(atprotoOutbox.status, status))
    .get()
    ?.n ?? 0

  return {
    mode: outboundMode(),
    started,
    pending: stat('pending'),
    dead: stat('dead'),
  }
}
