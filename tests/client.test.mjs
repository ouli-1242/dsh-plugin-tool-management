// Client-half wiring tests.
//
// The browser bundle is plain JavaScript served straight from lib/client.js, so
// a broken event handler is invisible to the host-side tests: React swallows the
// exception and the click simply does nothing. That is exactly how the shipped
// "switch does nothing" bug slipped through (an event handler referenced an
// identifier that no longer existed).
//
// These tests load the real bundle in a VM with a tiny React stand-in, render the
// Skills settings page, click its controls and assert the host ops they issue.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

// ---------- minimal React ----------
const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i])

function createReact() {
  const cells = []
  let cursor = 0
  let effects = []
  let dirty = false
  let current = null // { component, props }
  let latestTree = null // element tree produced by the most recent render pass

  const React = {
    Fragment: Symbol('react.fragment'),
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props || {})
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState(initial) {
      const i = cursor++
      if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial
      return [cells[i], (value) => {
        cells[i] = typeof value === 'function' ? value(cells[i]) : value
        dirty = true
      }]
    },
    useRef(initial) {
      const i = cursor++
      const key = 'ref' + i
      if (!(key in cells)) cells[key] = { current: initial }
      return cells[key]
    },
    useMemo(factory, deps) {
      const i = cursor++
      const key = 'memo' + i
      const prev = cells[key]
      if (prev && sameDeps(prev.deps, deps)) return prev.value
      const value = factory()
      cells[key] = { deps, value }
      return value
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
    useEffect(fn, deps) {
      const i = cursor++
      const key = 'fx' + i
      const prev = cells[key]
      if (!prev || !sameDeps(prev.deps, deps)) {
        effects.push(fn)
        cells[key] = { deps }
      }
    },
  }

  const renderOnce = (component, props) => {
    cursor = 0
    effects = []
    current = { component, props }
    latestTree = component(props)
    for (const effect of effects) effect()
    return latestTree
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  /** Render to quiescence: effects may schedule state updates that re-render.
   *  Each explicit render starts from a fresh hook state (components are not
   *  recursive here, so a top-level render of a nested function component must
   *  not inherit another component's hook cells). */
  async function render(component, props) {
    for (const key of Object.keys(cells)) delete cells[key]
    effects = []
    dirty = false
    cursor = 0
    renderOnce(component, props)
    for (let round = 0; round < 40; round++) {
      await tick()
      if (dirty) {
        dirty = false
        renderOnce(current.component, current.props)
      } else if (round > 2) break
    }
    return latestTree
  }

  async function settle() {
    for (let round = 0; round < 40; round++) {
      await tick()
      if (dirty) {
        dirty = false
        renderOnce(current.component, current.props)
      } else if (round > 2) break
    }
    return latestTree
  }

  return { React, render, settle, tick, getTree: () => latestTree }
}

// ---------- element-tree helpers ----------
function collect(node, predicate, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  if (node.props && node.props.children !== undefined) collect(node.props.children, predicate, out)
  return out
}

const byClass = (tree, className) => collect(tree, (node) => (
  typeof (node.props || {}).className === 'string' &&
  node.props.className.split(/\s+/).includes(className)
))

const switchesOf = (tree, parent) => collect(parent, (node) => (
  typeof node.type === 'function' && node.type.name === 'Switch'
))

// Modal / SourceSelect 是函数组件：minimal React 不递归渲染，元素本身保留在树里，
// 用组件类型名（而非渲染后的类名）定位。
const findModal = (tree) => collect(tree, (node) => (
  typeof node.type === 'function' && node.type.name === 'Modal'
))

// ---------- harness ----------
function makePage(opts) {
  opts = opts || {}
  const requests = []
  const disabled = new Set()
  const loads = []

  const statePayload = () => ({
    roots: [{
      key: 'agents',
      path: '/home/u/.agents/skills',
      label: '公共 Agent',
      mutable: false,
      toggleable: true,
      native: true,
      rank: 450,
      scope: 'user',
      exists: true,
      truncated: false,
      enabled: true,
      count: 1,
      skills: [{
        name: 'demo-skill',
        declaredName: 'demo-skill',
        description: 'Demo skill',
        kind: 'bundle',
        path: '/home/u/.agents/skills/demo-skill/SKILL.md',
        enabled: !disabled.has('demo-skill'),
        loadable: true,
        modelInvocable: !disabled.has('demo-skill'),
        userInvocable: true,
        managerEnabled: !disabled.has('demo-skill'),
        invocationPolicyValid: true,
        hasFrontmatter: true,
        diagnostics: [],
      }],
    }],
    projects: [],
    trash: [],
    warnings: [],
    summary: {
      total: 1,
      enabled: disabled.has('demo-skill') ? 0 : 1,
      disabled: disabled.has('demo-skill') ? 1 : 0,
      issues: 0,
    },
  })

  // MCP-page fixture: one project-level HTTP server; mcpm-set-enabled flips
  // its flag so a reload reflects the write.
  const mcpState = { enabled: true }
  const mcpPayload = () => ({
    rows: [{
      id: 'mcp-demo',
      serverName: 'demo',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      command: null,
      args: null,
      env: null,
      headers: null,
      level: 'project',
      disabled: !mcpState.enabled,
      managed: true,
      toolCount: 1,
      live: { enabled: true, phase: 'active' },
    }, {
      id: 'mcp-offline',
      serverName: 'offline',
      transport: 'stdio',
      url: null,
      command: 'echo hi',
      args: null,
      env: null,
      headers: null,
      level: 'global',
      disabled: false,
      managed: true,
      toolCount: 0,
      live: null,
    }],
    paths: { project: '/p/cordis.patch.yml', global: '/g/cordis.patch.yml', home: '/home/u', profile: 'web' },
    errors: [],
  })

  const fetchImpl = (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push({ op: body.op, args: body.args })
    let payload
    if (body.op === 'skill-state') payload = { ok: true, data: statePayload() }
    else if (body.op === 'skill-detail') {
      payload = {
        ok: true,
        data: {
          path: '/home/u/.agents/skills/demo-skill/SKILL.md',
          diagnostics: [],
          body: '# demo-skill',
          frontmatter: { name: 'demo-skill', description: 'Demo skill' },
        },
      }
    }
    else if (body.op === 'skill-disable') { disabled.add(body.args.name); payload = { ok: true, data: {} } }
    else if (body.op === 'skill-enable') { disabled.delete(body.args.name); payload = { ok: true, data: {} } }
    // MCP ops answer with a bare object (no { ok, data } envelope), matching
    // the host route, which returns each handler's own result.
    else if (body.op === 'mcpm-list') payload = Object.assign({ ok: true }, mcpPayload())
    else if (body.op === 'mcpm-set-enabled') { mcpState.enabled = body.args.enabled === true; payload = { ok: true } }
    else if (body.op === 'mcpm-tools') {
      payload = {
        ok: true,
        tools: [{ name: 'demo_tool', description: 'Demo tool', enabled: true, parameters: [{ key: 'q', required: true, type: 'string', description: 'Query' }] }],
      }
    }
    else if (body.op === 'plugin-version') payload = { ok: true, version: '9.9.9' }
    else if (body.op === 'agentsmd-list') payload = { ok: true, presets: [{ id: 'work', active: false }, { id: 'default', active: true }] }
    else if (body.op === 'agentsmd-get-current') payload = { ok: true, content: '# current\n', presetId: 'default', exists: true }
    else if (body.op === 'agentsmd-read') payload = { ok: true, content: '# ' + (body.args && body.args.id) + '\n' }
    else if (body.op === 'history-list') {
      payload = opts.historyGrouped
        ? { ok: true, items: [
            { sessionId: 's1', createdAt: 1000, cwd: 'C:/a', title: 'Hello', archivedAt: 2000, workspaceId: 'ws1' },
            { sessionId: 's2', createdAt: 3000, cwd: 'D:/b', title: 'World', archivedAt: 4000, workspaceId: 'ws2' },
            { sessionId: 's3', createdAt: 5000, cwd: 'E:/c', title: 'Solo', archivedAt: 1000 },
          ], workspaces: { ws1: { title: 'Alpha', path: 'C:/a' }, ws2: { title: 'Beta', path: 'D:/b' } }, retentionDays: 0 }
        : { ok: true, items: [{ sessionId: 's1', createdAt: 1000, cwd: 'C:/proj', title: 'Hello', archivedAt: 2000 }, { sessionId: 's2', createdAt: 3000, cwd: 'D:/x', archivedAt: 4000 }], retentionDays: 0 }
    }
    else if (body.op === 'history-retention-get') payload = { ok: true, retentionDays: 0 }
    else if (body.op === 'history-retention-set') payload = { ok: true, retentionDays: body.args && body.args.retentionDays }
    else if (body.op === 'history-unarchive') payload = { ok: true, archivedSessionIds: [] }
    else if (body.op === 'history-delete') payload = { ok: true, sessionId: body.args && body.args.sessionId, deleted: true }
    else if (body.op === 'history-unarchive-batch') {
      const ids = (body.args && body.args.target && body.args.target.sessionIds) || []
      payload = { ok: true, unarchivedSessionIds: ids, archivedSessionIds: [] }
    }
    else if (body.op === 'history-delete-batch') {
      const ids = (body.args && body.args.target && body.args.target.sessionIds) || []
      payload = { ok: true, requestedSessionIds: ids, deletedSessionIds: ids, skippedSessionIds: [], failures: [] }
    }
    else if (body.op === 'history-import') payload = { ok: true, sessionId: 'session-99', count: 2 }
    else if (body.op === 'history-sessions') payload = {
      ok: true,
      items: [
        { sessionId: 's1', createdAt: 1000, cwd: 'C:/a', title: 'Hello', archived: true, workspaceId: 'ws1' },
        { sessionId: 's2', createdAt: 3000, cwd: 'D:/b', title: 'World', archived: true, workspaceId: 'ws2' },
        { sessionId: 's3', createdAt: 5000, cwd: 'E:/c', title: 'Solo', archived: true },
        { sessionId: 's-live', createdAt: 6000, cwd: 'C:/a', title: 'Live Session', archived: false, workspaceId: 'ws1' },
        { sessionId: 's-orphan', createdAt: 7000, cwd: 'C:/gone', title: 'Orphan', archived: false, cwdMissing: true },
      ],
    }
    else if (body.op === 'history-archive-batch') {
      const ids = (body.args && body.args.sessionIds) || []
      payload = { ok: true, archived: ids, failed: [] }
    }
    else if (body.op === 'history-export') payload = { ok: true, exported: [{ sessionId: 's1', fileName: 's1.md', path: 'D:/backups/s1.md', count: 2 }], skipped: [] }
    else if (body.op === 'history-export-defaults') payload = { ok: true, defaultDir: 'C:/Users/test/Desktop' }
    else if (body.op === 'dir-list') {
      const dir = (body.args && body.args.dir) || ''
      if (dir === 'C:/Users/test/Desktop') payload = { ok: true, current: dir, parent: 'C:/Users/test', entries: [{ name: 'backups', path: 'C:/Users/test/Desktop/backups' }] }
      else if (dir === 'C:/Users/test/Desktop/backups') payload = { ok: true, current: dir, parent: 'C:/Users/test/Desktop', entries: [] }
      else if (dir === 'C:\\') payload = { ok: true, current: dir, parent: null, entries: [{ name: 'Users', path: 'C:\\Users' }] }
      else if (dir === '') payload = { ok: true, current: '', parent: null, entries: [{ name: 'C:\\', path: 'C:\\' }, { name: 'D:\\', path: 'D:\\' }] }
      else payload = { ok: false, error: '无法读取目录: ' + dir }
    }
    else payload = { ok: true, data: {} }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
    })
  }

  const windowObj = {
    __ModuleLoader__: { load: (def) => loads.push(def) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {},
    removeEventListener() {},
  }
  windowObj.window = windowObj

  const documentObj = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', style: {} }),
    head: { appendChild() {} },
    body: {},
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  }

  const sandbox = {
    window: windowObj,
    document: documentObj,
    fetch: fetchImpl,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    // 最小 FileReader：readAsText 同步填 result 并触发 onload（导入弹窗测试用）。
    FileReader: class {
      constructor() { this.result = null; this.onload = null }
      readAsText(file) {
        this.result = String(file && file.content != null ? file.content : '')
        if (this.onload) this.onload()
      }
    },
  }
  const context = vm.createContext(sandbox)
  vm.runInContext(readFileSync(bundlePath, 'utf8'), context, { filename: 'lib/client.js' })

  const loaded = loads.find((entry) => entry.id === 'dsh-plugin-tool-management')
  assert.ok(loaded, 'bundle registers itself under the loader id the CLI mounts')
  assert.equal(typeof loaded.factory, 'function', 'bundle factory is callable')

  const { React, render, settle, getTree } = createReact()
  const mod = loaded.factory((id) => {
    if (id === 'react') return React
    throw new Error('unexpected require: ' + id)
  })
  assert.equal(mod.name, 'dsh-plugin-tool-management-client')

  const registered = []
  const slots = {
    inject: (_name, fn) => fn(),
    register: (def, renderFn) => registered.push({ def, renderFn }),
  }
  // The MCP page schedules its refresh loop through the injected timer
  // service; the Skills page does not, but the plugin injects it for both.
  mod.apply({
    get: (name) => (name === 'slots' ? slots : undefined),
    interval: () => () => {},
    timeout: () => () => {},
  })

  const tools = registered.find((entry) => entry.def.id === 'dsm-tools')
  assert.ok(tools, 'TOOLS settings section is registered')

  /** Render the TOOLS shell (tab bar + active page element). */
  async function openToolsPage() {
    const element = tools.renderFn()
    return render(element.type, element.props)
  }

  /** Render the Skills page directly (bypassing ToolsSection so minimal-React
   *  hooks isolate per-component), expanding the source card that starts collapsed. */
  async function openSkillsPage() {
    let tree = await render(mod._pages.SkillManagerSection, { t: mod._pages.t })
    if (!byClass(tree, 'dsm-row').length) {
      const headButton = byClass(tree, 'dsm-source-head-main')[0]
      assert.ok(headButton, 'source card header renders')
      headButton.props.onClick()
      await settle()
      tree = getTree()
    }
    return tree
  }

  /** Render the MCP page directly. */
  async function openMcpPage() {
    return render(mod._pages.MCPPage)
  }

  /** Render the AGENTS.md presets page directly. */
  async function openAgentsMdPage() {
    return render(mod._pages.AgentsMdPage)
  }

  /** Render the History page directly. */
  async function openHistoryPage() {
    return render(mod._pages.HistoryPage)
  }

  return { requests, render, settle, openToolsPage, openSkillsPage, openMcpPage, openAgentsMdPage, openHistoryPage, getTree, tools, registered }
}

