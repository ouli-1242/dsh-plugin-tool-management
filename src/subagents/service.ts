// src/subagents/service.ts —— 轻量子智能体：人设发现（TTL 扫描）+ 官方 ctx.subagents.start 薄封装。
// 设计 §3：人设 = $DSH_HOME/tool-management/agents/<name>.md（frontmatter 可选，缺省派生）；v1 串行运行；
// provider 缺失时经 createRequire 挂载宿主侧包：`spawn`（新会话，默认）与 `fork`（继承本次会话）。
//
// v0.4 目录变更：人设由 `$DSH_HOME/subagents/` 搬到 `$DSH_HOME/tool-management/agents/`
// （插件产生的文件统一收在 tool-management/ 下）。旧目录在首次扫描时搬入，见 relocateLegacyPersonas。
import { createRequire } from 'node:module'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '../skills/core.js'
// 深度探针与注入通道共用一份实现（口径分叉就会出现"目录说不能、工具却能"的错配）。
// 方向是 service → context-inject，单向：context-inject 不 import 本模块。
import { subagentDepthOf } from '../context-inject.js'
import { listTrashEntries, moveOutOfTrash, moveToTrash, purgeTrashEntry, readTrashEntry } from '../hub.js'
import { expandUploads, planPersonaImport } from '../imports/upload.js'

const message = (e: unknown): string => String((e && (e as Error).message) || e)

/** 人设默认目录：`$DSH_HOME/tool-management/subagents/`（域 = 子智能体，工具 `subagent_manager_*`）。 */
export function defaultPersonasDir(): string {
  return join(resolveDshHome(), 'tool-management', 'subagents')
}

/**
 * 旧目录 `$DSH_HOME/subagents/` → `tool-management/subagents/` 一次性搬移（幂等）。
 * （hub 内 `agents/` → `subagents/` 的改名由 hub.ts 的启动迁移负责。）
 * 只在目标不存在同名文件时搬（绝不覆盖）；源目录保留空壳。每个进程只跑一次。
 */
let personasRelocated = false
async function relocateLegacyPersonas(dir: string): Promise<void> {
  if (personasRelocated) return
  personasRelocated = true
  const legacy = join(resolveDshHome(), 'subagents')
  if (legacy === dir) return
  let names: string[]
  try {
    names = (await readdir(legacy)).filter((n) => n.toLowerCase().endsWith('.md'))
  } catch {
    return
  }
  if (!names.length) return
  await mkdir(dir, { recursive: true }).catch(() => undefined)
  for (const name of names) {
    const from = join(legacy, name)
    const to = join(dir, name)
    try {
      const exists = await stat(to).then(() => true).catch(() => false)
      if (exists) continue
      await rename(from, to)
    } catch {
      /* 单项失败（被占用等）不阻断其余；保留源文件，下次启动再试 */
    }
  }
}

export interface PersonaDoc {
  name: string
  description: string
  /** 模型路由的 provider 半边（与 model 配对；缺省 = 继承主会话）。 */
  provider?: string
  model?: string
  /** 工具白名单：只保留列出的工具（与 toolsDeny 组合，deny 优先）。**旧格式**：对所有预设生效。 */
  tools?: string[]
  /** 工具黑名单：从子代理可见集合里移除（优先级高于白名单）。**旧格式**：对所有预设生效。 */
  toolsDeny?: string[]
  /** 按 Agent 预设分组的工具限制（新格式）：键 = 预设 id，如 `standard`。 */
  toolsByPreset?: Record<string, PresetToolRule>
  /**
   * **输出契约**（frontmatter `output:`，可重复：一条要求一行；缺省 = 没有人设级硬要求）。
   *
   * 为什么单开一个字段而不是写在正文里：正文是"这个角色是什么"（散文），契约是"产出必须
   * 长什么样"（可检验的硬要求）。两者混在一起时，散文会把硬要求稀释成风格提示 —— 实测里
   * 一句「必须从第一性原理出发，使用对抗性审查」既没有产出形态、也无法判断有没有执行。
   * 独立字段让角色框把它渲染成单独一节（`## 输出要求`，位置在角色定义之后 —— 收尾处
   * 对模型同样显眼），作者也能在人设编辑器里单独维护。
   */
  output?: string
  /**
   * **人设目录注入到哪些会话**（frontmatter `catalogDepth`，默认 1）。
   *
   * ⚠️ 它**不是**递归上限。子代理始终可以继续委派 —— 官方 `dsh-tool-subagent` 工具的
   * `maxDepth` 默认是 **3**（`lib/index.js:269`），provider 只在**传了该值**时才校验
   * （`dsh-subagent-in-process-driver/lib/index.js:165` → `resolveChildDepth` →
   * `SubagentDepthError`）。2026-09-17 用户实测确认了这一点，也推翻了此前"子会话委派
   * 必然失败"的假设：那个假设只对**本插件自己的**工具成立（因为我们当时传了
   * `maxDepth: 1`），官方工具不受影响、照常能嵌套。**同一个子会话里官方工具能委派、
   * 我们的不能**，是那次自相矛盾的根源。
   *
   * 现在这个字段只做一件事：决定常驻的人设目录出现在哪些深度的会话里。
   *   - `1`（默认）= 只在顶层注入（子会话收不到目录）；
   *   - `2` = 顶层和子会话都注入；
   *   - `3` = 到两层子会话；
   *   - `UNLIMITED_PERSONA_CATALOG_DEPTH`（99）= 不限制嵌套，任何深度的会话都注入。
   * 判据是 `深度 < catalogDepth`。每一跳读**被委派那个人设**的字段，不需要跨会话保存状态。
   *
   * 为什么不把它传给官方：`SubagentStartRequest.maxDepth` 是**真的**递归上限，而我们这个
   * 字段的意图只是"目录出现在哪"。绑在一起会让我们的工具比官方严（1 vs 3），而且用户想
   * 禁止嵌套也禁止不了 —— 官方工具照样能。所以现在**不传**，让 provider 用它自己的默认。
   */
  catalogDepth?: number
  body: string
  path: string
  /**
   * 子智能体开关（list() 时由启用集合计算后附加）：`false` = 停用 —— 不注入目录段、
   * subagent_manager_list / subagent_manager_run 不可见；文件本体一个字节不动。
   * 缺省/`true` = 启用。原始解析（parsePersona）不产生这个字段。
   */
  enabled?: boolean
}

/** 一个 Agent 预设下的工具限制：白名单（只留列出的）或黑名单（移除列出的）。 */
export interface PresetToolRule {
  mode: 'allow' | 'deny'
  names: string[]
}

/** 一次委派实际下发的 ToolRestriction（与官方 `SubagentStartRequest.toolFilter` 同形）。 */
export interface ToolFilter {
  allow?: string[]
  deny?: string[]
}

/** `decideToolFilter` 的结论：`null` 表示明确不加限制。 */
export interface ToolFilterDecision {
  filter: ToolFilter | null
  /** 需要如实转告调用方的一句话（预设判断失败、名单里有已失效的工具等）。 */
  note?: string
}

