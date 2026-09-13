<script setup lang="ts">
import type { ServerMessageMap } from 'server/modules/room/model'
import { ArrowLeft, Flag, Send, Swords, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Translation, useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import UserAvatar from '@/components/UserAvatar.vue'
import { api, API_BASE, user } from '@/lib/api'
import { makeReplyPreview, renderRoomMessageHtml } from '@/lib/roomMessage'
import NotFound from '@/views/NotFound.vue'

const props = defineProps<{ id: number }>()
const router = useRouter()

interface ReplyPreview {
  id: number
  username: string
  nickname: string
  avatar: string
  content: string
}

interface Message {
  id: number
  username: string
  nickname: string
  avatar: string
  content: string
  contentHtml: string
  createdAt: number | string | Date
  replyTo: ReplyPreview | null
}

interface SystemEvent {
  type: 'join' | 'leave'
  username: string
}

interface GameEvent {
  event: 'invite' | 'invite_cancelled' | 'start' | 'end' | 'valid' | 'invalid' | 'vote' | 'vote_result' | 'duplicate'
  keyword?: string
  host?: string
  hostNickname?: string
  players?: string[]
  currentPlayer?: string
  username?: string
  nextPlayer?: string | null
  winner?: string | null
  reason?: 'command' | 'winner' | 'no_players'
  invalidReason?: 'timeout' | 'no_keyword' | 'duplicate' | 'invalid_poem'
  eliminated?: boolean
  content?: string
  voters?: string[]
  yesCount?: number
  noCount?: number
}

interface PendingInvite {
  keyword: string
  host: string
  hostNickname: string
  players: string[]
  deadline: number
}

interface GameState {
  keyword: string
  activePlayers: string[]
  currentPlayer: string
  turnTimeoutMs: number
}

interface OnlineUser {
  username: string
  nickname: string
  avatar: string
}

interface RoomSummary {
  id: number
  name: string
}

interface ComposerCompletion {
  key: string
  label: string
  detail: string
  insertText: string
}

type ChatEntry =
  | { kind: 'message', data: Message }
  | { kind: 'system', data: SystemEvent }
  | { kind: 'game', data: GameEvent }

const { t } = useI18n()
const entries = ref<ChatEntry[]>([])
const draft = ref('')
const poemDraft = ref('')
const rooms = ref<RoomSummary[]>([])
const roomName = ref(t('room.unnamed', { id: props.id }))
const roomNotFound = ref(false)
const onlineUsers = ref<Map<string, OnlineUser>>(new Map())
const observerCount = ref(0)
const gameState = ref<GameState | null>(null)
const pendingInvite = ref<PendingInvite | null>(null)
const inviteMyResponse = ref<boolean | null>(null)
const inviteResponses = ref<Map<string, boolean>>(new Map())
const activeVote = ref<{ username: string, content: string, voters: string[], deadline: number } | null>(null)
const voteMyResponse = ref<boolean | null>(null)
const voteCountdown = ref(0)
let voteCountdownInterval: ReturnType<typeof setInterval> | null = null
const countdown = ref(0)
const inviteCountdown = ref(0)
const bottomEl = ref<HTMLElement | null>(null)
const showStartPanel = ref(false)
const keywordDraft = ref('')
const timeoutSecs = ref(30)
const selectedPlayers = ref<Set<string>>(new Set())
const draftComposerRef = ref<InstanceType<typeof Textarea> | null>(null)
const poemComposerRef = ref<InstanceType<typeof Textarea> | null>(null)
const replyTarget = ref<Message | null>(null)
const composerCursor = ref(0)
const contextMenu = ref<{ x: number, y: number, message: Message } | null>(null)
const contextMenuRef = ref<HTMLElement | null>(null)
const swipeMessageId = ref<number | null>(null)
const swipeOffset = ref(0)
let longPressTimer: ReturnType<typeof setTimeout> | null = null
let suppressNextWindowClick = false
let touchGesture: {
  message: Message
  startX: number
  startY: number
  replyTriggered: boolean
} | null = null
let ws: WebSocket | null = null
let pingInterval: ReturnType<typeof setInterval> | null = null
let countdownInterval: ReturnType<typeof setInterval> | null = null
let inviteCountdownInterval: ReturnType<typeof setInterval> | null = null

const roomMentionOptions = computed(() =>
  rooms.value.map(room => ({ id: room.id, name: room.name })),
)

watch(showStartPanel, (val) => {
  if (val)
    selectedPlayers.value = new Set(onlineUsers.value.keys())
})

function getTextareaElement(instance: InstanceType<typeof Textarea> | null) {
  const element = instance?.$el
  return element instanceof HTMLTextAreaElement ? element : null
}

function isPoemComposerActive() {
  return !!(gameState.value && gameState.value.currentPlayer === user.value?.username)
}

function getActiveComposerRef() {
  return isPoemComposerActive() ? poemComposerRef.value : draftComposerRef.value
}

function getActiveComposerValue() {
  return isPoemComposerActive() ? poemDraft.value : draft.value
}

function setActiveComposerValue(value: string) {
  if (isPoemComposerActive())
    poemDraft.value = value
  else
    draft.value = value
}

function focusComposer() {
  const element = getTextareaElement(getActiveComposerRef())
  if (!element)
    return
  element.focus()
}

function updateComposerCursor() {
  const element = getTextareaElement(getActiveComposerRef())
  composerCursor.value = element?.selectionStart ?? getActiveComposerValue().length
}

function closeContextMenu() {
  contextMenu.value = null
}

function handleWindowPointerDown(event: PointerEvent) {
  const target = event.target
  if (contextMenuRef.value && target instanceof Node && contextMenuRef.value.contains(target))
    return
  closeContextMenu()
}

function handleWindowClick() {
  if (!suppressNextWindowClick)
    return
  suppressNextWindowClick = false
}

function rememberComposerCursor() {
  nextTick(() => updateComposerCursor())
}

function insertTextAtCursor(insertText: string, start?: number, end?: number) {
  const element = getTextareaElement(getActiveComposerRef())
  const value = getActiveComposerValue()
  const rangeStart = start ?? element?.selectionStart ?? value.length
  const rangeEnd = end ?? element?.selectionEnd ?? rangeStart
  const nextValue = `${value.slice(0, rangeStart)}${insertText}${value.slice(rangeEnd)}`
  setActiveComposerValue(nextValue)
  nextTick(() => {
    const target = getTextareaElement(getActiveComposerRef())
    if (!target)
      return
    const cursor = rangeStart + insertText.length
    target.focus()
    target.setSelectionRange(cursor, cursor)
    composerCursor.value = cursor
  })
}

function mentionUser(username: string) {
  insertTextAtCursor(`@${username}@ `)
  closeContextMenu()
}

function setReplyTarget(message: Message) {
  replyTarget.value = message
  closeContextMenu()
  suppressNextWindowClick = true
  nextTick(() => focusComposer())
}

function clearReplyTarget() {
  replyTarget.value = null
}

function scrollToMessage(messageId: number) {
  const element = document.getElementById(`room-message-${messageId}`)
  if (!element)
    return
  element.scrollIntoView({ behavior: 'smooth', block: 'center' })
  element.classList.add('ring-2', 'ring-primary')
  setTimeout(() => element.classList.remove('ring-2', 'ring-primary'), 1200)
}

function startLongPress(action: () => void) {
  clearLongPress()
  longPressTimer = setTimeout(action, 420)
}

function clearLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function resetTouchGesture() {
  clearLongPress()
  touchGesture = null
  swipeMessageId.value = null
  swipeOffset.value = 0
}

function handleMessageContextMenu(event: MouseEvent, message: Message) {
  event.preventDefault()
  contextMenu.value = { x: event.clientX, y: event.clientY, message }
}

function handleMessagePointerDown(event: PointerEvent, message: Message) {
  if (event.pointerType === 'mouse')
    return
  touchGesture = {
    message,
    startX: event.clientX,
    startY: event.clientY,
    replyTriggered: false,
  }
  startLongPress(() => {
    suppressNextWindowClick = true
    contextMenu.value = { x: event.clientX, y: event.clientY, message }
    touchGesture = null
  })
}

function handleMessagePointerMove(event: PointerEvent, message: Message) {
  if (event.pointerType === 'mouse' || !touchGesture || touchGesture.message.id !== message.id)
    return

  const deltaX = event.clientX - touchGesture.startX
  const deltaY = event.clientY - touchGesture.startY

  if (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8)
    clearLongPress()

  if (deltaX < -10 && Math.abs(deltaX) > Math.abs(deltaY)) {
    swipeMessageId.value = message.id
    swipeOffset.value = Math.max(-72, deltaX)

    if (deltaX <= -72 && !touchGesture.replyTriggered) {
      touchGesture.replyTriggered = true
      setReplyTarget(message)
    }
  }
}

function handleMessagePointerEnd() {
  resetTouchGesture()
}

function handleMessageTouchStart(event: TouchEvent, message: Message) {
  const touch = event.touches[0]
  if (!touch)
    return
  touchGesture = {
    message,
    startX: touch.clientX,
    startY: touch.clientY,
    replyTriggered: false,
  }
  startLongPress(() => {
    suppressNextWindowClick = true
    contextMenu.value = { x: touch.clientX, y: touch.clientY, message }
    touchGesture = null
  })
}

function handleMessageTouchMove(event: TouchEvent, message: Message) {
  if (!touchGesture || touchGesture.message.id !== message.id)
    return

  const touch = event.touches[0]
  if (!touch)
    return

  const deltaX = touch.clientX - touchGesture.startX
  const deltaY = touch.clientY - touchGesture.startY

  if (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8)
    clearLongPress()

  if (deltaX < -10 && Math.abs(deltaX) > Math.abs(deltaY)) {
    if (event.cancelable)
      event.preventDefault()
    swipeMessageId.value = message.id
    swipeOffset.value = Math.max(-72, deltaX)

    if (deltaX <= -72 && !touchGesture.replyTriggered) {
      touchGesture.replyTriggered = true
      setReplyTarget(message)
    }
  }
}

function handleMessageTouchEnd() {
  resetTouchGesture()
}

function handleAvatarPointerDown(event: PointerEvent, username: string) {
  if (event.pointerType === 'mouse')
    return
  startLongPress(() => {
    suppressNextWindowClick = true
    mentionUser(username)
  })
}

type ComposerTrigger =
  | { type: 'user', query: string, start: number, end: number }
  | { type: 'room', query: string, start: number, end: number }

function getComposerTrigger(): ComposerTrigger | null {
  const value = getActiveComposerValue()
  const cursor = composerCursor.value
  const beforeCursor = value.slice(0, cursor)
  const userMatch = /(?:^|[\s(])@([\w-]*)$/.exec(beforeCursor)
  if (userMatch) {
    const query = userMatch[1] ?? ''
    return {
      type: 'user',
      query,
      start: cursor - query.length - 1,
      end: cursor,
    }
  }

  const roomMatch = /(?:^|[\s(])#(\d*)$/.exec(beforeCursor)
  if (roomMatch) {
    const query = roomMatch[1] ?? ''
    return {
      type: 'room',
      query,
      start: cursor - query.length - 1,
      end: cursor,
    }
  }

  return null
}

const composerTrigger = computed(() => getComposerTrigger())
const composerCompletions = computed<ComposerCompletion[]>(() => {
  const trigger = composerTrigger.value
  if (!trigger)
    return []

  if (trigger.type === 'user') {
    const query = trigger.query.trim().toLowerCase()
    return [...onlineUsers.value.values()]
      .filter(member => !query || member.username.toLowerCase().includes(query) || member.nickname.toLowerCase().includes(query))
      .slice(0, 8)
      .map(member => ({
        key: `user:${member.username}`,
        label: member.nickname || member.username,
        detail: `@${member.username}@`,
        insertText: `@${member.username}@ `,
      }))
  }

  const query = trigger.query.trim()
  return rooms.value
    .filter(room => !query || String(room.id).startsWith(query) || room.name.includes(query))
    .slice(0, 8)
    .map(room => ({
      key: `room:${room.id}`,
      label: room.name || `房间 ${room.id}`,
      detail: `#${room.id}#`,
      insertText: `#${room.id}# `,
    }))
})

function applyComposerCompletion(item: ComposerCompletion) {
  const trigger = composerTrigger.value
  if (!trigger)
    return
  insertTextAtCursor(item.insertText, trigger.start, trigger.end)
}

function decorateMessage(data: Omit<Message, 'contentHtml'>): Message {
  return {
    ...data,
    contentHtml: renderRoomMessageHtml(data.content ?? '', roomMentionOptions.value),
  }
}

function scrollToBottom() {
  nextTick(() => bottomEl.value?.scrollIntoView({ behavior: 'instant' }))
}

function startCountdown(deadline: number) {
  if (countdownInterval)
    clearInterval(countdownInterval)
  const tick = () => {
    countdown.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
  }
  tick()
  countdownInterval = setInterval(tick, 200)
}

function clearCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval)
    countdownInterval = null
  }
  countdown.value = 0
}