// ---------- tests ----------

test('agents-md page: registers section, renders presets, fires agentsmd-list', async () => {
  const page = await makePage()
  assert.ok(page.tools, 'TOOLS settings section is registered')
  const tree = await page.openAgentsMdPage()
  assert.ok(tree, 'page renders without throwing')
  assert.ok(page.requests.some((r) => r.op === 'agentsmd-list'), 'fires agentsmd-list on load')
  assert.ok(page.requests.some((r) => r.op === 'agentsmd-get-current'), 'fires agentsmd-get-current on load')
  // 列表渲染两行预设（work / default）
  const rows = byClass(tree, 'dsm-source')
  assert.ok(rows.length >= 2, 'renders a card per preset')
})

test('history page: fires history-list, renders a row per archived session, retention dropdown', async () => {
  const page = await makePage()
  const tree = await page.openHistoryPage()
  assert.ok(tree, 'page renders without throwing')
  assert.ok(page.requests.some((r) => r.op === 'history-list'), 'fires history-list on load')
  // 两个归档会话 → 两行
  const rows = byClass(tree, 'dsm-hist-row')
  assert.equal(rows.length, 2, 'one row per archived session')
  // 标题来自 host best-effort；s1 有 title "Hello"
  const titles = byClass(tree, 'dsm-hist-title').map((n) => n.props.children)
  assert.ok(titles.includes('Hello'), 'session title rendered')
  // 保留期是下拉（dsm-select 风格，SourceSelect 子组件），不再是按钮组
  assert.equal(byClass(tree, 'dsm-retention-opt').length, 0, 'no button-group retention options')
  const select = collect(tree, (node) => typeof node.type === 'function' && node.type.name === 'SourceSelect')[0]
  assert.ok(select, 'retention renders as a SourceSelect dropdown')
})

