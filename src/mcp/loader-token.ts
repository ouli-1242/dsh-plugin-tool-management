// 插件**自己那条 loader 行**的 `config.token` 读写 —— 唯一口径。
//
// 为什么需要它（用户裁定 2026-09-18）：访问令牌此前只能靠手改 `cordis.patch.yml` 来设置，
// 而"想开明文就得会写 YAML"这个门槛把功能卡住了。现在兼容页可以就地设置 / 关闭，本模块
// 负责那一次**外科手术式的文本改写**。
//
// 为什么是行级文本改写而不是 YAML 解析后重序列化：`cordis.patch.yml` 是**人的文件** ——
// 里面混着手写注释、`!!js` 表达式、以及别的插件/别的 MCP 条目的块。解析再序列化会把注释
// 全部抹掉、把 `!!js` 引号风格改掉、把不认识的键重排 —— 一次"设置令牌"不该顺带重写整个
// 文件。（这与 `override-blocks.ts` 选择"只算删除区间"是同一条理由。）
//
// 边界：只动**本插件 id 那条条目**内的 `config:` / `token:` 两行，别的一概不碰。条目有两种
// 形状（见 ROW_ID_RE 的注释）：0.1.5 补丁里嵌套的 insert 子条目、0.1.7 profile 补丁里顶层
// 的覆盖条目 —— 同一套相对缩进逻辑都认。找不到那条行时如实回 `found: false`，由调用方
// 决定怎么报错；唯一的"新建"路径是 0.1.7 的覆盖条目（buildLoaderOverrideEntry，见下）。
//
// 两个**不改写、只拒绝**的形状（2026-09-19 审计 T-28）：
//   - `config:` 写成 flow style（`config: {token: x}`）或缩进不是 6 空格 ⇒ 本模块的
//     `CONFIG_RE` 认不出来，会以为"没有 config"而在 `- id:` 之后**再插一个 `config:`**；
//     同一映射里出现重复键，官方解析器 `js-yaml` 是 **throw**（不是 last-wins、没有降级开关），
//     后果是**下一次 DSH 直接启动失败**。所以识别不了形状就拒绝改写，让调用方告诉用户手改。
//   - 同理，写完之前再自检一遍：本条目范围内 `config:` 若多于一个，也拒绝落盘。

/** 与生成器同一口径的 YAML 标量编码（见 index.ts 的 yq）。 */
const yq = (value: string): string => JSON.stringify(value)

/** 本插件 loader 行的 id（与 cordis.patch.yml 里那条 insert 子条目一致）。 */
export const PLUGIN_LOADER_ID = 'dsh-plugin-tool-management'

/**
 * 行首 `- id:` 的缩进就是条目的几何原点：0.1.5 的补丁把条目嵌在映射里（4 空格，config
 * 在 6、键在 8）；0.1.7 的 profile 覆盖条目在顶层（0 空格，config 在 2、键在 4）。两类形状
 * 用同一套「相对缩进」逻辑定位，readLoaderToken / rewriteConfigKey 都按条目自己的缩进算。
 */
const ROW_ID_RE = /^( *)- id:\s*(\S+)\s*$/
/** `config:` 的任何别的写法（flow style `config: {…}`、非空值、别的缩进）—— 一律不改写。 */
const CONFIG_OTHER_RE = /^\s*config:\s*\S/
const keyRe = (indent: number, key: string): RegExp => new RegExp('^ {' + indent + '}' + key + ':\\s*(.*)$')

const unquote = (raw: string): string => {
  const text = raw.trim()
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    const inner = text.slice(1, -1)
    if (text.startsWith('"')) { try { return JSON.parse(text) as string } catch { return inner } }
    return inner.replaceAll("''", "'")
  }
  return text
}

