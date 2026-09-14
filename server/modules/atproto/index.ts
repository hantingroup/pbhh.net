import type { OAuthSession } from '@atproto/oauth-client-node'
import { Agent } from '@atproto/api'
import { Elysia, t } from 'elysia'
import { requireAuth } from '../auth/guard'
import { jwtPlugin } from '../jwt'
import { backfillFromPds } from './backfill'
import { getOAuthClient, isAtprotoConfigured, revokeSession, sweepExpiredStates } from './client'
import { HANDLE_DOMAIN, SITE_ORIGIN } from './config'
import { getJetstreamStatus, scheduleJetstreamReconnect, startJetstream } from './jetstream'
import * as AtprotoService from './service'

const SWEEP_INTERVAL_MS = 15 * 60 * 1000

/** `?token=` 是既有约定（WS 也这么带），顶层跳转没法设 Authorization 头。 */
const pendingStates = new Map<string, { mode: 'bind', username: string, expiresAt: number }>()

setInterval(sweepExpiredStates, SWEEP_INTERVAL_MS).unref?.()

// 读路径（JetStream 入站）。放在模块加载处：没有已绑定身份时它自己就返回，
// 所以本地开发不会真去连生产 JetStream。
startJetstream()

async function resolveHandle(session: OAuthSession): Promise<string | undefined> {
  try {
    const agent = new Agent(session)
    const { data } = await agent.com.atproto.server.getSession()
    return data.handle
  }
  catch (err) {
    console.error('[atproto] failed to resolve handle for session:', err)
    return undefined
  }
}

function backToSettings(params: Record<string, string>) {
  const query = new URLSearchParams({ tab: 'atproto', ...params })
  return `${SITE_ORIGIN}/settings?${query}`
}

