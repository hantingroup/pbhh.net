import type { ClientMsg } from './model'
import process from 'node:process'
import { Elysia } from 'elysia'
import { requireAuth, usernameFromCredentials } from '../auth/guard'
import { jwtPlugin } from '../jwt'

import * as FeiHuaLing from './games/feihualing'
import { roomNameBody, wsQuery } from './model'
import * as RoomService from './service'

/**
 * 校验诗句是否为真实古诗文。
 * 返回 true=有效，false=无效，null=API 不可用（网络错误或超时）。
 */
export async function validatePoem(content: string): Promise<boolean | null> {
  try {
    const res = await fetch(
      `https://www.guwendao.net/search.aspx?value=${encodeURIComponent(content)}`,
      { headers: { Cookie: process.env.GUWENDAO_COOKIE ?? '' } },
    )
    if (!res.ok)
      return null
    const html = await res.text()
    return html.includes(`<span style="color:#A32A2A">`)
  }
  catch {
    return null
  }
}

// ── 投票逻辑 ──────────────────────────────────────────────────────────────────

const VOTE_TIMEOUT_MS = 15_000

function startVote(roomId: number, submitter: string, content: string, game: FeiHuaLing.FeiHuaLingState): Promise<boolean> {
  return new Promise((resolve) => {
    const voters = game.activePlayers.filter(p => p !== submitter)
    if (voters.length === 0) {
      resolve(true)
      return
    }

    const deadline = Date.now() + VOTE_TIMEOUT_MS
    const responses = new Map<string, boolean>()
    let timer: ReturnType<typeof setTimeout>

    const finalize = () => {
      clearTimeout(timer)
      RoomService.roomVotes.delete(roomId)
      const yes = [...responses.values()].filter(Boolean).length
      const no = responses.size - yes
      const valid = yes >= no
      RoomService.send(roomId, 'game_vote_result', { valid, yesCount: yes, noCount: no })
      resolve(valid)
    }

    timer = setTimeout(finalize, VOTE_TIMEOUT_MS)
    RoomService.roomVotes.set(roomId, { submitter, content, voters, responses, timer, finalize })
    RoomService.clearGameTimer(roomId)
    RoomService.send(roomId, 'game_vote', { username: submitter, content, voters, deadline })
  })
}

// ── 邀请逻辑 ──────────────────────────────────────────────────────────────────

const INVITE_TIMEOUT_MS = 10_000

function finalizeInvite(roomId: number) {
  const invite = RoomService.roomPendingInvites.get(roomId)
  if (!invite)
    return
  clearTimeout(invite.timer)
  RoomService.roomPendingInvites.delete(roomId)

  const accepted = invite.invitedPlayers.filter(p => invite.responses.get(p) === true)
  if (accepted.length < 2) {
    RoomService.send(roomId, 'game_invite_cancelled', { reason: 'no_players' })
    return
  }

  const gameState = FeiHuaLing.createGame(invite.keyword, accepted, invite.turnTimeoutMs)
  RoomService.roomGames.set(roomId, gameState)
  const deadline = scheduleTurn(roomId)
  RoomService.send(roomId, 'game_start', {
    keyword: gameState.keyword,
    players: gameState.activePlayers,
    currentPlayer: FeiHuaLing.currentPlayer(gameState),
    turnDeadline: deadline,
    turnTimeoutMs: invite.turnTimeoutMs,
  })
}

// ── 回合超时逻辑 ──────────────────────────────────────────────────────────────

/** 开始当前玩家的计时，返回 deadline（ms 时间戳） */
function scheduleTurn(roomId: number): number {
  RoomService.clearGameTimer(roomId)
  const timeout = RoomService.roomGames.get(roomId)?.turnTimeoutMs ?? RoomService.TURN_TIMEOUT_MS
  const deadline = Date.now() + timeout
  RoomService.roomTimers.set(roomId, setTimeout(() => onTurnTimeout(roomId), timeout))
  return deadline
}

/** 回合超时：自动淘汰当前玩家 */
function onTurnTimeout(roomId: number) {
  const game = RoomService.roomGames.get(roomId)
  if (!game)
    return

  const cp = FeiHuaLing.currentPlayer(game)
  const { result, newState } = FeiHuaLing.processMove(game, cp, '') // 空字符串 = 不含关键字 = 淘汰

  if (!result.isCurrentPlayer)
    return

  if (result.nextPlayer === null) {
    RoomService.roomGames.delete(roomId)
    RoomService.clearGameTimer(roomId)
    RoomService.send(roomId, 'game_end', { reason: 'winner', winner: result.winner ?? undefined })
  }
  else {
    RoomService.roomGames.set(roomId, newState)
    const deadline = scheduleTurn(roomId)
    RoomService.send(roomId, 'game_invalid', {
      username: cp,
      nextPlayer: result.nextPlayer,
      winner: result.winner,
      turnDeadline: deadline,
      invalidReason: result.invalidReason,
      eliminated: true,
    })
  }
}

// ── Elysia 路由 ───────────────────────────────────────────────────────────────

