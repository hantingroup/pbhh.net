import type { SQL } from 'drizzle-orm'
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { db, postLikes, posts, users } from 'server/database'
import { removeForDeletedPosts } from '../notification/service'
// 叶子模块，自己不 import 任何东西 —— 见 `rkey.ts` 顶部对「为什么单独成文件」的说明。
import { bskyPostUrl, isMirroredPost } from './rkey'

function query(where?: SQL, order: 'asc' | 'desc' = 'desc') {
  return db
    .select({
      id: posts.id,
      parentId: posts.parentId,
      title: posts.title,
      content: posts.content,
      username: posts.username,
      nickname: users.nickname,
      avatar: users.avatar,
      createdAt: posts.createdAt,
      atprotoUri: posts.atprotoUri,
      // 判来源靠这一列，不能靠 `atprotoUri` 的形态 —— 两个方向的 rkey 都是 TID。
      atprotoMirrored: posts.atprotoMirrored,
      likeCount: count(postLikes.username),
      replyCount: sql`(
        WITH RECURSIVE tree(id) AS (
          SELECT c.id FROM posts c WHERE c.parent_id = ${posts.id} AND c.deleted = 0
          UNION ALL
          SELECT p.id FROM posts p INNER JOIN tree ON p.parent_id = tree.id WHERE p.deleted = 0
        )
        SELECT COUNT(*) FROM tree
      )` as SQL<number>,
    })
    .from(posts)
    .leftJoin(users, eq(posts.username, users.username))
    .leftJoin(postLikes, eq(posts.id, postLikes.postId))
    .where(and(eq(posts.deleted, false), where))
    .groupBy(posts.id)
    .orderBy(order === 'asc' ? asc(posts.createdAt) : desc(posts.createdAt))
    .all()
}

function getLikedIds(viewerUsername?: string): Set<number> {
  if (!viewerUsername)
    return new Set()
  const rows = db
    .select({ postId: postLikes.postId })
    .from(postLikes)
    .where(eq(postLikes.username, viewerUsername))
    .all()
  return new Set(rows.map(r => r.postId))
}

type Row = ReturnType<typeof query>[number]
function toItem(row: Row, likedIds: Set<number>) {
  const isMirrored = isMirroredPost(row)
  return {
    id: row.id,
    parentId: row.parentId ?? undefined,
    title: row.title ?? undefined,
    content: row.content,
    username: row.username,
    nickname: row.nickname ?? '',
    avatar: row.avatar ?? '',
    createdAt: row.createdAt!.getTime(),
    /**
     * 这条帖是不是从 Bluesky 镜像来的，以及它的原帖地址。
     *
     * 判断放在服务端而不是把 `atprotoUri` 直接丢给前端：`pbhh-<id>` 那个约定、以及
     * 「哪一列才是判据」，让客户端去比字符串等于把服务端的不变量复制到第二个地方。
     *
     * `bskyUrl` 只有镜像帖才有 —— 本站发出去的帖虽然有 URI，但那是这里的内容，
     * 给一个「去 Bluesky 看」的链接只是把人绕一圈。
     */
    isMirrored,
    bskyUrl: isMirrored && row.atprotoUri ? bskyPostUrl(row.atprotoUri) : null,
    likeCount: row.likeCount,
    replyCount: row.replyCount,
    liked: likedIds.has(row.id),
  }
}

export function list(viewerUsername?: string, filterUsername?: string) {
  const rows = query(and(
    filterUsername ? undefined : isNull(posts.parentId),
    filterUsername ? eq(posts.username, filterUsername) : undefined,
  ))
  const likedIds = getLikedIds(viewerUsername)
  const items = rows.map(r => toItem(r, likedIds))

  if (!filterUsername)
    return items

  const parentIds = [...new Set(items.filter(i => i.parentId).map(i => i.parentId!))]
  if (!parentIds.length)
    return items

  const parentRows = db
    .select({ id: posts.id, content: posts.content, nickname: users.nickname })
    .from(posts)
    .leftJoin(users, eq(posts.username, users.username))
    .where(and(inArray(posts.id, parentIds), eq(posts.deleted, false)))
    .all()
  const parentMap = new Map(parentRows.map(r => [r.id, r]))

  return items.map((item) => {
    if (!item.parentId)
      return item
    const parent = parentMap.get(item.parentId)
    return {
      ...item,
      parentNickname: parent?.nickname ?? undefined,
      parentContent: parent?.content,
    }
  })
}

