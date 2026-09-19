// 补丁文件（cordis.patch.yml）里的「启停覆盖块」识别与收敛计划。
//
// 同一个 loader id 的启停状态有两种写法：insert 行自带的 `disabled:`，以及顶层
// `- id: xxx` + `disabled:` 的独立覆盖块。补丁按顺序应用、**last-wins**
// （见 @deepseek-ai/dsh-app-boot 的 applyEntryPatches：`target[key] = value`），
// 所以覆盖块可以无限追加而每次都不报错 —— 代价是文件越用越长，生效值只能靠
// "最后一条声明了 disabled 的块"推断。
//
// 这里只回答一个问题：要收敛的话，删哪些行区间**且生效值保证不变**。
//
// ⚠ 这个模块第一版出过一次事故：调用方把 `parseRows()` 合并覆盖块之后的**生效值**
// 当基准传进来，而生效值恒等于 decider 的值 —— 于是"decider 的值 == 基准"永远成立，
// 每个 decider 都被当成 no-op 删掉，6 台 MCP 全部被启用。为了从结构上杜绝这种传错，
// 现在的接口是：`planOverrideCompaction(content, otherFileContents)` —— 基准只能由
// 本模块自己从 **insert 行**读（`insertBaseRows`），调用方只能再补"另一份补丁文件的
// 内容"，不能传任何现成的状态值进来。

/** 补丁文件里的一个顶层条目块（从 `- ` 行到下一个 `- ` 行之前）。 */
export interface PatchBlockRange {
  start: number
  end: number
  text: string
}

/** 顶层启停覆盖块（带行号范围，供收敛时删除）。 */
export interface OverrideBlock extends PatchBlockRange {
  id: string
  disabled?: boolean
  /** 只含 id / name / disabled 三行 —— 删它不会动到配置或别的手工覆盖内容。 */
  pure: boolean
}

/** insert 行给出的基准状态（**不是**合并覆盖块之后的生效值）。 */
export interface OverrideBaseRow {
  id: string
  disabled?: boolean
}

/**
 * 顶层块扫描：每个 `- ` 开头的行都是新块的开始，块体延伸到下一个 `- ` 行之前。
 *
 * `end` 剔除块尾的注释/空行 —— 那些行属于"块与块之间"，其中就包括下一个块自己的
 * `# dsh-…:disable:<id>` 标记注释。带上它们的话，删一个块会把下一个块的注释一起带走。
 */
