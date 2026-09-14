import type { MirrorOutcome } from './mirror'
import { Agent } from '@atproto/api'
import { db } from 'server/database'
import { getOAuthClient } from './client'
import { BACKFILL_MAX_PAST_MS, mirrorRecord, POST_COLLECTION } from './mirror'

/**
 * 绑定时的历史帖回填。
 *
 * **不问 AppView，直接问用户的 PDS**：`com.atproto.repo.listRecords` 是 PDS 方法
 * （实测在 `public.api.bsky.app` 上返回 `MethodNotImplemented`）。用 OAuth 会话构造的
 * `Agent` 会自己路由到用户 PDS，所以这里不需要解析 DID 文档。
 */

/** `listRecords` 的 limit 上限是 100；50 是个折中，够让用户看到「我的帖过来了」。 */
const BACKFILL_LIMIT = 50

/**
 * 回填**刻意不发任何事件**（不调 `publishMirrored`）。
 *
 * 理由不是省事：`net.pbhh.post.created` 的订阅者会给**每一个粉丝**插一条通知并推送
 * （见 `notification/service.ts` 的 `onPostCreated`），还会投给所有外部 webhook。
 * 回填 50 条历史帖就会给粉丝刷 50 条「TA 发了新帖」—— 而那些帖是两年前的。用户只是
 * 绑了个号，不该惊动任何人。事件流本身已经发过这些帖子了。
 *
 * 代价是新绑定用户要刷新页面才能看到回填结果，而绑定流程末尾本来就要跳回设置页。
 */
export async function backfillFromPds(did: string): Promise<void> {
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
  }
  catch (err) {
    // 回填是锦上添花：失败绝不能影响绑定本身，也不该让用户看到报错。
    console.error(`[atproto] 回填失败 ${did}:`, err)
  }
}
