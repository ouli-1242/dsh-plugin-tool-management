// 补丁文件（cordis.patch.yml）里的「启停覆盖块」识别与收敛计划。
//
// 背景：同一个 loader id 的启停状态可以有多种写法 —— insert 行自带的 `disabled:`，
// 以及顶层 `- id: xxx` + `disabled:` 的独立覆盖块。补丁按顺序应用、**last-wins**，
// 所以覆盖块可以无限追加而每次都不报错。代价是文件越用越长：本机实测从 18 条涨到
// 25 条（context7 一条 id 就有 7 个块），生效值只能靠"最后一条说了算"推断。
//
// 这里只回答两个问题，都不碰文件：
//   ① 每个 id 有几个覆盖块、其中几个是"多余的"（`analyzeOverrideBlocks`）；
//   ② 要收敛的话删哪些行区间（`planOverrideCompaction`），且**生效值保证不变**。
//
// 为什么单独成模块：这段逻辑会改写 `~/.dsh/cordis.patch.yml` —— 写坏了 DSH 起不来。
// 放在 apply 闭包里就没法在测试里对着真文件（和真形状的样本）跑，所以拆出来，
// 由 `test/mcp-override-compaction.test.mjs` 直接驱动。

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

/** insert 行给出的基准状态（收敛计划只需要知道"这条 id 本来是什么状态"）。 */
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
 * 只看**顶层/一层缩进**的锚定写法（`- id:`、`name:`、`disabled:`）：生成器写出来的
 * 就是这几行，而 config 里的同名键缩进更深 —— 万一手工把 `disabled` 藏进 config，
 * 这里会判成"非纯块"（保留不删），保守方向是对的。
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
    if (/^\s{2,}name:\s*\S+\s*$/.test(line)) continue
    const flag = line.match(/^\s{2,}disabled:\s*(true|false)\s*$/)
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

export interface OverrideStat {
  /** 该 id 的覆盖块总数。 */
  total: number
  /** 其中删掉也不改变生效值的块数。 */
  dropped: number
}

/**
 * 每个 id 的覆盖块统计（供界面显示"启停覆盖 ×N / 其中 M 个多余"）。
 *
 * @param content - 补丁文件全文。
 * @param rows - insert 行给出的基准状态。**要给两份补丁文件里全部 insert 行的并集**：
 *   同一个 id 的 insert 行可能在另一份文件里，只喂本文件的会让基准判断失真。
 */
export function analyzeOverrideBlocks(content: string, rows: OverrideBaseRow[]): Record<string, OverrideStat> {
  return planOverrideCompaction(content, rows).ids
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
 * @param rows - 两份补丁文件里全部 insert 行的并集（见 analyzeOverrideBlocks）。
 * @returns `ranges` 为要删除的行区间；`ids` 为逐 id 统计。
 */
export function planOverrideCompaction(
  content: string,
  rows: OverrideBaseRow[],
): { ranges: Array<[number, number]>; ids: Record<string, OverrideStat> } {
  const lines = content.split(/\r?\n/)
  const byId = new Map<string, OverrideBlock[]>()
  for (const block of scanOverrideBlocks(content)) {
    const list = byId.get(block.id)
    if (list) list.push(block)
    else byId.set(block.id, [block])
  }
  const baseOf = new Map<string, boolean>()
  for (const row of rows) baseOf.set(row.id, row.disabled === true)
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
