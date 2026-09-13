import type { AppEvent, AppEventMap } from '../events/bus'
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { db, emails, notifications, posts, userBindings, users } from 'server/database'
import { bus } from '../events/bus'
import { deliverToUser } from '../events/deliver'
import * as FollowService from '../follow/service'
import { isPrefEnabled } from './prefs'

function getActor(username: string) {
  return db
    .select({ nickname: users.nickname, avatar: users.avatar })
    .from(users)
    .where(eq(users.username, username))
    .get()
}

function getBindings(username: string): Record<string, string> {
  return Object.fromEntries(
    db
      .select({
        platform: userBindings.platform,
        platformId: userBindings.platformId,
      })
      .from(userBindings)
      .where(eq(userBindings.username, username))
      .all()
      .map(r => [r.platform, r.platformId]),
  )
}

function onPostLiked({ postId, actorUsername, liked }: AppEventMap['net.pbhh.post.liked']) {
  if (!liked) {
    db.delete(notifications).where(and(
      eq(notifications.type, 'like'),
      eq(notifications.actorUsername, actorUsername),
      eq(notifications.postId, postId),
    )).run()
    return
  }
  const post = db
    .select({ username: posts.username, content: posts.content })
    .from(posts)
    .where(eq(posts.id, postId))
    .get()
  if (!post || post.username === actorUsername)
    return
  if (!isPrefEnabled(post.username, 'like'))
    return
  const actor = getActor(actorUsername)
  db.insert(notifications).values({
    username: post.username,
    type: 'like',
    actorUsername,
    postId,
  }).run()
  deliverToUser(post.username, 'net.pbhh.notify.post.liked', {
    recipientUsername: post.username,
    recipientBindings: getBindings(post.username),
    actorUsername,
    actorNickname: actor?.nickname ?? actorUsername,
    actorAvatar: actor?.avatar,
    postId,
    postContent: post.content,
  })
}

function onPostCreated({ username: actorUsername, postId }: AppEventMap['net.pbhh.post.created']) {
  const actor = getActor(actorUsername)
  const post = db
    .select({ content: posts.content })
    .from(posts)
    .where(eq(posts.id, postId))
    .get()
  for (const username of FollowService.getFollowers(actorUsername)) {
    if (!isPrefEnabled(username, 'post'))
      continue
    db.insert(notifications).values({
      username,
      type: 'post',
      actorUsername,
      postId,
    }).run()
    deliverToUser(username, 'net.pbhh.notify.post.created', {
      recipientUsername: username,
      recipientBindings: getBindings(username),
      actorUsername,
      actorNickname: actor?.nickname ?? actorUsername,
      actorAvatar: actor?.avatar,
      postId,
      postContent: post?.content,
    })
  }
}

function onPostReplied({ parentId, actorUsername, replyId }: AppEventMap['net.pbhh.post.replied']) {
  const post = db
    .select({ username: posts.username, content: posts.content })
    .from(posts)
    .where(eq(posts.id, parentId))
    .get()
  if (!post || post.username === actorUsername)
    return
  if (!isPrefEnabled(post.username, 'reply'))
    return
  const actor = getActor(actorUsername)
  const reply = db
    .select({ content: posts.content })
    .from(posts)
    .where(eq(posts.id, replyId))
    .get()
  db.insert(notifications).values({
    username: post.username,
    type: 'reply',
    actorUsername,
    postId: parentId,
    replyId,
  }).run()
  deliverToUser(post.username, 'net.pbhh.notify.post.replied', {
    recipientUsername: post.username,
    recipientBindings: getBindings(post.username),
    actorUsername,
    actorNickname: actor?.nickname ?? actorUsername,
    actorAvatar: actor?.avatar,
    postId: parentId,
    postContent: post.content,
    replyId,
    replyContent: reply?.content,
  })
}

bus.on('event', (event: AppEvent) => {
  if (event.topic === 'net.pbhh.post.liked')
    onPostLiked(event.payload)
  else if (event.topic === 'net.pbhh.post.created')
    onPostCreated(event.payload)
  else if (event.topic === 'net.pbhh.post.replied')
    onPostReplied(event.payload)
})

const replyPost = alias(posts, 'reply_post')

export function list(username: string) {
  const rows = db
    .select({
      id: notifications.id,
      type: notifications.type,
      actorUsername: notifications.actorUsername,
      actorLabel: notifications.actorLabel,
      actorNickname: users.nickname,
      actorAvatar: users.avatar,
      postId: notifications.postId,
      postContent: posts.content,
      replyId: notifications.replyId,
      replyContent: replyPost.content,
      emailId: notifications.emailId,
      emailSubject: emails.subject,
      emailFromAddress: emails.fromAddress,
      read: notifications.read,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .leftJoin(users, eq(notifications.actorUsername, users.username))
    .leftJoin(posts, eq(notifications.postId, posts.id))
    .leftJoin(replyPost, eq(notifications.replyId, replyPost.id))
    .leftJoin(emails, eq(notifications.emailId, emails.id))
    .where(eq(notifications.username, username))
    .orderBy(desc(notifications.createdAt))
    .all()

  return rows.map(row => ({
    ...row,
    actorLabel: row.actorLabel ?? row.actorNickname ?? row.actorUsername ?? row.emailFromAddress ?? '',
    createdAt: row.createdAt.getTime(),
  }))
}

export function markRead(id: number, username: string) {
  const notification = db.select({ emailId: notifications.emailId }).from(notifications).where(and(
    eq(notifications.id, id),
    eq(notifications.username, username),
  )).get()

  db.update(notifications).set({ read: true }).where(and(
    eq(notifications.id, id),
    eq(notifications.username, username),
  )).run()

  if (notification?.emailId) {
    db.update(emails).set({ read: true }).where(and(
      eq(emails.id, notification.emailId),
      eq(emails.username, username),
    )).run()
  }
}

export function markAllRead(username: string) {
  db.update(notifications).set({ read: true }).where(and(
    eq(notifications.username, username),
    eq(notifications.read, false),
  )).run()

  db.update(emails).set({ read: true }).where(and(
    eq(emails.username, username),
    eq(emails.read, false),
  )).run()
}

export function unreadCount(username: string): number {
  const result = db
    .select({ count: count() })
    .from(notifications)
    .where(and(
      eq(notifications.username, username),
      eq(notifications.read, false),
    ))
    .get()
  return result?.count ?? 0
}

export function removeForDeletedPosts(deletedIds: number[]) {
  if (!deletedIds.length)
    return
  db.delete(notifications).where(and(
    eq(notifications.type, 'reply'),
    inArray(notifications.replyId, deletedIds),
  )).run()
}
