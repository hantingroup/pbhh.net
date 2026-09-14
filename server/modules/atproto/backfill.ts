import type { MirrorOutcome } from './mirror'
import { Agent } from '@atproto/api'
import { db } from 'server/database'
import { getOAuthClient } from './client'
import { BACKFILL_MAX_PAST_MS, mirrorRecord, POST_COLLECTION, publishMirrored } from './mirror'

/**
 * 从用户的 PDS 拉最近若干条记录，按 `mirror.ts` 的规则落库。**两个调用方**：
 *
 * - **绑定时的历史帖回填**（`index.ts` 的 OAuth 回调）：`publish` 缺省 **false**；
 * - **`sync` 事件触发的重同步**（`jetstream.ts`）：`publish: true`。
 *
 * 两者的差别只在**要不要补发事件**，镜像规则完全共用 —— 这正是把它抽成一个函数的原因。
 *
 * **不问 AppView，直接问用户的 PDS**：`com.atproto.repo.listRecords` 是 PDS 方法
 * （实测在 `public.api.bsky.app` 上返回 `MethodNotImplemented`）。用 OAuth 会话构造的
 * `Agent` 会自己路由到用户 PDS，所以这里不需要解析 DID 文档。
 */

/** `listRecords` 的 limit 上限是 100；50 是个折中，够让用户看到「我的帖过来了」。 */
const BACKFILL_LIMIT = 50

/**
 * 只有**这么新**的帖才在重同步时补发事件。
 *
 * `publish: true` 的原始意图是「这条帖本该由实时流通知过一遍」—— 因为链断裂漏掉的
 * 就是断链到我们发现之间的那几条，粉丝本来该收到通知却没收到的正是它们。但
 * `listRecords` 给的是**最近 50 条**，与「断链之后新增的」不是一回事：一个长期没同步上
 * 的仓库可能一次补进一堆旧帖，而每一条都会给**每个粉丝**插一条通知（见
 * `notification/service.ts` 的 `onPostCreated`），还会投给所有外部 webhook。
 *
 * 所以用时间兜底：一周之内漏掉的补通知（停机几天后追赶回来属于这一类），更老的
 * **静默入库** —— 它们会出现在题壁流里，只是不假装自己刚刚发生。
 */
const PUBLISH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface BackfillOptions {
  /**
   * 是否对**窗口内**的新帖补发 `net.pbhh.post.created`（= 粉丝通知 + 前端实时刷新）。
   *
   * 绑定回填必须是 `false`：用户只是绑了个号，不该让他的粉丝收到 50 条「TA 发了新帖」，
   * 而那些帖是两年前的。代价是新绑定用户要刷新页面才能看到回填结果，而绑定流程末尾
   * 本来就要跳回设置页。
   */
  publish?: boolean
}

/**
 * 重同步的补发策略。**必须在事务之外调用** —— 与实时流一致，事务里发会在回滚时留下
 * 幽灵事件。
 *
 * 导出是为了让探针能直接驱动它：否则唯一的触发途径是「真有一个 commit 链断裂的仓库
 * 配一个能连上的 PDS」，本地复现不出来，而这恰恰是唯一会给**粉丝**发通知的新逻辑。
 *
 * `now` 可传是为了把窗口边界钉死（正好 7 天算不算「之内」），不是给人调的。
 */
export function publishResynced(
  outcomes: MirrorOutcome[],
  now = Date.now(),
): { published: number, suppressed: number } {
  const cutoff = now - PUBLISH_MAX_AGE_MS
  let published = 0
  let suppressed = 0
  for (const outcome of outcomes) {
    if (outcome.createdAt.getTime() >= cutoff) {
      publishMirrored(outcome)
      published++
    }
    else {
      suppressed++
    }
  }
  return { published, suppressed }
}

export async function backfillFromPds(did: string, opts?: BackfillOptions): Promise<void> {
  try {
    const client = await getOAuthClient()
    const session = await client.restore(did)
    const agent = new Agent(session)

    // **不传 `reverse`**：默认就是**新 → 旧**（实测），所以这一页正好是「最近 50 条」。
    const { data } = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection: POST_COLLECTION,
      limit: BACKFILL_LIMIT,
    })

    // 倒回**旧 → 新**再处理：回复必须排在父帖之后，否则轮到它时父帖还没落库，
    // 会被「父帖不在本地就跳过」的规则丢掉 —— 那批回复就永远补不上了。
    const records = [...data.records].reverse()
    const outcomes: MirrorOutcome[] = []

    db.transaction((tx) => {
      for (const record of records) {
        const outcome = mirrorRecord(tx, {
          did,
          rkey: record.uri.slice(record.uri.lastIndexOf('/') + 1),
          cid: record.cid,
          record: record.value,
          // 历史记录没有「观测时刻」可比；它只在 `createdAt` 不可用时兜底。
          observedAt: new Date().toISOString(),
          // 放宽过去侧，否则一年前的帖会被伪造成「现在」。
          maxPastMs: BACKFILL_MAX_PAST_MS,
        })
        if (outcome)
          outcomes.push(outcome)
      }
    })

    console.info(`[atproto] 回填 ${did}：拉到 ${records.length} 条，新增 ${outcomes.length} 条`)

    if (!opts?.publish || !outcomes.length)
      return

    // 补发放在事务**之外**，与实时流一致：事务里发会在回滚时留下幽灵事件。
    const { published, suppressed } = publishResynced(outcomes)
    if (published || suppressed)
      console.info(`[atproto] 重同步 ${did}：补发 ${published} 条事件，${suppressed} 条超出 ${PUBLISH_MAX_AGE_MS / 86400000} 天窗口、静默入库`)
  }
  catch (err) {
    // 回填是锦上添花：失败绝不能影响绑定本身，也不该让用户看到报错。
    console.error(`[atproto] 回填失败 ${did}:`, err)
  }
}
