import type { NodeSavedSessionStore, NodeSavedStateStore, OAuthClientMetadataInput } from '@atproto/oauth-client-node'
import { promises as dns } from 'node:dns'
import { JoseKey } from '@atproto/jwk-jose'
import { AtprotoHandleResolver, buildAtprotoLoopbackClientMetadata, NodeOAuthClient } from '@atproto/oauth-client-node'
import { eq, lt } from 'drizzle-orm'
import { atprotoOauthSessions, atprotoOauthStates, db } from 'server/database'
import { API_ORIGIN, IS_LOOPBACK } from './config'

/** 授权流程里 state 的有效期，超过就当作废。 */
export const STATE_TTL_MS = 60 * 60 * 1000

/**
 * 向用户申请的 OAuth scope。
 *
 * **`atproto` 本身不授予任何权限**——规范里它的地位相当于 `openid`，只是声明「这是
 * atproto 形态的 OAuth」。只有它的时候，`putRecord` / `deleteRecord` 会被 PDS 以
 * `Missing required scope "repo:app.bsky.feed.like?action=create"` 拒绝，于是
 * **出站半边整体失效**（本站的帖和赞都发不出去）。这个失败发生在**投递时刻**，
 * 表现只是 outbox 行反复重试，从「站点一切正常」走到发现它要绕一圈，实测花掉了
 * 一整天。
 *
 * `transition:generic` 是规范提供的迁移态 scope，语义等同于旧的 App Password 授权
 * 级别：允许写**任何**仓库记录类型，只排除账号管理与私信（`chat.bsky.*`）。选它而
 * 不是逐条列 `repo:<nsid>?action=…` 的理由是「以后加转发 / 关注 / 改资料不必再让用户
 * 重新授权一次」，代价是授权页显示「完全访问」——**这两句必须一起看**，别只看其中
 * 一句就把它改窄或改宽。
 *
 * ⚠️ **改这里对已存在的会话无效**：授予的 scope 存在会话里，`restore()` 拿到的永远是
 * 当初授予的那一份。改宽之后老用户必须**解绑重绑**才拿得到新 scope，否则会继续沿用
 * 旧 scope 失败到 `dead`。
 */
const SCOPE = 'atproto transition:generic'

/**
 * DNS TXT 那半条路。
 *
 * `resolveTxt` 的契约是「查不到就返回 null」（库的 TSDoc：*Return `null` if the
 * hostname successfully does not resolve to a valid DID.*），但 `node:dns` 查不到时是
 * **抛错**：NXDOMAIN / 只有别的记录类型是 ENOTFOUND，名字存在但没有 TXT 是 ENODATA。
 * 这两种都属于「成功地解析出没有」，必须还原成 null。
 *
 * 为什么这个还原是**必需**的，而不是锦上添花：`AtprotoHandleResolver` 并行发起 DNS
 * 与 HTTPS 两个请求、先 await DNS，而它只给 HTTPS 那个挂了 `.catch(noop)`，await DNS
 * 的这行没有兜底。所以这里一抛错，整个解析就炸 —— 哪怕 HTTPS 那条路早就取到了 DID。
 * Bluesky 的 `*.bsky.social` 一律用 HTTPS 发布 DID、不设 `_atproto` TXT，于是这个抛错
 * 会让**每一个** Bluesky 用户都绑不上，且报出的还是「handle 不存在」这种误导性原因。
 *
 * 其余错误码（超时、SERVFAIL…）同样返回 null 而不抛：HTTPS 那条路仍然是有效的，
 * DNS 只是兜底，不该因为兜底失败而拖垮主路径。
 */
async function resolveTxt(domain: string): Promise<string[] | null> {
  try {
    const records = await dns.resolveTxt(domain)
    return records.map(parts => parts.join(''))
  }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOTFOUND' && code !== 'ENODATA')
      console.error(`[atproto] DNS TXT lookup for ${domain} failed unexpectedly (${code}):`, err)
    return null
  }
}

