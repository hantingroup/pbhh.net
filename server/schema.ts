import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export type NotificationType = 'like' | 'reply' | 'post' | 'mail'
export const NOTIFICATION_TYPES: NotificationType[] = ['like', 'reply', 'post', 'mail']

export const users = sqliteTable('users', {
  username: text('username').notNull().primaryKey(),
  nickname: text('nickname').notNull(),
  password: text('password').notNull(),
  avatar: text('avatar').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export const userCapabilities = sqliteTable('user_capabilities', {
  username: text('username').notNull().references(() => users.username),
  capability: text('capability').notNull(),
}, table => [
  primaryKey({ columns: [table.username, table.capability] }),
])

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  parentId: integer('parent_id'),
  title: text('title'),
  content: text('content').notNull(),
  username: text('username').notNull().references(() => users.username),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
})

export const postLikes = sqliteTable('post_likes', {
  postId: integer('post_id').notNull().references(() => posts.id),
  username: text('username').notNull().references(() => users.username),
}, table => [
  primaryKey({ columns: [table.postId, table.username] }),
])

export const userBindings = sqliteTable('user_bindings', {
  username: text('username').notNull().references(() => users.username),
  platform: text('platform').notNull(),
  platformId: text('platform_id').notNull(),
}, table => [
  primaryKey({ columns: [table.username, table.platform] }),
])

export const userFollows = sqliteTable('user_follows', {
  followerUsername: text('follower_username').notNull().references(() => users.username),
  followingUsername: text('following_username').notNull().references(() => users.username),
}, table => [
  primaryKey({ columns: [table.followerUsername, table.followingUsername] }),
])

export const notifications = sqliteTable('notifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().references(() => users.username),
  type: text('type').notNull(),
  actorUsername: text('actor_username').references(() => users.username),
  actorLabel: text('actor_label'),
  postId: integer('post_id'),
  replyId: integer('reply_id'),
  emailId: integer('email_id'),
  read: integer('read', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export const notificationPrefs = sqliteTable('notification_prefs', {
  username: text('username').notNull().references(() => users.username),
  type: text('type').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
}, table => [
  primaryKey({ columns: [table.username, table.type] }),
])

export const rooms = sqliteTable('rooms', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdBy: text('created_by').notNull().references(() => users.username),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export const roomMessages = sqliteTable('room_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  roomId: integer('room_id').notNull().references(() => rooms.id),
  username: text('username').notNull().references(() => users.username),
  replyToId: integer('reply_to_id'),
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export const gravatarAccounts = sqliteTable('gravatar_accounts', {
  username: text('username').notNull().primaryKey().references(() => users.username),
  wpPassword: text('wp_password').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenExpiresAt: integer('token_expires_at', { mode: 'timestamp' }),
})

export const emails = sqliteTable('emails', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().references(() => users.username),
  fromAddress: text('from_address').notNull(),
  subject: text('subject').notNull().default(''),
  html: text('html').notNull().default(''),
  text: text('text').notNull().default(''),
  read: integer('read', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

export const hantingWords = sqliteTable('hanting_words', {
  wordId: integer('word_id').notNull(),
  variant: integer('variant').notNull().default(0),
  level: integer('level').notNull(),
  word: text('word').notNull(),
  competition: text('competition').notNull(),
  flag: integer('flag').notNull().default(0),
  pinyin: text('pinyin').notNull(),
  definition: text('definition').notNull().default(''),
  example: text('example').notNull().default(''),
}, table => [
  primaryKey({ columns: [table.wordId, table.variant] }),
])

export const hantingFeedback = sqliteTable('hanting_feedback', {
  wordId: integer('word_id').notNull(),
  variant: integer('variant').notNull().default(0),
  username: text('username').notNull().references(() => users.username),
  type: text('type').notNull(), // pinyin, definition, example, duplicate, other
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, table => [
  primaryKey({ columns: [table.wordId, table.variant, table.username, table.type] }),
])

export const hitokoto = sqliteTable('hitokoto', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  content: text('content').notNull(),
  from: text('from').notNull(),
  fromWho: text('from_who'),
  creator: text('creator').notNull().references(() => users.username),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

// ─── atproto ─────────────────────────────────────────────────────────────────
// 不自建 PDS：用户带自己的 repo 来，这里只存「哪个本地账号对应哪个 DID」。

export const atprotoIdentities = sqliteTable('atproto_identities', {
  username: text('username').notNull().primaryKey().references(() => users.username),
  did: text('did').notNull().unique(),
  /**
   * 最后一次观测到的 atproto handle（`alice.bsky.social`），仅作展示与重解析用。
   * 刻意**不加唯一约束**：handle 在 atproto 里是全球唯一的，但我们这份是副本，
   * 用户改 handle 后本行会过期，届时另一用户可能取走旧 handle —— 唯一约束会在
   * 那次绑定时硬失败。查询一律走 `did` 或 `domainLabel`，唯一性买不到东西。
   */
  handle: text('handle').notNull(),
  /**
   * 用户认领的 `*.pbhh.net` 子域标签（`alice`），与上面的 atproto handle 分开存：
   * 认领必须发生在用户去 Bluesky 改 handle **之前**（改的时候对方会来抓
   * `/.well-known/atproto-did` 校验），所以认领后、改完前，两者并不相等。
   * null = 未认领。
   */
  domainLabel: text('domain_label').unique(),
  pdsUrl: text('pds_url').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

/** `sessionStore` 的落库实现。session 内含 DPoP 绑定的 token，按机密对待。 */
export const atprotoOauthSessions = sqliteTable('atproto_oauth_sessions', {
  did: text('did').notNull().primaryKey(),
  session: text('session').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
})

/** `stateStore` 的落库实现，约 1h 后过期清理。 */
export const atprotoOauthStates = sqliteTable('atproto_oauth_states', {
  key: text('key').notNull().primaryKey(),
  state: text('state').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
})

/** JetStream 游标（`payload.seq`，inclusive）。kv 形态，便于将来多消费者共存。 */
export const atprotoCursor = sqliteTable('atproto_cursor', {
  key: text('key').notNull().primaryKey(),
  value: text('value').notNull(),
})

/** JetStream 至少一次投递的幂等去重，按 `at://` URI。需按 `seenAt` 定期清理。 */
export const atprotoSeen = sqliteTable('atproto_seen', {
  uri: text('uri').notNull().primaryKey(),
  seenAt: integer('seen_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, table => [
  index('atproto_seen_seen_at_idx').on(table.seenAt),
])
