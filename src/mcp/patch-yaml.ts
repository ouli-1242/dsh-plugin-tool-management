// cordis.patch.yml 的「受管 loader 行」读写层 —— 2026-09-19 从 index.ts 的 apply 闭包
// 原样抽出（07 审查五档问题 3：巨型单文件）。这里是所有 MCP 写路径的**唯一** YAML 出口：
// 生成（buildInsertBlock / buildDisableBlock）、解析（parseRows，供界面读生效值）、
// 行级块编辑（removeEntryAll / removeMarked / appendBlock / spliceRanges）。
// 纯字符串运算，不碰 ctx / 文件系统 —— 读写盘由调用方负责。
import { MCP_CLIENT_MODULE } from '../host-names.js'
import { maskedKeysIn } from './secret-guard.js'

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
  if (row.toolCallTimeoutMs) lines.push('        toolCallTimeoutMs: ' + Number(row.toolCallTimeoutMs))
  // 结构性兜底：这里是所有 MCP 写路径的**唯一** YAML 出口。打码值到这一步还没被拦下，
  // 说明某个调用点漏过了 ./secret-guard.js —— 那是代码缺陷，宁可整次写入失败，
  // 也不能把 `••••••` 写进补丁文件（真密钥一旦被覆盖就找不回来了：本机 2026-09-18
  // `TAVILY_API_KEY` 就是这样丢的）。所以这里**抛错**而不是静默剔除。
  //
  // 覆盖范围的边界（别读成"所有字段都查了"）：断言只查 env / headers 的整串 `•` 形态。
  // URL 的打码是另一套（查询串换成 `<redacted>`），由调用方经 `resolveMaskedUrl` 收敛，
  // 不在这里 —— 它需要"没有原值就拒绝"这种带上下文的裁决，不是一句断言能表达的。
  const leaked = [...maskedKeysIn(row.env), ...maskedKeysIn(row.headers)]
  if (leaked.length) {
    throw new Error('拒绝写入：' + leaked.join('、') + ' 的值仍是打码占位符（调用方应先经 resolveMaskedKv 收敛）')
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
      else if (kv.key === 'disabled') entry.disabled = kv.value === 'true'
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
  const blocks: Array<{ text: string }> = []
  let current: { text: string } | null = null
  for (const line of lines) {
    if (/^- /.test(line)) {
      current = { text: line }
      blocks.push(current)
    } else if (current) {
      current.text += '\n' + line
    }
  }
  for (const block of blocks) {
    const head = block.text.split('\n')[0]
    if (/^- insert:/.test(head)) {
      const parts = block.text.split('\n')
      const children: Array<{ lines: string[] }> = []
      let j = 0
      while (j < parts.length) {
        if (/^    - /.test(parts[j])) {
          const child = { lines: [parts[j]] }
          j++
          while (j < parts.length && !/^    - /.test(parts[j])) { child.lines.push(parts[j]); j++ }
          children.push(child)
        } else j++
      }
      for (const child of children) {
        const entry = parseEntry(child.lines)
        if (entry && entry.name === MCP_CLIENT_MODULE) {
          rows.push({ id: entry.id!, name: entry.name, disabled: entry.disabled, config: entry.config, managed: managedIds.has(entry.id!) })
        }
      }
    } else {
      // 覆盖块按**文件顺序**生效，不是"收集后统一回填"：官方
      // `@deepseek-ai/dsh-app-boot` 的 applyEntryPatches 只给此刻已入索引的 id 打补丁
      //（insert 是插入时立即入索引），命中不到就 warn + skip。所以写在 insert 之前的
      // 覆盖块在宿主侧是 no-op —— 这里同样丢弃，界面才和生效值一致。
      const entry = parseEntry(block.text.split('\n'))
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
function joinLines(lines: string[]): string {
  let res = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n*$/, '\n')
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
