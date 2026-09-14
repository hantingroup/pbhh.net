/**
 * 一条帖的来源判读，以及 atproto 地址 → 网页地址的换算。**这是读侧的活**：它不生成
 * rkey，生成在写侧（`atproto/outbox.ts` 的 `newRecordKey`）。
 *
 * **为什么单独成文件**：用它的 `posts/service.ts` **不能 import atproto**（那条依赖边会
 * 成环），所以这些东西必须住在一个自己不引任何东西的地方。
 *
 * 这里**没有 import**，是刻意的：它是叶子模块，把它拖进任何一边都不会牵出依赖图。
 */

/** 本站发出去的帖**曾经**用这个确定性 rkey 前缀。见 `isMirroredPost`。 */
const LOCAL_RKEY_PREFIX = 'pbhh-'

/** `at://<did>/<collection>/<rkey>` 里的 rkey。 */
function rkeyOf(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1)
}

/**
 * 旧约定的换算。**只剩一个用途**：让 `isMirroredPost` 判读本列引入之前写的行。
 *
 * 不要再拿它生成 rkey。那个「确定性」方案已经死了：`app.bsky.feed.post` 的 lexicon
 * 声明 `"key": "tid"`，PDS 拒绝非 TID 的 rkey（详见 `atproto/outbox.ts` 第 4 条）。
 */
export function localRkey(postId: number): string {
  return `${LOCAL_RKEY_PREFIX}${postId}`
}

/**
 * 这条帖是不是**从 Bluesky 镜像来的**。
 *
 * 判据是 `posts.atproto_mirrored`。**不能再用 `atproto_uri` 的形态判断**：本站发出去的
 * rkey 现在也是 TID，与镜像来的**完全同形**，老判据会把用户在这里写的原创帖统统标成
 * 「来自 Bluesky」。（更早的判据「`atproto_uri` 非空」更不行，理由同上。）
 *
 * `null` = 本列引入之前写的行，回退到老判据「rkey 是不是 `pbhh-<本地 id>`」。老判据对
 * 旧行是**对的**：旧的本站帖 rkey 正是 `pbhh-<id>`，旧的镜像帖 rkey 是 TID。所以
 * **不需要回填**，历史行照旧判对。
 */
export function isMirroredPost(post: {
  id: number
  atprotoUri: string | null
  atprotoMirrored?: boolean | null
}): boolean {
  if (!post.atprotoUri)
    return false
  if (post.atprotoMirrored != null)
    return post.atprotoMirrored
  return rkeyOf(post.atprotoUri) !== localRkey(post.id)
}

/**
 * 记录地址 → Bluesky 网页版地址，给镜像帖的来源标记当跳转目标。
 *
 * 入参只可能是我们自己拼的 `at://` 地址（镜像时由 `atUri()` 构造），所以不做出参
 * 校验；真喂进一个畸形串，得到的是一个打不开的 URL，而不是异常。
 */
export function bskyPostUrl(uri: string): string {
  const [did, , rkey] = uri.slice('at://'.length).split('/')
  return `https://bsky.app/profile/${did}/post/${rkey}`
}
