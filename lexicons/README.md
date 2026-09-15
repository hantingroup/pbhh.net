# lexicons/

atproto lexicon 文档。[lexicon](https://atproto.com/specs/lexicon) 是 atproto 里描述记录形状的
schema，作用相当于"这份 repo 里的记录长什么样"的正式声明 —— 别人（索引器、别的 AppView、
另一个客户端）靠它读懂你写进用户 repo 的记录。

本目录**只有定义，没有发布任何东西**。下面第 4 节写清楚真发布需要做什么、第 5 节写清楚
为什么现在不做。

## 1. `net.pbhh.feed.post.json`

本站一条题壁（或一条回复）的定义。与 `app.bsky.feed.post` 的关系是**刻意同形**：

| | `app.bsky.feed.post` | `net.pbhh.feed.post` |
| --- | --- | --- |
| `createdAt` | 有 | 逐字一致 |
| `reply` | `#replyRef` → `com.atproto.repo.strongRef` | 逐字一致 |
| 标题 | 无 | `title`，≤100 字素 |
| 正文上限 | 300 字素 | 1000 字素（`content`） |
| 正文格式 | 明文 | Markdown |
| `facets` | 有 | **无** |
| `langs` | 有 | **无** |

三个取舍，理由都在文件的 `description` 里：

- **`reply` 用 `com.atproto.repo.strongRef`**：strongRef 只认 `uri` + `cid`、不认 collection，
  所以回复锚在 bsky 那份还是本站这份上都成立，不锁死。
- **不带 `facets`**：本站正文是 Markdown（`PostItem.vue` 走 `useMarkdown` + `v-html`），
  而 Bluesky 的 facet 是"明文里的字节区间" —— 套在 Markdown 上是类别错误（`**粗体**`
  的星号会落进区间）。省掉它顺带让这份 lexicon 只依赖 `com.atproto.*`。
- **不带 `langs`**：`outbox.ts` 的 `buildRecord` 刻意不写（猜错等于把帖子塞进错误的语言流），
  站内也没有语言检测。可选字段是向后兼容的，将来需要再加。

`key` 用 `tid`，与既有的 `newRecordKey()`（`server/modules/atproto/outbox.ts:79`，
`TID.nextStr()`）一致，也与 Bluesky 同款。

### 它解决什么

出站发布现在把本站帖压成 `app.bsky.feed.post`，两处失真：

1. **`title` 直接丢弃**（`outbox.ts:208-213`）。理由是不污染用户的公开文本，本站靠回环
   `on conflict do nothing` 保住本地 title。但结果是**用户自己的 repo 里没有标题**。
2. **超过 300 字素的帖整条发不出去**（`outbox.ts:220-227`）。刻意不截断 —— 截断等于让
   用户的公开身份上出现半句话。

本站帖的真实形状是 `title`(≤100) + `content`(≤1000)（`server/modules/posts/model.ts:4-5`）。
这份 lexicon 就是那个形状的定义，让完整内容将来能留一份在**用户自己的 repo** 里，而不只是
存在本站数据库 —— 这是"pbhh.net 作为 open social 一员"的题中之义。

## 2. 命名与 DNS

**NSID 一旦有记录写进用户 repo 就改不了**，所以这个名字现在就要定对。`net.pbhh.feed.post`
留出了 `net.pbhh.feed.*` 这**整个 authority 组**，将来加 like / repost 不必再开新组的 DNS。

解析链是：**DNS TXT → DID → DID 文档 → PDS → `com.atproto.repo.getRecord`**。

TXT 记录名 = NSID 去掉最后一段、剩下的倒置、前缀 `_lexicon.`：

```text
net.pbhh.feed.post  →  _lexicon.feed.pbhh.net
```

注意**不是** `_lexicon.pbhh.net`（那是 `net.pbhh.<name>` 三段式才用的）。解析**不递归**，
父/子都不回退。已用两个真实项目对过：`_lexicon.leaflet.pub`、`_lexicon.standard.site`。

`scripts/check-lexicons.ts` 会把这个名字算出来打印，不靠人记。

## 3. 本地校验

```bash
bun run check:lexicons      # 或 bun run lint（已包含）
```

脚本做四件事，**每一条都反向验证过"确实会失败"** —— 一个从不失败的校验等于没有校验：

| 检查 | 谁做的 |
| --- | --- |
| `lexicon === 1`、`id` 是合法 NSID、`required` ⊆ `properties` | `@atproto/lexicon` 的 `lexiconDoc`（zod） |
| 文件名 === 文档的 `id` | 脚本 |
| `key` ∈ `tid`/`nsid`/`any`/`literal:<值>` | 脚本 |
| 每个 `ref` 都解析得到目标 def | 脚本 |

第一条容易踩错：**`Lexicons.add()` 不校验任何东西**，它只查重复、然后就地改写 ref
（源码里那句 `// WARNING mutates the object`）。所以"add 没抛错"什么都证明不了，
真正干活的是 `lexiconDoc`。

## 4. 真发布要做什么（现在没做）

### 4.1 需要的东西

1. **一个 atproto 账号**，挂在**任意** PDS 上 —— 不需要自建 PDS。它的 DID 就是 DNS 记录的值。
2. **一条 TXT 记录**：`_lexicon.feed.pbhh.net` → `did=<那个账号的 DID>`。
3. **一条 schema 记录**写进那个账号的 repo：collection 固定 `com.atproto.lexicon.schema`，
   **rkey 必须等于文档自己的 `id`**（meta-schema 声明了 `"key": "nsid"`）。

### 4.2 记录的形状

抓 `pub.leaflet.document` 的实物对过：**`value` 就是文档本体，平的**，另加
`$type: "com.atproto.lexicon.schema"`，以及 meta-schema 唯一要求的 `lexicon: 1`
（可选 `revision` 整数、`description`）。

**不要让文档有两份。** 读文件、补一个 `$type` 就行：

```ts
const doc = await Bun.file('lexicons/net.pbhh.feed.post.json').json()
const record = { $type: 'com.atproto.lexicon.schema', ...doc }
// rkey = doc.id
```

写入用 `com.atproto.repo.putRecord`，`repo` 传账号的 DID，`collection` 传
`com.atproto.lexicon.schema`，`rkey` 传 `doc.id`。

### 4.3 不发布并不违反任何东西

规范原文是 lexicon 发布 "not currently required"，只是 "strongly advised"。**不发布不会让
任何东西坏掉**：解析不到就是解析不到，没有降级路径可言，也没有东西因此报错。

## 5. 为什么现在不发布

**pbhh.net 没有自己的 DID，也没有自己的 repo。** 它是 handle provider（`/.well-known/atproto-did`
把子域标签映射到用户 DID，`server/modules/atproto/index.ts:53`），不是 identity provider。
所以真要发布，必须引入一个 atproto 账号。三条路：

| 方案 | 代价 |
| --- | --- |
| **借一个已有的 did:plc 账号** | 最低。但 lexicon 的权威性绑在一个跟 pbhh.net 无关的身份上；那个账号没了/换了，解析就断，而 NSID 已经写进用户 repo 改不了。 |
| **自建 PDS + `did:web:pbhh.net`** | 完全自主，但存储、备份、升级、迁移全要自己扛；官方明确警告**应用与 PDS 不宜共用同一个可注册域**。 |
| **不发布** | 定义先留在仓库里。见 4.3。 |

**任何 DID method 都绕不过"需要一个 PDS 放 repo"这件事** —— DID method 只决定 DID 文档从哪来
（did:plc 问 plc.directory，did:web 问那个域名下的 `/.well-known/did.json`），repo 本身仍然
必须由某个 PDS 托管。自建 PDS 是"照看一个服务"级别的长期负担，为一个尚未接线的 lexicon
付这个代价不划算。

> 顺带记一笔：did:web 账号在 Bluesky AppView 上有已知的索引问题。**与本用途无关** ——
> lexicon 解析直连 PDS，不经 AppView。

### 5.1 如果将来走 `did:web:pbhh.net` 或 `did:web:atproto.pbhh.net`

先做这件事：**把 `atproto` 加进 `RESERVED_LABELS`**（`server/modules/atproto/config.ts:21`）。

它现在**不在**表里，而注册时会查这张表（`server/modules/auth/service.ts:35`），
**也就是说今天任何人都能注册用户名 `atproto`**。一旦被认领，`atproto.pbhh.net` 就指向别人的
handle 校验，而那时再想收回就涉及删一个真实用户的账号。

apex 与子域的区别只有一处：**谁占 `/.well-known/`**。主站已经在用它
（`atproto-did`），`did:web:pbhh.net` 还要在同一个 host 下再挂一个 `/.well-known/did.json`，
两种协议从一个 `/.well-known/` 出。用子域可以完全不碰主站。**这和 PDS 需求无关。**

## 6. 将来接发布路径要改的地方（本轮一行没动）

三个会**静默吞掉事件**的点。加新 collection 时每一处都要有名字，否则事件静静消失、
站上没有任何痕迹：

1. **`jetstream.ts:212`** —— `mirrorCommit` 自己的 collection 闸门，不在集合里就 `return []`。
   **这是最可能的落点**：`handleFrame` 里没有对应分支的话，事件会掉进 `else` →
   `mirrorCommit` → 被这道闸门吞掉。`jetstream.ts:572-575` 的注释记着这个坑为 like 踩过一次
   （那时是一条"非 post 一律静默丢弃"的闸门，现已拆成具名分支）。
2. **`outbox.ts:850`** —— `deliver` 对未知 kind 直接 `fail(row, ..., permanent = true)`，
   行被标死。
3. **`backfill.ts:90`** —— 全模块唯一一处 `listRecords`，只拉 `POST_COLLECTION`。

其余：

- `WANTED_COLLECTIONS`（`jetstream.ts:40`）加一项即可。
- `WANTED_KINDS`（`jetstream.ts:47`）**不能动** —— 已经 4 项，是 lexicon 的上限。
- `OutboxKind`（`outbox.ts:64`）加值 + `deliver` 加分支。`kind` 是无约束 text 列
  ⇒ **不需要迁移**。
- `succeed()`（`outbox.ts:787`）里那句 `if (row.kind === 'put' && cid)` 是承重的，加 kind 时要一起看。
- scope 已经是 `transition:generic` ⇒ **不需要用户重新授权**。
- **潜伏 bug**：`bskyPostUrl`（`server/modules/posts/rkey.ts:58-61`）不查 collection，
  任何 `at://` URI 都会被拼成 bsky.app 链接 —— 一旦有 `net.pbhh.*` 的 uri 流到前端就是死链。
  今天没有这种行，所以**只记不修**。
