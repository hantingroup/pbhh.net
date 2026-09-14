import { Elysia, t } from 'elysia'
import * as AtprotoOutbox from '../atproto/outbox'
import { optionalAuth, requireAuth } from '../auth/guard'
import * as AuthService from '../auth/service'
import { bus } from '../events/bus'
import { createPostBody, replyBody } from './model'
import * as PostService from './service'

export default new Elysia()
  .use(optionalAuth)
  .get('/posts', ({ query, username }) => {
    // `?username=` 大小写自由；归一到存储形式。解析不出来就原样传下去 ——
    // 等值比较自然匹配不到任何行，结果为空的语义保持不变。
    const filter = query.username
      ? (AuthService.resolveUsername(query.username) ?? query.username)
      : undefined
    return PostService.list(username, filter)
  }, {
    query: t.Object({ username: t.Optional(t.String()) }),
  })
  .get('/posts/:id', ({ params, status, username }) => {
    const post = PostService.get(Number(params.id), username)
    if (!post)
      return status(404, { message: 'error.postNotFound' })
    return post
  })
  .get('/posts/:id/thread', ({ params, username }) =>
    PostService.listThread(Number(params.id), username))
  .get('/posts/:id/ancestors', ({ params, username }) =>
    PostService.listAncestors(Number(params.id), username))
  .use(requireAuth)
  .post('/posts', ({ body, status, username }) => {
    const postId = PostService.create(username, body.content, body.title)
    bus.publish('net.pbhh.post.created', { username, postId })
    // 写路径**显式调用**，不订阅总线 —— 见 outbox.ts 开头的说明。同步函数，
    // 内部自己判断有没有绑定、有没有关掉发布。
    AtprotoOutbox.mirrorLocalPost({ username, postId })
    return status(201, {})
  }, {
    body: createPostBody,
    error({ error, status }) {
      return status(400, { message: 'error.badRequest', detail: error })
    },
  })
  .delete('/posts/:id', ({ params, status, username }) => {
    const result = PostService.remove(Number(params.id), username)
    if (result.status === 'not_found')
      return status(404, { message: 'error.postNotFound' })
    if (result.status === 'forbidden')
      return status(403, { message: 'error.forbidden' })
    // 入队要在响应之前 —— 它只是一次本地写。先返回再入队就留下一个「进程恰好被杀
    // 则 Bluesky 上的副本永远不会被删」的窗口。
    AtprotoOutbox.enqueueDeletes(username, result.outbound)
    return {}
  })
  .post('/posts/:id/like', ({ params, status, username }) => {
    const result = PostService.toggleLike(Number(params.id), username)
    if (result === null)
      return status(404, { message: 'error.postNotFound' })
    bus.publish('net.pbhh.post.liked', {
      postId: Number(params.id),
      actorUsername: username,
      liked: result,
    })
    return { liked: result }
  })
  .post('/posts/:id/reply', ({ params, body, status, username }) => {
    const parentExists = PostService.get(Number(params.id))
    if (!parentExists)
      return status(404, { message: 'error.postNotFound' })
    const replyId = PostService.create(username, body.content, undefined, Number(params.id))
    bus.publish('net.pbhh.post.replied', {
      parentId: Number(params.id),
      actorUsername: username,
      replyId,
    })
    AtprotoOutbox.mirrorLocalPost({ username, postId: replyId })
    return status(201, {})
  }, {
    body: replyBody,
  })
