# lexicons/

atproto lexicon 文档。[lexicon](https://atproto.com/specs/lexicon) 是描述记录形状的 schema ——
"这份 repo 里的记录长什么样"的正式声明，索引器、别的 AppView、另一个客户端靠它读懂你写进
用户 repo 的记录。

本目录**只有定义，没有发布任何东西**；发布步骤见 §4。

## 1. `net.pbhh.feed.post.json`

本站一条题壁（或一条回复）。与 `app.bsky.feed.post` 同形：

| | `app.bsky.feed.post` | `net.pbhh.feed.post` | 备注 |
| --- | --- | --- | --- |
| `createdAt` | 有 | 逐字一致 | |
| `reply` | `#replyRef` → `com.atproto.repo.strongRef` | 逐字一致 | strongRef 不认 collection，两边都锚得住 |
| 标题 | 无 | `title`，≤100 字素 | |
| 正文上限 | 300 字素 | 1000 字素（`content`） | |
| 正文格式 | 明文 | Markdown | |
| `facets` | 有 | **无** | 正文是 Markdown，字节区间会切进语法本身 |
| `langs` | 有 | **无** | 站内没有语言检测，不猜 |

`key` 用 `tid`，与既有的 `newRecordKey()`（`server/modules/atproto/outbox.ts:79`，
`TID.nextStr()`）一致，也与 Bluesky 同款。

本站帖的形状是 `title`(≤100) + `content`(≤1000)（`server/modules/posts/model.ts:4-5`）。
出站发布把本站帖压成 `app.bsky.feed.post` 时会丢掉 `title`（`outbox.ts:208-213`），
超过 300 字素的帖整条发不出去（`outbox.ts:220-227`）。这份 lexicon 是本站形状本身的定义。

## 2. 命名与 DNS

**NSID 一旦有记录写进用户 repo 就改不了**，所以名字现在就要定对。`net.pbhh.feed.post`
留出了 `net.pbhh.feed.*` 整个 authority 组，将来加 like / repost 不必再开新组 DNS。

解析链：**DNS TXT → DID → DID 文档 → PDS → `com.atproto.repo.getRecord`**。

TXT 记录名 = NSID 去掉最后一段、剩下的倒置、前缀 `_lexicon.`：

```text
net.pbhh.feed.post  →  _lexicon.feed.pbhh.net
```

不是 `_lexicon.pbhh.net`（那是 `net.pbhh.<name>` 三段式才用的）。解析**不递归**，父/子都不回退。
已用两个真实项目对过：`_lexicon.leaflet.pub`、`_lexicon.standard.site`。

`scripts/check-lexicons.ts` 会把这个名字算出来打印。

## 3. 本地校验

```bash
bun run check:lexicons      # 或 bun run lint（已包含）
```

| 检查 | 谁做的 |
| --- | --- |
| `lexicon === 1`、`id` 是合法 NSID、`required` ⊆ `properties` | `@atproto/lexicon` 的 `lexiconDoc`（zod） |
| 文件名 === 文档的 `id` | 脚本 |
| `key` ∈ `tid`/`nsid`/`any`/`literal:<值>` | 脚本 |
| 每个 `ref` 都解析得到目标 def | 脚本 |

注意 **`Lexicons.add()` 不校验任何东西** —— 它只查重复、然后就地改写 ref（源码里那句
`// WARNING mutates the object`）。所以"add 没抛错"什么都证明不了，真正干活的是 `lexiconDoc`。

## 4. 真发布要做什么

### 4.1 需要的东西

1. **一个 atproto 账号**，挂在**任意** PDS 上，不需要自建。它的 DID 就是 DNS 记录的值。
2. **一条 TXT 记录**：`_lexicon.feed.pbhh.net` → `did=<那个账号的 DID>`。
3. **一条 schema 记录**写进那个账号的 repo：collection 固定 `com.atproto.lexicon.schema`，
   **rkey 必须等于文档自己的 `id`**（meta-schema 声明了 `"key": "nsid"`）。

### 4.2 记录的形状

`value` 就是文档本体、平的，另加 `$type: "com.atproto.lexicon.schema"` 和 meta-schema 唯一
要求的 `lexicon: 1`（可选 `revision` 整数、`description`）。已抓 `pub.leaflet.document` 的实物对过。

**不要让文档有两份。** 读文件、补一个 `$type`：

```ts
const doc = await Bun.file('lexicons/net.pbhh.feed.post.json').json()
const record = { $type: 'com.atproto.lexicon.schema', ...doc }
// rkey = doc.id
```

写入用 `com.atproto.repo.putRecord`，`repo` 传账号 DID，`collection` 传
`com.atproto.lexicon.schema`，`rkey` 传 `doc.id`。

### 4.3 为什么现在不发布

- pbhh.net 没有自己的 DID 和 repo，是 handle provider（`server/modules/atproto/index.ts:53`），
  目前没有可发布的主体。
- 三条路都被否掉：**借一个现成的 did:plc 账号**（lexicon 的权威性绑在一个跟本站无关的身份上，
  而 NSID 已经写进用户 repo 改不了）、**自建 PDS + `did:web:pbhh.net`**（存储备份升级迁移全要
  自己扛，且官方警告应用与 PDS 不宜共用同一个可注册域）、**不发布**。
- 规范原文是 "not currently required"，只是 "strongly advised"。**不发布不会让任何东西坏掉**：
  解析不到就是解析不到，没有降级路径，也没有东西因此报错。

### 4.4 如果将来走 `did:web:pbhh.net` 或 `did:web:atproto.pbhh.net`

先做这件事：**把 `atproto` 加进 `RESERVED_LABELS`**（`server/modules/atproto/config.ts:21`）。

它现在**不在**表里，而注册时会查这张表（`server/modules/auth/service.ts:35`）——
**也就是说今天任何人都能注册用户名 `atproto`**。一旦被认领，`atproto.pbhh.net` 就指向别人的
handle 校验，那时再想收回就涉及删一个真实用户的账号。

apex 与子域的区别只有一处：**谁占 `/.well-known/`**。主站已经在用它（`atproto-did`），
`did:web:pbhh.net` 还要在同一个 host 下再挂一个 `/.well-known/did.json`；用子域可以不碰主站。

## 5. 将来接发布路径要改的地方（本轮一行没动）

三个会**静默吞掉事件**的点，加新 collection 时每一处都要有名字：

1. **`jetstream.ts:212`** —— `mirrorCommit` 的 collection 闸门，不在集合里就 `return []`。
   最可能的落点：`handleFrame` 里没有对应分支的话，事件会掉进 `else` → `mirrorCommit` →
   被这道闸门吞掉。`jetstream.ts:572-575` 的注释记着这个坑为 like 踩过一次。
2. **`outbox.ts:850`** —— `deliver` 对未知 kind 直接 `fail(row, ..., permanent = true)`，行被标死。
3. **`backfill.ts:90`** —— 全模块唯一一处 `listRecords`，只拉 `POST_COLLECTION`。

其余：

- `WANTED_COLLECTIONS`（`jetstream.ts:40`）加一项即可。
- `WANTED_KINDS`（`jetstream.ts:47`）**不能动** —— 已经 4 项，是 lexicon 的上限。
- `OutboxKind`（`outbox.ts:64`）加值 + `deliver` 加分支。`kind` 是无约束 text 列 ⇒ **不需要迁移**。
- `succeed()`（`outbox.ts:787`）里那句 `if (row.kind === 'put' && cid)` 是承重的，加 kind 时要一起看。
- scope 已经是 `transition:generic` ⇒ **不需要用户重新授权**。
- **潜伏 bug**：`bskyPostUrl`（`server/modules/posts/rkey.ts:58-61`）不查 collection，
  任何 `at://` URI 都会被拼成 bsky.app 链接 —— 一旦有 `net.pbhh.*` 的 uri 流到前端就是死链。
  今天没有这种行，**只记不修**。
