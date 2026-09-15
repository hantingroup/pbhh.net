#!/usr/bin/env bun
/**
 * 校验 `lexicons/` 下的文档。
 *
 * 注意 `Lexicons.add()` **不校验**任何东西 —— 它只查重复、然后就地改写 ref（源码里那句
 * `// WARNING mutates the object`）。所以"add 没抛错"什么都证明不了。真正的 schema 校验
 * 在 `@atproto/lexicon` 导出的 zod schema `lexiconDoc` 里，它自带 `lexicon === 1` 和
 * "id 是合法 NSID"两条断言。官方 schemas 必须一并加载：本站的 lexicon 引了
 * `com.atproto.repo.strongRef`，不加载它这个 ref 就解析不到目标。
 *
 * `lexiconDoc` 查完还剩三件事没人管，由这里补上。它们的共同点是**错了也不会当场报错**，
 * 要等发布之后、或者等真实记录走到校验那一步才炸：
 *   1. 文件名必须等于文档的 `id` —— 发布时记录的 rkey 用的就是这个字符串，
 *      文件叫别的名字、文档写另一个 id，发出去的是文档里那个，两边悄悄分叉；
 *   2. `key` 必须是 `tid` / `nsid` / `any` / `literal:<值>` 之一（zod 里它只是
 *      `z.string()`），写错了记录会落到一个自以为是的 rkey 上；
 *   3. 每个 `ref` 都要能解析到目标 def。
 *
 * 每条都反向验证过"确实会失败"：一个从不失败的校验等于没有校验。加检查前先确认它有的可失败
 * —— `required` 就属于 `lexiconDoc` 已经做了的（`lexObject` 的 superRefine 走 util.js 的
 * `Required field "${field}" not defined`），在这里再写一遍只是死代码。
 */
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { schemas } from '@atproto/api'
import { lexiconDoc, Lexicons } from '@atproto/lexicon'

const DIR = fileURLToPath(new URL('../lexicons/', import.meta.url))
const KEY_PATTERN = /^(?:tid|nsid|any|literal:.+)$/

/**
 * NSID → DNS TXT 记录名：去掉最后一段、剩下的倒置、前缀 `_lexicon.`。
 * 解析**不递归**，父/子都不回退，所以整个 `net.pbhh.feed.*` 组共用这一条。
 * 这是真发布时唯一容易算错的东西，交给代码算而不是靠人记。
 */
function txtName(nsid: string): string {
  const labels = nsid.split('.')
  return `_lexicon.${labels.slice(0, -1).reverse().join('.')}`
}

/** 收集文档里所有 ref（必须在 `add()` 之后调用，那时它们才是全限定形式）。 */
function collectRefs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found)
    return found
  }
  if (!node || typeof node !== 'object')
    return found
  const obj = node as Record<string, unknown>
  if (obj.type === 'ref' && typeof obj.ref === 'string')
    found.push(obj.ref)
  if (obj.type === 'union' && Array.isArray(obj.refs))
    found.push(...obj.refs as string[])
  for (const value of Object.values(obj)) collectRefs(value, found)
  return found
}

/** 递归查每个 record def 的 `key`。 */
function checkKeys(node: unknown, where: string, problems: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => checkKeys(item, `${where}[${i}]`, problems))
    return
  }
  if (!node || typeof node !== 'object')
    return
  const obj = node as Record<string, unknown>
  if (obj.type === 'record' && !KEY_PATTERN.test(String(obj.key ?? '')))
    problems.push(`${where}: key "${obj.key}" 不是 tid/nsid/any/literal:<值>`)
  for (const [key, value] of Object.entries(obj)) checkKeys(value, `${where}.${key}`, problems)
}

function report(file: string, problems: string[]): void {
  console.error(`✗ ${file}`)
  for (const p of problems) console.error(`    ${p}`)
}

const files = (await readdir(DIR)).filter(f => f.endsWith('.json')).sort()
if (files.length === 0) {
  console.error(`lexicons/ 下没有 .json：${DIR}`)
  process.exit(1)
}

// 官方 schemas 先入，本站的方言才解析得了跨命名空间的 ref。
const lexicons = new Lexicons(schemas)
let failed = false

for (const file of files) {
  const raw: unknown = JSON.parse(await readFile(join(DIR, file), 'utf8'))

  const parsed = lexiconDoc.safeParse(raw)
  if (!parsed.success) {
    failed = true
    report(file, [`lexiconDoc 不通过：${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`])
    continue
  }

  const id = parsed.data.id
  const problems: string[] = []
  if (basename(file, '.json') !== id)
    problems.push(`文件名与 id 不一致：文件叫 ${basename(file, '.json')}，文档是 ${id}`)
  checkKeys(parsed.data, id, problems)

  // `add()` 会把 ref 改写成全限定形式，所以解析要在它之后 —— 实际校验的是 add 自己
  // 算出来的那个字符串，而不是文档里我们以为的那个。
  lexicons.add(parsed.data)
  for (const ref of collectRefs(parsed.data)) {
    if (!lexicons.getDef(ref))
      problems.push(`ref 解析不到：${ref}`)
  }

  if (problems.length) {
    failed = true
    report(file, problems)
    continue
  }

  console.log(`✓ ${id}\n    DNS TXT  ${txtName(id)}  →  did=<发布账号的 DID>`)
}

process.exit(failed ? 1 : 0)
