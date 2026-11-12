// 自动段的渲染：每个域只渲染**一层**（全局 / 本工作区）。
//
// 三条硬约束，每一条都对应一个会毁掉体验的具体故障：
//
// ① **预算按层独立**。两个自动记忆域各占一条消息，各自只装自己那一层的条目；上限是该层
//    max + 固定开销。用户记忆是另一条消息，不在这里竞争 —— 手写记忆再多也不会把自动段挤成 0，
//    反过来自动记忆再多也挤不掉用户写的东西。拆域之前两层共用一脚预算，任何一条新增都会让
//    整段（含用户记忆）重发；现在只有变化的那一层会重发。
//
// ② **不按场景分组**。全局层就是全局；「本工作区」块里的工作区 / 旧会话 / 旧场景条目都按
//    本地处理，不写成 `## Scene Memories: X` —— 那会让模型以为用户建了一个叫 `_ws/3f2a` 的场景。
//
// ③ **文本稳定**。注入去重按正文字节比对，任何"按当前时间算"的东西（相对时间、随机顺序、
//    每次重排）都会让整段每轮重发。所以：条目按固定规则排序，时间只体现为分数（影响谁进来），
//    不体现为文本。

import {
  AUTO_MEMORY_NOTE, AUTO_MEMORY_NOTE_PARTIAL,
  LAYER_GLOBAL, LAYER_SCENE, LAYER_SESSION, LAYER_WORKSPACE, TRUNCATION_MARKER,
  type MemoryLayer,
} from './constants.js'
import { isInjectableStatus, type CatalogEntry } from './catalog.js'
import { itemBlock } from './projection.js'
import { scoreOf, tierOf, type EntryCounters, type EvolutionState } from '../evolution/state.js'

/** 自动记忆的两个注入层。 */
export type AutoLayer = 'global' | 'workspace'

export interface AutoRenderScope {
  workspaceHash?: string
  sessionId?: string
  enabledScenes?: Set<string>
}

export interface AutoRenderInput {
  entries: CatalogEntry[]
  state: EvolutionState
  scope: AutoRenderScope
  /** 共享注入总盘（字节）：手写记忆 + 自主笔记共用这一个数。 */
  totalBytes: number
  /**
   * 已被更高优先级内容占掉的字节。
   *
   * 分配顺序（也是丢弃顺序的反向）：手动全局 → 场景记忆 → 全局自主 → 工作区自主。
   * 所以全局层传"手写记忆段的字节"，工作区层再叠加"全局自主段实际用掉的字节"。
   */
  reservedBytes: number
  /**
   * 当前笔记风格的注入行（`noteStyleLineOf` 生成）。空 / 缺省 = 默认风格，不注入 ——
   * 默认档由工具描述约束，额外一行只是常驻字节。
   */
  noteStyleLine?: string
}

export interface AutoRenderResult {
  /** 整段正文（不含框架标题）；空串 = 不注入。 */
  text: string
  /** 不含收尾授权语的正文（含截断 / 降级提示）；合并块自己补收尾句。 */
  body: string
  /** 有条目因预算没进来（合并块的收尾句据此去掉「完整集合」）。 */
  truncated: boolean
  /** 实际注入条数。 */
  count: number
  /** 估算 token。 */
  tokens: number
  /** 本次总盘。 */
  budget: number
  /** 因预算 / 门槛没进来的条数。 */
  dropped: number
  /** 各层进来几条（诊断与界面用）。 */
  byLayer: Record<MemoryLayer, number>
  /** 真正进入这段文本的条目 id（调用方据此写注入计数）。 */
  pickedIds: string[]
  /** 实际注入的条目与对应行（增量注入按 id 做差集）。 */
  picked: Array<{ id: string; line: string }>
}

const zeroByLayer = (): Record<MemoryLayer, number> => ({ global: 0, workspace: 0, scene: 0, session: 0 })

/**
 * 本层还能用多少字节：总盘减去更高优先级内容已占的部分。
 *
 * 不给自动段单独设上限 —— 总盘已经管住了"一共能吃多少"，再叠一层层配额只会让
 * "明明还有空间却不注入"变成一种无法解释的行为。
 */
export function remainingBytesOf(totalBytes: number, reservedBytes: number): number {
  const total = Number.isFinite(totalBytes) ? totalBytes : 0
  const used = Number.isFinite(reservedBytes) ? reservedBytes : 0
  return Math.max(0, total - used)
}

/**
 * 一条笔记的注入块：与手写记忆同构（`itemBlock`），正文**完整**进上下文。
 *
 * 不带类型标签，也**不带 id**：模型不需要知道内部分类；而 id（`_ws/<hash16>/<slug>`）
 * 是磁盘目录，对模型和用户都没有意义 —— 真要按引用定位，`memory_get` 已经支持
 * id / slot / 名称 / 注入行首句四种写法。
 *
 * 边界不再另附：正文落盘时就把 `边界：…` 拼在了末尾（`renderBody`），再附一次会让同一句话
 * 在上下文里出现两遍。
 *
 * **playbook 只放标题**：它带着十几个步骤，整段塞进每轮上下文会吃掉大半预算，而且模型在
 * 没决定执行之前根本用不上。这里只告诉它"有这么一份已验证流程"，真要执行时再 `memory_get`。
 */