test('history page: 永久删除按钮打开确认弹窗', async () => {
  const page = await makePage()
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  // 第一行的删除按钮
  const row = byClass(tree, 'dsm-hist-row')[0]
  assert.ok(row, '至少一行归档会话')
  const delBtn = byClass(row, 'dsm-btn-danger')[0]
  assert.ok(delBtn, '每行有永久删除按钮')
  delBtn.props.onClick()
  await page.settle()
  const modal = findModal(page.getTree())
  assert.ok(modal.length >= 1, '点击删除后弹出确认弹窗')
})

test('history page: 保留期下拉选择发出 history-retention-set', async () => {
  const page = await makePage()
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  // 最小 React 不递归渲染子组件，这里直接验证 SourceSelect 元素及其接线
  const select = collect(tree, (node) => typeof node.type === 'function' && node.type.name === 'SourceSelect')[0]
  assert.ok(select, 'retention renders as a SourceSelect dropdown')
  assert.equal(select.props.value, 0, 'dropdown reflects the current retention')
  assert.equal(select.props.options.map((o) => o.label).join('|'), '永久保留|7 天|30 天')
  select.props.onChange(7)
  await page.settle()
  assert.ok(page.requests.some((r) => r.op === 'history-retention-set' && r.args.retentionDays === 7), 'selecting 7 天 issues history-retention-set(7)')
})

test('TOOLS section: registers one section with four tabs', async () => {
  const page = await makePage()
  const tree = await page.openToolsPage()
  const tabs = byClass(tree, 'dsm-tab')
  assert.equal(tabs.length, 4, 'four tabs render (MCP / Skills / AGENTS.md / History)')
  const labels = tabs.map((t) => t.props.children)
  assert.deepEqual(labels, ['MCP', 'Skills', 'AGENTS.md', 'History'])
})

test('client: skills page renders a row per host skill after expanding a source', async () => {
  const page = makePage()
  const tree = await page.openSkillsPage()
  const rows = byClass(tree, 'dsm-row')
  assert.equal(rows.length, 1, 'one row rendered for the single skill')
  const names = byClass(tree, 'dsm-name').map((node) => node.props.children)
  assert.ok(names.includes('demo-skill'), 'skill name is rendered')
  const status = byClass(tree, 'dsm-status')[0]
  assert.equal(status.props.className, 'dsm-status dsm-enabled', 'enabled skill shows the enabled status')
})

