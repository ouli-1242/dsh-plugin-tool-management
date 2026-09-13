// 客户端 bundle 的「装配 + 渲染」契约测试（白屏故障的第二道护栏）。
//
// 第一道护栏在 client-exports.test.mjs（导出必须在 factory 作用域落地）。
// 这一道守的是另一半：**apply 跑起来之后，设置项真的注册进去了吗**。
//
// 失败模式很具体：apply 第一件事就是 `const slots = ctx.get('slots'); if (slots === undefined) return`。
// 于是只要 slots 服务缺失（或插件 dsh.client.inject 声明与 shell 提供的服务名不一致），
// 插件就静默什么都不注册——界面上就是「工具」页空空如也，控制台也不一定报错。
// 这里用假 ctx 把整段 apply 跑完，断言它确实注册了 settings.section，并把面板渲染一遍。
//
// 边界（别把它当浏览器验收）：没有 DOM、没有 react-dom，hook 语义由本文件自建的
// dispatcher 提供；effect 触发的异步 setState 不会引发重渲染。它挡的是「渲染期抛错 /
// 没有注册 / 组件不是函数」这一类，交互行为仍需真浏览器。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const React = require('react')
const src = readFileSync('lib/client.js', 'utf8')

/** 求值 bundle 的 factory（不跑 apply）。 */
function loadModule() {
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
  return registration.value.factory((name) => {
    if (name === 'react') return React
    throw new Error('bundle 请求了未声明的依赖: ' + name)
  })
}

/** 假槽位服务：分别记录 inject 与 register，便于断言「面板确实挂上去了」。 */
function fakeSlots() {
  const injected = []
  const registered = []
  const factories = []
  return {
    injected,
    registered,
    factories,
    inject(name, register) {
      injected.push(name)
      if (typeof register === 'function') register()
    },
    register(spec, factory) {
      registered.push({ name: spec && spec.name, id: spec && spec.id, label: spec && spec.label, order: spec && spec.order })
      if (typeof factory === 'function') factories.push(factory)
      return null
    },
  }
}

/** 假 ctx：只实现 apply 真正用到的那几个成员（ctx.get / locale / interval / timeout）。 */
function fakeCtx(slots, dict) {
  return {
    get: (name) => (name === 'slots' ? slots : undefined),
    interval: () => (() => {}),
    timeout: () => (() => {}),
    locale: {
      register: () => (() => {}),
      // 宿主 locale.bind(ns) 返回的取词函数签名是 (key, params)；这里用导出词典里的中文表。
      bind: () => (key, params) => {
        let text = dict.zh[key] || key
        if (params) for (const k of Object.keys(params)) text = text.replace('{' + k + '}', String(params[k]))
        return text
      },
    },
  }
}