export interface SubagentService {
  list(): Promise<PersonaDoc[]>
  /** 场景绑定校验 + 串行运行一个子代理（结果文本截断 ≤16 KiB）。`inherit` = 用 fork 通道（见 runOnce）。 */
  runSerial(parentAgent: any, persona: PersonaDoc, task: string, signal: AbortSignal | undefined, toolFilter?: ToolFilter | null, inherit?: boolean): Promise<{ text: string; runId: string; stopReason: string }>
  ops: Record<string, (args: any) => Promise<any>>
  /** 写操作 op 名集合（HTTP 端 WRITE_OPS 由它派生）。 */
  writeOps: ReadonlySet<string>
  /**
   * 场景档案引擎专用（非 op，无 HTTP 门禁面）：人设启用集合的读/写通道。
   * 进入模式时启用档案勾选的人设、退出时按快照停回，都走这里。
   */
  enabledStore: {
    /** 指定名单里当前被停用的（进入模式拍快照用：只记将被启用的行）。 */
    disabledAmong(names: string[]): Promise<string[]>
    /** 指定名单里当前**开着**的（进入模式把未勾的关掉时，只记将被关闭的行）。 */
    enabledAmong(names: string[]): Promise<string[]>
    /** 当前开着的人设全名单（档案页把「开关」落成场景绑定时用）。 */
    enabledNames(): Promise<string[]>
    /** 批量启停；只碰给出的名字，人设已不存在的跳过。 */
    setEnabled(names: string[], enabled: boolean): Promise<void>
  }
}

/** 逗号/顿号分隔的名字清单（空串 → undefined）。 */
function listOf(value: unknown): string[] | undefined {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  const list = text.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  return list.length ? list : undefined
}

/**
 * 解析 `toolsByPreset:` 块 —— 每个 Agent 预设一行：
 *
 * ```yaml
 * toolsByPreset:
 *   standard: allow: read, write
 *   ptc: deny: workflow
 * ```
 *
 * 缩进即"在块内"，回到顶格即块结束（frontmatter 只有这一处嵌套，所以不需要完整
 * YAML 解析器）。模式 id 只做形状校验，认不认得由运行时按当前预设名单判断。
 */
export function parsePresetToolRules(frontmatter: string): Record<string, PresetToolRule> | undefined {
  const rules: Record<string, PresetToolRule> = {}
  let inBlock = false
  for (const raw of frontmatter.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!inBlock) {
      if (/^toolsbypreset\s*:\s*$/i.test(line.trim())) inBlock = true
      continue
    }
    if (line.trim() === '') continue
    if (!/^\s/.test(line)) break
    const m = /^\s*([A-Za-z0-9._-]+)\s*:\s*(allow|deny)\s*:\s*(.*)$/i.exec(line)
    if (!m) continue
    const names = listOf(m[3])
    // 空名单 = 不限制 = 不落盘，读到时也直接忽略，免得把"没开"读成"开了但空"。
    if (!names) continue
    rules[m[1]] = { mode: m[2].toLowerCase() === 'deny' ? 'deny' : 'allow', names }
  }
  return Object.keys(rules).length ? rules : undefined
}

/** 行式 frontmatter 解析：只认 description / provider / model / tools / toolsDeny / toolsByPreset / catalogDepth / output。 */
export function parsePersona(raw: string, fallbackName: string): PersonaDoc {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  const data: Record<string, string> = {}
  const outputLines: string[] = []
  let body = raw
  let toolsByPreset: Record<string, PresetToolRule> | undefined
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim())
      if (!kv) continue
      const key = kv[1].toLowerCase()
      // `output:` 是**可重复**的键（一条要求一行，按顺序收集）。frontmatter 是逐行解析的，
      // 多行契约塞不进一个值里；写成重复键比引入块标量语法简单，也一眼看得懂。
      if (key === 'output') {
        if (kv[2].trim() !== '') outputLines.push(kv[2].trim())
        continue
      }
      data[key] = kv[2].trim()
    }
    toolsByPreset = parsePresetToolRules(m[1])
    body = raw.slice(m[0].length)
  }
  const tools = listOf(data.tools)
  // 兼容两种写法：`toolsdeny: a, b`（线上格式）与 `toolsDeny: a, b`（键名统一小写后同形）。
  const toolsDeny = listOf(data.toolsdeny)
  const firstLine = body.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
  const catalogDepth = parseCatalogDepth(data)
  return {
    name: fallbackName,
    description: data.description || firstLine,
    provider: data.provider || undefined,
    model: data.model || undefined,
    tools,
    toolsDeny,
    ...(toolsByPreset === undefined ? {} : { toolsByPreset }),
    ...(catalogDepth === undefined ? {} : { catalogDepth }),
    ...(outputLines.length ? { output: outputLines.join('\n') } : {}),
    body: body.trim(),
    path: '',
  }
}

/** 零宽空格：用来拆开 `{{`，视觉上不留痕。 */
const ZERO_WIDTH = '\u200b'

/**
 * 拆开正文里的 `{{`，让它不再被宿主当作提示词变量引用。
 *
 * 宿主对 section 文本做**严格**变量插值（dsh-system-prompt 的 `interpolate`）：
 * 命中 `{{name}}` 而该变量没注册就抛错，整个子代理启动失败。人设是用户自由文本，
 * 作者写 `{{foo}}` 几乎一定是字面量，却会让委派直接崩掉。这里在两个花括号之间插一个
 * 零宽空格：模型看到的仍是 `{{foo}}`，宿主再也找不到 `{{`。**只拆开，不删除**——
 * 用户写下的每一个可见字符都保留。
 */