test('client: row switch issues skill-disable then skill-enable (no handler errors)', async () => {
  const page = makePage()
  const tree = await page.openSkillsPage()
  const row = byClass(tree, 'dsm-row')[0]

  const rowSwitches = switchesOf(tree, row)
  assert.equal(rowSwitches.length, 1, 'row has exactly one toggle switch')
  assert.equal(rowSwitches[0].props.on, true, 'switch starts in the enabled position')
  assert.notEqual(rowSwitches[0].props.disabled, true, 'switch is clickable')

  await rowSwitches[0].props.onClick()
  await page.settle()

  const disable = page.requests.find((request) => request.op === 'skill-disable')
  assert.ok(disable, 'clicking the switch posts skill-disable')
  assert.deepEqual(disable.args, { root: 'agents', name: 'demo-skill' })

  // The page refreshes from the host after a successful write; the reloaded row
  // is now disabled, so the same control must offer skill-enable.
  const reloadedTree = await page.openSkillsPage()
  const reloadedSwitch = switchesOf(reloadedTree, byClass(reloadedTree, 'dsm-row')[0])[0]
  assert.equal(reloadedSwitch.props.on, false, 'switch reflects the persisted disabled state')
  await reloadedSwitch.props.onClick()
  await page.settle()

  const enable = page.requests.find((request) => request.op === 'skill-enable')
  assert.ok(enable, 'clicking the reloaded switch posts skill-enable')
  assert.deepEqual(enable.args, { root: 'agents', name: 'demo-skill' })
})

test('client: source switch issues skill-source-disable for the source root', async () => {
  const page = makePage()
  const tree = await page.openSkillsPage()
  const sourceHead = byClass(tree, 'dsm-source')[0]
  const sourceSwitch = switchesOf(tree, sourceHead).find((node) => !String(node.props.label).includes('demo-skill'))
  assert.ok(sourceSwitch, 'source card exposes its own switch')
  assert.equal(sourceSwitch.props.on, true, 'source starts enabled')

  await sourceSwitch.props.onClick()
  await page.settle()

  const request = page.requests.find((entry) => entry.op === 'skill-source-disable')
  assert.ok(request, 'clicking the source switch posts skill-source-disable')
  assert.deepEqual(request.args, { root: 'agents' })
})

test('client: detail button issues skill-detail for the clicked row', async () => {
  const page = makePage()
  const tree = await page.openSkillsPage()
  const row = byClass(tree, 'dsm-row')[0]
  const detailButton = collect(row, (node) => (
    node.type === 'button' &&
    typeof (node.props || {}).className === 'string' &&
    node.props.className.includes('dsm-btn-quiet')
  ))[0]
  assert.ok(detailButton, 'row exposes a detail button')

  detailButton.props.onClick()
  await page.settle()

  const request = page.requests.find((entry) => entry.op === 'skill-detail')
  assert.ok(request, 'clicking detail posts skill-detail')
  assert.deepEqual(request.args, { root: 'agents', name: 'demo-skill' })

  // The detail modal labels every section in Chinese and shows the skill
  // metadata (frontmatter) above the body text.
  const modal = page.getTree()
  const titles = byClass(modal, 'dsm-detail-title').map((node) => node.props.children)
  assert.deepEqual(titles, ['诊断', '元数据', '正文'], 'sections are Chinese and metadata sits above the body')
  const keys = byClass(modal, 'dsm-fm-key').map((node) => (Array.isArray(node.props.children) ? node.props.children[0] : node.props.children))
  assert.deepEqual(keys, ['名称', '描述'], 'frontmatter keys are shown with Chinese labels')
  const values = byClass(modal, 'dsm-fm-val').map((node) => node.props.children)
  assert.deepEqual(values, ['demo-skill', 'Demo skill'], 'frontmatter values are rendered verbatim')
})

test('client: every host op the page can post is served by the host handler table', async () => {
  const page = makePage()
  const paths = ['/state', '/enable', '/disable', '/source-enable', '/source-disable', '/delete',
    '/trash-restore', '/trash-delete', '/detail', '/create', '/import', '/upload', '/browse']
  const source = readFileSync(bundlePath, 'utf8')
  const host = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
  const service = readFileSync(join(here, '..', 'lib', 'skills', 'service.js'), 'utf8')

  const mapped = [...source.matchAll(/"(\/[a-z-]+)":\s*"(skill-[a-z-]+)"/g)].map((match) => [match[1], match[2]])
  assert.equal(mapped.length, paths.length, 'client maps every skills path to an op')
  for (const [path, op] of mapped) {
    assert.ok(paths.includes(path), 'mapped path is a known page path: ' + path)
    assert.ok(service.includes("'" + op + "':"), 'host service implements ' + op)
  }
  assert.ok(host.includes('...skillsService.ops'), 'host route merges the skill ops into its handler table')
  void page
})

test('client: mcp page renders a row per configured server', async () => {
  const page = makePage()
  const tree = await page.openMcpPage()
  const rows = byClass(tree, 'dsm-row')
  assert.equal(rows.length, 2, 'one row per configured server')
  const names = byClass(tree, 'dsm-name').map((node) => node.props.children)
  assert.ok(names.includes('demo') && names.includes('offline'), 'both server names are rendered')
  const status = byClass(tree, 'dsm-status')[0]
  assert.equal(status.props.className, 'dsm-status dsm-enabled', 'a live, tool-bearing server shows the running status')
})

test('client: mcp row switch issues mcpm-set-enabled (local update, no reload)', async () => {
  const page = makePage()
  const tree = await page.openMcpPage()
  const row = byClass(tree, 'dsm-row')[0]
  const listCallsBefore = page.requests.filter((entry) => entry.op === 'mcpm-list').length

  const rowSwitches = switchesOf(tree, row)
  assert.equal(rowSwitches.length, 1, 'row has exactly one toggle switch')
  assert.equal(rowSwitches[0].props.on, true, 'switch starts in the enabled position')
  assert.notEqual(rowSwitches[0].props.disabled, true, 'switch is clickable')

  await rowSwitches[0].props.onClick()
  await page.settle()

  const request = page.requests.find((entry) => entry.op === 'mcpm-set-enabled')
  assert.ok(request, 'clicking the switch posts mcpm-set-enabled')
  assert.deepEqual(request.args, { id: 'mcp-demo', level: 'project', enabled: false })

  // The clicked row is updated in place: no list reload, no scroll jump.
  const updated = page.getTree()
  const updatedSwitch = switchesOf(updated, byClass(updated, 'dsm-row')[0])[0]
  assert.equal(updatedSwitch.props.on, false, 'the row reflects the new state immediately')
  assert.equal(
    page.requests.filter((entry) => entry.op === 'mcpm-list').length,
    listCallsBefore,
    'toggling does not reload the whole list',
  )
})

