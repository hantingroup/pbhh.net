import { Elysia } from 'elysia'
import { bus } from '../events/bus'
import { getFollowerCount, getFollowingCount, isFollowing } from '../follow/service'
import { jwtPlugin } from '../jwt'
import { optionalAuth, requireAuth } from './guard'
import { loginBody, signUpBody, updateProfileBody } from './model'
import * as AuthService from './service'

export default new Elysia()
  .use(jwtPlugin)
  .post('/login', async ({ body, status, jwt }) => {
    const user = await AuthService.verify(body.username, body.password)
    if (!user)
      return status(401, { message: 'error.invalidCredentials' })
    return { token: await jwt.sign({ sub: user.username }) }
  }, { body: loginBody })
  .post('/signup', async ({ body, status, jwt }) => {
    const result = await AuthService.create(body)
    if (!result.ok) {
      return result.reason === 'reserved'
        ? status(409, { message: 'error.usernameReserved' })
        : status(409, { message: 'error.usernameExists' })
    }
    bus.publish('net.pbhh.user.registered', { username: result.username })
    return status(201, { token: await jwt.sign({ sub: result.username }) })
  }, { body: signUpBody })
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
