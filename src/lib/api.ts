import type { App } from 'server/index'
import type { Capability, UserProfile } from 'server/modules/auth/model'
import { treaty } from '@elysiajs/eden'
import { ref } from 'vue'

// Production: API lives on its own subdomain. Dev: vite proxy strips the /api prefix.
export const API_BASE = import.meta.env.DEV ? `${window.location.origin}/api` : 'https://api.pbhh.net'

/**
 * 凭据是一张 httpOnly cookie，由服务端下发，**前端读不到也不该读**。
 *
 * 所以要 `credentials: 'include'`：生产环境 API 在另一个子域，跨源响应不带这个选项
 * 连 `Set-Cookie` 都会被浏览器丢掉，登录会静默失败。子域之间是同站（见
 * `server/modules/auth/cookie.ts`），所以 `SameSite=Lax` 的 cookie 跟得上。
 *
 * 换成 cookie 之前，token 存在 localStorage 里，由 `headers` 闭包手工带上；
 * 那条路在 EventSource / WebSocket / 顶层跳转上走不通，只能把 token 塞进 URL。
 */
export const api = treaty<App>(API_BASE, {
  fetch: { credentials: 'include' },
})

export const user = ref<UserProfile & { capabilities: Capability[] }>()
export const unreadCount = ref(0)

export async function fetchUnreadCount() {
  if (!user.value)
    return
  const { data } = await api.notifications.unread.get()
  if (data)
    unreadCount.value = data.count
}

export function clearAuth() {
  user.value = undefined
  // 未读数不是会话的一部分，登出后不清就会把上一个人的红点留给下一个。
  unreadCount.value = 0
}

/**
 * 拿当前凭据换一份用户资料，是**唯一**的登录态来源。
 *
 * 这里不能再看本地有没有 token 才发请求：cookie 是 httpOnly 的，前端看不见它，
 * 「有没有登录」这个问题只有服务端答得上来。改成无条件请求，401 即未登录。
 */
export async function fetchUser() {
  const { data, error } = await api.me.get()
  if (error)
    clearAuth()
  else
    return user.value = data
}
