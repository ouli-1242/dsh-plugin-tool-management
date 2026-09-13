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

/**
 * 宿主 op 的假响应：**按真实形状**（键名取自宿主 3080 的实回），并且刻意带数据。
 *
 * 为什么必须带数据：本文件第一版把 fetch 写成直接 reject，于是页面停在 loading 态、
 * `(data.scenes || []).map(...)` 的回调一次都没执行——`ScenesPage` 里那个
 * `sceneLabel is not defined` 的 ReferenceError 就这样从测试里溜过去了（真实后果是
 * 「工具」页整页白屏）。**渲染测试必须让列表渲染路径真的跑起来。**
 */
/**
 * 当前模式（`scene-mode-get` 回的 `mode.scene`）。测试可临时改成 null 表示「没进任何模式」——
 * 「自由模式」那条常驻解释已被删除，这条用两种模式状态各渲染一遍来守。
 */
let modeSceneFixture = '办公'

function fixtureFor(op) {
  const scenes = [
    { name: 'global', label: '全局', order: 0, count: 1, active: true, shared: false, global: true, description: '任何对话都注入' },
    { name: '办公', label: '办公', order: 1, count: 2, active: true, shared: false, global: false, description: '写周报与站会' },
    { name: 'code-review', label: 'code-review', order: 2, count: 0, active: false, shared: false, global: false, description: '' },
  ]
  const rules = [
    { id: 'global/总则', name: '总则', group: 'global', description: '全局约定', enabled: true, form: 'flat', bytes: 120 },
    { id: '办公/周报格式', name: '周报格式', group: '办公', description: '周报写法', enabled: true, form: 'flat', bytes: 240 },
    { id: '办公/流程/站会', name: '站会', group: '办公', description: '站会流程', enabled: false, form: 'bundle', bytes: 300 },
  ]
  switch (op) {
    case 'rules-list':
      return { ok: true, rules, groups: [{ name: 'global', label: '全局', order: 0, count: 1 }], scenes, activeMode: 'all', sceneMemory: { usedBytes: 660, maxBytes: 65536, truncated: false, dropped: [] }, paths: { memories: 'C:/m', scenes: 'C:/s', hub: 'C:/h' }, stats: { total: 3, enabled: 2, scenes: 3 } }
    case 'scene-mode-get':
      return { ok: true, mode: { scene: modeSceneFixture, snapshot: { mcp: ['github'], skills: ['find-extensions'], subagents: [] } }, archives: { 办公: { mcp: ['github'], skills: ['find-extensions'], subagents: [], memories: ['办公/周报格式'] } } }
    case 'rules-budget':
      return { ok: true, usedBytes: 660, maxBytes: 65536, truncated: false, scenes, items: rules.map((r) => ({ id: r.id, bytes: r.bytes, injected: r.enabled, scene: r.group })) }
    case 'subagent-list':
      return { ok: true, personas: [{ name: 'java-helper', description: 'Java 后端实现与重构', provider: 'sensenova', model: 'sensenova-6.8-flash-lite', tools: ['read_file'], toolsDeny: ['bash'] }] }
    case 'agentsmd-list':
      return { ok: true, presets: [{ id: 'default', name: '默认预设', applied: true, size: 1024 }], current: 'default' }
    case 'history-list':
    case 'history-sessions':
      return { ok: true, items: [], groups: [], total: 0 }
    case 'rules-trash-list':
      return { ok: true, entries: [{ id: 't1', name: '旧记忆', group: '办公', form: 'flat', bytes: 100, deletedAt: '2026-09-13T10:00:00.000Z' }] }
    case 'mcpm-list':
      return { ok: true, rows: [{ serverName: 'github', transport: 'stdio', level: 'project', enabled: true, tools: ['create_issue'] }], paths: {}, errors: [], warnings: [] }
    case 'plugin-version':
      return { ok: true, version: '0.4.0' }
    case 'model-candidates':
      return { ok: true, candidates: [{ provider: 'sensenova', providerName: 'SenseNova', id: 'sensenova-6.8-flash-lite', name: '6.8 Flash Lite' }] }
    case 'preset-tools':
      return { ok: true, tools: [{ name: 'read_file', presets: ['default'], current: true }] }
    case 'skill-state':
      return { ok: true, roots: [], trash: [], summary: { total: 0, enabled: 0, disabled: 0, issues: 0 } }
    default:
      return { ok: true }
  }
}

