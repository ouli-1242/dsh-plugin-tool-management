// MCP 停用表的读取结果与结构校验（纯函数，无 I/O）。
//
// 这张表是「关掉危险工具」的唯一依据，读失败不能退化成空表。四态里只有 missing（ENOENT）
// 可以当空表；corrupt / unreadable 都由调用方按 unknown 处理。
//
// 结构错误与「名字不认识」必须分开：前者是文件被改坏，后者可能只是宿主用了本插件正则不
// 认识的工具名。把后者升级成全表损坏，会让一个合法名字把全部 MCP 工具一起禁掉。

/** 严格 JSON 读取的结果（由 index.ts 的 readJsonFileStrict 产出）。 */
export type JsonFileRead =
  | { status: 'ok'; value: unknown }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string }
  | { status: 'unreadable'; error: string }

/** 停用表读不出来的两类问题：内容坏了，或文件读不了。 */
export type DisabledToolsIssue = 'corrupt' | 'unreadable'

/** 读停用表的四种结果 —— 「没有文件」与「读坏了」必须分开。 */
export type DisabledToolsRead =
  | { status: 'ok'; value: Record<string, string[]>; warnings: string[] }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string }
  | { status: 'unreadable'; error: string }

/** 这些键在普通对象上是原型槽，不是普通属性；出现在侧车里一律按结构错误处理。 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** 与写入口 / 界面同一套工具名格式；不匹配的名字保留并上报，不升级为整表损坏。 */
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/

/** 这个键是不是原型链污染那一类（`__proto__` / `constructor` 等），读写侧车时要拒掉。 */
export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key)
}

/** 空的无原型表：写入、克隆与快照都用它，避免 `__proto__` 赋值改原型。 */
export function emptyDisabledTools(): Record<string, string[]> {
  return Object.create(null) as Record<string, string[]>
}

/**
 * 安全克隆：只保留字符串数组，丢弃保留键。用于所有写前“读-改-写”的合并点。
 * 注意不能用 `Object.assign({}, map)` —— 目标若是普通对象，`__proto__` 会触发 setter。
 */
export function cloneDisabledTools(map: Record<string, string[]> | null | undefined): Record<string, string[]> {
  const out = emptyDisabledTools()
  if (!map || typeof map !== 'object') return out
  for (const [serverName, list] of Object.entries(map)) {
    if (isUnsafeKey(serverName) || !Array.isArray(list)) continue
    out[serverName] = list.filter((name): name is string => typeof name === 'string').slice()
  }
  return out
}

function serverKeyProblem(key: string): string | null {
  if (key === '') return '存在空的服务器名'
  if (key.length > 128) return `服务器名过长：${key.slice(0, 16)}…`
  if (/[\u0000-\u001f\u007f]/.test(key)) return `服务器名含控制字符：${JSON.stringify(key)}`
  return null
}

/**
 * 合法 JSON 的结构校验。返回 `ok` 时 value 一定是无原型对象。
 *
 * 结构错误（顶层不是对象、值不是数组、元素不是字符串、空名字、proto 键）→ corrupt；
 * 字符串但不符合本插件工具名格式（例如 `read.file`）→ 原样保留 + warnings。
 */
export function classifyDisabledTools(raw: unknown): DisabledToolsRead {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'corrupt', error: '顶层不是对象' }
  }
  const out = emptyDisabledTools()
  const warnings: string[] = []
  const warned = new Set<string>()
  for (const [serverName, rawList] of Object.entries(raw as Record<string, unknown>)) {
    if (isUnsafeKey(serverName)) {
      return { status: 'corrupt', error: `服务器名是保留键：${serverName}` }
    }
    const keyProblem = serverKeyProblem(serverName)
    if (keyProblem) return { status: 'corrupt', error: keyProblem }
    if (!Array.isArray(rawList)) {
      return { status: 'corrupt', error: `服务器「${serverName}」的值不是数组` }
    }
    const names: string[] = []
    for (const item of rawList) {
      if (typeof item !== 'string') {
        return { status: 'corrupt', error: `服务器「${serverName}」的条目不是字符串` }
      }
      if (item === '') {
        return { status: 'corrupt', error: `服务器「${serverName}」存在空工具名` }
      }
      if (item !== '*' && !TOOL_NAME_RE.test(item) && !warned.has(serverName + '/' + item)) {
        warned.add(serverName + '/' + item)
        warnings.push(serverName + '/' + item)
      }
      if (names.indexOf(item) < 0) names.push(item)
    }
    if (names.length) out[serverName] = names
  }
  return { status: 'ok', value: out, warnings }
}

/** 停用表不可用时的具名错误：调用方可以据此返回结构化错误，而不是把空表当成事实。 */
export class DisabledToolsUnavailableError extends Error {
  readonly status: DisabledToolsIssue
  readonly detail: string

  constructor(status: DisabledToolsIssue, detail: string) {
    super(`MCP 停用表${status === 'corrupt' ? '损坏' : '不可读'}：${detail}`)
    this.name = 'DisabledToolsUnavailableError'
    this.status = status
    this.detail = detail
  }
}
