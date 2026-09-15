import type { ElysiaWS } from 'elysia/ws'
import type { AppEvent } from '../events/bus'
import type { LogEntry } from './logger'
import { Elysia, t } from 'elysia'
import { requireAuth, usernameFromCredentials } from '../auth/guard'
import { userHasCapability } from '../auth/service'
import { bus } from '../events/bus'
import { jwtPlugin } from '../jwt'
import { getLogDates, logBuffer, logListeners, readLogsByDate } from './logger'
import { getUpdateStatus, runUpdateScript } from './updater'

const wsHandlers = new Map<ElysiaWS, {
  logFn: (entry: LogEntry) => void
  eventFn: (event: AppEvent) => void
  heartbeat: ReturnType<typeof setInterval>
}>()

export default new Elysia({ prefix: '/admin' })
  .use(jwtPlugin)
  .use(requireAuth)
  .onBeforeHandle(({ username, status }) => {
    if (!userHasCapability(username, 'admin'))
      return status(403, { message: 'error.forbidden' })
  })
  .get('/logs', () => logBuffer)
  .get('/log-dates', () => getLogDates())
  .get('/update', () => getUpdateStatus())
  .get('/logs/:date', ({ params, status }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date))
      return status(400, { message: 'error.badRequest' })
    return readLogsByDate(params.date)
  })
  .ws('/ws', {
    /**
     * 凭据走 cookie，query 上没有东西要校验。
     *
     * 这里过去声明了 `query: t.Object({ token: t.String() })` 却**从没读过它** ——
     * 全模块没有任何 `jwt.verify`。而浏览器 `WebSocket` 构造器设不了 `Authorization`
     * 头，所以上面那条 `requireAuth` 在握手时无从满足：这个订阅要么一直被拒、
     * 要么在 hook 不参与升级时完全敞开。现在像 events/room 那样在 `open` 里显式验。
     */
    query: t.Object({}),
    async open(ws) {
      // `requireAuth` 的 derive 是另一个实例的 scoped hook，在 `open` 里拿不到；
      // 而且 `open` 原本就没有任何授权检查，这里必须自己判一次管理员。
      const username = await usernameFromCredentials(ws.data.jwt, ws.data)
      if (!username || !userHasCapability(username, 'admin')) {
        ws.close()
        return
      }

      for (const entry of logBuffer)
        ws.send(JSON.stringify(entry))
      const logFn = (entry: LogEntry) => ws.send(JSON.stringify(entry))
      logListeners.add(logFn)
      const eventFn = (event: AppEvent) => ws.send(JSON.stringify({ type: 'event', ...event }))
      bus.on('event', eventFn)
      const heartbeat = setInterval(() => ws.send('{"type":"ping"}'), 5000)
      wsHandlers.set(ws, { logFn, eventFn, heartbeat })
    },
    close(ws) {
      const handler = wsHandlers.get(ws)
      if (handler) {
        logListeners.delete(handler.logFn)
        bus.off('event', handler.eventFn)
        clearInterval(handler.heartbeat)
        wsHandlers.delete(ws)
      }
    },
    message() {},
  })
  .post('/update', ({ status }) => {
    const result = runUpdateScript()
    if (!result.ok) {
      if (result.reason === 'missing')
        return status(500, { message: 'error.updateScriptMissing', scriptPath: result.scriptPath })
      if (result.reason === 'running')
        return status(409, { message: 'error.updateAlreadyRunning', update: getUpdateStatus() })
      return status(500, { message: 'error.updateFailed' })
    }
    return { ok: true, scriptPath: result.scriptPath, pid: result.pid, update: result.update }
  })