test('client: mcp detail button loads the tool list via mcpm-tools', async () => {
  const page = makePage()
  const tree = await page.openMcpPage()
  const row = byClass(tree, 'dsm-row')[0]
  const detailButton = collect(row, (node) => (
    node.type === 'button' &&
    typeof (node.props || {}).className === 'string' &&
    node.props.className.includes('dsm-btn-quiet')
  ))[0]
  assert.ok(detailButton, 'row exposes a detail button')

  detailButton.props.onClick()
  await page.settle()

  const request = page.requests.find((entry) => entry.op === 'mcpm-tools')
  assert.ok(request, 'opening the details modal posts mcpm-tools')
  assert.deepEqual(request.args, { serverName: 'demo' })

  const modal = page.getTree()
  const toolNames = byClass(modal, 'dsm-tool-name').map((node) => node.props.children)
  assert.deepEqual(toolNames, ['demo_tool'], 'the details modal lists the registered tools')
})

test('client: mcp page renders summary stats, filters and grouped source cards', async () => {
  const page = makePage()
  const tree = await page.openMcpPage()

  const summary = byClass(tree, 'dsm-summary-4')[0]
  assert.ok(summary, 'summary strip renders')
  const stats = byClass(summary, 'dsm-stat')
  assert.equal(stats.length, 4, 'four stats: servers / enabled / running / tools')
  assert.deepEqual(stats.map((node) => node.props.children[1]), ['个服务', '个已启用', '个运行中', '个工具'])
  assert.equal(byClass(tree, 'dsm-search').length, 1, 'search box renders')
  const headings = byClass(tree, 'dsm-source-title')
  assert.deepEqual(headings.map((node) => node.props.children), ['Profile 级', '全局'], 'only non-empty groups render a card')
})

test('client: mcp add form posts mcpm-add with the typed server', async () => {
  const page = makePage()
  const tree = await page.openMcpPage()
  const addButton = collect(tree, (node) => node.type === 'button' && node.props.children === '新增服务')[0]
  assert.ok(addButton, 'toolbar exposes the add button')

  addButton.props.onClick()
  await page.settle()

  const modal = collect(page.getTree(), (node) => typeof node.type === 'function' && node.type.name === 'Modal')[0]
  assert.ok(modal, 'clicking add opens the form modal')
  const serverInput = byClass(modal, 'dsm-control')[0]
  assert.ok(serverInput, 'the form exposes the serverName input')
  serverInput.props.onChange({ target: { value: 'github' } })
  await page.settle()

  const submit = collect(page.getTree(), (node) => node.type === 'button' && node.props.children === '添加')[0]
  assert.ok(submit, 'form modal exposes the submit button')
  assert.notEqual(submit.props.disabled, true, 'submit enables once a name is typed')
  submit.props.onClick()
  await page.settle()

  const request = page.requests.find((entry) => entry.op === 'mcpm-add')
  assert.ok(request, 'submitting the form posts mcpm-add')
  assert.equal(request.args.serverName, 'github')
  assert.equal(request.args.transport, 'streamable-http')
  assert.equal(request.args.level, 'project')
})

test('client: mcp details toggle the reveal view and save a note', async () => {
  const page = makePage()
  const tree = await page.openMcpPage()
  const row = byClass(tree, 'dsm-row')[0]
  const detailButton = collect(row, (node) => (
    node.type === 'button' && String(node.props.className).includes('dsm-btn-quiet')
  ))[0]
  detailButton.props.onClick()
  await page.settle()

  const revealButton = collect(page.getTree(), (node) => node.type === 'button' && node.props.children === '显示密钥')[0]
  assert.ok(revealButton, 'the details modal exposes a reveal toggle')
  revealButton.props.onClick()
  await page.settle()
  // 明文视图走独立的 mcpm-reveal op（host 端受 token 保护）。
  const listCalls = page.requests.filter((entry) => entry.op === 'mcpm-reveal')
  assert.ok(listCalls.length >= 1, 'revealing re-reads the list unmasked via the reveal op')

  const modal = collect(page.getTree(), (node) => typeof node.type === 'function' && node.type.name === 'Modal')[0]
  const noteArea = collect(modal, (node) => node.type === 'textarea')[0]
  assert.ok(noteArea, 'the details modal exposes the note editor')
  noteArea.props.onChange({ target: { value: 'A 挂了用 B' } })
  await page.settle()

  const saveButton = collect(page.getTree(), (node) => node.type === 'button' && node.props.children === '保存备注')[0]
  assert.ok(saveButton, 'the note editor exposes a save button')
  assert.notEqual(saveButton.props.disabled, true, 'save enables once the note changes')
  saveButton.props.onClick()
  await page.settle()

  const request = page.requests.find((entry) => entry.op === 'mcpm-note')
  assert.ok(request, 'saving the note posts mcpm-note')
  assert.deepEqual(request.args, { id: 'mcp-demo', note: 'A 挂了用 B' })
})

test('client: the shipped host handler table serves every new UI op', async () => {
  const host = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
  for (const op of ['mcpm-list', 'mcpm-note', 'mcpm-settings', 'skill-open']) {
    assert.ok(host.includes("'" + op + "':"), 'host registers ' + op)
  }
})

test('client: the loader filter shows every live server across levels', async () => {
  const page = makePage()
  const tree = await page.openMcpPage()
  const filter = collect(tree, (node) => typeof node.type === 'function' && node.type.name === 'SourceSelect')[0]
  assert.ok(filter, 'the level filter renders')

  filter.props.onChange('loader')
  await page.settle()

  assert.equal(byClass(page.getTree(), 'dsm-row').length, 1, 'only servers with live loader state are shown')
  const names = byClass(page.getTree(), 'dsm-name').map((node) => node.props.children)
  assert.deepEqual(names, ['demo'], 'the offline server is filtered out')
})

