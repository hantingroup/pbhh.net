import type { Tx } from './mirror'
import { Agent, RichText, XRPCError } from '@atproto/api'
import { TID } from '@atproto/common-web'
import { and, asc, count, eq, inArray, isNull, lte } from 'drizzle-orm'
import { atprotoOutbox, db, postLikes, posts } from 'server/database'
import { getOAuthClient } from './client'
import { atUri, LIKE_COLLECTION, POST_COLLECTION } from './mirror'
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
 * 4. **rkey 是自己生成的一个 TID**，入队时生成、随行落库（`newRecordKey`）。URI 因而
 *    在建帖那一刻就确定，`putRecord` 对同 rkey 是覆盖语义、重试天然幂等，回环也才能被
 *    第 2 条吸收。**唯独不能做成「确定性」的 `pbhh-<本地 id>`**：`app.bsky.feed.post` 与
 *    `app.bsky.feed.like` 的 lexicon 都声明 `"key": "tid"`（拉官方 lexicon 文件可确认），
 *    PDS 按声明校验，非 TID 一律回 `Invalid record key for <collection>: Invalid TID
 *    string` —— 于是**整条出站半边在投递时刻才失败**，而 scope 那个 bug 也是同一副面孔
 *    （见 `client.ts` 的 SCOPE 注释），两件事叠在一起时会互相掩盖，实测花掉一整天。
 * 5. **引用别人记录时，锚点在发送时刻算，不在入队时刻算**。回复的 `reply.parent` 与
 *    点赞的 `subject` 都是 strongRef，而目标帖的 `atproto_cid` 要等它自己的 put 投递
 *    成功才有（`succeed` 才写）—— 也就是**建帖后那 3 秒内谁都锚不住它**。入队时就
 *    算并「拿不到就丢弃」会把这类赞变成永久静默丢失。见 `resolveReplyRefs` 与
 *    `deliverLike`。
 *
 * 依赖方向：`posts/index.ts → atproto/outbox.ts → posts/service.ts`；`posts/service.ts`
 * **完全不 import atproto**，无环。这里也不 import `posts/service` —— 需要的字段
 * （`atproto_uri` / `atproto_cid` / `parentId`）`toItem` 都不给，直接查表更短。
 *
 * 这个模块**不 import `posts/rkey.ts`**。那里的 `localRkey` 曾是这里生成 rkey 的依据，
 * 现在只剩一个用途：让 `isMirroredPost` 认出 `posts.atproto_mirrored` 引入之前写的旧行。
 * 那纯属**读**侧的活；生成在写侧，解释在读侧，两边不再共用一份定义 —— 它们已经不是
 * 同一个东西了（详见第 4 条与 `schema.ts` 里 `atprotoMirrored` 的注释）。
 */

/** `app.bsky.feed.post` 的 `text` 上限（lexicon：maxGraphemes 300）。 */
const MAX_GRAPHEMES = 300

/**
 * 队列行的意图。**四个值，两条独立的轴压在一起**：写还是删（`put` / `delete`），
 * 以及发的是哪种记录（帖 / 赞）。
 *
 * 为什么把 collection 编进 `kind`，而不是给 `atproto_outbox` 加一列、也不是从
 * `row.uri` 里解析出来：
 *
 * - `kind` 是**无约束的 `text` 列**，加值不需要迁移，已有的行原样有效。
 * - 解析 uri 要另写一个 `collectionOf()`，还得处理畸形 uri；而这个模块里已经有
 *   一处按 `lastIndexOf('/')` 切 rkey 的写法（`enqueueDeletes`），两处解析一旦
 *   不是同一次结果就会不一致。
 * - 最实际的好处：`succeed()` 里那句 `if (row.kind === 'put' && cid)` 会**自动**
 *   不再命中 like 行。否则那句「按 `row.uri` 回写 `posts.atproto_cid`」是靠
 *   「like 的 uri 恰好不等于任何 `posts.atproto_uri`」这个巧合才安全的。
 */
type OutboxKind = 'put' | 'delete' | 'put-like' | 'delete-like'

