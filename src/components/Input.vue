<script setup lang="ts">
import type { FieldValidator } from '@/composables/useValidators'
import { useSlots, watch } from 'vue'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const { validate } = defineProps<{
  id: string
  label: string
  hint?: string
  hintVisible?: boolean
  disabled?: boolean
  optional?: boolean
  dirty?: boolean
  validate?: FieldValidator
  error?: string
}>()

const emit = defineEmits<{
  'update:error': [string]
  'focusin': [FocusEvent]
  'focusout': [FocusEvent]
}>()

const slots = useSlots()
const modelValue = defineModel<string>('value')
watch(() => modelValue.value, (newValue) => {
  emit('update:error', validate?.(newValue || '') || '')
})
</script>

<template>
  <div class="space-y-2">
    <div class="flex justify-between items-end">
      <Label :for="id">
        {{ label }}
        <span v-if="!optional || dirty" class="text-destructive">*</span>
      </Label>
      <div v-if="error" class="text-xs leading-none text-destructive">
        {{ error }}
      </div>
    </div>
    <div class="relative flex gap-2" @focusin="emit('focusin', $event)" @focusout="emit('focusout', $event)">
      <div
        v-if="hint && hintVisible"
        class="pointer-events-none absolute left-3 top-0 z-20 max-w-[calc(100%-1.5rem)] -translate-y-[calc(100%+0.75rem)] rounded-xl border border-border/70 bg-popover px-3 py-2 text-xs leading-5 text-popover-foreground shadow-lg"
      >
        {{ hint }}
        <div class="absolute left-5 top-full size-3 -translate-y-1/2 rotate-45 border-b border-r border-border/70 bg-popover" />
      </div>
      <slot name="prepend" />
      <Input
        :id="id"
        v-bind="$attrs"
        spellcheck="false"
        :required="!optional"
        :class="[
          error && 'border-destructive',
          slots.append && 'pr-11',
          slots.suffix && 'rounded-r-none',
        ]"
        :disabled="disabled"
        :model-value="modelValue"
        @update:model-value="modelValue = $event as string"
      />
      <!-- `append` 是浮在输入框内部的（如密码显隐按钮），`suffix` 是拼接在右侧的
           固定附加段（如 `.pbhh.net`）。两者服务于不同字段，不会同时出现。 -->
      <div v-if="slots.append" class="absolute inset-y-0 right-3 flex items-center">
        <slot name="append" />
      </div>
      <div
        v-if="slots.suffix"
        class="-ml-2 flex select-none items-center rounded-r-md border border-l-0 border-input bg-muted px-3 text-sm text-muted-foreground"
      >
        <slot name="suffix" />
      </div>
    </div>
  </div>
</template>