test('client: mcp detail tool switch posts mcpm-tool-enabled', async () => {
  const page = makePage()
  const tree = await page.openMcpPage()
  const row = byClass(tree, 'dsm-row')[0]
  const detailButton = collect(row, (node) => node.type === 'button' && String(node.props.className).includes('dsm-btn-quiet'))[0]
  detailButton.props.onClick()
  await page.settle()

  const modal = collect(page.getTree(), (node) => typeof node.type === 'function' && node.type.name === 'Modal')[0]
  const toolCard = byClass(modal, 'dsm-tool')[0]
  assert.ok(toolCard, 'the details modal lists the tools')
  const toolSwitch = switchesOf(page.getTree(), toolCard)[0]
  assert.ok(toolSwitch, 'each tool exposes a switch')
  assert.equal(toolSwitch.props.on, true, 'the tool starts enabled')

  toolSwitch.props.onClick()
  await page.settle()

  const request = page.requests.find((entry) => entry.op === 'mcpm-tool-enabled')
  assert.ok(request, 'toggling a tool posts mcpm-tool-enabled')
  assert.deepEqual(request.args, { serverName: 'demo', tool: 'demo_tool', enabled: false })
})

test('client: apply-scope icons are never referenced from the factory scope', async () => {
  // The settings harness only invokes the top-level section component, so a
  // factory-scope component referencing apply-scope helpers passes here but
  // ReferenceErrors in the real renderer — both settings pages went blank.
  const source = readFileSync(bundlePath, 'utf8')
  const applyStart = source.indexOf('apply(ctx) {')
  assert.ok(applyStart > 0, 'apply body found')
  for (const marker of ['GithubMark16']) {
    const firstUse = source.indexOf(marker)
    assert.ok(firstUse > applyStart, marker + ' first appears inside apply, not the factory scope')
  }
})

test('history page: groups archived sessions by workspace, ungrouped last', async () => {
  const page = await makePage({ historyGrouped: true })
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  // 组头按组内最新归档时间降序：Beta(s2@4000) > Alpha(s1@2000) > 未分组(s3@1000)
  const titles = byClass(tree, 'dsm-hist-group-title').map((n) => n.props.children)
  assert.deepEqual(titles, ['Beta', 'Alpha', '未分组'])
  // 每行一个复选框
  const checks = byClass(tree, 'dsm-hist-check')
  assert.equal(checks.length, 3, 'one checkbox per archived session')
})

test('history page: selecting a row reveals the batch bar', async () => {
  const page = await makePage({ historyGrouped: true })
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  assert.equal(byClass(tree, 'dsm-hist-batch').length, 0, 'no batch bar before any selection')
  const check = byClass(tree, 'dsm-hist-check')[0]
  check.props.onChange()
  await page.settle()
  tree = page.getTree()
  const bar = byClass(tree, 'dsm-hist-batch')[0]
  assert.ok(bar, 'batch bar appears after selecting a row')
  const labels = byClass(bar, 'dsm-btn').map((n) => n.props.children)
  assert.ok(labels.includes('恢复所选 (1)'), 'batch restore shows the count')
  assert.ok(labels.includes('删除所选 (1)'), 'batch delete shows the count')
})

test('history page: batch restore issues history-unarchive-batch with selected ids', async () => {
  const page = await makePage({ historyGrouped: true })
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  const checks = byClass(tree, 'dsm-hist-check')
  checks[1].props.onChange() // s1
  checks[0].props.onChange() // s2
  await page.settle()
  tree = page.getTree()
  const actions = byClass(tree, 'dsm-hist-batch-actions')[0]
  const restore = byClass(actions, 'dsm-btn').find((n) => String(n.props.children).indexOf('恢复所选') === 0)
  assert.ok(restore, 'batch restore button present')
  restore.props.onClick()
  await page.settle()
  const req = page.requests.find((r) => r.op === 'history-unarchive-batch')
  assert.ok(req, 'issues history-unarchive-batch')
  assert.deepEqual(req.args.target, { scope: 'sessions', sessionIds: ['s1', 's2'] })
})

test('history page: batch delete goes through a confirm dialog then history-delete-batch', async () => {
  const page = await makePage({ historyGrouped: true })
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  const check = byClass(tree, 'dsm-hist-check')[1]
  check.props.onChange() // s1
  await page.settle()
  tree = page.getTree()
  const actions = byClass(tree, 'dsm-hist-batch-actions')[0]
  const del = byClass(actions, 'dsm-btn').find((n) => String(n.props.children).indexOf('删除所选') === 0)
  assert.ok(del, 'batch delete button present')
  del.props.onClick()
  await page.settle()
  const modal = findModal(page.getTree())[0]
  assert.ok(modal, 'confirm dialog opens for batch delete')
  const confirm = byClass(modal, 'dsm-btn').find((n) => n.props.children === '确认删除')
  assert.ok(confirm, 'confirm button present')
  confirm.props.onClick()
  await page.settle()
  const req = page.requests.find((r) => r.op === 'history-delete-batch')
  assert.ok(req, 'issues history-delete-batch after confirmation')
  assert.deepEqual(req.args.target, { scope: 'sessions', sessionIds: ['s1'] })
})

test('history page: select-all-visible only affects the filtered result', async () => {
  const page = await makePage({ historyGrouped: true })
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  // 搜索只命中 s1（Hello）
  const input = byClass(tree, 'dsm-search')[0]
  input.props.onChange({ target: { value: 'Hello' } })
  await page.settle()
  tree = page.getTree()
  const allBtn = byClass(tree, 'dsm-btn').find((n) => n.props.children === '全选')
  assert.ok(allBtn, 'select-all button present')
  allBtn.props.onClick()
  await page.settle()
  tree = page.getTree()
  const count = byClass(tree, 'dsm-hist-batch-count')[0]
  assert.ok(count, 'batch bar shows after select-all-visible')
  assert.equal(count.props.children, '已选 1 项', 'only the filtered row is selected')
})

test('history page: group header checkbox selects the whole group', async () => {
  const page = await makePage({ historyGrouped: true })
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  // 组头顺序：Beta / Alpha / 未分组 → heads[1] 是 Alpha（含 s1）
  const heads = byClass(tree, 'dsm-hist-group-head')
  const alphaCheck = byClass(heads[1], 'dsm-hist-group-check')[0]
  assert.ok(alphaCheck, 'group header has a checkbox')
  alphaCheck.props.onChange()
  await page.settle()
  const count = byClass(page.getTree(), 'dsm-hist-batch-count')[0]
  assert.equal(count.props.children, '已选 1 项', 'group select picks exactly its own session')
})

test('history page: flat fallback renders checkboxes without groups or batch bar', async () => {
  const page = await makePage()
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  assert.equal(byClass(tree, 'dsm-hist-group-head').length, 0, 'no group headers in flat mode')
  assert.equal(byClass(tree, 'dsm-hist-check').length, 2, 'flat rows still have checkboxes')
  assert.equal(byClass(tree, 'dsm-hist-batch').length, 0, 'no batch bar when nothing is selected')
})

