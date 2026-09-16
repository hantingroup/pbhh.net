import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bus } from '../events/bus'

export interface LogEntry {
  level: 'trace' | 'debug' | 'log' | 'info' | 'warn' | 'error'
  message: string
  timestamp: number
}

const MAX_LOGS = Number(Bun.env.MAX_LOGS) || 500
export const logBuffer: LogEntry[] = []
export const logListeners = new Set<(entry: LogEntry) => void>()

const dataDir = resolve(import.meta.dir, '../../../data')
const logsDir = resolve(dataDir, 'logs')

function getLogFile() {
  const date = new Date().toISOString().slice(0, 10)
  return resolve(logsDir, `${date}.log`)
}

// Load existing logs from today's file on startup
const todayFile = getLogFile()
if (existsSync(todayFile)) {
  try {
    const lines = readFileSync(todayFile, 'utf-8').split('\n').filter(Boolean)
    const entries = lines.map(line => JSON.parse(line))
    logBuffer.push(...entries.slice(-MAX_LOGS))
  }
  catch {}
}

function capture(level: LogEntry['level'], origin: (...args: unknown[]) => void) {
  return (...args: unknown[]) => {
    origin(...args)
    const message = args.map((arg) => {
      if (typeof arg === 'string')
        return arg
      if (arg instanceof Error)
        return `${arg.name}: ${arg.message}`
      return JSON.stringify(arg)
    }).join(' ')
    const entry: LogEntry = { level, message, timestamp: Date.now() }
    if (logBuffer.length >= MAX_LOGS)
      logBuffer.shift()
    logBuffer.push(entry)
    for (const fn of logListeners)
      fn(entry)
    try {
      // Create the directory actually written to. This used to create `dataDir` while
      // writing to `logs/` under it, so the missing subdirectory threw ENOENT into the
      // catch below: the live tail worked, history was silently always empty.
      if (!existsSync(logsDir))
        mkdirSync(logsDir, { recursive: true })
      appendFileSync(getLogFile(), `${JSON.stringify(entry)}\n`)
    }
    catch {}
  }
}

console.trace = capture('trace', console.trace.bind(console))
console.debug = capture('debug', console.debug.bind(console))
console.log = capture('log', console.log.bind(console))
console.info = capture('info', console.info.bind(console))
console.warn = capture('warn', console.warn.bind(console))
console.error = capture('error', console.error.bind(console))

export function getLogDates(): string[] {
  // Used to scan `dataDir` for `server-*.log` — the old directory *and* the old naming,
  // so it always returned empty and the history page never offered a date.
  if (!existsSync(logsDir))
    return []
  return readdirSync(logsDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .map(f => f.slice(0, 10))
    .sort()
    .reverse()
}

export function readLogsByDate(date: string): LogEntry[] {
  const file = resolve(logsDir, `${date}.log`)
  if (!existsSync(file))
    return []
  try {
    return readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
  }
  catch {
    return []
  }
}

bus.on('event', (event: { topic: string, payload: unknown }) => {
  console.info(`[event] ${event.topic}`, event.payload)
})
