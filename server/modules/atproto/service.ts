import { eq, sql } from 'drizzle-orm'
import { atprotoIdentities, db } from 'server/database'
import { labelFromHost } from './config'

export interface AtprotoIdentity {
  username: string
  did: string
  handle: string
  pdsUrl: string
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
  db.delete(atprotoIdentities).where(eq(atprotoIdentities.username, username)).run()
  return identity.did
}

/** 更新最后观测到的 handle（用户可能在别处改过）。 */
export function updateObservedHandle(username: string, handle: string): void {
  db.update(atprotoIdentities)
    .set({ handle })
    .where(eq(atprotoIdentities.username, username))
    .run()
}
