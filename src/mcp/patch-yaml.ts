// cordis.patch.yml 的「受管 loader 行」读写层 —— 2026-09-19 从 index.ts 的 apply 闭包
// 原样抽出（07 审查五档问题 3：巨型单文件）。这里是所有 MCP 写路径的**唯一** YAML 出口：
// 生成（buildInsertBlock / buildDisableBlock）、解析（parseRows，供界面读生效值）、
// 行级块编辑（removeEntryAll / removeMarked / appendBlock / spliceRanges）。
// 纯字符串运算，不碰 ctx / 文件系统 —— 读写盘由调用方负责。
import { MCP_CLIENT_MODULE } from '../host-names.js'
import { isMaskedUrl, maskedKeysIn } from './secret-guard.js'
import { readToggleEntry } from './override-blocks.js'

export interface ManagedRow {
  id: string
  name?: string
  serverName?: string
  level?: 'project' | 'global'
  disabled?: boolean
  managed?: boolean
  config: Record<string, unknown>
}

// ---------- YAML generation ----------
function yq(v: unknown): string { return typeof v === 'string' ? JSON.stringify(v) : String(v) }
function yplain(v: string): string { return /^[A-Za-z0-9_.:@%+=/-]+$/.test(v) ? v : yq(v) }

export function buildInsertBlock(row: { id: string; serverName: string; transport: string; url?: string; command?: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string>; toolCallTimeoutMs?: number }): string {
  const lines = [
    '# dsh-plugin-tool-management:server:' + row.id,
    '- insert:',
    '    - id: ' + yplain(row.id),
    "      name: '" + MCP_CLIENT_MODULE + "'",
    '      config:',
    '        serverName: ' + yq(row.serverName),
    '        transport: ' + yq(row.transport),
  ]
  if (row.transport === 'streamable-http') {
    lines.push('        url: ' + yq(row.url || ''))
    const headers = row.headers || {}
    const hk = Object.keys(headers)
    if (hk.length) {
      lines.push('        headers:')
      for (const k of hk) lines.push('          ' + yq(k) + ': ' + yq(headers[k]))
    }
  } else {
    lines.push('        command: ' + yq(row.command || ''))
    const args = row.args || []
    if (args.length) {
      lines.push('        args:')
      for (const a of args) lines.push('          - ' + yq(a))
    }
    const env = row.env || {}
    const ek = Object.keys(env)
    if (ek.length) {
      lines.push('        env:')
      for (const k of ek) lines.push('          ' + yq(k) + ': ' + yq(env[k]))
    }
  }
  // 超时值只在**能解析成有限数、且非 0** 时才写这一行（2026-09-30 审查 P2-13）。
  // 此前是 `if (row.toolCallTimeoutMs)`：手写补丁里这个键被读成字符串（`unquote` 只认纯数字），
  // 于是 `"30s"` / `"abc"` 这类值会走 `Number()` → `NaN` 落盘，补丁里出现一个**不是数字**的
  // `toolCallTimeoutMs` —— 宿主读到的要么是字符串、要么是 YAML 里的字符串 "NaN"，两种都不是
  // 超时毫秒数，而界面显示的是"已配置"。认不出来就不写这一行（键缺失 = 用宿主默认值）。
  // `0` 同样不写：界面上"没填"读出来就是 0，写成 `toolCallTimeoutMs: 0` 会让每次工具调用立刻超时。
  if (row.toolCallTimeoutMs && Number.isFinite(Number(row.toolCallTimeoutMs))) {
    lines.push('        toolCallTimeoutMs: ' + Number(row.toolCallTimeoutMs))
  }
  // 结构性兜底：这里是所有 MCP 写路径的**唯一** YAML 出口。打码值到这一步还没被拦下，
  // 说明某个调用点漏过了 ./secret-guard.js —— 那是代码缺陷，宁可整次写入失败，
  // 也不能把 `••••••` 写进补丁文件（真密钥一旦被覆盖就找不回来了：本机 2026-09-18
  // `TAVILY_API_KEY` 就是这样丢的）。所以这里**抛错**而不是静默剔除。
  //
  // 两种形态都查（2026-09-30 审查 F4 补上第二种）：env / headers 的整串 `•`，
  // 以及 URL 的 userinfo / 查询串 / 片段哨兵（`isMaskedUrl`）。此前只有前者，
  // 注释自己写着"URL 的打码是另一套……不在这里"—— 于是 `mcpmAdd` 与 `mcpmImport`
  // 两条写路径都没有 `resolveMaskedUrl`，打码 URL 会原样落盘，**且不产生任何 warning**。
  // 各调用点仍应自己做「有旧值就顶替、没有就拒绝/跳过」的裁决（那需要上下文），
  // 这里的断言只是"漏了就吵"的最后一道。
  const leaked = [...maskedKeysIn(row.env), ...maskedKeysIn(row.headers)]
  if (leaked.length) {
    throw new Error('拒绝写入：' + leaked.join('、') + ' 的值仍是打码占位符（调用方应先经 resolveMaskedKv 收敛）')
  }
  if (row.transport === 'streamable-http' && isMaskedUrl(row.url)) {
    throw new Error('拒绝写入：url 仍是打码形态（' + String(row.url) + '）—— 调用方应先经 resolveMaskedUrl 收敛（有旧值顶替、没有则拒绝或跳过）')
  }
  return lines.join('\n')
}