/**
 * 生成本站要写的记录的 rkey。见模块说明第 4 条。
 *
 * **必须在入队时生成一次、随行落库**，不能在每次投递尝试时现生成：`putRecord` 的幂等
 * 性来自「同一个 rkey 覆盖」，每次换一个 rkey 就会在用户 repo 里造出多条记录，而本地
 * 只有一行 —— 那是永久发散。放在这里而不是 `posts/rkey.ts`，因为那是个零 import 的
 * 叶子模块，而生成需要一个依赖（见下）。
 *
 * 用库的实现而不是自己拼 13 位 base32：TID 的位域是「53 位微秒 + 10 位 clock id +
 * 12 位计数器」，`TID.next()` 内部的单调计数器还保证同一进程内连续调用不重复。自己拼
 * 很容易造出**看起来像 TID 但不合法**的串，而那种错误只会在投递时刻由 PDS 报出来。
 * `@atproto/common-web` 是显式依赖（`@atproto/api` 也依赖它，版本对齐，不会装出两份）。
 */
function newRecordKey(): string {
  return TID.nextStr()
}

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
  /**
   * `code` 给调用方**归类**（回填要按类计数），`reason` 给人看。两个都要：拿 reason
   * 字符串去嗅探类别，等于让文案成为控制流的一部分。
   */
  | { ok: false, code: 'emptyText' | 'tooLong', reason: string }

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
    return { ok: false, code: 'emptyText', reason: 'empty text' }

  const rich = new RichText({ text })
  if (rich.graphemeLength > MAX_GRAPHEMES) {
    return {
      ok: false,
      code: 'tooLong',
      reason: `text is ${rich.graphemeLength} graphemes, over Bluesky's ${MAX_GRAPHEMES} limit (no truncation, see module notes)`,
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
        reason: `parent post #${refs.postId} is not on Bluesky (no atproto_uri), the reply cannot be anchored`,
      }
    case 'pending':
      return {
        ok: false,
        permanent: false,
        reason: `parent post #${refs.postId} has no cid yet (still being delivered), will retry`,
      }
  }
}

// ─── 入队 ─────────────────────────────────────────────────────────────────────

/**
 * `mirrorLocalPost` 的结局。**建帖时的两个调用方忽略它**（`posts/index.ts`），回填
 * 靠它分类计数 —— 那个调用方需要知道「入队了」与「因为父帖不在 Bluesky 上、永远发不
 * 出去」的区别，而后者是**终态**，重跑一万次也还是这个结果。
 */
