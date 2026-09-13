<script setup lang="ts">
import { AtSign, Bell, Link, MonitorCog, Quote, User } from 'lucide-vue-next'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { Separator } from '@/components/ui/separator'
import SettingsAtproto from './settings/SettingsAtproto.vue'
import SettingsBind from './settings/SettingsBind.vue'
import SettingsHitokoto from './settings/SettingsHitokoto.vue'
import SettingsNotifications from './settings/SettingsNotifications.vue'
import SettingsProfile from './settings/SettingsProfile.vue'
import SettingsAppearance from './settings/SettingsTheme.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

type Tab = 'profile' | 'appearance' | 'bind' | 'atproto' | 'notifications' | 'hitokoto'
const TABS: Tab[] = ['profile', 'appearance', 'bind', 'atproto', 'notifications', 'hitokoto']

/**
 * atproto 的 OAuth 回调是**顶层跳转**回来的，只能带 query：
 * `${SITE_ORIGIN}/settings?tab=atproto&atproto=bound`（server/modules/atproto/index.ts）。
 * 站内切换仍然走 hash。两个来源都认，query 优先。
 */
function getTabFromHash(): Tab {
  const fromQuery = route.query.tab
  const candidate = (typeof fromQuery === 'string' ? fromQuery : '') || location.hash.slice(1)
  return (TABS as string[]).includes(candidate) ? (candidate as Tab) : 'profile'
}

const activeTab = ref<Tab>(getTabFromHash())

function setTab(tab: Tab) {
  activeTab.value = tab
  // 用 router.replace 而非 history.replaceState：后者传 fragment-only 的 URL 会
  // **保留 search**，`?atproto=bound` 会残留到下次刷新、反复弹同一条结果。
  router.replace({ path: '/settings', query: {}, hash: `#${tab}` })
}
</script>

<template>
  <div class="w-full max-w-3xl px-4 py-8 mb-auto">
    <h1 class="text-2xl font-bold mb-6">
      {{ t('settings.title') }}
    </h1>

    <div class="flex gap-6 flex-col sm:flex-row">
      <!-- Sidebar nav -->
      <nav class="flex sm:flex-col gap-1 sm:w-44 shrink-0 overflow-x-auto">
        <button
          v-for="tab in TABS"
          :key="tab"
          class="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left transition-colors whitespace-nowrap cursor-pointer"
          :class="activeTab === tab ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'"
          @click="setTab(tab)"
        >
          <User v-if="tab === 'profile'" class="size-4 shrink-0" />
          <MonitorCog v-else-if="tab === 'appearance'" class="size-4 shrink-0" />
          <Link v-else-if="tab === 'bind'" class="size-4 shrink-0" />
          <AtSign v-else-if="tab === 'atproto'" class="size-4 shrink-0" />
          <Bell v-else-if="tab === 'notifications'" class="size-4 shrink-0" />
          <Quote v-else-if="tab === 'hitokoto'" class="size-4 shrink-0" />
          {{ t(`settings.tabs.${tab}`) }}
        </button>
      </nav>

      <Separator class="sm:hidden" />
      <div class="hidden sm:block w-px bg-border shrink-0" />

      <!-- Content -->
      <div class="flex-1 min-w-0">
        <SettingsProfile v-if="activeTab === 'profile'" />
        <SettingsAppearance v-else-if="activeTab === 'appearance'" />
        <SettingsBind v-else-if="activeTab === 'bind'" />
        <SettingsAtproto v-else-if="activeTab === 'atproto'" />
        <Suspense v-else-if="activeTab === 'notifications'">
          <SettingsNotifications />
          <template #fallback>
            <div class="flex justify-center py-8">
              <div class="size-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
            </div>
          </template>
        </Suspense>
        <SettingsHitokoto v-else-if="activeTab === 'hitokoto'" />
      </div>
    </div>
  </div>
</template>
