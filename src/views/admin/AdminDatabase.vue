<!-- eslint-disable no-alert -->
<script setup lang="ts">
import { ChevronDown, Eye, EyeOff } from 'lucide-vue-next'
import { computed, onMounted, ref, watch, watchEffect } from 'vue'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { API_BASE } from '@/lib/api'

type Row = Record<string, unknown>

const props = defineProps<{
  canEdit: boolean
}>()

const tables = ref<string[]>([])
const selectedTable = ref('')
const tableRows = ref<Row[]>([])
const tablePks = ref<string[]>([])
const loadingTable = ref(false)

const editingIndex = ref<number | null>(null)
const editDraft = ref<Row>({})
const insertDraft = ref<Row | null>(null)

const DB_PAGE_SIZE = 500
const dbPage = ref(0)
const totalDbPages = computed(() => Math.max(1, Math.ceil(tableRows.value.length / DB_PAGE_SIZE)))
const pagedRows = computed(() => tableRows.value.slice(dbPage.value * DB_PAGE_SIZE, (dbPage.value + 1) * DB_PAGE_SIZE))

watchEffect(() => {
  if (dbPage.value >= totalDbPages.value)
    dbPage.value = totalDbPages.value - 1
})

watch(dbPage, () => {
  editingIndex.value = null
  insertDraft.value = null
})

const tableColumns = computed(() =>
  tableRows.value[0]
    ? Object.keys(tableRows.value[0])
    : insertDraft.value
      ? Object.keys(insertDraft.value)
      : [],
)

// ── Password column hiding ────────────────────────────────────────────────────
const PASSWORD_PATTERN = /password|passwd|secret/i
const hiddenCols = ref<Set<string>>(new Set())

watch(tableColumns, (cols) => {
  hiddenCols.value = new Set(cols.filter(col => PASSWORD_PATTERN.test(col)))
}, { immediate: true })

function toggleColVisibility(col: string) {
  const next = new Set(hiddenCols.value)
  if (next.has(col))
    next.delete(col)
  else
    next.add(col)
  hiddenCols.value = next
}

// ── Auth ──────────────────────────────────────────────────────────────────────
const authHeaders = computed(() => ({
  Authorization: `Bearer ${localStorage.getItem('token') ?? ''}`,
}))

async function loadTables() {
  const res = await fetch(`${API_BASE}/admin/tables`, { headers: authHeaders.value })
  if (res.ok) {
    tables.value = await res.json()
    if (tables.value.length)
      selectedTable.value = tables.value[0]!
  }
}

async function loadTable() {
  if (!selectedTable.value)
    return
  editingIndex.value = null
  insertDraft.value = null
  dbPage.value = 0
  loadingTable.value = true
  const res = await fetch(`${API_BASE}/admin/db/${selectedTable.value}`, { headers: authHeaders.value })
  if (res.ok) {
    const data = await res.json()
    tableRows.value = data.rows
    tablePks.value = data.pks ?? []
  }
  loadingTable.value = false
}

watch(selectedTable, loadTable)

// ── Delete ────────────────────────────────────────────────────────────────────
async function deleteRow(row: Row) {
  if (!props.canEdit)
    return
  if (!tablePks.value.length)
    return
  if (!window.confirm('确认删除这条记录？'))
    return
  const pk: Row = {}
  for (const col of tablePks.value) pk[col] = row[col]
  const res = await fetch(`${API_BASE}/admin/db/${selectedTable.value}`, {
    method: 'DELETE',
    headers: { ...authHeaders.value, 'Content-Type': 'application/json' },
    body: JSON.stringify(pk),
  })
  if (res.ok)
    tableRows.value = tableRows.value.filter(r => !tablePks.value.every(col => r[col] === row[col]))
}

// ── Edit ──────────────────────────────────────────────────────────────────────
function startEdit(localIndex: number) {
  if (!props.canEdit)
    return
  const globalIndex = dbPage.value * DB_PAGE_SIZE + localIndex
  editingIndex.value = globalIndex
  editDraft.value = { ...tableRows.value[globalIndex] }
  insertDraft.value = null
}