function startInviteCountdown(deadline: number) {
  if (inviteCountdownInterval)
    clearInterval(inviteCountdownInterval)
  const tick = () => {
    inviteCountdown.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
  }
  tick()
  inviteCountdownInterval = setInterval(tick, 200)
}

function clearInviteCountdown() {
  if (inviteCountdownInterval) {
    clearInterval(inviteCountdownInterval)
    inviteCountdownInterval = null
  }
  inviteCountdown.value = 0
}

function startVoteCountdown(deadline: number) {
  if (voteCountdownInterval)
    clearInterval(voteCountdownInterval)
  const tick = () => {
    voteCountdown.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
  }
  tick()
  voteCountdownInterval = setInterval(tick, 200)
}

function clearVoteCountdown() {
  if (voteCountdownInterval) {
    clearInterval(voteCountdownInterval)
    voteCountdownInterval = null
  }
  voteCountdown.value = 0
}

const handlers = {
  message(data) {
    entries.value.push({
      kind: 'message',
      data: decorateMessage(data),
    })
    scrollToBottom()
  },
  join({ username }) {
    entries.value.push({ kind: 'system', data: { type: 'join', username } })
  },
  leave({ username }) {
    entries.value.push({ kind: 'system', data: { type: 'leave', username } })
  },
  pong() {},
  game_vote(data) {
    activeVote.value = data
    voteMyResponse.value = null
    startVoteCountdown(data.deadline)
    entries.value.push({ kind: 'game', data: { event: 'vote', ...data } })
    scrollToBottom()
  },
  game_vote_result(data) {
    activeVote.value = null
    clearVoteCountdown()
    entries.value.push({ kind: 'game', data: { event: 'vote_result', ...data } })
    scrollToBottom()
  },
  game_duplicate(data) {
    entries.value.push({ kind: 'game', data: { event: 'duplicate', username: data.username } })
    scrollToBottom()
  },
  game_invite(data) {
    pendingInvite.value = data
    inviteMyResponse.value = null
    inviteResponses.value = new Map([[data.host, true]])
    startInviteCountdown(data.deadline)
    entries.value.push({ kind: 'game', data: { event: 'invite', ...data } })
    scrollToBottom()
  },
  game_invite_progress(data) {
    inviteResponses.value = new Map(inviteResponses.value).set(data.username, data.accepted)
  },
  game_invite_cancelled(data) {
    pendingInvite.value = null
    clearInviteCountdown()
    entries.value.push({ kind: 'game', data: { event: 'invite_cancelled', ...data } })
    scrollToBottom()
  },
  roster({ users, observers }) {
    const map = new Map<string, OnlineUser>()
    for (const u of users)
      map.set(u.username, u)
    onlineUsers.value = map
    observerCount.value = observers
  },
  game_start(data) {
    pendingInvite.value = null
    clearInviteCountdown()
    gameState.value = { keyword: data.keyword, activePlayers: data.players, currentPlayer: data.currentPlayer, turnTimeoutMs: data.turnTimeoutMs }
    startCountdown(data.turnDeadline)
    poemDraft.value = ''
    entries.value.push({ kind: 'game', data: { event: 'start', ...data } })
    scrollToBottom()
  },
  game_end(data) {
    gameState.value = null
    clearCountdown()
    entries.value.push({ kind: 'game', data: { event: 'end', ...data } })
    scrollToBottom()
  },
  game_valid(data) {
    if (gameState.value)
      gameState.value.currentPlayer = data.nextPlayer
    startCountdown(data.turnDeadline)
    poemDraft.value = ''
    entries.value.push({ kind: 'game', data: { event: 'valid', ...data } })
    scrollToBottom()
  },
  game_invalid(data) {
    if (gameState.value) {
      if (data.eliminated)
        gameState.value.activePlayers = gameState.value.activePlayers.filter(p => p !== data.username)
      gameState.value.currentPlayer = data.nextPlayer ?? ''
    }
    if (data.turnDeadline !== null)
      startCountdown(data.turnDeadline)
    else
      clearCountdown()
    poemDraft.value = ''
    entries.value.push({ kind: 'game', data: { event: 'invalid', ...data } })
    scrollToBottom()
  },
} satisfies {
  [K in keyof ServerMessageMap]: (msg: ServerMessageMap[K]) => void
}

