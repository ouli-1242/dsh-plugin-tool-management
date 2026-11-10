// 记忆（rules）域的 model 工具：memory_get / memory_manager_switch / memory_manager_save。
//
// 自主笔记（agent 学的一句话）是另一族 `memory_note`：两族按对象分开，读取统一走
// `memory_get`，id 形状也不同（用户记忆 `<scene>/<name>`，笔记 `note:<layer>/<slug>`）。
//
// 为什么族名是 `memory_manager_` 而不是 `scene_memory_manager_`：后者是为了跟注入段名
// （`scene-memory-manager-catalog`）对齐才改的，但那个名字描述的是**域**，
// 而这个族操作的全是记忆。加场景能力时这个错配就现形了 —— 场景是另一个对象（容器，
// 进入时切换 mcp / 技能 / 人设），硬塞进 `save` 会让 `description` 变成双义参数（给
// `memory` 时是记忆描述、给 `scene` 时是场景描述），门禁也得按参数分叉（记忆写入有开关
// 可放行，场景写入是改运行时环境、不该有那条路）。所以拆成两族：这里管记忆内容，
// `scene_manager_*`（tools/scene.ts）管场景本身。
//
// 场景清单也不挂在这条 list 的尾巴上（「记忆就管记忆，场景就管场景」）——
// 它在 `scene_manager_list`，理由记在 tools/scene.ts 头部，别当"少写了一段"再加回来。
//
// 为什么 write + update 并成 save：两者的判定（同名 = 改、无同名 = 建）本来就只有
// `rules-create` 知道 —— 它对同名是**拒绝**的，op 层不会替你 upsert。分开两条工具时，
// 模型必须自己先查一次再决定调哪条，而它手里的清单可能已经过期。合并后由工具侧兜住。
//
// 活动场景的记忆正文会自动注入上下文（无需调用工具读取）；这里的工具用于查询/编辑规则
// 本身。memory_manager_save 受 tools/pre-execute 审批门禁。
// 路径锚点：$DSH_HOME/tool-management/memories/<场景>/…（场景 `global` = 界面「全局」）。

import { GLOBAL_SCENE, SHARED_GROUP } from '../memories/constants.js'
import type { ScopeAskRequest, ScopeChoice, ScopeLayer } from '../evolution/scope-card.js'
import { candidateNote, effectiveScope, existingNote, globalActionNote, globalUnchangedNote, isolationOffNote, listLimit, moreNotShown, scopeOnlyNote, scopeSessionDesc, sessionScopeOf, text, toolOrNeutral, type ToolDomainDeps } from './deps.js'
import { PROACTIVE_MEMORY_TOOL } from './table.js'
import { isNoteRef, noteRefOf, stripNoteRef } from './note-ref.js'

/** 记忆工具域要的宿主能力：记忆 op 表与场景记录。 */
export interface MemoryToolDeps extends ToolDomainDeps {
  /** rules service 的 ops 表：rules-list / rules-read / rules-create / rules-update / rules-toggle。 */
  rulesOps: Record<string, (args: any) => Promise<any>>
  /**
   * 自主记忆的 op（`evolution-learn` / `evolution-forget` / `evolution-list`）。
   *
   * 不给 = 这版没接自动记忆：两条工具**不注册**（注册了却调不通比不存在更糟 ——
   * 模型会照描述去试，然后拿到一个内部错误）。
   */
  evolutionOps?: Record<string, (args: any) => Promise<any>>
  /** 这个 agent 现在能不能主动学（三级开关 + depth + 会话 id 是否可作目录名）。 */
  autoLearnEnabled?: (agent: unknown) => boolean
  /** 当前启用的场景名（写入路由要它判"该不该落场景层"）。 */
  activeSceneOf?: (agent: unknown) => string | undefined
  /**
   * **真实**会话身份（sid + cwd），不是作用域键。
   *
   * 为什么不能用 `sessionScopeOf`：那个返回的是按作用域粒度派生的键 ——「按工作区」粒度下
   * 所有会话共用一个键。拿它当会话层目录名，切一次粒度就会让所有会话的记忆互相串进对方
   * 的目录（静默的隐私事故）。层永远认真实 sid（见 docs 01-model §4）。
   */
  sessionIdentity?: (agent: unknown) => { sessionId?: string; cwd?: string } | null
  /**
   * 在对话里问用户「这条记忆放哪」。
   *
   * 返回 `null` = 没有可用卡片（headless / 非 live root / 卡片异常）—— 调用方退回待确认，
   * 不丢笔记；返回 `{ choice: 'skip' }` = 用户明确不加入或关掉了卡片。
   * 不接这个依赖 = 这版没有卡片，走原来的待确认路径。
   */
  askMemoryScope?: (agent: unknown, req: ScopeAskRequest) => Promise<ScopeChoice | null>
}


