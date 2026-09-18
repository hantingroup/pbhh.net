import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Drizzle Studio 的前端（HTML + 20MB 的 index.js）是 local.drizzle.studio 上的静态资源，
 * 不随 drizzle-kit 一起安装。这里首次请求时拉一份、就地打补丁、缓存到 data/ 下。
 *
 * 为什么要打补丁：前端从 `window.location.search` 的 host/port 拼出 `${proto}://${host}:${port}`
 * 当 API 根，然后**直接 POST 到这个根**——它只会是「某 host:port 的根」，没法表达一个路径前缀。
 * 而且它先试 http、失败才退 https，所以「把 host/port 指到自己的 443」也不行（nginx 对纯
 * HTTP 请求回 400，那不是网络错误，不触发降级）。唯一的办法就是改掉这一处拼接。
 *
 * 缓存是打过补丁的那份；上游改版导致补丁失配时会直接报错，不会悄悄端出没打补丁的前端。
 * 想强制重新拉取：删掉 data/studio-ui/。
 */

const UPSTREAM = 'https://local.drizzle.studio'
const cacheDir = resolve(import.meta.dir, '../../../data/studio-ui')
const FETCH_TIMEOUT_MS = 60_000

// eslint-disable-next-line no-template-curly-in-string -- 这串就是要照抄的压缩代码，${...} 是它的一部分
const XRN_SOURCE = 'xRn=(e,{host:t,port:n})=>`${e}://${t}:${n}`'
const XRN_PATCH = 'xRn=()=>"/api/admin/studio/api"'

interface AssetSpec {
  contentType: string
  transform?: (body: string) => string
}

const ASSETS: Record<string, AssetSpec> = {
  'index.html': { contentType: 'text/html; charset=utf-8', transform: patchHtml },
  'index.js': { contentType: 'text/javascript; charset=utf-8', transform: patchJs },
  'favicon.svg': { contentType: 'image/svg+xml' },
}

/**
 * The `@font-face` rules inside index.js resolve against `document.baseURI` (a module
 * script has no `document.currentScript`), so font requests land on /ui/fonts/*. They
 * need no patching, so they are redirected upstream rather than cached here.
 *
 * The allowlist is load-bearing: upstream answers any unknown path with the SPA's
 * index.html and a 200, and a font that fails to load fails silently.
 */
const UPSTREAM_FONTS = new Set([
  'Geist-Medium.otf',
  'GeistMono-Regular.otf',
  'Geist-Regular.otf',
  'Geist-SemiBold.otf',
  'Menlo-Regular.ttf',
  'OperatorMono-Book.otf',
])

export function upstreamFontUrl(name: string) {
  return UPSTREAM_FONTS.has(name) ? `${UPSTREAM}/fonts/${name}` : null
}

export interface StudioAsset {
  body: string
  contentType: string
  etag: string
}

function patchHtml(body: string) {
  // 管理后台没必要把第三方统计脚本加载进管理员的浏览器。
  return body.replace(/<script[^>]*onedollarstats[^>]*><\/script>/, '')
}

function patchJs(body: string) {
  if (!body.includes(XRN_SOURCE))
    throw new Error(`没在 ${UPSTREAM}/index.js 里找到 API 根拼接点（上游改版了？），拒绝提供未打补丁的前端`)

  return body.replace(XRN_SOURCE, XRN_PATCH)
}

/** 同一个资源并发请求时只拉一次。 */
const inFlight = new Map<string, Promise<string>>()

export async function readStudioAsset(name: string): Promise<StudioAsset | null> {
  const spec = ASSETS[name]
  if (!spec)
    return null

  const path = resolve(cacheDir, name)
  if (existsSync(path))
    return compose(path, readFileSync(path, 'utf-8'), spec)

  let pending = inFlight.get(name)
  if (!pending) {
    pending = download(name, spec.transform).finally(() => inFlight.delete(name))
    inFlight.set(name, pending)
  }

  return compose(resolve(cacheDir, name), await pending, spec)
}

function compose(path: string, body: string, spec: AssetSpec): StudioAsset {
  // index.js 有 20MB，重进页面时让它能走 304，不然每次都白传一遍。
  const stat = statSync(path)
  return {
    body,
    contentType: spec.contentType,
    etag: `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`,
  }
}

async function download(name: string, transform?: (body: string) => string) {
  const url = name === 'index.html' ? `${UPSTREAM}/` : `${UPSTREAM}/${name}`
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok)
    throw new Error(`拉取 ${url} 失败：HTTP ${response.status}`)

  const body = transform ? transform(await response.text()) : await response.text()

  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(resolve(cacheDir, name), body)
  console.info(`[studio] cached ${name} (${body.length} bytes) from ${UPSTREAM}`)
  return body
}
