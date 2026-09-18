import { Elysia } from 'elysia'
import { usernameFromCredentials } from '../auth/guard'
import { userHasCapability } from '../auth/service'
import { jwtPlugin } from '../jwt'
import { ensureStudioRunning, getStudioStatus } from './process'
import { proxyStudio } from './proxy'
import { readStudioAsset, upstreamFontUrl } from './ui'

/**
 * 把 Drizzle Studio 挂在管理后台里。
 *
 * 前端（local.drizzle.studio 的 HTML/JS）和 API 分两头：
 * - `/ui/*` 提供打过补丁的前端，它请求 API 时打的是同源的 `/api/admin/studio/api`；
 * - `/api/*` 转发到服务端 127.0.0.1:4983 上的 drizzle-kit studio，没起来就先把它拉起来。
 *
 * 鉴权直接用本站的会话 cookie。studio 前端是别人的代码，带不了 `Authorization`
 * 头 —— 这里本来靠「SPA 用 Bearer 换一张同源 cookie」绕过去（`POST /session`），
 * 但会话本身迁到 cookie 之后，`Domain=.pbhh.net` 已经让 `pbhh.net` 上的
 * `/api/admin/studio/*` 自动带上凭据，那次交换就是多余的一步，删掉。
 *
 * 注意校验的是 `usernameFromCredentials` 而不是 `usernameFromToken`：后者不比对
 * `tokenVersion`，等于让登出过的凭据还能开数据库后台。
 */

export default new Elysia({ prefix: '/admin/studio' })
  .use(jwtPlugin)
  // These hooks must stay **local**, not `as: 'scoped'`. This instance has routes of its
  // own, so local hooks cover exactly them. Scoped would copy them one level up — onto
  // the root app in `index.ts`, which holds every module's routes, so the guard would
  // reject every request on the server: 401 anonymous, 403 for any non-admin user.
  .derive(async ({ headers, cookie, jwt }) => {
    try {
      return { studioUser: await usernameFromCredentials(jwt, { headers, cookie }) }
    }
    // 坏掉的 token 是「没登录」，不是服务器错误。
    catch {
      return { studioUser: undefined }
    }
  })
  .onBeforeHandle(({ studioUser, status }) => {
    if (!studioUser)
      return status(401, { message: 'error.unauthorized' })
    if (!userHasCapability(studioUser, 'admin'))
      return status(403, { message: 'error.forbidden' })
  })
  // ── 状态：顺带催一下启动，前端轮询到 ready 再挂 iframe ──────────────────────
  .get('/status', () => {
    void ensureStudioRunning().catch(error => console.error('[studio] ensure failed', error))
    return getStudioStatus()
  })
  // ── 前端资源 ──────────────────────────────────────────────────────────────
  .get('/ui', ({ request }) => {
    // Elysia 把 `/ui` 和 `/ui/` 归一化成同一条路由，只能靠原始 pathname 区分。
    // 斜杠不能省：页面里 `./index.js` 是按文档 URL 解析的，少了它就会指到上一级去。
    const { pathname } = new URL(request.url)
    return pathname.endsWith('/')
      ? serveAsset('index.html', request)
      : new Response(null, { status: 302, headers: { location: `${pathname}/` } })
  })
  // Fonts need no patching, so send the browser to the CDN instead of caching them here.
  // Still behind the guard: this is the admin's studio, not a public font host.
  //
  // The ACAO header is for the redirect hop itself — fonts are fetched in CORS mode, and
  // a hop without it can drop the font with nothing in the server log to show for it.
  .get('/ui/fonts/:name', ({ params }) => {
    const url = upstreamFontUrl(params.name)
    return url
      ? new Response(null, {
          status: 307,
          headers: { 'location': url, 'access-control-allow-origin': '*' },
        })
      : new Response('Not Found', { status: 404 })
  })
  .get('/ui/:file', ({ params, request }) => serveAsset(params.file, request))
  // ── API 转发 ──────────────────────────────────────────────────────────────
  .all('/api', ({ request }) => proxyStudio(request))
  .all('/api/*', ({ request }) => proxyStudio(request))

async function serveAsset(name: string, request: Request) {
  const asset = await readStudioAsset(name)
  if (!asset)
    return new Response('Not Found', { status: 404 })

  // index.js 有 20MB，重进页面时让它走 304，不然每次都得重传一遍。
  if (request.headers.get('if-none-match') === asset.etag)
    return new Response(null, { status: 304 })

  return new Response(asset.body, {
    headers: {
      'content-type': asset.contentType,
      // HTML 每次回来问一趟：换了上游或改了补丁，缓存的页面会一直指着旧的 index.js。
      'cache-control': name === 'index.html' ? 'no-store' : 'no-cache',
      'etag': asset.etag,
    },
  })
}