function cancelEdit() {
  editingIndex.value = null
}

async function saveEdit(row: Row) {
  if (!props.canEdit)
    return
  const pk: Row = {}
  for (const col of tablePks.value) pk[col] = row[col]
  const values: Row = {}
  for (const col of tableColumns.value) {
    if (!tablePks.value.includes(col))
      values[col] = editDraft.value[col]
  }
  const res = await fetch(`${API_BASE}/admin/db/${selectedTable.value}`, {
    method: 'PATCH',
    headers: { ...authHeaders.value, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pk, values }),
  })
  if (res.ok) {
    tableRows.value[editingIndex.value!] = { ...row, ...values }
    editingIndex.value = null
  }
}

// ── Insert ────────────────────────────────────────────────────────────────────
function startInsert() {
  if (!props.canEdit)
    return
  const template: Row = {}
  const cols = tableRows.value[0] ? Object.keys(tableRows.value[0]) : tablePks.value
  for (const col of cols) template[col] = ''
  insertDraft.value = template
  editingIndex.value = null
}

function cancelInsert() {
  insertDraft.value = null
}

async function saveInsert() {
  if (!props.canEdit || !insertDraft.value)
    return
  const res = await fetch(`${API_BASE}/admin/db/${selectedTable.value}`, {
    method: 'POST',
    headers: { ...authHeaders.value, 'Content-Type': 'application/json' },
    body: JSON.stringify(insertDraft.value),
  })
  if (res.ok) {
    insertDraft.value = null
    await loadTable()
  }
}

type ColType = 'boolean' | 'number' | 'text'

function colType(col: string): ColType {
  const sample = tableRows.value[0]?.[col]
  if (typeof sample === 'boolean')
    return 'boolean'
  if (typeof sample === 'number')
    return 'number'
  return 'text'
}

function cellValue(v: unknown) {
  if (v === null || v === undefined)
    return '—'
  if (typeof v === 'object')
    return JSON.stringify(v)
  return String(v)
}

onMounted(loadTables)
</script>

