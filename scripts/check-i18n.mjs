// i18n 键对齐检查（开发期自检，不随包发布）。
//
// 客户端把中英两套文案写在 src/client.js 里的同一个结构（`zh: {…}` / `en: {…}`）。
// 这里按块切出两个 locale 对象，比较键集合的差集、重复键，以及**占位符集合**是否一致
// （`{name}` 之类少写一个就会在界面上显示成字面量，是实际会发生的低级缺陷）。
//
// 用法：node scripts/check-i18n.mjs [src/client.js]
import { readFileSync } from 'node:fs'

const file = process.argv[2] || 'src/client.js'
const src = readFileSync(file, 'utf8')

/** 从 `zh: {` 起按花括号配平切出该 locale 块的正文（不依赖缩进宽度）。 */
function blockOf(name) {
  const re = new RegExp('(?:^|[\\s,{])' + name + ':\\s*\\{')
  const m = re.exec(src)
  if (!m) return null
  const open = src.indexOf('{', m.index)
  let depth = 0
  let i = open
  let inStr = null
  let esc = false
  for (; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(open + 1, i)
}

/**
 * 抽 `"key": "value"`。locale 块里一行会写多个键，
 * 所以匹配「行首缩进 + "k": "v"」或「, "k": "v"」两种出现形态。
 */
function entriesOf(body) {
  const out = []
  const re = /(?:^|,)\s*"([A-Za-z0-9._]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(body))) out.push({ key: m[1], value: m[2] })
  return out
}

const placeholders = (v) => [...v.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((x) => x[1]).sort().join(',')

const zhBody = blockOf('zh')
const enBody = blockOf('en')
if (!zhBody || !enBody) {
  console.error('找不到 zh/en locale 块（结构变了？）')
  process.exit(1)
}
const zh = entriesOf(zhBody)
const en = entriesOf(enBody)
const zhMap = new Map(zh.map((e) => [e.key, e.value]))
const enMap = new Map(en.map((e) => [e.key, e.value]))
const dup = (list) => [...new Set(list.map((e) => e.key).filter((k, i, a) => a.indexOf(k) !== i))]

const onlyZh = [...zhMap.keys()].filter((k) => !enMap.has(k))
const onlyEn = [...enMap.keys()].filter((k) => !zhMap.has(k))
const badArgs = [...zhMap.keys()]
  .filter((k) => enMap.has(k) && placeholders(zhMap.get(k)) !== placeholders(enMap.get(k)))
  .map((k) => `${k} (zh:${placeholders(zhMap.get(k)) || '-'} en:${placeholders(enMap.get(k)) || '-'})`)

console.log(`file: ${file}`)
console.log(`zh keys: ${zh.length} | en keys: ${en.length}`)
console.log(`only zh: ${onlyZh.length ? onlyZh.join(', ') : '(none)'}`)
console.log(`only en: ${onlyEn.length ? onlyEn.join(', ') : '(none)'}`)
console.log(`duplicate zh: ${dup(zh).length ? dup(zh).join(', ') : '(none)'}`)
console.log(`duplicate en: ${dup(en).length ? dup(en).join(', ') : '(none)'}`)
console.log(`placeholder mismatch: ${badArgs.length ? badArgs.join(' | ') : '(none)'}`)

const failed = onlyZh.length || onlyEn.length || dup(zh).length || dup(en).length || badArgs.length
console.log(failed ? 'RESULT: FAIL' : 'RESULT: OK')
process.exit(failed ? 1 : 0)
