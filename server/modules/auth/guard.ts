import { Elysia } from 'elysia'
import { jwtPlugin } from '../jwt'

/** 从 `Authorization: Bearer <jwt>` 解出 username；没有或无效则不返回任何东西。 */
async function parseUsername({ headers, jwt }: {
  headers: Record<string, string | undefined>
  jwt: { verify: (token: string) => Promise<unknown> }
}) {
  if (headers.authorization?.startsWith('Bearer ')) {
    const payload = await jwt.verify(headers.authorization.slice(7))
    if (payload && typeof payload === 'object' && 'sub' in payload && typeof payload.sub === 'string')
      return { username: payload.sub }
  }
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