export function neutralizePromptVariables(text: string): string {
  // 在"后面还是左花括号"的 `{` 之后插入零宽空格，把 `{{` 拆成 `{<ZWSP>{`。
  // 用前瞻断言而不是 `replace(/\{\{/g, …)`：后者的替换串**尾字符也是 `{`**，
  // 遇到 `{{{` 会与被替换掉的首括号后面的原字符重新拼出 `{{`（实测踩到）。
  // 前瞻写法一次扫描就够，连续多少个左括号都处理干净。
  return text.replace(/\{(?=\{)/g, `{${ZERO_WIDTH}`)
}

/**
 * 这个人设主要用中文写的？启发式，判错的代价只是框的语言不搭。
 *
 * 判定范围是**人设整体**（名字 + 描述 + 正文），不只是正文：正文可能是占位符、
 * 代码片段或纯英文标识（实测有人的正文是 `123`），只看正文会把一个中文人设
 * 判成英文、配上英文框。名字与描述是作者写的，同样能说明语言。
 */
function isChinesePersona(name: string, description: string, body: string): boolean {
  const sample = `${name}\n${description}\n${body}`
  const cjk = (sample.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length
  if (cjk === 0) return false
  const latin = (sample.match(/[A-Za-z]/g) || []).length
  // 汉字信息密度高于字母，1 个汉字按 2 个字母折算，避免"中文正文夹少量英文术语"被判成英文。
  return cjk * 2 >= latin
}

/**
 * 人设 → 子代理系统提示词里那一段的**成品文本**（2026-09-17）。
 *
 * 为什么需要这层框：宿主给子代理的 persona 只占一个槽位 —— `deployment:persona-prefix`，
 * section order 0，位置紧贴 `harness:identity`（order -1000，那句 "You are an AI agent
 * powered by DeepSeek Harness."）。而宿主自己的 `personaPrefix` 配置是**部署级短前缀**，
 * 它默认由部署方承担框架。我们把整篇人设正文直接填进这个槽，等于交出一段无标题、无归属、
 * 无授权的裸文本：模型读到的是"身份句后面又跟了两句话"，而不是"我被指定为一个角色"。
 * 用户写的 `必须…` 因此只是背景信息，没有上位效力。
 *
 * 两份参考实现都靠**框**解决同一件事：Claude Code 把代理提示词放在系统提示词**首位**，
 * 追加内容一律带 `#`/`##` 标题与指令段（`AgentTool/agentMemory.ts`、`memdir/memdir.ts`）；
 * Codex 在指令文件交界处插入来源标记 `--- project-doc ---`，让模型知道权威边界从哪开始
 * （`core/src/agents_md.rs`）。两者都没有"把用户正文裸拼进系统提示词"这种做法。
 *
 * 框里四样东西各有分工，缺一样就退化成原来的裸文本：
 *   - `# 角色：名` —— 结构信号（markdown 标题是模型最强的分段线索）+ 可引用的名字；
 *   - 归属 + 授权一行 —— "由调用方指定、与默认倾向冲突时以它为准"，给正文上位效力；
 *     2026-09-17 补了半句"任务说要什么，怎么做以它为准"：不写这句，模型会把 `task`
 *     （父代理按自己的框架写的具体指令）读成人设的上级，人设只剩风格提示的分量；
 *   - 边界一句 —— 角色决定**怎么做**，不改变**能做什么**。这不是装饰：官方
 *     `subagent:delegation` 运行时上下文已经声明"权限在启动时固定"，两处不呼应的话，
 *     写着"你可以随意写文件"的人设会读起来像与工具限制矛盾；
 *   - `## 角色定义` 标题 + 正文 —— 明确起止，把用户文本围起来。
 *
 * 语言跟随人设整体（名字 + 描述 + 正文）：中文人设配中文框，英文配英文。
 *
 * 框里**不列 `description`**（2026-09-17 用户裁定，此前列）：那个字段的用途是**给调用方
 * 选用**（本机那份写的是"当用户提到审查或使用审查子智能体时使用"），对已经在执行的人设
 * 子代理是错位信息 —— 可能被读成"满足某个条件才按这个角色"的前置条件。要给人设子代理
 * 看的简介属于正文（`description` 仍照常参与语言判定与目录展示）。
 *
 * 正文为空时退化成只给一个名字 —— 空框比没有框更糟。
 */
export function renderPersonaPrompt(persona: PersonaDoc): string {
  // 名字与正文/输出过同一道中和：名字原样进框时，宿主对 section 文本的严格插值会把
  // `{{…}}` 当未注册变量抛错，委派直接硬失败 —— 0.9.5 的中和只盖了正文与输出，漏了名字
  // （validPersonaName 不挡花括号，手写 frontmatter 造得出这种名字）。
  const name = neutralizePromptVariables(String(persona.name || '').trim()) || '(unnamed)'
  const raw = String(persona.body ?? '')
  const body = neutralizePromptVariables(raw.trim())
  if (body === '') return name
  const rawDescription = String(persona.description ?? '').trim()
  const output = neutralizePromptVariables(String(persona.output ?? '').trim())
  const lines = isChinesePersona(name, rawDescription, raw)
    ? [
        `# 角色：${name}`,
        '',
        `你正在以「${name}」的身份执行本次委派任务。以下角色定义由调用方指定，是你本次运行的固定行为准则：与你的默认倾向冲突时，以它为准；任务说要什么，怎么做以它为准。它决定你如何工作，不改变你的权限范围。`,
        '',
        '## 角色定义',
        '',
        body,
        ...(output === '' ? [] : ['', '## 输出要求（硬性）', '', output]),
      ]
    : [
        `# Persona: ${name}`,
        '',
        `You are running this delegated task as "${name}". The persona below was specified by the caller and is your fixed operating guideline for this run: where it conflicts with your default inclinations, it wins; the task states what to achieve, and this persona governs how. It governs how you work, not what you are permitted to do.`,
        '',
        '## Persona',
        '',
        body,
        ...(output === '' ? [] : ['', '## Output requirements (hard)', '', output]),
      ]
  return lines.join('\n')
}

/** 一个人设没写 `catalogDepth` 时的目录注入深度：1 —— 只在顶层注入目录。 */
export const DEFAULT_PERSONA_CATALOG_DEPTH = 1

/**
 * 「不限制嵌套」的目录注入深度（界面下拉的第四档，前端同值见 client.js 的
 * `CATALOG_DEPTH_UNLIMITED`）。
 *
 * 取值远大于宿主能嵌套到的深度（官方 `dsh-tool-subagent` 默认 `maxDepth: 3`），所以判据
 * `深度 < catalogDepth` 在任何可达的会话里都成立 —— 判据本身不必为它加特例分支。
 */
export const UNLIMITED_PERSONA_CATALOG_DEPTH = 99

/**
 * 这个人设的目录注入深度（非法值一律退回默认，**默认从不放宽**）。
 *
 * 为什么非法值退回默认而不是报错：`catalogDepth` 是 frontmatter 里手写的字段，写错一个
 * 数字不该让整个人设不可用；而"退回默认"是安全方向 —— 默认只注入到顶层，噪声最小。
 */
export function catalogDepthOf(persona: Pick<PersonaDoc, 'catalogDepth'>): number {
  const value = persona?.catalogDepth
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return DEFAULT_PERSONA_CATALOG_DEPTH
  return value
}

/**
 * 深度为 `depth` 的会话里，该不该注入这个人设所在的目录？
 *
 * 判据是 `depth < 目录注入深度`。**这个函数是三处口径的唯一来源** —— 目录要不要列出、
 * 域该不该注入、实况报什么状态，全都问它。各写一份必然分叉。
 *
 * ⚠️ 它回答的**不是**"能不能委派"（那由官方决定，且默认能嵌套到 3 层）。这个区分是
 * 2026-09-17 用户实测后纠正的：此前函数名是 `canDelegateTo`，把"目录可见性"当成了
 * "委派可行性"，于是同一个子会话里官方工具能委派、我们的工具被自己的守卫拦下。
 */
export function catalogInjectedAt(persona: Pick<PersonaDoc, 'catalogDepth'>, depth: number): boolean {
  const from = Number.isSafeInteger(depth) && depth >= 0 ? depth : 0
  return from < catalogDepthOf(persona)
}

/** frontmatter 里目录注入深度的几种写法都认（含旧的 `maxDepth`，见下）。 */
function parseCatalogDepth(data: Record<string, string>): number | undefined {
  // 旧键 `maxDepth` 也读：0.9.5 定稿前这个字段叫过那个名字，且当时语义是"递归上限"。
  // 读它只是为了不让手写过旧键的文件静默失效；**写回时一律写新键**（见 serializePersona）。
  const raw = data.catalogdepth ?? data['catalog-depth'] ?? data.catalog_depth ?? data.maxdepth ?? data['max-depth'] ?? data.max_depth
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw.trim())
  if (!Number.isSafeInteger(value) || value < 0) return undefined
  return value
}

const RESULT_MAX = 16 * 1024

/**
 * 从内容块数组里按 `type` 取文本并拼接 —— 官方 `finalText` 的口径
 * （`dsh-subagent/lib/index.js:2658`：`blocks.filter(block => block.type === "text")`；
 * `dsh-tool-subagent` 的 `outputValueText`、`withDiagnosticAndPartialText` 同样如此）。
 *
 * **必须按 `type` 过滤，不能只判有没有 `text` 字段**：`ContentBlock` 里 `TextBlock` 与
 * `ReasoningBlock` 的结构完全相同（都是 `{ type, text: string }`，见 dsh-llm 的
 * `types.d.ts:39/44`），只判字段会把**思考**当成正文拼进去。本机 298 条子代理终局消息里
 * 294 条受影响：211 条思考与正文并存（返回结果的开头变成「我做了 1、2、3」这类自我校验，
 * 正文被顶到后面），83 条压根没有正文。
 *
 * `typeof b.text === 'string'` 这层是防 provider 给出畸形块（官方工具也这么防）。
 */
export function textOfBlocks(blocks: unknown, type: string): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b: any) => b !== null && typeof b === 'object' && b.type === type && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('')
    .trim()
}

