import type { AppEvent } from './bus'
import { Buffer } from 'node:buffer'
import { Elysia, t } from 'elysia'
import { requireAuth } from '../auth/guard'
import { jwtPlugin } from '../jwt'
import { bus } from './bus'
import { isValidTopicSuffix, pushBody, subscribeBody } from './model'

// ─── Webhook ─────────────────────────────────────────────────────────────────

const MAX_FAILURES = 5

interface WebhookSub {
  url: string
  topics: string[]
  failures: number
}

const webhooks = new Map<string, WebhookSub>()

function matchesTopic(pattern: string, topic: string): boolean {
  if (pattern === '*')
    return true
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2)
    return topic === prefix || topic.startsWith(`${prefix}.`)
  }
  return pattern === topic
}

async function deliver(username: string, sub: WebhookSub, event: AppEvent, attempt = 1): Promise<void> {
  const auth = `Basic ${Buffer.from(`${username}:`).toString('base64')}`
  try {
    const res = await fetch(sub.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify(event),
    })
    if (!res.ok)
      throw new Error(`HTTP ${res.status}`)
    sub.failures = 0
  }
  catch (err) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * attempt))
      return deliver(username, sub, event, attempt + 1)
    }
    sub.failures++
    if (sub.failures >= MAX_FAILURES) {
      webhooks.delete(username)
      console.error(`[webhook:${username}] removed after ${MAX_FAILURES} consecutive failures`)
      return
    }
    console.error(`[webhook:${username}] delivery failed (failures=${sub.failures}):`, err)
  }
}

// ─── WS clients ──────────────────────────────────────────────────────────────

interface WsClient {
  username: string
  topics: string[]
  send: (data: string) => void
}

const wsClients = new Map<object, WsClient>()

// ─── Event dispatch ───────────────────────────────────────────────────────────

bus.on('event', (event: AppEvent) => {
  const msg = JSON.stringify(event)

  for (const [username, sub] of webhooks) {
    if (sub.topics.some(p => matchesTopic(p, event.topic))) {
      console.info(`[webhook:${username}] delivering topic=${event.topic} to ${sub.url}`)
      deliver(username, sub, event)
    }
  }

  for (const client of wsClients.values()) {
    if (client.topics.some(p => matchesTopic(p, event.topic)))
      client.send(msg)
  }
})

// ─── Routes ───────────────────────────────────────────────────────────────────

const encoder = new TextEncoder()

const streamQuery = t.Object({
  token: t.Optional(t.String()),
  topics: t.Optional(t.String()),
})

function parseTopics(param: string | undefined): string[] {
  return param ? param.split(',').map(s => s.trim()).filter(Boolean) : ['*']
}

export default new Elysia({ prefix: '/events' })
  .use(jwtPlugin)
  .ws('/ws', {
    query: streamQuery,
    async open(ws) {
      const { token, topics } = ws.data.query

      const payload = token ? await ws.data.jwt.verify(token) : null
      if (!payload || typeof payload.sub !== 'string') {
        ws.close()
        return
      }
      const username = payload.sub

      const client: WsClient = {
        username,
        topics: parseTopics(topics),
        send: data => ws.send(data),
      }
      wsClients.set(ws.raw, client)
    },
    message(ws, msg) {
      const client = wsClients.get(ws.raw)
      if (!client)
        return
      if (typeof msg !== 'object' || msg === null || (msg as any).type !== 'publish')
        return
      const { topic, payload } = msg as { type: string, topic?: unknown, payload?: unknown }
      if (typeof topic !== 'string' || !isValidTopicSuffix(topic))
        return
      bus.publish(`net.pbhh.custom.${client.username}.${topic}`, payload)
    },
    close(ws) {
      wsClients.delete(ws.raw)
    },
  })
  .get('/sse', async ({ query, jwt, status }) => {
    const { token, topics: topicsParam } = query
    const topics = parseTopics(topicsParam)

    if (token) {
      const payload = await jwt.verify(token)
      if (!payload || typeof payload.sub !== 'string')
        return status(401, { message: 'error.unauthorized' })
    }

    let handler: (event: AppEvent) => void
    let heartbeat: ReturnType<typeof setInterval>
    const stream = new ReadableStream({
      start(controller) {
        heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        }, 10 * 1000)
        handler = (event: AppEvent) => {
          if (topics.some(p => matchesTopic(p, event.topic)))
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        }
        bus.on('event', handler)
      },
      cancel() {
        clearInterval(heartbeat)
        bus.off('event', handler)
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
    webhooks.set(username, {
      url: body.url,
      topics: body.topics ?? ['*'],
      failures: 0,
    })
    return { ok: true }
  }, {
    body: subscribeBody,
    error({ error, status }) {
      return status(400, { message: 'error.badRequest', detail: error })
    },
  })
  .delete('/subscribe', ({ username }) => {
    webhooks.delete(username)
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
