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

test('场景档案弹窗的布局契约：段体可伸缩 + 列表自身出滚动条，不许写死高度', () => {
  // 来自一次真实反馈：档案弹窗里「记忆/各种集」的勾选框区太矮。
  // 关键点是**空间从哪来**：弹窗高度决定可用空间，光把 .dsm-seg-body 拉高只会让
  // 弹窗内部多出滚动。所以三件事必须同时成立，否则尺寸问题会以另一种形式回来：
  //   ① 弹窗外层放开高度（不再是写死的 620px）；
  //   ② 段体可伸缩（flex:1 + min-height 下限）；
  //   ③ 段体高度由伸缩决定（height:auto），列表自己 overflow 出滚动条。
  const rule = (selector) => {
    const found = src.split('\n').map((line) => line.trim())
      .filter((line) => line.startsWith(selector) && line.includes('{'))
      .map((line) => line.slice(line.indexOf('{') + 1, line.lastIndexOf('}')))
      .join(';')
    assert.ok(found, `找不到 CSS 规则 ${selector}`)
    return found
  }
  const archive = rule('.dsm-modal-archive{')
  assert.equal(/height:\s*\d+px/.test(archive), false, '档案弹窗高度不许写死像素（放开给 min(...) 以适配窗口）')
  assert.match(archive, /height:min\(/, '档案弹窗高度应是 min(上限, 视口比例)')

  const seg = rule('.dsm-modal-archive .dsm-seg{')
  // 必须是「下限优先」而不是 `flex:1` 平分：720px 弹窗里四项平分每段只剩约 155px，
  // 比改动前的固定 216px 还矮（这一版我算错过一次，所以写成断言）。
  assert.match(seg, /min-height:(\d+)px/, '段体需要下限，否则窗口矮时被压扁到看不见')
  assert.equal(/flex:\s*1(\s|;|$)/.test(seg), false, '段体不许 flex:1 平分高度（会把每段压到比原来更矮）')
  assert.match(seg, /flex:\s*0 0 auto/, '段体应「下限优先」，装不下交给外层滚动')

  const floor = Number(seg.match(/min-height:(\d+)px/)[1])
  assert.ok(floor >= 260, `段体下限太小（${floor}px），列表又会显矮`)
  const outer = Number(rule('.dsm-modal-archive{').match(/min\((\d+)px/)[1])
  assert.ok(outer <= 4 * 130 + 260, `弹窗上限 ${outer}px 装不下「段体下限 + 头部/摘要/按钮」`)

  const body = rule('.dsm-modal-archive .dsm-seg-body{')
  assert.match(body, /flex:1/, '段体内部列表跟着伸缩')
  assert.match(body, /height:auto/, '段体高度该由伸缩决定，不是写死')
  assert.match(rule('.dsm-seg-body{'), /overflow:auto/, '列表必须自己出滚动条')
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