/**
 * 没有正文时给调用方的一句话。
 *
 * 要解决的是**误读**：原来一律回 `(子代理无输出)`，而「子代理没干活」和「干了活但没写出
 * 正文」是两件事，报成同一句会让调用方把它当成一次空跑。所以这一句里必须同时说清两件事：
 *   ① 它**干了活**（产出了思考）—— 否则会被读成空跑；
 *   ② 这次委派**没有拿到可用结果** —— 否则会被当成一份内容读下去。
 *
 * 按收尾原因分档，而不是给一句通用话：实测数据推翻了「它忘了写结论」这个想当然的解释 ——
 * 本机 83 条「没有正文」的终局里**没有一条是 `completed`**（max-tokens 36、error 20、
 * 无收尾记录 22、aborted 5），而有正文那批 215 条里 195 条是 `completed`。官方自己也是
 * 这么分的：`dsh-tool-subagent/lib/index.js:316` 对任何非 `completed` 的收尾**直接抛错**
 * （`stopReasonError` → `withDiagnosticAndPartialText`），只有 `completed` 才当结果返回。
 * 所以这个兜底出现的场合，对策基本都是「拆小任务 / 查诊断 / 换人设」，不是原样再发一次。
 *
 * 分档用的是官方 `stopReasonError` 认的那几个值，出现新值时落回最后那句通用说明。
 *
 * 刻意**不把思考正文塞回来**：那正是这次要修的泄漏，换个标签塞回去等于没修。
 */
export function emptyResultNote(output: unknown, stopReason?: string): string {
  // 连思考都没有 → 子代理确实什么都没产出，这时说「没干活」是对的。
  if (textOfBlocks(output, 'reasoning') === '') return '(子代理无输出)'
  const head = '子代理没有返回正文 —— 它产出了思考'
  switch (stopReason) {
    case 'max-tokens':
      return `(${head}，但写出结论前就用完了 token 上限；需要结果请把任务拆小些再委派。)`
    case 'error':
      return `(${head}，但中途出错了；诊断信息见后。)`
    case 'aborted':
      return `(${head}，但写出结论前被中止了。)`
    case 'refusal':
      return `(${head}，但它拒绝了这项任务。)`
    default:
      return `(${head}，但没有写出结论；可以拆小任务重新委派，或你自己接着做。)`
  }
}