export function buildDisableBlock(id: string, disabled: boolean): string {
  return [
    '# dsh-plugin-tool-management:' + (disabled ? 'disable' : 'enable') + ':' + id,
    '- id: ' + yplain(id),
    "  name: '" + MCP_CLIENT_MODULE + "'",
    '  disabled: ' + (disabled ? 'true' : 'false'),
  ].join('\n')
}

// ---------- YAML parsing (mini parser) ----------
// Known limitation: this hand-rolled parser assumes the exact indentation
// style that buildInsertBlock emits (config at 6 spaces, children at 8,
// nested maps/lists at 10+). Hand-edited patch files using different
// indentation may parse incorrectly — DSH itself only cares about the
// effective YAML it reads, and this parser exists purely for the UI.
function splitKV(text: string): { key: string; value: string } | null {
  const m = text.match(/^("(?:\\.|[^"])*"|'[^']*'|[^:]+?)\s*:\s*(.*)$/)
  if (!m) return null
  return { key: unquote(m[1]), value: m[2] }
}
function unquote(v: string): any {
  if (v === undefined || v === null) return v
  const s = String(v).trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s) } catch (e) { return s.slice(1, -1) }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter((x) => x !== '')
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  return s
}

function parseEntry(lines: string[]): { id?: string; name?: string; disabled?: boolean; config: Record<string, any> } {
  const entry: { id?: string; name?: string; disabled?: boolean; config: Record<string, any> } = { config: {} }
  let inConfig = false
  let configIndent = 0
  let nested: { key: string; indent: number; type: 'map' | 'list'; current: any } | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = line.match(/^\s*/)![0].length
    let t = trimmed
    if (t.startsWith('- ')) t = t.slice(2).trim()
    const kv = splitKV(t)
    if (!kv) {
      if (inConfig && nested && nested.type === 'list') nested.current.push(unquote(t))
      continue
    }
    if (!inConfig) {
      if (kv.key === 'config' && kv.value === '') { inConfig = true; configIndent = indent; continue }
      if (kv.key === 'id') entry.id = unquote(kv.value)
      else if (kv.key === 'name') entry.name = unquote(kv.value)
      else if (kv.key === 'disabled') {
        // 只认**字面量** true / false（2026-09-30 审查 P2-6）：`!!js` 这类读不出来的写法
        // 此前被算成**显式 false**，于是"读不出来"与"明确启用"混成同一个值 —— 覆盖块会拿它
        // 去改写当前生效值（`parseRows` 的 `entry.disabled !== undefined` 那道闸因此失效）。
        // 读不出来就保持 `undefined` = 不表态，让生效值维持原样。
        if (kv.value === 'true') entry.disabled = true
        else if (kv.value === 'false') entry.disabled = false
      }
      continue
    }
    if (indent <= configIndent) { inConfig = false; nested = null; continue }
    if (kv.value === '' && (kv.key === 'headers' || kv.key === 'env')) {
      nested = { key: kv.key, indent, type: 'map', current: {} }
      entry.config[kv.key] = nested.current
      continue
    }
    if (kv.value === '' && kv.key === 'args') {
      nested = { key: kv.key, indent, type: 'list', current: [] }
      entry.config[kv.key] = nested.current
      continue
    }
    if (nested && indent > nested.indent) {
      if (nested.type === 'map') nested.current[kv.key] = unquote(kv.value)
      else if (nested.type === 'list') nested.current.push(unquote(kv.value))
      continue
    }
    nested = null
    entry.config[kv.key] = unquote(kv.value)
  }
  return entry
}

