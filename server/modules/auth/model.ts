import { t } from 'elysia'
import { USERNAME_PATTERN } from '../atproto/config'

/**
 * 注册用。用户名就是 `*.pbhh.net` 的子域标签，所以直接用 label 的字符规则；
 * 保留用户选择的显示大小写，唯一性由 `users_username_lower_idx` 保证大小写不敏感。
 * 63 是 DNS label 上限。
 */
export const username = t.String({ minLength: 3, maxLength: 63, pattern: USERNAME_PATTERN })

/**
 * 登录用。**刻意宽松**：注册 grammar 收紧后若登录复用同一个 schema，历史用户名
 * （旧规则允许 `_`）会在 Elysia 校验层直接 422，根本进不到 handler —— 用户会
 * 表现为「密码没错但登不进去」。
 */
export const loginUsername = t.String({ minLength: 1, maxLength: 63 })

export const nickname = t.String({ minLength: 1, maxLength: 20 })
export const password = t.String({ minLength: 8, maxLength: 20 })
export const avatar = t.String({ minLength: 1, maxLength: 100 })
export const capability = t.Union([
  t.Literal('admin'),
  t.Literal('admin:view'),
  t.Literal('admin:edit'),
  t.Literal('admin:update'),
])
export const capabilities = t.Array(capability)

export type Capability = typeof capability.static

export interface UserProfile {
  username: string
  nickname: string
  avatar: string
}

export const signUpBody = t.Object({
  username,
  nickname,
  password,
})
export type SignUpBody = typeof signUpBody.static

export const loginBody = t.Object({
  username: loginUsername,
  password,
})
export type LoginBody = typeof loginBody.static

export const updateProfileBody = t.Object({
  nickname: t.Optional(nickname),
  avatar: t.Optional(avatar),
})
export type UpdateProfileBody = typeof updateProfileBody.static
