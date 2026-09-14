<script setup lang="ts">
import type { FieldValidator } from '@/composables/useValidators'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import Input from '@/components/Input.vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { api, API_BASE, TOKEN } from '@/lib/api'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

interface AtprotoBinding {
  configured: boolean
  did: string | null
  handle: string | null
  domainHandle: string
  handleDomain: string
}

const binding = ref<AtprotoBinding | null>(null)
const loading = ref(true)
const loadError = ref('')
const handle = ref('')
const handleError = ref('')
/** 正在跳去 PDS 授权（顶层跳转，页面会离开，所以这个状态基本只是防重复点击）。 */
const redirecting = ref(false)
const unbinding = ref(false)
const actionError = ref('')
const notice = ref('')

/**
 * 后端把 OAuth 的 reason 原样透传（`accessDenied` 等具名码除外），所以能翻译的
 * 是有限几个。用白名单而不是拿 reason 直接拼 key —— 那个值来自 query，不该
 * 由它决定去查哪个 i18n key。
 */
const KNOWN_REASONS = [
  'accessDenied',
  'authorizeFailed',
  'callbackFailed',
  'stateExpired',
  'handleUnresolved',
  'didTakenByOther',
  'handleTakenByOther',
] as const

/**
 * 至少一个点，每段与 `server/modules/atproto/config.ts` 的 `LABEL_RE` 同规则。
 * 这里校验的是用户**现有的** atproto handle（如 `alice.bsky.social`），不是本站
 * 用户名 —— 两者规则不同，不要复用 `useValidators` 里的 `username`。
 */
const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

const validateHandle: FieldValidator = (value) => {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed)
    return t('bind.atproto.handleRequired')
  if (!HANDLE_PATTERN.test(trimmed))
    return t('bind.atproto.handlePattern')
}

async function loadBinding() {
  loading.value = true
  loadError.value = ''
  try {
    const { data, error } = await api.me.bindings.atproto.get()
    if (error || !data)
      loadError.value = t('bind.atproto.loadFailed')
    else
      binding.value = data
  }
  catch {
    loadError.value = t('bind.atproto.loadFailed')
  }
  finally {
    loading.value = false
  }
}

/** `?atproto=bound` / `?atproto=error&reason=…`：OAuth 回来后只展示一次。 */
function readRedirectResult() {
  const status = route.query.atproto
  if (typeof status !== 'string')
    return

  if (status === 'bound') {
    notice.value = t('bind.atproto.boundSuccess')
  }
  else if (status === 'error') {
    const reason = typeof route.query.reason === 'string' ? route.query.reason : ''
    const key = (KNOWN_REASONS as readonly string[]).includes(reason)
      ? `bind.atproto.reasons.${reason}`
      : 'bind.atproto.reasons.unknown'
    actionError.value = t(key, { reason: reason || 'unknown' })
  }
  // 清掉 query —— 否则刷新会反复弹同一条结果。tab 参数也在其中，所以补回 hash。
  router.replace({ path: '/settings', query: {}, hash: '#atproto' })
}

onMounted(() => {
  loadBinding()
  readRedirectResult()
})

function startBind() {
  actionError.value = ''
  notice.value = ''
  if (!TOKEN.value) {
    actionError.value = t('error.unauthorized')
    return
  }
  handleError.value = validateHandle(handle.value) ?? ''
  if (handleError.value)
    return

  const query = new URLSearchParams({
    token: TOKEN.value,
    handle: handle.value.trim().toLowerCase(),
    mode: 'bind',
  })
  // 顶层跳转没法带 Authorization 头，所以 token 走 query（见 server 侧注释）。
  // 生产环境 API 在另一个子域，router.push 跨不了源，只能用 location。
  redirecting.value = true
  window.location.href = `${API_BASE}/atproto/oauth/login?${query}`
}

