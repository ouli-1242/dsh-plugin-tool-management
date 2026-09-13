// 客户端 bundle 的**导出契约**测试。
//
// 这条测试来自一次真实白屏故障（点开「工具」设置页什么都没有）。成因是导出写错了位置：
//
//   module.exports = { name, inject, dict: DICT, apply(ctx) {
//     ...
//     if (slots === undefined) return
//     ...
//     module.exports._pages = { ... }   // ← 2900 行之后，写在 apply 方法体内部
//   }}
//
// `module.exports` 是对象字面量，在 factory 求值时就定了型；`module.exports._pages = ...`
// 却是 apply 方法体的最后一条语句。于是只要 apply 提前返回（slots 拿不到、或任何异常），
// 导出里就永远没有 `_pages`。节点测试当时只看「代码里有没有这一行」，所以一直是绿的。
//
// 这里守的是**运行时导出**：只求值 factory（不跑 apply）就必须能拿到该有的键。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const React = require('react')
const src = readFileSync('lib/client.js', 'utf8')

/** 求值 bundle 的 factory，返回导出对象（不调用 apply，模拟「apply 提前返回」的极端情形）。 */
function loadExports() {
  const registration = {}
  const win = {
    __ModuleLoader__: { load: (value) => { registration.value = value } },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {}, removeEventListener: () => {},
  }
  const prev = { window: globalThis.window, __ModuleLoader__: globalThis.__ModuleLoader__, localStorage: globalThis.localStorage }
  globalThis.window = win
  globalThis.__ModuleLoader__ = win.__ModuleLoader__
  globalThis.localStorage = win.localStorage
  try {
    // eslint-disable-next-line no-new-func
    new Function(src)()
  } finally {
    for (const key of Object.keys(prev)) { if (prev[key] === undefined) delete globalThis[key]; else globalThis[key] = prev[key] }
  }
  assert.ok(registration.value, 'bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(registration.value.id, 'dsh-plugin-tool-management')
  return registration.value.factory((name) => {
    if (name === 'react') return React
    throw new Error('bundle 请求了未声明的依赖: ' + name)
  })
}

test('导出契约：只求值 factory 就能拿到 dict / pages / apply（不依赖 apply 跑到底）', () => {
  const exported = loadExports()
  assert.equal(typeof exported.apply, 'function', 'apply 必须是函数')
  assert.deepEqual(exported.inject, ['timer'])

  // 这两条是白屏故障的直接护栏：它们必须在 apply **之外**就已经挂上。
  assert.ok(exported.dict && typeof exported.dict === 'object', 'dict 必须是对象（不能靠 apply 挂载）')
  assert.ok(exported.dict.zh && exported.dict.en, 'dict 必须含 zh / en 两份')
  assert.ok(Object.keys(exported.dict.zh).length > 400, `词典规模异常（${Object.keys(exported.dict.zh).length} 键）`)
  assert.ok(exported.pages && typeof exported.pages === 'object', 'pages 必须是对象（不能靠 apply 挂载）')

  // 反向护栏：不许再出现「挂在 module.exports 字面量上、却写在 apply 方法体内」的写法。
  // 缩进 >= 8 空格 = 已经进了 apply 的方法体；顶层的 `module.exports = {` 是 4 个空格。
  assert.equal(
    /^\s{8,}module\.exports\.\w+\s*=/m.test(src), false,
    '导出不许用 `module.exports.X =` 的形式（apply 提前返回时会静默丢失），请在 factory 作用域落地',
  )
})

test('词条对齐：zh / en 键集合一致，且无空文案', () => {
  const { dict } = loadExports()
  const zh = Object.keys(dict.zh)
  const en = Object.keys(dict.en)
  assert.deepEqual(zh.filter((k) => !en.includes(k)), [], '只有中文的键')
  assert.deepEqual(en.filter((k) => !zh.includes(k)), [], '只有英文的键')
  for (const lang of ['zh', 'en']) {
    const empty = Object.entries(dict[lang]).filter(([, v]) => typeof v !== 'string' || v.trim() === '').map(([k]) => k)
    assert.deepEqual(empty, [], `${lang} 里有空文案`)
  }
})

test('引用完整性：bundle 里用到的每个 t() 键都在两份词典里', () => {
  const { dict } = loadExports()
  const keys = new Set()
  const KEY = "([a-z][A-Za-z0-9]*(?:\\.[A-Za-z0-9]+)+)"
  for (const m of src.matchAll(new RegExp("\\bt\\(\\s*'" + KEY + "'\\s*[,)]", 'g'))) keys.add(m[1])
  for (const m of src.matchAll(new RegExp('\\bt\\(\\s*"' + KEY + '"\\s*[,)]', 'g'))) keys.add(m[1])
  assert.ok(keys.size > 100, `抓到的键太少（${keys.size}），正则可能失效了`)
  assert.deepEqual([...keys].filter((k) => !(k in dict.zh)).sort(), [], '这些键在中文词典里缺失（界面会显示原始键名）')
  assert.deepEqual([...keys].filter((k) => !(k in dict.en)).sort(), [], '这些键在英文词典里缺失')
})