/** 按 op 分发的假 fetch：异步 settle，让 effect 里的 .then 链真的把数据写进 state。 */
function makeFetch(calls) {
  return (url, init) => {
    let op = ''
    try { op = JSON.parse(init && init.body).op } catch { /* 非 API 调用 */ }
    calls.push(op)
    return Promise.resolve({ status: 200, json: () => Promise.resolve(fixtureFor(op)) })
  }
}

/** 让所有已 resolve 的 promise 链跑完（setState 在 effect 的 .then 里发生）。 */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 求值 bundle 的 factory（不跑 apply）。 */
function loadModule({ fetchImpl } = {}) {
  const registration = {}
  const win = {
    __ModuleLoader__: { load: (value) => { registration.value = value } },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {}, removeEventListener: () => {},
  }
  const prev = { window: globalThis.window, __ModuleLoader__: globalThis.__ModuleLoader__, localStorage: globalThis.localStorage, fetch: globalThis.fetch }
  globalThis.window = win
  globalThis.__ModuleLoader__ = win.__ModuleLoader__
  globalThis.localStorage = win.localStorage
  if (fetchImpl) globalThis.fetch = fetchImpl
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
  const pendingEffects = []
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
      const slot = slotAt(index, () => ({ deps: undefined, effect: undefined }))
      const changed = slot.deps === undefined || deps === undefined
        || deps.length !== slot.deps.length || deps.some((d, i) => !Object.is(d, slot.deps[i]))
      if (!changed) return
      slot.deps = deps ? deps.slice() : undefined
      slot.effect = effect
      pendingEffects.push({ component: current, effect, cleanup: slot.cleanup })
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
    /** 执行已排队的 effect（真实 React 在提交阶段做），effect 里的请求才会发出。 */
    runEffects() {
      const batch = pendingEffects.splice(0, pendingEffects.length)
      for (const item of batch) {
        if (typeof item.cleanup === 'function') item.cleanup()
        try {
          const cleanup = item.effect()
          if (typeof cleanup === 'function') {
            const slots = slotsByComponent.get(item.component) || []
            for (const slot of slots) if (slot && slot.effect === item.effect) slot.cleanup = cleanup
          }
        } catch (error) {
          throw new Error(`effect 抛错: ${error && error.message}`)
        }
      }
      return batch.length
    },
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

/**
 * 场景卡片的**文案契约**（纯函数，可直接调）。
 *
 * 来自一次真实反馈：「全局框只显示描述，不显示当前记忆、skill 等这些数量，描述也要有字数限制，
 * 不然会导致全局变成纵向布局」。三件事各有一条断言，缺一条这个缺陷就会以另一种形式回来：
 *   ① 保留场景「全局」的说明行 = 描述，**一个数字都不许有**（它恒定注入，勾选进度毫无意义）；
 *   ② 普通场景仍要显示勾选进度（那是「记忆」段唯一的行为依据，不能一起删掉）；
 *   ③ 描述必裁到上限——描述是自由文本，卡片只留一行，否则卡片被撑成纵向。
 */
test('场景卡片文案：全局只显示描述（无任何数量），普通场景保留勾选进度，描述超长必裁', () => {
  const exported = loadModule()
  exported.apply(fakeCtx(fakeSlots(), exported.dict))
  const { sceneTileDesc, sceneMemDesc, sceneDescMax, clipText } = exported.pages
  for (const [name, fn] of Object.entries({ sceneTileDesc, sceneMemDesc, clipText })) {
    assert.equal(typeof fn, 'function', `pages.${name} 未导出（测试接缝丢失）`)
  }
  const max = sceneDescMax()
  assert.ok(max >= 20 && max <= 120, `描述字数上限不合理：${max}`)

  // ① 全局：只有描述，没有数量、没有勾选进度。
  const globalScene = { name: 'global', label: '全局', global: true, description: '跨项目通用约定' }
  const globalLine = sceneMemDesc(globalScene, 0, 3)
  assert.equal(globalLine, '跨项目通用约定')
  assert.equal(/\d/.test(globalLine), false, `全局卡片出现了数量：${globalLine}`)
  // 没有描述 → 空串，调用方连描述行都不渲染（不是渲染一个空行把卡片撑高）。
  assert.equal(sceneMemDesc({ name: 'global', global: true }, 0, 0), '')

  // ② 普通场景：描述 + 勾选进度。
  assert.equal(sceneMemDesc({ name: '办公', description: '写周报' }, 1, 2), '写周报 · 1/2 条已勾选')
  assert.equal(sceneMemDesc({ name: '办公' }, 0, 4), '0/4 条已勾选')

  // ③ 场景页卡片：只有描述（数量已收进页首的「当前模式」条）。
  assert.equal(sceneTileDesc({ description: '写周报与站会', count: 7 }), '写周报与站会')

  // ④ 超长描述必裁到上限并以省略号结尾。
  const clipped = sceneTileDesc({ description: '一'.repeat(200) })
  assert.equal(clipped.length, max, `裁剪后长度应为上限 ${max}，实际 ${clipped.length}`)
  assert.equal(clipped.endsWith('…'), true, '裁剪后应以省略号结尾')
  assert.equal(clipText('  a\n\nb  ', 10), 'a b', '裁剪前应压平空白')

  // CSS 侧的兜底（双保险）：描述行单行省略；勾选行的名称/说明各占一行（否则长描述横向溢出段边框）。
  // 后者是「文字超出边框」的直接成因——.dsm-pick-main 原是行内 span，text-overflow 对行内元素无效，
  // 实测溢出 353px（Playwright 量过）。
  const cssOf = (selector) => {
    const line = src.split('\n').map((l) => l.trim()).find((l) => l.startsWith(selector) && l.includes('{'))
    assert.ok(line, `找不到 CSS 规则 ${selector}`)
    return line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'))
  }
  assert.match(cssOf('.dsm-scene-tile-desc{'), /white-space:nowrap/, '描述行必须单行')
  assert.match(cssOf('.dsm-scene-tile-desc{'), /text-overflow:ellipsis/, '描述行超出要省略号')
  assert.match(cssOf('.dsm-pick-main{'), /flex-direction:column/, '勾选行的名称与说明必须各占一行')
  assert.match(cssOf('.dsm-pick-desc{'), /text-overflow:ellipsis/, '勾选行说明超出要省略号')
  // 滚动容器里的子项不许被压缩（否则筛选框会被压扁、与下面的条目叠在一起）。
  assert.match(cssOf('.dsm-seg-body>*{'), /flex:none/, '段体子项必须禁止收缩')
  assert.match(cssOf('.dsm-tools-grid>*{'), /flex:none/, '工具勾选列表子项必须禁止收缩')
  // 描述输入框的字数上限：显示层裁剪只兜住历史数据，新写的必须在输入处就挡住。
  assert.match(src, /maxLength:\s*SCENE_DESC_MAX/, '场景描述输入框缺少 maxLength')
})

/**
 * 档案弹窗各段的**默认勾选**契约（用户要求）：
 *   - MCP 工具集 / 技能集 / 子智能体绑定：点「添加」后一律**不勾选**；
 *   - 记忆：只勾**保留场景「全局」里已启用**的那几条，其余（其它场景、全局里已停用的）不勾。
 * 记忆的默认值是真逻辑（memDefaultPickIds），直接调；另外两段是常量动作，用源码守卫。
 */
test('档案弹窗默认勾选：MCP/技能/子智能体空集，记忆只勾「全局」已启用的那几条', () => {
  const exported = loadModule()
  exported.apply(fakeCtx(fakeSlots(), exported.dict))
  const { memDefaultPickIds, memDescMax, clipText } = exported.pages
  assert.equal(typeof memDefaultPickIds, 'function', 'pages.memDefaultPickIds 未导出（测试接缝丢失）')

  const memories = [
    { id: 'global/总则', scene: 'global', name: '总则', description: 'x' },
    { id: 'global/停用的', scene: 'global', name: '停用的', description: 'y' },
    { id: '办公/周报', scene: '办公', name: '周报', description: 'z' },
    { id: 'global/被覆盖的', scene: 'global', name: '被覆盖的', description: 'w' },
  ]
  const rules = [
    { id: 'global/总则', group: 'global', enabled: true },
    { id: 'global/停用的', group: 'global', enabled: false },
    { id: '办公/周报', group: '办公', enabled: true },
    { id: 'global/被覆盖的', group: 'global', enabled: true, shadowed: true },
  ]
  assert.deepEqual(memDefaultPickIds(memories, rules), ['global/总则'], '默认只勾「全局」+ 已启用 + 未被覆盖')
  assert.deepEqual(memDefaultPickIds(memories, []), [], '拿不到 rules（老宿主/请求失败）时不预勾，宁少不滥')
  assert.deepEqual(memDefaultPickIds([{ id: 'global/a', scene: 'global' }], [{ id: 'global/a', enabled: undefined }]), ['global/a'], 'enabled 缺省视为启用（与记忆页一致）')

  // 记忆描述必须截断：上限存在、且超长必裁（记忆正文可能很长，行内只留一行）。
  const max = memDescMax()
  assert.ok(max >= 40 && max <= 160, `记忆描述上限不合理：${max}`)
  const clipped = clipText('一'.repeat(300), max)
  assert.equal(clipped.length, max)
  assert.equal(clipped.endsWith('…'), true)

  // 源码守卫：两段的「添加」动作必须是空集（默认不勾选）。
  assert.match(src, /\{ mcp: emptyMcpPreset\(\) \}/, 'MCP 工具集「添加」必须默认不勾选')
  assert.match(src, /\{ skills: \[\] \}/, '技能集「添加」必须默认不勾选')
  assert.match(src, /subagents: \[\] \}/, '子智能体绑定「添加」必须默认不勾选')
  // 反向守卫：记忆段的「全选」必须是真正的全选，不能还是默认值那一个子集。
  assert.match(src, /memories: allMemoryIds\(\) \}/, '记忆段「全选」必须勾上全部记忆')
})

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

