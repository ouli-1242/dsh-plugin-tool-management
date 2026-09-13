// test/client-i18n.test.mjs —— 客户端词典与「界面实际用到的键」之间的契约（node --test）。
//
// 挡的缺陷类型（真实发生过）：
//   1. 代码里 `t('memory.archive.emptySection')` 但词典没这个键 → 界面直接显示原始键名；
//   2. 只有英文有、中文没有（或反之）→ 中文用户看不到该提示；
//   3. 词典里同一键整块重复 → 以后改文案只改到一份。
//
// 与 scripts/check-i18n.mjs 的分工：那边做**格式与占位符对齐**（纯文本层面），
// 这边做**代码 → 词典的引用完整性**（真的把用到的键抓出来比对）。
// 浏览器交互验收仍需真浏览器，这条不能替代。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync('src/client.js', 'utf8')

/** 取出导出的 DICT（`dict: DICT` 指向同一个对象，所以直接从导出里读最稳）。 */
function loadDict() {
  const mod = { exports: {} }
  const win = {
    __ModuleLoader__: {
      load(def) {
        // 只跑 factory 取 exports；不调用 apply（不需要渲染）
        return def.factory((name) => {
          if (name === 'react') return { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), Fragment: () => null, useMemo: (f) => f(), useCallback: (f) => f() }
          throw new Error('unexpected require: ' + name)
        })
      },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {}, removeEventListener: () => {},
  }
  const doc = { querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }), head: { appendChild() {} }, addEventListener: () => {} }
  const fn = new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', src)
  fn(win, doc, () => Promise.resolve({ json: () => Promise.resolve({}) }), setTimeout, clearTimeout, setInterval, clearInterval)
  return mod.exports.dict || win.__ModuleLoader__.__dict
}

/**
 * 抓出代码里所有 `t('key')` / `t("key")` 的字面量键。
 *
 * 键的形状要求「至少一个点」（`a.b`、`a.b.c`）：否则会把 `t(x === 'bundle' ? ...)` 里的
 * 比较值也当成键抓进来（第一版就踩了这个坑，报出两个假缺失）。
 * 动态拼接（`t('mcp.level.' + level)`）故意不抓——那族由 `没有死键` 用例的前缀白名单覆盖。
 */
function usedKeys() {
  const keys = new Set()
  const KEY = "([a-z][A-Za-z0-9]*(?:\\.[A-Za-z0-9]+)+)"
  for (const m of src.matchAll(new RegExp("\\bt\\(\\s*'" + KEY + "'\\s*[,)]", 'g'))) keys.add(m[1])
  for (const m of src.matchAll(new RegExp('\\bt\\(\\s*"' + KEY + '"\\s*[,)]', 'g'))) keys.add(m[1])
  return keys
}

const dict = (() => {
  // 直接解析源码里的 DICT 字面量：避免依赖运行时导出（导出是给别的用途的保险）。
  const start = src.indexOf('var DICT = {')
  assert.ok(start > 0, '找不到 DICT 定义')
  // 配平花括号取出整块，再交给 Function 求值（纯字面量，安全）
  let depth = 0
  let i = src.indexOf('{', start)
  const from = i
  let inStr = null
  let esc = false
  for (; i < src.length; i++) {
    const ch = src[i]
    if (inStr) { if (esc) { esc = false; continue } if (ch === '\\') { esc = true; continue } if (ch === inStr) inStr = null; continue }
    if (ch === '"' || ch === "'") { inStr = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) break }
  }
  const body = src.slice(from, i + 1)
  return new Function('return ' + body)()
})()

test('词典结构：zh / en 两份都在，且键集合完全一致', () => {
  assert.ok(dict.zh && dict.en, 'DICT 应有 zh 与 en')
  const zh = Object.keys(dict.zh)
  const en = Object.keys(dict.en)
  assert.deepEqual(zh.filter((k) => !en.includes(k)), [], '只有中文的键')
  assert.deepEqual(en.filter((k) => !zh.includes(k)), [], '只有英文的键')
  assert.ok(zh.length > 400, `词典规模异常（${zh.length} 键）`)
})

test('引用完整性：bundle 里用到的每个 t() 键都在两份词典里', () => {
  const used = usedKeys()
  const missingZh = [...used].filter((k) => !(k in dict.zh))
  const missingEn = [...used].filter((k) => !(k in dict.en))
  assert.deepEqual(missingZh.sort(), [], '这些键在中文词典里缺失（界面会显示原始键名）')
  assert.deepEqual(missingEn.sort(), [], '这些键在英文词典里缺失')
})

test('文案非空：两套词典里没有空字符串', () => {
  for (const lang of ['zh', 'en']) {
    const empty = Object.entries(dict[lang]).filter(([, v]) => typeof v !== 'string' || v.trim() === '').map(([k]) => k)
    assert.deepEqual(empty, [], `${lang} 里有空文案`)
  }
})

// 说明：**不做「死键」检查**。词典里有约 235 个键没有直接的字面量引用，但其中绝大多数是
// 动态取键（`countKey()` 拼 `.one/.other`、`translateOrFallback(t, 'status.' + x)`、
// `t(item.code)` 取后端的诊断码）。静态分析无法区分「动态可达」与「真死键」，
// 强行做只会逼出一张不断膨胀的白名单——那种测试会给人虚假的安全感，不如不做。
// 真死键的清理留给 `scripts/i18n-debt.mjs` 的人工排查。