<template>
  <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
    <div class="flex items-center gap-2 px-4 py-2 border-b shrink-0 flex-wrap">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="outline" class="shrink-0 gap-1">
            {{ selectedTable }}
            <ChevronDown class="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup v-model="selectedTable">
            <DropdownMenuRadioItem
              v-for="table in tables"
              :key="table" :value="table"
            >
              {{ table }}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="sm" variant="outline" :disabled="loadingTable" @click="loadTable">
        <Spinner v-if="loadingTable" data-icon="inline-start" />
        刷新
      </Button>
      <Button v-if="canEdit" size="sm" variant="outline" @click="startInsert">
        + 新增
      </Button>
      <span class="text-xs text-muted-foreground">{{ tableRows.length }} 条</span>
      <div v-if="totalDbPages > 1" class="flex items-center gap-1 shrink-0">
        <Button variant="ghost" size="sm" :disabled="dbPage === 0" @click="dbPage--">‹</Button>
        <span class="text-xs text-muted-foreground">{{ dbPage + 1 }}/{{ totalDbPages }}</span>
        <Button variant="ghost" size="sm" :disabled="dbPage >= totalDbPages - 1" @click="dbPage++">›</Button>
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-auto">
      <table class="text-xs border-collapse min-w-max w-full">
        <thead class="sticky top-0 bg-background shadow-[0_1px_0_0_var(--border)]">
          <tr>
            <th
              v-for="col in tableColumns"
              :key="col"
              class="text-left px-3 py-2 font-medium border-r whitespace-nowrap"
              :class="tablePks.includes(col) ? 'text-primary' : 'text-muted-foreground'"
            >
              <span class="inline-flex items-center gap-1">
                {{ col }}
                <button
                  v-if="PASSWORD_PATTERN.test(col)"
                  class="opacity-50 hover:opacity-100"
                  @click="toggleColVisibility(col)"
                >
                  <EyeOff v-if="hiddenCols.has(col)" class="size-3" />
                  <Eye v-else class="size-3" />
                </button>
              </span>
            </th>
            <th v-if="canEdit" class="px-3 py-2 text-muted-foreground">
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          <!-- Insert row -->
          <tr v-if="insertDraft" class="border-b bg-muted/30">
            <td v-for="col in tableColumns" :key="col" class="px-2 py-1 border-r">
              <input
                v-if="colType(col) === 'boolean'"
                v-model="insertDraft[col] as boolean"
                type="checkbox"
                class="cursor-pointer block mx-auto"
              >
              <input
                v-else-if="colType(col) === 'number' || hiddenCols.has(col)"
                v-model="insertDraft[col] as string"
                :type="colType(col) === 'number' ? 'number' : 'password'"
                class="w-full bg-transparent border border-input rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-ring"
              >
              <textarea
                v-else
                v-model="insertDraft[col] as string"
                rows="2"
                class="w-full bg-transparent border border-input rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-ring resize-y min-w-40"
              />
            </td>
            <td v-if="canEdit" class="px-3 py-1.5 flex gap-3 items-center">
              <button class="text-xs text-green-600 hover:text-green-800 font-medium" @click="saveInsert">
                保存
              </button>
              <button class="text-xs text-muted-foreground hover:text-foreground" @click="cancelInsert">
                取消
              </button>
            </td>
          </tr>

          <!-- Data rows -->
          <tr
            v-for="(row, i) in pagedRows"
            :key="i"
            class="border-b hover:bg-muted/50"
            :class="{ 'bg-muted/20': editingIndex === dbPage * DB_PAGE_SIZE + i }"
          >
            <template v-if="editingIndex === dbPage * DB_PAGE_SIZE + i">
              <td v-for="col in tableColumns" :key="col" class="px-2 py-1 border-r">
                <template v-if="!tablePks.includes(col)">
                  <input
                    v-if="colType(col) === 'boolean'"
                    v-model="editDraft[col] as boolean"
                    type="checkbox"
                    class="cursor-pointer block mx-auto"
                  >
                  <input
                    v-else-if="colType(col) === 'number' || hiddenCols.has(col)"
                    v-model="editDraft[col] as string"
                    :type="colType(col) === 'number' ? 'number' : 'password'"
                    class="w-full bg-transparent border border-input rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-ring"
                  >
                  <textarea
                    v-else
                    v-model="editDraft[col] as string"
                    rows="2"
                    class="w-full bg-transparent border border-input rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-ring resize-y min-w-40"
                  />
                </template>
                <span v-else class="px-1 text-muted-foreground">{{ cellValue(row[col]) }}</span>
              </td>
              <td v-if="canEdit" class="px-3 py-1.5 flex gap-3 items-center">
                <button class="text-xs text-green-600 hover:text-green-800 font-medium" @click="saveEdit(row)">
                  保存
                </button>
                <button class="text-xs text-muted-foreground hover:text-foreground" @click="cancelEdit">
                  取消
                </button>
              </td>
            </template>
            <template v-else>
              <td
                v-for="col in tableColumns"
                :key="col"
                class="px-3 py-1.5 border-r max-w-60 truncate font-mono"
                :title="hiddenCols.has(col) ? '' : String(row[col] ?? '')"
              >
                <span v-if="hiddenCols.has(col)" class="tracking-widest text-muted-foreground">{{ '•'.repeat(12) }}</span>
                <template v-else>{{ cellValue(row[col]) }}</template>
              </td>
              <td v-if="canEdit" class="px-3 py-1.5 flex gap-3 items-center">
                <button class="text-xs text-blue-500 hover:text-blue-700" @click="startEdit(i)">
                  编辑
                </button>
                <button v-if="tablePks.length" class="text-xs text-red-500 hover:text-red-700" @click="deleteRow(row)">
                  删除
                </button>
              </td>
            </template>
          </tr>
        </tbody>
      </table>
      <div v-if="tableRows.length === 0 && !loadingTable && !insertDraft" class="text-muted-foreground py-8 text-center text-sm">
        暂无数据
      </div>
    </div>
  </div>
</template>