/** 按顶层 `- ` 切块：每个块从一行 `- ` 开始，到下一个 `- ` 之前。首块之前的内容丢弃。 */
function splitTopBlocks(lines: string[]): string[] {
  const blocks: string[] = []
  let current: string | null = null
  for (const line of lines) {
    if (/^- /.test(line)) {
      if (current !== null) blocks.push(current)
      current = line
    } else if (current !== null) {
      current += '\n' + line
    }
  }
  if (current !== null) blocks.push(current)
  return blocks
}

/** 一个 `- insert:` 块里的子条目（按 `    - ` 4 空格缩进切）。 */
function splitInsertChildren(blockText: string): string[][] {
  const parts = blockText.split('\n')
  const children: string[][] = []
  let j = 0
  while (j < parts.length) {
    if (/^    - /.test(parts[j])) {
      const lines = [parts[j]]
      j++
      while (j < parts.length && !/^    - /.test(parts[j])) { lines.push(parts[j]); j++ }
      children.push(lines)
    } else j++
  }
  return children
}

/**
 * 文件里**所有** insert 子条目的 id（**不限 loader 名**）。
 *
 * 为什么不能复用 `parseRows`：它只收 `name === MCP_CLIENT_MODULE` 的行（本插件只管 MCP），
 * 而「两条同 id 的 insert 会让插件组装失败、**DSH 起不来**」这个约束对**任何** loader 都成立。
 * 只统计 MCP 行的话，导入一条非 MCP loader 就能撞出第二条同 id 条目而守卫看不见
 * （2026-09-30 审查 P1-5）。
 *
 * 只收 **insert 子条目**，不收顶层覆盖块：覆盖块的 id 本来就应该与某个 insert 相同，
 * 那是正常用法而非重复。
 */
export function insertEntryIds(content: string): string[] {
  const out: string[] = []
  for (const blockText of splitTopBlocks(content.split(/\r?\n/))) {
    if (!/^- insert:/.test(blockText.split('\n')[0])) continue
    for (const childLines of splitInsertChildren(blockText)) {
      const entry = parseEntry(childLines)
      if (entry.id) out.push(entry.id)
    }
  }
  return out
}