export function createSubagentService(ctx: any, opts?: { subagentsDir?: string; stateDir?: string }): SubagentService {
  const dir = opts?.subagentsDir || defaultPersonasDir()
  const stateDir = opts?.stateDir && opts.stateDir.trim() !== '' ? opts.stateDir : join(resolveDshHome(), 'tool-management')
  const stateFile = join(stateDir, 'subagents-index.json')
  const req = createRequire(import.meta.url)

  let cache: { at: number; value: PersonaDoc[] } | null = null

  // ── 人设启用集合（子智能体开关）────────────────────────────────────────
  // subagents-index.json：{ version: 1, enabled: string[] }（与 memories-index.json 同目录约定）。
  //   - 文件缺失/损坏 = **全部启用**（老用户升级零感知，行为与开关上线前一致）；
  //   - 文件一旦写出即为权威：之后新建/导入/回收站恢复的人设**自动启用**（刚建就想用是常理）；
  //   - 停用只影响注入与 subagent_* 工具的可见性，人设文件一个字节不动。
  // 缓存约定：undefined = 还没读过盘；null = 文件缺失（全部启用）；数组 = 权威集合。
  let enabledCache: string[] | null | undefined = undefined
  async function readEnabled(): Promise<string[] | null> {
    if (enabledCache !== undefined) return enabledCache
    // 用局部变量过渡：await 之后 TS 对闭包级缓存变量的收窄会失效，直接返回会报 undefined。
    let next: string[] | null
    try {
      const raw = JSON.parse(await readFile(stateFile, 'utf8'))
      next = Array.isArray(raw && raw.enabled) ? raw.enabled.map((x: unknown) => String(x)) : []
    } catch { next = null }
    enabledCache = next
    return next
  }
  async function writeEnabled(list: string[]): Promise<void> {
    await mkdir(stateDir, { recursive: true })
    await writeFile(stateFile, JSON.stringify({ version: 1, enabled: list }, null, 2), 'utf8')
    enabledCache = list
  }
  /** 新建/导入/恢复的人设默认停用（v0.8.5 用户裁定，与技能 / MCP 同口径）：
   *  文件缺失（含旧数据）时先把「全部启用」物化成显式全集**并排除新名**——
   *  否则新名会随"文件缺失=全启用"的兼容语义被误判为启用。已有显式集合时新名
   *  不在集合里，天然停用，无需写盘。 */
  async function materializeEnabledExcluding(names: string[]): Promise<void> {
    const set = await readEnabled()
    if (set !== null) return
    const docs = await list()
    await writeEnabled(docs.map((d) => d.name).filter((n) => names.indexOf(n) < 0))
    cache = null
  }
  /** 改名跟随：旧名在集合里就改新名；不在（停用中）保持停用。 */
  async function renamePersonaInEnabled(from: string, to: string): Promise<void> {
    const set = await readEnabled()
    if (set === null) return
    const i = set.indexOf(from)
    if (i < 0) return
    set[i] = to
    await writeEnabled(set)
  }
  /** 删除后从集合摘掉，别留悬空名（列表时无害，但会让集合越攒越脏）。 */
  async function removePersonaFromEnabled(name: string): Promise<void> {
    const set = await readEnabled()
    if (set === null || set.indexOf(name) < 0) return
    await writeEnabled(set.filter((n) => n !== name))
  }
  /** list() 输出统一附上 enabled：文件缺失 → 全 true；否则按集合。 */
  function withEnabled(docs: PersonaDoc[], set: string[] | null): PersonaDoc[] {
    if (set === null) return docs.map((d) => ({ ...d, enabled: true }))
    return docs.map((d) => ({ ...d, enabled: set.indexOf(d.name) >= 0 }))
  }

  async function list(): Promise<PersonaDoc[]> {
    let docs: PersonaDoc[]
    if (cache && Date.now() - cache.at < 1000) {
      docs = cache.value
    } else {
      // 旧目录搬家放在首次扫描前（幂等；失败不阻断，旧目录仍会被下面的读取兜底看到）。
      await relocateLegacyPersonas(dir).catch(() => undefined)
      const fresh: PersonaDoc[] = []
      try {
        const entries = await readdir(dir)
        for (const fileName of entries.filter((e) => e.endsWith('.md')).sort()) {
          const raw = await readFile(join(dir, fileName), 'utf8').catch(() => '')
          if (!raw.trim()) continue
          fresh.push({ ...parsePersona(raw, fileName.slice(0, -3)), path: join(dir, fileName) })
        }
      } catch { /* 目录缺失 = 无人设 */ }
      cache = { at: Date.now(), value: fresh }
      docs = fresh
    }
    return withEnabled(docs, await readEnabled())
  }

  // provider 在场性（设计 §3.2，落地方式见 cordis.patch.yml 的取舍注释）：
  // 官方通道探测（ctx.subagents.list()）→ 缺失才挂载 → 失败把原因原样带出（不吞、不谎报）。
  // 不是一次性静默标记：每次调用都先探测，宿主后来注册了 provider 也能立刻跟上。
  //
  // 两个 provider（2026-09-17 加 fork，理由见 runOnce 的通道说明）：
  //   spawn = 新起的独立会话（默认）；fork = **继承本次会话已完成的对话**（官方 subagent_fork 用的是它）。
  const PROVIDER_PACKAGES = {
    spawn: { pkg: '@deepseek-ai/dsh-subagent-spawn-in-process', label: 'spawn（新会话）' },
    fork: { pkg: '@deepseek-ai/dsh-subagent-fork-in-process', label: 'fork（继承本次会话）' },
  } as const
  type ProviderKind = keyof typeof PROVIDER_PACKAGES
  const providerMounts: Partial<Record<ProviderKind, { ok: true } | { ok: false; error: string }>> = {}
  function hasProvider(runtime: any, kind: ProviderKind): boolean {
    if (typeof runtime.list !== 'function') return false
    try {
      const names = runtime.list()
      return Array.isArray(names) && names.indexOf(kind) >= 0
    } catch { return false }
  }
  async function ensureProvider(kind: ProviderKind): Promise<any> {
    const runtime = ctx.get?.('subagents')
    if (!runtime || typeof runtime.start !== 'function') {
      throw new Error('子代理服务未挂载（ctx.subagents 缺失；请确认 DSH 版本 ≥0.1.5-rc.2）')
    }
    if (hasProvider(runtime, kind)) return runtime
    // 宿主没有 list() 就探测不了：不重复挂载（避免同名 provider 二次注册），交给 start 报官方错误兜底。
    if (typeof runtime.list !== 'function') return runtime
    if (!providerMounts[kind]) {
      const { pkg, label } = PROVIDER_PACKAGES[kind]
      try {
        const mod = req(pkg)
        if (!mod || typeof mod.apply !== 'function') throw new Error('模块未导出 apply(ctx, config)（版本不匹配？）')
        mod.apply(ctx, { providerName: kind })
        providerMounts[kind] = { ok: true }
      } catch (e) {
        providerMounts[kind] = {
          ok: false,
          error: `${label} provider 不可用：宿主没有注册它，本插件挂载 ${pkg} 也失败（`
            + message(e) + '）。请在宿主 profile 挂载该包（本插件已声明为可选 peerDependency），或安装后重启 DSH。',
        }
      }
    }
    const mount = providerMounts[kind]
    if (!mount || !mount.ok) throw new Error(mount ? mount.error : 'provider 挂载失败（未知原因）')
    if (!hasProvider(runtime, kind)) throw new Error(`${kind} provider 挂载后仍未出现在 ctx.subagents.list()（宿主版本不匹配？）`)
    return runtime
  }

  async function runOnce(parentAgent: any, p: PersonaDoc, task: string, signal: AbortSignal | undefined, toolFilter?: ToolFilter | null, inherit?: boolean): Promise<{ text: string; runId: string; stopReason: string }> {
    // 这里**刻意没有**"预算用尽就拒绝"的前置检查（2026-09-17 用户实测后拆掉）。
    // 它此前基于一个错误假设：以为传 `maxDepth: 1` 会让子会话再委派必然失败。实际上官方
    // `dsh-tool-subagent` 的默认是 **3**、provider 只在**传了值**时才校验（`resolveChildDepth`），
    // 所以子代理本来就能继续嵌套。那个检查唯一的净效果是让**我们的**工具比官方严 ——
    // 同一个子会话里官方工具能委派、我们的被自己拦下 —— 而用户真想禁止嵌套也禁止不了。
    //
    // 通道选择（方案 C，2026-09-17）：`inherit` → 官方 fork provider（子会话被**本次会话已完成的
    // 对话**播种，`task` 只需写新增部分）；默认 → spawn（全新会话，任务必须自包含）。
    // 为什么必须有这一档：官方的 `subagent_fork` 靠"继承上下文"赢走过模型的选择 —— 本机实测
    // （session-ee722e23）上下文里明明有「先在这里选人设…用 subagent_manager_run 执行」与
    // `code-review` 人设，模型在**读进 README 之后**仍选了 `subagent_fork`：那能把已读内容带过去、
    // 不必复述。人设通道缺这一档时，"贴合人设的任务"会持续被官方工具抢走 —— 补齐能力比改文案
    // 更根本（模型选的是省力，不是没看见）。fork provider 的能力位（persona / toolFilter /
    // agentOptions）与 spawn 相同，所以请求体不用分叉。
    const kind: ProviderKind = inherit === true ? 'fork' : 'spawn'
    const runtime = await ensureProvider(kind)
    // 工具限制三态：对象 = 调用方已按当前预设决定；null = 调用方明确决定不加限制；
    // undefined = 调用方没决定（如别的入口直接调 runSerial）→ 回落人设里的旧格式全局名单。
    const legacyFilter: ToolFilter | null = (p.tools?.length || p.toolsDeny?.length)
      ? { ...(p.tools?.length ? { allow: p.tools } : {}), ...(p.toolsDeny?.length ? { deny: p.toolsDeny } : {}) }
      : null
    const resolved = toolFilter === undefined ? legacyFilter : toolFilter
    // 官方签名：start(name, request) —— name = ctx.subagents 上的 provider 注册名。
    const run = await runtime.start(kind, {
      label: p.name,
      parent: parentAgent,
      // 官方 SubagentStartRequest.signal 为必填：调用方缺省时给一个永不中止的信号，不传 undefined。
      signal: signal ?? new AbortController().signal,
      prompt: [{ type: 'text', text: task }],
      // 人设不是裸正文：宿主的 persona 槽位（section order 0）原本是部署级短前缀，
      // 框架该由填槽方承担。见 renderPersonaPrompt 的说明 —— 裸拼的后果是模型把它
      // 读成身份句的续写，而不是一个被指定的角色。
      persona: renderPersonaPrompt(p),
      // 工具白/黑名单 → 官方 ToolRestriction（`deny` 优先级高于 `allow`；未知名官方会直接拒绝启动，
      // 所以名单由 index.ts 按当前预设 + 当前真实存在的工具名算好再传进来，见 decideToolFilter）。
      ...(resolved === null ? {} : { toolFilter: resolved }),
      // **刻意不传 `maxDepth`**（2026-09-17 用户裁定，方案 A）：它是官方的**真·递归上限**
      // （`resolveChildDepth` 会抛 `SubagentDepthError`），而我们的 `catalogDepth` 只想决定
      // "目录出现在哪"。传了它会让我们的工具比官方严（1 vs 3），且会要求 provider 具备
      // `depthLimit` capability（不传就没这个依赖）。让 provider 用它自己的默认，与官方
      // 工具的能力保持一致。
      // provider 与 model 是模型路由的两半：DSH 的 resolveModel(provider, model) 不做
      // `provider/model` 字符串拆分，只改 model 会落在**主会话的 provider** 上——跨来源
      // 指定模型（如 sensenova 的 sensenova-6.8-flash-lite）必须两个键一起给。
      ...(p.provider || p.model
        ? { agentOptions: { ...(p.provider ? { provider: p.provider } : {}), ...(p.model ? { model: p.model } : {}) } }
        : {}),
    })
    try {
      const result = await run.result   // 官方契约：child 级失败不 reject（stopReason 体现）
      // 只取 `text` 块（见 textOfBlocks）。此前这里只判了 `typeof b.text === 'string'`，
      // 于是 `reasoning` 块被当成正文 —— 子代理返回的正文里混着它的思考（计数、自我校验），
      // 只有思考时整段返回思考。本机 298 条终局消息里 98.7% 命中。
      const text = textOfBlocks(result.output, 'text')
      // 官方 SubagentResult 的诊断字段是 `diagnostic`（旧代码读 .detail 恒空 → 失败时模型只见空输出）。
      const diagnostic = (result as any).diagnostic ? `\n\n[provider] ${String((result as any).diagnostic)}` : ''
      const stopReason = String((result as any).stopReason ?? 'completed')
      return {
        text: ((text || emptyResultNote(result.output, stopReason)) + diagnostic).slice(0, RESULT_MAX),
        runId: String(run.id ?? ''),
        stopReason,
      }
    } finally {
      await run.dispose().catch(() => {})   // 官方前台语义：collection 后即弃
    }
  }

  // v1 串行：同一时刻至多一个子代理运行（设计 §3.2）。
  let chain: Promise<unknown> = Promise.resolve()
  const runSerial = (parentAgent: any, p: PersonaDoc, task: string, signal: AbortSignal | undefined, toolFilter?: ToolFilter | null, inherit?: boolean) => {
    const start = () => runOnce(parentAgent, p, task, signal, toolFilter, inherit)
    const queued = chain.then(start, start)
    chain = queued.catch(() => undefined)
    return queued
  }

  const ops = {
    'subagent-list': async () => {
      const docs = await list()
      return {
        ok: true,
        // catalogDepth 报**生效值**（没写就是默认 1），界面与模型都不必各自知道默认是多少。
        subagents: docs.map((p) => ({ name: p.name, enabled: p.enabled !== false, description: p.description, provider: p.provider ?? null, model: p.model ?? null, tools: p.tools ?? null, toolsDeny: p.toolsDeny ?? null, toolsByPreset: p.toolsByPreset ?? null, catalogDepth: catalogDepthOf(p), output: p.output ?? null })),
      }
    },
    'subagent-get': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      const docs = await list()
      const p = docs.find((d) => d.name === name)
      if (!p) return { ok: false, error: `人设不存在: ${name}` }
      return { ok: true, persona: { name: p.name, description: p.description, provider: p.provider ?? '', model: p.model ?? '', tools: p.tools ?? [], toolsDeny: p.toolsDeny ?? [], toolsByPreset: p.toolsByPreset ?? {}, catalogDepth: catalogDepthOf(p), output: p.output ?? '', body: p.body } }
    },
    'subagent-create': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      if (!validPersonaName(name)) return { ok: false, error: `人设名不合法: ${name || '(空)'}（≤64 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）` }
      const target = join(dir, name + '.md')
      const exists = await readFile(target, 'utf8').then(() => true).catch(() => false)
      if (exists) return { ok: false, error: `人设已存在: ${name}` }
      // 目录必须先建：v0.4 起人设落在 hub 内的 agents/，全新安装时它还不存在
      // （旧版本落在 $DSH_HOME/subagents/，那个目录一直有人建，所以这个坑以前不显形）。
      try {
        await mkdir(dir, { recursive: true })
      } catch (e) {
        return { ok: false, error: `创建人设目录失败: ${dir}（${message(e)}）` }
      }
      await writeFile(target, serializePersona(args), 'utf8')
      // v0.8.5：新建默认不启动——显式集合下新名天然停用；文件缺失时先物化全集并排除新名。
      await materializeEnabledExcluding([name]).catch(() => undefined)
      cache = null
      return { ok: true, name }
    },
    /**
     * 保存人设，**可选改名**（nextName）。
     * 人设名就是文件名（`agents/<名>.md`），所以改名 = 重命名文件；
     * 目标名已存在直接拒绝，绝不覆盖别人的文件。
     * 返回 `renamedFrom` 供调用方把场景档案里的绑定一起改掉（档案存的是人设名）。
     */
    'subagent-update': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      if (!validPersonaName(name)) return { ok: false, error: `人设名不合法: ${name || '(空)'}` }
      const target = join(dir, name + '.md')
      const exists = await readFile(target, 'utf8').then(() => true).catch(() => false)
      if (!exists) return { ok: false, error: `人设不存在: ${name}` }
      let finalName = name
      let renamedFrom: string | undefined
      const nextRaw = args && args.nextName !== undefined ? String(args.nextName).trim() : ''
      if (nextRaw !== '' && nextRaw !== name) {
        if (!validPersonaName(nextRaw)) {
          return { ok: false, error: `新人设名不合法: ${nextRaw}（非空、≤64 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）` }
        }
        const nextTarget = join(dir, nextRaw + '.md')
        const taken = await readFile(nextTarget, 'utf8').then(() => true).catch(() => false)
        if (taken) return { ok: false, error: `人设已存在: ${nextRaw}` }
        try {
          await rename(target, nextTarget)
        } catch (e) {
          return { ok: false, error: `人设改名失败: ${message(e)}` }
        }
        finalName = nextRaw
        renamedFrom = name
      }
      await writeFile(join(dir, finalName + '.md'), serializePersona({ ...args, name: finalName }), 'utf8')
      if (renamedFrom) await renamePersonaInEnabled(renamedFrom, finalName).catch(() => undefined)
      cache = null
      return { ok: true, name: finalName, ...(renamedFrom ? { renamedFrom } : {}) }
    },
    /**
     * 删除人设 = **移入回收站**（`hub/trash/agents-trash/<id>/persona.md`）。
     * 早先这里是 `rm`，而界面按钮写着「移入回收站」——文案与行为不一致；现在行为追上文案，
     * 误删可以从子智能体页的回收站里恢复。
     */
    'subagent-delete': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      if (!validPersonaName(name)) return { ok: false, error: `人设名不合法: ${name || '(空)'}` }
      const target = join(dir, name + '.md')
      const exists = await readFile(target, 'utf8').then(() => true).catch(() => false)
      if (!exists) return { ok: false, error: `人设不存在: ${name}` }
      const moved = await moveToTrash('subagents', name, [{ from: target, dest: 'persona.md' }])
      if (moved.ok === false) return { ok: false, error: `移入回收站失败: ${moved.error}` }
      await removePersonaFromEnabled(name).catch(() => undefined)
      cache = null
      return { ok: true, name, trashId: moved.id }
    },
    'subagent-trash-list': async () => ({ ok: true, trash: await listTrashEntries('subagents') }),
    'subagent-trash-restore': async (args: any) => {
      const id = String((args && args.id) || '').trim()
      const entry = await readTrashEntry('subagents', id)
      if (!entry) return { ok: false, error: `回收站条目不存在: ${id}` }
      if (!validPersonaName(entry.name)) return { ok: false, error: `回收站里的人设名不合法: ${entry.name}` }
      const target = join(dir, entry.name + '.md')
      const exists = await readFile(target, 'utf8').then(() => true).catch(() => false)
      // 绝不覆盖：同名人设已经存在时如实拒绝，让人自己决定怎么办。
      if (exists) return { ok: false, error: `无法恢复，同名人设已存在: ${entry.name}` }
      try {
        await mkdir(dir, { recursive: true })
        await moveOutOfTrash('subagents', id, 'persona.md', target)
      } catch (e) {
        return { ok: false, error: `恢复失败: ${message(e)}` }
      }
      await purgeTrashEntry('subagents', id)
      // v0.8.5：回收站恢复默认不启动（与新建/导入同口径）。
      await materializeEnabledExcluding([entry.name]).catch(() => undefined)
      cache = null
      return { ok: true, name: entry.name }
    },
    'subagent-trash-delete': async (args: any) => {
      const id = String((args && args.id) || '').trim()
      const gone = await purgeTrashEntry('subagents', id)
      if (!gone) return { ok: false, error: `回收站条目不存在: ${id}` }
      return { ok: true, id }
    },
    /**
     * 导入人设（.md / .zip）：一个 .md 一个人设，文件名（去扩展名）= 人设名；
     * zip 内任意层级的 .md 都按文件名导入（目录层级忽略）。同名**跳过并报告**，不覆盖既有文件。
     * 部分成功：单条失败只记 skipped。
     */
    'subagent-import': async (args: any) => {
      const files = args && args.files
      if (!Array.isArray(files) || !files.length) return { ok: false, error: '没有选择要导入的文件' }
      const { entries, problems } = expandUploads(files)
      const planned = planPersonaImport(entries)
      const skipped: Array<{ name: string; reason: string }> = [...problems, ...planned.problems]
      const imported: string[] = []
      for (const target of planned.targets) {
        if (!validPersonaName(target.name)) { skipped.push({ name: target.name, reason: '人设名不合法（≤64 字符、不含路径分隔符与 < > : " | ? *、不以 . 开头）' }); continue }
        const text = Buffer.from(target.bytes).toString('utf8').replace(/^\uFEFF/, '')
        if (!text.trim()) { skipped.push({ name: target.name, reason: '内容为空，已跳过' }); continue }
        const targetPath = join(dir, target.name + '.md')
        const exists = await readFile(targetPath, 'utf8').then(() => true).catch(() => false)
        if (exists) { skipped.push({ name: target.name, reason: '同名已存在（已跳过）' }); continue }
        try {
          await mkdir(dir, { recursive: true })
          await writeFile(targetPath, text, 'utf8')
        } catch (e) {
          skipped.push({ name: target.name, reason: '写入失败：' + message(e) })
          continue
        }
        imported.push(target.name)
      }
      if (imported.length) {
        await materializeEnabledExcluding(imported).catch(() => undefined)
        cache = null
      }
      return { ok: true, imported, skipped }
    },
    /**
     * 子智能体开关（v0.8）：停用 = 不注入目录段、subagent_manager_list/run 不可见；文件本体不动。
     * `enabled` 必须显式给布尔值 —— 与 rules-toggle 同一条口径：不按"翻转"推断，
     * 免得参数丢了时界面以为改了、实际什么都没动。
     */
    'subagent-toggle': async (args: any) => {
      const name = String((args && args.name) || '').trim()
      if (!validPersonaName(name)) return { ok: false, error: `人设名不合法: ${name || '(空)'}` }
      if (typeof (args && args.enabled) !== 'boolean') {
        return { ok: false, error: '缺少参数：enabled 必须是布尔值（只按传入值写入，不做"翻转"推断）' }
      }
      const docs = await list()
      if (!docs.some((d) => d.name === name)) return { ok: false, error: `人设不存在: ${name}` }
      const set = await readEnabled()
      // 文件缺失 = 当前全启用：首次开关时把现状物化成显式集合（否则"部分停用"无处落笔）。
      const base = (set === null ? docs.map((d) => d.name) : set.slice()).filter((n) => docs.some((d) => d.name === n))
      const i = base.indexOf(name)
      if (args.enabled === true) {
        if (i < 0) base.push(name)
      } else if (i >= 0) {
        base.splice(i, 1)
      }
      await writeEnabled(base)
      cache = null
      return { ok: true, name, enabled: args.enabled === true }
    },
  }
  const enabledStore = {
    /** 指定名单里当前被停用的（进入模式拍快照用：只记将被启用的行，退出时精确停回）。 */
    async disabledAmong(names: string[]): Promise<string[]> {
      const docs = await list()
      const state = new Map(docs.map((d) => [d.name, d.enabled !== false]))
      return names.filter((n) => state.get(n) === false)
    },
    /** 指定名单里当前**开着**的（进入模式把未勾的关掉时，只记将被关闭的行）。 */
    async enabledAmong(names: string[]): Promise<string[]> {
      const docs = await list()
      const state = new Map(docs.map((d) => [d.name, d.enabled !== false]))
      return names.filter((n) => state.get(n) === true)
    },
    /** 当前开着的人设全名单（档案页把页面的「开关」落成场景绑定时用）。 */
    async enabledNames(): Promise<string[]> {
      const docs = await list()
      const state = new Map(docs.map((d) => [d.name, d.enabled !== false]))
      return docs.map((d) => d.name).filter((n) => state.get(n) === true)
    },
    /** 批量启停；只碰给出的名字，人设已不存在的跳过（别把悬空名写进集合）。 */
    async setEnabled(names: string[], enabled: boolean): Promise<void> {
      const docs = await list()
      const set = await readEnabled()
      const base = (set === null ? docs.map((d) => d.name) : set.slice()).filter((n) => docs.some((d) => d.name === n))
      let dirty = false
      for (const n of names) {
        if (!docs.some((d) => d.name === n)) continue
        const i = base.indexOf(n)
        if (enabled && i < 0) { base.push(n); dirty = true }
        if (!enabled && i >= 0) { base.splice(i, 1); dirty = true }
      }
      if (dirty) {
        await writeEnabled(base)
        cache = null
      }
    },
  }
  return { list, runSerial, ops, enabledStore, writeOps: new Set(['subagent-create', 'subagent-update', 'subagent-delete', 'subagent-import', 'subagent-toggle', 'subagent-trash-restore', 'subagent-trash-delete']) }
}