export function scanBlockRanges(lines: string[]): PatchBlockRange[] {
  const out: PatchBlockRange[] = []
  let current: { start: number; lines: string[] } | null = null
  const flush = (): void => {
    if (!current) return
    let end = current.start + current.lines.length
    while (end > current.start + 1 && (lines[end - 1].trim() === '' || /^\s*#/.test(lines[end - 1]))) end--
    out.push({ start: current.start, end, text: current.lines.slice(0, end - current.start).join('\n') })
    current = null
  }
  for (let i = 0; i < lines.length; i++) {
    if (/^- /.test(lines[i])) { flush(); current = { start: i, lines: [lines[i]] } }
    else if (current) current.lines.push(lines[i])
  }
  flush()
  return out
}

/**
 * 读一个覆盖块三件事：id、disabled、是不是"纯块"。
 *
 * 只认**精确列位**的写法（顶层 `- id:`，生成器的 2 空格 `name:` / `disabled:`）：
 * config 里的同名键缩进更深，正则不匹配，于是落入下面的 `pure = false` ——
 * 手工把 `disabled` 藏进 config 的块会被判成"非纯块"（保留不删），保守方向是对的。
 *
 * 不筛 `name:` —— 补丁是按 **loader id** 生效的，别的模块名写同一个 id 时改的仍是
 * 那个条目；真正决定"能不能删"的是 pure 与 decider 两条规则，不是名字。
 */
export function readToggleEntry(lines: string[]): { id?: string; disabled?: boolean; pure: boolean } {
  let id: string | undefined
  let disabled: boolean | undefined
  let pure = true
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const head = line.match(/^- id:\s*(\S+)\s*$/)
    if (head) { id = head[1]; continue }
    if (/^ {2}name:\s*\S+\s*$/.test(line)) continue
    const flag = line.match(/^ {2}disabled:\s*(true|false)\s*$/)
    if (flag) { disabled = flag[1] === 'true'; continue }
    pure = false
  }
  return { id, disabled, pure }
}

/** 覆盖块自己的标记注释（紧邻上方的 `# …:disable|enable:<id>`），删块时一起删。 */
export function markerLinesAbove(lines: string[], start: number): number {
  let i = start
  while (i > 0 && /^# (?:dsh-plugin-tool-management|dsh-mcp-manager):(?:disable|enable):/.test(lines[i - 1])) i--
  return i
}

/** 文件里所有顶层启停覆盖块（按出现顺序）。 */
export function scanOverrideBlocks(content: string): OverrideBlock[] {
  const lines = content.split(/\r?\n/)
  const out: OverrideBlock[] = []
  for (const block of scanBlockRanges(lines)) {
    if (/^- insert:/.test(lines[block.start])) continue
    const entry = readToggleEntry(lines.slice(block.start, block.end))
    if (!entry.id) continue
    out.push({ ...block, id: entry.id, disabled: entry.disabled, pure: entry.pure })
  }
  return out
}

/**
 * **insert 行自带的** 启停基准（`- insert:` 里每个子条目的 `disabled`，缺失 = 启用）。
 *
 * 子条目键只认 6 空格列位（生成器 `    - id:` 之下的 `      disabled:`）—— config 内嵌的
 * 同名键缩进更深，匹配不上，该 id 就按"基准未知"处理（调用方只删被 decider 盖住的块，
 * 绝不删 decider），少删不会错删。
 *
 * 这是收敛判定的唯一合法基准来源：绝不能用 `parseRows()` 那种"合并覆盖块之后的生效值"，
 * 因为生效值就等于最后一条覆盖块的值，"覆盖块的值 == 基准"会恒成立，decider 会被全删。
 *
 * 「无 `disabled` 键」与「有键但值读不出来」是**两件事**（本仓自己的 loader 行就写着
 * `disabled: !!js "..."`，那个值是启动期算出来的）：前者 = 基准未知（不删 decider），
 * 后者同样 = 基准未知。把它们都记成 `false` 会让"基准已知"成立，于是 decider 被当 no-op
 * 删掉 —— 在 `!!js` 那条上就是**按启动期的值做了一次启停翻转判断**（审计 C-15）。
 */
export function insertBaseRows(content: string): OverrideBaseRow[] {
  const lines = content.split(/\r?\n/)
  const out: OverrideBaseRow[] = []
  for (const block of scanBlockRanges(lines)) {
    if (!/^- insert:/.test(lines[block.start])) continue
    let id: string | undefined
    let disabled: boolean | undefined
    const flush = (): void => { if (id) out.push({ id, disabled }) }
    for (const line of block.text.split('\n')) {
      const child = line.match(/^ {4}- id:\s*(\S+)\s*$/)
      if (child) { flush(); id = child[1]; disabled = undefined; continue }
      if (!id) continue
      const flag = line.match(/^ {6}disabled:\s*(true|false)\s*$/)
      if (flag) disabled = flag[1] === 'true'
    }
    flush()
  }
  return out
}

export interface OverrideStat {
  /** 该 id 的覆盖块总数。 */
  total: number
  /** 其中删掉也不改变生效值的块数。 */
  dropped: number
}

/**
 * 收敛计划：算出"删掉也不改变生效状态"的覆盖块行区间。
 *
 * 为什么除最后一条外都能删：补丁按顺序应用，同一 id 的多个覆盖块 last-wins，真正
 * 决定生效值的只有**最后一个声明了 disabled 的块**（decider）。于是：
 *   - decider 之前的纯启停块 → 删（被 decider 盖住）；
 *   - decider 本身 → 仅当它与 insert 行的 disabled 相同（纯 no-op）**且基准已知**时删；
 *   - decider 之后的块 → 留着（它们不声明 disabled，可能改的是别的东西）；
 *   - 带 config 的非纯块 → 一律留着（可能承载手工覆盖内容）。
 *
 * "基准未知"为什么要单列：覆盖块可以打在**补丁文件之外**定义的条目上（profile 的
 * cordis.yml 原生行，或另一份补丁文件的 insert 行）。此时"删掉这条 disabled: false"
 * 完全可能把它翻回原生状态的 disabled: true —— 所以基准未知时只删被 decider 盖住的
 * 那些块，绝不删 decider 自己。
 *
 * @param content - 补丁文件全文。
 * @param otherFileContents - 同一 id 的 insert 行**可能坐在里面**的其它补丁文件全文
 *   （项目级与全局两份互查）。只用于补基准，绝不用来推断本文件要删什么。
 * @returns `ranges` 为要删除的行区间；`ids` 为逐 id 统计。
 */
export function planOverrideCompaction(
  content: string,
  otherFileContents: string[] = [],
): { ranges: Array<[number, number]>; ids: Record<string, OverrideStat> } {
  const lines = content.split(/\r?\n/)
  const byId = new Map<string, OverrideBlock[]>()
  for (const block of scanOverrideBlocks(content)) {
    const list = byId.get(block.id)
    if (list) list.push(block)
    else byId.set(block.id, [block])
  }
  const baseOf = new Map<string, boolean>()
  // 只有**读得出 true/false** 才算基准已知；`disabled` 缺失或值不可解析（`!!js`）一律不记。
  for (const row of insertBaseRows(content)) if (row.disabled !== undefined) baseOf.set(row.id, row.disabled)
  for (const other of otherFileContents) {
    for (const row of insertBaseRows(other)) if (!baseOf.has(row.id) && row.disabled !== undefined) baseOf.set(row.id, row.disabled)
  }
  const ranges: Array<[number, number]> = []
  const ids: Record<string, OverrideStat> = {}
  for (const [id, list] of byId) {
    const baseKnown = baseOf.has(id)
    const base = baseOf.get(id) === true
    let decider = -1
    for (let i = 0; i < list.length; i++) if (list[i].disabled !== undefined) decider = i
    const doomed: OverrideBlock[] = []
    if (decider >= 0) {
      for (let i = 0; i < decider; i++) if (list[i].pure) doomed.push(list[i])
      if (baseKnown && list[decider].pure && list[decider].disabled === base) doomed.push(list[decider])
    }
    ids[id] = { total: list.length, dropped: doomed.length }
    for (const block of doomed) ranges.push([markerLinesAbove(lines, block.start), block.end])
  }
  return { ranges, ids }
}