/**
 * 场景页「当前模式」条：**只在真的进入模式后出现**。
 * 用户反馈「自由模式 / 各场景按自己的启用开关注入记忆…这个是干什么的，感觉没什么用」——
 * 那条常驻的静态解释已删；这里两种状态各渲染一遍，确认「有条」与「没条」的差别只由状态决定。
 */
test('场景页：「当前模式」条只在进入模式后出现（不再常驻一条「自由模式」解释）', async () => {
  /** 展开函数组件并把 class / 文本收集出来（同一个组件只展开一次，避免 hook 槽位错位）。 */
  const collect = (element, view, seen = new Set(), out = { classes: new Set(), text: [] }) => {
    if (element === null || element === undefined || typeof element === 'boolean') return out
    if (typeof element === 'string' || typeof element === 'number') { out.text.push(String(element)); return out }
    if (Array.isArray(element)) { for (const item of element) collect(item, view, seen, out); return out }
    if (typeof element !== 'object' || element.type === undefined) return out
    if (typeof element.type === 'function') {
      if (seen.has(element.type)) return out
      seen.add(element.type)
      collect(view.render(element.type, element.props), view, seen, out)
      return out
    }
    const cls = element.props && element.props.className
    if (typeof cls === 'string') for (const name of cls.split(/\s+/)) if (name) out.classes.add(name)
    collect(element.props && element.props.children, view, seen, out)
    return out
  }
  const renderMode = async () => {
    const calls = []
    const prevFetch = globalThis.fetch
    globalThis.fetch = makeFetch(calls)
    try {
      const exported = loadModule({ fetchImpl: globalThis.fetch })
      exported.apply(fakeCtx(fakeSlots(), exported.dict))
      const view = createDispatcher()
      let out = null
      for (let pass = 0; pass < 4; pass += 1) {
        const tree = view.renderTree(React.createElement(exported.pages.ScenesPage, { t: exported.pages.t }))
        assert.deepEqual(tree.failures, [], `渲染抛错:\n${tree.failures.join('\n')}`)
        out = collect(React.createElement(exported.pages.ScenesPage, { t: exported.pages.t }), view)
        try { view.runEffects() } catch { /* 交互行为不在这里断言 */ }
        await settle()
      }
      assert.ok(calls.includes('rules-list'), '规则列表没被请求，用例没生效')
      return out
    } finally {
      if (prevFetch === undefined) delete globalThis.fetch
      else globalThis.fetch = prevFetch
    }
  }

  modeSceneFixture = '办公'
  const withMode = await renderMode()
  assert.ok(withMode.classes.has('dsm-mode-bar'), '进入模式后必须有「当前模式」条')
  assert.ok(withMode.text.some((s) => s.includes('当前模式：办公')), `模式条没显示当前模式：${withMode.text.slice(0, 12).join(' | ')}`)
  assert.ok(withMode.text.some((s) => s.includes('MCP 1 台')), '模式条应给出档案摘要')

  modeSceneFixture = null
  const freeMode = await renderMode()
  assert.equal(freeMode.classes.has('dsm-mode-bar'), false, '没进任何模式时不该有模式条（自由模式解释已删除）')
  assert.equal(freeMode.text.some((s) => s.includes('自由模式')), false, '「自由模式」文案应已下线')
  // 反向护栏：卡片本身照常渲染（别把整页一起弄没了）。
  assert.ok(freeMode.classes.has('dsm-scenes'), '场景卡片网格必须仍在渲染')
  assert.equal(freeMode.classes.has('dsm-scene-tile'), true, '场景卡片必须仍在渲染')
  modeSceneFixture = '办公'
})

