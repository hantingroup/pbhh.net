import type { NodeSavedSessionStore, NodeSavedStateStore, OAuthClientMetadataInput } from '@atproto/oauth-client-node'
import { promises as dns } from 'node:dns'
import { JoseKey } from '@atproto/jwk-jose'
import { AtprotoHandleResolver, buildAtprotoLoopbackClientMetadata, NodeOAuthClient } from '@atproto/oauth-client-node'
import { eq, lt } from 'drizzle-orm'
import { atprotoOauthSessions, atprotoOauthStates, db } from 'server/database'
import { API_ORIGIN, IS_LOOPBACK } from './config'

/** 授权流程里 state 的有效期，超过就当作废。 */
export const STATE_TTL_MS = 60 * 60 * 1000

const SCOPE = 'atproto'

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
const handleResolver = new AtprotoHandleResolver({
  fetch: globalThis.fetch,
  resolveTxt: async (domain: string) => {
    const records = await dns.resolveTxt(domain)
    return records.map(parts => parts.join(''))
  },
})

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
