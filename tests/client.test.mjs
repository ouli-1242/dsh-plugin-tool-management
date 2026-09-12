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

  /** Render to quiescence: effects may schedule state updates that re-render. */
  async function render(component, props) {
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

// ---------- harness ----------
function makePage() {
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

  const skills = registered.find((entry) => entry.def.id === 'dsm-skills')
  assert.ok(skills, 'Skills settings section is registered')
  const mcp = registered.find((entry) => entry.def.id === 'dsm-mcp')
  assert.ok(mcp, 'MCP settings section is registered')

  /** Render the Skills page, expanding the source card that starts collapsed. */
  async function openSkillsPage() {
    const element = skills.renderFn()
    let tree = await render(element.type, element.props)
    if (!byClass(tree, 'dsm-row').length) {
      const headButton = byClass(tree, 'dsm-source-head-main')[0]
      assert.ok(headButton, 'source card header renders')
      headButton.props.onClick()
      await settle()
      // Return the tree from the most recent pass: the click re-rendered it.
      tree = getTree()
    }
    return tree
  }

  /** Render the MCP page (every group starts expanded). */
  async function openMcpPage() {
    const element = mcp.renderFn()
    return render(element.type, element.props)
  }

  return { requests, render, settle, openSkillsPage, openMcpPage, getTree, skills, mcp, registered }
}

// ---------- tests ----------

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
  for (const marker of ['GithubMark16', 'primitives.IconListPenOutline16']) {
    const firstUse = source.indexOf(marker)
    assert.ok(firstUse > applyStart, marker + ' first appears inside apply, not the factory scope')
  }
})
