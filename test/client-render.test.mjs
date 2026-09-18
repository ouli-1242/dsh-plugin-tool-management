// 客户端 bundle 的「装配 + 渲染」冒烟测试（白屏故障的第二道护栏）。
//
// 第一道护栏在 client-exports.test.mjs（导出必须在 factory 作用域落地）。
// 这一道守的是另一半：**apply 跑起来之后，设置项真的注册进去了吗**，以及每个页面
// （含拿到数据之后再渲染一遍）都不抛错。
//
// 只保留最宽泛的护栏：装配、页面填充、首渲染、带数据渲染。文案 / 类名 / 结构细节的
// 逐条断言是刻舟求剑（用户裁定 2026-09-15：改一次样式就要改一次断言），观感由人在
// 真实页面上确认；fixture 的唯一作用是让各页面的渲染分支**真的跑起来**。
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
 * 宿主 op 的假响应：**按真实形状**（键名取自宿主实回），并且刻意带数据。
 *
 * 为什么必须带数据：页面停在 loading 态时，`(data.scenes || []).map(...)` 这类列表
 * 回调一次都不执行，渲染期的 ReferenceError 就溜过去了（真实后果是整页白屏）。
 */
function fixtureFor(op) {
  const scenes = [
    { name: 'global', label: '全局', order: 0, count: 1, active: true, shared: false, global: true, description: '任何对话都注入' },
    { name: '办公', label: '办公', order: 1, count: 2, active: true, shared: false, global: false, description: '写周报与站会', prompt: 'p-办公' },
    { name: 'code-review', label: 'code-review', order: 2, count: 0, active: false, shared: false, global: false, description: '' },
  ]
  const rules = [
    { id: 'global/总则', name: '总则', group: 'global', description: '全局约定', enabled: true, form: 'flat', bytes: 120 },
    { id: '办公/周报格式', name: '周报格式', group: '办公', description: '周报写法', enabled: true, form: 'flat', bytes: 240 },
    { id: '办公/流程/站会', name: '站会', group: '办公', description: '站会流程', enabled: false, form: 'bundle', bytes: 300 },
  ]
  switch (op) {
    case 'rules-list':
      return { ok: true, rules, groups: [{ name: 'global', label: '全局', order: 0, count: 1 }], scenes, activeMode: 'all', scenePrompt: { scene: '办公', label: '办公', presetId: 'p-办公', missing: false, duplicate: false, bytes: 10 }, sceneMemory: { usedBytes: 660, maxBytes: 65536, truncated: false, dropped: [] }, paths: { memories: 'C:/m', scenes: 'C:/s', hub: 'C:/h' }, stats: { total: 3, enabled: 2, scenes: 3 } }
    case 'scene-mode-get':
      return { ok: true, mode: { scene: '办公', snapshot: { mcp: ['github'], skills: ['find-extensions'], subagents: [] } }, archives: { 办公: { mcp: ['github'], skills: ['find-extensions'], subagents: [], memories: ['办公/周报格式'] } } }
    case 'rules-budget':
      return { ok: true, usedBytes: 660, maxBytes: 65536, truncated: false, scenes, items: rules.map((r) => ({ id: r.id, bytes: r.bytes, injected: r.enabled, scene: r.group })) }
    case 'subagent-list':
      // 形状对齐 subagents/service.ts 的 subagent-list 实回（客户端读 r.subagents / r.anyLocked）。
      return { ok: true, subagents: [{ name: 'java-helper', enabled: true, description: 'Java 后端实现与重构', provider: 'sensenova', model: 'sensenova-6.8-flash-lite', tools: ['read_file'], toolsDeny: ['bash'], catalogDepth: 1 }], anyLocked: false }
    case 'agentsmd-list':
      // 形状对齐 index.ts agentsmd-list 实回：active / fileApplied / activeVia / refs
      // （applied 是早已改掉的字段，带数据渲染对现行分支空转过一段时间）。
      return { ok: true, presets: [{ id: 'default', name: '默认预设', active: true, fileApplied: true, activeVia: 'file', refs: [], size: 1024 }, { id: 'p-office', name: '办公基线', active: false, fileApplied: false, activeVia: '', refs: [], size: 512 }], current: 'default' }
    case 'history-list':
    case 'history-sessions':
      return { ok: true, items: [], groups: [], total: 0 }
    case 'rules-trash-list':
      // 恢复/永久删除按钮都用 entry.trashId（client.js），id 是旧字段名。
      return { ok: true, entries: [{ trashId: 't1', name: '旧记忆', group: '办公', form: 'flat', bytes: 100, deletedAt: '2026-09-13T10:00:00.000Z' }] }
    case 'mcpm-list':
      // 形状对齐 index.ts mcpm-list 实回：disabled + live{enabled,phase} + 四个工具计数
      // （live/known 拆分是 0.9.5 的「连不上不再报可用」修复，夹具必须跟着走）。
      return { ok: true, rows: [{ serverName: 'github', transport: 'stdio', level: 'project', disabled: false, notes: '', live: { enabled: true, phase: 'ready' }, toolCount: 1, enabledToolCount: 1, liveToolCount: 1, liveEnabledToolCount: 1, knownToolCount: 1 }], paths: {}, errors: [], warnings: [] }
    case 'plugin-version':
      return { ok: true, version: '0.4.0' }
    case 'model-candidates':
      // 服务端键名是 models（客户端读 mres.models）；candidates 是旧字段名。
      return { ok: true, models: [{ provider: 'sensenova', providerName: 'SenseNova', id: 'sensenova-6.8-flash-lite', name: '6.8 Flash Lite' }] }
    case 'preset-tools':
      return { ok: true, tools: [{ name: 'read_file', presets: ['default'], current: true }] }
    case 'skill-state':
      return { ok: true, roots: [], trash: [], summary: { total: 0, enabled: 0, disabled: 0, issues: 0 } }
    case 'compat-status':
      return compatFixture()
    case 'preset-reach':
      return presetReachFixture()
    case 'inject-settings':
      return injectSettingsFixture()
    case 'injection-live':
      return injectionLiveFixture()
    default:
      return { ok: true }
  }
}