/**
 * 句柄解析器，**分两层**：外层是我们包的，内层是库的 `AtprotoHandleResolver`。
 *
 * **外层这一层不是多余的**，它修的是一个实测踩到的坑。库的 `HandleResolver` 契约写得
 * 很清楚（`@atproto-labs/handle-resolver` 的 types.d.ts）：`null` **只在解析过程没有
 * 异常时**才该返回，「unexpected error」要**抛出去**。但 `AtprotoHandleResolver` 的
 * HTTP 那半（`WellKnownHandleResolver`）把所有异常都 catch 掉再返回 `null` —— 库自己
 * 也知道，所以才提供 `onError` 这个「只观察、不改变返回值」的钩子，d.ts 里的原话是
 * 「the only strategy that swallows failures」。
 *
 * **为什么必须把它掰回来**：`@atproto/oauth-client` 会在我们传进去的实例外面再包一层
 * `CachedHandleResolver`，而它的 `CachedGetter` 是 `await this.setStored(key, value)`
 * **无条件**写入的 —— `null` 会被当成正常结果缓存，TTL **10 分钟**；读取时判的是
 * `storedValue !== undefined`，所以 `null` 会命中。于是**一次网络抖动等于接下来 10 分钟
 * 里每次重试都以「handle 不存在」失败**。2026-09-14 实测正是如此：本机到 Bluesky 的
 * 出站全走 mihomo 代理，代理的 DNS 抖了一下，用户连着 8 次被告知 handle 不存在，而它
 * 一直是好的；独立进程的探针有空缓存，所以完全复现不出来。
 *
 * 抛出去则完全不同：`CachedGetter` 的 `.catch` 挂在 `.then(setStored)` **之前**，被拒绝
 * 的那一路根本不会写缓存。所以规则是 —— **HTTP 那条路报过错，就抛**；两条路都干净地
 * 没找到，才返回 `null`。
 *
 * 对用户而言这两种结局**没有差别**：真的不存在时原先返回 `null`，`AtprotoIdentityResolver`
 * 会抛「does not resolve to a DID」，路由照样映射成 `authorizeFailed`。变的只是「抖动不再
 * 被缓存成一条 10 分钟的假结论」。
 */
function createBunHandleResolver() {
  return {
    async resolve(handle: string, options?: { signal?: AbortSignal, noCache?: boolean }) {
      // 每次调用现建内层实例：`onError` 在 `resolve()` 返回**之前**同步触发，所以下面
      // 读到的必然是本次的因。共用一个实例的话并发解析会互相串味（A 的异常被 B 读到）。
      let wellKnownError: unknown
      const inner = new AtprotoHandleResolver({
        fetch: globalThis.fetch,
        resolveTxt,
        onError: (err) => { wellKnownError = err },
      })
      const did = await inner.resolve(handle, options)
      if (did)
        return did
      if (wellKnownError !== undefined)
        throw wellKnownError
      return null
    },
  }
}

/**
 * Bun 上没有 `process.versions.undici`，`@atproto-labs/fetch-node` 的 SSRF
 * dispatcher 会在 `buildDispatcher` 里直接抛错（"Unicast SSRF protection
 * requires Node.js 20.6+"）。绕开它的办法是自己提供 `handleResolver` —— 基础包
 * `@atproto-labs/handle-resolver` 不带 undici，DNS 用 `node:dns`，HTTP 用 Bun
 * 原生 fetch。`NodeOAuthClient` 的 `fetch` 默认就是 `globalThis.fetch`，所以
 * OAuth 自身的网络调用也不会碰到 undici。
 *
 * 另见仓库根的 `patches/`：静态 import 的 undici@8 在 Bun 上模块体就会抛错，
 * 那个补丁让它变成惰性 import，否则本包根本无法被 import。
 */
const handleResolver = createBunHandleResolver()

/**
 * 串行化同一个 key 上的会话刷新。缺了它库会打印 "No lock mechanism provided.
 * Credentials might get revoked." —— 并发刷新会让先前发出的 refresh token 失效。
 */
const locks = new Map<string, Promise<unknown>>()

// 不 import 库的 `RequestLock`：它只从传递依赖 `@atproto/oauth-client` 导出，
// 直接引会依赖未声明的包。这里从构造参数上反推，签名与库保持精确一致。
type RequestLock = NonNullable<ConstructorParameters<typeof NodeOAuthClient>[0]['requestLock']>

const requestLock: RequestLock = <T>(key: string, fn: () => T | PromiseLike<T>) => {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  // 锁链本身不能因为一次失败就断掉，所以存的是吞掉结果的版本。
  locks.set(key, next.then(() => undefined, () => undefined))
  return next
}

const stateStore: NodeSavedStateStore = {
  async get(key) {
    const row = db
      .select({ state: atprotoOauthStates.state })
      .from(atprotoOauthStates)
      .where(eq(atprotoOauthStates.key, key))
      .get()
    return row ? JSON.parse(row.state) : undefined
  },
  async set(key, state) {
    const expiresAt = new Date(Date.now() + STATE_TTL_MS)
    db.insert(atprotoOauthStates)
      .values({ key, state: JSON.stringify(state), expiresAt })
      .onConflictDoUpdate({
        target: atprotoOauthStates.key,
        set: { state: JSON.stringify(state), expiresAt },
      })
      .run()
  },
  async del(key) {
    db.delete(atprotoOauthStates).where(eq(atprotoOauthStates.key, key)).run()
  },
}

