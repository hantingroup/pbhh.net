<script setup lang="ts">
import type { UserProfile } from 'server/modules/auth/model'
import { Inbox, LogOut, MessageCircle, Settings, ShieldCheck, User } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import UserAvatar from '@/components/UserAvatar.vue'
import { api, clearAuth, unreadCount, user } from '@/lib/api'
import { hasCapability } from '@/lib/capabilities'

defineProps<UserProfile>()

const router = useRouter()

async function logout() {
  // 先让服务端作废凭据（`tokenVersion` +1，清 cookie），再清本地。
  // 顺序不能反：凭据现在只存在于服务端下发的 httpOnly cookie 里，前端清不了它 ——
  // 只调 `clearAuth()` 会留下一张仍然有效的 cookie，刷新一下又登回来了。
  // 请求失败也照样往下走：本地状态必须清掉，否则界面会卡在「登出不了」。
  try {
    await api.logout.post()
  }
  catch {
    // 忽略
  }
  clearAuth()
  router.push('/login')
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger class="flex items-center gap-2 cursor-pointer">
      <span class="text-sm">{{ nickname }}</span>
      <div class="relative h-9">
        <UserAvatar :username="username" :nickname="nickname" :avatar="avatar" size="size-9" />
        <span v-if="unreadCount > 0" class="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-blue-500 border-2 border-background" />
      </div>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-40">
      <DropdownMenuItem as-child>
        <RouterLink :to="`/@${username}`" class="flex items-center gap-2 cursor-pointer">
          <User class="size-4" />
          {{ $t('nav.profile') }}
        </RouterLink>
      </DropdownMenuItem>
      <DropdownMenuItem as-child>
        <RouterLink to="/inbox" class="flex items-center gap-2 cursor-pointer">
          <Inbox class="size-4" />
          {{ $t('nav.inbox') }}
          <span v-if="unreadCount > 0" class="ml-auto text-xs font-medium bg-blue-500 text-white rounded-full px-1.5 py-0.5 leading-none">
            {{ unreadCount }}
          </span>
        </RouterLink>
      </DropdownMenuItem>
      <DropdownMenuItem as-child>
        <RouterLink to="/rooms" class="flex items-center gap-2 cursor-pointer">
          <MessageCircle class="size-4" />
          {{ $t('room.title') }}
        </RouterLink>
      </DropdownMenuItem>
      <DropdownMenuItem as-child>
        <RouterLink to="/settings" class="flex items-center gap-2 cursor-pointer">
          <Settings class="size-4" />
          {{ $t('nav.settings') }}
        </RouterLink>
      </DropdownMenuItem>
      <DropdownMenuItem v-if="hasCapability(user?.capabilities, 'admin:view')" as-child>
        <RouterLink to="/admin" class="flex items-center gap-2 cursor-pointer">
          <ShieldCheck class="size-4" />
          管理后台
        </RouterLink>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        class="flex items-center gap-2 text-destructive focus:text-destructive cursor-pointer"
        @click="logout"
      >
        <LogOut class="size-4" />
        {{ $t('nav.logout') }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