export function findRoot(id: number): number {
  let current = id
  while (true) {
    const row = db
      .select({ parentId: posts.parentId })
      .from(posts)
      .where(and(eq(posts.id, current), eq(posts.deleted, false)))
      .get()
    if (!row?.parentId)
      return current
    current = row.parentId
  }
}

export function get(id: number, viewerUsername?: string) {
  const row = query(eq(posts.id, id))[0]
  if (!row)
    return null
  return { ...toItem(row, getLikedIds(viewerUsername)), rootId: findRoot(id) }
}

export function listThread(rootId: number, viewerUsername?: string) {
  const treeIds = db.all<{ id: number }>(sql`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM ${posts} WHERE parent_id = ${rootId}
      UNION ALL
      SELECT p.id FROM ${posts} p INNER JOIN tree ON p.parent_id = tree.id
    )
    SELECT id FROM tree
  `).map(r => r.id)

  if (!treeIds.length)
    return []

  const likedIds = getLikedIds(viewerUsername)

  const rows = db
    .select({
      id: posts.id,
      parentId: posts.parentId,
      content: posts.content,
      username: posts.username,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .where(and(inArray(posts.id, treeIds), eq(posts.deleted, false)))
    .orderBy(asc(posts.createdAt))
    .all()

  const rootRow = db
    .select({
      id: posts.id,
      parentId: posts.parentId,
      content: posts.content,
      username: posts.username,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .where(and(eq(posts.id, rootId), eq(posts.deleted, false)))
    .get()

  const usernames = [...new Set([
    ...rows.map(r => r.username),
    ...(rootRow ? [rootRow.username] : []),
  ])]
  const userMap = new Map(
    db.select({
      username: users.username,
      nickname: users.nickname,
      avatar: users.avatar,
    })
      .from(users)
      .where(inArray(users.username, usernames))
      .all()
      .map(u => [u.username, u]),
  )

  const likeCountMap = new Map(
    db.select({ postId: postLikes.postId, n: count() })
      .from(postLikes)
      .where(inArray(postLikes.postId, treeIds))
      .groupBy(postLikes.postId)
      .all()
      .map(r => [r.postId, r.n]),
  )

  const postMap = new Map(rows.map(r => [r.id, r]))
  if (rootRow)
    postMap.set(rootId, rootRow)

  // Reorder rows by depth-first traversal so replies appear right after their parent
  const childrenMap = new Map<number, typeof rows>()
  for (const r of rows) {
    const pid = r.parentId!
    if (!childrenMap.has(pid))
      childrenMap.set(pid, [])
    childrenMap.get(pid)!.push(r)
  }
  function dfs(parentId: number): typeof rows {
    return (childrenMap.get(parentId) ?? []).flatMap(r => [r, ...dfs(r.id)])
  }
  const sorted = dfs(rootId)

  return sorted.map((r) => {
    const user = userMap.get(r.username)
    const parent = postMap.get(r.parentId!)
    const parentUser = parent ? userMap.get(parent.username) : undefined
    return {
      id: r.id,
      parentId: r.parentId!,
      content: r.content,
      username: r.username,
      nickname: user?.nickname ?? '',
      avatar: user?.avatar ?? '',
      createdAt: r.createdAt!.getTime(),
      likeCount: likeCountMap.get(r.id) ?? 0,
      liked: likedIds.has(r.id),
      parentUsername: parent?.username,
      parentNickname: parentUser?.nickname ?? undefined,
      parentContent: parent?.content,
    }
  })
}

export function listAncestors(id: number, viewerUsername?: string) {
  const ancestorIds = db.all<{ id: number }>(sql`
    WITH RECURSIVE anc(id, parent_id) AS (
      SELECT id, parent_id FROM ${posts} WHERE id = ${id}
      UNION ALL
      SELECT p.id, p.parent_id FROM ${posts} p INNER JOIN anc ON p.id = anc.parent_id
    )
    SELECT id FROM anc WHERE id != ${id}
  `).map(r => r.id)

  if (!ancestorIds.length)
    return []

  const likedIds = getLikedIds(viewerUsername)
  return query(inArray(posts.id, ancestorIds), 'asc').map(row => toItem(row, likedIds))
}

export function listReplies(parentId: number, viewerUsername?: string) {
  const rows = query(eq(posts.parentId, parentId), 'asc')
  return rows.map(r => toItem(r, getLikedIds(viewerUsername)))
}

export function create(username: string, content: string, title?: string, parentId?: number): number {
  const result = db.insert(posts).values({
    username,
    title: title || null,
    content,
    parentId: parentId ?? null,
  }).returning({ id: posts.id }).get()
  return result!.id
}

/** 一条需要连带从 Bluesky 删掉的本地帖。 */
export interface RemovablePost { id: number, atprotoUri: string }

export type RemoveResult =
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'ok', outbound: RemovablePost[] }

export function remove(id: number, username: string): RemoveResult {
  const post = db
    .select({ username: posts.username })
    .from(posts)
    .where(and(eq(posts.id, id), eq(posts.deleted, false)))
    .get()
  if (!post)
    return { status: 'not_found' }
  if (post.username !== username)
    return { status: 'forbidden' }
  const descendantIds = db.all<{ id: number }>(sql`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM ${posts} WHERE id = ${id}
      UNION ALL
      SELECT p.id FROM ${posts} p INNER JOIN tree ON p.parent_id = tree.id
    )
    SELECT id FROM tree
  `).map(r => r.id)

  /**
   * 挑出该连带从 Bluesky 删掉的行，**只挑发起删帖的人自己的**。
   *
   * 这里决不能用「所有后代」：上面的递归 CTE 会软删**别人**的回复，而那些回复是别人
   * 写在自己 repo 里的记录 —— 删不得。而 `atproto_uri IS NOT NULL` 的含义是「这条帖
   * 在 Bluesky 上有个对应记录」，`cid` 空也照样挑：那条 put 可能还在队列里（FIFO 保证
   * 它会先发出去再被删），也可能已经死了（删除会撞 `RecordNotFound`，按幂等算成功）。
   * 重复入队由 `atproto_outbox` 的 `(uri, kind)` 唯一索引吸收。
   */
  const outbound = db
    .select({ id: posts.id, atprotoUri: posts.atprotoUri })
    .from(posts)
    .where(and(
      inArray(posts.id, descendantIds),
      eq(posts.username, username),
      isNotNull(posts.atprotoUri),
    ))
    .all()
    .map(row => ({ id: row.id, atprotoUri: row.atprotoUri! }))

  db.update(posts).set({ deleted: true }).where(inArray(posts.id, descendantIds)).run()
  removeForDeletedPosts(descendantIds)
  return { status: 'ok', outbound }
}

/**
 * 判别的结果是**故意做成两个形状不同的分支**，不是 `{ liked: boolean, atprotoUri }`：
 * 后者会让人以为「点赞时也可能带出一个 uri」（实际恒为 null），从而在调用方写出永远
 * 走不到的分支。取消赞才需要交出一条记录的地址 —— 撤回它。
 */
export type ToggleLikeResult =
  | { liked: true }
  | { liked: false, retractedUri: string | null }

/**
 * 点赞 / 取消赞。`null` = 这条帖不存在或已删除（调用方回 404）。
 *
 * 整个过程放进**一个事务**：`select → delete/insert` 裸跑时并发双击会撞 `post_likes`
 * 的主键抛错（既有问题）；而且 `posts/index.ts` 紧接着要在 `mirrorLocalLike` 里
 * `update` 同一行，两次写之间那行会短暂处于「存在但 `atproto_uri` 为 NULL」的状态 ——
 * 那正是入站认领规则要分辨的形状，不能凭空造出来。
 *
 * `retractedUri` 取自被删掉的那一行，所以「在 Bluesky 官方客户端点的赞、回本站取消」
 * 也能正确撤回：那时它是一条 TID 地址，不是 `pbhh-like-`。
 */
export function toggleLike(postId: number, username: string): ToggleLikeResult | null {
  return db.transaction((tx) => {
    if (!tx
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.deleted, false)))
      .get()) {
      return null
    }
    const existing = tx
      .select({ atprotoUri: postLikes.atprotoUri })
      .from(postLikes)
      .where(and(eq(postLikes.postId, postId), eq(postLikes.username, username)))
      .get()
    if (existing) {
      tx
        .delete(postLikes)
        .where(and(eq(postLikes.postId, postId), eq(postLikes.username, username)))
        .run()
      return { liked: false, retractedUri: existing.atprotoUri }
    }
    tx.insert(postLikes).values({ postId, username }).run()
    return { liked: true }
  })
}