export default new Elysia({ prefix: '/rooms' })
  .use(jwtPlugin)

  .get('/', () => RoomService.listRooms())

  .ws('/ws/:roomId', {
    query: wsQuery,
    async open(ws) {
      const { roomId: roomIdStr } = ws.data.params
      const roomId = Number(roomIdStr)

      const [room] = await RoomService.findRoom(roomId)
      if (!room) {
        ws.close()
        return
      }

      // 凭据只来自 cookie —— 浏览器的 `WebSocket` 设不了请求头。
      // 拿不到（没登录、已过期、已登出）就**静默降级成只读观察者**，和过去 token
      // 无效时的行为一致。注意这条路的失败是无声的：cookie 一旦整体取不到，
      // 所有人都会变成观察者而不报错，排查时先看这里。
      const username = await usernameFromCredentials(ws.data.jwt, ws.data)
      if (!username) {
        if (!RoomService.roomObservers.has(roomId))
          RoomService.roomObservers.set(roomId, new Map())
        RoomService.roomObservers.get(roomId)!.set(ws.raw, data => ws.send(data))
        return
      }

      const [userInfo] = await RoomService.getUserInfo(username)

      if (!RoomService.roomClients.has(roomId))
        RoomService.roomClients.set(roomId, new Map())

      RoomService.roomClients.get(roomId)!.set(ws.raw, {
        username,
        nickname: userInfo?.nickname ?? username,
        avatar: userInfo?.avatar ?? '',
        lastPing: Date.now(),
        send: data => ws.send(data),
      })

      RoomService.broadcastRoster(roomId)
      RoomService.send(roomId, 'join', { username })
    },

    async message(ws, msg) {
      const { roomId: roomIdStr } = ws.data.params
      const roomId = Number(roomIdStr)
      const client = RoomService.roomClients.get(roomId)?.get(ws.raw)
      if (!client)
        return

      const clientMsg = msg as ClientMsg
      if (typeof clientMsg !== 'object' || clientMsg === null)
        return

      // ── 心跳 ────────────────────────────────────────────────────────────────

      if (clientMsg.type === 'ping') {
        client.lastPing = Date.now()
        client.send(JSON.stringify({ type: 'pong' }))
        return
      }

      // ── 飞花令指令 ────────────────────────────────────────────────────────────

      if (clientMsg.type === 'game_start_fhl') {
        const { keyword, players, timeoutMs } = clientMsg
        const timeout = Math.min(Math.max(timeoutMs ?? RoomService.TURN_TIMEOUT_MS, 5_000), 300_000)
        const kw = keyword?.trim()
        if (kw && players?.length && !RoomService.roomGames.has(roomId) && !RoomService.roomPendingInvites.has(roomId)) {
          const responses = new Map<string, boolean>([[client.username, true]])
          const timer = setTimeout(() => finalizeInvite(roomId), INVITE_TIMEOUT_MS)
          RoomService.roomPendingInvites.set(roomId, { keyword: kw, host: client.username, invitedPlayers: players, responses, timer, turnTimeoutMs: timeout })
          const [hostInfo] = await RoomService.getUserInfo(client.username)
          RoomService.send(roomId, 'game_invite', {
            keyword: kw,
            host: client.username,
            hostNickname: hostInfo?.nickname ?? client.username,
            players,
            deadline: Date.now() + INVITE_TIMEOUT_MS,
          })
          if (players.every(p => responses.has(p)))
            finalizeInvite(roomId)
        }
        return
      }

      if (clientMsg.type === 'game_invite_response') {
        const invite = RoomService.roomPendingInvites.get(roomId)
        if (invite && invite.invitedPlayers.includes(client.username) && !invite.responses.has(client.username)) {
          invite.responses.set(client.username, clientMsg.accepted)
          RoomService.send(roomId, 'game_invite_progress', { username: client.username, accepted: clientMsg.accepted })
          const total = invite.invitedPlayers.length
          const yes = [...invite.responses.values()].filter(Boolean).length
          const no = invite.responses.size - yes
          const half = Math.ceil(total / 2)
          if (yes >= half || no >= half || invite.invitedPlayers.every(p => invite.responses.has(p)))
            finalizeInvite(roomId)
        }
        return
      }

      if (clientMsg.type === 'game_vote_response') {
        const vote = RoomService.roomVotes.get(roomId)
        if (vote && vote.voters.includes(client.username) && !vote.responses.has(client.username)) {
          vote.responses.set(client.username, clientMsg.valid)
          const total = vote.voters.length
          const yes = [...vote.responses.values()].filter(Boolean).length
          const no = vote.responses.size - yes
          const half = Math.ceil(total / 2)
          if (yes >= half || no >= half || vote.voters.every(v => vote.responses.has(v)))
            vote.finalize()
        }
        return
      }

      if (clientMsg.type === 'game_surrender') {
        const surrenderGame = RoomService.roomGames.get(roomId)
        if (surrenderGame && FeiHuaLing.currentPlayer(surrenderGame) === client.username)
          onTurnTimeout(roomId)
        return
      }

      if (clientMsg.type === 'game_end_fhl') {
        if (RoomService.roomGames.has(roomId)) {
          RoomService.roomGames.delete(roomId)
          RoomService.clearGameTimer(roomId)
          RoomService.send(roomId, 'game_end', { reason: 'command' })
        }
        return
      }

      if (clientMsg.type !== 'message')
        return

      const rawContent = typeof clientMsg.content === 'string' ? clientMsg.content : ''
      const content = rawContent.trim()
      if (!content)
        return

      // ── 飞花令消息校验 ──────────────────────────────────────────────────────

      const game = RoomService.roomGames.get(roomId)
      if (game) {
        const { saved, userInfo, replyTo } = await RoomService.saveMessage(roomId, client.username, rawContent, clientMsg.replyToId)
        RoomService.send(roomId, 'message', {
          id: saved.id,
          username: client.username,
          nickname: userInfo?.nickname ?? client.username,
          avatar: userInfo?.avatar ?? '',
          content: saved.content,
          createdAt: saved.createdAt,
          replyTo,
        })

        // 不含关键字或重复诗句：仅作普通消息，当前玩家可继续作答
        if (FeiHuaLing.currentPlayer(game) !== client.username || !content.includes(game.keyword)) {
          return
        }
        if (game.usedLines.has(FeiHuaLing.normalize(content))) {
          RoomService.send(roomId, 'game_duplicate', { username: client.username })
          return
        }

        let { result, newState } = FeiHuaLing.processMove(game, client.username, content)

        if (result.isCurrentPlayer) {
          // 本地通过后，先用古文岛校验，无法判断时再发起投票
          if (result.valid) {
            const apiResult = await validatePoem(content)
            const isRealPoem = apiResult === null
              ? await startVote(roomId, client.username, content, game)
              : apiResult
            if (!isRealPoem) {
              const currentGame = RoomService.roomGames.get(roomId)
              if (!currentGame) {
                return
              }
              ;({ result, newState } = FeiHuaLing.skipCurrentTurn(currentGame, 'invalid_poem'))
            }
          }

          if (result.nextPlayer === null) {
            RoomService.roomGames.delete(roomId)
            RoomService.clearGameTimer(roomId)
            RoomService.send(roomId, 'game_end', { reason: 'winner', winner: result.winner ?? undefined })
          }
          else if (result.valid) {
            RoomService.roomGames.set(roomId, newState)
            const deadline = scheduleTurn(roomId)
            RoomService.send(roomId, 'game_valid', {
              username: client.username,
              nextPlayer: result.nextPlayer,
              turnDeadline: deadline,
            })
          }
          else {
            RoomService.roomGames.set(roomId, newState)
            const deadline = scheduleTurn(roomId)
            RoomService.send(roomId, 'game_invalid', {
              username: client.username,
              nextPlayer: result.nextPlayer,
              winner: result.winner,
              turnDeadline: deadline,
              invalidReason: result.invalidReason,
              eliminated: false,
            })
          }
        }
        return
      }

      // ── 普通消息 ────────────────────────────────────────────────────────────

      const { saved, userInfo, replyTo } = await RoomService.saveMessage(roomId, client.username, rawContent, clientMsg.replyToId)
      RoomService.send(roomId, 'message', {
        id: saved.id,
        username: client.username,
        nickname: userInfo?.nickname ?? client.username,
        avatar: userInfo?.avatar ?? '',
        content: saved.content,
        createdAt: saved.createdAt,
        replyTo,
      })
    },

    close(ws) {
      const { roomId: roomIdStr } = ws.data.params
      const roomId = Number(roomIdStr)
      RoomService.handleClientLeave(roomId, ws.raw)
      const observers = RoomService.roomObservers.get(roomId)
      if (observers) {
        observers.delete(ws.raw)
        if (observers.size === 0)
          RoomService.roomObservers.delete(roomId)
      }
    },
  })

  .use(requireAuth)

  .post('/', async ({ username, body }) => {
    const [room] = await RoomService.createRoom(username, body.name)
    return room!
  }, { body: roomNameBody })

  .get('/:id/messages', ({ params }) => RoomService.listMessages(Number(params.id)))

  .patch('/:id', async ({ username, params, body, status }) => {
    const roomId = Number(params.id)
    const [room] = await RoomService.findRoom(roomId)
    if (!room)
      return status(404, { message: 'error.notFound' })
    if (room.createdBy !== username)
      return status(403, { message: 'error.forbidden' })
    const [updated] = await RoomService.updateRoom(roomId, body.name)
    return updated!
  }, { body: roomNameBody })

  .delete('/:id', async ({ username, params, status }) => {
    const roomId = Number(params.id)
    const [room] = await RoomService.findRoom(roomId)
    if (!room)
      return status(404, { message: 'error.notFound' })
    if (room.createdBy !== username)
      return status(403, { message: 'error.forbidden' })
    await RoomService.deleteRoomMessages(roomId)
    await RoomService.deleteRoom(roomId)
    return { ok: true }
  })