test('history page: 导入对话按钮打开导入弹窗', async () => {
  const page = await makePage()
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  const btn = byClass(tree, 'dsm-btn').find((n) => n.props.children === '导入对话')
  assert.ok(btn, 'import button present in the page header')
  btn.props.onClick()
  await page.settle()
  const modal = findModal(page.getTree())[0]
  assert.ok(modal, 'import modal opens')
  assert.equal(modal.props.title, '导入对话', 'modal carries the import title')
})

test('history page: 选择对话文件发出 history-import（含 cwd）', async () => {
  const page = await makePage()
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  const btn = byClass(tree, 'dsm-btn').find((n) => n.props.children === '导入对话')
  btn.props.onClick()
  await page.settle()
  tree = page.getTree()
  const modal = findModal(tree)[0]
  // 填项目目录
  const cwdInput = byClass(modal, 'dsm-control')[0]
  cwdInput.props.onChange({ target: { value: 'C:/proj' } })
  await page.settle()
  tree = page.getTree()
  // 模拟选择文件（FileReader mock 同步回填 content）
  const fileInput = byClass(tree, 'dsm-hidden-input')[0]
  fileInput.props.onChange({ target: { files: [{ name: 'chat.jsonl', content: '{"type":"user","message":{"role":"user","content":"hi"}}' }] } })
  await page.settle()
  const req = page.requests.find((r) => r.op === 'history-import')
  assert.ok(req, 'issues history-import')
  assert.equal(req.args.fileName, 'chat.jsonl')
  assert.equal(req.args.content, '{"type":"user","message":{"role":"user","content":"hi"}}')
  assert.equal(req.args.cwd, 'C:/proj')
  // 成功反馈显示 sessionId
  const feedback = byClass(page.getTree(), 'dsm-feedback').map((n) => String(n.props.children))
  assert.ok(feedback.some((f) => f.indexOf('session-99') >= 0), 'success feedback shows the created session id')
})

test('history page: 导出对话弹窗选择会话并发出 history-export', async () => {
  const page = await makePage({ historyGrouped: true })
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  const btn = byClass(tree, 'dsm-btn').find((n) => n.props.children === '导出对话')
  assert.ok(btn, 'export button present in the page header')
  btn.props.onClick()
  await page.settle()
  let modal = findModal(page.getTree())[0]
  assert.ok(modal, 'export modal opens')
  assert.equal(modal.props.title, '导出对话')
  // 填导出目录（弹窗内第一个 dsm-control）
  const dirInput = byClass(modal, 'dsm-control')[0]
  dirInput.props.onChange({ target: { value: 'D:/backups' } })
  await page.settle()
  // 勾选第一个会话（s1）
  modal = findModal(page.getTree())[0]
  const check = byClass(modal, 'dsm-hist-check')[0]
  check.props.onChange()
  await page.settle()
  // 点导出
  modal = findModal(page.getTree())[0]
  const expBtn = byClass(modal, 'dsm-btn').find((n) => String(n.props.children).indexOf('导出 ') === 0)
  assert.ok(expBtn, 'export action button present')
  expBtn.props.onClick()
  await page.settle()
  const req = page.requests.find((r) => r.op === 'history-export')
  assert.ok(req, 'issues history-export')
  assert.deepEqual(req.args.sessionIds, ['s1'])
  assert.equal(req.args.format, 'markdown')
  assert.equal(req.args.outDir, 'D:/backups')
  // 成功反馈显示导出数量
  const feedback = byClass(page.getTree(), 'dsm-feedback').map((n) => String(n.props.children))
  assert.ok(feedback.some((f) => f.indexOf('已导出 1 个会话') >= 0), 'success feedback shows the export count')
})

test('history page: 导出弹窗按工作区筛选会话列表', async () => {
  const page = await makePage({ historyGrouped: true })
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  const btn = byClass(tree, 'dsm-btn').find((n) => n.props.children === '导出对话')
  btn.props.onClick()
  await page.settle()
  const modal = findModal(page.getTree())[0]
  // 三个下拉：格式 / 会话范围 / 工作区
  const selects = collect(modal, (node) => typeof node.type === 'function' && node.type.name === 'SourceSelect')
  assert.equal(selects.length, 3, 'format, scope and workspace dropdowns present')
  selects[2].props.onChange('ws:ws1') // Alpha
  await page.settle()
  const modal2 = findModal(page.getTree())[0]
  const checks = byClass(modal2, 'dsm-hist-check')
  assert.equal(checks.length, 2, 'Alpha 工作区列出 s1 与未归档的 s-live')
  const titles = byClass(modal2, 'dsm-hist-title').map((n) => n.props.children)
  assert.deepEqual(titles, ['Hello', 'Live Session'])
})

test('history page: 导出弹窗按范围筛选（仅未归档）', async () => {
  const page = await makePage({ historyGrouped: true })
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  const btn = byClass(tree, 'dsm-btn').find((n) => n.props.children === '导出对话')
  btn.props.onClick()
  await page.settle()
  const modal = findModal(page.getTree())[0]
  const selects = collect(modal, (node) => typeof node.type === 'function' && node.type.name === 'SourceSelect')
  selects[1].props.onChange('live') // 仅未归档
  await page.settle()
  const modal2 = findModal(page.getTree())[0]
  const checks = byClass(modal2, 'dsm-hist-check')
  assert.equal(checks.length, 2, '仅未归档列出 s-live 与 s-orphan')
  const titles = byClass(modal2, 'dsm-hist-title').map((n) => n.props.children)
  assert.deepEqual(titles, ['Live Session', 'Orphan'])
  // 未归档行带状态标签
  const tags = byClass(modal2, 'dsm-tag').map((n) => n.props.children)
  assert.deepEqual(tags, ['未归档', '未归档'])
})

