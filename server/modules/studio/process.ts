import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'

/**
 * 服务端那个 drizzle-kit studio 进程。
 *
 * 它只提供 API（`POST /`），前端另外从 local.drizzle.studio 取（见 ui.ts）。默认按需
 * 自动拉起：管理员打开 /admin/database 时如果 4983 没人应答，这里把它拉起来再等就绪。
 *
 * 服务器上没装 mkcert，drizzle-kit 拿不到证书，所以它监听的是**明文 http**。装了
 * mkcert 的话它会改成 https 自签，代理那边会连不上——DRIZZLE_STUDIO_URL 是出口。
 */

const serverRoot = resolve(import.meta.dir, '../..')
const STUDIO_HOST = '127.0.0.1'
const STUDIO_PORT = 4983

/** 显式给了地址就当成外部托管，本模块只管转发、不 spawn。 */
export const STUDIO_ORIGIN = Bun.env.DRIZZLE_STUDIO_URL ?? `http://${STUDIO_HOST}:${STUDIO_PORT}`
const AUTO_SPAWN = !Bun.env.DRIZZLE_STUDIO_URL

const BUN_EXECUTABLE = Bun.which('bun') || 'bun'
const MAX_OUTPUT_LINES = 40
const PROBE_TIMEOUT_MS = 1500
const READY_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 300
/** 前端在轮询 /status，失败后不能每次都重新 spawn —— 否则会一秒拉起一个进程。 */
const RETRY_COOLDOWN_MS = 15_000

export interface StudioStatus {
  ready: boolean
  status: 'idle' | 'starting' | 'running' | 'failed'
  pid: number | null
  lastOutput: string[]
  error: string | null
}

const state = {
  status: 'idle' as StudioStatus['status'],
  pid: null as number | null,
  lastOutput: [] as string[],
  error: null as string | null,
}

function pushOutput(line: string) {
  const trimmed = line.trim()
  if (!trimmed)
    return

  state.lastOutput.push(trimmed)
  if (state.lastOutput.length > MAX_OUTPUT_LINES)
    state.lastOutput.shift()
}

export function getStudioStatus(): StudioStatus {
  return {
    ready: state.status === 'running',
    status: state.status,
    pid: state.pid,
    lastOutput: [...state.lastOutput],
    error: state.error,
  }
}

/**
 * studio 只认 `POST /`，GET 会拿到 404 —— 那是「活着」，不是「没起来」。
 * 所以判据是能不能拿到**任何** HTTP 响应，只有连不上（ECONNREFUSED）才算没起来。
 */
async function probe() {
  try {
    await fetch(STUDIO_ORIGIN, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return true
  }
  catch {
    return false
  }
}

/** 启动中的那一轮，用来去重：并发请求不该拉起好几个 studio。 */
let booting: Promise<boolean> | null = null

export async function ensureStudioRunning(): Promise<boolean> {
  if (await probe()) {
    state.status = 'running'
    state.error = null
    return true
  }

  if (!AUTO_SPAWN) {
    state.status = 'failed'
    state.error ??= `连不上 ${STUDIO_ORIGIN}`
    return false
  }

  if (!booting)
    booting = boot().finally(() => { booting = null })

  return booting
}

let failedAt = 0

async function boot(): Promise<boolean> {
  if (!state.pid) {
    // 上一轮 spawn 的进程可能还在启动，别重复拉；刚失败过则先等冷却。
    if (Date.now() - failedAt < RETRY_COOLDOWN_MS) {
      state.status = 'failed'
      return false
    }
    spawnStudio()
  }

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await probe()) {
      state.status = 'running'
      state.error = null
      return true
    }
    // 进程自己退了（端口被占、schema 加载失败…），再等也没有意义。
    if (!state.pid)
      break
    await Bun.sleep(POLL_INTERVAL_MS)
  }

  failedAt = Date.now()
  state.status = 'failed'
  state.error ??= `drizzle studio 在 ${READY_TIMEOUT_MS / 1000}s 内没有就绪`
  return false
}

function spawnStudio() {
  state.status = 'starting'
  state.error = null
  state.lastOutput = []

  const child = spawn(
    BUN_EXECUTABLE,
    ['x', 'drizzle-kit', 'studio', '--host', STUDIO_HOST, '--port', String(STUDIO_PORT)],
    {
      cwd: serverRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    },
  )

  state.pid = child.pid ?? null

  const pipe = (stream: NodeJS.ReadableStream | null, level: 'info' | 'warn') => {
    if (!stream)
      return

    let pending = ''
    stream.on('data', (chunk) => {
      pending += chunk.toString()
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''

      for (const line of lines) {
        pushOutput(line)
        if (level === 'warn')
          console.warn(`[studio] ${line}`)
        else
          console.info(`[studio] ${line}`)
      }
    })
  }

  pipe(child.stdout, 'info')
  pipe(child.stderr, 'warn')

  child.on('error', (error) => {
    state.status = 'failed'
    state.pid = null
    state.error = error.message
    pushOutput(`[spawn error] ${error.message}`)
    console.error('[studio] spawn failed', error)
  })

  child.on('exit', (code, signal) => {
    state.pid = null
    if (state.status === 'running' || state.status === 'starting')
      state.status = code === 0 ? 'idle' : 'failed'
    if (code !== 0 && !state.error)
      state.error = `drizzle studio 退出：code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`
  })

  child.unref()
  console.info('[studio] spawned drizzle-kit studio', { pid: child.pid, cwd: serverRoot })
}
