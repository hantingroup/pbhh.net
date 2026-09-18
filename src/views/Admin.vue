<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { Button } from '@/components/ui/button'
import { user } from '@/lib/api'
import { hasCapability } from '@/lib/capabilities'

const router = useRouter()
const route = useRoute()
const canViewAdmin = computed(() => hasCapability(user.value?.capabilities, 'admin:view'))

type Tab = 'backend' | 'database'

const tabs: Array<{ key: Tab, label: string, to: string }> = [
  { key: 'backend', label: '服务端日志', to: '/admin/log' },
  { key: 'database', label: '数据库', to: '/admin/database' },
]

const currentTab = computed<Tab>(() =>
  route.path === '/admin/database' ? 'database' : 'backend',
)

onMounted(() => {
  if (!canViewAdmin.value)
    router.replace('/')
})
</script>

<template>
  <!-- A definite viewport height, not h-full: the parent main only has min-height, so a
       percentage height resolves to auto and the flex-1 iframe falls back to ~150px.
       Same workaround as RoomChat.vue. -->
  <div class="w-full h-[calc(100vh-4rem)] min-h-0 flex flex-col overflow-hidden">
    <div class="shrink-0 border-b bg-background sticky top-0 z-20">
      <div class="px-4 py-3 flex items-center gap-4 overflow-x-auto">
        <span class="font-bold shrink-0">Admin</span>
        <div class="flex gap-1 shrink-0">
          <RouterLink
            v-for="item in tabs"
            :key="item.key"
            :to="item.to"
          >
            <Button
              :variant="currentTab === item.key ? 'default' : 'outline'"
              size="sm"
              :class="currentTab === item.key ? 'border border-primary' : ''"
            >
              {{ item.label }}
            </Button>
          </RouterLink>
        </div>
      </div>
    </div>

    <RouterView v-slot="{ Component }">
      <component :is="Component" />
    </RouterView>
  </div>
</template>