function validPersonaName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && !name.startsWith('.') && !/[\\/<>:"|?*]/.test(name)
}

/** 字符串数组规范化（非数组/空项都丢掉）。 */
function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((x: unknown) => String(x).trim()).filter(Boolean) : []
}

/**
 * 规范化前端传来的 `toolsByPreset`：丢掉空名单（空 = 不限制 = 不落盘），
 * 模式 id 只收形状合法的（预设 id 允许字母数字点横线）。
 */
export function presetRulesOf(value: unknown): Array<[string, PresetToolRule]> {
  if (value === null || typeof value !== 'object') return []
  const out: Array<[string, PresetToolRule]> = []
  for (const [rawId, rawRule] of Object.entries(value as Record<string, unknown>)) {
    const id = String(rawId).trim()
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) continue
    if (rawRule === null || typeof rawRule !== 'object') continue
    const rec = rawRule as { mode?: unknown; names?: unknown }
    const names = toStringList(rec.names)
    if (!names.length) continue
    out.push([id, { mode: String(rec.mode) === 'deny' ? 'deny' : 'allow', names }])
  }
  return out
}

/** 人设文件序列化：frontmatter 只写用户填过的键；正文 = 人设提示词。 */
export function serializePersona(args: any): string {
  const description = String((args && args.description) || '').replace(/\r?\n/g, ' ').trim()
  const provider = String((args && args.provider) || '').trim()
  const model = String((args && args.model) || '').trim()
  const tools = toStringList(args?.tools)
  // 黑名单字段兼容两种入参名：toolsDeny（UI/camel）与 tools_deny（snake）。
  const toolsDeny = toStringList(args?.toolsDeny ?? args?.tools_deny)
  const byPreset = presetRulesOf(args?.toolsByPreset)
  // 目录注入深度：只在显式给了合法值时写入。默认（1）**不落盘** —— 免得每个新建的人设都
  // 多一行说明"它和默认一样"，也保证老的人设文件回写后逐字节不变。
  // 入参名兼容三种：catalogDepth（新）、maxDepth / max_depth（0.9.5 定稿前的旧名）。
  const catalogDepthRaw = args?.catalogDepth ?? args?.catalog_depth ?? args?.maxDepth ?? args?.max_depth
  const catalogDepth = catalogDepthRaw === undefined || catalogDepthRaw === null || String(catalogDepthRaw).trim() === ''
    ? undefined
    : Number(String(catalogDepthRaw).trim())
  const hasCatalogDepth = catalogDepth !== undefined && Number.isSafeInteger(catalogDepth) && catalogDepth >= 0 && catalogDepth !== DEFAULT_PERSONA_CATALOG_DEPTH
  const body = String((args && args.body) ?? '').trim()
  // `output` 可传字符串（按行拆）或数组（界面直接给数组）：一条要求写成一行重复键。
  const outputLines = (Array.isArray(args?.output) ? args.output.map((v: unknown) => String(v)) : String(args?.output ?? '').split(/\r?\n/))
    .map((line: string) => line.trim())
    .filter((line: string) => line !== '')
  const lines = ['---']
  if (description) lines.push('description: ' + description)
  if (provider) lines.push('provider: ' + provider)
  if (model) lines.push('model: ' + model)
  if (hasCatalogDepth) lines.push('catalogDepth: ' + String(catalogDepth))
  for (const line of outputLines) lines.push('output: ' + line)
  if (tools.length) lines.push('tools: ' + tools.join(', '))
  if (toolsDeny.length) lines.push('toolsDeny: ' + toolsDeny.join(', '))
  if (byPreset.length) {
    lines.push('toolsByPreset:')
    for (const [id, rule] of byPreset) lines.push('  ' + id + ': ' + rule.mode + ': ' + rule.names.join(', '))
  }
  lines.push('---', '', body, '')
  return lines.join('\n')
}