async function loadRoom() {
  roomNotFound.value = false
  const token = localStorage.getItem('token') ?? ''

  const { data: roomList } = await api.rooms.get()
  if (roomList) {
    rooms.value = roomList
    const room = roomList.find(r => r.id === props.id)
    if (!room) {
      roomNotFound.value = true
      return
    }
    roomName.value = room.name
  }

  const { data: msgs } = await api.rooms({ id: String(props.id) }).messages.get()
  if (msgs) {
    entries.value = (msgs as Omit<Message, 'contentHtml'>[]).map(m => ({
      kind: 'message',
      data: decorateMessage(m),
    }))
    scrollToBottom()
  }

  const origin = API_BASE.replace(/^http/, 'ws')
  ws = new WebSocket(`${origin}/rooms/ws/${props.id}?token=${encodeURIComponent(token)}`)

  ws.onopen = () => {
    pingInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'ping' }))
    }, 30_000)
  }

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type in handlers)
      handlers[msg.type as keyof ServerMessageMap](msg)
  }

  ws.onclose = () => {
    ws = null
  }
}

function sendMessage(content: string) {
  if (!content || !ws || ws.readyState !== WebSocket.OPEN)
    return
  ws.send(JSON.stringify({ type: 'message', content, replyToId: replyTarget.value?.id ?? null }))
  replyTarget.value = null
}