/**
 * 兼容页 fixture：形状按宿主实回（`/compat-status`）来，两类「非 ok」都覆盖到：
 *
 * - **optional**（`workspace.delete-native` 等）：宿主本来就没有这个入口，插件自己顶上 ——
 *   功能完好；本机 rc.2 的真实形状就是这三个槽位都缺。
 * - **真降级**（`projection.write`）：能力不可用且插件也补不上。
 */
function compatFixture() {
  const ok = (id, label, kind, fallback, owner) => ({ id, label, kind, fallback, owner, state: 'ok', detail: '成员齐备', missing: [] })
  const optionalAbsent = (id, label, missingName, kind) => ({
    id, label, kind, owner: 'workspace', fallback: 'native-entry', optional: true,
    state: 'missing-member', detail: '宿主实现缺少 ' + missingName, missing: [missingName],
  })
  const degradedItem = {
    id: 'projection.write', label: '投影缓存写入路径', kind: 'write', owner: 'projectionCache',
    fallback: 'disable-destructive', state: 'missing-member', detail: '宿主实现缺少 put', missing: ['put'],
  }
  const findings = [
    ok('workspace.read-state', '读取工作区状态', 'read', 'degrade-read', 'workspace'),
    ok('workspace.enqueue', '串行写事务', 'write', 'disable-destructive', 'workspace'),
    ok('workspace.set-state', '写工作区状态', 'write', 'disable-destructive', 'workspace'),
    ok('workspace.index-header', '索引会话头部', 'write', 'disable-destructive', 'workspace'),
    ok('projection.delete-native', '投影缓存删除屏障', 'delete', 'native-entry', 'projectionCache'),
    optionalAbsent('workspace.delete-native', '宿主原生删除入口', 'deleteSession', 'delete'),
    ok('sessions.cold-announce', '冷会话移除广播', 'delete', 'disable-destructive', 'sessions'),
    ok('sessions.detach-live', '实时会话落盘与分离', 'delete', 'disable-destructive', 'sessions'),
    degradedItem,
    optionalAbsent('workspace.unarchive-native', '宿主原生恢复入口', 'unarchiveSession', 'write'),
    optionalAbsent('workspace.batch-native', '宿主原生批量入口', 'archiveWorkspaceSessions', 'write'),
  ]
  return {
    ok: true,
    host: { version: '0.1.5-rc.2', modules: { '@deepseek-ai/dsh-workspace': 'C:/x/dsh-workspace/lib/index.js' } },
    sameAsHost: { '@deepseek-ai/dsh-workspace': true, '@deepseek-ai/dsh-tools': true },
    findings,
    degraded: [degradedItem],
    blockers: [],
    mayDelete: true,
    verifiedVersion: '0.1.5-rc.2',
    expectedPeerRange: '>=0.1.5-rc.2',
    generatedAt: 1757836000000,
    summary: '宿主 0.1.5-rc.2 · 能力 ' + String(findings.length - 1) + '/' + String(findings.length) + ' · 降级 1 项',
  }
}

/**
 * 预设可达性 fixture：形状按 `preset-reach` op 的实回（src/compat/preset-reach.ts）。
 * 刻意带上一个**被压制**的预设，让「被压制」那一支的回调也真的执行一次。
 */
function presetReachFixture() {
  return {
    ok: true,
    rows: [
      {
        presetId: 'standard', name: '标准模式', trust: 'system', isDefault: true,
        personaComplete: false, personaMounted: true, suppressing: false,
        agentInstructions: 'mounted', toolSkill: 'mounted',
        memory: 'ok', agentsMd: 'ok', skillCatalog: 'ok',
      },
      {
        presetId: 'minimal', name: '极简模式', trust: 'system', isDefault: false,
        personaComplete: true, personaMounted: true, suppressing: true,
        agentInstructions: 'absent', toolSkill: 'absent',
        memory: 'suppressed', agentsMd: 'absent', skillCatalog: 'absent',
      },
    ],
    defaultId: 'standard',
    generatedAt: 1757836000000,
    summary: '预设 2 个 · 压制型预设（本插件默认不注入）1 个 · 技能目录缺失 1 个',
    blockers: [],
  }
}