/** 最小 hook dispatcher：真实 React 的 dispatcher 接口，槽位按组件身份复用。 */
function createDispatcher() {
  const slotsByComponent = new WeakMap()
  let current = null
  const slotAt = (index, create) => {
    const list = slotsByComponent.get(current)
    if (list[index] === undefined) list[index] = create()
    return list[index]
  }
  const dispatcher = {
    useState(initial) {
      const slot = slotAt(current.__cursor++, () => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
      }]
    },
    useEffect(effect, deps) {
      const index = current.__cursor++
      const slot = slotAt(index, () => ({ deps: undefined }))
      const changed = slot.deps === undefined || deps === undefined
        || deps.length !== slot.deps.length || deps.some((d, i) => !Object.is(d, slot.deps[i]))
      if (!changed) return
      slot.deps = deps ? deps.slice() : undefined
      // 不执行 effect：effect 里是数据请求，本测试只关心渲染期是否抛错。
    },
    useMemo(factory) { current.__cursor++; return factory() },
    useCallback(factory) { current.__cursor++; return factory },
    useRef(initial) { return slotAt(current.__cursor++, () => ({ current: initial })) },
    useContext() { return undefined },
    useReducer(reducer, initial) { return [initial, () => {}] },
    useSyncExternalStore(_s, getSnapshot) { return getSnapshot() },
    useImperativeHandle() {}, useDebugValue() {},
    useId() { return 'test-' + current.__cursor++ },
    useTransition() { return [false, (fn) => fn()] },
    useDeferredValue(value) { return value },
  }
  return {
    dispatcher,
    render(component, props) {
      current = component
      if (!slotsByComponent.has(component)) slotsByComponent.set(component, [])
      component.__cursor = 0
      const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
      const prior = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      try { return component(props) } finally { internals.ReactCurrentDispatcher.current = prior }
    },
    /**
     * 渲染整棵树：宿主元素（字符串 type）跳过，函数组件各自执行一次。
     * 用 seen 去重，避免同一个组件被反复执行（hook 槽位会错位）。
     */
    renderTree(element) {
      const seen = new Set()
      const failures = []
      const walk = (node) => {
        if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string') return
        if (Array.isArray(node)) { for (const item of node) walk(item); return }
        if (typeof node !== 'object' || node.type === undefined) return
        if (typeof node.type === 'function') {
          if (!seen.has(node.type)) {
            seen.add(node.type)
            let child = null
            try { child = this.render(node.type, node.props) }
            catch (error) { failures.push(`${node.type.name || '(匿名组件)'}: ${error && error.message}`); return }
            walk(child)
          }
          return
        }
        // 宿主元素：继续往下看它的 children
        walk(node.props && node.props.children)
      }
      walk(element)
      return { failures, rendered: seen.size }
    },
  }
}

test('apply 装配：注册 settings.section（slots 缺失时会静默什么都不注册，这条挡住白屏）', () => {
  const exported = loadModule()
  const slots = fakeSlots()
  exported.apply(fakeCtx(slots, exported.dict))
  assert.deepEqual(slots.injected, ['settings.section'], 'apply 必须往 settings.section 注入一次')
  assert.equal(slots.registered.length, 1, '并且注册恰好一个设置项')
  assert.equal(slots.registered[0].id, 'dsm-tools')
  assert.equal(slots.registered[0].label, '工具')
  assert.equal(slots.registered[0].order, 16)
})

test('apply 装配：页面组件全部填充，且都是函数', () => {
  const exported = loadModule()
  exported.apply(fakeCtx(fakeSlots(), exported.dict))
  const pages = exported.pages
  const names = ['MCPPage', 'SkillManagerSection', 'AgentsMdPage', 'HistoryPage', 'ScenesPage', 'SubagentsPage', 'MemoryPage']
  for (const name of names) {
    assert.equal(typeof pages[name], 'function', `pages.${name} 未被填充（apply 是否提前返回了？）`)
  }
  assert.equal(typeof pages.t, 'function', 'pages.t 未被填充')
})

test('面板渲染：整棵组件树首次渲染都不抛错（递归进页面组件）', () => {
  const exported = loadModule()
  const slots = fakeSlots()
  exported.apply(fakeCtx(slots, exported.dict))
  const pages = exported.pages
  const view = createDispatcher()

  // 面板本体：调用注册时的工厂，得到与宿主同形的元素，再递归渲染。
  assert.equal(typeof slots.factories[0], 'function', '注册时必须给出面板工厂')
  const panel = view.render(slots.factories[0])
  assert.ok(panel, '面板工厂必须返回元素')
  const panelResult = view.renderTree(panel)
  assert.deepEqual(panelResult.failures, [], '面板树渲染抛错:\n' + panelResult.failures.join('\n'))
  assert.ok(panelResult.rendered >= 2, `面板树只渲染了 ${panelResult.rendered} 个组件，树遍历可能失效`)

  // 每个页面：分别挂到一棵树上渲染（SkillManagerSection 的 t 由父组件注入）。
  const failures = []
  for (const [name, component] of Object.entries(pages)) {
    if (name === 't') continue
    const result = view.renderTree(React.createElement(component, { t: pages.t }))
    for (const line of result.failures) failures.push(`${name}: ${line}`)
  }
  assert.deepEqual(failures, [], '页面渲染抛错:\n' + failures.join('\n'))
})
