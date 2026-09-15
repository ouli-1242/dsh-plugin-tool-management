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

/**
 * 测试用：替换 `rules-list` 的场景清单（null = 用默认三场景）。
 * 「只剩保留场景 global」是用户机器的真实形状——场景页必须显示空态，而不是列出一张全局卡片。
 */
let scenesFixtureOverride = null

/**
 * 兼容页 fixture 模式：
 * - `'blocked'`（默认）：一项真降级 + 三项可选槽位缺失 + 一个阻塞项；
 * - `'optional-only'`：**只有**宿主本来就没有的原生入口缺失，其余全通过、无阻塞 ——
 *   插件自己顶上，结论条不得着色（这是本页唯一必须守住的口径）；
 * - `'healthy'`：全部通过。
 */
let compatFixtureMode = 'blocked'

/**
 * 兼容页 fixture 构造器：形状按宿主实回（`/compat-status`）来，两类"非 ok"都覆盖到：
 *
 * - **optional**（`workspace.delete-native` 等）：宿主没有这个入口，插件自己顶上 ——
 *   功能完好，必须显示为"插件适配层"，**不得**出现在降级清单、**不得**说按钮被禁用。
 *   本机 rc.2 的真实形状就是这三个槽位都缺。
 * - **真降级**（`projection.write`）：能力不可用且插件也补不上 → 才进降级清单。
 */
function compatFixture() {
  const healthy = compatFixtureMode === 'healthy'
  const optionalOnly = compatFixtureMode === 'optional-only'
  const withRealDegrade = compatFixtureMode === 'blocked'
  const ok = (id, label, kind, fallback, owner) => ({ id, label, kind, fallback, owner, state: 'ok', detail: '成员齐备', missing: [] })
  const optionalAbsent = (id, label, missingName, kind) => ({
    id, label, kind, owner: 'workspace', fallback: 'native-entry', optional: true,
    state: 'missing-member', detail: '宿主实现缺少 ' + missingName, missing: [missingName],
  })
  const degradedItem = {
    // 真降级选 projection.write：它在五条动作路由里**都不是**必需项，所以断言
    // "本 fixture 下没有不可用动作"仍然成立。若拿 sessions.detach-live 当降级样本，
    // 删除路由会合理地变成"不可用"，那条断言就会误报（fixture 与断言互相打架）。
    id: 'projection.write', label: '投影缓存写入路径', kind: 'write', owner: 'projectionCache',
    fallback: 'disable-destructive', state: 'missing-member', detail: '宿主实现缺少 put', missing: ['put'],
  }
  const findings = [
    ok('workspace.read-state', '读取工作区状态', 'read', 'degrade-read', 'workspace'),
    ok('workspace.enqueue', '串行写事务', 'write', 'disable-destructive', 'workspace'),
    ok('workspace.set-state', '写工作区状态', 'write', 'disable-destructive', 'workspace'),
    ok('workspace.index-header', '索引会话头部', 'write', 'disable-destructive', 'workspace'),
    ok('projection.delete-native', '投影缓存删除屏障', 'delete', 'native-entry', 'projectionCache'),
    healthy
      ? ok('workspace.delete-native', '宿主原生删除入口', 'delete', 'native-entry', 'workspace')
      : optionalAbsent('workspace.delete-native', '宿主原生删除入口', 'deleteSession', 'delete'),
    ok('sessions.cold-announce', '冷会话移除广播', 'delete', 'disable-destructive', 'sessions'),
    ok('sessions.detach-live', '实时会话落盘与分离', 'delete', 'disable-destructive', 'sessions'),
    withRealDegrade ? degradedItem : ok('projection.write', '投影缓存写入路径', 'write', 'disable-destructive', 'projectionCache'),
    optionalAbsent('workspace.unarchive-native', '宿主原生恢复入口', 'unarchiveSession', 'write'),
    optionalAbsent('workspace.batch-native', '宿主原生批量入口', 'archiveWorkspaceSessions', 'write'),
  ]
  const degraded = withRealDegrade ? [degradedItem] : []
  return {
    ok: true,
    host: { version: '0.1.5-rc.2', modules: { '@deepseek-ai/dsh-workspace': 'C:/x/dsh-workspace/lib/index.js' } },
    sameAsHost: { '@deepseek-ai/dsh-workspace': true, '@deepseek-ai/dsh-tools': !withRealDegrade },
    findings,
    degraded,
    blockers: withRealDegrade
      ? ['@deepseek-ai/dsh-tools：插件与宿主加载的是两份不同拷贝（运行 node scripts/host-deps.mjs --fix）']
      : [],
    mayDelete: true,
    verifiedVersion: '0.1.5-rc.2',
    expectedPeerRange: '>=0.1.5-rc.2',
    generatedAt: 1757836000000,
    summary: '宿主 0.1.5-rc.2 · 能力 ' + String(findings.length - degraded.length) + '/' + String(findings.length)
      + (degraded.length ? ' · 降级 ' + String(degraded.length) + ' 项' : ' · 全部可用'),
  }
}

