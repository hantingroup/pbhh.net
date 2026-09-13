import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export type NotificationType = 'like' | 'reply' | 'post' | 'mail'
export const NOTIFICATION_TYPES: NotificationType[] = ['like', 'reply', 'post', 'mail']

export const users = sqliteTable('users', {
  /** 同时是 `*.pbhh.net` 的 DNS label，保留用户选择的显示大小写（`BeiDou`）。 */
  username: text('username').notNull().primaryKey(),
  nickname: text('nickname').notNull(),
  password: text('password').notNull(),
  avatar: text('avatar').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, () => [
  /**
   * 唯一性必须大小写不敏感（`Alice` 与 `alice` 是同一个人的两种写法），但主键是
   * `TEXT PRIMARY KEY`，SQLite 默认 BINARY 排序，挡不住；drizzle 0.45.1 也没有列级
   * `COLLATE NOCASE`。所以唯一性落在表达式索引上 —— drizzle-kit 支持，无需手改
   * `drizzle/`。表达式里不能有 `,` 或 `;`（快照用 `join(",")` 切分）。
   */
  uniqueIndex('users_username_lower_idx').on(sql`lower(username)`),
])

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
  /**
   * 对应 atproto 记录地址。本站发布的是 `at://<did>/app.bsky.feed.post/pbhh-<id>`
   * （rkey 故意做成确定性的，见 `modules/atproto/outbox.ts`）；从 Bluesky 镜像来的
   * 则是原记录的 `at://` 地址（rkey 是 TID）。
   *
   * 它同时是回环吸收点：写路径发出去的记录会被 JetStream 送回读路径，靠这一列上的
   * 唯一索引 + `on conflict do nothing` 吃掉。
   */
  atprotoUri: text('atproto_uri'),
  /**
   * `putRecord` 的返回值 / JetStream 事件的 cid。回复的 strongRef 必须 uri + cid
   * 成对，缺 cid 就不能当父锚点 —— 所以「两列都非空」等价于「这条帖已成功发布」。
   */
  atprotoCid: text('atproto_cid'),
}, table => [
  /**
   * 刻意用**普通唯一索引**而不是 `WHERE atproto_uri IS NOT NULL` 的部分索引：SQLite
   * 的唯一索引本来就把多个 NULL 当彼此不同，约束语义完全等价；部分索引只省体积，而
   * 这点体积毫无意义。而 drizzle-kit 的 `where` 要经过 `sql\`\`` 字符串化往返，在这个
   * 刚被快照漂移坑过的仓库里属于纯风险、零收益。
   */
  uniqueIndex('posts_atproto_uri_unique').on(table.atprotoUri),
])

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
  /** 本地账号，同时就是 `*.pbhh.net` 的 label —— handle 为 `lower(username).pbhh.net`。 */
  username: text('username').notNull().primaryKey().references(() => users.username),
  did: text('did').notNull().unique(),
  /**
   * 最后一次观测到的 atproto handle（`alice.bsky.social`），仅作展示与重解析用。
   * 刻意**不加唯一约束**：handle 在 atproto 里是全球唯一的，但我们这份是副本，
   * 用户改 handle 后本行会过期，届时另一用户可能取走旧 handle —— 唯一约束会在
   * 那次绑定时硬失败。查询一律走 `did` 或 `username`，唯一性买不到东西。
   */
  handle: text('handle').notNull(),
  pdsUrl: text('pds_url').notNull(),
  /** 是否把本站新帖同步发到用户 PDS。默认开，用户可在设置页关掉。 */
  publishEnabled: integer('publish_enabled', { mode: 'boolean' }).notNull().default(true),
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

/**
 * 出站队列：本站的帖/删要写进用户自己的 PDS，成功即删行。
 *
 * **这里刻意没有 `atproto_seen` 那样的去重表。** 曾经有过一张（按 `at://` URI 做主键
 * 记「见过」），已删除 —— 它的主键是 URI，于是同一个 URI 的 delete 事件会撞主键被静默
 * 跳过，**镜像删除直接失效**。而有了 `posts.atproto_uri` 之后它什么也买不到：建是
 * `on conflict do nothing`、删是 `update ... where atproto_uri = ?`、改是 upsert，
 * 三种操作天然幂等，重复投递的事件重放时同样被吸收。**不要再建回来。**
 */
export const atprotoOutbox = sqliteTable('atproto_outbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 目标 repo。存 did 而不是 username —— 解绑重绑会让绑定变化。 */
  did: text('did').notNull(),
  /** 只为查/清方便，解绑时按它整批删。 */
  username: text('username').notNull().references(() => users.username),
  kind: text('kind').notNull(),
  rkey: text('rkey').notNull(),
  uri: text('uri').notNull(),
  /** `kind = 'delete'` 时为 null。 */
  record: text('record'),
  attempts: integer('attempts').notNull().default(0),
  /** `'pending' | 'dead'`；成功即删行，所以没有 `'done'`。 */
  status: text('status').notNull().default('pending'),
  lastError: text('last_error'),
  /** 退避用：失败后推到未来，让位给后面的行，避免队头阻塞。 */
  nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, table => [
  /**
   * `(uri, kind)` 而不是仅 `uri`：同一个 URI 先 put 后 delete 是**合法序列**，两行都
   * 必须在队列里，只按 uri 做唯一就会把 delete 顶掉。
   */
  uniqueIndex('atproto_outbox_uri_kind_unique').on(table.uri, table.kind),
  index('atproto_outbox_claim_idx').on(table.status, table.nextAttemptAt),
])
