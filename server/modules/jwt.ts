import { jwt } from '@elysiajs/jwt'
import { Elysia } from 'elysia'

export const jwtPlugin = new Elysia({ name: 'jwt' })
  .use(jwt({
    name: 'jwt',
    secret: Bun.env.JWT_SECRET ?? 'dev-secret-please-change-in-production',
    /**
     * 有效期。以前没有这一项，签出来的 payload 只有 `{ sub, iat }` —— 意味着
     * **签发的每一把 token 都永不过期**，登出也不作废，抓到一个就能用到天荒地老。
     *
     * 插件的 `sign` 是 `"exp" in signValue ? exp : defaultValues.exp`，所以放在这里
     * 对全部调用点一次生效。时长要和 `auth/cookie.ts` 的 `AUTH_MAX_AGE_SECONDS` 一致。
     */
    exp: '30d',
  }))
