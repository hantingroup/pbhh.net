import { Elysia } from 'elysia'
import { jwtPlugin } from '../jwt'
import { readAuthToken } from './cookie'
import { getTokenVersion } from './service'

interface JwtVerifier {
  verify: (token: string) => Promise<unknown>
}

/** 从 payload 里取出要用的两个 claim；形状不对就当作没有。 */
function readClaims(payload: unknown) {
  if (!payload || typeof payload !== 'object' || !('sub' in payload) || typeof payload.sub !== 'string')
    return
  return { username: payload.sub, ver: 'ver' in payload ? payload.ver : undefined }
}

/**
 * **只验签**并取出 username，不看 `ver`。
 *
 * `/logout` 要用它：凭据已经失效的人也得能把自己的 cookie 清掉，否则会卡在
 * 「登出不了、又进不去」的状态。其余调用方一律用下面那个带版本比对的。
 */
export async function usernameFromToken(jwt: JwtVerifier, token: string | undefined) {
  if (!token)
    return

  return readClaims(await jwt.verify(token))?.username
}

/**
 * 验签 + 比对 token 版本，这才是「这个凭据现在还有效吗」的完整答案。
 *
 * 版本不等有两种来源：用户登出过（`bumpTokenVersion`），或者 token 是在引入这一列
 * **之前**签发的（那时 payload 里根本没有 `ver`）。后者意味着上线后所有人需要重新
 * 登录一次 —— 这正是想要的，那些永久 token 之前在 URL 里流通过，一次冲干净最好。
 */
export async function usernameFromCredentials(
  jwt: JwtVerifier,
  credentials: Parameters<typeof readAuthToken>[0],
) {
  const token = readAuthToken(credentials)
  if (!token)
    return

  const claims = readClaims(await jwt.verify(token))
  if (!claims || claims.ver !== getTokenVersion(claims.username))
    return

  return claims.username
}

/** 从请求凭据解出 username；没有或无效则不返回任何东西。 */
async function parseUsername({ headers, cookie, jwt }: Parameters<typeof usernameFromCredentials>[1] & { jwt: JwtVerifier }) {
  const username = await usernameFromCredentials(jwt, { headers, cookie })
  return username ? { username } : undefined
}

export const optionalAuth = new Elysia({ name: 'optional-auth' })
  .use(jwtPlugin)
  .derive({ as: 'scoped' }, parseUsername)

/**
 * `as: 'scoped'` 只向上传播一层：hook 拷贝给**直接** `.use()` 它的实例，不再沿着
 * `.use()` 链继续上传。所以 `requireAuth` 不能只 `.use(optionalAuth)` 就指望拿到
 * username —— 实测那样写时它自己的 hook 上下文里 `username` 恒为 undefined，
 * 连已登录请求都会被拒。
 *
 * 两个 `as: 'scoped'` 都不能省：
 * - `onBeforeHandle` 缺了它 → 本实例没有自己的路由，检查挂在空集上，等价于没有守卫。
 * - `derive` 缺了它 → 消费方路由拿不到 `username`。
 */
export const requireAuth = new Elysia({ name: 'require-auth' })
  .use(jwtPlugin)
  .derive({ as: 'scoped' }, parseUsername)
  // 再把 username 收敛成非可选：`parseUsername` 可能什么都不返回，消费方拿到的会是
  // `string | undefined`。守卫保证走到 handler 时它一定存在，这里把类型补齐。
  .derive({ as: 'scoped' }, ({ username }) => ({ username: username! }))
  .onBeforeHandle({ as: 'scoped' }, ({ username, status }) => {
    if (!username)
      return status(401)
  })