export type MirrorPostResult =
  | { ok: true }
  | { ok: false, reason: 'notBound' | 'publishDisabled' | 'alreadyPublished' | 'emptyText' | 'tooLong' | 'parentUnpublished' }

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
export function mirrorLocalPost(input: { username: string, postId: number }): MirrorPostResult {
  const identity = AtprotoService.getIdentity(input.username)
  if (!identity)
    return { ok: false, reason: 'notBound' }
  if (!identity.publishEnabled)
    return { ok: false, reason: 'publishDisabled' }

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
  // 行不存在也归到这里：对建帖那条路来说「行不在」与「已经发过」是同一个结局 ——
  // 没什么可发的。回填的候选是从同一张表查出来的，不会命中这一支。
  if (!post || post.atprotoUri)
    return { ok: false, reason: 'alreadyPublished' }

  const built = buildRecord(post)
  if (!built.ok) {
    console.warn(`[outbox] post #${post.id} not sent: ${built.reason}`)
    return { ok: false, reason: built.code }
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
      console.warn(`[outbox] reply #${post.id} not sent: ${withReply.reason}`)
      return { ok: false, reason: 'parentUnpublished' }
    }
  }

  const rkey = newRecordKey()
  const uri = atUri(identity.did, POST_COLLECTION, rkey)

  db.transaction((tx) => {
    // `atprotoMirrored: false` 必须和 `atprotoUri` 同一次写：`atprotoUri` 一非空，
    // 这条帖就可能被读侧当成镜像帖（旧判据），而它明明是用户在这里写的原创内容。
    tx.update(posts).set({ atprotoUri: uri, atprotoMirrored: false }).where(eq(posts.id, post.id)).run()
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
  return { ok: true }
}

// ─── 回填 ─────────────────────────────────────────────────────────────────────

/**
 * 该用户**从未尝试发布过**的帖的 id，按 `id` 升序。
 *
 * `atproto_uri IS NULL` 就是「从未尝试过」的判据 —— 它由不变量 L 保证：uri 在任何
 * 网络调用之前写好，所以 uri 非空意味着「要么已投递成功，要么有一行还在队列里，要么
 * 那条队列行已经死了」。三种情况回填都不该再插一手，**第三种也一样**：把一条 uri 已定
 * 的帖重新入队等于换个新 rkey 再发一遍，会在用户 repo 里留下一条孤儿记录，要同时给旧
 * uri 入一条 delete 才收得干净。那是另一件事，不在这里做。
 *
 * `ORDER BY id ASC` **是承重的**，不是随手排序：`posts.id` 自增且 `parentId` 永远
 * 指向更早的行，所以这个顺序天然保证**父帖排在回复之前**；而 `claim()` 也是按 outbox
 * `id ASC` 取行，于是入队顺序 = 投递顺序 = 父先于子。那正是回复能在发送时刻解析出
 * `reply.parent` 那个 strongRef 的前提。改成别的顺序会让回复先于父帖入队、进而先于
 * 父帖投递，父帖那时还没有 cid ⇒ 回复白白撞一次 `pending` 退避。
 *
 * `deleted = false` 把软删的排除掉：它们要么已被 `enqueueDeletes` 收走，要么本来就没
 * 发出去，重新发一遍是错的（`deliverPost` 也会把它们 drop 掉，但那是浪费一次查询）。
 *
 * **这里是一次全表扫**（`posts` 上只有 `atproto_uri` 那一个索引），量级上千条时也就
 * 几毫秒，先不为此动迁移 —— 加索引要走 `drizzle-kit`，而这个仓库的迁移史里有一次快照
 * 漂移事故，收益不抵风险。
 */
function unpublishedIds(username: string): number[] {
  return db
    .select({ id: posts.id })
    .from(posts)
    .where(and(
      eq(posts.username, username),
      eq(posts.deleted, false),
      isNull(posts.atprotoUri),
    ))
    .orderBy(asc(posts.id))
    .all()
    .map(row => row.id)
}

/** 按终态原因分类。见 `BackfillPostsResult`。 */
export interface BackfillSkips {
  /**
   * **结构上恒为 0**：候选全是 `atproto_uri IS NULL` 的行，`mirrorLocalPost` 的同一道
   * 闸不可能在本次循环里翻过来。留着是为了让 `MirrorPostResult` 的每个 reason 都有
   * 归宿 —— 否则下面那个 `switch` 就得写 `default`，而 `default` 会把「以后新增一种
   * reason」变成一次静默漏算。
   */
  alreadyPublished: number
  /**
   * 父帖不在 Bluesky 上（含父帖是别人从未发布过的帖）。**终态**，补不了。
   *
   * 这一桶里混着一种**误报**：父链超过 `MAX_ANCESTOR_WALK`（64）环时 `resolveReplyRefs`
   * 也返回 `unpublished`，而那种回复本身可能是能发的。本站的回复树是平铺的（深度 2 就到
   * 顶了），所以走不到；真要走到了，得先看深度再看这条计数，别直接下结论说父帖不在
   * Bluesky 上。
   */
  parentUnpublished: number
  tooLong: number
  emptyText: number
}

/**
 * 一次回填的结果。**判别联合而不是「一个带状态字段的对象」** —— 后者的 `queued: 0`
 * 有三种完全不同的含义（没绑、开关关着、真的一条都不用补），前端只能猜。做成判别联合
 * 就逼着每个调用方分别对待。
 */
export type BackfillPostsResult =
  | {
    status: 'ok'
    /** 已入队条数。真正会发出去的就是这些。 */
    queued: number
    /** 逐条处理时抛错的条数（数据库错误之类）。**其余候选不受影响**，见下面的循环。 */
    failed: number
    skipped: BackfillSkips
    /** 跑完之后仍未发布的候选总数。`queued + failed + 各 skipped 之和` 之外没别的。 */
    remaining: number
  }
  | { status: 'notBound' | 'publishDisabled' | 'error' }

/**
 * 把本站已有的帖补发到用户的 PDS —— 出站回填。
 *
 * **存在的理由**：出站写路径从建立起就是坏的（scope 不含 `repo:*`，随后是 rkey 不是
 * 合法 TID，见模块说明与 `client.ts` 的 SCOPE 注释），所以在它修好之前，用户在这里
 * 发的每一条帖都没发到过 Bluesky。这个函数把那段历史补上。
 *
 * 手动入口（设置页按钮）与自动入口（绑定/重绑时）**走的是同一个函数、同一套闸**，
 * 所以两条路的行为不可能不一致。
 *
 * 只碰数据库，**不接网络** —— 它只入队，投递由 worker 按 FIFO 做（这也正是「按 id
 * 升序」能决定投递顺序的原因）。同步函数，自动入口因此不必被 await。
 *
 * **刻意不做的四件事**（设置页的文案必须把第一条讲清楚，否则会被当成 bug 反复报）：
 *
 * 1. **父帖不在 Bluesky 上的回复永远补不上，不是暂时。** Bluesky 的回复必须带父帖的
 *    `{uri, cid}` strongRef，而父帖若只存在于本站，那个 cid 谁也构造不出来。别人写的、
 *    从未发布过的帖下的回复全归此类。
 * 2. **已卡死的帖**（判据与两条修法见本节末尾）：uri 已定却从未投递成功，会被 uri 闸永久跳过。
 * 3. **可能造出重复**：用户绑定前若已在 Bluesky 手动发过同样内容，这里会再发一条，而
 *    两条之间没有任何共同标识可供比对（入站回填早就把 Bluesky 那条也镜像进来了，内容
 *    一样、来源不同）。让用户自己删一条即可 —— 删除是幂等的、且我们控制得住。
 * 4. **赞不补**。`post_likes` 没有时间列，而定 `put-like` 的 `createdAt` 只能靠入队
 *    时刻；补出来的赞会带上一串「刚刚」的时间戳。而绝大多数历史赞的目标是别人的帖，
 *    本来也锚不住。
 *
 * **这个函数必须全程同步**，一个 `await` 都不许加 —— 它因此不需要重入闸：Bun 的单线程
 * 上，同步函数不会被打断，两次「同时」触发实际上是先后跑完的，第二次看到的已经是第一次
 * 写完的状态（候选都被写上 uri 了 ⇒ 全部落进 `alreadyPublished`），不会算出重复的 TID。
 * 一旦在循环里加 `await`（比如「先探一下 PDS 通不通」），这个论证当场失效，那时就必须补
 * 一个重入闸，否则两次跑会在 `posts_atproto_uri_unique` 上撞车。
 *
 * ── 上面第 2 条「已卡死的帖」：留给下一次改动 ──────────────────────────────
 *
 * **判据**：`atproto_uri IS NOT NULL AND atproto_cid IS NULL AND deleted = 0`。
 * `atproto_cid` 只在投递成功时写（见 `succeed`），所以「有 uri 没 cid」就是「uri 已定、
 * 但**没有收到过投递成功的确认**」：outbox 行要么退避到 `dead`，要么被 `unbindIdentity`
 * 连带清掉了。**2026-09-14 生产上是 0 行**（那 28 条候选从未被尝试过），所以这一轮
 * 不处理 —— 为 0 行写修复代码，等于让一段没有真实输入的分支先于需求存在。
 *
 * 这个判据是**必要条件而非充要条件**：`succeed` 在 `cid` 为空时不会回写（dry 模式走
 * 的就是这一支），所以跑过一次干跑的库会凭空多出「有 uri 没 cid」的行。用之前先确认
 * 那些 uri 对应的 outbox 行到底是怎么没的。
 *
 * 修法是**一次入队两条**：换一个新 TID 重发，**并且**给旧 uri 补一条 delete。
 *
 * 之所以不必先弄清旧记录到底落没落：`deliverPost` 的 delete 分支**把 `RecordNotFound`
 * 当成功**（幂等，见那里的注释）。旧 uri 上什么都没有是最可能的情况，那条 delete 自己
 * 就会成功删掉自己，不会留下 `dead` 行 —— 代价只是白跑一次 XRPC。反过来若旧记录真的
 * 在，这条 delete 正好收走它，也就不会在 Bluesky 上留下重复。**两条路都通，所以不需要
 * 拿旧 uri 去 `getRecord` 探一次**，这个函数也就不必因此变成 async。
 */
export function backfillLocalPosts(username: string): BackfillPostsResult {
  const identity = AtprotoService.getIdentity(username)
  if (!identity)
    return { status: 'notBound' }
  // 补发**就是**「往 Bluesky 发新东西」，所以与 `mirrorLocalPost` 同受这个开关管。
  // 反过来做的后果是：用户明确关掉了发布，却在设置页点一下把 28 条历史全推出去。
  if (!identity.publishEnabled)
    return { status: 'publishDisabled' }

  try {
    const skipped: BackfillSkips = { alreadyPublished: 0, parentUnpublished: 0, tooLong: 0, emptyText: 0 }
    let queued = 0
    let failed = 0

    // 一个**必然会被误读**的细节，先写在这里：这一批里若有回复，它的父帖是刚刚才被写上
    // uri 的（就在上一轮循环），cid 还没有 —— 投递是 worker 的事。于是 `attachReply` 判
    // `pending`，**存进 outbox 的那份 record 里没有 `reply` 字段**。这是对的，不是漏了：
    // 投递时刻 `deliverPost` 会用当时的 cid 重算补上（见 `attachReply` 的说明），而 FIFO
    // 保证父帖先投递成功、cid 先落地。看到存的 JSON 里没有 reply 就当 bug 报是误读。
    for (const postId of unpublishedIds(username)) {
      // **逐条 try/catch，不是包住整个循环**：一条候选炸了（比如 TID 真的撞了唯一索引）
      // 不该让后面 27 条一起泡汤 —— 那些才是这次回填的主体。
      try {
        const result = mirrorLocalPost({ username, postId })
        if (result.ok) {
          queued++
          continue
        }
        // 没有 `default` 是有意的：`MirrorPostResult` 以后新增 reason 时，TS 会在这里
        // 报错，逼着人来决定它该算哪一类，而不是被静默漏算。
        switch (result.reason) {
          case 'alreadyPublished':
            skipped.alreadyPublished++
            break
          case 'parentUnpublished':
            skipped.parentUnpublished++
            break
          case 'tooLong':
            skipped.tooLong++
            break
          case 'emptyText':
            skipped.emptyText++
            break
          // 上面两道闸本轮已经查过（同一进程、同一次调用，中间没人能改），走不到这里。
          // 真走到了只能是一次竞态解绑，不计入任何一类。
          case 'notBound':
          case 'publishDisabled':
            break
        }
      }
      catch (err) {
        failed++
        console.error(`[outbox] backfilling post #${postId} failed:`, err)
      }
    }

    return { status: 'ok', queued, failed, skipped, remaining: unpublishedIds(username).length }
  }
  catch (err) {
    // 走到这里说明连候选查询都失败了。**必须兜住**：自动入口是在 OAuth 回调里跑的，
    // 那里抛出去会把「绑定成功」变成一个 500，而用户其实已经绑好了。与 `backfillFromPds`
    // 同策（见它的注释）。
    console.error('[outbox] backfilling local posts failed:', err)
    return { status: 'error' }
  }
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

/**
 * 点赞 / 取消赞后调用。与 `mirrorLocalPost` 同形：同步、无 await、显式调用。
 *
 * **闸门的方向在这里必须分清**，不能照抄 `mirrorLocalPost` 的顺序：
 *
 * 1. 未绑定 → 返回。
 * 2. **`publishEnabled` 只闸住「点赞」，不闸住「取消赞」** —— 与 `enqueueDeletes`
 *    逐字同理（见上面那段注释）。搞反的后果是**保证发散**：用户开着开关赞了（Bluesky
 *    上真有一条记录）→ 关掉开关 → 回来取消赞 → 那条记录**永远留在 Bluesky**，而本站
 *    显示未赞。
 * 3. `liked === true` 再依次三道闸，见下。
 *
 * `retractUri` 由 `toggleLike` 交出 —— 它删掉的那一行上的 `atproto_uri`。所以
 * 「在 Bluesky 官方客户端点的赞、回本站取消」也能撤回。**撤回目标只能靠这一列拿到，
 * 不能靠 rkey 的形态去猜**：客户端那条和我们自己发的那条，rkey 都是 TID。
 */
export function mirrorLocalLike(input: {
  username: string
  postId: number
  liked: boolean
  /** 仅在 `liked === false` 时有意义：要撤回的那条 like 记录的 at-uri。 */
  retractUri: string | null
}): void {
  const identity = AtprotoService.getIdentity(input.username)
  if (!identity)
    return

  if (!input.liked) {
    if (!input.retractUri)
      return
    const uri = input.retractUri
    db.transaction((tx: Tx) => {
      // 还没发就别发了 —— 下面那条 delete 已经表达了最终状态。**只省一次投递尝试，
      // 不承重**：`deliverLike` 在发送时刻会复查本地行，取消之后那行已经没了 ⇒ 直接
      // drop。留着是因为它让「一 tick 内 赞→取消」不必白跑一次网络。
      tx.delete(atprotoOutbox)
        .where(and(eq(atprotoOutbox.uri, uri), eq(atprotoOutbox.kind, 'put-like')))
        .run()
      tx.insert(atprotoOutbox)
        .values({
          did: identity.did,
          username: input.username,
          kind: 'delete-like',
          rkey: uri.slice(uri.lastIndexOf('/') + 1),
          uri,
          record: null,
        })
        .onConflictDoNothing({ target: [atprotoOutbox.uri, atprotoOutbox.kind] })
        .run()
    })
    return
  }

  if (!identity.publishEnabled)
    return

  const like = db
    .select({ atprotoUri: postLikes.atprotoUri })
    .from(postLikes)
    .where(and(eq(postLikes.postId, input.postId), eq(postLikes.username, input.username)))
    .get()
  // 行没了 = 调用方与 `toggleLike` 不同步，或者用户取消得比这次调用快。不入队。
  if (!like)
    return
  // **幂等，也是防重复记录**：用户在 Bluesky 刚赞了、回环还没到，此时在本站也点一下，
  // 没有这道闸就会在他 repo 里造出**第二条** like 记录（他客户端那条 + 我们这条），
  // 而本地只有一行。
  if (like.atprotoUri)
    return

  const post = db
    .select({ atprotoUri: posts.atprotoUri })
    .from(posts)
    .where(eq(posts.id, input.postId))
    .get()
  // 这条帖在 Bluesky 上不存在 ⇒ 赞只能留在站内。这是「赞一条纯站内帖」的正常路径，
  // 不是错误，所以不入队、不记日志。
  if (!post?.atprotoUri)
    return

  const rkey = newRecordKey()
  const uri = atUri(identity.did, LIKE_COLLECTION, rkey)

  db.transaction((tx: Tx) => {
    // 不变量 L 的 like 版：uri 先于任何网络调用写好。
    tx.update(postLikes)
      .set({ atprotoUri: uri })
      .where(and(eq(postLikes.postId, input.postId), eq(postLikes.username, input.username)))
      .run()

    // **这一步是承重的，不是双保险。** 赞 → 取消 → 再赞，全在 3 秒的一个 tick 内：
    // 上一轮取消留下的 `delete-like` 还在队列里，而 `(uri, kind)` 唯一索引会把下面
    // 这次 put 吸收掉 —— 队列停在 `[put, delete]`，FIFO 先发 put 再发 delete
    // ⇒ **Bluesky 上没赞、本站显示已赞**。
    tx.delete(atprotoOutbox)
      .where(and(eq(atprotoOutbox.uri, uri), eq(atprotoOutbox.kind, 'delete-like')))
      .run()

    tx.insert(atprotoOutbox)
      .values({
        did: identity.did,
        username: input.username,
        kind: 'put-like',
        rkey,
        uri,
        // **外壳，不含 `subject`** —— 它在发送时刻才现造（模块说明第 5 条）。这里的
        // `createdAt` 是唯一知道用户真正何时点赞的地方：`post_likes` 没有时间列，
        // 而退避重试可能把这个赞推迟一小时才发出去。
        record: JSON.stringify({
          $type: LIKE_COLLECTION,
          createdAt: new Date().toISOString(),
        }),
      })
      .onConflictDoNothing({ target: [atprotoOutbox.uri, atprotoOutbox.kind] })
      .run()
  })
}

/**
 * 把一条**已经不再代表用户意图**的旧 like 记录收回来。由读路径的认领规则调用
 * （见 `jetstream.ts` 的 `mirrorLike`），**必须在调用方的事务里执行** —— 它和「把
 * `post_likes.atproto_uri` 改指到新记录」是同一个决定的两半，分两个事务崩在中间会
 * 留下「行指向旧记录、而旧记录已经被删」这种更糟的状态。
 *
 * 旧 uri `U` 可能**还在队列里**（这次 put 还没轮到），也可能**已经投递成功**
 * （AppView 还没索引到，用户在客户端就又点了一次，于是产生了第二条记录）。这里
 * **不需要分辨**，两步各自幂等：
 *
 * - 删掉 `U` 挂起的 `put-like`：还没发就别发了。
 * - 给 `U` 入一条 `delete-like`：发过就收回；没发过则 `RecordNotFound` → 幂等成功
 *   （见 `deliverLike` 的 delete 分支）。
 *
 * `did` 用**当前绑定**的那个，与 `enqueueDeletes` 同一个理由（见那里的注释）。
 */
export function retractStaleLike(tx: Tx, input: {
  did: string
  username: string
  uri: string
}): void {
  // **`kind` 非带不可**：唯一索引是 `(uri, kind)`，`uri` 单独并不唯一 —— 按 uri 裸删
  // 会把同一地址上待发的 put 一起删掉（而那条 put 可能是我们真正想发出去的）。
  tx.delete(atprotoOutbox)
    .where(and(eq(atprotoOutbox.uri, input.uri), eq(atprotoOutbox.kind, 'put-like')))
    .run()
  tx.insert(atprotoOutbox)
    .values({
      did: input.did,
      username: input.username,
      kind: 'delete-like',
      rkey: input.uri.slice(input.uri.lastIndexOf('/') + 1),
      uri: input.uri,
      record: null,
    })
    .onConflictDoNothing({ target: [atprotoOutbox.uri, atprotoOutbox.kind] })
    .run()
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
    //
    // **`kind === 'put'` 这个收窄是承重的**（`kind` 把 collection 编进去的主要收益）：
    // 落到这里来的还有 `put-like` 行，而它的 uri 是 `.../app.bsky.feed.like/...`，
    // 与任何 `posts.atproto_uri` 都不相等。靠「恰好不相等」来保证安全是隐式巧合 ——
    // 这里显式把它排除掉。like 的任何东西**都不许**回写 `posts`。
    if (row.kind === 'put' && cid)
      tx.update(posts).set({ atprotoCid: cid }).where(eq(posts.atprotoUri, row.uri)).run()
    tx.delete(atprotoOutbox).where(eq(atprotoOutbox.id, row.id)).run()
  })
  console.info(`[outbox] delivered ${row.kind} ${row.uri}`)
}