/**
 * 带数据的挂载：effect 真的执行、假 fetch 真的回数据、拿到数据后再渲染一次。
 * 这条才是能抓住「列表回调里引用未定义变量」的用例——scenes/rules/personas 都必须非空。
 */
test('带数据挂载：每个页面在数据到达后再渲染一遍都不抛错（列表回调真的执行）', async () => {
  const calls = []
  const prevFetch = globalThis.fetch
  globalThis.fetch = makeFetch(calls)
  try {
    const exported = loadModule({ fetchImpl: globalThis.fetch })
    const slots = fakeSlots()
    exported.apply(fakeCtx(slots, exported.dict))
    const pages = exported.pages
    const failures = []

    for (const [name, component] of Object.entries(pages)) {
      if (name === 't') continue
      const view = createDispatcher()
      for (let pass = 0; pass < 4; pass += 1) {
        try {
          const tree = view.renderTree(React.createElement(component, { t: pages.t }))
          for (const line of tree.failures) failures.push(`${name}（第 ${pass + 1} 次渲染）: ${line}`)
        } catch (error) {
          failures.push(`${name}（第 ${pass + 1} 次渲染）: ${error && error.message}`)
        }
        try { view.runEffects() } catch (error) { failures.push(`${name}（effect）: ${error && error.message}`) }
        await settle()
      }
    }

    assert.deepEqual(failures, [], '带数据渲染抛错:\n' + failures.join('\n'))
    // 反向护栏：确认假数据真的被请求过，否则上面的遍历等于空跑（历史教训）。
    assert.ok(calls.includes('rules-list'), '规则列表没被请求，带数据用例没生效')
    assert.ok(calls.filter((op) => op === 'rules-list').length >= 2, '规则列表只请求了一次，页面可能不止一个')
  } finally {
    if (prevFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = prevFetch
  }
})
