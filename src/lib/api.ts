import type { App } from 'server/index'
import type { Capability, UserProfile } from 'server/modules/auth/model'
import { treaty } from '@elysiajs/eden'
import { useStorage } from '@vueuse/core'
import { ref } from 'vue'

export const TOKEN = useStorage('token', '')

// Production: API lives on its own subdomain. Dev: vite proxy strips the /api prefix.
export const API_BASE = import.meta.env.DEV ? `${window.location.origin}/api` : 'https://api.pbhh.net'

export const api = treaty<App>(API_BASE, {
  headers: () => ({
    Authorization: TOKEN.value && `Bearer ${TOKEN.value}`,
  }),
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
  TOKEN.value = ''
  user.value = undefined
}

export async function fetchUser() {
  if (!TOKEN.value) {
    clearAuth()
    return
  }

  const { data, error } = await api.me.get()
  if (error)
    clearAuth()
  else
    return user.value = data
}