/** 这一行没有意义了（帖子已在本地删掉），直接丢弃。 */
function drop(row: OutboxRow, reason: string): void {
  db.delete(atprotoOutbox).where(eq(atprotoOutbox.id, row.id)).run()
  console.info(`[outbox] dropped ${row.kind} ${row.uri}: ${reason}`)
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
    console.error(`[outbox] ${row.kind} ${row.uri} failed ${attempts} times, marked dead (row kept for inspection):`, err)
    return
  }
  console.warn(`[outbox] ${row.kind} ${row.uri} failed (attempt ${attempts}), retrying in ${Math.round(backoff / 1000)}s:`, err)
}

/**
 * 按 `kind` 分派。**四个分支各自明确**，判错 kind 的代价是往用户的 repo 里发错东西。
 */
async function deliver(row: OutboxRow): Promise<void> {
  const kind = row.kind as OutboxKind
  if (kind === 'put' || kind === 'delete') {
    await deliverPost(row, kind)
    return
  }
  if (kind === 'put-like' || kind === 'delete-like') {
    await deliverLike(row, kind)
    return
  }
  fail(row, new Error(`unknown kind: ${row.kind}`), true)
}

async function deliverPost(row: OutboxRow, kind: 'put' | 'delete'): Promise<void> {
  if (kind === 'put') {
    const post = db
      .select({ id: posts.id, parentId: posts.parentId, deleted: posts.deleted })
      .from(posts)
      .where(eq(posts.atprotoUri, row.uri))
      .get()
    // `remove` 会连带软删所有后代，而那些后代的 put 行可能还在队列里。先把一条已经
    // 删掉的回复发出去、再发一条删除，等于无谓地把它短暂公开一次。delete 行不受此
    // 影响 —— 它本来就要发。
    if (!post || post.deleted) {
      drop(row, 'local post deleted or missing')
      return
    }

    if (!row.record) {
      fail(row, new Error('put row has no record'), true)
      return
    }

    const parsed = JSON.parse(row.record) as Record<string, unknown>
    const built = attachReply(parsed, post.parentId)
    if (!built.ok) {
      fail(row, new Error(built.reason), built.permanent)
      return
    }

    if (outboundMode() === 'dry') {
      console.warn(`[outbox] [dry run, not sent] putRecord ${POST_COLLECTION} ${row.uri} ${JSON.stringify(built.record)}`)
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

  if (outboundMode() === 'dry') {
    console.warn(`[outbox] [dry run, not sent] deleteRecord ${POST_COLLECTION} ${row.uri}`)
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
 * `subject` 的解析结果。**三种结局的处置完全不同**，与 `ReplyRefs` 同一个道理 ——
 * 只是这里只有一环，没有父链要爬。
 *
 * - `gone`：本地那行赞已经没了（用户取消得比投递快），或目标帖根本不在 Bluesky 上。
 *   终态，丢弃。
 * - `pending`：目标帖的 `atproto_cid` 还没回来 —— 它自己的 put 还在队列里。**必须重试**，
 *   这是本模块第 5 条约束要防的那个静默丢失。
 */
type LikeSubject =
  | { kind: 'ok', subject: StrongRef }
  | { kind: 'gone' }
  | { kind: 'pending' }

function resolveLikeSubject(uri: string): LikeSubject {
  const like = db
    .select({ postId: postLikes.postId })
    .from(postLikes)
    .where(eq(postLikes.atprotoUri, uri))
    .get()
  if (!like)
    return { kind: 'gone' }

  const post = db
    .select({
      atprotoUri: posts.atprotoUri,
      atprotoCid: posts.atprotoCid,
      deleted: posts.deleted,
    })
    .from(posts)
    .where(eq(posts.id, like.postId))
    .get()
  // 帖被软删 = 它在 Bluesky 上的记录也正在被删，这个赞没有意义了。
  if (!post || post.deleted || !post.atprotoUri)
    return { kind: 'gone' }
  if (!post.atprotoCid)
    return { kind: 'pending' }

  return { kind: 'ok', subject: { uri: post.atprotoUri, cid: post.atprotoCid } }
}

/**
 * 把入队时存下的外壳补成完整记录。
 *
 * `createdAt` **必须用外壳里那个**（入队时刻），不能用此刻：退避重试可能把它推迟一小时，
 * 而 `post_likes` 没有时间列，入队那一刻是唯一知道用户真正何时点赞的地方。
 */
function buildLikeRecord(row: OutboxRow, subject: StrongRef): Record<string, unknown> | null {
  if (!row.record)
    return null
  try {
    return { ...JSON.parse(row.record) as Record<string, unknown>, subject }
  }
  catch {
    return null
  }
}

async function deliverLike(row: OutboxRow, kind: 'put-like' | 'delete-like'): Promise<void> {
  if (kind === 'put-like') {
    const resolved = resolveLikeSubject(row.uri)
    if (resolved.kind === 'gone') {
      drop(row, 'local like removed, or the target post is not on Bluesky')
      return
    }
    // 非永久失败：给它退避，下个 tick 目标帖的 cid 可能就到位了。
    if (resolved.kind === 'pending') {
      fail(row, new Error('target post cid not ready yet'), false)
      return
    }

    const record = buildLikeRecord(row, resolved.subject)
    if (!record) {
      fail(row, new Error('put-like row has no record'), true)
      return
    }

    if (outboundMode() === 'dry') {
      console.warn(`[outbox] [dry run, not sent] putRecord ${LIKE_COLLECTION} ${row.uri} ${JSON.stringify(record)}`)
      succeed(row, null)
      return
    }

    const agent = await agentFor(row.did)
    await agent.com.atproto.repo.putRecord({
      repo: row.did,
      collection: LIKE_COLLECTION,
      rkey: row.rkey,
      record,
    })
    // 不回写 cid：`post_likes` 没有这一列，而 `subject.cid` 取自目标帖那行。
    succeed(row, null)
    return
  }

  if (outboundMode() === 'dry') {
    console.warn(`[outbox] [dry run, not sent] deleteRecord ${LIKE_COLLECTION} ${row.uri}`)
    succeed(row, null)
    return
  }

  const agent = await agentFor(row.did)
  try {
    await agent.com.atproto.repo.deleteRecord({
      repo: row.did,
      collection: LIKE_COLLECTION,
      rkey: row.rkey,
    })
  }
  catch (err) {
    // 与帖的删除同理：记录本来就不在 = 正是我们想要的状态。**这一条是承重的** ——
    // 上层的「收敛」会无条件给旧 uri 入一条 delete，那条记录十有八九从没投递成功过。
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
    console.info('[outbox] ATPROTO_OUTBOUND=off, write path not started')
    return
  }
  started = true
  if (mode === 'dry')
    console.warn('[outbox] ATPROTO_OUTBOUND=dry: only logging the XRPC calls that would go out, sending nothing (rows still dequeue)')
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

/**
 * 可观测性端点用。**按 kind 分列** —— 赞进队列之后，混在一起的 `pending: 3` 不再能
 * 指导排查：「3 条待发帖子」和「3 条待发赞」是完全不同的两件事，前者要等 cid、后者
 * 只要目标帖就绪。
 *
 * `pending` / `dead` 保留为总数，是为了让这个端点的老读者（和人肉 `curl`）不至于看到
 * 一个空的形状。
 */
export function getOutboxStatus() {
  function stat(status: string, kinds?: string[]) {
    return db
      .select({ n: count() })
      .from(atprotoOutbox)
      .where(kinds
        ? and(eq(atprotoOutbox.status, status), inArray(atprotoOutbox.kind, kinds))
        : eq(atprotoOutbox.status, status))
      .get()
      ?.n ?? 0
  }

  return {
    mode: outboundMode(),
    started,
    pending: stat('pending'),
    dead: stat('dead'),
    // `kind` 是无约束的文本列，未知值不落在任何一组里 —— 所以两组之和不等于总数是
    // **正常的**，别把它当成漏算。
    byKind: {
      post: { pending: stat('pending', ['put', 'delete']), dead: stat('dead', ['put', 'delete']) },
      like: {
        pending: stat('pending', ['put-like', 'delete-like']),
        dead: stat('dead', ['put-like', 'delete-like']),
      },
    },
  }
}
