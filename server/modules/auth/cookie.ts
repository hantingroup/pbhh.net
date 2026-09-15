/**
 * 会话 cookie 的名字和属性只在这里定义。
 *
 * 为什么是 cookie 而不是 `Authorization` 头：EventSource、WebSocket 握手、顶层跳转
 * **都设不了请求头**，所以过去只能把 token 塞进 query —— 于是它出现在
 * `/events/sse?token=…`、`/rooms/ws/:id?token=…`、`/atproto/oauth/login?token=…`
 * 等处，进而进 access log、浏览器历史和 `Referer`（atproto 那一处是送给第三方
 * 授权服务器的）。cookie 由浏览器自动附带，这几条路一起干净了。
 *
 * 跨子域问题：页面在 `pbhh.net`，API 在 `api.pbhh.net`。两者同属 registrable
 * domain `pbhh.net`，在 schemeful same-site 下是**同站**（两边都是 https），所以
 * `SameSite=Lax` 就够，**不需要** `None`。生产环境给 `Domain=.pbhh.net` 让两个源
 * 都收得到；dev 是 `localhost:5173` 经 vite 同源代理，只能是 host-only。
 */

/** 与 `SITE_ORIGIN` 同一个 env；另一处读者见 `modules/atproto/config.ts`。 */
const SITE_ORIGIN = (Bun.env.SITE_ORIGIN ?? 'https://pbhh.net').replace(/\/+$/, '')

export const AUTH_COOKIE = 'token'

/** 与 JWT 的 `exp` 保持一致（见 `modules/jwt.ts`）。 */
export const AUTH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/** nginx 在后面，`x-forwarded-proto` 才是浏览器看到的那个协议。 */
function isSecureRequest(request: Request) {
  return request.headers.get('x-forwarded-proto') === 'https'
    || new URL(request.url).protocol === 'https:'
}

/**
 * 只在生产加 `Domain`：dev 的源是 `localhost`，硬塞一个 `.pbhh.net` 浏览器会直接拒收。
 * 用 secure 当开关是因为这两个条件在生产环境恰好同时成立，不必再引一个 env。
 */
export function authCookieOptions(request: Request) {
  const secure = isSecureRequest(request)
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    ...(secure && { domain: `.${new URL(SITE_ORIGIN).hostname}` }),
  } as const
}

/**
 * 取出请求里的凭据：`Authorization: Bearer` 优先，其次 cookie。
 *
 * 保留 Bearer 是为了仓库外的消费者（服务器上还有个 koishi bot 之类）不被打断 ——
 * 前端已经不再用它了。副作用是过期的 Bearer 会盖住新鲜的 cookie，但只有显式设了
 * 那个头的调用方才会撞上。
 */
export function readAuthToken(
  { headers, cookie }: {
    headers: Record<string, string | undefined>
    cookie: Record<string, { value?: unknown } | undefined>
  },
) {
  if (headers.authorization?.startsWith('Bearer '))
    return headers.authorization.slice(7)

  const value = cookie[AUTH_COOKIE]?.value
  return typeof value === 'string' && value ? value : undefined
}
