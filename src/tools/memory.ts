// 记忆（rules）域的 model 工具：memory_get / memory_switch / memory_remember。
//
// 自主笔记（agent 学的一句话）是另一族 `memory_note`：两族按对象分开，读取统一走
// `memory_get`，id 形状也不同（用户记忆 `<scene>/<name>`，笔记 `note:<layer>/<slug>`）。
//
// 为什么工具名是 `memory_*` 而不是 `scene_memory_manager_*`：后者描述的是**域**，
// 而这些工具操作的全是记忆。加场景能力时这个错配就现形了 —— 场景是另一个对象（容器，
// 进入时切换 mcp / 技能 / 人设），硬塞进同一个写工具会让 `description` 变成双义参数、
// 门禁按参数分叉（记忆写入有开关可放行，场景写入是改运行时环境、不该有那条路）。
// 所以拆成两族：这里管记忆内容，`scene_manager_*`（tools/scene.ts）管场景本身。
//
// 场景清单也不挂在这条 list 的尾巴上（「记忆就管记忆，场景就管场景」）——
// 它在 `scene_manager_list`，理由记在 tools/scene.ts 头部，别当"少写了一段"再加回来。
//
// 为什么 write + update 并成 save：两者的判定（同名 = 改、无同名 = 建）本来就只有
// `rules-create` 知道 —— 它对同名是**拒绝**的，op 层不会替你 upsert。分开两条工具时，
// 模型必须自己先查一次再决定调哪条，而它手里的清单可能已经过期。合并后由工具侧兜住。
//
// 活动场景的记忆正文会自动注入上下文（无需调用工具读取）；这里的工具用于查询/编辑规则
// 本身。memory_remember 受 tools/pre-execute 审批门禁。
// 路径锚点：$DSH_HOME/tool-management/memories/<场景>/…（场景 `global` = 界面「全局」）。

