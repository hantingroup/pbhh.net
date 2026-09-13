import { Elysia } from 'elysia'
import { optionalAuth, requireAuth } from '../auth/guard'
import * as AuthService from '../auth/service'
import * as FollowService from './service'

export default new Elysia()
  .use(optionalAuth)
  .get('/users/:username/follow', ({ params, username }) => {
    // 路径参数的大小写是用户自由拼的，先归一成存储形式，下游的 FK 等值比较才成立。
    const target = AuthService.resolveUsername(params.username)
    return { following: !!target && !!username && FollowService.isFollowing(username, target) }
  })
  .use(requireAuth)
  .post('/users/:username/follow', ({ params, username, status }) => {
    const target = AuthService.resolveUsername(params.username)
    if (!target)
      return status(404, { message: 'error.userNotFound' })
    if (target === username)
      return status(400, { message: 'error.badRequest' })
    const following = FollowService.toggle(username, target)
    return { following }
  })
