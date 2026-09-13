/**
 * 生成 OAuth 客户端签名用的 ES256 私钥（`private_key_jwt` + DPoP）。
 *
 *   bun run modules/atproto/scripts/gen-atproto-key.ts
 *
 * 把输出的单行 JSON 写进 `server/.env.local` 的 `ATPROTO_PRIVATE_KEY=`。
 * 公钥部分会自动内联进 `GET /oauth-client-metadata.json` 的 `jwks`，不需要另存。
 *
 * 换密钥会让所有已发出的 DPoP 绑定 token 失效，用户需要重新绑定。
 */
import { JoseKey } from '@atproto/jwk-jose'

// kid 是必须的：`private_key_jwt` 要求每个签名密钥都有 kid，库会在构造客户端时
// 直接拒掉没有 kid 的密钥集。用随机 kid 便于轮换时区分新旧密钥。
const key = await JoseKey.generate(['ES256'], `pbhh-${crypto.randomUUID().slice(0, 8)}`)

console.log('kid:', key.kid)
console.log()
console.log(`ATPROTO_PRIVATE_KEY=${JSON.stringify(key.privateJwk)}`)