export default new Elysia()
  .use(jwtPlugin)
  // ── 无需鉴权：授权服务器与 handle 校验都要能直接抓到 ──────────────────────
  .get('/oauth-client-metadata.json', async ({ status }) => {
    if (!isAtprotoConfigured())
      return status(503, { message: 'atproto.notConfigured' })
    const client = await getOAuthClient()
    return client.clientMetadata
  })
  .get('/.well-known/atproto-did', ({ headers, status }) => {
    const did = AtprotoService.getDidForHost(headers.host)
    // 不存在的子域必须是 404 + 纯文本，绝不能落到 SPA 兜底返回 HTML ——
    // 否则授权服务器会把 HTML 当成 DID 读。
    if (!did)
      return status(404, 'not found')
    return new Response(did, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        // 短缓存：用户改名/解绑后要能较快失效。
        'Cache-Control': 'max-age=60',
      },
    })
  })
  .get('/atproto/oauth/login', async ({ query, jwt, status, redirect }) => {
    if (!isAtprotoConfigured())
      return status(503, { message: 'atproto.notConfigured' })

    // 先只做绑定：自动建号（mode=login）要不要支持还没定，留出口但不实现。
    if (query.mode && query.mode !== 'bind')
      return status(400, { message: 'atproto.loginNotEnabled' })

    const payload = query.token ? await jwt.verify(query.token) : null
    if (!payload || typeof payload.sub !== 'string')
      return status(401, { message: 'error.unauthorized' })

    const client = await getOAuthClient()
    const state = crypto.randomUUID()
    pendingStates.set(state, {
      mode: 'bind',
      username: payload.sub,
      expiresAt: Date.now() + 60 * 60 * 1000,
    })

    try {
      return redirect((await client.authorize(query.handle, { state })).toString())
    }
    catch (err) {
      pendingStates.delete(state)
      console.error(`[atproto] authorize failed for ${query.handle}:`, err)
      return redirect(backToSettings({ atproto: 'error', reason: 'authorizeFailed' }))
    }
  }, {
    query: t.Object({
      handle: t.String({ minLength: 1 }),
      token: t.Optional(t.String()),
      mode: t.Optional(t.String()),
    }),
  })
  .get('/atproto/oauth/callback', async ({ query, request, status, redirect }) => {
    if (!isAtprotoConfigured())
      return status(503, { message: 'atproto.notConfigured' })

    // 授权服务器拒绝时不会带 code，带的是 error/error_description。
    // `access_denied`（用户在授权页点「拒绝」）是最常见的一种，归一成具名 reason，
    // 否则这个原始英文 token 会被原样显示给用户。
    if (query.error) {
      return redirect(backToSettings({
        atproto: 'error',
        reason: query.error === 'access_denied' ? 'accessDenied' : query.error,
      }))
    }

    const client = await getOAuthClient()
    let session: OAuthSession
    let state: string | null
    try {
      // 直接用原始查询串，避免被上面的 schema 过滤掉 `iss` 之类库需要的参数。
      const params = new URL(request.url).searchParams
      ;({ session, state } = await client.callback(params))
    }
    catch (err) {
      console.error('[atproto] callback failed:', err)
      return redirect(backToSettings({ atproto: 'error', reason: 'callbackFailed' }))
    }

    const pending = state ? pendingStates.get(state) : undefined
    if (state)
      pendingStates.delete(state)
    if (!pending || pending.expiresAt < Date.now())
      return redirect(backToSettings({ atproto: 'error', reason: 'stateExpired' }))

    const handle = await resolveHandle(session)
    if (!handle) {
      await revokeSession(session.did)
      return redirect(backToSettings({ atproto: 'error', reason: 'handleUnresolved' }))
    }

    const result = AtprotoService.bindIdentity({
      username: pending.username,
      did: session.did,
      handle,
      pdsUrl: session.serverMetadata.issuer,
    })
    if (!result.ok) {
      await revokeSession(session.did)
      return redirect(backToSettings({ atproto: 'error', reason: result.reason }))
    }

    // 新绑定的 repo 要进 `dids` 订阅列表。**刻意不通过 `bus` 广播这件事** ——
    // `bus.on('event')` 会把事件投给所有 webhook 与已认证的 WS/SSE 订阅者，等于把
    // 「谁绑定了/谁解绑了」泄露给所有人。
    scheduleJetstreamReconnect()

    // 回填历史帖。**刻意不 await** —— 用户拿到的应该是一张已经跳回去的设置页，
    // 而不是等 50 条记录写完；失败也只记日志（见 backfill.ts）。不 await 也意味着
    // 它可能与 JetStream 的实时流抢同一条 URI，靠 `posts.atproto_uri` 的唯一索引
    // 加 `on conflict do nothing` 吸收。
    void backfillFromPds(session.did)

    return redirect(backToSettings({ atproto: 'bound' }))
  }, {
    query: t.Object({
      code: t.Optional(t.String()),
      state: t.Optional(t.String()),
      error: t.Optional(t.String()),
      error_description: t.Optional(t.String()),
    }, { additionalProperties: true }),
  })
  // ── 需要鉴权 ───────────────────────────────────────────────────────────────
  .use(requireAuth)
  .get('/me/bindings/atproto', ({ username }) => {
    const identity = AtprotoService.getIdentity(username)
    return {
      // 绑定是顶层浏览器跳转，缺 ATPROTO_PRIVATE_KEY 时用户会停在裸 JSON 的 503 上。
      // 把这个状态暴露出来，前端才能提前把按钮禁掉。
      configured: isAtprotoConfigured(),
      did: identity?.did ?? null,
      handle: identity?.handle ?? null,
      // 子域标签就是用户名（降为小写），注册时就定了，没有单独的认领步骤。
      domainHandle: `${username.toLowerCase()}.${HANDLE_DOMAIN}`,
      handleDomain: HANDLE_DOMAIN,
    }
  })
  .delete('/me/bindings/atproto', async ({ username, status }) => {
    const did = AtprotoService.unbindIdentity(username)
    if (did)
      await revokeSession(did)
    scheduleJetstreamReconnect()
    return status(204, null)
  })
  /**
   * 读路径的可观测性。`console.*` 已被 `admin/logger.ts` 全量捕获（`/admin/log` 可看），
   * 但连接状态是「看一眼」的需求，翻日志太慢。
   *
   * **不回传 `dids` 原文** —— DID 本身是公开信息，但没必要把它们一次性交给任意已认证
   * 用户；个数足以判断「该不该连着」。
   */
  .get('/me/bindings/atproto/jetstream', () => getJetstreamStatus())
