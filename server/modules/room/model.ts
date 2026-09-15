import { t } from 'elysia'

// ── WS message types ──────────────────────────────────────────────────────────

/** Messages sent from client → server */
export interface ClientMessageMap {
  message: { content: string, replyToId?: number | null }
  ping: Record<string, never>
  game_start_fhl: { keyword: string, players: string[], timeoutMs: number }
  game_end_fhl: Record<string, never>
  game_invite_response: { accepted: boolean }
  game_vote_response: { valid: boolean }
  game_surrender: Record<string, never>
}

/** Messages sent from server → client */
export interface ServerMessageMap {
  message: {
    id: number
    username: string
    nickname: string
    avatar: string
    content: string
    createdAt: Date
    replyTo: null | {
      id: number
      username: string
      nickname: string
      avatar: string
      content: string
    }
  }
  join: { username: string }
  leave: { username: string }
  pong: Record<string, never>
  roster: { users: Array<{ username: string, nickname: string, avatar: string }>, observers: number }
  // 飞花令游戏事件
  game_invite: { keyword: string, host: string, hostNickname: string, players: string[], deadline: number }
  game_invite_progress: { username: string, accepted: boolean }
  game_invite_cancelled: { reason: 'no_players' }
  game_start: { keyword: string, players: string[], currentPlayer: string, turnDeadline: number, turnTimeoutMs: number }
  game_end: { reason: 'command' | 'winner', winner?: string }
  game_valid: { username: string, nextPlayer: string, turnDeadline: number }
  game_invalid: { username: string, nextPlayer: string | null, winner: string | null, turnDeadline: number | null, invalidReason?: 'timeout' | 'no_keyword' | 'duplicate' | 'invalid_poem', eliminated: boolean }
  game_duplicate: { username: string }
  game_vote: { username: string, content: string, voters: string[], deadline: number }
  game_vote_result: { valid: boolean, yesCount: number, noCount: number }
}

export type ClientMsg = { [K in keyof ClientMessageMap]: { type: K } & ClientMessageMap[K] }[keyof ClientMessageMap]

export interface RoomClient {
  username: string
  nickname: string
  avatar: string
  lastPing: number
  send: (data: string) => void
}

// ── Elysia schemas ────────────────────────────────────────────────────────────

export const roomNameBody = t.Object({ name: t.String({ minLength: 2, maxLength: 50 }) })

/** 凭据走 cookie（浏览器 `WebSocket` 设不了请求头），query 上没有东西要校验了。 */
export const wsQuery = t.Object({})