/**
 * 一个布尔开关的值（`tokenDisabled`）。
 *
 * 容忍**行尾注释**（`tokenDisabled: true # 临时关掉`）：YAML 里它是合法的，宿主读到的
 * 也是 `true`；而逐字比较 `=== 'true'` 会得到 false —— 用户以为关掉了，实际开着，
 * 两边都看不出分歧（审计 T-27）。解析不出来（既不是 true 也不是 false）时返回 `null`，
 * 调用方按"没有这条开关"处理 —— 那是**启用门禁**的方向，与宿主对非 `true` 值的读法一致。
 */
function parseFlag(raw: string): boolean | null {
  const text = String(raw == null ? '' : raw).trim()
  if (text === 'true') return true
  if (text === 'false') return false
  // 只有注释前的那段是明确的 true/false 才认；引号里的 `#` 不参与切分。
  if (!/["']/.test(text)) {
    const head = text.split('#')[0].trim()
    if (head === 'true') return true
    if (head === 'false') return false
  }
  return null
}

export interface LoaderTokenRead {
  /** 文件里有没有本插件那条 loader 行。 */
  found: boolean
  /** `config.token` 的当前值；没写就是 `''`。 */
  token: string
  /**
   * `config.tokenDisabled === true`：令牌**保留**在配置里，但当前不生效（用户主动关掉）。
   *
   * 与"没有令牌"是两件事：关掉之后仍然随时能开回来，不需要重新输一遍
   * （用户裁定 2026-09-19：原令牌要保留）。两者都不要求写操作带令牌。
   */
  disabled: boolean
}

/** 定位插件 loader 行及其 `config:` 块（找不到行时 `start < 0`）。 */
function locate(content: string, pluginId: string): {
  lines: string[]
  start: number
  end: number
  /** `- id:` 的缩进格数（config 在 +2、键在 +4）。 */
  indent: number
  configAt: number
  configEnd: number
  /** 该子条目里存在本模块读不了的 `config:` 写法 ⇒ 只能拒绝改写。 */
  configUnrecognised: boolean
  /** 该子条目里 `config:` 出现了多于一次 ⇒ 已经是会启动失败的重复键。 */
  configDuplicated: boolean
} {
  const lines = content.split(/\r?\n/)
  let start = -1
  let indent = 0
  for (let i = 0; i < lines.length; i++) {
    const m = ROW_ID_RE.exec(lines[i])
    if (m && m[2] === pluginId) { start = i; indent = m[1].length; break }
  }
  if (start < 0) return { lines, start: -1, end: -1, indent: 0, configAt: -1, configEnd: -1, configUnrecognised: false, configDuplicated: false }
  // 该子条目块内的行：缩进 ≥ 条目+2（键），或空行/注释（块间空隙，归前一块）。
  const inRowBlock = (line: string): boolean => line.trim() === '' || /^\s*#/.test(line) || new RegExp('^\\s{' + (indent + 2) + ',}\\S').test(line)
  // config 块内的行：缩进 ≥ 条目+4，或空行/注释。
  const inConfigBlock = (line: string): boolean => line.trim() === '' || /^\s*#/.test(line) || new RegExp('^\\s{' + (indent + 4) + ',}\\S').test(line)
  const configRe = new RegExp('^ {' + (indent + 2) + '}config:\\s*$')
  let end = start + 1
  while (end < lines.length && inRowBlock(lines[end])) end++
  let configAt = -1
  let configCount = 0
  let configUnrecognised = false
  for (let i = start + 1; i < end; i++) {
    if (configRe.test(lines[i])) {
      configCount += 1
      if (configAt < 0) configAt = i
      continue
    }
    if (CONFIG_OTHER_RE.test(lines[i])) { configCount += 1; configUnrecognised = true }
  }
  let configEnd = -1
  if (configAt >= 0) {
    configEnd = configAt + 1
    while (configEnd < end && inConfigBlock(lines[configEnd])) configEnd++
  }
  return { lines, start, end, indent, configAt, configEnd, configUnrecognised, configDuplicated: configCount > 1 }
}

/** 读插件 loader 行里的 `config.token` / `config.tokenDisabled`（没写 / 没这条行都返回空值）。 */
export function readLoaderToken(content: string, pluginId: string = PLUGIN_LOADER_ID): LoaderTokenRead {
  const { lines, start, configAt, configEnd, indent } = locate(content, pluginId)
  if (start < 0) return { found: false, token: '', disabled: false }
  if (configAt < 0) return { found: true, token: '', disabled: false }
  const tokenRe = keyRe(indent + 4, 'token')
  const disabledRe = keyRe(indent + 4, 'tokenDisabled')
  let token = ''
  let disabled = false
  for (let i = configAt + 1; i < configEnd; i++) {
    const t = tokenRe.exec(lines[i])
    if (t) { token = unquote(t[1]); continue }
    const d = disabledRe.exec(lines[i])
    // `null` = 值既不是 true 也不是 false（宿主同样不当成"已关闭"），按未关闭处理。
    if (d) disabled = parseFlag(d[1]) === true
  }
  return { found: true, token, disabled }
}

export type LoaderTokenWrite =
  | { found: false }
  | { found: true; changed: boolean; content: string; refused?: string }

/**
 * 在 `config:` 块里写 / 删一个键 —— **唯一实现**（`token` 与 `tokenDisabled` 共用）。
 *
 * 为什么是行级文本改写而不是 YAML 解析后重序列化：`cordis.patch.yml` 是**人的文件** ——
 * 里面混着手写注释、`!!js` 表达式、以及别的插件/别的 MCP 条目的块。解析再序列化会把注释
 * 全部抹掉、把 `!!js` 引号风格改掉、把不认识的键重排 —— 一次"设置令牌"不该顺带重写整个
 * 文件。（这与 `override-blocks.ts` 选择"只算删除区间"是同一条理由。）
 *
 * 删除时若 `config:` 下面再没有别的键，连 `config:` 一起删 —— 否则留下一个空的 `config:`
 * （YAML 里是 `null`，宿主读到的 config 就是 null，行为与"没有 config"并不完全相同）。
 *
 * @param line - 要写入的整行（含缩进）；`null` = 删除该键。
 */
function rewriteConfigKey(content: string, key: string, value: string | null, pluginId: string): LoaderTokenWrite {
  const { lines, start, end, indent, configAt, configEnd, configUnrecognised, configDuplicated } = locate(content, pluginId)
  if (start < 0) return { found: false }
  // 写之前先自检：这两种形状一旦落盘就是"DSH 下次起不来"（官方 js-yaml 对重复映射键 throw），
  // 而"设置令牌"是界面上一次点击触发的 —— 宁可拒绝并说明，也不产出一个坏文件。
  if (configDuplicated) {
    return {
      found: true,
      changed: false,
      content,
      refused: '本插件那条 loader 行里出现了多个 `config:` 键（重复映射键会让 DSH 启动失败）：请先手工整理 cordis.patch.yml，只保留一个 config 块。',
    }
  }
  if (configUnrecognised) {
    return {
      found: true,
      changed: false,
      content,
      refused: '本插件那条 loader 行里的 `config:` 不是插件认识的写法（flow style 或缩进不是 6 空格），自动改写会插入重复键并导致 DSH 启动失败：请手工把它改回 `      config:` + 缩进 8 空格的键值行，或在配置里手工写 token。',
    }
  }
  const re = keyRe(indent + 4, key)
  const keyAt = (() => {
    if (configAt < 0) return -1
    for (let i = configAt + 1; i < configEnd; i++) if (re.test(lines[i])) return i
    return -1
  })()
  // 要写的整行（含缩进）；`value === null` = 删除该键。缩进按条目自己的原点算。
  const line = value === null ? null : ' '.repeat(indent + 4) + key + ': ' + value

  // 写之后的第二道自检：不管走哪条分支，产物里 `config:` 只能有一个。宁可原样退回，
  // 也不让一次界面点击产出一个"DSH 下次起不来"的补丁文件。
  const commit = (nextContent: string): LoaderTokenWrite => {
    if (locate(nextContent, pluginId).configDuplicated) {
      return {
        found: true,
        changed: false,
        content,
        refused: '改写会在本插件那条 loader 行里产生重复的 `config:` 键（会让 DSH 启动失败），已放弃本次修改：请手工整理 cordis.patch.yml。',
      }
    }
    return { found: true, changed: true, content: nextContent }
  }

  const next = lines.slice()
  if (line === null) {
    if (keyAt < 0) return { found: true, changed: false, content }
    // 这个键之外还有别的键吗？（在原行上判断，避免 splice 之后的下标漂移算错）
    const otherKeys = lines
      .slice(configAt + 1, configEnd)
      .some((row, index) => configAt + 1 + index !== keyAt && new RegExp('^\\s{' + (indent + 4) + ',}\\S').test(row))
    next.splice(keyAt, 1)
    if (!otherKeys) next.splice(configAt, 1)
    return commit(next.join('\n'))
  }
  if (keyAt >= 0) {
    if (lines[keyAt] === line) return { found: true, changed: false, content }
    next[keyAt] = line
    return commit(next.join('\n'))
  }
  if (configAt >= 0) {
    next.splice(configAt + 1, 0, line)
    return commit(next.join('\n'))
  }
  // 没有 config：紧跟 `- id:` 之后插入（映射键的顺序不影响 YAML 语义，位置固定才好断言）。
  next.splice(start + 1, 0, ' '.repeat(indent + 2) + 'config:', line)
  return commit(next.join('\n'))
}

/**
 * 设置（非空字符串）或移除（`null`）插件 loader 行的 `config.token`。
 *
 * @param content - 补丁文件全文。
 * @param token - 要写入的令牌；`null` = 移除。
 * @returns `found: false` 表示文件里没有本插件那条 loader 行（调用方据此报错）；
 *   否则给出新全文与"是否真的改了"。
 */
export function applyLoaderToken(content: string, token: string | null, pluginId: string = PLUGIN_LOADER_ID): LoaderTokenWrite {
  return rewriteConfigKey(content, 'token', token === null ? null : yq(token), pluginId)
}

/**
 * 打开（`true`）或关掉（`false`）令牌功能 —— **不动 `config.token` 本身**。
 *
 * 关掉 = 写一行 `tokenDisabled: true`：令牌留在配置里，随时能开回来，不需要重新输一遍
 * （用户裁定 2026-09-19）。`false` = 删掉那一行。
 *
 * @param disabled - `true` 写开关；`false` / `null` 删掉该键。
 */
export function applyLoaderTokenDisabled(content: string, disabled: boolean | null, pluginId: string = PLUGIN_LOADER_ID): LoaderTokenWrite {
  return rewriteConfigKey(content, 'tokenDisabled', disabled === true ? 'true' : null, pluginId)
}

/**
 * 0.1.7 bundle 挂载下的令牌落点：profile 补丁里的**覆盖条目**（官方 `applyEntryPatches`
 * 的 id-targeted override —— 不带 name / insert、只带 id + config，宿主在 bundle 层之后
 * 应用它，整体替换那条 loader 的 `config`；bundle 条目没有 config，替换零丢失）。
 * 注意：同 id 的 **insert** 条目才会重复挂载、启动失败；覆盖条目是官方支持的改法，
 * 目标不存在的树只是逐条警告跳过（一份 overlay 打多个表面，不必每棵树都命中）。
 */
export function buildLoaderOverrideEntry(token: string, pluginId: string = PLUGIN_LOADER_ID): string {
  return '- id: ' + pluginId + '\n  config:\n    token: ' + yq(token)
}
