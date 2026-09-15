import type { Capability, SignUpBody, UpdateProfileBody, UserProfile } from './model'
import bcrypt from 'bcryptjs'
import { eq, sql } from 'drizzle-orm'
import { db, userCapabilities, users } from 'server/database'
import { RESERVED_LABELS } from '../atproto/config'
import { hasCapability } from './capability'

/**
 * 用户名比较一律走 `lower()`：用户名保留显示大小写（`BeiDou`），但 `beidou` 是
 * 同一个人的写法。`users_username_lower_idx` 既提供唯一性，也是这条查询的索引。
 */
function sameUsername(input: string) {
  return sql`lower(${users.username}) = lower(${input})`
}

/**
 * 返回值必须带上**库里那一行** —— `index.ts` 用 `user.username` 签 JWT，`sub`
 * 因此是存储形式，下游十几处 `eq(users.username, ...)` 才不用跟着改。
 */
export async function verify(username: string, password: string) {
  const user = db.select().from(users).where(sameUsername(username)).get()
  if (user && await bcrypt.compare(password, user.password)) {
    return user
  }
}

export type CreateResult =
  | { ok: true, username: string }
  | { ok: false, reason: 'taken' | 'reserved' }

export async function create({ username, nickname, password }: SignUpBody): Promise<CreateResult> {
  // 字符规则由注册 schema 的正则保证；保留字表正则表达不了，只能在代码里查。
  // 这不是洁癖：这些名字都有真实 nginx vhost，而精确 server_name 压过通配 ——
  // 用户叫 `api` 会让他的 `api.pbhh.net` DID 端点被 api vhost 吃掉。
  if (RESERVED_LABELS.has(username.toLowerCase()))
    return { ok: false, reason: 'reserved' }

  const existing = db.select({ username: users.username }).from(users).where(sameUsername(username)).get()
  if (existing)
    return { ok: false, reason: 'taken' }

  try {
    db.insert(users).values({
      username,
      nickname,
      password: await bcrypt.hash(password, 8),
    }).run()
  }
  catch {
    // 预检与插入之间仍有并发窗口，唯一索引是最终防线。没有这个 catch 的话上面
    // 那行会抛未捕获的 SqliteError，前端拿到 500 而不是「用户名已存在」。
    return { ok: false, reason: 'taken' }
  }
  return { ok: true, username }
}

/** 大小写不敏感；返回的 `username` 是**存储形式**，可直接用作规范名。 */
export function getByUsername(username: string): UserProfile | undefined {
  return db.select({
    username: users.username,
    nickname: users.nickname,
    avatar: users.avatar,
  }).from(users).where(sameUsername(username)).get()
}

/**
 * 把来自 URL / 查询参数的用户名归一成存储形式。经 JWT `sub` 来的已经是规范形式，
 * 不用过这一道；需要的是路径参数与 `?username=` 这类用户可自由拼写的入口。
 */
export function resolveUsername(input: string): string | undefined {
  return db
    .select({ username: users.username })
    .from(users)
    .where(sameUsername(input))
    .get()
    ?.username
}

export async function update(username: string, data: UpdateProfileBody) {
  db.update(users).set({
    ...(data.nickname !== undefined && { nickname: data.nickname }),
    ...(data.avatar !== undefined && { avatar: data.avatar }),
  }).where(eq(users.username, username)).run()
  return getByUsername(username)
}

export function getCapabilities(username: string): Capability[] {
  return db
    .select({ capability: userCapabilities.capability })
    .from(userCapabilities)
    .where(eq(userCapabilities.username, username))
    .all()
    .map(row => row.capability) as Capability[]
}

export function userHasCapability(username: string, capability: Capability) {
  return hasCapability(getCapabilities(username), capability)
}

/** JWT 里 `ver` 要比对的那一列；用户不存在时返回 undefined（= 不一致）。 */
export function getTokenVersion(username: string) {
  return db
    .select({ tokenVersion: users.tokenVersion })
    .from(users)
    .where(eq(users.username, username))
    .get()
    ?.tokenVersion
}

/**
 * 登出：把版本号 +1，该用户**所有**已签发的 token 立刻失效。
 *
 * 这是「登出所有设备」的语义 —— 手机上点登出，桌面也会掉线。换按设备撤销要存会话表，
 * 这里刻意没那么做。也正因为是单调递增的计数器，重复调用无害。
 */
export function bumpTokenVersion(username: string) {
  db.update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.username, username))
    .run()
}