/**
 * 按**当前会话的 Agent 预设**决定这次委派下发什么工具限制。
 *
 * 为什么必须按预设分：子代理跑在父会话的预设里（官方 `composeFrom(childCtx, parent.ctx)`），
 * 而各预设的工具集合差别极大（极简模式只有持久 shell），官方 `tools.restrict()` 遇到
 * 名单里不存在的工具名会直接抛错、子代理根本起不来。所以：
 *
 *   - 当前预设配了名单（且名单非空）→ 用它；白名单额外并入**当时真实在跑的 MCP 工具**
 *     （官方 allow 是"清单之外全砍"，不并进来会把 MCP 一起砍掉；用户裁定：子代理要能
 *     用当前启动的 MCP）；
 *   - 当前预设没配 → 回落旧的全局 `tools` / `toolsDeny`（老文件行为不变）；
 *   - 名单里有已经消失的工具名 → **丢掉并在 note 里如实说明**（不接受静默失效）；
 *   - 判断不了当前预设（老宿主 / 异常）→ 不按模式施加，并在 note 里说明。
 *
 * 三态返回：`filter: null` = 明确不加限制；`filter: {...}` = 下发该限制。
 */
export function decideToolFilter(
  persona: PersonaDoc,
  presetId: string | null,
  known: { names: Set<string>; mcp: string[] },
): ToolFilterDecision {
  const rule = presetId === null ? undefined : persona.toolsByPreset?.[presetId]
  if (rule && rule.names.length) {
    const usable = rule.names.filter((name) => known.names.has(name))
    const dropped = rule.names.filter((name) => !known.names.has(name))
    const droppedNote = dropped.length ? `名单里这些工具当前不存在，已忽略：${dropped.join('、')}` : undefined
    if (!usable.length) {
      return { filter: null, note: `「${presetId}」的${rule.mode === 'allow' ? '白' : '黑'}名单里没有当前存在的工具，本次不施加工具限制` }
    }
    if (rule.mode === 'allow') return { filter: { allow: [...new Set([...usable, ...known.mcp])] }, ...(droppedNote === undefined ? {} : { note: droppedNote }) }
    return { filter: { deny: usable }, ...(droppedNote === undefined ? {} : { note: droppedNote }) }
  }
  // 旧格式（全局名单）：保持老行为，白名单同样并入 MCP。
  const legacyAllow = (persona.tools || []).filter((name) => known.names.has(name))
  const legacyDeny = (persona.toolsDeny || []).filter((name) => known.names.has(name))
  const legacyDropped = [...(persona.tools || []), ...(persona.toolsDeny || [])].filter((name) => !known.names.has(name))
  const filter: ToolFilter = {
    ...(legacyAllow.length ? { allow: [...new Set([...legacyAllow, ...known.mcp])] } : {}),
    ...(legacyDeny.length ? { deny: legacyDeny } : {}),
  }
  const notes: string[] = []
  const hasLegacy = Boolean((persona.tools || []).length || (persona.toolsDeny || []).length)
  if (presetId === null) {
    // 说清这一刻到底靠什么在跑：有旧格式就照旧格式，没有就明说"按模式配的限制这次不生效"。
    notes.push(hasLegacy
      ? '没能判断当前会话的 Agent 预设，按旧格式的全局名单执行'
      : '没能判断当前会话的 Agent 预设，按模式配的限制这次不生效')
  }
  if (legacyDropped.length) notes.push(`名单里这些工具当前不存在，已忽略：${legacyDropped.join('、')}`)
  if (!Object.keys(filter).length) {
    if (presetId === null && !notes.length) notes.push('没能判断当前会话的 Agent 预设，本次不施加工具限制')
    return { filter: null, ...(notes.length ? { note: notes.join('；') } : {}) }
  }
  return { filter, ...(notes.length ? { note: notes.join('；') } : {}) }
}
