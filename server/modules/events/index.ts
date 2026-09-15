import { Elysia, t } from 'elysia'
import { readAuthToken } from '../auth/cookie'
import { requireAuth, usernameFromCredentials } from '../auth/guard'
import { jwtPlugin } from '../jwt'
import { bus } from './bus'
import { clearWebhook, getSubscriber, registerSse, registerWs, setWebhook, unregister } from './deliver'
import { isValidTopicSuffix, pushBody, subscribeBody } from './model'

// ─── Routes ───────────────────────────────────────────────────────────────────

const encoder = new TextEncoder()

const streamQuery = t.Object({
  topics: t.Optional(t.String()),
})

/**
 * 匿名 SSE 只放行这几个 topic。**必须逐条列出，不能写 `net.pbhh.post.*`** ——
 * 前缀匹配会让将来新增的话题自动对匿名公开，白名单就失去了「加新东西时必须有人
 * 主动决定」的意义。
 *
 * `app.bsky.*` 刻意不进：它内容本身是公开的，但一旦放进来，本站就成了「按 DID
 * 抓取本站用户 Bluesky 帖」的稳定公开接口。题壁流的实时刷新不需要它 —— 镜像成功
 * 后会补发本地 `net.pbhh.post.created`（见 jetstream.ts）。
 *
 * 通知不在这个列表里，也不需要：它们根本不走总线（见 `deliver.ts` 的
 * `deliverToUser`），匿名连接没有 username，收不到。
 */
const PUBLIC_TOPICS = new Set([
  'net.pbhh.post.created',
  'net.pbhh.post.liked',
  'net.pbhh.post.replied',
])

function parseTopics(param: string | undefined, fallback: string[] = ['*']): string[] {
  return param ? param.split(',').map(s => s.trim()).filter(Boolean) : fallback
}

export default new Elysia({ prefix: '/events' })
  .use(jwtPlugin)
  .ws('/ws', {
    query: streamQuery,
    async open(ws) {
      const { topics } = ws.data.query

      // 浏览器的 `WebSocket` 构造器设不了请求头，所以这里只能看 cookie ——
      // 这也正是过去把 token 塞进 `?token=` 的原因，现在不必了。
      const username = await usernameFromCredentials(ws.data.jwt, ws.data)
      if (!username) {
        ws.close()
        return
      }

      registerWs(ws.raw, {
        username,
        topics: parseTopics(topics),
        send: data => ws.send(data),
      })
    },
    message(ws, msg) {
      const client = getSubscriber(ws.raw)
      if (!client?.username)
        return
      if (typeof msg !== 'object' || msg === null || (msg as any).type !== 'publish')
        return
      const { topic, payload } = msg as { type: string, topic?: unknown, payload?: unknown }
      if (typeof topic !== 'string' || !isValidTopicSuffix(topic))
        return
      bus.publish(`net.pbhh.custom.${client.username}.${topic}`, payload)
    },
    close(ws) {
      unregister(ws.raw)
    },
  })
  .get('/sse', async ({ query, jwt, headers, cookie, status }) => {
    const { topics: topicsParam } = query

    const credentials = { headers, cookie }
    const token = readAuthToken(credentials)
    const username = token ? await usernameFromCredentials(jwt, credentials) : undefined

    // 凭据非法一律 401，**绝不降级成匿名** —— 降级会让前端以为自己仍处于已
    // 认证状态，症状是通知红点永远不动，比直接报错难查得多。
    // 注意「没有凭据」和「凭据无效」要分开：前者是合法的匿名订阅，后者是错误。
    if (token && !username)
      return status(401, { message: 'error.unauthorized' })

    // 匿名连接没有 username，因此在投递层收不到任何点对点事件 —— 也就是收不到通知。
    const anonymous = !username

    // 两道控制是刻意冗余的。**闸门（`allow`）才是安全边界**，因为只有它能拦住匿名
    // 端显式传 `topics=*`；这里的默认值只是让匿名端从一开始就拿最小集合，且加了新
    // 公开话题时自动跟上。
    const topics = parseTopics(topicsParam, anonymous ? [...PUBLIC_TOPICS] : ['*'])

    let heartbeat: ReturnType<typeof setInterval>
    let key: object
    const stream = new ReadableStream({
      start(controller) {
        heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        }, 10 * 1000)
        // controller 本身就是这条连接的身份，不必另造一个 key。
        key = controller
        registerSse(controller, {
          username,
          topics,
          allow: anonymous ? (topic: string) => PUBLIC_TOPICS.has(topic) : undefined,
          send: (data) => {
            try {
              controller.enqueue(encoder.encode(`data: ${data}\n\n`))
            }
            catch {
              // 连接已关闭；注销由下面的 cancel 负责。
            }
          },
        })
      },
      cancel() {
        clearInterval(heartbeat)
        unregister(key)
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }, { query: streamQuery })
  .use(requireAuth)
  .post('/subscribe', ({ username, body }) => {
    setWebhook(username, body.url, body.topics ?? ['*'])
    return { ok: true }
  }, {
    body: subscribeBody,
    error({ error, status }) {
      return status(400, { message: 'error.badRequest', detail: error })
    },
  })
  .delete('/subscribe', ({ username }) => {
    clearWebhook(username)
    return { ok: true }
  })
  .post('/publish', ({ username, body }) => {
    bus.publish(`net.pbhh.custom.${username}.${body.topic}`, body.payload)
    return { ok: true }
  }, {
    body: pushBody,
    error({ error, status }) {
      return status(400, { message: 'error.badRequest', detail: error })
    },
  })