/**
 * 预设可达性 fixture：形状按 `preset-reach` op 的实回（src/compat/preset-reach.ts）。
 *
 * 刻意带上一个**被压制**的预设：`minimal` 的 persona 是 complete，场景记忆与
 * AGENTS.md 都进不了提示词。全部 `{ok:true}` 的空响应会让"被压制"那一支的回调
 * 一次都不执行——那等于新增的渲染路径从没被跑过，而本文件存在的理由正是抓这种空白。
 */
function presetReachFixture() {
  return {
    ok: true,
    rows: [
      {
        presetId: 'standard', name: '标准模式', trust: 'system', isDefault: true,
        personaComplete: false, personaMounted: true,
        agentInstructions: 'mounted', toolSkill: 'mounted',
        memory: 'ok', agentsMd: 'ok', skillCatalog: 'ok',
      },
      {
        presetId: 'minimal', name: '极简模式', trust: 'system', isDefault: false,
        personaComplete: true, personaMounted: true,
        agentInstructions: 'absent', toolSkill: 'absent',
        memory: 'suppressed', agentsMd: 'suppressed', skillCatalog: 'absent',
      },
    ],
    defaultId: 'standard',
    generatedAt: 1757836000000,
    summary: '预设 2 个 · 抑制记忆注入 1 个 · 技能目录缺失 1 个',
    blockers: [],
  }
}

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
      return { ok: true, rules, groups: [{ name: 'global', label: '全局', order: 0, count: 1 }], scenes: scenesFixtureOverride || scenes, activeMode: 'all', sceneMemory: { usedBytes: 660, maxBytes: 65536, truncated: false, dropped: [] }, paths: { memories: 'C:/m', scenes: 'C:/s', hub: 'C:/h' }, stats: { total: 3, enabled: 2, scenes: 3 } }
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
    // 兼容页的假响应按宿主实回形状给出。默认 fixture **刻意带一项降级 + 一个阻塞项**：
    // 全部 ok 的响应会让降级/阻塞两块的回调一次都不执行，那两块就等于没被渲染过。
    // `compatFixtureMode = 'optional-only' | 'healthy'` 时改成对应的另一支。
    case 'compat-status':
      return compatFixture()
    case 'preset-reach':
      return presetReachFixture()
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
function fakeCtx(slots, dict, lang) {
  // 默认中文表；传 lang='en' 时改用英文表（供"英文界面不得露出中文"这类回归用）。
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
 * 场景卡片的**描述契约**（纯函数，可直接调）。
 *
 * 来自一次真实反馈：「描述也要有字数限制，不然会导致全局变成纵向布局」——
 * 描述是自由文本，卡片只留一行，不裁就会把卡片撑成纵向。
 *
 * 只断言**函数行为**（裁到上限、压平空白）；具体 CSS 与视觉排版不做逐条断言 ——
 * 用户裁定（2026-09-15）：排版/文案的逐条断言是刻舟求剑，改一次样式就要改一次断言，
 * 真实观感由人在页面上确认。
 */
test('场景卡片描述：只显示描述、超长必裁', () => {
  const exported = loadModule()
  exported.apply(fakeCtx(fakeSlots(), exported.dict))
  const { sceneTileDesc, sceneDescMax, clipText } = exported.pages
  for (const [name, fn] of Object.entries({ sceneTileDesc, clipText })) {
    assert.equal(typeof fn, 'function', `pages.${name} 未导出（测试接缝丢失）`)
  }
  const max = sceneDescMax()
  assert.ok(max >= 20 && max <= 120, `描述字数上限不合理：${max}`)

  // 场景页卡片：只有描述（数量已收进页首的「当前模式」条）。
  assert.equal(sceneTileDesc({ description: '写周报与站会', count: 7 }), '写周报与站会')

  // 超长描述必裁到上限并以省略号结尾。
  const clipped = sceneTileDesc({ description: '一'.repeat(200) })
  assert.equal(clipped.length, max, `裁剪后长度应为上限 ${max}，实际 ${clipped.length}`)
  assert.equal(clipped.endsWith('…'), true, '裁剪后应以省略号结尾')
  assert.equal(clipText('  a\n\nb  ', 10), 'a b', '裁剪前应压平空白')
})

/**
 * 档案弹窗「记忆」段的**作用域契约**（纯函数，可直接调）。
 *
 * 宿主侧 `memoryAllowed(archives, file.scene, id)` 是按**记忆所属场景**取档案的
 * （`src/rules/archive.ts:135`，渲染调用点 `src/rules/service.ts:1044`；回归测试
 * `hub-layout.test.mjs`「保留场景 global 的记忆不受其它场景的勾选段影响」）。
 * 所以一个场景的记忆段**只能门控它自己的记忆**：列别的场景（含全局）是陷阱——勾了不生效。
 * 用户也对齐了这一点：「其他场景的记忆也不需要显示全局」。
 */
test('记忆段只认本场景的记忆：全局与其它场景都不出现，多级分组按一级目录归位', () => {
  const exported = loadModule()
  exported.apply(fakeCtx(fakeSlots(), exported.dict))
  const { sceneMemoriesOf, sceneOfGroup, memDefaultPickIds } = exported.pages
  for (const [name, fn] of Object.entries({ sceneMemoriesOf, sceneOfGroup, memDefaultPickIds })) {
    assert.equal(typeof fn, 'function', `pages.${name} 未导出（测试接缝丢失）`)
  }
  const memories = [
    { id: 'global/总则', scene: 'global', name: '总则', description: '跨项目通用约定' },
    { id: '办公/周报格式', scene: '办公', name: '周报格式', description: '写周报' },
    { id: '办公/流程/站会', scene: '办公/流程', name: '站会', description: '站会只说三件事' },
    { id: '生活/记账', scene: '生活', name: '记账', description: '记账格式' },
  ]
  // ① 只出本场景自己的；多级分组（办公/流程）按一级目录归到「办公」——否则那条记忆整个看不见。
  // 顺序依赖 locale（站会 / 周报格式 谁在前由拼音定），所以比较集合而不是顺序。
  const ids = (list) => list.map((m) => m.id).sort()
  assert.deepEqual(ids(sceneMemoriesOf(memories, '办公')), ['办公/流程/站会', '办公/周报格式'].sort())
  assert.deepEqual(ids(sceneMemoriesOf(memories, 'global')), ['global/总则'], '全局只在自己的档案里出现')
  assert.deepEqual(ids(sceneMemoriesOf(memories, '生活')), ['生活/记账'])
  assert.deepEqual(sceneMemoriesOf(memories, '不存在'), [])
  assert.equal(sceneOfGroup('办公/流程/站会'), '办公')
  assert.equal(sceneOfGroup('global'), 'global')

  // ② 默认勾选 = 本场景里已启用的那几条（全局/别的场景一条都不进来）。
  const rules = [
    { id: 'global/总则', group: 'global', enabled: true },
    { id: '办公/周报格式', group: '办公', enabled: true },
    { id: '办公/流程/站会', group: '办公/流程', enabled: false },
    { id: '生活/记账', group: '生活', enabled: true },
  ]
  assert.deepEqual(memDefaultPickIds(memories, rules, '办公'), ['办公/周报格式'])
  assert.deepEqual(memDefaultPickIds(memories, rules, 'global'), ['global/总则'])
  assert.deepEqual(memDefaultPickIds(memories, [], '办公'), [], '拿不到 rules 时不预勾，宁少不滥')
})

/**
 * 档案弹窗各段的**默认勾选**契约（用户要求）：
 *   - MCP 工具集 / 技能集 / 子智能体绑定：点「添加」后一律**不勾选**；
 *   - 记忆：只勾**本场景里已启用**的那几条（作用域见上一条用例），「全选」= 本场景全部。
 * 记忆的默认值是唯一的真逻辑（memDefaultPickIds），直接调；三段的「添加即空集」是界面动作，
 * 由人在页面上确认（源码文本守卫是刻舟求剑，改一次实现就要改一次正则）。
 */
test('档案弹窗：记忆默认只勾本场景已启用的', () => {
  const exported = loadModule()
  exported.apply(fakeCtx(fakeSlots(), exported.dict))
  const { memDefaultPickIds } = exported.pages
  assert.equal(typeof memDefaultPickIds, 'function', 'pages.memDefaultPickIds 未导出（测试接缝丢失）')

  const memories = [
    { id: 'global/总则', scene: 'global', name: '总则', description: 'x' },
    { id: '办公/周报', scene: '办公', name: '周报', description: 'z' },
    { id: '办公/停用的', scene: '办公', name: '停用的', description: 'y' },
  ]
  const rules = [
    { id: 'global/总则', group: 'global', enabled: true },
    { id: '办公/周报', group: '办公', enabled: true },
    { id: '办公/停用的', group: '办公', enabled: false },
  ]
  assert.deepEqual(memDefaultPickIds(memories, rules, '办公'), ['办公/周报'], '默认只勾本场景 + 已启用')
  assert.deepEqual(memDefaultPickIds(memories, [], '办公'), [], '拿不到 rules（老宿主/请求失败）时不预勾，宁少不滥')
  assert.deepEqual(memDefaultPickIds([{ id: '办公/a', scene: '办公' }], [{ id: '办公/a', enabled: undefined }], '办公'), ['办公/a'], 'enabled 缺省视为启用（与记忆页一致）')

  // 源码守卫：三段的「添加」动作必须是空集（默认不勾选）。
  assert.match(src, /\{ mcp: emptyMcpPreset\(\) \}/, 'MCP 工具集「添加」必须默认不勾选')
  assert.match(src, /\{ skills: \[\] \}/, '技能集「添加」必须默认不勾选')
  assert.match(src, /subagents: \[\] \}/, '子智能体绑定「添加」必须默认不勾选')
  // P5 契约变更：记忆段不再是「可选段」—— 勾选状态**就是** `rules[*].enabled`
  // （与记忆页同一个写入口），所以：
  //   ① 「全选 / 全不选」走批量写 enabled，而不是往档案里塞一个 memories 数组；
  //   ② 保存档案的 payload 里不再出现 memories 段。
  assert.match(src, /function setAllMemories\(on\)/, '记忆段「全选/全不选」必须走批量写 enabled')
  assert.match(src, /rules-toggle', \{ id: id, enabled: on \}/, '批量写必须逐个调 rules-toggle')
  assert.doesNotMatch(src, /payload\.memories = /, '档案保存不再写 memories 段（P5 单一真相源）')
})

test('apply 装配：注册 settings.section（slots 缺失时会静默什么都不注册，这条挡住白屏）', () => {
  const exported = loadModule()
  const slots = fakeSlots()
  exported.apply(fakeCtx(slots, exported.dict))
  assert.deepEqual(slots.injected, ['settings.section'], 'apply 必须往 settings.section 注入一次')
  assert.equal(slots.registered.length, 1, '并且注册恰好一个设置项')
  assert.equal(slots.registered[0].id, 'dsm-tools')
  assert.equal(typeof slots.registered[0].label, 'function')
  assert.equal(slots.registered[0].label(), '工具')
  assert.equal(slots.registered[0].order, 16)
})

test('apply 装配：页面组件全部填充，且都是函数', () => {
  const exported = loadModule()
  exported.apply(fakeCtx(fakeSlots(), exported.dict))
  const pages = exported.pages
  const names = ['MCPPage', 'SkillManagerSection', 'AgentsMdPage', 'HistoryPage', 'ScenesPage', 'SubagentsPage', 'MemoryPage', 'CompatPage']
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
test('场景页：模式条按状态出现/消失，卡片网格照常渲染（只看结构，不断言文案）', async () => {
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

  modeSceneFixture = null
  const freeMode = await renderMode()
  assert.equal(freeMode.classes.has('dsm-mode-bar'), false, '没进任何模式时不该有模式条')
  // 反向护栏：卡片本身照常渲染（别把整页一起弄没了）。
  assert.ok(freeMode.classes.has('dsm-scenes'), '场景卡片网格必须仍在渲染')
  assert.equal(freeMode.classes.has('dsm-scene-tile'), true, '场景卡片必须仍在渲染')

  // 保留场景「全局」不在场景页出现（用户裁定：全局恒定注入、skills/MCP 各有专页，列成卡片只是噪声）。
  // 只断言**结构**（卡片数），具体标签与文案由人在页面上看。
  scenesFixtureOverride = [{ name: 'global', label: '全局', order: 0, count: 2, active: true, shared: false, global: true, description: '' }]
  const onlyGlobal = await renderMode()
  assert.equal(onlyGlobal.classes.has('dsm-scene-tile'), false, '只剩全局时不该有任何场景卡片')
  scenesFixtureOverride = null
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

/**
 * 渲染兼容页并收集 class / 文本（含 effect 跑完、数据到达后的那一遍）。
 * @returns 收集结果与请求过的 op 列表。
 */
async function renderCompatPage(lang) {
  const calls = []
  const prevFetch = globalThis.fetch
  globalThis.fetch = makeFetch(calls)
  try {
    const exported = loadModule({ fetchImpl: globalThis.fetch })
    exported.apply(fakeCtx(fakeSlots(), exported.dict, lang))
    const view = createDispatcher()
    // `collected` 每轮重建、只保留最后一轮（数据已到达）的文本：
    // 兼容页的数据是异步到的，若把各轮结果累加，loading 态的文本会混进断言。
    let collected = { classes: new Set(), text: [], summary: '' }
    const collect = (element, seen = new Set(), out = collected) => {
      if (element === null || element === undefined || typeof element === 'boolean') return out
      if (typeof element === 'string' || typeof element === 'number') { out.text.push(String(element)); return out }
      if (Array.isArray(element)) { for (const item of element) collect(item, seen, out); return out }
      if (typeof element !== 'object' || element.type === undefined) return out
      if (typeof element.type === 'function') {
        if (seen.has(element.type)) return out
        seen.add(element.type)
        collect(view.render(element.type, element.props), seen, out)
        return out
      }
      const cls = element.props && element.props.className
      if (typeof cls === 'string') for (const name of cls.split(/\s+/)) if (name) out.classes.add(name)
      // 结论条那整句单独留一份：它必须由客户端按当前语言拼，不能渲染服务端返回的中文 summary。
      if (typeof cls === 'string' && cls.includes('dsm-compat-sum') && typeof (element.props && element.props.children) === 'string') {
        out.summary = element.props.children
      }
      collect(element.props && element.props.children, seen, out)
      return out
    }
    for (let pass = 0; pass < 4; pass += 1) {
      const tree = view.renderTree(React.createElement(exported.pages.CompatPage, { t: exported.pages.t }))
      assert.deepEqual(tree.failures, [], `兼容页渲染抛错:\n${tree.failures.join('\n')}`)
      try { view.runEffects() } catch (error) { assert.fail(`effect 抛错：${error && error.message}`) }
      await settle()
      collected = { classes: new Set(), text: [], summary: '' }
      collect(React.createElement(exported.pages.CompatPage, { t: exported.pages.t }))
    }
    assert.ok(calls.includes('compat-status'), '兼容页没有请求 compat-status（用例没生效）')
    return { out: collected, calls }
  } finally {
    if (prevFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = prevFetch
  }
}

/**
 * 兼容页：宿主升级后用户该看的那一页。
 *
 * 只断言**结构与状态**（渲染不抛错 + 请求发出 + 结论条是否着色），不含任何文案/排版逐条断言
 * —— 用户裁定（2026-09-15）：那些断言是刻舟求剑，页面观感由人在真实页面上确认。
 *
 * 保留项目里唯一重要的那条业务口径：**宿主没提供原生入口 ≠ 降级**
 * （删除/恢复/批量入口官方本来就没有，插件自己顶上，功能完好，结论条不得变红）。
 */
test('兼容页：只缺官方入口时不着色，渲染不抛错', async () => {
  compatFixtureMode = 'optional-only'
  try {
    const { out, calls } = await renderCompatPage()
    assert.ok(calls.includes('compat-status'), '兼容页没有请求 compat-status')
    assert.ok(out.classes.has('dsm-compat'), '整页必须用 dsm-compat 容器')
    assert.equal(out.classes.has('dsm-compat-bar-warn'), false, '只缺官方入口时结论条不得标成"需要处理"')
    assert.equal(out.classes.has('dsm-compat-pill-warn'), false, '只缺官方入口时不得出现降级标记')
  } finally {
    compatFixtureMode = 'blocked'
  }
})

test('兼容页：真有阻塞项/真降级时才着色', async () => {
  compatFixtureMode = 'blocked'
  const { out } = await renderCompatPage()
  assert.ok(out.classes.has('dsm-compat-bar-warn'), '真有阻塞项时结论条必须着色')
  assert.ok(out.classes.has('dsm-compat-pill-warn'), '真降级项必须带降级标记')
})

/**
 * 兼容页的结论条：由客户端按当前语言拼（服务端 `compat-status` 的 summary 是中文）。
 *
 * 这是**本地化契约**而不是文案断言：断言的是"英文界面下这一句不能出现中文"，
 * 不锁具体措辞（措辞改了这条仍然通过）。曾经的缺陷就是英文界面照抄服务端中文。
 */
test('兼容页：英文界面下结论条不得露出中文', async () => {
  compatFixtureMode = 'optional-only'
  try {
    const { out } = await renderCompatPage('en')
    assert.ok(out.summary, '没有渲染出结论条（用例没生效）')
    assert.equal(/[\u4e00-\u9fff]/.test(out.summary), false, '英文界面下结论条出现中文：' + out.summary)
    assert.match(out.summary, /host |capabilities /, '英文界面下结论条应当走英文词典：' + out.summary)
  } finally {
    compatFixtureMode = 'blocked'
  }
})

/**
 * 兼容页「预设注入边界」——本页新增的那一支渲染路径。
 *
 * fixture 的唯一作用是把它**跑起来**：这段代码只在 `preset-reach` 带回 rows 时才执行，
 * 空响应下一次都不跑，等于没测。
 *
 * 断言只留语义契约，不锁文案、符号与类名——用户裁定（2026-09-14）：文案与排版的逐条
 * 断言是刻舟求剑，改一次样式就要改一次断言，页面观感由人在真实页面上确认：
 *   ① 带数据渲染整页不抛错（本文件存在的理由就是抓渲染期抛错，见文件头）；
 *   ② 请求真的发出去了（反向护栏，否则遍历等于空跑）；
 *   ③ 预设压制**不得**冒充宿主降级——这是业务口径而非排版：它既不是宿主缺能力、
 *      也不是插件故障，混用标记会让人以为自己的安装坏了。
 * 用 `optional-only` 跑，是为了让页面上不可能出现降级标记，于是 ③ 才真的在测这一节。
 */
test('兼容页：预设注入边界带数据渲染不抛错，且不冒充宿主降级', async () => {
  compatFixtureMode = 'optional-only'
  try {
    const { out, calls } = await renderCompatPage()
    assert.ok(calls.includes('preset-reach'), '兼容页没有请求 preset-reach（用例没生效）')
    assert.equal(out.classes.has('dsm-compat-pill-warn'), false, '预设压制不得冒充宿主降级标记')
    assert.equal(out.classes.has('dsm-compat-bar-warn'), false, '预设压制不得把结论条染成"需要处理"')
  } finally {
    compatFixtureMode = 'blocked'
  }
})
