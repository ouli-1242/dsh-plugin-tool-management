// 人设文件的读侧与渲染：解析 frontmatter、规整名字、把中性骨架拼成某个语言的提示词，
// 以及工具结果/空结果的文案收口。
//
// 从 subagents/service.ts 整段搬来，一行未改。这一层不认识宿主也不写文件：进来一段文本，
// 出去一个 PersonaDoc；创建与更新走的解析口径与扫描时同一份，两处不能各写一套。
import type { PersonaDoc, PresetToolRule } from './persona-types.js'

/** 逗号/顿号分隔的名字清单（空串 → undefined）。 */
export function listOf(value: unknown): string[] | undefined {
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
/**
 * 思考强度档位 id 的归一：单行、去空白、限长。**不校验它是不是合法档位** —— 清单要问 adapter
 * 才拿得到（可能拿不到），而官方本来就会在 provider I/O 之前拒掉不支持的显式值。
 *
 * 为什么必须去换行：frontmatter 是**逐行**解析的（`parsePersona`），值里带换行会把后面半截
 * 变成一行无主文本。限长是防脏值（正常档位 id 都很短）。
 */
export const REASONING_EFFORT_MAX_LENGTH = 64
export function normalizeReasoningEffort(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, REASONING_EFFORT_MAX_LENGTH)
}

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
    // frontmatter 键统一小写后是 `reasoningeffort`（写出去的是 camelCase）。
    reasoningEffort: normalizeReasoningEffort(data.reasoningeffort) || undefined,
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
export const ZERO_WIDTH = '\u200b'

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
export function isChinesePersona(name: string, description: string, body: string): boolean {
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
export function parseCatalogDepth(data: Record<string, string>): number | undefined {
  // 旧键 `maxDepth` 也读：0.9.5 定稿前这个字段叫过那个名字，且当时语义是"递归上限"。
  // 读它只是为了不让手写过旧键的文件静默失效；**写回时一律写新键**（见 serializePersona）。
  const raw = data.catalogdepth ?? data['catalog-depth'] ?? data.catalog_depth ?? data.maxdepth ?? data['max-depth'] ?? data.max_depth
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw.trim())
  if (!Number.isSafeInteger(value) || value < 0) return undefined
  return value
}

export const RESULT_MAX = 16 * 1024

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