const sessionStore: NodeSavedSessionStore = {
  async get(did: string) {
    const row = db
      .select({ session: atprotoOauthSessions.session })
      .from(atprotoOauthSessions)
      .where(eq(atprotoOauthSessions.did, did))
      .get()
    return row ? JSON.parse(row.session) : undefined
  },
  async set(did: string, session: unknown) {
    const updatedAt = new Date()
    db.insert(atprotoOauthSessions)
      .values({ did, session: JSON.stringify(session), updatedAt })
      .onConflictDoUpdate({
        target: atprotoOauthSessions.did,
        set: { session: JSON.stringify(session), updatedAt },
      })
      .run()
  },
  async del(did: string) {
    db.delete(atprotoOauthSessions).where(eq(atprotoOauthSessions.did, did)).run()
  },
}

/** 清掉过期的授权 state（以及已撤销 DID 留下的会话）。 */
export function sweepExpiredStates(): void {
  db.delete(atprotoOauthStates).where(lt(atprotoOauthStates.expiresAt, new Date())).run()
}

async function buildKeyset(): Promise<JoseKey[]> {
  const raw = Bun.env.ATPROTO_PRIVATE_KEY
  if (!raw)
    throw new Error('ATPROTO_PRIVATE_KEY is not set (run scripts/gen-atproto-key.ts to create one)')
  const parsed = JSON.parse(raw)
  const jwks = Array.isArray(parsed) ? parsed : [parsed]
  for (const jwk of jwks) {
    // `private_key_jwt` 要求每个签名密钥都带 kid，否则库在构造客户端时就抛错。
    // 提前给出可操作的提示，而不是让运维去猜库的那句 TypeError。
    if (!jwk?.kid)
      throw new Error('ATPROTO_PRIVATE_KEY has no "kid"; regenerate it with modules/atproto/scripts/gen-atproto-key.ts')
  }
  return Promise.all(jwks.map((jwk: Record<string, unknown>) => JoseKey.fromJWK(jwk as never)))
}

function buildClientMetadata(keyset: JoseKey[]): OAuthClientMetadataInput {
  // 环回客户端由 atproto 特殊对待（`client_id=http://localhost?redirect_uri=…`），
  // 用公开客户端语义，不需要密钥。只有本地开发会走到这里。
  if (IS_LOOPBACK) {
    return buildAtprotoLoopbackClientMetadata({
      scope: SCOPE,
      redirect_uris: [`${API_ORIGIN}/atproto/oauth/callback`],
    })
  }
  return {
    client_id: `${API_ORIGIN}/oauth-client-metadata.json`,
    client_name: 'pbhh.net',
    client_uri: API_ORIGIN,
    redirect_uris: [`${API_ORIGIN}/atproto/oauth/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: SCOPE,
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: 'ES256',
    dpop_bound_access_tokens: true,
    // 规范允许 `jwks` 与 `jwks_uri` 二选一，内联省掉一个端点。
    jwks: { keys: keyset.map(key => key.publicJwk) },
  }
}

export function isAtprotoConfigured(): boolean {
  return IS_LOOPBACK || !!Bun.env.ATPROTO_PRIVATE_KEY
}

let clientPromise: Promise<NodeOAuthClient> | undefined

/**
 * 惰性单例。刻意不在模块加载时构造：缺 `ATPROTO_PRIVATE_KEY` 时整个服务仍应
 * 正常启动，只是 atproto 相关路由返回 503，而不是把站点一起拖垮。
 */
export function getOAuthClient(): Promise<NodeOAuthClient> {
  clientPromise ??= (async () => {
    const keyset = IS_LOOPBACK ? [] : await buildKeyset()
    return new NodeOAuthClient({
      clientMetadata: buildClientMetadata(keyset),
      ...(keyset.length ? { keyset } : {}),
      handleResolver,
      stateStore,
      sessionStore,
      requestLock,
    })
  })()
  return clientPromise
}

/** 已撤销的绑定：连会话一起清掉，别留下能用的凭据。 */
export async function revokeSession(did: string): Promise<void> {
  const client = await getOAuthClient()
  await client.revoke(did).catch((err) => {
    console.error(`[atproto] revoke failed for ${did}:`, err)
  })
}