export function parseRows(content: string): { rows: ManagedRow[] } {
  const lines = content.split(/\r?\n/)
  const managedIds = new Set<string>()
  for (const line of lines) {
    // Markers written by either this plugin or the template upstream count
    // as managed (coexistence: both can edit the same patch file).
    const m = line.match(/^# (?:dsh-plugin-tool-management|dsh-mcp-manager):server:(.+)$/)
    if (m) managedIds.add(m[1].trim())
  }
  const rows: ManagedRow[] = []
  for (const blockText of splitTopBlocks(lines)) {
    const head = blockText.split('\n')[0]
    if (/^- insert:/.test(head)) {
      for (const childLines of splitInsertChildren(blockText)) {
        const entry = parseEntry(childLines)
        if (entry && entry.name === MCP_CLIENT_MODULE) {
          rows.push({ id: entry.id!, name: entry.name, disabled: entry.disabled, config: entry.config, managed: managedIds.has(entry.id!) })
        }
      }
    } else {
      // 覆盖块按**文件顺序**生效，不是"收集后统一回填"：官方
      // `@deepseek-ai/dsh-app-boot` 的 applyEntryPatches 只给此刻已入索引的 id 打补丁
      //（insert 是插入时立即入索引），命中不到就 warn + skip。所以写在 insert 之前的
      // 覆盖块在宿主侧是 no-op —— 这里同样丢弃，界面才和生效值一致。
      const entry = parseEntry(blockText.split('\n'))
      if (entry && entry.name === MCP_CLIENT_MODULE && entry.disabled !== undefined) {
        const row = rows.find((r) => r.id === entry.id)
        if (row) row.disabled = entry.disabled
      }
    }
  }
  return { rows }
}

// ---------- line-based block editing ----------
export function splitLines(content: string): string[] { return content.split(/\r?\n/) }

/** 映射键（裸 / 双引号 / 单引号三种写法）。 */
const YAML_KEY_PART = String.raw`(?:[^#\s][^:]*|"[^"]*"|'[^']*')`
/** 节点属性：锚点 `&a` 与标签 `!tag` / `!!js` / `!<verbatim>`，可多个、可任意顺序。 */
const YAML_NODE_PROPS = String.raw`(?:[&!]\S+\s+)*`
/**
 * 块标量头部的指示符，**两种顺序都合法**（YAML 规范 `c-b-block-header`）：
 *   `( 缩进指示符 截断指示符 ) | ( 截断指示符 缩进指示符 )`
 * 缩进指示符是 `[1-9]`，截断指示符是 `[+-]`。所以 `|2-` 与 `|-2` 都算。
 */
const YAML_BLOCK_INDICATOR = String.raw`[|>](?:\d[+-]?|[+-]\d?)?`
/**
 * 一条**块标量头部**行：映射值（`key: <属性> <指示符>`）或序列项（`- <属性> <指示符>`）。
 *
 * 为什么必须认全（2026-09-30 审查 F6）：判据此前是 `key:\s*[|>][+-]?\d*`，它只认裸 `script: |`
 * 这一种。于是 `script: !!js |`（CHANGELOG 与注释**点名**要覆盖的那个形态）、`script: &a |`、
 * `script: |2-` 全都落进"不在块标量里"，`joinLines` 照旧把它们内部的 3+ 连续空行折成 1 行 ——
 * 补丁照旧能读、表达式照旧能 eval，**只是算出来的值变了**。方向恰好是改写用户手写的内容。
 */
const BLOCK_SCALAR_HEADER_RE = new RegExp(
  `^(\\s*)(?:${YAML_KEY_PART}\\s*:|-(?=\\s|$))\\s*${YAML_NODE_PROPS}${YAML_BLOCK_INDICATOR}\\s*(?:#.*)?$`,
)
/**
 * 「像块标量头部、但上面那条严格判据认不出来」的行。
 *
 * 认不出的形状一律**整体不折叠**（函数头注释里的第二道闸）：折叠的代价是"少一次排版归一化"
 * （文件里可能积空行，肉眼可见、可再折叠），而误判的代价是**静默改写用户手写的表达式** ——
 * 两者不对称，所以认不出时选保守的那一边。
 *
 * 为什么不会误伤本插件自己生成的行：`buildInsertBlock` 的标量值一律走 `JSON.stringify`
 * （行尾必是 `"`），数字与布尔没有 `|` / `>`。所以只有**人手写**的形状才可能命中这条。
 */
const SUSPICIOUS_BLOCK_HEADER_RE = new RegExp(
  `^\\s*(?:${YAML_KEY_PART}\\s*:|-(?=\\s|$)).*[|>]\\s*(?:#.*)?$`,
)

/**
 * 标出「哪些行在**块标量**（`key: |` / `key: >`）里」。
 *
 * 为什么折叠空行前必须知道这件事（2026-09-30 审查 P2-7）：`joinLines` 每次行级编辑
 * （任何一次 MCP 增 / 改 / 删 / 启停）都会把整份文件里 3+ 连续换行折成 1 个空行 —— 那是为了
 * 不让反复增删在文件里积出越来越长的空行。但块标量的**内容就是换行与缩进**，它内部的空行
 * 属于内容本身：折掉一次等于改写了用户手写的表达式（`!!js |`），而补丁照旧能读、表达式
 * 照旧能 eval —— 只是算出来的值变了，**静默**改掉一个用户写的东西。
 *
 * 两道闸：
 *   ① 严格判据（`BLOCK_SCALAR_HEADER_RE`）按 YAML 规范认头：属性（tag / anchor）+ 指示符，
 *      两种指示符顺序都算；块体是之后所有**空行**或**缩进深于头行**的行，遇到第一个非空且
 *      缩进不深于头行的行即结束。
 *   ② 文件里只要出现**一条**认不出的疑似块标量头（`SUSPICIOUS_BLOCK_HEADER_RE`），
 *      整份文件都不折叠 —— 宁可少一次排版归一化，也不猜着改写内容。
 */
function blockScalarLineMask(lines: string[]): boolean[] {
  const inScalar = new Array<boolean>(lines.length).fill(false)
  let i = 0
  while (i < lines.length) {
    const m = BLOCK_SCALAR_HEADER_RE.exec(lines[i])
    if (!m) { i++; continue }
    const keyIndent = m[1].length
    let j = i + 1
    while (j < lines.length) {
      const line = lines[j]
      if (line.trim() === '') { inScalar[j] = true; j++; continue }
      const indent = line.match(/^\s*/)![0].length
      if (indent <= keyIndent) break
      inScalar[j] = true
      j++
    }
    i = Math.max(j, i + 1)
  }
  // 第二道闸：认不出的疑似块标量头 → 整体不折叠（全部标成"受保护"）。
  for (const line of lines) {
    if (SUSPICIOUS_BLOCK_HEADER_RE.test(line) && !BLOCK_SCALAR_HEADER_RE.test(line)) {
      return new Array<boolean>(lines.length).fill(true)
    }
  }
  return inScalar
}

function joinLines(lines: string[]): string {
  // 折叠**跳过块标量内部的行**：那些空行是内容，不是排版（见 blockScalarLineMask 的注释）。
  const protectedLine = blockScalarLineMask(lines)
  const folded: string[] = []
  let blanks = 0
  for (let i = 0; i < lines.length; i++) {
    if (protectedLine[i]) { blanks = 0; folded.push(lines[i]); continue }
    if (lines[i].trim() === '') {
      blanks++
      // 最多留 1 个空行 —— 与改动前 `/\n{3,}/ → /\n\n/` 的力度一致。
      if (blanks <= 1) folded.push(lines[i])
      continue
    }
    blanks = 0
    folded.push(lines[i])
  }
  // 尾部若正处在块标量里，就不做「补一个换行」的归一化（那也会动到内容）；只去首部空行。
  const tailProtected = lines.length > 0 && protectedLine[lines.length - 1]
  let res = folded.join('\n').replace(/^\n+/, '')
  res = tailProtected ? res : res.replace(/\n*$/, '\n')
  if (!res.trim()) {
    res = '[]\n'
  } else if (!/^- /m.test(res) && !/^\[\]\s*$/m.test(res)) {
    // A patch file must stay a top-level YAML array: after removing the last
    // entry, emit [] so loadOptionalPatches never throws on a comments-only file.
    res = res.replace(/\n*$/, '\n[]\n')
  }
  return res
}
function escRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function markerRanges(lines: string[], id: string, ops: string): Array<[number, number]> {
  const n = lines.length
  // Match this plugin's markers AND the template upstream's
  // (`# dsh-mcp-manager:server|disable|enable:<id>`) so an entry written by
  // either manager can be located and cleaned up without orphan blocks —
  // the two plugins are designed to coexist.
  const re = new RegExp('^# (?:dsh-plugin-tool-management|dsh-mcp-manager):(' + ops + '):' + escRe(id) + '$')
  const ranges: Array<[number, number]> = []
  for (let i = 0; i < n; i++) {
    if (!re.test(lines[i])) continue
    let j = i + 1
    while (j < n && !/^- /.test(lines[j])) j++
    let end = j
    if (j < n && /^- /.test(lines[j])) {
      let k = j + 1
      while (k < n && !/^- /.test(lines[k])) k++
      end = k
    }
    ranges.push([i, end])
  }
  return ranges
}

/**
 * 命中 id 的 `- insert:` 区间。
 *
 * 一个 `- insert:` 下**可以挂多个子条目**（`parseRows` 就是这么读的：它按 `    - `
 * 切子条目逐个解析）。此前只要块内有任一子条目命中就返回**整块**，于是
 * `mcpm-edit` / `mcpm-remove` 会顺手删掉同块兄弟服务器 —— 插件自己写的是"一块一条"，
 * 出事的都是手工编辑出来的多子条目块，而那正是最需要保住的形状（用户的手写意图）。
 *
 * 所以按子条目粒度切：只删命中的那一条，兄弟留下；整块只剩这一条时连 `- insert:`
 * 一起删，不留一个空壳块（`- insert:` 下没有子条目在 YAML 里是 null，宿主会跳过）。
 */
function insertBlockRange(lines: string[], id: string): [number, number] | null {
  const n = lines.length
  const entryRe = new RegExp('^\\s*- id: ' + escRe(id) + '\\s*$')
  for (let i = 0; i < n; i++) {
    if (!/^- insert:/.test(lines[i])) continue
    let end = i + 1
    while (end < n && !/^- /.test(lines[end])) end++
    const starts: number[] = []
    for (let k = i + 1; k < end; k++) if (/^ {4}- /.test(lines[k])) starts.push(k)
    // 切不出子条目（缩进不是生成器那套的手写块）：退回"整块"，与改动前一致 ——
    // 认不出形状时宁可照旧删整块，也好过认不出就跳过、让 edit 追加出一条重复条目。
    if (!starts.length) {
      if (lines.slice(i, end).some((l) => entryRe.test(l))) return [i, end]
      continue
    }
    for (let s = 0; s < starts.length; s++) {
      const from = starts[s]
      const to = s + 1 < starts.length ? starts[s + 1] : end
      if (!lines.slice(from, to).some((l) => entryRe.test(l))) continue
      return starts.length === 1 ? [i, end] : [from, to]
    }
  }
  return null
}

function bareOverrideRanges(lines: string[], id: string): Array<[number, number]> {
  const n = lines.length
  const re = new RegExp('^- id: ' + escRe(id) + '\\s*$')
  const ranges: Array<[number, number]> = []
  for (let i = 0; i < n; i++) {
    if (!re.test(lines[i])) continue
    let end = i + 1
    while (end < n && !/^- /.test(lines[end])) end++
    // 只删**纯块**（2026-09-30 审查 P2-6）：`mcpm-edit` / `mcpm-remove` 原来把同 id 的顶层
    // 覆盖块**一律**删掉，而用户完全可能在里面手写 `config`（补丁是按 **loader id** 生效的，
    // 别的模块名写同一个 id 时改的仍是那个条目，手写 config 因此是合法且有用的）。删掉它
    // 就是静默丢掉用户手写的配置。判据与 `override-blocks.ts` 的 `readToggleEntry().pure`
    // **同源**（认不出的写法一律判非纯 → 保留，保守方向是对的）。
    if (!readToggleEntry(lines.slice(i, end)).pure) continue
    ranges.push([i, end])
  }
  return ranges
}

export function spliceRanges(lines: string[], ranges: Array<[number, number]>): string {
  const remove = new Set<number>()
  for (const r of ranges) for (let i = r[0]; i < r[1]; i++) remove.add(i)
  return joinLines(lines.filter((_, i) => !remove.has(i)))
}

export function removeEntryAll(content: string, id: string): string {
  const lines = splitLines(content)
  const ranges = markerRanges(lines, id, 'server|disable|enable')
  const ib = insertBlockRange(lines, id)
  if (ib) ranges.push(ib)
  ranges.push(...bareOverrideRanges(lines, id))
  return spliceRanges(lines, ranges)
}

export function removeMarked(content: string, id: string, op: string): string {
  return spliceRanges(splitLines(content), markerRanges(splitLines(content), id, op))
}

export function appendBlock(content: string, block: string): string {
  let c = content
  if (/^\[\]\s*$/m.test(c)) c = c.replace(/^\[\]\s*$/m, block + '\n')
  else c = c.replace(/\s*$/, '\n' + block + '\n')
  return c
}