test('history page: 导出弹窗「仅目录丢失」筛选并标记', async () => {
  const page = await makePage({ historyGrouped: true })
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  const btn = byClass(tree, 'dsm-btn').find((n) => n.props.children === '导出对话')
  btn.props.onClick()
  await page.settle()
  const modal = findModal(page.getTree())[0]
  const selects = collect(modal, (node) => typeof node.type === 'function' && node.type.name === 'SourceSelect')
  selects[1].props.onChange('missing') // 仅目录丢失
  await page.settle()
  const modal2 = findModal(page.getTree())[0]
  const checks = byClass(modal2, 'dsm-hist-check')
  assert.equal(checks.length, 1, '仅目录丢失只列出 s-orphan')
  const missing = byClass(modal2, 'dsm-hist-cwd-missing')[0]
  assert.ok(missing, '目录丢失行带红色标记类')
  assert.ok(String(missing.props.children).indexOf('⚠') === 0, '目录丢失行以 ⚠ 开头')
})

test('history page: 归档所选发出 history-archive-batch', async () => {
  const page = await makePage({ historyGrouped: true })
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  const btn = byClass(tree, 'dsm-btn').find((n) => n.props.children === '导出对话')
  btn.props.onClick()
  await page.settle()
  let modal = findModal(page.getTree())[0]
  // 勾选第一个会话（s1）
  const check = byClass(modal, 'dsm-hist-check')[0]
  check.props.onChange()
  await page.settle()
  modal = findModal(page.getTree())[0]
  const archBtn = byClass(modal, 'dsm-btn').find((n) => n.props.children === '归档所选')
  assert.ok(archBtn, 'archive-selected button present')
  archBtn.props.onClick()
  await page.settle()
  const req = page.requests.find((r) => r.op === 'history-archive-batch')
  assert.ok(req, 'issues history-archive-batch')
  assert.deepEqual(req.args.sessionIds, ['s1'])
  // 成功反馈显示归档数量
  const feedback = byClass(page.getTree(), 'dsm-feedback').map((n) => String(n.props.children))
  assert.ok(feedback.some((f) => f.indexOf('已归档 1 个会话') >= 0), 'success feedback shows the archive count')
})

test('history page: 导出弹窗默认目录来自 host，「选择文件夹」目录树回填', async () => {
  const page = await makePage({ historyGrouped: true })
  let tree = await page.openHistoryPage()
  await page.settle()
  tree = page.getTree()
  const btn = byClass(tree, 'dsm-btn').find((n) => n.props.children === '导出对话')
  btn.props.onClick()
  await page.settle()
  const modal = findModal(page.getTree())[0]
  // 默认导出目录 = host 返回的桌面路径
  const dirInput = byClass(modal, 'dsm-control')[0]
  assert.equal(dirInput.props.value, 'C:/Users/test/Desktop', 'default dir filled from host')
  // 「选择」按钮打开目录选择器（initial = 当前导出目录）
  const pickBtn = byClass(modal, 'dsm-btn').find((n) => n.props.children === '选择')
  assert.ok(pickBtn, '选择 button present')
  pickBtn.props.onClick()
  await page.settle()
  const pickerEl = collect(page.getTree(), (n) => typeof n.type === 'function' && n.type.name === 'DirPickerModal')[0]
  assert.ok(pickerEl, 'DirPickerModal rendered in export modal')
  assert.equal(pickerEl.props.initial, 'C:/Users/test/Desktop', 'picker starts at current export dir')
  // minimal React 不递归渲染函数组件：把选择器作为顶层组件渲染，并捕获 onPick
  let picked = null
  await page.render(pickerEl.type, Object.assign({}, pickerEl.props, { onPick: (p) => { picked = p } }))
  await page.settle()
  const req = page.requests.find((r) => r.op === 'dir-list')
  assert.ok(req, 'issues dir-list')
  assert.equal(req.args.dir, 'C:/Users/test/Desktop')
  // 点击子目录进入 → 「选择此文件夹」→ 回填
  tree = page.getTree()
  const item = byClass(tree, 'dsm-dir-item').find((n) => n.props.children === 'backups')
  assert.ok(item, 'dir item listed')
  item.props.onClick()
  await page.settle()
  const selectBtn = byClass(page.getTree(), 'dsm-btn').find((n) => n.props.children === '选择此文件夹')
  assert.ok(selectBtn, 'select-this-folder button present')
  selectBtn.props.onClick()
  await page.settle()
  assert.equal(picked, 'C:/Users/test/Desktop/backups', 'dir picked via onPick')
})

test('skills page: 添加目录弹窗的「选择文件夹」目录树回填路径', async () => {
  const page = makePage()
  let tree = await page.openSkillsPage()
  await page.settle()
  tree = page.getTree()
  // 打开「添加目录」弹窗（头部 actions 里的 quiet 按钮文案）
  const addBtn = byClass(tree, 'dsm-btn').find((n) => n.props.children === '添加目录')
  assert.ok(addBtn, 'custom-add button present')
  addBtn.props.onClick()
  await page.settle()
  tree = page.getTree()
  const modal = findModal(tree)[0]
  assert.ok(modal, 'custom-add modal opens')
  // 「选择」无需先填路径即可打开选择器
  const pickBtn = byClass(modal, 'dsm-btn').find((n) => n.props.children === '选择')
  assert.ok(pickBtn, '选择 button present in custom-add')
  pickBtn.props.onClick()
  await page.settle()
  // 路径为空 → DirPickerModal initial 为空
  const pickerEl = collect(page.getTree(), (n) => typeof n.type === 'function' && n.type.name === 'DirPickerModal')[0]
  assert.ok(pickerEl, 'DirPickerModal rendered in custom-add')
  assert.equal(pickerEl.props.initial, '')
  let picked = null
  await page.render(pickerEl.type, Object.assign({}, pickerEl.props, { onPick: (p) => { picked = p } }))
  await page.settle()
  const req0 = page.requests.find((r) => r.op === 'dir-list')
  assert.ok(req0, 'issues dir-list on open')
  assert.equal(req0.args.dir, '')
  // 点击盘符 C:\ 进入
  tree = page.getTree()
  const drive = byClass(tree, 'dsm-dir-item').find((n) => n.props.children === 'C:\\')
  assert.ok(drive, 'drive item listed')
  drive.props.onClick()
  await page.settle()
  const dirReqs = page.requests.filter((r) => r.op === 'dir-list')
  assert.equal(dirReqs[dirReqs.length - 1].args.dir, 'C:\\', 'issues dir-list for drive')
  // 「选择此文件夹」→ onPick 传出所选路径
  const selectBtn = byClass(page.getTree(), 'dsm-btn').find((n) => n.props.children === '选择此文件夹')
  assert.ok(selectBtn, 'select-this-folder button present in custom-add')
  selectBtn.props.onClick()
  await page.settle()
  assert.equal(picked, 'C:\\', 'path picked via onPick')
})
