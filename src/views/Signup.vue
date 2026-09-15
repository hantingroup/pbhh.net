<script setup lang="ts">
import { Eye, EyeOff } from 'lucide-vue-next'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import FormPage from '@/components/FormPage.vue'
import Input from '@/components/Input.vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useFields } from '@/composables/useFields'
import { useValidators } from '@/composables/useValidators'
import { api, fetchUser } from '@/lib/api'

const { t, te } = useI18n()
const router = useRouter()
const { username, nickname, password } = useValidators()
const activeHintField = ref<string | null>(null)
const showPassword = ref(false)
const showConfirmPassword = ref(false)

const { fields, filled, hasErrors } = useFields({
  username: { type: 'text', autocomplete: 'username', validate: username },
  nickname: { type: 'text', autocomplete: 'nickname', validate: nickname },
  password: { type: 'password', autocomplete: 'new-password', validate: password },
  confirmPassword: { type: 'password', autocomplete: 'new-password', validate: validateConfirmPassword },
})

function validateConfirmPassword(value: string) {
  if (!value)
    return t('validation.required')
  if (value !== fields.password.value.value)
    return t('field.confirmPassword.mismatch')
  return ''
}

function getFieldHint(key: string) {
  if (key === 'username')
    return t('signup.usernameHint')
  if (key === 'nickname')
    return t('signup.nicknameHint')
}

async function handleSubmit(): Promise<string | void> {
  // 同 Login.vue：凭据走服务端下发的 httpOnly cookie，响应体里的 `token` 不收。
  const { error } = await api.signup.post({
    username: fields.username.value.value,
    nickname: fields.nickname.value.value,
    password: fields.password.value.value,
  })

  if (error) {
    const key = error.value?.message
    return key && te(key) ? t(key) : t('error.signupFailed')
  }

  await fetchUser()
  router.push('/')
}
</script>

<template>
  <FormPage :title="t('signup.title')" :submit="handleSubmit">
    <Input
      v-for="field, key in fields"
      :id="key" :key="key" v-bind="field"
      v-model:value="field.value.value"
      v-model:error="field.error.value"
      :label="t(`field.${key}.label`)"
      :hint="getFieldHint(String(key))"
      :hint-visible="activeHintField === String(key)"
      :placeholder="t(`field.${key}.placeholder`)"
      :type="key === 'password' ? (showPassword ? 'text' : 'password') : key === 'confirmPassword' ? (showConfirmPassword ? 'text' : 'password') : field.type"
      @focusin="activeHintField = String(key)"
      @focusout="activeHintField = activeHintField === String(key) ? null : activeHintField"
    >
      <template v-if="key === 'username'" #suffix>
        .pbhh.net
      </template>

      <template v-if="key === 'password' || key === 'confirmPassword'" #append>
        <button
          type="button"
          class="inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="key === 'password'
            ? (showPassword ? t('field.password.hide') : t('field.password.show'))
            : (showConfirmPassword ? t('field.password.hide') : t('field.password.show'))"
          :title="key === 'password'
            ? (showPassword ? t('field.password.hide') : t('field.password.show'))
            : (showConfirmPassword ? t('field.password.hide') : t('field.password.show'))"
          @click="key === 'password' ? (showPassword = !showPassword) : (showConfirmPassword = !showConfirmPassword)"
        >
          <Eye v-if="key === 'password' ? showPassword : showConfirmPassword" class="size-4" />
          <EyeOff v-else class="size-4" />
        </button>
      </template>
    </Input>

    <template #submit="{ loading }">
      <Button type="submit" class="w-full" :disabled="!filled || hasErrors || loading">
        <Spinner v-if="loading" data-icon="inline-start" />
        {{ loading ? t('signup.submitting') : t('signup.submit') }}
      </Button>
    </template>

    <template #footer>
      <p class="text-center text-sm text-muted-foreground">
        {{ t('signup.hasAccount') }}
        <RouterLink to="/login" class="text-foreground underline underline-offset-4 hover:text-primary">
          {{ t('signup.loginLink') }}
        </RouterLink>
      </p>
    </template>
  </FormPage>
</template>