export function lineOf(entry: CatalogEntry): string {
  const fallback = entry.id.slice(entry.id.lastIndexOf('/') + 1)
  const name = (entry.title ?? '').trim() || entry.key || ''
  const body = entry.body || entry.oneLine
  if (entry.status === 'playbook') {
    const title = name || fallback
    return `- **${title}** — playbook; read the full note for steps\n`
  }
  // 没有名称的旧条目（`auto_title` 与 `auto_key` 都缺）：只输出正文，不留一对空加粗。
  if (name === '') return `- ${body.trim()}\n`
  return itemBlock(name, body).text
}

const countersOf = (state: EvolutionState, id: string): EntryCounters =>
  state.entries[id]?.counters ?? { injected: 0, read: 0 }

/** 这条目录项是否属于这一层。workspace 域兼容旧数据：会话层按 sid、场景层按启用场景。 */
function inLayer(entry: CatalogEntry, layer: AutoLayer, scope: AutoRenderScope): boolean {
  if (layer === 'global') return entry.layer === LAYER_GLOBAL
  if (entry.layer === LAYER_WORKSPACE) return scope.workspaceHash !== undefined && entry.workspace === scope.workspaceHash
  // 会话层 / 场景层已不再写入，但盘上可能还有旧条目：按当前环境放进「本工作区」块，
  // 不让它们静默消失（维护扫描仍按原规则 GC 会话层）。
  if (entry.layer === LAYER_SESSION) return scope.sessionId !== undefined && entry.session === scope.sessionId
  if (entry.layer === LAYER_SCENE) return scope.enabledScenes !== undefined && scope.enabledScenes.has(entry.scene)
  return false
}

/**
 * 渲染某一层的自动段正文。纯函数：同样的输入永远给同样的字节（去重的前提）。
 *
 * 标题不在这里：全局那块并进 `## Always-on memories`，工作区那块由注入框架给
 * `# Workspace notes`。
 */
