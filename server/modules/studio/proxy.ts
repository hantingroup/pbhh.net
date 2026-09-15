import { ensureStudioRunning, getStudioStatus, STUDIO_ORIGIN } from './process'

/** 服务器侧路径前缀；浏览器看到的是 /api/admin/studio/api（nginx / vite 会把 /api 剥掉）。 */
const MOUNT_PATH = '/admin/studio/api'

/** 逐跳头和 Bun 已经解压过的响应头，照着转发只会给出对不上的元数据。 */
const DROPPED_RESPONSE_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
]

export async function proxyStudio(request: Request): Promise<Response> {
  if (!await ensureStudioRunning())
    return unavailable()

  const url = new URL(request.url)
  // '' 就是 studio 协议的本体（POST / ），'/init' 是它的 legacy 探测。
  const subPath = url.pathname.slice(MOUNT_PATH.length)
  const target = new URL(`${STUDIO_ORIGIN}${subPath}`)
  target.search = url.search

  const headers = new Headers(request.headers)
  headers.delete('host')
  // 剥掉本站的会话 cookie 再转发。drizzle-kit studio 是本机另一个进程，没有任何
  // 理由拿到一张能开整个后台的凭据 —— 会话迁到 cookie 之后这一条更要紧了，
  // 因为现在每一条 studio 请求上都挂着一张真的。
  headers.delete('cookie')
  headers.delete('authorization')
  headers.delete('content-length')

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
  }
  if (!['GET', 'HEAD'].includes(request.method))
    init.body = await request.arrayBuffer()

  try {
    const response = await fetch(target, init)
    const proxyHeaders = new Headers(response.headers)
    for (const name of DROPPED_RESPONSE_HEADERS)
      proxyHeaders.delete(name)

    return new Response(response.body, { status: response.status, headers: proxyHeaders })
  }
  catch (error) {
    console.error('[studio] proxy failed', error)
    return unavailable()
  }
}

/** studio 前端把非 2xx 的 JSON 当 `error` 读出来显示，所以这里照它认得的形状回。 */
function unavailable() {
  const studio = getStudioStatus()
  return new Response(JSON.stringify({
    status: 'error',
    error: studio.error ?? 'drizzle studio 未就绪',
    studio,
  }), {
    status: 503,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
