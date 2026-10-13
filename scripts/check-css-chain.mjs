#!/usr/bin/env node
/**
 * 检查「CSS 字符串链条里出现孤立表达式」——见 docs/regression-samples.md 例 1。
 *
 * 背景：lib/client.js 是 src/client/*.js 拼接出来的，CSS 全在字符串里。
 *       一条样式链只要前面漏了 `const X =`（或断行处漏了 `+`），它就成了**裸表达式**：
 *       语法合法、node --check 全绿、页面照常渲染，规则却不进文档。
 *
 * 判定（行级，状态机版 —— 块注释与模板串都会被正确跳过）：
 *   维护「是否在块注释 / 模板串里」两个状态；只在两者都为否时，
 *   检查以 ' / " / ` 开头的行，其上一有效行是否以 + = ( , [ : ? && || => return 结尾。
 *
 * 用法：
 *   node scripts/check-css-chain.mjs [目录...]      # 默认 src/client
 * 退出码：0 = 未发现可疑；1 = 有可疑（逐条打印 file:line 与上下文）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const CONTINUES = ['+', '=', '(', ',', '[', ':', '?', '&&', '||', '=>', 'return']
const roots = process.argv.slice(2)
const targets = roots.length ? roots : ['src/client']

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && /\.(m?js)$/.test(e.name) && !/\.min\./.test(e.name)) out.push(p)
  }
}

const endsContinuing = (text) => CONTINUES.some((c) => text.endsWith(c))

/** 统计一行里的反引号（不含转义的），用来在模板串内外切换状态 */
function backticks(text) {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
      continue
    }
    if (text[i] === '`') n++
    // 行内 // 之后的都当注释，不再数反引号
    if (text[i] === '/' && text[i + 1] === '/') break
  }
  return n
}

const hits = []
for (const root of targets) {
  let st
  try {
    st = statSync(root)
  } catch {
    continue
  }
  const files = []
  if (st.isFile()) files.push(root)
  else walk(root, files)

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    let inBlock = false // /* … */ 里
    let inTemplate = false // ` … ` 里
    let prev = null // 上一条「代码行」（不含注释）

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      const t = raw.trim()

      // ① 块注释状态推进（先把整行扫一遍）
      let content = t
      if (inBlock) {
        const end = content.indexOf('*/')
        if (end < 0) continue
        content = content.slice(end + 2).trim()
        inBlock = false
      }
      // 行内可能有 /* 开、*/ 收（同行的算注释掉）
      let guard = 0
      while (guard++ < 8) {
        const open = content.indexOf('/*')
        if (open < 0) break
        const close = content.indexOf('*/', open + 2)
        if (close < 0) {
          content = content.slice(0, open).trim()
          inBlock = true
          break
        }
        content = (content.slice(0, open) + content.slice(close + 2)).trim()
      }
      if (content === '' || content.startsWith('//')) {
        // 模板串状态仍可能持续；注释行不参与判定
        if (!inTemplate && inBlock === false && content === '') continue
        if (inTemplate) inTemplate = backticks(content) % 2 === 1 ? inTemplate : false
        continue
      }

      // ② 模板串状态推进：模板串**内部**的引号不算"字符串字面量开头"
      const bt = backticks(content)
      const wasInTemplate = inTemplate
      if (bt % 2 === 1) inTemplate = !inTemplate

      const startsWithQuote = content.startsWith("'") || content.startsWith('"') || content.startsWith('`')

      if (!wasInTemplate && startsWithQuote && content !== '`') {
        if (prev === null || !endsContinuing(prev.text)) {
          hits.push({
            file: relative(process.cwd(), file),
            line: i + 1,
            text: content.slice(0, 96),
            prevLine: prev ? prev.text.trim().slice(0, 96) : '(文件第一行)',
          })
        }
      }
      if (!wasInTemplate || bt % 2 === 1) prev = { line: i + 1, text: content }
    }
  }
}

if (!hits.length) {
  console.log('[check-css-chain] ✓ 未发现孤立的字符串链条')
  process.exit(0)
}

console.error('[check-css-chain] ✗ 发现 %d 处可疑（很可能是漏了赋值 / 漏了 + 的样式链）：', hits.length)
for (const h of hits) {
  console.error('  %s:%d', h.file, h.line)
  console.error('      上一代码行: %s', h.prevLine)
  console.error('      本行      : %s', h.text)
}
console.error('')
console.error('说明：命中代表这段字符串可能从未被插进文档（见 docs/regression-samples.md 例 1）。')
process.exit(1)
