<script setup lang="ts">
import { Check, ChevronLeft, MailPlus, Send } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import Input from '@/components/Input.vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'

const { t, te } = useI18n()
const route = useRoute()
const router = useRouter()

const recipients = ref(typeof route.query.to === 'string' ? route.query.to : '')
const subject = ref(typeof route.query.subject === 'string' ? route.query.subject : '')
const body = ref('')
const sending = ref(false)
const errorMessage = ref('')
const sent = ref(false)

const normalizedRecipients = computed(() => recipients.value
  .split(/[;；]/)
  .map(part => part.trim())
  .filter(Boolean)
  .map(part => part.includes('@') ? part : `${part}@pbhh.net`)
  .join('; '))

const canSubmit = computed(() => !!recipients.value.trim() && !!subject.value.trim() && !!body.value.trim())

watch([recipients, subject, body], () => {
  if (sent.value)
    sent.value = false
})

async function submit() {
  if (!recipients.value.trim() || !subject.value.trim() || !body.value.trim())
    return

  sending.value = true
  errorMessage.value = ''
  sent.value = false

  const { error } = await api.mail.send.post({
    recipients: recipients.value.trim(),
    subject: subject.value.trim(),
    text: body.value.trim(),
  } as never)

  sending.value = false

  if (error) {
    // 401 的 body 是裸字符串 'Unauthorized'，没有 message 字段。
    const err = error.value
    const key = err && typeof err === 'object' ? err.message : undefined
    errorMessage.value = key && te(key) ? t(key) : t('mail.sendFailed')
    return
  }

  sent.value = true
}
</script>

<template>
  <div class="w-full mb-auto max-w-2xl px-4 py-8 space-y-4">
    <Button variant="ghost" size="sm" class="gap-1 -ml-2 text-muted-foreground" @click="router.back()">
      <ChevronLeft class="size-4" />
      {{ t('common.back') }}
    </Button>

    <div class="rounded-xl border bg-card p-5 shadow-sm space-y-5">
      <div class="flex items-center gap-3">
        <div class="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <MailPlus class="size-5" />
        </div>
        <div>
          <h1 class="text-xl font-semibold">{{ t('mail.composeTitle') }}</h1>
          <p class="text-sm text-muted-foreground">{{ t('mail.composeDescription') }}</p>
        </div>
      </div>

      <Input
        id="mail-recipient"
        v-model:value="recipients"
        :label="t('mail.recipients')"
        :placeholder="t('mail.recipientPlaceholder')"
      />

      <p v-if="normalizedRecipients" class="text-xs text-muted-foreground">
        {{ t('mail.composeAddress', { address: normalizedRecipients }) }}
      </p>

      <Input
        id="mail-subject"
        v-model:value="subject"
        :label="t('mail.subject')"
        :placeholder="t('mail.subjectPlaceholder')"
      />

      <div class="space-y-2">
        <label for="mail-body" class="text-sm font-medium">{{ t('mail.body') }}</label>
        <Textarea
          id="mail-body"
          v-model="body"
          class="min-h-40 resize-y"
          :placeholder="t('mail.bodyPlaceholder')"
        />
      </div>

      <p v-if="errorMessage" class="text-sm text-destructive">
        {{ errorMessage }}
      </p>
      <p v-else-if="sent" class="text-sm text-green-600 dark:text-green-400">
        {{ t('mail.sentDescription') }}
      </p>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" @click="router.push('/inbox')">
          {{ t('common.cancel') }}
        </Button>
        <Button :disabled="sending || sent || !canSubmit" @click="submit">
          <Spinner v-if="sending" data-icon="inline-start" />
          <Check v-else-if="sent" class="size-4" />
          <Send v-else class="size-4" />
          {{ sending ? t('mail.sending') : sent ? t('mail.sentDone') : t('mail.send') }}
        </Button>
      </div>
    </div>
  </div>
</template>
