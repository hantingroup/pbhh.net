/**
 * 一条帖与它的 atproto 记录地址之间的约定与换算。
 *
 * **为什么单独成文件**：需要这个约定的两边分别在两个模块里 —— 写路径要用它生成
 * 确定性的 rkey（`atproto/outbox.ts`），读接口要用它判断一条帖是不是镜像来的
 * （`posts/service.ts`）。而 `posts/service.ts` **不能 import atproto**（那条依赖边
 * 会成环），所以约定本身必须住在一个两边都能引、且自己不引任何东西的地方。
 *
 * 这里**没有 import**，是刻意的：它是叶子模块，把它拖进任何一边都不会牵出依赖图。
 */

/** 本站发出去的帖用确定性 rkey：`pbhh-<posts.id>`。见 outbox 的「不变量 L」。 */
const LOCAL_RKEY_PREFIX = 'pbhh-'

/** `at://<did>/<collection>/<rkey>` 里的 rkey。 */
function rkeyOf(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1)
}

export function localRkey(postId: number): string {
  return `${LOCAL_RKEY_PREFIX}${postId}`
}

/**
 * 这条帖是不是**从 Bluesky 镜像来的**。
 *
 * 判据不能是「`atproto_uri` 非空」：本站发出去并成功投递的帖也有 URI，而那是用户
 * 在这里写的原创内容，标成「来自 Bluesky」是错的。
 *
 * 所以比的是 rkey 是否等于 `pbhh-<本地 id>` —— 而不是「是否以 `pbhh-` 开头」。
 * 镜像来的帖 rkey 是 TID，但 rkey 本身是自由字符串，别的客户端理论上可以造出一个
 * 恰好叫 `pbhh-7` 的记录；要求它**同时**撞上本地 id 才误判，那就只剩理论可能了。
 */
export function isMirroredPost(post: { id: number, atprotoUri: string | null }): boolean {
  if (!post.atprotoUri)
    return false
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
