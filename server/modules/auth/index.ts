import { Elysia } from 'elysia'
import { bus } from '../events/bus'
import { getFollowerCount, getFollowingCount, isFollowing } from '../follow/service'
import { jwtPlugin } from '../jwt'
import { AUTH_COOKIE, AUTH_MAX_AGE_SECONDS, authCookieOptions, readAuthToken } from './cookie'
import { optionalAuth, requireAuth, usernameFromToken } from './guard'
import { loginBody, signUpBody, updateProfileBody } from './model'
import * as AuthService from './service'

export default new Elysia()
  .use(jwtPlugin)
  /**
   * `ver` 是登出撤销用的版本号（见 `service.ts` 的 `bumpTokenVersion`），守卫每次
   * 拿它和库里的列比对。响应里**照旧返回 `token`** —— 前端已经不再存它，但仓库外
   * 的 Bearer 消费者还在用。
   */
  .post('/login', async ({ body, status, jwt, cookie, request }) => {
    const user = await AuthService.verify(body.username, body.password)
    if (!user)
      return status(401, { message: 'error.invalidCredentials' })

    const token = await jwt.sign({ sub: user.username, ver: user.tokenVersion })
    cookie[AUTH_COOKIE]!.set({ value: token, ...authCookieOptions(request), maxAge: AUTH_MAX_AGE_SECONDS })
    return { token }
  }, { body: loginBody })
  .post('/signup', async ({ body, status, jwt, cookie, request }) => {
    const result = await AuthService.create(body)
    if (!result.ok) {
      return result.reason === 'reserved'
        ? status(409, { message: 'error.usernameReserved' })
        : status(409, { message: 'error.usernameExists' })
    }
    bus.publish('net.pbhh.user.registered', { username: result.username })

    const token = await jwt.sign({ sub: result.username, ver: AuthService.getTokenVersion(result.username) })
    cookie[AUTH_COOKIE]!.set({ value: token, ...authCookieOptions(request), maxAge: AUTH_MAX_AGE_SECONDS })
    return status(201, { token })
  }, { body: signUpBody })
  /**
   * 登出 = 版本号 +1，该用户所有 token 立刻失效，然后清掉 cookie。
   *
   * 刻意**不挂 `requireAuth`**：凭据可能已经失效（过期、或已登出过），那种情况下
   * 挂守卫会让请求 401、cookie 也清不掉，用户卡在「登出不了又进不去」。所以这里
   * 只验签取 `sub` —— `usernameFromToken` 不看 `ver` 正是为此。
   */
  .post('/logout', async ({ jwt, cookie, headers, request }) => {
    const username = await usernameFromToken(jwt, readAuthToken({ headers, cookie }))
    if (username)
      AuthService.bumpTokenVersion(username)

    cookie[AUTH_COOKIE]!.set({ value: '', ...authCookieOptions(request), maxAge: 0 })
    return { ok: true }
  })
  .use(optionalAuth)
  .get('/users/:username', ({ params, status, username: viewer }) => {
    const profile = AuthService.getByUsername(params.username)
    if (!profile)
      return status(404, { message: 'error.userNotFound' })
    const { username } = profile
    return {
      ...profile,
      followerCount: getFollowerCount(username),
      followingCount: getFollowingCount(username),
      isFollowing: !!viewer && isFollowing(viewer, username),
    }
  })
  .use(requireAuth)
  .get('/me', ({ username, status }) => {
    const profile = AuthService.getByUsername(username)
    return profile
      && { ...profile, capabilities: AuthService.getCapabilities(username) }
      || status(404, { message: 'error.userNotFound' })
  })
  .patch('/me', async ({ username, status, body }) => {
    return await AuthService.update(username, body)
      || status(404, { message: 'error.userNotFound' })
  }, { body: updateProfileBody })