function send() {
  const content = draft.value
  if (!content.trim())
    return
  sendMessage(content)
  draft.value = ''
}

function submitPoem() {
  const content = poemDraft.value
  if (!content.trim() || !ws || ws.readyState !== WebSocket.OPEN)
    return
  if (gameState.value?.currentPlayer !== user.value?.username)
    return
  sendMessage(content)
  poemDraft.value = ''
}

function startGame() {
  const kw = keywordDraft.value.trim()
  const players = [...selectedPlayers.value]
  if (!kw || players.length === 0 || !ws || ws.readyState !== WebSocket.OPEN)
    return
  ws.send(JSON.stringify({ type: 'game_start_fhl', keyword: kw, players, timeoutMs: timeoutSecs.value * 1000 }))
  keywordDraft.value = ''
  showStartPanel.value = false
}

function togglePlayer(username: string) {
  const s = new Set(selectedPlayers.value)
  s.has(username) ? s.delete(username) : s.add(username)
  selectedPlayers.value = s
}

function formatTime(val: number | string | Date) {
  const d = val instanceof Date ? val : new Date(typeof val === 'number' ? val * 1000 : val)
  const now = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString())
    return time
  if (d.getFullYear() === now.getFullYear())
    return `${d.toLocaleDateString([], { month: '2-digit', day: '2-digit' })} ${time}`
  return `${d.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' })} ${time}`
}

function getUserProfileLink(username: string) {
  const normalizedUsername = username.trim()
  return normalizedUsername ? `/@${normalizedUsername}` : ''
}

function gameEventText(entry: GameEvent): string {
  switch (entry.event) {
    case 'start':
      return t('room.game.fhl.start', {
        keyword: entry.keyword,
        players: entry.players?.join('、'),
        player: entry.currentPlayer,
      })
    case 'end':
      return entry.reason === 'winner' && entry.winner
        ? t('room.game.fhl.endWinner', { winner: entry.winner })
        : t('room.game.fhl.endCommand')
    case 'valid':
      return t('room.game.fhl.valid', { username: entry.username, next: entry.nextPlayer })
    case 'invalid': {
      const reasonKey = entry.invalidReason === 'duplicate'
        ? 'duplicate'
        : entry.invalidReason === 'timeout'
          ? 'timeout'
          : entry.invalidReason === 'invalid_poem'
            ? 'invalidPoem'
            : 'noKeyword'
      const reason = t(`room.game.fhl.reason.${reasonKey}`)
      return entry.nextPlayer === null
        ? t('room.game.fhl.invalidGameOver', { username: entry.username, winner: entry.winner ?? '—', reason })
        : t('room.game.fhl.invalid', { username: entry.username, next: entry.nextPlayer, reason })
    }
    case 'duplicate':
      return t('room.game.fhl.duplicateEvent', { username: entry.username })
    case 'invite':
      return t('room.game.fhl.inviteEvent', { host: entry.hostNickname ?? entry.host, keyword: entry.keyword })
    case 'invite_cancelled':
      return t('room.game.fhl.cancelledEvent')
    case 'vote':
      return t('room.game.fhl.voteEvent', { content: entry.content })
    case 'vote_result':
      return entry.yesCount !== undefined && entry.noCount !== undefined
        ? entry.yesCount >= entry.noCount
          ? t('room.game.fhl.voteValid', { yes: entry.yesCount, no: entry.noCount })
          : t('room.game.fhl.voteInvalid', { yes: entry.yesCount, no: entry.noCount })
        : ''
    default:
      return ''
  }
}

