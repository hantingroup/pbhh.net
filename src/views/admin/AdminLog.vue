<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { ScrollArea } from '@/components/ui/scroll-area'

const props = defineProps<{
  logs: LogEntry[]
  autoScroll: boolean
  emptyText: string
}>()

export interface LogEntry { level: string, message: string, timestamp: number }

// The admin area is English-only, so timestamps are formatted here rather than
// through vue-i18n, whose `d()` would follow the site locale.
const TIMESTAMP_FORMAT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

const logEl = ref<{ viewport: HTMLElement | null } | null>(null)

const LEVEL_CLASS: Record<string, string> = {
  error: 'text-red-400',
  warn: 'text-amber-400',
  info: 'text-sky-400',
  log: 'text-foreground',
  debug: 'text-zinc-400',
  trace: 'text-muted-foreground',
}

watch(() => props.logs.length, () => {
  if (props.autoScroll)
    nextTick(() => logEl.value?.viewport?.scrollTo(0, logEl.value.viewport!.scrollHeight))
})
</script>

<template>
  <ScrollArea ref="logEl" class="flex-1 min-h-0 font-mono text-xs p-3 space-y-0.5">
    <div
      v-for="(entry, i) in logs"
      :key="i"
      class="flex gap-2 leading-5"
    >
      <span class="text-muted-foreground shrink-0">{{ TIMESTAMP_FORMAT.format(entry.timestamp) }}</span>
      <span class="shrink-0 w-8 uppercase font-semibold" :class="LEVEL_CLASS[entry.level]">{{ entry.level }}</span>
      <span class="break-all whitespace-pre-wrap">{{ entry.message }}</span>
    </div>
    <div v-if="logs.length === 0" class="text-muted-foreground py-4 text-center">
      {{ emptyText }}
    </div>
  </ScrollArea>
</template>
