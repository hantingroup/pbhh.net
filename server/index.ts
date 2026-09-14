import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'
import { mailServer } from './modules/mail/server'
import './modules/admin/logger'

const app = new Elysia()
  .use(cors())
  .use(import('./modules/auth'))
  .use(import('./modules/events'))
  .use(import('./modules/notification'))
  .use(import('./modules/posts'))
  .use(import('./modules/follow'))
  .use(import('./modules/bind'))
  .use(import('./modules/atproto'))
  .use(import('./modules/hitokoto'))
  .use(import('./modules/room'))
  .use(import('./modules/admin'))
  .use(import('./modules/mail'))
  .use(import('./modules/hanting'))
  .listen(3000)

export type App = typeof app

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`)

mailServer.listen(25, () => {
  console.log('[mail] SMTP server listening on port 25')
})
