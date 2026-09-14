import { eq, sql } from 'drizzle-orm'
import { atprotoIdentities, atprotoOutbox, db } from 'server/database'
import { labelFromHost } from './config'

export interface AtprotoIdentity {
  username: string
  did: string
  handle: string
  pdsUrl: string
  publishEnabled: boolean
  /**
   * 是否把用户**在 Bluesky 上点的赞**同步进来。**刻意不覆盖入站帖子** —— 帖子的镜像
   * 至今没有开关（见 schema 里的同名注释）。读路径 `jetstream.ts` 只该用它闸住 like。
   */
  syncLikesEnabled: boolean
}

export function getIdentity(username: string): AtprotoIdentity | undefined {
  return db
    .select()
    .from(atprotoIdentities)
    .where(eq(atprotoIdentities.username, username))
    .get()
}

export function getIdentityByDid(did: string): AtprotoIdentity | undefined {
  return db
    .select()
    .from(atprotoIdentities)
    .where(eq(atprotoIdentities.did, did))
    .get()
}

/** JetStream 的连接级 `dids` 参数就是这一串。 */
export function getBoundDids(): string[] {
  return db.select({ did: atprotoIdentities.did }).from(atprotoIdentities).all().map(r => r.did)
}

/**
 * `/.well-known/atproto-did` 的查询：Host → 子域标签 → DID。
 *
 * 标签**就是用户名**（降为小写），没有单独的认领步骤 —— 用户注册时选的名字即
 * 他的 handle。所以这里查的是 `lower(username)`；未绑定 atproto 身份的账号查不到
 * 行，返回 undefined 走 404，不会漏出任何东西。
 */
export function getDidForHost(host: string | undefined): string | undefined {
  const label = labelFromHost(host)
  if (!label)
    return undefined
  const row = db
    .select({ did: atprotoIdentities.did })
    .from(atprotoIdentities)
    .where(sql`lower(${atprotoIdentities.username}) = ${label}`)
    .get()
  return row?.did
}

export type BindResult =
  | { ok: true, identity: AtprotoIdentity }
  | { ok: false, reason: 'didTakenByOther' | 'handleTakenByOther' }

export function bindIdentity(input: {
  username: string
  did: string
  handle: string
  pdsUrl: string
}): BindResult {
  // did 是全局唯一的：同一个 DID 不能同时挂在两个本地账号上。handle 相反——
  // 见 schema 里的说明，我们这份 handle 只是副本，不加唯一约束。
  const existing = getIdentityByDid(input.did)
  if (existing && existing.username !== input.username)
    return { ok: false, reason: 'didTakenByOther' }

  const identity = db.insert(atprotoIdentities)
    .values(input)
    .onConflictDoUpdate({
      target: atprotoIdentities.username,
      set: { did: input.did, handle: input.handle, pdsUrl: input.pdsUrl },
    })
    .returning()
    .get()

  return { ok: true, identity }
}

export function unbindIdentity(username: string): string | undefined {
  const identity = getIdentity(username)
  if (!identity)
    return undefined
  db.transaction((tx) => {
    // 未投递的出站行必须一起清掉，且**与身份删除在同一个事务里**：已解绑的仓库
    // 不可投递（`revokeSession` 会把会话一起撤销），而那些行按 `username` 只在这里
    // 有唯一一次清理机会 —— 一旦身份行没了就再也找不到它们，worker 只会一遍遍
    // `restore` 失败直到标记 dead。
    tx.delete(atprotoOutbox).where(eq(atprotoOutbox.username, username)).run()
    tx.delete(atprotoIdentities).where(eq(atprotoIdentities.username, username)).run()
  })
  // **不清 `posts.atproto_uri` / `atproto_cid`**：URI 是历史事实，留着让重绑后旧帖的
  // 去重依然有效，也仍然能正确镜像「用户在 Bluesky 删掉了旧帖」。
  return identity.did
}

/**
 * 设置页的「把这里的帖子同步发到 Bluesky」开关。返回 false = 这个用户没绑定。
 *
 * 用 `returning()` 而不是 `run()` 的 `changes`：bun:sqlite 驱动下后者的类型是
 * `void`，拿不到影响行数。
 */
export function setPublishEnabled(username: string, publishEnabled: boolean): boolean {
  const row = db.update(atprotoIdentities)
    .set({ publishEnabled })
    .where(eq(atprotoIdentities.username, username))
    .returning({ username: atprotoIdentities.username })
    .get()
  return !!row
}

/**
 * 设置页的「把我在 Bluesky 点的赞同步进来」开关。返回 false = 这个用户没绑定。
 *
 * 与 `setPublishEnabled` 分成两个函数而不是合成一个 `updateSettings`：两个开关方向
 * 相反（一个出站一个新入站），调用点也分属两个路由字段，合起来只会让「哪些字段是
 * 可选的、缺省时保持原值」这层逻辑散在参数默认值里。
 */
export function setSyncLikesEnabled(username: string, syncLikesEnabled: boolean): boolean {
  const row = db.update(atprotoIdentities)
    .set({ syncLikesEnabled })
    .where(eq(atprotoIdentities.username, username))
    .returning({ username: atprotoIdentities.username })
    .get()
  return !!row
}

/** 更新最后观测到的 handle（用户可能在别处改过）。 */
export function updateObservedHandle(username: string, handle: string): void {
  db.update(atprotoIdentities)
    .set({ handle })
    .where(eq(atprotoIdentities.username, username))
    .run()
}