export function renderAutoLayer(layer: AutoLayer, input: AutoRenderInput): AutoRenderResult {
  const empty: AutoRenderResult = { text: '', body: '', truncated: false, count: 0, tokens: 0, budget: 0, dropped: 0, byLayer: zeroByLayer(), pickedIds: [], picked: [] }
  // 风格行只进 `text`（注入正文），不进 `body`（条目集合）：合并块用 body 拼用户记忆，
  // 风格行由调用方单独拼在收尾句之后。它也算进条目预算，否则会在满配时把正文顶出上限。
  const styleLine = String(input.noteStyleLine ?? '').trim()
  const styleCost = Buffer.byteLength(styleLine, 'utf8')
  const tailOf = (note: string): string => note + (styleLine === '' ? '' : '\n' + styleLine)
  const budget = remainingBytesOf(input.totalBytes, input.reservedBytes)
  // 收尾句也要占地方：装满了却发不出去，等于这一层白渲染。
  const noteCost = Buffer.byteLength(AUTO_MEMORY_NOTE, 'utf8')
  if (budget <= noteCost + styleCost) {
    const dropped = input.entries.length
    if (dropped === 0) return { ...empty, budget: 0 }
    // 预算耗尽时也要留一句"笔记没显示"：合并块只在 `truncated` 为真时去掉「完整集合」，
    // 没有这一句，模型会以为自动笔记本来就不存在。这里不报条数 —— 这个分支还没按层过滤，
    // `input.entries.length` 会把别的层 / 已停用的条目也算进去。
    const body = `${TRUNCATION_MARKER} Learned notes are not shown here because the hand-written memories are large; list them with memory_get (kind=note).`
    // 「Learned notes」在这里指**这一类**（agent 学的笔记），不是板块名 —— 板块名随层不同，
    // 这句要在两层的渲染里都读得通。
    const text = body + '\n\n' + tailOf(AUTO_MEMORY_NOTE_PARTIAL) + '\n'
    return { ...empty, text, body, truncated: true, tokens: Math.ceil(Buffer.byteLength(text, 'utf8') / 3), budget: 0, dropped }
  }

  const usable = budget - noteCost - styleCost
  const scope = input.scope

  // 候选：状态可注入 + 层匹配 + 没有待裁决理由。
  const candidates: Array<{ entry: CatalogEntry; score: number }> = []
  for (const entry of input.entries) {
    if (!entry.enabled) continue
    if (!isInjectableStatus(entry.status)) continue
    if (!inLayer(entry, layer, scope)) continue
    const st = input.state.entries[entry.id]
    // 待裁决的不注入：与用户记忆冲突、或表述有歧义的条目，等用户确认后才算数。
    //
    // **只看 `pendingReason`，不看 `reviewDue`**：后者是「这条有点旧了，看一眼」的提醒，
    // 不是停用。两者曾共用一个字段，于是维护扫描一挂 TTL 提醒，一条仍在生效的记忆就从
    // 上下文里消失了 —— 界面还显示生效、预算还把它算进去，而模型一条都看不到。
    if (st && typeof st.pendingReason === 'string' && st.pendingReason !== '') continue
    candidates.push({
      entry,
      score: scoreOf(
        {
          // 档位从证据算，不从 catalog 读：catalog 是派生数据，多存一份就多一处会漂。
          tier: st ? tierOf(st.evidence) : 'inferred',
          updatedAt: new Date(entry.mtime || 0).toISOString(),
        },
        countersOf(input.state, entry.id),
      ),
    })
  }

  // 一条候选都没有：只发风格行。风格行是「以后怎么写」的写作规范，与「现在有没有条目可注入」
  // 无关 —— 只学不用（`inject: false`）正好落进这里：条目一条都不进，而学习还在继续，
  // 吞掉风格行会让用户选的「详细 / 极简 / 自定义」对这批笔记完全失效，而 `memory_note` 的
  // 工具描述还让模型去 `follow the style line in the learned-notes section`。
  if (candidates.length === 0) {
    if (styleLine === '') return { ...empty, budget, dropped: 0 }
    const text = styleLine + '\n'
    return { ...empty, text, budget, dropped: 0, tokens: Math.ceil(Buffer.byteLength(text, 'utf8') / 3) }
  }

  // 排序必须是**确定**的：分数降序 → id 升序（同分时给一个稳定次序，否则每次 pre-step 顺序都变，
  // 去重指纹跟着变，整段重发）。
  candidates.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))

  // 预算按**实际渲染块**的字节记，不按 `estTokens`：块里还有 `- `、加粗的名称与围栏，
  // 估算口径会少算，条目一多就顶穿总盘。
  const costOf = (entry: CatalogEntry): number => Buffer.byteLength(lineOf(entry), 'utf8')
  // **固定开销要先扣掉**：段尾那句收尾语、两个换行、以及"还有 N 条没列出"的截断标记。
  //
  // 早先只累计条目块，标记与换行完全没进 `spent` —— 于是 `auto.text` 实测会超出本层预算
  // 几十到上百字节，两层叠起来就顶穿 256 KiB 的总盘。"按实际渲染块字节记"是这一层的
  // 不变量，标记也是渲染块的一部分。
  const tailBytes = Buffer.byteLength('\n' + tailOf(AUTO_MEMORY_NOTE_PARTIAL) + '\n', 'utf8')
  const markerBytes = Buffer.byteLength('\n' + `${TRUNCATION_MARKER} ${candidates.length} more learned note(s) not shown; list them with memory_get (kind=note).` + '\n', 'utf8')
  const fixed = tailBytes + markerBytes
  const picked: CatalogEntry[] = []
  let spent = 0
  for (const cand of candidates) {
    // 只按字节停：装不下就跳过这一条、继续试更短的，直到预算用尽。
    // 不设条数上限 —— 条数多到读不动的问题由字节预算自己解决（正文越长装得越少）。
    const cost = costOf(cand.entry)
    // 预留 `fixed`：真出现截断时标记要放得下，不截断时那几个字节就是安全余量。
    if (fixed + spent + cost > usable) continue
    picked.push(cand.entry)
    spent += cost
  }

  if (picked.length === 0) {
    const body = `${TRUNCATION_MARKER} ${candidates.length} more learned note(s) not shown; list them with memory_get (kind=note).`
    const text = body + '\n\n' + tailOf(AUTO_MEMORY_NOTE_PARTIAL) + '\n'
    return { ...empty, text, body, truncated: true, tokens: Math.ceil(Buffer.byteLength(text, 'utf8') / 3), budget, dropped: candidates.length }
  }

  // 单层内按正文排序：先总则后特例在这里没有意义（层已经分开了），稳定才是第一位的。
  picked.sort((a, b) => a.oneLine.localeCompare(b.oneLine) || a.id.localeCompare(b.id))

  const dropped = candidates.length - picked.length
  // 每条块的结尾已经带换行（`itemBlock` 如此），拼起来不再补 `\n`。
  const entryBlocks = picked.map(lineOf)
  const lines = [...entryBlocks]
  if (dropped > 0) lines.push('', `${TRUNCATION_MARKER} ${dropped} more learned note(s) not shown; list them with memory_get (kind=note).\n`)
  // 收尾句（与用户记忆的版式一致）：条目 → 截断提示 → 空行 → 收尾句。
  // 截断时去掉「完整集合」声明，否则段尾那句与上面的省略提示自相矛盾。
  const note = dropped > 0 ? AUTO_MEMORY_NOTE_PARTIAL : AUTO_MEMORY_NOTE
  const body = lines.join('')
  const text = body + '\n' + tailOf(note) + '\n'

  const byLayer = zeroByLayer()
  byLayer[layer] = picked.length
  return {
    text,
    body,
    truncated: dropped > 0,
    count: picked.length,
    tokens: Math.ceil(Buffer.byteLength(text, 'utf8') / 3),
    budget,
    dropped,
    byLayer,
    pickedIds: picked.map((e) => e.id),
    picked: picked.map((e, i) => ({ id: e.id, line: entryBlocks[i] })),
  }
}