async function unbind() {
  unbinding.value = true
  actionError.value = ''
  notice.value = ''
  try {
    const { error } = await api.me.bindings.atproto.delete()
    if (error)
      actionError.value = t('bind.atproto.unbindFailed')
    else
      await loadBinding()
  }
  catch {
    actionError.value = t('bind.atproto.unbindFailed')
  }
  finally {
    unbinding.value = false
  }
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base flex items-center justify-between">
        {{ t('bind.atproto.title') }}
        <span
          v-if="binding && !loading"
          class="text-xs font-normal"
          :class="binding.did ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'"
        >
          {{ binding.did ? t('bind.atproto.bound') : t('bind.atproto.unbound') }}
        </span>
      </CardTitle>
    </CardHeader>

    <CardContent class="space-y-4">
      <div v-if="loading" class="flex justify-center py-6">
        <div class="size-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
      </div>

      <Alert v-else-if="loadError" variant="destructive">
        <AlertDescription>{{ loadError }}</AlertDescription>
      </Alert>

      <template v-else-if="binding">
        <Alert v-if="actionError" variant="destructive">
          <AlertDescription>{{ actionError }}</AlertDescription>
        </Alert>
        <Alert v-else-if="notice">
          <AlertDescription class="text-green-600 dark:text-green-400">
            {{ notice }}
          </AlertDescription>
        </Alert>

        <!-- 本站 handle：无论是否绑定都有，由用户名派生 -->
        <div class="space-y-1">
          <p class="text-sm text-muted-foreground">
            {{ t('bind.atproto.domainHandle') }}<strong class="text-foreground">{{ binding.domainHandle }}</strong>
          </p>
          <p class="text-xs text-muted-foreground">
            {{ t('bind.atproto.domainHandleHint') }}
          </p>
        </div>

        <template v-if="binding.did">
          <div class="space-y-1">
            <p class="text-sm text-muted-foreground">
              {{ t('bind.atproto.currentHandle') }}<strong class="text-foreground">{{ binding.handle }}</strong>
            </p>
            <p class="text-xs text-muted-foreground break-all">
              {{ t('bind.atproto.currentDid') }}{{ binding.did }}
            </p>
          </div>

          <p class="text-xs text-muted-foreground">
            {{ t('bind.atproto.syncNote') }}
          </p>

          <AlertDialog>
            <AlertDialogTrigger as-child>
              <Button variant="outline" class="w-full text-destructive hover:text-destructive" :disabled="unbinding">
                <Spinner v-if="unbinding" data-icon="inline-start" />
                {{ t('bind.atproto.unbind') }}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{{ t('bind.atproto.unbindConfirmTitle') }}</AlertDialogTitle>
                <AlertDialogDescription>
                  {{ t('bind.atproto.unbindConfirmDescription', { handle: binding.domainHandle }) }}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
                <AlertDialogAction
                  class="bg-destructive text-white hover:bg-destructive/90"
                  :disabled="unbinding"
                  @click.prevent="unbind"
                >
                  {{ t('bind.atproto.unbind') }}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </template>

        <template v-else>
          <p class="text-sm text-muted-foreground">
            {{ t('bind.atproto.intro') }}
          </p>

          <!--
            这两句是刻意写在「绑定前」的。别人对同步帖的回复不会过来，是这套机制
            最容易被误解的地方 —— 事后再解释只会变成工单。
          -->
          <p class="text-xs text-muted-foreground">
            {{ t('bind.atproto.syncNote') }}
          </p>
          <p class="text-xs text-muted-foreground">
            {{ t('bind.atproto.replyNote') }}
          </p>

          <Alert v-if="!binding.configured" variant="destructive">
            <AlertDescription>{{ t('bind.atproto.notConfigured') }}</AlertDescription>
          </Alert>

          <Input
            id="atproto-handle"
            v-model:value="handle"
            v-model:error="handleError"
            :label="t('bind.atproto.handleLabel')"
            :placeholder="t('bind.atproto.handlePlaceholder')"
            :validate="validateHandle"
            :disabled="!binding.configured"
            autocapitalize="off"
            autocorrect="off"
          />

          <Button
            class="w-full"
            :disabled="redirecting || !binding.configured"
            @click="startBind"
          >
            <Spinner v-if="redirecting" data-icon="inline-start" />
            {{ t('bind.atproto.bind') }}
          </Button>

          <p class="text-xs text-muted-foreground">
            {{ t('bind.atproto.redirectHint') }}
          </p>
        </template>
      </template>
    </CardContent>
  </Card>
</template>
