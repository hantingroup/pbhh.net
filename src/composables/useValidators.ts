import type { Composer } from 'vue-i18n'
import { useI18n } from 'vue-i18n'

interface StringConstraints { minLength?: number, maxLength?: number, pattern?: string }

/**
 * 注册用。用户名就是 `*.pbhh.net` 的子域标签（保留显示大小写），字符规则与
 * 服务端 `server/modules/atproto/config.ts` 的 `USERNAME_PATTERN` 一致 —— 前端跨不到
 * 那个模块，所以这份是镜像，改动时两边都要动。
 */
const username: StringConstraints = {
  minLength: 3,
  maxLength: 63,
  pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$',
}
/**
 * 登录用。**刻意宽松**：与注册 grammar 拆开，否则旧规则（允许 `_`）下的历史
 * 用户名会被前端拦在提交之前，用户看到的是「密码没错但登不进去」。
 */
const loginUsername: StringConstraints = { minLength: 1, maxLength: 63 }
const nickname: StringConstraints = { minLength: 1, maxLength: 20 }
const password: StringConstraints = { minLength: 8, maxLength: 20 }

export type FieldValidator = (value: string) => string | undefined

export function validateField(
  { t, te }: Pick<Composer, 't' | 'te'>,
  schema: StringConstraints,
  value: string,
  field?: string,
): string | undefined {
  const label = field ? t(`field.${field}.label`) : ''
  if (!value)
    return t('validation.required', { label })
  if (schema.minLength && value.length < schema.minLength)
    return t('validation.minLength', { label, min: schema.minLength })
  if (schema.maxLength && value.length > schema.maxLength)
    return t('validation.maxLength', { label, max: schema.maxLength })
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
    const key = `field.${field}.pattern`
    return field && te(key) ? t(key, { label }) : t('validation.pattern', { label })
  }
}

export function useValidators(composer: Pick<Composer, 't' | 'te'> = useI18n()) {
  return {
    username: value => validateField(composer, username, value, 'username'),
    loginUsername: value => validateField(composer, loginUsername, value, 'username'),
    nickname: value => validateField(composer, nickname, value, 'nickname'),
    password: value => validateField(composer, password, value, 'password'),
  } satisfies Record<string, FieldValidator>
}