/** 注入设置 fixture：形状按 `inject-settings` op 的实回（src/context-inject.ts）。 */
function injectSettingsFixture() {
  return {
    ok: true,
    settings: {
      underSuppressingPresets: false,
      domains: { memory: true, mcp: true, subagents: true, prompt: true, skills: true },
    },
  }
}

/**
 * 「注入实况」fixture（形状按 `injection-live` op 的实回，src/context-inject.ts）。
 *
 * 存在的理由只有一个：让实况面板**带着数据**渲染一遍。没有它，这个 op 落到默认的
 * `{ ok: true }`，面板只走"空列表"那条分支 —— 有数据才走到的那几行（采纳统计、状态胶囊）
 * 就永远没被渲染过。这里只提供数据，不写断言：断言在冒烟测试那一侧统一是"不抛错"。
 * 覆盖到的状态：in-context（有正文）、child（本会话不适用）、official（官方载体在送）。
 */
function injectionLiveFixture() {
  return {
    ok: true,
    hasAgent: true,
    delivered: { count: 3, lastAt: Date.now(), byDomain: { memory: 1, mcp: 1 } },
    observed: { toolCalls: 5 },
    domains: [
      { key: 'memory', label: '场景和记忆', kind: 'scene-memory-manager-catalog', state: 'in-context', bytes: 120, text: 'MEM-BODY', adoption: { injected: 1, used: 2, adopted: 2 } },
      { key: 'mcp', label: 'MCP 服务器', kind: 'mcp-manager-catalog', state: 'in-context', bytes: 40, text: 'MCP-BODY', adoption: { injected: 1, used: 0, adopted: 0 } },
      { key: 'skills', label: '技能目录', kind: 'skill-manager-catalog', state: 'official', bytes: 30, text: 'SKILL-BODY', adoption: { injected: 0, used: 0, adopted: 0 } },
      { key: 'subagents', label: '子智能体', kind: 'subagent-manager-catalog', state: 'child', bytes: 0, text: '', adoption: { injected: 0, used: 0, adopted: 0 } },
      { key: 'prompt', label: '提示词', kind: 'prompt-manager-catalog', state: 'off', bytes: 0, text: '', adoption: { injected: 0, used: 0, adopted: 0 } },
    ],
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
function fakeCtx(slots, dict, lang) {
  // 默认中文表；传 lang='en' 时改用英文表。
  const table = (dict && dict[lang || 'zh']) || {}
  return {
    get: (name) => (name === 'slots' ? slots : undefined),
    interval: () => (() => {}),
    timeout: () => (() => {}),
    locale: {
      register: () => (() => {}),
      // 宿主 locale.bind(ns) 返回的取词函数签名是 (key, params)。
      bind: () => (key, params) => {
        let text = table[key] || key
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
  const useEffectImpl = function (effect, deps) {
    const index = current.__cursor++
    const slot = slotAt(index, () => ({ deps: undefined, effect: undefined }))
    const changed = slot.deps === undefined || deps === undefined
      || deps.length !== slot.deps.length || deps.some((d, i) => !Object.is(d, slot.deps[i]))
    if (!changed) return
    slot.deps = deps ? deps.slice() : undefined
    slot.effect = effect
    pendingEffects.push({ component: current, effect, cleanup: slot.cleanup })
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
    useEffect: useEffectImpl,
    // 真 React 里 layout effect 在提交后、绘制前执行；这个假 dispatcher 不区分提交阶段，
    // 用同一实现即可 —— 客户端里的 useFlipReorder 在没有 DOM 的测试环境会直接跳过。
    useLayoutEffect: useEffectImpl,
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

test('apply 装配：注册 settings.section（slots 缺失时会静默什么都不注册，这条挡住白屏）', () => {
  const exported = loadModule()
  const slots = fakeSlots()
  exported.apply(fakeCtx(slots, exported.dict))
  assert.deepEqual(slots.injected, ['settings.section'], 'apply 必须往 settings.section 注入一次')
  assert.equal(slots.registered.length, 1, '并且注册恰好一个设置项')
  assert.equal(typeof slots.registered[0].label, 'function', '设置项标签必须是函数（宿主按当前语言取词）')
})

test('apply 装配：页面组件全部填充，且都是函数', () => {
  const exported = loadModule()
  exported.apply(fakeCtx(fakeSlots(), exported.dict))
  const pages = exported.pages
  assert.ok(Object.keys(pages).length > 1, 'pages 必须是填充过的对象（apply 是否提前返回了？）')
  for (const [name, value] of Object.entries(pages)) {
    assert.equal(typeof value, 'function', `pages.${name} 未被填充（apply 是否提前返回了？）`)
  }
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