function respondInvite(accepted: boolean) {
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return
  inviteMyResponse.value = accepted
  ws.send(JSON.stringify({ type: 'game_invite_response', accepted }))
}

function surrender() {
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return
  ws.send(JSON.stringify({ type: 'game_surrender' }))
}

function respondVote(valid: boolean) {
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return
  voteMyResponse.value = valid
  ws.send(JSON.stringify({ type: 'game_vote_response', valid }))
}

function cleanupRoomConnection() {
  closeContextMenu()
  resetTouchGesture()
  clearCountdown()
  clearInviteCountdown()
  clearVoteCountdown()
  if (pingInterval) {
    clearInterval(pingInterval)
    pingInterval = null
  }
  ws?.close()
  ws = null
}

onMounted(() => {
  window.addEventListener('pointerdown', handleWindowPointerDown)
  window.addEventListener('click', handleWindowClick)
  window.addEventListener('resize', closeContextMenu)
  loadRoom()
})
watch(() => props.id, () => {
  cleanupRoomConnection()
  entries.value = []
  draft.value = ''
  poemDraft.value = ''
  replyTarget.value = null
  loadRoom()
})
onUnmounted(() => {
  window.removeEventListener('pointerdown', handleWindowPointerDown)
  window.removeEventListener('click', handleWindowClick)
  window.removeEventListener('resize', closeContextMenu)
  cleanupRoomConnection()
})
</script>

