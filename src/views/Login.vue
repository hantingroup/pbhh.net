<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import FormPage from '@/components/FormPage.vue'
import Input from '@/components/Input.vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useFields } from '@/composables/useFields'
import { useValidators } from '@/composables/useValidators'
import { api, fetchUser, TOKEN } from '@/lib/api'

const router = useRouter()
const { t, te } = useI18n()
const { loginUsername, password } = useValidators()
const { fields, filled, hasErrors } = useFields({
  username: { type: 'text', autocomplete: 'username', validate: loginUsername },
  password: { type: 'password', autocomplete: 'current-password', validate: password },
})

async function handleSubmit(): Promise<string | void> {
  const { data, error } = await api.login.post({
    username: fields.username.value.value,
    password: fields.password.value.value,
  })

  if (error) {
    const key = error.value?.message
    return key && te(key) ? t(key) : t('error.loginFailed')
  }

  TOKEN.value = data.token
  await fetchUser()
  if (window.history.length > 1)
    router.back()
  else
    router.push('/')
}
</script>

<template>
  <FormPage :title="t('login.title')" :submit="handleSubmit">
    <Input
      v-for="field, key in fields"
      :id="key" :key="key" v-bind="field"
      v-model:value="field.value.value"
      v-model:error="field.error.value"
      :label="t(`field.${key}.label`)"
      :placeholder="t(`field.${key}.placeholder`)"
    />

    <template #submit="{ loading }">
      <Button type="submit" class="w-full" :disabled="!filled || hasErrors || loading">
        <Spinner v-if="loading" data-icon="inline-start" />
        {{ loading ? t('login.submitting') : t('login.submit') }}
      </Button>
    </template>

    <template #footer>
      <p class="text-center text-sm text-muted-foreground">
        {{ t('login.noAccount') }}
        <RouterLink to="/signup" class="text-foreground underline underline-offset-4 hover:text-primary">
          {{ t('login.signupLink') }}
        </RouterLink>
      </p>
    </template>
  </FormPage>
</template>
