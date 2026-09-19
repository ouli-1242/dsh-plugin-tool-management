// 客户端 bundle 的**导出契约**测试 —— 2026-09-19 瘦身之后 test/ 里只剩两份：
// 这一份（导出落地）与 `contracts.test.mjs`（纯函数不变量）。
//
// 被移走的三份（原件在 `test/_archive/`，已 gitignore）：`client-notice` /
// `client-render` / `client-scope`。移走的理由（用户 2026-09-19 裁定，与 2026-09-17
// 那条一致的口径）：它们各自复刻**某一次具体故障**，靠手写的假 React + 具体文案/按钮
// 定位去断言；界面一改就红，红了先得改测试，等于没有测试。功能验证以真实使用为准。
//
// 留下这一条的理由：**它不是场景测试**。它只回答"只求值 factory（不跑 apply）能不能
// 拿到该有的键"，不碰任何文案、类名、结构。它来自一次真实白屏故障（点开「工具」设置页
// 什么都没有），成因是导出写错了位置：
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
// 断言刻意只钉"有没有 / 是不是"，不钉具体数量与内容 —— 词典多大、页面有几个，随项目演进。
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

  // 注入清单只钉"该有的在"，不钉"只有这些" —— 以后加注入不该让这条红。
  assert.ok(Array.isArray(exported.inject), 'inject 必须是数组')
  assert.ok(exported.inject.includes('timer'), 'inject 必须含 timer')
  assert.ok(exported.inject.includes('locale'), 'inject 必须含 locale')

  // 这两条是白屏故障的直接护栏：它们必须在 apply **之外**就已经挂上。
  assert.ok(exported.dict && typeof exported.dict === 'object', 'dict 必须是对象（不能靠 apply 挂载）')
  for (const lang of ['zh', 'en']) {
    const table = exported.dict[lang]
    assert.ok(table && typeof table === 'object', `dict 必须含 ${lang} 这份`)
    assert.ok(Object.keys(table).length > 0, `dict.${lang} 不能是空的（挂载失败时就是这样）`)
  }
  // 注意：这里**不能**断言 pages 非空 —— 页面组件本来就是 apply 跑起来之后挂进去的
  // （`_pages.MCPPage = MCPPage` 那一段在 apply 里）。要钉的正是"那个容器对象在 factory
  // 作用域就已经导出"，这样 apply 往里塞的键才会被宿主看到；换成 apply 内部再
  // `module.exports._pages = {}` 就会漏出去一个空对象（白屏故障的原形）。
  assert.ok(exported.pages && typeof exported.pages === 'object', 'pages 必须是对象（不能靠 apply 挂载）')
})