/** 注册记忆域的 model 工具（列表 / 读取 / 检索 / 切换 / 保存）。 */
export function buildMemoryTools(deps: MemoryToolDeps): void {
  const { defineTool, register } = deps
  /**
   * 运行时点名自主笔记工具：它不在工具表里时退回中性说法。
   *
   * 静态描述不能点名（契约测试拦），错误消息与回执同理 —— 指一条模型没有的工具
   * 等于把它往墙上推。`toolOrNeutral` 只在可见时说出真实名字。
   */
  const noteTool = (agent: unknown, named: string, neutral: string): string =>
    toolOrNeutral(deps, agent, PROACTIVE_MEMORY_TOOL, named, neutral)
  const evo = deps.evolutionOps

  /**
   * 这条规则是不是自主笔记而不是用户记忆。
   *
   * `memory_get` 把两族并成一份输出，用户记忆那一半必须把笔记摘掉 —— 否则同一句话
   * 会在「user memories」与「agent notes」各出现一次。`origin` 是权威字段；旧数据
   * 没有它时按目录判（`_ws` / `_session` 只由笔记后端写入，见 memories/catalog.ts）。
   */
  const isAutoRule = (x: any): boolean => {
    if (x && x.origin === 'auto') return true
    if (x && x.origin === 'user') return false
    // 搜索结果把场景叫 `scene`，清单叫 `group`；两边都要认。
    const group = String((x && (x.group !== undefined ? x.group : x.scene)) || '')
    return group === '_ws' || group.startsWith('_ws/') ||
      group === '_session' || group.startsWith('_session/')
  }

  /**
   * 把模型给的引用解析成一条笔记：id（可带 `note:`）→ slot → title → 原文，唯一命中才算。
   *
   * 为什么允许 title/原文：注入行里只有 key 与摘要，模型不一定记得 id；唯一命中时
   * 直接读/删，比让它再查一次 list 省一轮。多条命中必须报候选 —— 猜错一条就是删错。
   */
  const resolveNote = async (ref: string): Promise<{ id: string | null; hits: any[] }> => {
    const raw = stripNoteRef(ref)
    if (raw === '' || !evo) return { id: null, hits: [] }
    const list: any = await evo['evolution-list']({ all: true })
    const rows: any[] = list && Array.isArray(list.entries) ? list.entries : []
    const hits = rows.filter((e: any) =>
      String(e.id || '') === raw ||
      String(e.key || '') === raw ||
      String(e.title || '') === raw ||
      String(e.oneLine || '') === raw
    )
    return hits.length === 1 ? { id: String(hits[0].id), hits } : { id: null, hits }
  }
  const describeNoteHits = (hits: any[]): string =>
    hits.map((e) => noteRefOf(String(e.id)) + (e.title ? ' (' + String(e.title) + ')' : '')).join(', ')
  /** forget 的引用参数：新名 `note`，旧名 `memory` 兼容一次（改名前的调用习惯）。 */
  const noteArgOf = (a: any): string => String((a && (a.note !== undefined ? a.note : a.memory)) || '').trim()

  /** 一条笔记的正文 + 证据链；`note:` 前缀由调用方决定是否剥掉。 */
  const noteReadText = async (ref: string): Promise<string> => {
    if (!evo) throw new Error('agent notes are not available in this build')
    const raw = stripNoteRef(ref)
    if (raw === '') throw new Error('missing argument: id — the note id (note:...), slot, title or exact text.')
    let a: any = await evo['evolution-read']({ id: raw, touch: true })
    if (!a || a.ok === false) {
      const resolved = await resolveNote(raw)
      if (resolved.id !== null) a = await evo['evolution-read']({ id: resolved.id, touch: true })
      else if (resolved.hits.length > 1) {
        throw new Error('ambiguous: "' + ref + '" matches ' + describeNoteHits(resolved.hits) + '; pass one of these ids.')
      }
    }
    if (!a || a.ok === false) throw new Error(String((a && a.error) || 'no such agent note: ' + ref))
    const st = a.state || {}
    const bits = [
      'status ' + String(a.status || 'active'),
      'confidence ' + (Number(st.confidence) || 0).toFixed(2),
      a.layer,
    ]
    const lines = ['# ' + noteRefOf(String(a.id || raw)) + ' (agent note)', bits.join(' · ')]
    if (a.title) lines.push('title: ' + String(a.title))
    if (a.key) lines.push('slot: ' + String(a.key))
    if (a.basis) lines.push('basis: ' + String(a.basis))
    if (a.boundary) lines.push('boundary: ' + String(a.boundary))
    if (a.degraded) lines.push('degraded: ' + String(a.degraded))
    lines.push('', String(a.body || ''))
    const ev: any[] = Array.isArray(st.evidence) ? st.evidence : []
    if (ev.length) {
      lines.push('', 'evidence (latest ' + ev.length + '):')
      for (const e of ev) lines.push('- [' + String(e.source || '') + '] ' + String(e.quote || '').slice(0, 200))
    }
    const tr: any[] = Array.isArray(st.transitions) ? st.transitions : []
    if (tr.length) {
      lines.push('', 'timeline:')
      for (const x of tr) lines.push('- ' + String(x.at || '') + ' ' + String(x.from || '') + ' → ' + String(x.to || '') + ' (' + String(x.actor || '') + ': ' + String(x.reason || '') + ')')
    }
    return lines.join('\n')
  }

  const noteCatalogText = async (all: boolean, limit: number): Promise<string> => {
    if (!evo) return ''
    const r: any = await evo['evolution-list']({ all })
    if (!r || r.ok === false) throw new Error(String((r && r.error) || 'failed to read agent notes'))
    const rows: any[] = Array.isArray(r.entries) ? r.entries : []
    const shown = rows.slice(0, limit)
    const order = ['workspace', 'global']
    const lines: string[] = []
    for (const layer of order) {
      const group = shown.filter((e) => e.layer === layer)
      if (!group.length) continue
      lines.push('[' + layer + ']')
      for (const e of group) {
        lines.push('- ' + noteRefOf(String(e.id)) + ' · ' + String(e.status || 'active') +
          (e.key ? ' · slot ' + String(e.key) : '') +
          (e.title ? ' · ' + String(e.title) : '') +
          ' · conf ' + (Number(e.confidence) || 0).toFixed(2) +
          ' · ' + (e.injects ? 'injects' : 'not injected') +
          (e.needsReview ? ' · needs review: ' + String(e.needsReview) : '') +
          (e.oneLine ? ' — ' + String(e.oneLine) : ''))
      }
    }
    const head = 'agent notes: ' + rows.length + ' listed' +
      (r.total !== undefined ? ' / ' + r.total + ' in catalog' : '') +
      (rows.length > shown.length ? ' (showing ' + shown.length + ', raise limit for more)' : '')
    return head + '\n' + (lines.join('\n') || '(none)')
  }

  const noteSearchText = async (query: string, limit: number): Promise<string> => {
    if (!evo) return ''
    const r: any = await evo['evolution-list']({ all: true })
    if (!r || r.ok === false) throw new Error(String((r && r.error) || 'failed to read agent notes'))
    const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '')
    const rows: any[] = (Array.isArray(r.entries) ? r.entries : []).filter((e: any) => {
      const hay = [e.id, e.key, e.title, e.oneLine].map((x) => String(x || '').toLowerCase()).join(' ')
      return words.every((w) => hay.includes(w))
    })
    const shown = rows.slice(0, limit)
    const lines = shown.map((e: any) => '- ' + noteRefOf(String(e.id)) + ' · ' + String(e.status || 'active') +
      (e.title ? ' · ' + String(e.title) : '') +
      (e.oneLine ? ' — ' + String(e.oneLine) : ''))
    return 'agent notes matching "' + query + '": ' + rows.length +
      (rows.length > shown.length ? ' (showing ' + shown.length + ')' : '') +
      '\n' + (lines.join('\n') || '(none)')
  }

  const userCatalogText = async (all: boolean, limit: number, scene: string | undefined, exec: any): Promise<string> => {
    const opArgs: any = {}
    if (scene !== undefined) opArgs.group = scene
    const scoped = sessionScopeOf(deps, exec && exec.agent)
    if (scoped !== null) opArgs.sessionId = scoped.sessionId
    const r: any = await deps.rulesOps['rules-list'](opArgs)
    if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to read memories')
    // 「会注入」的判定与记忆段同源（renderSceneMemory）：global 与 _shared 恒常注入，
    // 其余场景要在 index.active 里，再叠加单条 enabled 与同名 bundle 的 shadowed。
    const alwaysInjects = (group: string): boolean => group === GLOBAL_SCENE || group === SHARED_GROUP
    const sceneOn = (group: string): boolean => alwaysInjects(group) ||
      (group !== '' && (r.activeMode === 'all' || String(r.activeScene || '') === group))
    const stateOf = (x: any): { injects: boolean; label: string } => {
      if (x.shadowed === true) return { injects: false, label: 'shadowed' }
      if (x.enabled === false) return { injects: false, label: 'disabled' }
      if (!sceneOn(String(x.group || ''))) return { injects: false, label: 'scene off' }
      return { injects: true, label: 'injects' }
    }
    const rows: Array<{ x: any; injects: boolean; label: string }> =
      (r.rules || []).filter((x: any) => !isAutoRule(x)).map((x: any) => ({ x, ...stateOf(x) }))
    const shown = all ? rows : rows.filter((row) => row.injects)
    const visible = shown.slice(0, limit)
    const lines = visible.map(({ x, label }) => (
      '- ' + x.id + ' [' + (x.group || 'no scene') + '] ' + label +
      (x.form === 'bundle'
        ? ' · bundle' + (x.attach && x.attach.count ? ' (' + x.attach.count + ' attachment(s))' : '')
        : '') +
      (x.description ? ' — ' + x.description : '')
    ))
    const scope = r.activeMode === 'all'
      ? 'every scene (historical default, not narrowed)'
      : (r.activeScene ? '"' + String(r.activeScene) + '"' : 'no scene is on')
    const viewNoun = deps.scopeMode?.() === 'workspace' ? 'this workspace' : 'this conversation'
    const sessionNote = scoped === null || scoped.scope === undefined
      ? ''
      : '\nthis is ' + viewNoun + "'s view" +
        (scoped.scope.scene !== undefined ? ' — scene pinned to "' + scoped.scope.scene + '"; the machine-wide scene may differ' : '') +
        (scoped.scope.memory !== undefined ? '; ' + Object.keys(scoped.scope.memory).length + ' switch(es) applied here' : '')
    const sharedHere = rows.some(({ x }) => String(x.group || '') === SHARED_GROUP)
    const header = 'user memories: ' + (all
      ? rows.length + ' total'
      : shown.length + ' injecting / ' + rows.length + ' total' +
        (shown.length === rows.length ? '' : ' (pass all=true for all)')) +
      '\ninjects from: ' + scope + ' + global' + (sharedHere ? ' + _shared' : '') + ' (always on)' + sessionNote + '\n'
    const notice = await deps.reachNoticeForAgent(deps.presetRoster(), exec && exec.agent && exec.agent.ctx, deps.injectNoticeOptions())
    return header + (lines.join('\n') || '(none)') + moreNotShown(shown.length, visible.length) + notice
  }

  const userSearchText = async (query: string, limit: number, scene: string | undefined, exec: any): Promise<string> => {
    const opArgs: any = { query, limit }
    const scoped = sessionScopeOf(deps, exec && exec.agent)
    if (scoped !== null) opArgs.sessionId = scoped.sessionId
    const r: any = await deps.rulesOps['rules-search'](opArgs)
    if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to search memories')
    let hits: any[] = Array.isArray(r.hits) ? r.hits : []
    hits = hits.filter((h) => !isAutoRule(h))
    if (scene !== undefined) hits = hits.filter((h) => String(h.scene || '') === scene)
    if (!hits.length) return 'user memories: no match for "' + query + '"'
    const lines = hits.slice(0, limit).map((h) => '- ' + h.id + ' [' + (h.scene || 'no scene') + ']' +
      (h.enabled === false ? ' (off here)' : '') +
      (h.snippet ? ' — ' + h.snippet : ''))
    return 'user memories matching "' + query + '": ' + hits.length +
      (hits.length > limit ? ' (showing ' + limit + ')' : '') + '\n' + lines.join('\n')
  }

  const userReadText = async (id: string, exec: any): Promise<string | null> => {
    const r: any = await deps.rulesOps['rules-read']({ id })
    if (!r || r.ok === false) return null
    const rule: any = r.rule || {}
    // 自动条目由笔记渲染器负责；这里返回 null，让 readEntry 走 noteReadText。
    if (isAutoRule(rule)) return null
    const attach: any[] = Array.isArray(rule.attachments) ? rule.attachments : []
    const form = rule.form === 'bundle' ? 'bundle' : 'flat'
    const attLine = attach.length
      ? '\nattachments (' + attach.length + '): ' + attach.map((a: any) => String((a && a.name) || a)).join(', ')
      : ''
    const scoped = sessionScopeOf(deps, exec && exec.agent)
    const over = scoped?.scope?.memory?.[String(rule.id)]
    const offHere = over === false
      ? '\n(switched off here only — the body above is not injected here; the global setting is unchanged) '
      : ''
    return '# ' + rule.id + ' (memory, ' + form + ')' + attLine + '\n\n' + (rule.body || '') + offHere
  }

  const readEntry = async (id: string, exec: any): Promise<string> => {
    if (isNoteRef(id)) return noteReadText(id)
    const mem = await userReadText(id, exec)
    if (mem !== null) return mem
    if (evo) {
      try { return await noteReadText(id) } catch (e) {
        throw new Error('no user memory with id "' + id + '"; ' + (e instanceof Error ? e.message : String(e)))
      }
    }
    throw new Error('no user memory with id "' + id + '". Call memory_get with no id to list what exists.')
  }

  register(defineTool({
    name: 'memory_get',
    description: 'Look up user-written memories and agent notes. No id → catalog (what exists and what injects); `id` → full body; `query` → filtered catalog with snippets. Agent note ids start with `note:`. Use this for ids and for entries not already in your context. Read-only.',
    parameters: {
      id: { type: 'string', description: 'Read one entry: a user memory id (<scene>/<name>) or an agent note id (note:...).' },
      query: { type: 'string', description: 'Filter the catalog by words in id, scene, description, tags or body; every word must match (case-insensitive).' },
      kind: { type: 'string', enum: ['memory', 'note'], description: 'Limit the catalog to user-written memories or agent notes.' },
      scene: { type: 'string', description: 'Only user memories in this scene; `global` and `_shared` are the always-on scenes.' },
      all: { type: 'boolean', description: 'Include entries that are off, in an inactive scene, or archived (default false).' },
      limit: { type: 'number', description: 'Max entries per kind (default 50, max 100).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const id = String((args && args.id) || '').trim()
      if (id !== '') return readEntry(id, exec)
      const query = String((args && args.query) || '').trim()
      const kind = args && args.kind === 'note' ? 'note' : args && args.kind === 'memory' ? 'memory' : ''
      const all = args && args.all === true
      const limit = listLimit(args && args.limit)
      const scene = args && typeof args.scene === 'string' && args.scene !== '' ? args.scene : undefined
      // 自主记忆关着时，笔记不在这份清单里出现：功能没开，模型不该看到「有笔记可读」
      // 这种半开状态（直接给 note: id 仍然读得到 —— 那是显式请求）。
      const notesOn = Boolean(evo && deps.autoLearnEnabled && deps.autoLearnEnabled(exec && exec.agent))
      if (kind === 'note' && !notesOn) {
        throw new Error('autonomous memory is off here, so agent notes are not available. The user can turn it on in Memory → Autonomous memory.')
      }
      const sections: string[] = []
      if (kind !== 'note') {
        sections.push(query !== ''
          ? await userSearchText(query, limit, scene, exec)
          : await userCatalogText(all, limit, scene, exec))
      }
      if (kind !== 'memory' && notesOn) {
        sections.push(query !== '' ? await noteSearchText(query, limit) : await noteCatalogText(all, limit))
      }
      return sections.filter((s) => s !== '').join('\n\n') || '(none)'
    },
  }))
  register(defineTool({
    name: 'memory_manager_switch',
    // 为什么叫 `_switch` 而不是 `_set_enabled`：六个域里"拨一个开关"
    // 是同一件事，名字该同形 —— `mcp_manager_switch` 早就是这个名字，`_set_enabled` 只剩
    // 记忆 / 技能 / 人设三族在叫。**参数保留 `enabled` 布尔**：这里没有 `restart` 那第三个
    // 动词，`action: 'on' | 'off'` 只会在 `true`/`false` 之上多一层映射、多付一段 schema。
    // 旧名不注册别名（同一口径：注册就进工具表、就要付 token）；用户的旧设置由
    // `tools/table.ts` 的 `LEGACY_TOOL_NAME_MAP` 翻译。
    //
    // 为什么单独一个工具：注入实况里「这个域注入了几次 / 模型调了几次」都看得到，但模型此前
    // 看得到一份记忆却开关不了它 —— 只能回一句"请你去界面上点"。启停是它替用户调整环境时
    // 最常碰的一格，而 `rules-toggle` 这个 op 早就带齐了门禁（写令牌 + 场景冻结）。
    // 三个写侧工具共用一句 consent（`Only when the user asks or approves.` / `Only on the
    // user's instruction.`）：这些动的都是"以后每一轮都会带上"的东西，模型不该顺手做。
    // 描述同时按"省 token"重写了一遍 —— 这几段文字每次请求都要发出去，废话是常驻成本。
    // 后半句"freeing the byte budget"删掉：byte budget 是本插件
    // 内部术语，模型据此做不了任何判断 —— "不再被注入"已经是它需要的全部因果。
    description: 'Enable or disable one user-written memory. Disabled memories stop being injected. Reversible. Agent notes are not switched here — forget them with the agent-note tool. Only when the user asks or approves.',
    parameters: {
      memory: { type: 'string', required: true, description: 'Memory id like <scene>/<name>.' },
      enabled: { type: 'boolean', required: true, description: 'true = enable, false = disable.' },
      // 默认只改**这个对话**。写全局要显式说明。
      scope: { type: 'string', enum: ['session', 'global'], description: scopeSessionDesc('global = every conversation.') },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const memory = String((args && args.memory) || '')
      // 笔记不是用户记忆：这条工具拨的是索引里的开关，笔记的删除/停用走另一族。
      if (isNoteRef(memory)) {
        throw new Error('that is an agent note, not a user memory: use ' + noteTool(exec && exec.agent, 'memory_note action=forget', 'the agent-note tool') + '. User memory ids look like <scene>/<name>.')
      }
      // `enabled` 必须是布尔：`rules-toggle` 缺了它直接拒（ops/memory.ts），但那是给用户看的
      // 中文 op 错；这里先挡一句说清"这条工具要什么"。
      if (typeof (args && args.enabled) !== 'boolean') throw new Error('missing argument: enabled must be true or false')
      // 场景锁冻结的是**全局**写入：会话覆盖写的是侧车，与锁无关 ——
      // 与面板的 `scopeWriteLocked()` 同一口径。只有全局那条路才过守卫。
      // 全局粒度下 `effectiveScope` 一律返回 global：那一档没有会话层，写的就是索引本身。
      const scope = effectiveScope(deps, args)
      const sessionOnly = scope === 'session'
      if (!sessionOnly) {
        const blocked = await deps.lockedSceneGuard()
        if (blocked) throw new Error(blocked)
      }
      // 默认写**本会话**（别的对话不受影响），`scope: "global"` 才改索引。
      // 会话层只改"注入不注入"，不碰索引里那条记录 —— 所以不需要场景档案同步。
      if (sessionOnly) {
        if (!deps.sessionScopeSet) throw new Error('per-conversation switches are unavailable in this host: pass scope="global" to change it for every conversation')
        const sc = await deps.sessionScopeSet(exec && exec.agent, 'memory', memory, args.enabled === true)
        if (!sc || sc.ok === false) throw new Error((sc && sc.error) || 'failed to switch this memory here')
        return 'OK: ' + memory + ' now ' + (args.enabled ? 'enabled' : 'disabled') + scopeOnlyNote(deps) +
          (sc.cleared === true ? ' (that matches what this scope would see anyway, so the override was removed)' : '') +
          '. ' + globalUnchangedNote(deps) + ' Pass scope="global" to change it for every conversation.'
      }
      const r: any = await deps.rulesOps['rules-toggle']({ id: memory, enabled: args.enabled })
      if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to switch this memory')
      const rule = r.rule || {}
      // 「启用了一条不在启用场景里的记忆」是一次静默无效：单条开关拨上去了，注入集里却没有它。
      // 这一句不说，模型会以为已经生效 —— 与 skill_manager_switch 说清影子副本同一条理由。
      let sceneNote = ''
      try {
        const all: any = await deps.rulesOps['rules-list']({})
        if (all && all.ok !== false) {
          const group = String(rule.group || '')
          const on = group === 'global' || (group !== '' && (all.activeMode === 'all' || String(all.activeScene || '') === group))
          if (!on) sceneNote = ' — BUT its scene "' + group + '" is not the one injecting, so it still will not be injected; turn that scene on (or move it to global) first'
        }
      } catch { sceneNote = '' }
      return 'OK: memory ' + String(rule.id || memory) + ' ' + (rule.enabled === false ? 'disabled' : 'enabled') + sceneNote + isolationOffNote(deps)
    },
  }))
  register(defineTool({
    name: 'memory_manager_save',
    // 「能推导的别记」「先查重」这两句必须有：记忆是唯一直接吃注入预算的域
    // （场景段 128 KiB），而模型很乐意把「这个项目用 pnpm」记一条 —— 那看一眼 `package.json`
    // 就知道，记下来却永久占着每一轮请求。合并 write/update 后这两句更要留：upsert 降低了
    // "再记一条"的摩擦，而摩擦正是这里唯一拦得住它的东西。
    description: 'Create a full user-written memory (a convention, procedure or reference worth keeping), or update the one with this id — the receipt says which. Memories cost context on every later request: record only what cannot be re-derived from code, config or git, and update an existing one rather than adding a near-duplicate. For a one-line note, standing order, reminder or preference ("every time…", "always…"), use the agent-note learn action instead. Blocked while the active scene is locked. Asks the user to confirm before it runs. Only on the user\'s instruction.',
    parameters: {
      memory: { type: 'string', required: true, description: 'Memory id like <scene>/<name> — copy it from the list. `global` is the always-on scene.' },
      description: { type: 'string', description: 'One-sentence description (<=500 chars). Required when creating. Empty string = drop it and re-derive from the body; omit = keep.' },
      body: { type: 'string', description: 'Markdown body (<=256 KiB). Required when creating. Omit to keep the current body.' },
      // 不再承诺「旧文件进回收站」：bundle 记忆改名走的是
      // 「只重写正文、目录不动」那条路，一个字都不进回收站 —— 对 bundle 说进回收站是假话。
      // 与上一轮 P1-1 同口径：**只说可逆，不说实现细节**。
      nextName: { type: 'string', description: 'New memory name (= file name); omit to keep it.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      // 这两个是自主笔记的参数。模型在两族之间串用参数时（会话里确实发生过），
      // 先把它指回 note，别让它继续猜 scene id。
      if (args && (args.layer !== undefined || args.title !== undefined)) {
        throw new Error('those are agent-note parameters, not memory parameters: for a one-line note call ' + noteTool(exec && exec.agent, 'memory_note action=learn', 'the agent-note learn action') + ' with title and text. To create a user memory pass memory=<scene>/<name>, description and body.')
      }
      const memory = String((args && args.memory) || '').trim()
      // 笔记不是用户记忆：它有自己的 id 前缀与写入路径，别让一次前缀传错落到"场景不存在"。
      if (isNoteRef(memory)) {
        throw new Error('that is an agent note, not a user memory: use ' + noteTool(exec && exec.agent, 'memory_note action=learn', 'the agent-note learn action') + ' to update it (same slot) or action=forget. User memory ids look like <scene>/<name>.')
      }
      // 拆成 `<场景>/<名字>`：要求两段都非空。**不做"没有斜杠就落 global"的兜底** —— 那会把
      // 一次拼错的 id 变成一条"每轮都注入"的全局记忆，而清单上看起来完全正常。
      // 清单里打印的就是 `<场景>/<名字>`，照抄比拼装准。
      const slash = memory.indexOf('/')
      if (slash <= 0 || slash === memory.length - 1) {
        // 这一条错得最有规律：用户口语里说的是「编程约定」，模型手里没有 id，就把那个名字
        // 直接传进来了。给两条现成的 id 比再解释一遍格式有用；读失败就只报格式
        // （`candidateNote` 自己吞掉失败，不改变错误结论）。
        const note = await candidateNote(async () => {
          const r: any = await deps.rulesOps['rules-list']({})
          return r && r.ok !== false ? (r.rules || []).map((x: any) => String(x.id)) : []
        }, 'memory ids')
        throw new Error('memory must be <scene>/<name> (copy that from the listing; the always-on scene is written global/<name>): ' + (memory || '(empty)') + note +
          '. For a one-line note use ' + noteTool(exec && exec.agent, 'memory_note action=learn', 'the agent-note learn action') + ' instead.')
      }
      const group = memory.slice(0, slash)
      const name = memory.slice(slash + 1)
      // 先取全量：既用来定位（命中 = 改、未命中 = 建），也是查重的数据源。判定必须在工具
      // 这一侧 —— `rules-create` 对同名是**拒绝**的（`error.rules.exists`），op 不会 upsert。
      const all: any = await deps.rulesOps['rules-list']({})
      if (!all || all.ok === false) throw new Error((all && all.error) || 'failed to read memories')
      const hit = (all.rules || []).find((x: any) => String(x.id) === memory)

      if (hit) {
        // 改的分支一律 read-modify-write（省略 = 保持），因为 `rules-update` 是整份重写。
        // 三个可改字段一个都没给就拒：op 会按"保留现有"落一次盘并刷新 updatedAt，
        // 模型以为改了点什么，其实只是把文件重写了一遍。
        const touched = ['body', 'description', 'nextName'].filter((k) => (args as Record<string, unknown>)[k] !== undefined)
        if (!touched.length) throw new Error('nothing to change: give at least one of body / description / nextName')
        const payload: any = { id: memory }
        // 只带模型真给过的键：`description` 传空串在 op 里是"删除并重新派生"，与"未给"是两种
        // 意图，都必须原样透传 —— 所以用 `!== undefined` 而不是真值判断。
        if (args.body !== undefined) payload.body = args.body
        if (args.description !== undefined) payload.description = args.description
        if (args.nextName !== undefined) payload.name = args.nextName
        const r: any = await deps.rulesOps['rules-update'](payload)
        if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to update the memory')
        const rule = r.rule || {}
        return 'OK: updated ' + String(rule.id || memory) + ' (changed ' + touched.join(', ') + ')' +
          (rule.id && String(rule.id) !== memory ? ' → now ' + rule.id : '')
      }

      // 建的分支：正文与描述都必填。`rules-create` 自己会拒空正文与非法名（ops/memory.ts），
      // 但那是给用户看的中文 op 错；模型需要的是"这条工具要什么"，所以在工具侧先挡、点名缺哪个。
      const body = args && args.body !== undefined ? String(args.body) : ''
      const description = args && args.description !== undefined ? String(args.description) : ''
      // 一行正文不是"完整记忆"，是自主记忆的短笔记。模型手里有两条写入工具时，
      // `save` 的名字更直白，它就会把「每次提醒我喝水」也塞进一条全局记忆；而这类内容
      // 本该走零摩擦的 learn（卡片选层、可 TTL、可合并）。只在 auto 真正可用时重定向：
      // 开关关着却让模型去调一条看不见的工具，等于把这次记录丢掉。
      // 放在必填校验之前：短笔记往往也没有 description，先报缺字段会把它推回 save。
      const trimmedBody = body.trim()
      const oneParagraph = trimmedBody !== '' && !/\n\s*\n/.test(trimmedBody)
      if (oneParagraph && trimmedBody.length <= 300 && deps.autoLearnEnabled && deps.autoLearnEnabled(exec && exec.agent)) {
        throw new Error('this is a one-line note, not a full memory: call ' + noteTool(exec && exec.agent, 'memory_note action=learn', 'the agent-note learn action') + ' with title and text instead (layer=global for every project, workspace for this one). memory_manager_save is for a multi-paragraph memory such as a convention, procedure or reference.')
      }
      const missing = [
        body.trim() === '' ? 'body' : '',
        description.trim() === '' ? 'description' : '',
      ].filter((x) => x !== '')
      if (missing.length) {
        // id 不存在 + 内容也不全：最可能是名字记差了一个字。先给**同一场景**里现成的 id
        // （整个库列出来只会把这条错误变成噪音），一条都没有才退回全库。
        const ids: string[] = (all.rules || []).map((x: any) => String(x.id))
        const here = ids.filter((id: string) => id.indexOf(group + '/') === 0)
        throw new Error('creating a memory needs ' + missing.join(' and ') + ' (' + memory + ' does not exist yet)'
          + existingNote(here.length ? here : ids, 'memory ids'))
      }
      // 查重只**说出来**，不拒绝 —— 猜错一次就把该记的东西记不下去，比多记一条代价大得多；
      // 而且"像不像同一条"本来就是人判断的事。只在建的分支提示：改的分支没有"再记一条"的风险。
      const norm = (value: unknown): string => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
      // 场景预检：op 层那条「场景不存在」错误是中文面板文案，直接透传给模型只会让它
      // 猜。工具清单里已经拿到了全部现存场景，在这里用英文说清"这个场景没有、现成有
      // 哪些"，比让一次注定失败的创建走到 op 层再报错体验好得多。
      const knownGroups = new Set<string>((all.rules || []).map((x: any) => String(x.group || '')))
      knownGroups.add(GLOBAL_SCENE)
      knownGroups.add(SHARED_GROUP)
      // `_ws` / `_session` 是自主笔记的内部存储目录，不是用户场景。模型从笔记 id
      // 反推出 `_ws/<hash>` 当 scene 时（会话里发生过），说清它是另一族，别再让它试。
      if (group === '_ws' || group.startsWith('_ws/') || group === '_session' || group.startsWith('_session/')) {
        throw new Error('"' + group + '" is internal storage for agent notes, not a user scene. For a workspace note use ' + noteTool(exec && exec.agent, 'memory_note action=learn', 'the agent-note learn action') + ' with layer=workspace; for a user memory use an existing scene (global, …).')
      }
      if (!knownGroups.has(group)) {
        const scenes = [...knownGroups].filter((s) => s !== '').sort()
        throw new Error('scene "' + group + '" does not exist — memories can only be created inside an existing scene. Existing scenes: ' + scenes.join(', ') + '. The user creates scenes in the plugin panel (Scenes page); then save again.')
      }
      const wantName = norm(name)
      const wantDesc = norm(description)
      const similar: string[] = (all.rules || [])
        .filter((x: any) => {
          const have = norm(x.name)
          const desc = norm(x.description)
          if (have === wantName) return true
          if (wantDesc !== '' && desc !== '' && desc === wantDesc) return true
          // 名字互相包含：只在两边都不短于 4 个字符时算，否则 "git" 会把所有条目都匹配上。
          return have.length >= 4 && wantName.length >= 4 && (have.includes(wantName) || wantName.includes(have))
        })
        .map((x: any) => String(x.id))
        .slice(0, 3)
      const r: any = await deps.rulesOps['rules-create']({ group, name, description, body, enabled: true })
      if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to create the memory')
      // 刚建好的这条自己会在列表里，从名单里去掉。
      const dup = similar.filter((id) => id !== String(r.rule.id))
      const warn = dup.length
        ? `\nnote: ${dup.length} existing memories have a similar name or description (${dup.join(', ')}) — if it is the same thing, update that one instead of keeping two.`
        : ''
      // 回执必须同时说清**两个**条件：记忆本身已开启（本工具创建时传了 `enabled: true`），
      // 但它落进的场景在这个对话里未必开着 —— 场景没开，单条开关拨上去也不会注入。
      // 「会不会注入」按**本会话**的投影判：会话钉了别的场景时，照全局口径回一句
      // "打开就能用"是错的答案。
      const scoped = sessionScopeOf(deps, exec && exec.agent)
      const effScene = scoped?.scope?.scene
      const activeNow = effScene === undefined ? all.activeScene : effScene
      const activeMode = effScene === undefined ? all.activeMode : 'custom'
      const sceneActive = group === 'global' ||
        (group !== '' && (activeMode === 'all' || String(activeNow || '') === group))
      const enableHint = sceneActive
        ? ' (created enabled)'
        : ' (created enabled, but scene "' + group + '" is not on in this conversation, so it will not be injected here until that scene is turned on)'
      // 会话层：这条记忆写的是**磁盘上的那一份**（所有对话共用），本会话的开关只决定
      // "这里看不看得到"。模型据此回一句"记下了"时，用户很容易读成"只在这个对话里"。
      return 'OK: created ' + r.rule.id + enableHint + warn +
        globalActionNote(deps, exec && exec.agent, 'memory', 'memory')
    },
  }))

  // ── 自主笔记（只在开关打开时出现在工具表里）────────────────────────────────
  //
  // 为什么不复用 `memory_manager_save`：那条的契约是「Only on the user's instruction」并且
  // 受确认门禁。自主笔记需要零摩擦：给 `save` 加一个 `auto` 参数会让同一个工具同时代表
  // 两种授权，门禁只能按参数分叉；模型传错一次就是"该问的没问"。授权边界写在工具名上。
  //
  // 与用户记忆分开的另一点是**对象**：笔记是一句话、按层（global / workspace）走；
  // 用户记忆是多段、按场景走。读取统一走 `memory_get`，这里只保留写入与删除。
  // 弹卡策略：自动确认关 → 每次都问；开 → 不弹卡，由 agent 决定。生效判断在 gates 的 `autoActive`。
  if (!deps.evolutionOps || !deps.autoLearnEnabled) return
  const noteOps = deps.evolutionOps
  // 热路径的频率上限：模型在一轮里反复 learn / 弹卡时，10 分钟窗口最多 5 条。
  const learnCalls = new Map<string, { at: number; n: number }>()
  const LEARN_WINDOW_MS = 10 * 60_000
  const LEARN_MAX = 5

  register(defineTool({
    name: PROACTIVE_MEMORY_TOOL,
    description: 'Agent notes (autonomous memory) — short one-line notes you learned: a preference, fact, correction or procedure. Only for what YOU inferred; when the user explicitly asks to remember something, use memory_manager_save instead. learn: `title` (2-8 words) + `text` (one sentence, <=400 chars); `layer` global = every project / workspace = this one; pass `slot` (a stable name) when you may update or forget it later; `quote` + `source` when the user said it. forget: `note` = id (note:...), slot, title or exact text. Inspect notes with the memory read tool. Only when the user asks you to remember, or just corrected you; do not scan the conversation for candidates.',
    parameters: {
      action: { type: 'string', enum: ['learn', 'forget'], required: true, description: 'learn or forget.' },
      // ── learn ──
      title: { type: 'string', description: 'learn: a short name for the row (2-8 words, <=40 chars), in the user\'s language.' },
      text: { type: 'string', description: 'learn: the note itself — one sentence (<=400 chars), in the user\'s language.' },
      source: { type: 'string', enum: ['user_explicit', 'user_correction', 'tool_verified', 'model_inference'], description: 'learn: why you know it; user_explicit when you quote the user, user_correction when they corrected you; default model_inference (or user_explicit when quote is set).' },
      quote: { type: 'string', description: 'learn: the user\'s exact words; implies source=user_explicit unless source says otherwise.' },
      slot: { type: 'string', description: 'learn: optional stable slot name; learning again with the same slot merges into that note.' },
      boundary: { type: 'string', description: 'learn: optional; when it may not hold.' },
      layer: { type: 'string', enum: ['global', 'workspace'], description: 'learn: global (every project) or workspace (this project). Omit only when unsure; the card asks, or auto-confirm uses the default.' },
      ttlDays: { type: 'number', description: 'learn: optional; re-check after N days.' },
      // ── forget ──
      note: { type: 'string', description: 'forget: the note — id (note:...), slot, title, or exact text.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const agent = exec && exec.agent
      if (!deps.autoLearnEnabled!(agent)) {
        // 开关在调用途中被关掉（另一个窗口 / 本会话切了）也要说清，而不是静默什么都不做。
        throw new Error('autonomous memory is off here, so nothing was done. The user can turn it on in Memory → Autonomous memory.')
      }
      const action = String((args && args.action) || 'learn')

      if (action === 'forget') {
        const ref = noteArgOf(args)
        if (ref === '') throw new Error('missing argument: note — the note id (note:...), slot, title or exact text.')
        const raw = stripNoteRef(ref)
        const forget = async (id: string): Promise<any> => noteOps['evolution-forget']({ id, actor: 'model' })
        let r: any = await forget(raw)
        if (!r || r.ok === false) {
          // 注入行只显示 key / 摘要，模型不一定记得 id：按 id / slot / title / 原文反查一次，唯一命中才删。
          const resolved = await resolveNote(raw)
          if (resolved.id !== null) r = await forget(resolved.id)
          else if (resolved.hits.length > 1) {
            throw new Error('ambiguous: "' + ref + '" matches ' + describeNoteHits(resolved.hits) + '; pass one of these ids.')
          }
        }
        if (!r || r.ok === false) {
          // 用户记忆 id 也是 `<scene>/<name>` 形状；零命中时明确说这不是笔记，别让模型再猜。
          if (raw.includes('/')) {
            throw new Error('no such agent note: ' + ref + '. That looks like a user memory id (<scene>/<name>) — user memories are disabled or deleted on the Memory page, not here. Agent note ids start with note:.')
          }
          throw new Error(String((r && r.error) || 'failed to forget it'))
        }
        return 'OK: forgot ' + noteRefOf(String(r.id || raw)) + '. It will not be learned again for 30 days.'
      }

      if (action !== 'learn') throw new Error('unknown action: ' + action + ' (expected learn / forget)')

      // save 的参数串进来时（`body` / `description` / `memory`），直接指回用户记忆，
      // 别让一次完整记忆被当成一句话笔记丢掉。
      if (args && (args.body !== undefined || args.description !== undefined || args.memory !== undefined)) {
        throw new Error('those are user-memory parameters, not note parameters: for a full memory call memory_manager_save with memory=<scene>/<name>, description and body. For a note pass title and text (the same slot updates the existing note).')
      }

      // ── learn（默认）──
      const identity = deps.sessionIdentity ? deps.sessionIdentity(agent) : null
      if (identity?.sessionId) {
        const now = Date.now()
        const hit = learnCalls.get(identity.sessionId)
        if (!hit || now - hit.at > LEARN_WINDOW_MS) {
          if (learnCalls.size > 256) learnCalls.clear()
          learnCalls.set(identity.sessionId, { at: now, n: 1 })
        } else if (hit.n >= LEARN_MAX) {
          throw new Error('already tried to save ' + LEARN_MAX + ' notes in the last 10 minutes; stop and continue the task. The user can still ask you to remember more.')
        } else {
          hit.n += 1
        }
      }
      const text = String((args && args.text) || '').trim()
      if (text === '') throw new Error('missing argument: text — the note itself, one sentence.')
      const quote = String((args && args.quote) || '').trim()
      const payload: any = {
        text,
        // 给了引句就是用户原话：不传 source 时按 user_explicit 起步，别让证据门把它降级成模型推断。
        source: (args && args.source) || (quote !== '' ? 'user_explicit' : 'model_inference'),
      }
      for (const key of ['title', 'quote', 'boundary', 'layer', 'ttlDays'] as const) {
        if (args && args[key] !== undefined && args[key] !== '') payload[key] = args[key]
      }
      // `slot` 是模型面的名字；op 的字段仍是 `key`（同 slot 合并）。`key` 作为旧名兼容一次。
      const slot = String((args && (args.slot !== undefined ? args.slot : args.key)) || '')
      if (slot !== '') payload.key = slot
      if (identity?.sessionId) payload.sessionId = identity.sessionId
      if (identity?.cwd) payload.cwd = identity.cwd
      const scene = deps.activeSceneOf ? deps.activeSceneOf(agent) : undefined
      if (scene !== undefined) payload.scene = scene

      // 没有 preview / 卡片依赖（旧装配、测试）：保持原来的待确认路径。
      const previewOp = noteOps['evolution-preview']
      const ask = deps.askMemoryScope
      if (!previewOp || !ask) {
        const r: any = await noteOps['evolution-learn'](payload)
        if (!r || r.ok === false) throw new Error(String((r && r.error) || 'failed to record it'))
        return learnReceipt(r, 'none', payload)
      }

      // 先只读预演：同时拿到「弹卡后会发生什么」与「不弹卡直接落盘会发生什么」。
      const preview: any = await previewOp(payload)
      if (!preview || preview.ok === false) {
        // 门禁拒绝是**正常的业务结果**，不是异常：把它当异常抛会让模型以为工具坏了。
        // 但工具层只能通过 throw 回话，所以把 `error` 原样抛（它已经是一句给模型看的话）。
        throw new Error(String((preview && preview.error) || 'failed to record it'))
      }
      // 自动确认：不弹卡，模型给的层就是最终层；后台复习也走这条授权。
      if (preview.autoConfirm === true) {
        const r: any = await noteOps['evolution-learn']({ ...payload, autoActive: true })
        if (!r || r.ok === false) throw new Error(String((r && r.error) || 'failed to record it'))
        return learnReceipt(r, 'auto', payload)
      }

      const layerProvided = payload.layer === 'global' || payload.layer === 'workspace'
      const layer: ScopeLayer = preview.layer === 'global' ? 'global' : 'workspace'
      // 合并进一条已生效的记忆：层已经定了，结果也仍是 active，不必再问一次。
      if (typeof preview.mergeInto === 'string' && preview.mergeInto !== '' && preview.status === 'active') {
        const r: any = await noteOps['evolution-learn'](payload)
        if (!r || r.ok === false) throw new Error(String((r && r.error) || 'failed to record it'))
        return learnReceipt(r, 'none', payload)
      }

      // 其余一律弹卡：新条目、候选合并、冲突都由用户选层；选了就批准并立即生效。
      const allowed: ScopeLayer[] = Array.isArray(preview.allowedLayers)
        ? (preview.allowedLayers as unknown[]).filter((l): l is ScopeLayer => l === 'global' || l === 'workspace')
        : []
      const request: ScopeAskRequest = {
        text: String(preview.text || payload.text || ''),
        ...(typeof preview.boundary === 'string' && preview.boundary !== '' ? { boundary: preview.boundary } : {}),
        // 只有模型明确给了层才标「推荐」；省略层就是不确定，让用户自己选。
        ...(layerProvided ? { recommended: layer } : {}),
        allowed: allowed.length > 0 ? allowed : [layer],
        ...(typeof preview.mergeInto === 'string' && preview.mergeInto !== '' ? { mergeInto: preview.mergeInto } : {}),
        ...(Array.isArray(preview.supersedes) && preview.supersedes.length > 0
          ? { supersedes: (preview.supersedes as unknown[]).filter((x): x is string => typeof x === 'string') }
          : {}),
        ...(exec && exec.signal !== undefined ? { signal: exec.signal } : {}),
      }
      const choice = await ask(agent, request)

      // 没有可用卡片（headless / 非 live root / 卡片异常）：退回待确认，不丢笔记。
      if (choice === null) {
        const r: any = await noteOps['evolution-learn'](payload)
        if (!r || r.ok === false) throw new Error(String((r && r.error) || 'failed to record it'))
        return learnReceipt(r, 'unavailable', payload)
      }
      // 用户在卡片里自己写了说法：不写盘，交回模型按他们的话重写，再调一次 learn 弹卡。
      // 不在同一次工具调用里循环，是因为用户写的可能是一句修改要求（「改成只在写代码时用」），
      // 而不是可以直接落盘的完整正文。
      if (choice.choice === 'revise') {
        return 'Not saved yet. The user wants this note worded differently:\n' +
          String(choice.custom ?? '') + '\n\n' +
          'Rewrite the note to match their wording, then call memory_note action=learn again with the revised text. The card will ask them to confirm the new version.'
      }
      if (choice.choice === 'skip') {
        return 'Not saved: the user chose not to add it. Do not save it again unless they ask.'
      }

      const r: any = await noteOps['evolution-learn']({
        ...payload,
        layer: choice.choice,
        approved: true,
      })
      if (!r || r.ok === false) throw new Error(String((r && r.error) || 'failed to record it'))
      return learnReceipt(r, 'approved', payload)
    },
  }))
}

/** learn 回执。状态（active / pending）以 learn 的返回为准，`card` 只补充「卡片 / 自动路径那一侧发生了什么」。 */
function learnReceipt(r: any, card: 'approved' | 'unavailable' | 'pending-conflict' | 'pending' | 'none' | 'auto', payload?: any): string {
  const parts = ['OK: recorded ' + noteRefOf(String(r.id))]
  // 回执要给出之后能原样引用的东西：id 与 slot 都在，模型就不必猜 title/quote 哪个是键。
  if (payload && typeof payload.key === 'string' && payload.key !== '') parts.push('slot: ' + payload.key)
  if (payload && typeof payload.title === 'string' && payload.title !== '') parts.push('title: ' + payload.title)
  if (r.merged === true) {
    parts.push(String(r.status === 'active' ? 'merged into an existing active note' : 'merged into an existing pending note'))
  } else if (r.status === 'active') {
    parts.push('saved as active')
  } else {
    parts.push('saved as pending review — not injected until the user confirms it on the Memory page')
  }
  if (r.merged !== true && typeof r.confidence === 'number') parts.push('confidence ' + r.confidence.toFixed(2))
  if (Array.isArray(r.supersedes) && r.supersedes.length) parts.push('replaced ' + r.supersedes.join(', '))
  if (r.note) parts.push(String(r.note))
  if (r.needsReview) parts.push('needs review: ' + String(r.needsReview))
  if (card === 'approved' && r.status !== 'active' && r.needsReview) {
    parts.push('the card approved it, but it stayed pending for the reason above')
  }
  if (card === 'unavailable') parts.push('no interactive card was available, so it stayed pending')
  if (card === 'pending-conflict') parts.push('it conflicts with a memory the user wrote; they can resolve it on the Memory page')
  if (card === 'pending') parts.push('it stayed pending for the reason above')
  // 层要说出来：用户以为"只在这个项目里"，实际它进了全局（别的项目也会出现）——
  // 这个误读比记错内容更难发现。
  const layerNote: Record<string, string> = {
    global: 'applies in every project',
    workspace: 'applies in this project (visible to other conversations here too)',
  }
  if (typeof r.layer === 'string' && layerNote[r.layer]) parts.push(layerNote[r.layer])
  return parts.join('; ')
}
