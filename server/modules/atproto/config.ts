/**
 * API 源。OAuth 的 `client_id` 是一个必须能被授权服务器直接 GET 到、返回 200
 * 且 `Content-Type: application/json` 的 HTTPS URL，所以它落在 api.pbhh.net
 * （nginx 该 vhost 的 `location /` 全量转发到本站，无需新增配置）。
 */
export const API_ORIGIN = (Bun.env.API_ORIGIN ?? 'https://api.pbhh.net').replace(/\/+$/, '')

/** 前端源。OAuth 回调完成后把用户送回这里。 */
export const SITE_ORIGIN = (Bun.env.SITE_ORIGIN ?? 'https://pbhh.net').replace(/\/+$/, '')

/** handle 域名服务使用的站点域名（`<label>.pbhh.net`）。 */
export const HANDLE_DOMAIN = Bun.env.HANDLE_DOMAIN ?? 'pbhh.net'

/** 环回源只用于本地开发：atproto 对 `http://127.0.0.1` 有专门的 loopback client。 */
export const IS_LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(API_ORIGIN)

/**
 * 不允许用户认领的子域标签。这些名字已经指向本站自己的服务（见 F 节的 nginx
 * vhost 与阿里云解析），被认领成 handle 会让 handle 校验落到别人的 vhost 上。
 */
export const RESERVED_LABELS = new Set([
  'api',
  'www',
  'bot',
  'gswapi',
  'tianzi',
  'admin',
  'mail',
  'smtp',
  'imap',
  'pop',
  'mx',
  'ns',
  'ns1',
  'ns2',
  'dns',
  'static',
  'assets',
  'cdn',
  'status',
  'dev',
  'test',
  'staging',
])

/**
 * DNS label 的字符规则：字母数字与 `-`，不首尾为 `-`，≤63 字符。
 *
 * **用户名与 label 共用这一套规则** —— 用户名就是 `*.pbhh.net` 的子域标签，只是
 * 保留用户选择的显示大小写（`Alice`），寻址与比较时才降为小写。
 *
 * 下面两个形态是刻意的，不是重复：
 * - `LABEL_RE` 只作用于 `labelFromHost` 已经降过小写的标签；
 * - `USERNAME_PATTERN` 是给注册 schema 的正则**字符串** —— Elysia 的
 *   `t.String({ pattern })` 只收字符串、传不了 `i` 标志，所以字符类必须写全。
 */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** 注册用：与 `LABEL_RE` 同规则，但接受大小写（用户名保留用户的显示形式）。 */
export const USERNAME_PATTERN = '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$'

/**
 * 从 `Host` 头取出 `*.pbhh.net` 的子域标签。只接受**单层**子域：
 * `alice.pbhh.net` → `alice`；`pbhh.net`、`a.b.pbhh.net`、`api.pbhh.net`
 * （保留字）一律 undefined —— handle 服务只对真正存在的用户名应答。
 *
 * 这里不再有「认领」概念：标签就是用户名，形状在注册时已由 `USERNAME_PATTERN`
 * 把关，这里复查一遍是为了让本函数对任意 Host 头都自洽。
 */
export function labelFromHost(host: string | undefined): string | undefined {
  if (!host)
    return undefined
  const name = (host.split(':')[0] ?? '').toLowerCase()
  const suffix = `.${HANDLE_DOMAIN}`
  if (!name.endsWith(suffix))
    return undefined
  const label = name.slice(0, -suffix.length)
  if (!label || label.includes('.') || !LABEL_RE.test(label))
    return undefined
  return RESERVED_LABELS.has(label) ? undefined : label
}