import { GLOBAL_SCENE, MAX_DESCRIPTION_LENGTH, MAX_GROUP_SEGMENT_LENGTH, SHARED_GROUP } from '../memories/constants.js'
import { MAX_AUTO_DESCRIPTION, MAX_AUTO_TEXT_WIDTH, MAX_AUTO_TITLE_WIDTH } from '../evolution/write.js'
import { textWidthOf, truncateToWidth } from '../text-width.js'
import type { ScopeAskRequest, ScopeChoice, ScopeLayer } from '../evolution/scope-card.js'
import { LIST_LIMIT_MAX, effectiveScope, existingNote, globalActionNote, globalUnchangedNote, isolationOffNote, listLimit, moreNotShown, scopeOnlyNote, scopeSessionDesc, sessionScopeOf, text, toolOrNeutral, type ToolDomainDeps } from './deps.js'
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
  /** 能不能列 / 读笔记；与「能不能学」分开（子代理可读不可学）。 */
  autoNotesReadable?: (agent: unknown) => boolean
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
   * 三条口径（都由真实测试暴露出来）：
   *   - **原文 = 注入行里那一行**（`oneLine`，去标点的首句），不是整段正文。模型的引用
   *     来自它看到的注入行，让它去猜"整段正文"只会白试一轮。末尾标点也一并忽略。
   *   - **先按活跃状态过滤**：同 slot 冲突替换后会留下一条 `superseded`，它与新的那条
   *     同 key。不过滤就会报 ambiguous —— 而 agent 用 slot 当稳定句柄的前提就没了。
   *     只有多条**活跃**同引用时才报歧义，防删错的初衷不变。
   *   - 活跃状态一个都没有时退回全量匹配，让错误消息能给出候选。
   */
  const resolveNote = async (ref: string): Promise<{ id: string | null; hits: any[] }> => {
    const raw = stripNoteRef(ref)
    if (raw === '' || !evo) return { id: null, hits: [] }
    const list: any = await evo['evolution-list']({ all: true })
    const rows: any[] = list && Array.isArray(list.entries) ? list.entries : []
    const trimEnd = (s: unknown): string => String(s ?? '').replace(/[。．.!！?？\s]+$/, '')
    const matches = (e: any): boolean =>
      String(e.id || '') === raw ||
      String(e.key || '') === raw ||
      String(e.title || '') === raw ||
      String(e.oneLine || '') === raw ||
      trimEnd(e.oneLine) === trimEnd(raw)
    const live = rows.filter((e: any) => {
      const st = String(e.status || '')
      return st === 'candidate' || st === 'active' || st === 'core' || st === 'playbook'
    })
    const activeHits = live.filter(matches)
    if (activeHits.length === 1) return { id: String(activeHits[0].id), hits: activeHits }
    if (activeHits.length > 1) return { id: null, hits: activeHits }
    const hits = rows.filter(matches)
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
    if (raw === '') throw new Error('missing argument: id — the note id (note:...), its slot, its title, or the first line of the note as injected (trailing punctuation ignored).')
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
    if (a.alias) lines.push('also said as: ' + String(a.alias))
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
    // 与用户记忆搜索同口径：搜索覆盖归档 / 未注入的条目，`all` 只影响清单。
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
    // 搜索不跟随 `all`：找一条已停用 / 归档的条目正是搜索的用途（新建前先确认有没有）。
    // 带场景过滤时向 op 要满上限，否则 op 先按 limit 截断、再过滤，目标场景的命中会被挤掉。
    const opArgs: any = { query, limit: scene !== undefined ? LIST_LIMIT_MAX : limit }
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

  /**
   * 从标题或正文首行派生文件名：保留 Unicode，去掉路径分隔符与控制字符，空白压成 `-`。
   *
   * 用户说的是「记录一下：以后提交前跑测试」，不会给文件 slug。文件名必须是一个合法路径段
   * （`isValidGroupSegment` 允许 Unicode），所以这里只做最低限度的清洗；真正的合法性
   * 仍由 `rules-create` 兜底。
   */
  const slugOf = (raw: string): string => {
    const line = String(raw || '').split('\n').map((l) => l.trim()).find((l) => l !== '') || ''
    const cleaned = line
      .replace(/^#+\s*/, '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, MAX_GROUP_SEGMENT_LENGTH)
    return cleaned !== '' ? cleaned : 'memory'
  }

  /** 正文首行（去掉 markdown 标题标记），用于派生描述。 */
  const firstLineOf = (raw: string): string => {
    const line = String(raw || '').split('\n').map((l) => l.trim()).find((l) => l !== '') || ''
    return line.replace(/^#+\s*/, '').slice(0, 500)
  }

  /** 当前可用场景名：`scenes` 行与规则里的 group 取并集（有记忆但没显式记录的场景也要认）。 */
  const sceneNamesOf = (r: any): string[] => {
    const names = new Set<string>()
    const rows: any[] = Array.isArray(r && r.scenes) ? r.scenes : []
    for (const s of rows) {
      const name = String((s && (s.key || s.name)) || '')
      if (name !== '') names.add(name)
    }
    for (const x of (Array.isArray(r && r.rules) ? r.rules : [])) {
      const group = String((x && x.group) || '')
      if (group !== '') names.add(group)
    }
    return [...names]
  }

  register(defineTool({
    name: 'memory_get',
    description: 'Look up user-written memories and agent notes. No id → catalog (what exists and what injects); `id` → full body; `query` → filtered catalog with snippets. Agent note ids start with `note:`. Use this for ids and for entries not already in your context. Read-only.',
    parameters: {
      id: { type: 'string', description: 'Read one entry: a user memory id (<scene>/<name>) or an agent note id (note:...).' },
      query: { type: 'string', description: 'Filter the catalog by words in id, scene, description, tags or body; every word must match (case-insensitive).' },
      kind: { type: 'string', enum: ['memory', 'note'], description: 'Limit the catalog to user-written memories or agent notes.' },
      scene: { type: 'string', description: 'Only user memories in this scene; `global` is the always-on scene.' },
      all: { type: 'boolean', description: 'Catalog only: include entries that are off, in an inactive scene, or archived (default false). Search always covers everything.' },
      limit: { type: 'number', description: 'Max entries per kind (default 50, max 100).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      // 参数写错要报错，不能静默降级：`limit` 被夹取、空 `query` / 空 `id` 被当成没传，
      // 调用方会以为查询按自己的意图跑了。
      if (args && args.limit !== undefined) {
        const n = Number(args.limit)
        if (!Number.isFinite(n) || n < 1 || n > LIST_LIMIT_MAX) {
          throw new Error('limit must be a number between 1 and ' + LIST_LIMIT_MAX)
        }
      }
      if (args && args.query !== undefined && String(args.query).trim() === '') {
        throw new Error('query is empty: pass words to search for, or omit it to list the catalog')
      }
      if (args && args.id !== undefined && String(args.id).trim() === '') {
        throw new Error('id is empty: pass a memory id, or omit it to list the catalog')
      }
      const id = String((args && args.id) || '').trim()
      if (id !== '') return readEntry(id, exec)
      const query = String((args && args.query) || '').trim()
      const kind = args && args.kind === 'note' ? 'note' : args && args.kind === 'memory' ? 'memory' : ''
      const all = args && args.all === true
      const limit = listLimit(args && args.limit)
      const scene = args && typeof args.scene === 'string' && args.scene !== '' ? args.scene : undefined
      // 自主记忆关着时，笔记不在这份清单里出现：功能没开，模型不该看到「有笔记可读」
      // 这种半开状态（直接给 note: id 仍然读得到 —— 那是显式请求）。
      const readable = deps.autoNotesReadable ?? deps.autoLearnEnabled
      const notesOn = Boolean(evo && readable && readable(exec && exec.agent))
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
    name: 'memory_switch',
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
      id: { type: 'string', description: 'Memory id like <scene>/<name>.' },
      // 改名前的参数名。保留在 schema 里，旧调用习惯（以及确认门的兼容分支）才真的走得通。
      memory: { type: 'string', description: 'Deprecated alias for id; use id.' },
      enabled: { type: 'boolean', required: true, description: 'true = enable, false = disable.' },
      // 默认只改**这个对话**。写全局要显式说明。
      scope: { type: 'string', enum: ['session', 'global'], description: scopeSessionDesc('global = every conversation.') },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      // `memory` 是改名前的参数名，兼容一次；新调用方用 `id`。
      const memory = String((args && (args.id !== undefined ? args.id : args.memory)) || '').trim()
      if (memory === '') throw new Error('missing argument: id — the memory id like <scene>/<name>.')
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
        // 会话覆盖只对真实存在的记忆有意义：拼错的 id 会静默写一条永远不会生效的覆盖。
        const read: any = await deps.rulesOps['rules-read']({ id: memory })
        if (!read || read.ok === false) {
          throw new Error('no such memory: ' + memory + ' (per-conversation switches only apply to existing memories)')
        }
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
          const on = group === GLOBAL_SCENE || group === SHARED_GROUP ||
            (group !== '' && (all.activeMode === 'all' || String(all.activeScene || '') === group))
          if (!on) sceneNote = ' — BUT its scene "' + group + '" is not the one injecting, so it still will not be injected; turn that scene on (or move it to global) first'
        }
      } catch { sceneNote = '' }
      return 'OK: memory ' + String(rule.id || memory) + ' ' + (rule.enabled === false ? 'disabled' : 'enabled') + sceneNote + isolationOffNote(deps)
    },
  }))
  register(defineTool({
    name: 'memory_remember',
    // 写入口只按**范围**分叉，不再按内容长短分叉：用户说「记录 a」时，唯一要判断的是
    // 「记到哪儿」，而那是用户的问题，不是模型能猜的。旧版按"一句话 → 笔记 / 多段 → 记忆"
    // 重定向，模型于是要在两条工具、三种后端之间选，参数串用是必然的。
    description: 'Remember something the user explicitly asked you to keep. scope=scene → a memory in a scene (injected only when that scene is on); scope=global → every project; scope=workspace → a note for this project (needs autonomous memory). Omit scope and ask the user where it belongs; do not guess. Pass `id` to update an existing memory or note instead of creating one. To delete a user memory the user asked you to remove, pass `action: "forget"` and `id` (moved to the recycle bin). For your own inferences use the agent-note tool, not this. User-memory writes are blocked while the active scene is locked.',
    parameters: {
      action: { type: 'string', enum: ['forget'], description: 'forget: delete an existing user memory by `id` (moved to the recycle bin, restorable on the Memory page). Omit to create or update.' },
      content: { type: 'string', description: 'What to remember. For scene/global: the memory body (Markdown, <=256 KiB). For workspace: one sentence (<=400 Chinese chars / 800 letters). Required when creating; do not pass with action=forget.' },
      title: { type: 'string', description: 'Short name: the file name for a user memory, the note title for a workspace note. Omit to derive from the first line.' },
      id: { type: 'string', description: 'Update an existing entry instead of creating: a user memory id (<scene>/<name>) or an agent note id (note:...).' },
      scope: { type: 'string', enum: ['scene', 'global', 'workspace', 'conversation'], description: 'Where it belongs: scene (this working mode), global (every project), workspace (this project, stored as an agent note). Ask the user when unsure.' },
      scene: { type: 'string', description: 'scope=scene: the scene name; defaults to the active scene. `global` is the always-on scene.' },
      description: { type: 'string', description: 'User memories: one-sentence description; omit to derive from the first line.' },
      nextName: { type: 'string', description: 'User memories: rename the existing memory to this file name.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    async execute(args: any, exec: any) {
      const agent = exec && exec.agent
      // 旧两条工具的字段名做一次兼容：`memory`/`body` 来自 save，`text`/`layer`/`slot`
      // 来自 note。模型按旧习惯传进来时不该整次失败 —— 这正是合并写入入口要消掉的摩擦。
      // 只做 fallback，不写进 schema：新调用方看到的仍是 content / id / scope。
      const rawId = String((args && (args.id !== undefined ? args.id : args.memory)) || '').trim()
      const content = String((args && (args.content !== undefined ? args.content : (args.body !== undefined ? args.body : (args.text !== undefined ? args.text : '')))) || '')
      const title = String((args && args.title) || '').trim()
      const nextName = String((args && args.nextName) || '').trim()
      const descriptionArg = args && args.description !== undefined ? String(args.description) : undefined
      const scopeArg = String((args && (args.scope !== undefined ? args.scope : args.layer)) || '').trim()
      const sceneArg = String((args && args.scene) || '').trim()
      const slotArg = String((args && (args.slot !== undefined ? args.slot : args.key)) || '').trim()
      const actionArg = String((args && args.action) || '').trim()

      // 删除是用户明确要求时才走的另一条路：只按 id 定位，绝不把同时带来的 content /
      // description 当成一次更新写回去 —— 真实会话里 `action=forget` + `content` 就把
      // 一条待删记忆的正文改成了「删」，回执却说更新成功。
      if (actionArg !== '' && actionArg !== 'forget') {
        throw new Error('unknown action: ' + actionArg + ' — memory_remember creates or updates; use action=forget with id to delete a user memory.')
      }
      if (actionArg === 'forget') {
        if (rawId === '') throw new Error('missing argument: id — the user memory to delete (<scene>/<name>). Agent notes use memory_note action=forget.')
        if (isNoteRef(rawId)) throw new Error('that is an agent note: delete it with memory_note action=forget.')
        if (!rawId.includes('/')) throw new Error('id must be <scene>/<name> (a user memory): ' + rawId)
        if (content.trim() !== '' || descriptionArg !== undefined || nextName !== '' || title !== '' || slotArg !== '' || scopeArg !== '' || sceneArg !== '') {
          throw new Error('action=forget deletes by id only: do not pass content, title, description, nextName, scope or scene.')
        }
        const blocked = await deps.lockedSceneGuard()
        if (blocked) throw new Error(blocked)
        const all: any = await deps.rulesOps['rules-list']({})
        if (!all || all.ok === false) throw new Error((all && all.error) || 'failed to read memories')
        const hit = (all.rules || []).find((x: any) => String(x.id) === rawId)
        if (!hit) throw new Error('no memory with id "' + rawId + '".' + existingNote((all.rules || []).map((x: any) => String(x.id)), 'memory ids'))
        if (isAutoRule(hit)) throw new Error('that is an agent note: delete it with memory_note action=forget.')
        const r: any = await deps.rulesOps['rules-remove']({ id: rawId })
        if (!r || r.ok === false) throw new Error(String((r && r.error) || 'failed to delete the memory'))
        return 'OK: deleted ' + rawId + ' (moved to the recycle bin; restore it on the Memory page).'
      }

      /** 就地更新一条已有笔记：id / 层 / 状态不变，正文与标题替换。 */
      const updateNote = async (a: any, ref: string): Promise<string> => {
        if (descriptionArg !== undefined) {
          throw new Error('description is for user memories; a note has no description. Use title or content.')
        }
        if (nextName !== '') throw new Error('nextName is for user memories; a note uses title.')
        const layer = String(a.layer || '')
        if (layer !== 'global' && layer !== 'workspace') {
          throw new Error('that note is not a global or workspace note, so memory_remember cannot update it: ' + ref)
        }
        const id = String(a.id || stripNoteRef(ref))
        const text = content !== '' ? content.trim() : String(a.body || '').trim()
        if (text === '') throw new Error('missing argument: content — the updated note text.')
        if (textWidthOf(text) > MAX_AUTO_TEXT_WIDTH || /\n\s*\n/.test(text)) {
          throw new Error('an agent note is one sentence (<= about 400 Chinese chars / 800 letters). This content is longer — use a user memory (scope=scene / global) instead.')
        }
        // 笔记的正文编辑是 `evolution-update`（就地改文件、id/层/状态不变）；
        // `evolution-learn` 是"学一条新的"——同 key 只会合并/追加，没 key 会新建 id，
        // 拿它做更新会把原文留在旧条目里，回执却说"updated"。
        const updateOp = evo!['evolution-update']
        if (typeof updateOp !== 'function') {
          throw new Error('this host cannot edit an agent note in place. Forget it with memory_note action=forget and learn a new one, or use memory_note action=learn with the same slot.')
        }
        const payload: any = { id, text }
        if (title !== '') payload.title = truncateToWidth(title, MAX_AUTO_TITLE_WIDTH)
        const r: any = await updateOp(payload)
        if (!r || r.ok === false) throw new Error(String((r && r.error) || 'failed to update the note'))
        const status = String(r.status || a.status || 'active')
        const state = status === 'active' ? 'active' : status + ' — confirm it in Memory → Autonomous memory before it injects'
        return 'OK: updated ' + noteRefOf(String(r.id || id)) + ' (' + String(r.layer || layer) + ' note, ' + state + ')'
      }

      // 带 id 时 scope 不参与路由，但仍要先挡掉不可能的范围：用户说「只在这个对话里」
      // 时不能因为传了 id 就悄悄改掉磁盘上那份全局记忆。
      if (scopeArg === 'conversation') {
        throw new Error('scope=conversation is not supported: per-conversation memories are not injected. Use scope=scene (this working mode) or scope=global (every project).')
      }
      if (rawId !== '' && scopeArg === 'workspace' && !isNoteRef(rawId)) {
        throw new Error('scope=workspace is for agent notes; to update a user memory pass id alone (or use id=note:... for a note).')
      }

      if (rawId !== '') {
        if (isNoteRef(rawId)) {
          if (!evo) throw new Error('agent notes are not available in this build')
          if (!(deps.autoLearnEnabled && deps.autoLearnEnabled(agent))) {
            throw new Error('autonomous memory is off here, so agent notes cannot be updated. The user can turn it on in Memory → Autonomous memory.')
          }
          const raw = stripNoteRef(rawId)
          let a: any = await evo['evolution-read']({ id: raw, touch: true })
          if (!a || a.ok === false) {
            const resolved = await resolveNote(raw)
            if (resolved.id !== null) {
              const found: any = await evo['evolution-read']({ id: resolved.id, touch: true })
              if (found && found.ok !== false) a = found
            } else if (resolved.hits.length > 1) {
              throw new Error('ambiguous: "' + rawId + '" matches ' + describeNoteHits(resolved.hits) + '; pass one of these ids.')
            }
          }
          if (!a || a.ok === false) throw new Error(String((a && a.error) || 'no such agent note: ' + rawId))
          return updateNote(a, rawId)
        }
        if (!rawId.includes('/')) {
          throw new Error('id must be <scene>/<name> (a user memory) or note:... (an agent note): ' + rawId)
        }
        const blocked = await deps.lockedSceneGuard()
        if (blocked) throw new Error(blocked)
        const all: any = await deps.rulesOps['rules-list']({})
        if (!all || all.ok === false) throw new Error((all && all.error) || 'failed to read memories')
        const hit = (all.rules || []).find((x: any) => String(x.id) === rawId)
        if (!hit) {
          // 与 memory_get 同一条回退：裸 id 也可能是笔记 id（`note:` 前缀可省）。
          if (evo) {
            let note: any = null
            try { note = await evo['evolution-read']({ id: rawId, touch: true }) } catch { note = null }
            if (note && note.ok !== false) {
              if (!(deps.autoLearnEnabled && deps.autoLearnEnabled(agent))) {
                throw new Error('autonomous memory is off here, so agent notes cannot be updated. The user can turn it on in Memory → Autonomous memory.')
              }
              return updateNote(note, rawId)
            }
          }
          const ids: string[] = (all.rules || []).map((x: any) => String(x.id))
          throw new Error('no memory with id "' + rawId + '"' + existingNote(ids, 'memory ids') + '. Pass scope=scene/global/workspace to create a new one.')
        }
        if (isAutoRule(hit)) {
          throw new Error('that is an agent note, not a user memory: update it with id=note:' + rawId + ' or the agent-note tool.')
        }
        const touched: string[] = []
        const payload: any = { id: rawId }
        const contentGiven = Boolean(args && (args.content !== undefined || args.body !== undefined || args.text !== undefined))
        if (contentGiven) {
          if (content.trim() === '') throw new Error('content cannot be empty when updating a memory')
          payload.body = content
          touched.push('content')
        }
        if (descriptionArg !== undefined) { payload.description = descriptionArg; touched.push('description') }
        if (nextName !== '') { payload.name = nextName; touched.push('nextName') }
        if (!touched.length) throw new Error('nothing to change: give content, description, or nextName')
        const r: any = await deps.rulesOps['rules-update'](payload)
        if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to update the memory')
        const rule = r.rule || {}
        return 'OK: updated ' + String(rule.id || rawId) + ' (changed ' + touched.join(', ') + ')' +
          (rule.id && String(rule.id) !== rawId ? ' → now ' + rule.id : '')
      }

      if (content.trim() === '') {
        throw new Error('missing argument: content — what to remember. (The old body / text arguments are now content.)')
      }
      if (nextName !== '') throw new Error('nextName renames an existing memory; to name a new one use title.')
      if (descriptionArg !== undefined && descriptionArg.length > MAX_DESCRIPTION_LENGTH) {
        throw new Error('description is too long (limit ' + MAX_DESCRIPTION_LENGTH + ' chars).')
      }
      const scope = scopeArg !== '' ? scopeArg : (sceneArg !== '' ? 'scene' : '')
      if (scope === '') {
        throw new Error('where should this be remembered? Pass scope=scene (only when this working mode is active), scope=global (every project), or scope=workspace (this project). Ask the user which one; do not guess.')
      }
      if (scope !== 'scene' && scope !== 'global' && scope !== 'workspace') {
        throw new Error('unknown scope: ' + scope + ' (expected scene / global / workspace)')
      }

      if (scope === 'workspace') {
        if (!evo) throw new Error('workspace notes need autonomous memory, which is not available in this build. Use scope=scene or scope=global.')
        if (!(deps.autoLearnEnabled && deps.autoLearnEnabled(agent))) {
          throw new Error('workspace notes need autonomous memory. The user can turn it on in Memory → Autonomous memory, or choose scope=scene / scope=global.')
        }
        const text = content.trim()
        if (textWidthOf(text) > MAX_AUTO_TEXT_WIDTH || /\n\s*\n/.test(text)) {
          throw new Error('a workspace note is one sentence (<= about 400 Chinese chars / 800 letters). This content is longer — use scope=scene (this working mode) or scope=global (every project) for a full memory.')
        }
        const identity = deps.sessionIdentity ? deps.sessionIdentity(agent) : null
        const payload: any = {
          text,
          title: truncateToWidth(title !== '' ? title : text, MAX_AUTO_TITLE_WIDTH),
          key: slotArg !== '' ? slotArg : slugOf(title !== '' ? title : text),
          layer: 'workspace',
          source: 'user_explicit',
          approved: true,
        }
        if (descriptionArg !== undefined && descriptionArg.trim() !== '') {
          payload.description = descriptionArg.slice(0, MAX_AUTO_DESCRIPTION)
        }
        if (identity?.sessionId) payload.sessionId = identity.sessionId
        if (identity?.cwd) payload.cwd = identity.cwd
        const scene = deps.activeSceneOf ? deps.activeSceneOf(agent) : undefined
        if (scene !== undefined) payload.scene = scene
        // 预演一次：`routeLayer` 在工作区层关着或拿不到 cwd 时会静默落到全局。
        // 用户选的是「这个项目」，落到全局是另一件事 —— 写入前先问清楚，别写错再解释。
        const previewOp = evo['evolution-preview']
        if (typeof previewOp === 'function') {
          const preview: any = await previewOp(payload)
          if (!preview || preview.ok === false) {
            throw new Error(String((preview && preview.error) || 'workspace memory is not available here'))
          }
          const allowed: string[] = Array.isArray(preview.allowedLayers) ? preview.allowedLayers : []
          if (preview.layer !== 'workspace' || (allowed.length > 0 && allowed.indexOf('workspace') < 0)) {
            throw new Error('workspace memories are not available here (workspace learning is off, or this workspace could not be resolved). Use scope=global or scope=scene, or turn on workspace autonomous memory.')
          }
        }
        const r: any = await evo['evolution-learn'](payload)
        if (!r || r.ok === false) throw new Error(String((r && r.error) || 'failed to record the workspace note'))
        const ref = r.id ? noteRefOf(String(r.id)) : 'the new note'
        const layer = String(r.layer || '')
        if (layer !== 'workspace') {
          // 旧宿主没有 preview 时可能走到这里：如实说落到了哪一层，别把全局笔记说成工作区笔记。
          return 'Not saved as a workspace note: this host stored it as a ' + (layer || 'global') + ' note (' + ref + '). Workspace memories need workspace learning on and a resolvable workspace; use scope=global or scope=scene instead.'
        }
        const status = String(r.status || 'active')
        const state = status === 'active'
          ? 'active in this workspace'
          : status + ' — confirm it in Memory → Autonomous memory before it injects'
        return 'OK: remembered as a workspace note ' + ref + ' (' + state + '; stored with agent notes).'
      }

      if (scope === 'global' && sceneArg !== '' && sceneArg !== GLOBAL_SCENE) {
        throw new Error('scope=global does not take a scene (got "' + sceneArg + '"). Use scope=scene with that scene, or omit scene.')
      }
      const blocked = await deps.lockedSceneGuard()
      if (blocked) throw new Error(blocked)
      const all: any = await deps.rulesOps['rules-list']({})
      if (!all || all.ok === false) throw new Error((all && all.error) || 'failed to read memories')
      // `_shared` 不进候选：它恒常注入、在界面上也没有开关，agent 往里写等于**自己造一个
      // 常开场景**，绕开了用户对"哪条记忆该生效"的控制。恒常注入的只有 `global` 一个。
      const knownGroups = new Set<string>(sceneNamesOf(all).filter((s) => s !== SHARED_GROUP))
      knownGroups.add(GLOBAL_SCENE)
      let group = scope === 'global' ? GLOBAL_SCENE : sceneArg
      if (scope === 'scene' && group === '') {
        group = String((deps.activeSceneOf ? deps.activeSceneOf(agent) : '') || '')
      }
      if (group === '') {
        const scenes = [...knownGroups].filter((s) => s !== '').sort()
        throw new Error('scope=scene needs a scene, and this conversation has no active scene. Existing scenes: ' + scenes.join(', ') + '. Ask the user which one; do not guess.')
      }
      if (group === SHARED_GROUP) {
        // 显式传了也拒：这条路径上没有"用户明确要求"的证据，而写进去的记忆不受任何开关
        // 控制。要全局生效就用 scope=global；要场景生效就让用户先建 / 开一个场景。
        throw new Error('_shared is not a writable scene: memories there are injected in every conversation and have no on/off switch, so an agent must not create one. Use scope=global for something that should apply everywhere, or scope=scene with a scene the user has turned on.')
      }
      if (group === '_ws' || group.startsWith('_ws/') || group === '_session' || group.startsWith('_session/')) {
        throw new Error('"' + group + '" is internal storage for agent notes, not a user scene. For a workspace note use scope=workspace; for a user memory use an existing scene (global, …).')
      }
      if (!knownGroups.has(group)) {
        const scenes = [...knownGroups].filter((s) => s !== '').sort()
        throw new Error('scene "' + group + '" does not exist — memories can only be created inside an existing scene. Existing scenes: ' + scenes.join(', ') + '. The user creates scenes in the plugin panel (Scenes page); then remember again.')
      }
      const body = content
      const name = slugOf(title !== '' ? title : firstLineOf(body))
      const description = descriptionArg !== undefined && descriptionArg.trim() !== '' ? descriptionArg : firstLineOf(body)
      const id = group + '/' + name
      const hit = (all.rules || []).find((x: any) => String(x.id) === id)
      if (hit) {
        if (isAutoRule(hit)) {
          throw new Error('the derived id "' + id + '" belongs to an agent note, not a user memory. Pick a different title, or use scope=workspace for a note.')
        }
        // 同名 upsert：用户说「记住」两次，第二句通常是在改同一条；替换正文而不是再建一条。
        const payload: any = { id, body }
        if (descriptionArg !== undefined) payload.description = descriptionArg
        const r: any = await deps.rulesOps['rules-update'](payload)
        if (!r || r.ok === false) throw new Error((r && r.error) || 'failed to update the memory')
        return 'OK: updated ' + String((r.rule && r.rule.id) || id) + ' (same name already existed; content replaced)' +
          globalActionNote(deps, agent, 'memory', 'memory')
      }
      const norm = (value: unknown): string => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
      const wantName = norm(name)
      const wantDesc = norm(description)
      const similar: string[] = (all.rules || [])
        .filter((x: any) => !isAutoRule(x))
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
      const dup = similar.filter((sid) => sid !== String(r.rule.id))
      const warn = dup.length
        ? `\nnote: ${dup.length} existing memories have a similar name or description (${dup.join(', ')}) — if it is the same thing, update that one instead of keeping two.`
        : ''
      // 回执必须同时说清**两个**条件：记忆本身已开启（本工具创建时传了 `enabled: true`），
      // 但它落进的场景在这个对话里未必开着 —— 场景没开，单条开关拨上去也不会注入。
      // 「会不会注入」按**本会话**的投影判：会话钉了别的场景时，照全局口径回一句
      // "打开就能用"是错的答案。
      const scoped = sessionScopeOf(deps, agent)
      const effScene = scoped?.scope?.scene
      const activeNow = effScene === undefined ? all.activeScene : effScene
      const activeMode = effScene === undefined ? all.activeMode : 'custom'
      const sceneActive = group === GLOBAL_SCENE || group === SHARED_GROUP ||
        (group !== '' && (activeMode === 'all' || String(activeNow || '') === group))
      const enableHint = sceneActive
        ? ' (created enabled)'
        : ' (created enabled, but scene "' + group + '" is not on in this conversation, so it will not be injected here until that scene is turned on)'
      return 'OK: created ' + r.rule.id + enableHint + warn +
        globalActionNote(deps, agent, 'memory', 'memory')
    },
  }))

  // ── 自主笔记（只在开关打开时出现在工具表里）────────────────────────────────
  //
  // 为什么不复用 `memory_remember`：那条的契约是「Only on the user's instruction」并且
  // 受确认门禁。自主笔记需要零摩擦：给 `save` 加一个 `auto` 参数会让同一个工具同时代表
  // 两种授权，门禁只能按参数分叉；模型传错一次就是"该问的没问"。授权边界写在工具名上。
  //
  // 与用户记忆分开的另一点是**对象**：笔记是一句话、按层（global / workspace）走；
  // 用户记忆是多段、按场景走。读取统一走 `memory_get`，这里只保留写入与删除。
  // 弹卡策略：自动确认关 → 每次都问；开 → 不弹卡，由 agent 决定。生效判断在 gates 的 `autoActive`。
  if (!deps.evolutionOps || !deps.autoLearnEnabled) return
  const noteOps = deps.evolutionOps

  register(defineTool({
    name: PROACTIVE_MEMORY_TOOL,
    description: 'Agent notes (autonomous memory) — short notes you learned: a preference, fact, correction or procedure. Only for what YOU inferred; when the user explicitly asks to remember something, use memory_remember instead. learn: `title` (2-8 words) + `text` (<=400 Chinese chars / 800 letters; 1-2 clear sentences by default, or follow the style line in the learned-notes section); `layer` global = every project / workspace = this one; pass `slot` (a stable name) when you may update or forget it later; `quote` + `source` when the user said it. forget: `note` = id (note:...), slot, title, or the first line as it was injected. Inspect notes with the memory read tool. Only when the user asks you to remember, or just corrected you; do not scan the conversation for candidates.',
    parameters: {
      action: { type: 'string', enum: ['learn', 'forget'], required: true, description: 'learn or forget.' },
      // ── learn ──
      title: { type: 'string', description: 'learn: a short name for the row (2-8 words, <=40 Chinese chars / 80 letters), in the user\'s language.' },
      text: { type: 'string', description: 'learn: the note itself (<=400 Chinese chars / 800 letters), in the user\'s language; by default 1-2 clear sentences, conclusion first, key reason only when it matters. Follow the style shown in the learned-notes section when present. `note` is accepted as an alias.' },
      source: { type: 'string', enum: ['user_explicit', 'user_correction', 'tool_verified', 'model_inference'], description: 'learn: why you know it; user_explicit when you quote the user, user_correction when they corrected you; default model_inference (or user_explicit when quote is set).' },
      quote: { type: 'string', description: 'learn: the user\'s exact words; implies source=user_explicit unless source says otherwise.' },
      slot: { type: 'string', description: 'learn: optional stable slot name; learning again with the same slot merges when it says the same thing, and replaces the old note when it conflicts.' },
      boundary: { type: 'string', description: 'learn: optional; when it may not hold.' },
      layer: { type: 'string', enum: ['global', 'workspace'], description: 'learn: global (every project) or workspace (this project). Omit only when unsure; the card asks, or auto-confirm uses the default.' },
      ttlDays: { type: 'number', description: 'learn: optional; re-check after N days.' },
      // ── forget ──
      note: { type: 'string', description: 'forget: the note — id (note:...), slot, title, or the first line of the note as it was injected (trailing punctuation ignored; the full body is not required). learn: alias for text (the note body).' },
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
        if (ref === '') throw new Error('missing argument: note — the note id (note:...), its slot, its title, or the first line of the note as injected (trailing punctuation ignored).')
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
          // 带 `note:` 前缀的一定是笔记：它只是不存在了，别再说"这像是用户记忆"。
          if (isNoteRef(ref)) {
            throw new Error('no such agent note: ' + ref + ' (it may have been forgotten or archived). List the current notes with memory_get kind=note.')
          }
          // 用户记忆 id 也是 `<scene>/<name>` 形状；零命中时明确说这不是笔记，别让模型再猜。
          if (raw.includes('/')) {
            throw new Error('no such agent note: ' + ref + '. That looks like a user memory id (<scene>/<name>) — user memories are disabled or deleted on the Memory page, not here. Agent note ids start with note:.')
          }
          // 走到这里说明 id / slot / title / 注入行都没命中。`evolution-forget` 的内部错
          // （`not a memory id`）对模型没有任何可执行信息 —— 它要的是"下一步做什么"。
          throw new Error('no such agent note: "' + ref + '". Pass its id (note:<layer>/<slug>), its slot, its title, or the first line exactly as it was injected; list the current notes with memory_get kind=note to find one.')
        }
        return 'OK: forgot ' + noteRefOf(String(r.id || raw)) + '. It will not be learned again for 30 days.'
      }

      if (action !== 'learn') throw new Error('unknown action: ' + action + ' (expected learn / forget)')

      // save 的参数串进来时（`body` / `description` / `memory`），直接指回用户记忆，
      // 别让一次完整记忆被当成一句话笔记丢掉。
      if (args && (args.body !== undefined || args.description !== undefined || args.memory !== undefined)) {
        throw new Error('those are user-memory parameters, not note parameters: for a full memory call memory_remember with content and scope=scene/global. For a note pass title and text (the same slot merges the same meaning and replaces a conflicting note).')
      }

      // ── learn（默认）──
      const identity = deps.sessionIdentity ? deps.sessionIdentity(agent) : null
      // `note` 是模型按工具名最常写的那个字段（真实会话里就有人把正文塞进 `note`，
      // 然后在 `text` 的必填校验上白跑一次）。learn 时把它当正文别名；forget 仍只读 `note`。
      const bodyArg = args && String(args.text || '').trim() !== '' ? args.text : args && args.note
      const text = String(bodyArg || '').trim()
      if (text === '') throw new Error('missing argument: text (or note) — the note itself, one sentence.')
      // 非法 TTL 不能静默落默认值：调用方会以为"30 天后重查"生效了。
      if (args && args.ttlDays !== undefined) {
        const ttl = Number(args.ttlDays)
        if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('ttlDays must be a positive number of days')
      }
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
  // 回执要报落盘值：标题超宽时写入侧会截到 MAX_AUTO_TITLE_WIDTH，回显原串会让模型以为它存下了完整标题。
  if (payload && typeof payload.title === 'string' && payload.title !== '') parts.push('title: ' + truncateToWidth(payload.title.trim(), MAX_AUTO_TITLE_WIDTH))
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