<template>
  <NotFound v-if="roomNotFound" />
  <div v-else class="relative border-x w-full max-w-2xl mx-auto flex flex-col" style="height: calc(100vh - 4rem)">
    <!-- Header -->
    <div class="flex items-center gap-3 px-4 py-3 border-b shrink-0">
      <button class="text-muted-foreground hover:text-foreground" @click="router.push('/rooms')">
        <ArrowLeft class="size-5" />
      </button>
      <span class="font-semibold text-lg flex-1">{{ roomName }}</span>
      <span class="text-xs text-muted-foreground mr-1">
        {{ t('room.online', { count: onlineUsers.size }) }}
        <span v-if="observerCount > 0"> · {{ t('room.observers', { count: observerCount }) }}</span>
      </span>
      <Button
        v-if="user && !gameState && !pendingInvite"
        variant="ghost"
        size="sm"
        class="gap-1.5 text-amber-600 hover:text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40"
        @click="showStartPanel = !showStartPanel"
      >
        <Swords class="size-4" />
        {{ t('room.game.fhl.btnStart') }}
      </Button>
    </div>

    <!-- 飞花令邀请横幅 -->
    <div v-if="pendingInvite && !gameState" class="px-4 py-3 border-b bg-amber-50 dark:bg-amber-950/30 shrink-0">
      <div class="flex items-center justify-between gap-3">
        <div class="text-sm text-amber-800 dark:text-amber-200 min-w-0">
          <span v-if="pendingInvite.host === user?.username">
            {{ t('room.game.fhl.waitingInvites') }}
          </span>
          <span v-else-if="pendingInvite.players.includes(user?.username ?? '')">
            {{ t('room.game.fhl.inviteBanner', { host: pendingInvite.hostNickname, keyword: pendingInvite.keyword }) }}
          </span>
          <span v-else>
            {{ t('room.game.fhl.inviteEvent', { host: pendingInvite.hostNickname, keyword: pendingInvite.keyword }) }}
          </span>
          <div class="flex flex-wrap gap-1.5 mt-1.5">
            <template v-for="p in pendingInvite.players" :key="p">
              <span
                v-if="inviteResponses.get(p) !== false"
                class="text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 transition-opacity"
                :class="inviteResponses.has(p) ? 'opacity-100' : 'opacity-40'"
              >{{ onlineUsers.get(p)?.nickname ?? p }}</span>
            </template>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="tabular-nums font-mono text-xs font-semibold" :class="inviteCountdown <= 3 ? 'text-red-500' : 'text-amber-600 dark:text-amber-400'">
            {{ inviteCountdown }}s
          </span>
          <template v-if="pendingInvite.host !== user?.username && pendingInvite.players.includes(user?.username ?? '')">
            <template v-if="inviteMyResponse === null">
              <Button size="sm" class="h-7 text-xs" @click="respondInvite(true)">
                {{ t('room.game.fhl.accept') }}
              </Button>
              <Button size="sm" variant="outline" class="h-7 text-xs" @click="respondInvite(false)">
                {{ t('room.game.fhl.decline') }}
              </Button>
            </template>
            <span v-else class="text-xs font-medium" :class="inviteMyResponse ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'">
              {{ inviteMyResponse ? t('room.game.fhl.accepted') : t('room.game.fhl.declined') }}
            </span>
          </template>
        </div>
      </div>
    </div>

    <!-- 飞花令投票横幅 -->
    <div v-if="activeVote" class="px-4 py-3 border-b bg-blue-50 dark:bg-blue-950/30 shrink-0">
      <div class="flex items-center justify-between gap-3">
        <div class="text-sm text-blue-800 dark:text-blue-200 min-w-0 truncate">
          {{ t('room.game.fhl.voteBanner', { content: activeVote.content, username: activeVote.username }) }}
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="tabular-nums font-mono text-xs font-semibold" :class="voteCountdown <= 3 ? 'text-red-500' : 'text-blue-600 dark:text-blue-400'">
            {{ voteCountdown }}s
          </span>
          <template v-if="activeVote.voters.includes(user?.username ?? '')">
            <template v-if="voteMyResponse === null">
              <Button size="sm" class="h-7 text-xs" @click="respondVote(true)">
                {{ t('room.game.fhl.voteYes') }}
              </Button>
              <Button size="sm" variant="outline" class="h-7 text-xs" @click="respondVote(false)">
                {{ t('room.game.fhl.voteNo') }}
              </Button>
            </template>
            <span v-else class="text-xs font-medium" :class="voteMyResponse ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'">
              {{ voteMyResponse ? t('room.game.fhl.voteYesed') : t('room.game.fhl.voteNoed') }}
            </span>
          </template>
        </div>
      </div>
    </div>

    <!-- 飞花令启动面板 -->
    <div v-if="showStartPanel && !gameState && !pendingInvite" class="px-4 py-3 border-b bg-amber-50 dark:bg-amber-950/30 shrink-0 space-y-2.5">
      <p class="text-xs text-amber-700 dark:text-amber-300">
        {{ t('room.game.fhl.startPanelHint') }}
      </p>
      <div class="flex gap-2">
        <Input
          v-model="keywordDraft"
          :placeholder="t('room.game.fhl.keywordPlaceholder')"
          class="flex-1 h-8 text-sm"
          maxlength="4"
          @keydown.enter.prevent="startGame"
        />
        <Button size="sm" class="h-8" :disabled="!keywordDraft.trim() || selectedPlayers.size === 0" @click="startGame">
          {{ t('room.game.fhl.startConfirm') }}
        </Button>
        <Button size="sm" variant="ghost" class="h-8" @click="showStartPanel = false">
          {{ t('common.cancel') }}
        </Button>
      </div>
      <!-- 每轮限时 -->
      <div class="flex items-center gap-2">
        <span class="text-xs text-amber-700 dark:text-amber-300 shrink-0">{{ t('room.game.fhl.timeoutLabel') }}</span>
        <div class="flex gap-1">
          <button
            v-for="s in [15, 30, 60]"
            :key="s"
            class="text-xs px-2 py-0.5 rounded-full border transition-colors"
            :class="timeoutSecs === s
              ? ['bg-amber-500', 'border-amber-500', 'text-white']
              : ['border-amber-300', 'text-amber-700', 'dark:border-amber-600', 'dark:text-amber-400', 'hover:bg-amber-100', 'dark:hover:bg-amber-900/40']"
            @click="timeoutSecs = s"
          >
            {{ s }}s
          </button>
        </div>
        <input
          v-model.number="timeoutSecs"
          type="number"
          min="5"
          max="300"
          class="w-16 h-7 rounded-md border border-input bg-background px-2 text-xs tabular-nums"
        >
      </div>
      <div class="space-y-1">
        <p class="text-xs font-medium text-amber-700 dark:text-amber-300">
          {{ t('room.game.fhl.selectPlayers') }}
        </p>
        <div class="flex flex-wrap gap-2">
          <label
            v-for="u in onlineUsers.values()"
            :key="u.username"
            class="flex items-center gap-1.5 cursor-pointer select-none rounded-full px-2.5 py-1 text-xs border transition-colors"
            :class="selectedPlayers.has(u.username)
              ? 'bg-amber-200 border-amber-400 text-amber-800 dark:bg-amber-800/50 dark:border-amber-600 dark:text-amber-200'
              : 'bg-white border-border text-muted-foreground dark:bg-background'"
          >
            <input type="checkbox" class="hidden" :checked="selectedPlayers.has(u.username)" @change="togglePlayer(u.username)">
            <UserAvatar :username="u.username" :nickname="u.nickname" :avatar="u.avatar" size="size-4" />
            {{ u.nickname || u.username }}
          </label>
        </div>
      </div>
    </div>

    <!-- 飞花令游戏状态横幅 -->
    <div v-if="gameState" class="px-4 pt-2 pb-1.5 border-b bg-amber-50 dark:bg-amber-950/30 shrink-0">
      <div class="flex items-center justify-between text-sm mb-1.5">
        <span class="font-medium text-amber-700 dark:text-amber-300">
          {{ t('room.game.fhl.banner', { keyword: gameState.keyword }) }}
        </span>
        <div class="flex items-center gap-3">
          <span
            class="tabular-nums font-mono text-xs font-semibold"
            :class="countdown <= 10 ? 'text-red-500 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'"
          >
            {{ countdown }}s
          </span>
          <span class="text-amber-600 dark:text-amber-400 text-xs">
            {{ t('room.game.fhl.currentTurn', { player: gameState.currentPlayer }) }}
          </span>
        </div>
      </div>
      <!-- 进度条 -->
      <div class="h-1 rounded-full bg-amber-200 dark:bg-amber-900 overflow-hidden">
        <div
          class="h-full rounded-full transition-none"
          :class="countdown <= 10 ? 'bg-red-500' : 'bg-amber-500'"
          :style="{ width: `${Math.min(100, countdown / (gameState.turnTimeoutMs / 1000) * 100)}%` }"
        />
      </div>
    </div>

    <!-- Messages -->
    <ScrollArea class="flex-1">
      <div class="px-4 py-3 space-y-3">
        <div v-for="(entry, i) in entries" :key="i">
          <!-- System event -->
          <div v-if="entry.kind === 'system'" class="text-center text-xs text-muted-foreground py-1">
            {{ entry.data.username }} {{ entry.data.type === 'join' ? $t('room.joined') : $t('room.left') }}
          </div>

          <!-- Game event -->
          <div
            v-else-if="entry.kind === 'game'"
            class="text-center text-xs py-1.5 px-3 rounded-full mx-auto w-fit"
            :class="{
              'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300': entry.data.event === 'start' || entry.data.event === 'invite',
              'bg-muted text-muted-foreground': entry.data.event === 'end' || entry.data.event === 'invite_cancelled',
              'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300': entry.data.event === 'valid' || entry.data.event === 'vote_result' && (entry.data.yesCount ?? 0) >= (entry.data.noCount ?? 0),
              'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300': entry.data.event === 'invalid' || entry.data.event === 'vote_result' && (entry.data.yesCount ?? 0) < (entry.data.noCount ?? 0),
              'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300': entry.data.event === 'vote',
            }"
          >
            {{ gameEventText(entry.data) }}
          </div>

          <!-- Chat message -->
          <div
            v-else
            :id="`room-message-${entry.data.id}`"
            class="flex gap-2 transition-transform duration-150 ease-out"
            :class="entry.data.username === user?.username ? 'flex-row-reverse' : 'flex-row'"
            :style="swipeMessageId === entry.data.id ? { transform: `translateX(${swipeOffset}px)` } : undefined"
            @contextmenu="handleMessageContextMenu($event, entry.data)"
            @pointerdown="handleMessagePointerDown($event, entry.data)"
            @pointermove="handleMessagePointerMove($event, entry.data)"
            @pointerup="handleMessagePointerEnd"
            @pointerleave="handleMessagePointerEnd"
            @pointercancel="handleMessagePointerEnd"
          >
            <component
              :is="getUserProfileLink(entry.data.username) ? RouterLink : 'span'"
              :to="getUserProfileLink(entry.data.username)"
              class="shrink-0 mt-0.5"
              @contextmenu.prevent.stop="mentionUser(entry.data.username)"
              @pointerdown.stop="handleAvatarPointerDown($event, entry.data.username)"
              @pointerup.stop="clearLongPress"
              @pointerleave.stop="clearLongPress"
              @pointercancel.stop="clearLongPress"
            >
              <UserAvatar
                :username="entry.data.username"
                :nickname="entry.data.nickname"
                :avatar="entry.data.avatar"
                size="size-8"
              />
            </component>
            <div
              class="flex flex-col gap-0.5 max-w-[70%]"
              :class="entry.data.username === user?.username ? 'items-end' : 'items-start'"
            >
              <span class="text-xs text-muted-foreground px-1">
                <component
                  :is="getUserProfileLink(entry.data.username) ? RouterLink : 'span'"
                  :to="getUserProfileLink(entry.data.username)"
                  class="font-medium text-foreground/80"
                  :class="getUserProfileLink(entry.data.username) ? 'hover:underline underline-offset-4' : ''"
                >
                  {{ entry.data.nickname }}
                </component>
                <!-- <span class="opacity-50">@{{ entry.data.username }}</span> -->
                <span class="ml-1">{{ formatTime(entry.data.createdAt) }}</span>
              </span>
              <div
                class="rounded-2xl px-3 py-2 text-sm wrap-break-word select-none transition-transform duration-150 ease-out md:select-text [-webkit-touch-callout:none] [touch-action:pan-y]"
                :class="entry.data.username === user?.username
                  ? 'bg-primary text-primary-foreground rounded-tr-sm'
                  : 'bg-muted rounded-tl-sm'"
                @touchstart="handleMessageTouchStart($event, entry.data)"
                @touchmove="handleMessageTouchMove($event, entry.data)"
                @touchend="handleMessageTouchEnd"
                @touchcancel="handleMessageTouchEnd"
              >
                <button
                  v-if="entry.data.replyTo"
                  type="button"
                  class="mb-2 block w-full rounded-xl border border-border/70 bg-background/70 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-background"
                  @click="scrollToMessage(entry.data.replyTo.id)"
                >
                  <div class="font-medium text-foreground/80">
                    回复 {{ entry.data.replyTo.nickname }}
                  </div>
                  <div class="truncate">
                    {{ makeReplyPreview(entry.data.replyTo.content) }}
                  </div>
                </button>
                <div
                  class="prose prose-sm max-w-none text-inherit **:text-inherit [&_p]:whitespace-pre-wrap prose-p:my-0 prose-pre:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 dark:prose-invert"
                  v-html="entry.data.contentHtml"
                />
              </div>
            </div>
          </div>
        </div>
        <div ref="bottomEl" class="-mt-2" />
      </div>
    </ScrollArea>

    <!-- 飞花令诗句输入区（轮到自己时） -->
    <div
      v-if="gameState && gameState.currentPlayer === user?.username"
      class="relative border-t px-4 py-3 shrink-0 bg-amber-50/60 dark:bg-amber-950/20"
    >
      <div class="text-xs mb-2 text-amber-700 dark:text-amber-400">
        {{ t('room.game.fhl.yourTurnHint', { keyword: gameState.keyword }) }}
      </div>
      <div
        v-if="replyTarget"
        class="mb-2 flex items-start justify-between gap-3 rounded-xl border border-amber-200/80 bg-background/80 px-3 py-2 text-xs"
      >
        <div class="min-w-0">
          <div class="font-medium text-foreground/80">
            回复 {{ replyTarget.nickname }}
          </div>
          <div class="truncate text-muted-foreground">
            {{ makeReplyPreview(replyTarget.content) }}
          </div>
        </div>
        <button
          type="button"
          class="text-muted-foreground transition-colors hover:text-foreground"
          aria-label="dismiss reply"
          @click="clearReplyTarget"
        >
          <X class="size-4" />
        </button>
      </div>
      <div
        v-if="composerCompletions.length"
        class="absolute bottom-full left-4 right-4 z-30 mb-2 overflow-hidden rounded-2xl border bg-popover shadow-lg"
      >
        <button
          v-for="item in composerCompletions"
          :key="item.key"
          type="button"
          class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
          @mousedown.prevent="applyComposerCompletion(item)"
        >
          <span class="min-w-0 truncate font-medium">{{ item.label }}</span>
          <span class="shrink-0 text-xs text-muted-foreground">{{ item.detail }}</span>
        </button>
      </div>
      <div class="flex gap-2 items-end">
        <Textarea
          ref="poemComposerRef"
          v-model="poemDraft"
          :placeholder="t('room.game.fhl.poemPlaceholder', { keyword: gameState.keyword })"
          rows="1"
          class="flex-1 resize-none max-h-32 transition-colors border-amber-400 focus-visible:ring-amber-400"
          @keydown.enter.exact.prevent="submitPoem"
          @input="rememberComposerCursor"
          @click="rememberComposerCursor"
          @keyup="rememberComposerCursor"
          @select="rememberComposerCursor"
        />
        <Button
          size="sm"
          :disabled="!poemDraft.trim()"
          @click="submitPoem"
        >
          <Send class="size-4" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          class="text-muted-foreground hover:text-destructive"
          :title="t('room.game.fhl.surrender')"
          @click="surrender"
        >
          <Flag class="size-4" />
        </Button>
      </div>
    </div>

    <!-- 普通输入区（无游戏时，或游戏中非当前选手） -->
    <div v-else-if="user" class="relative border-t px-4 py-3 shrink-0">
      <div
        v-if="replyTarget"
        class="mb-2 flex items-start justify-between gap-3 rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs"
      >
        <div class="min-w-0">
          <div class="font-medium text-foreground/80">
            回复 {{ replyTarget.nickname }}
          </div>
          <div class="truncate text-muted-foreground">
            {{ makeReplyPreview(replyTarget.content) }}
          </div>
        </div>
        <button
          type="button"
          class="text-muted-foreground transition-colors hover:text-foreground"
          aria-label="dismiss reply"
          @click="clearReplyTarget"
        >
          <X class="size-4" />
        </button>
      </div>

      <div
        v-if="composerCompletions.length"
        class="absolute bottom-full left-4 right-4 z-30 mb-2 overflow-hidden rounded-2xl border bg-popover shadow-lg"
      >
        <button
          v-for="item in composerCompletions"
          :key="item.key"
          type="button"
          class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
          @mousedown.prevent="applyComposerCompletion(item)"
        >
          <span class="min-w-0 truncate font-medium">{{ item.label }}</span>
          <span class="shrink-0 text-xs text-muted-foreground">{{ item.detail }}</span>
        </button>
      </div>

      <div class="flex gap-2 items-end">
        <Textarea
          ref="draftComposerRef"
          v-model="draft"
          :placeholder="$t('room.messagePlaceholder')"
          rows="1"
          class="flex-1 resize-none max-h-32"
          @keydown.enter.exact.prevent="send"
          @input="rememberComposerCursor"
          @click="rememberComposerCursor"
          @keyup="rememberComposerCursor"
          @select="rememberComposerCursor"
        />
        <Button :disabled="!draft.trim()" size="sm" @click="send">
          <Send class="size-4" />
        </Button>
      </div>
    </div>

    <!-- 未登录提示 -->
    <div v-else class="border-t px-4 py-3 shrink-0 text-center text-sm text-muted-foreground">
      <Translation keypath="room.loginRequired">
        <template #login>
          <RouterLink to="/login" class="link">{{ t('home.loginLink') }}</RouterLink>
        </template>
      </Translation>
    </div>

    <div
      v-if="contextMenu"
      ref="contextMenuRef"
      class="fixed z-50 min-w-36 overflow-hidden rounded-xl border bg-popover shadow-lg"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
    >
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
        @click="setReplyTarget(contextMenu.message)"
      >
        回复消息
      </button>
    </div>
  </div>
</template>
