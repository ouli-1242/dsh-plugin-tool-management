// 「模型工具表」开关。
//
// 为什么要有它：工具表是按**每个请求**付钱的 —— 每一轮都随请求发出工具 schema，哪怕这一轮
// 根本用不上。关掉某几个工具，它们整份不进请求（不是"把描述写短点"那种省）；面板
// （118 个 op）与注入通道完全不受影响。
//
// 出厂**默认就关着十八条**（其中自主笔记那一条跟随总开关开合；整张表 23 条，每轮实发 5 条）—— 名单、判据与代价见下面
// `DEFAULT_HIDDEN_TOOLS`；用户自己额外关的与出厂关的在合计那句里分开报。
//
// 实测数字（口径：宿主 `recordToolSize` 的 `ceil(JSON.stringify(header.tools).length / 4) + 4`，
// 即**字符数 / 4**；`header.tools` 里只有 name / description / parameters —— 官方的
// `projectToolSchema` 不投影 output / execute，那几个不进请求。界面「模型工具表」那行
// 合计与逐条 ≈tok 就是这份）：
//   · 上一次实测（`memory_get` 合并之前）是 18 条隐藏 ≈**4,524 tok**、默认可见 6 条
//     ≈**1,536 tok**、全开 ≈**6,055 tok**。合并后少了一条工具、描述也换了，**没有重测** ——
//     引用时按"旧口径"说，别当成当前工具表的实测值。
//   · 同一批 A/B 实测净少 **4,119 / 4,197 tok**（把当时那批隐藏工具逐个打开，前后各跑两轮），
//     对照当天合计 4,186 略低是正常的（边界按 ceil 逐个算、四条一合并就省下那几个 +4）。
//     那是**净节省的下界**，不是"省了多少"的上界；描述一改就得重测，新的净省要在真实环境跑
//     A/B，这里不拿估算冒充实测。
//
// ⚠️ **那个口径不是 token 数，别拿它跟别的数直接比**（用真 BPE 词表实测）：
// 工具描述是英文，`字符数 / 4` 对英文**高估约 10%** —— 18 个工具那一版真实是 ≈3,137 tok（o200k）。
// 反方向也一样：注入段是中文，同一个口径对它**低估约 13%**（四段 716 → 真 823）。
// 所以"工具表 / 注入"这两个数不是同一把尺子，跨语言比大小会得出错的结论。
// 口径本身是**宿主的**（`recordToolSize`），我们改不了；能做的只是知道它偏在哪。
//
// 当前环境**没有 BPE 分词器可实测**：官方包里零个词表文件，本机也没有 tiktoken /
// transformers。所以上面那些只是**按宿主的尺子**量出来的数，真 BPE 值按上面那条经验约低一成 ——
// 没有实测，别当实测引用。
//
// 本文件只放纯逻辑（normalize / 分域分组 / 体积汇总）。落盘与 TTL 缓存在 index.ts，与
// 注入设置（`inject-settings.json`）走同一套写法。
//
// 谁读这份设置：
//   · index.ts 的 op `tool-table`（读写侧车 + 写后刷新可见性与两个目录）——
//     带 `sessionId` 的那一支改的是**本对话**的整份名单（存 `scope-overrides.json`），
//     这份侧车只剩"新对话的默认模板"与方案库；
//   · mcp/manager.ts 的 `pluginHiddenTools` —— 官方 `tools.restrict()` 只允许**每个 agent
//     scope 一层**限制（两处各调一次会互相覆盖），所以 MCP 停用名单与我们的名单必须在那边
//     并成一次 restrict；
//   · 工具执行门禁（关掉的工具即便被点到也不执行 —— 可见性半边失败时仍有这一半）；
//   · 注入通道与两个目录：目录里「用 `skill_manager_list` 查」这类句子在工具关掉后就是假的。

import { INJECT_DOMAIN_KEYS, domainOfTool, type InjectDomainKey } from '../context-inject.js'
import { LEGACY_TOOL_NAME_MAP } from '../legacy-tool-names.js'
import { CONTROL_TOOL_NAME } from './deps.js'

/**
 * 自主笔记唯一那条工具的名字。
 *
 * learn / forget 两个行为靠 `action` 分叉；名字集中在这里，是因为
 * 「出厂隐藏名单」「跟随总开关开合」「旧名迁移」「工具注册」四处都得认同一串字符。
 */
export const PROACTIVE_MEMORY_TOOL = 'memory_note'

/**
 * 自主笔记那条工具**只跟总开关走**，工具表盘上存过的关停名单对它无效。
 *
 * 为什么两个方向都要强制：开着时保存一次工具表会把它从 `hidden` 摘掉（那时不许关），
 * 名单从此不再包含它；而 `DEFAULT_HIDDEN_TOOLS` 只在用户从没存过设置时铺一次底 ——
 * 于是关掉自主笔记之后，模型手里仍留着一条"看得见、调了只会报错"的工具。
 *
 * 一份纯函数给全局读路径、会话读路径、两条写路径和回包共用：少一处判据就少一处
 * 「面板说开着、restrict 说关着」的分叉。
 */
export function normalizeProactiveToolHidden(hidden: readonly string[], enabled: boolean): string[] {
  const has = hidden.includes(PROACTIVE_MEMORY_TOOL)
  if (enabled ? !has : has) return hidden.slice()
  return enabled
    ? hidden.filter((name) => name !== PROACTIVE_MEMORY_TOOL)
    : [...hidden, PROACTIVE_MEMORY_TOOL]
}

/**
 * 从工具表数据里**永久摘掉**自主笔记那条工具（只删不加）。
 *
 * 它与 `normalizeProactiveToolHidden` 是两件事：后者给运行时算可见性（关着时要把它补进
 * 隐藏名单）；这一份给界面回包与落盘，保证「工具表」这份数据里根本没有这条工具 ——
 * 面板不显示它，保存名单 / 方案也不会多带一条用户改不了的记录。
 */
export function stripProactiveToolHidden(hidden: readonly string[]): string[] {
  return hidden.filter((name) => name !== PROACTIVE_MEMORY_TOOL)
}

/** 一份命名方案：名字 + 那一组"不发给模型"的工具名（与 `hidden` 同口径，不是"开着哪些"）。 */
export interface ToolTablePreset {
  name: string
  hidden: string[]
}

/**
 * 侧车 `tool-table.json` 的形状。
 *
 * `hidden` 是**当前生效**的那份；`presets` 是用户存下来的命名方案（界面「保存方案 / 恢复方案」）。
 * 两者同处一份文件是刻意的：方案只是"另一份 hidden"，分开存就要处理两份真相互相落后
 * （改完当前忘了同步方案，或反过来）。
 */
export interface ToolTableSettings {
  hidden: string[]
  presets: ToolTablePreset[]
}

/**
 * 出厂默认关掉的**十八条**：整张表 23 条，关掉后**每轮实发 5 条**。下面五组列 16 条，
 * 人设清单（`subagent_manager_list`）单列在「人设域」那一段，自主笔记单列在末尾 ——
 * 三条计数不要合并，否则又会对不上。
 *
 * 判据只有一条：**这些信息或动作常态下由注入段与面板承担，
 * 平时也用不到模型自己伸手**。分五组：
 *   · **写侧五条** —— 三个 `*_save`（MCP / 技能 / 人设：配置本体在面板上改）+
 *     `prompt_manager_apply`（当前生效的那份本来就在 `Current prompt` 注入段里）+
 *     `plugin_manager_remove`（删除进回收站可恢复，但常态下由面板承担）。
 *   · **读侧四条** —— `mcp_manager_list` / `skill_manager_list` / `prompt_manager_list` /
 *     `scene_manager_list`。会话开头注入的那几段目录已经写了当前有什么，模型不必每轮
 *     再带一份查询工具。
 *     **`memory_get` 刻意不在这份名单**：合并后的读取入口同时承担清单、搜索与正文，
 *     藏掉它等于把被截断的条目、以及 `memory_remember` 需要的 id 变成不可发现。
 *   · **切场一条** —— `scene_manager_switch`：进入 / 退出场景。
 *   · **开关四条** —— `skill` / `memory` / `subagent` 三个 `_switch`（用户：「平时使用也很少」）
 *     + `mcp_manager_switch`。启停在面板上都有同款，注入段也写着当前开着哪些。
 *     MCP 那条**也关**（用户指定的五条清单里没有它）：代价是这个域出厂没有一条可见工具 ——
 *     模型要停 / 启服务器，得先用 `tool_manager_tools` 把它打开，多一次往返。默认清单以
 *     用户点名的五条为准，不为了"每域留一条腿"自行加回。
 *   · **建档两条** —— `scene_manager_save`（场景记录）+ `scene_manager_archive`（档案段：
 *     进入时开哪些 MCP / 技能 / 人设）。配置本体在面板上改；档案的勾选集机器自己算得出来
 *     （`capture`），模型逐项填反而容易填错。
 *
 * 人设域**没有官方载体兜底**：MCP / 技能 / 记忆三个域即便目录被压制型预设压掉，也各自还留着
 * 一条常驻发现路径（各自的 list 工具），而人设目录一旦不注入，模型手里就只剩
 * `subagent_manager_run` —— 人设的 id 就是名字，`run` 报错时会把当前可委派的那几个列出来，
 * 但那要先猜错一次。这条清单工具（≈165 tok/轮）**默认关**：常态下人设目录已经在注入段里，
 * 它只是那份的**全量版**（停用的、场景外的、每个人设正文在哪），要全量清单时模型自己就能
 * 打开它（控制面工具那条永远在）。
 *
 * 技能 / 人设"是常问的，但它**低频于"读现状 + 拨开关 + 建改定义"**那批，而且面板每个域都有
 * 删除入口 —— 默认关、要用时在「兼容」页勾上（与其余默认关停的工具同一条纪律，不额外付 token）。
 *
 * 关掉的这些**模型自己也能打开**：`tool_manager_tools`（每轮常驻的那一条）能按对话
 * 打开任意一条被关掉的工具，列清单时给出名字、一句话用途与 ≈token。这条工具不在
 * 这份名单里 —— 它是唯一的回头路，自己关掉自己的话就再也开不回来了。
 *
 * ⚠️ 关掉的是**能力**，不是"冗余"，代价如实记在这里（要拿回来就在「兼容」页勾，或整批换：
 * 「恢复方案」）：注入的目录是**筛过的视图**（MCP 段只列可用/曾可用的、人设目录只列本场景
 * 绑定且深度够的、技能目录只列可调用的），所以"没开的那几台 / 被同名覆盖的那份技能 / 没进
 * 上下文的记忆正文"在会话里查不到；`*_switch` 关掉后模型也不能再替你拨启停。三处配套改动为
 * 的就是不把模型往墙上推：目录被条数上限截断时那句「用 `X_manager_list` 查」自动退回「另有
 * N more not listed.)」（`listToolVisible`）；`mcp_manager_list` / `skill_manager_read` 里"没找到 →
 * 去调 list"那两句先问 `deps.toolVisible`；`memory_get` 的描述不再点名已关的工具。
 *
 * 只在**用户从没记过选择**时生效（见 index.ts 的 `toolTableSettingsFrom`：侧车文件读不出来
 * 才用这份）。已经存过盘的一律照原样，包括显式的 `hidden: []` —— 那是"我全都要"，
 * 不是"还没配过"。存过盘的人要拿回这份默认，走界面上的「恢复方案 → 出厂默认」。
 */
export const DEFAULT_HIDDEN_TOOLS: readonly string[] = Object.freeze([
  'scene_manager_list',
  'scene_manager_switch',
  'scene_manager_save',
  'scene_manager_archive',
  'memory_switch',
  'mcp_manager_list',
  'mcp_manager_save',
  'mcp_manager_switch',
  'skill_manager_list',
  'skill_manager_switch',
  'skill_manager_save',
  'subagent_manager_list',
  'subagent_manager_switch',
  'subagent_manager_save',
  'prompt_manager_list',
  'prompt_manager_apply',
  'plugin_manager_remove',
  // 自主笔记：默认藏着（它是权限，不是便利），此后**跟随总开关开合** —— 开着强制可见、
  // 关着强制隐藏，两边都不能手动改（见 index.ts 的 proactiveMemoryGlobalOn 那条过滤链）。
  // 放在这份名单而不是另建一张表：
  // 工具表清单、体积统计、兼容页分组全都读这一份，多一张表就多一处"清单显示开着、
  // 实际被藏着"的错位。
  PROACTIVE_MEMORY_TOOL,
])

/** 出厂默认那份设置：十八条不发（名单与理由见上面），方案清单是空的。 */
export const DEFAULT_TOOL_TABLE_SETTINGS: ToolTableSettings = { hidden: [...DEFAULT_HIDDEN_TOOLS], presets: [] }

/** 方案名上限（与 MCP 备注那类输入同风格：短到能在一行里读，长了也没人看）。 */
export const PRESET_NAME_MAX_LENGTH = 40
/**
 * 场景档案绑定「出厂默认那份」时用的方案名。
 * 它不是一个可保存的方案名，只在档案里当哨兵用；解析时用户存的同名方案优先。
 */
export const FACTORY_TOOL_TABLE_PRESET = 'factory-default'
/** 存得下的方案数上限 —— 侧车是人手能审的文件，不放开。 */
export const PRESET_MAX_COUNT = 20

const DEFAULT_HIDDEN_SET: ReadonlySet<string> = new Set(DEFAULT_HIDDEN_TOOLS)

/** 夹一份工具名名单（只收非空字符串；重复的只留一份）。 */
function normalizeNameList(list: unknown): string[] {
  const out: string[] = []
  if (!Array.isArray(list)) return out
  for (const item of list) {
    // 只认字符串：`[7]` 这种手改产物不该被 String() 变成一个看着像工具名的东西。
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name !== '' && out.indexOf(name) < 0) out.push(name)
  }
  return out
}

/** 夹一份方案清单：名字非空且截到上限、同名只留第一个、总数封顶（超出的是手改产物，丢掉不如不认）。 */
function normalizePresetList(list: unknown): ToolTablePreset[] {
  const out: ToolTablePreset[] = []
  if (!Array.isArray(list)) return out
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    if (typeof raw.name !== 'string') continue
    const name = raw.name.trim().slice(0, PRESET_NAME_MAX_LENGTH)
    if (name === '' || !Array.isArray(raw.hidden)) continue
    if (out.some((p) => p.name === name)) continue
    // 方案不保存自主笔记那条工具：它只跟两个开关走（见 stripProactiveToolHidden）。
    // 旧方案里残留的名字读出来就过滤掉，应用时也不会被它影响。
    out.push({ name, hidden: normalizeNameList(raw.hidden).filter((n) => n !== PROACTIVE_MEMORY_TOOL) })
    if (out.length >= PRESET_MAX_COUNT) break
  }
  return out
}

/** 把任意输入夹成合法设置（缺字段 / 类型不对的条目一律不认，绝不凭空造方案）。 */
export function normalizeToolTableSettings(raw: unknown): ToolTableSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { hidden: normalizeNameList(obj.hidden), presets: normalizePresetList(obj.presets) }
}

/**
 * 读侧入口：**从没记过选择**（侧车不存在 / 读不出，`readJsonFile` 给 `null`）时给出厂默认，
 * 其余一律按盘上那份夹一遍。
 *
 * 为什么必须分这一叉：默认值不能合成在 `normalize` 里，否则用户把五条全打开、存下
 * `hidden: []` 之后，下一次读又会把它们关回去 —— 那是把"我全都要"读成"还没配过"。
 */
export function toolTableSettingsFrom(raw: unknown): ToolTableSettings {
  return raw === null || raw === undefined ? DEFAULT_TOOL_TABLE_SETTINGS : normalizeToolTableSettings(raw)
}

/**
 * 严格结构检查：宽松归一化会把「合法 JSON 但形状错了」读成 `hidden: []`
 * ——也就是**全部打开**，用户关掉的工具会在执行守卫眼皮底下复活。
 *
 * 只把真正影响可见性的字段判为损坏：顶层必须是对象、`hidden` 必须是字符串数组、
 * `presets` 必须是数组。方案条目的残缺仍按原口径跳过 —— 它不改变当前 hidden，
 * 不该因为一条手工改坏的方案把整份设置锁死。
 */
export function classifyToolTableSettings(raw: unknown): { ok: true; value: ToolTableSettings } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '顶层必须是对象' }
  const obj = raw as Record<string, unknown>
  if (obj.hidden !== undefined) {
    if (!Array.isArray(obj.hidden)) return { ok: false, error: 'hidden 必须是字符串数组' }
    for (const item of obj.hidden) {
      if (typeof item !== 'string') return { ok: false, error: 'hidden 里出现了非字符串条目' }
    }
  }
  if (obj.presets !== undefined && !Array.isArray(obj.presets)) return { ok: false, error: 'presets 必须是数组' }
  return { ok: true, value: normalizeToolTableSettings(raw) }
}

/**
 * 旧工具名 → 新工具名迁移表（几轮改名累积）。
 *
 * 为什么必须有它：`tool-table.json` 存的是**用户点名关掉的那些工具**。几族并成 17 条
 * 之后，旧名在新表里根本不存在 —— 不迁移的话，用户"关掉了某条"的意图会在新名字上**静默失效**
 * （那条工具照旧每轮发出去，而他以为早就关了）。
 *
 * 映射规则不是字符串替换而是**语义合并**：两条旧工具并成一条 `save` 时，只要原来关掉了其中
 * 任意一条，就应当关掉新的那条 —— 用户当时的意图是"别让模型碰这件事"。
 *
 * 只翻译**认识的名字**，其余原样保留：我们无法区分"用户的旧名"与"别的插件的工具名"，
 * 误删别人的条目比留着一条死名更糟。
 *
 * 表本身放在根目录那一叶（`src/legacy-tool-names.ts`）：它还有两个使用方在更低的层
 * （会话侧车、场景快照），那些层不能反向引本文件。
 */
export { LEGACY_TOOL_NAME_MAP } from '../legacy-tool-names.js'

/**
 * 把一份设置里的旧工具名翻译成新名（**幂等**：已经全是新名时 `changed` 为 false、原样返回）。
 * 翻译后按新名去重（两条旧名并成同一条 save 时只留一份）。
 *
 * 命名方案**一起翻译**：方案里存的就是工具名，只翻当前那份的话，用户恢复旧方案时会把
 * 已经改名的条目原样铺回当前设置 —— 那条"静默失效"的毛病只是晚一步发生。
 */
export function migrateLegacyToolNames(settings: ToolTableSettings): { settings: ToolTableSettings; changed: boolean } {
  let changed = false
  const translate = (list: readonly string[]): string[] => {
    const out: string[] = []
    for (const raw of list) {
      const name = LEGACY_TOOL_NAME_MAP[raw] ?? raw
      if (name !== raw) changed = true
      if (out.indexOf(name) < 0) out.push(name)
    }
    return out
  }
  const hidden = translate(settings.hidden)
  const presets = settings.presets.map((p) => {
    const next = translate(p.hidden)
    // 逐字比对，不能只比长度：`skill_manager_create → skill_manager_save` 是**一对一**，
    // 长度不变 —— 拿长度当"有没有变"的判据会把翻译结果整份丢掉（方案里留的还是旧名）。
    const same = next.length === p.hidden.length && next.every((n, i) => n === p.hidden[i])
    return same ? p : { name: p.name, hidden: next }
  })
  return changed ? { settings: { hidden, presets }, changed: true } : { settings, changed: false }
}

/**
 * 新存一份命名方案：**同名不覆盖**（用户 ：「保存方案不能同名」）。"保存"这颗按钮
 * 不该悄悄改掉一份已有的记录 —— 那是破坏性动作，而它连一句确认都没有。撞名时 `exists=true`
 * 且原样返回，由调用方在写盘之前挡下来并如实报错。封顶同样由调用方挡（超了要报错，不是静默丢）。
 */
export function addPreset(settings: ToolTableSettings, name: string, hidden: readonly string[]): { settings: ToolTableSettings; exists: boolean } {
  if (settings.presets.some((p) => p.name === name)) return { settings, exists: true }
  return {
    settings: {
      hidden: settings.hidden,
      presets: settings.presets.concat([{
        name,
        hidden: normalizeNameList(hidden).filter((n) => n !== PROACTIVE_MEMORY_TOOL),
      }]),
    },
    exists: false,
  }
}

/** 删一份方案。名字不认识时 `changed=false` —— 由调用方如实报，不静默成功。 */
export function dropPreset(settings: ToolTableSettings, name: string): { settings: ToolTableSettings; changed: boolean } {
  const presets = settings.presets.filter((p) => p.name !== name)
  if (presets.length === settings.presets.length) return { settings, changed: false }
  return { settings: { hidden: settings.hidden, presets }, changed: true }
}

/** 注册时量到的工具体积（`JSON.stringify(definition).length`，见 index.ts 的 register 包装）。 */
export interface ToolTableRow {
  name: string
  bytes: number
}

/** 工具表里的一条工具：全名、所属族与是否可关。 */
export interface ToolTableTool {
  name: string
  tok: number
  hidden: boolean
  /** 这条在出厂默认名单里（合计那句"其中 ≈X 是出厂默认关掉的"、悬停与「恢复方案」都取它）。 */
  defaultHidden: boolean
}

/** 工具表里的一个族：族名、显示名与成员。 */
export interface ToolTableGroup {
  /** 域 key；与注入域清单（context-inject 的 INJECT_DOMAIN_KEYS）同源。认不出前缀的工具归到 `other`。 */
  key: InjectDomainKey | 'control' | 'other'
  tools: ToolTableTool[]
  /** 该域全部工具的 ≈token 合计（含关掉的）。 */
  tok: number
  /** 其中当前关掉的 ≈token 合计。 */
  hiddenTok: number
}

/** 工具表报告：分组、关停名单与「关掉会失去什么」的提示。 */
export interface ToolTableReport {
  groups: ToolTableGroup[]
  /** 当前会随请求发出的部分。 */
  visibleTok: number
  /** 当前不发的那部分（关对了就是这个数）。**不含**载体让位那一档。 */
  hiddenTok: number
  totalTok: number
  visibleCount: number
  hiddenCount: number
  totalCount: number
  /**
   * 当前关掉的里面有几条是**出厂就关**的（用户没动过它们）。
   *
   * 给「功能总览」用：`hiddenCount - defaultHiddenCount` 才是"用户自己关掉的条数"。
   * 把出厂默认报成异常，等于把插件自己的选择读成用户的故障 —— 与兼容页那条
   * 「琥珀只留给'该投却没投'」的口径冲突。
   */
  defaultHiddenCount: number
  /** 那几条当前省下的 ≈token。 */
  defaultHiddenTok: number
  /**
   * 「有官方等价物 ⇒ 我们让位」而当前**不发**的那部分（`skill_manager_read`）。
   *
   * 为什么单开一档，不并进 `hiddenTok`：那一档的语义是"用户或出厂关掉的"，界面用
   * `hiddenCount - defaultHiddenCount` 反推"用户自己关了几条"。载体让位既不是用户关的、
   * 也不是出厂关的 —— 并进去，兼容页就会报出一个假的"用户关掉了 1 条"。
   * 而**不计入可见**是必须的：那条工具在标准预设下确实不进请求（`index.ts` 的
   * `CARRIER_DUPLICATES`），报成"实发"就是虚报。
   */
  carrierHiddenCount: number
  carrierHiddenTok: number
}

/**
 * 宿主与界面共用的字符/词比（`dsh-token-meter` 的 `CHARS_PER_TOKEN`，其
 * `estimateToolsTokens` = `ceil(JSON.stringify(tools).length / 4) + 4`）。
 *
 * 这是**估算**：宿主自己也这么说（"Actual usage remains authoritative"，真实用量来自
 * API 的 `stream_options.include_usage`）。界面上必须带「≈」。
 */
export const CHARS_PER_TOKEN = 4

/** 按宿主的尺子把字节数估成 token 数（经验值，见文件头；不是 BPE 实测）。 */
export function estimateTok(bytes: number): number {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.ceil(value / CHARS_PER_TOKEN)
}

/**
 * 一句话用途的字符上限（模型看「这条工具能干什么」时用）。
 *
 * 为什么截：整段描述在模型读 schema 时已经在上下文里，重复贴一遍只是把回执撑大；
 * 清单是**按需**调用，一次贴二十条整段描述就是几千字符。
 */
export const TOOL_SUMMARY_MAX = 180

/**
 * 从工具描述里取一句话用途：第一行非空行，截到 {@link TOOL_SUMMARY_MAX}。
 *
 * 各工具描述的组织惯例是「是什么 → 怎么做 → 何时用」，首句就是「是什么」。
 * 空描述返回空串（那一条在清单里就只留名字）。
 */
export function summarizeToolDescription(description: unknown): string {
  const text = String(description ?? '')
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  const trimmed = line.trim()
  return trimmed.length > TOOL_SUMMARY_MAX ? trimmed.slice(0, TOOL_SUMMARY_MAX - 1) + '…' : trimmed
}

/**
 * 逐条改一份关停名单：返回新的名单（不改动入参）。
 *
 * 为什么要有「改一格」而不只有「整份替换」：整份替换要先**读出**当前名单再算差量，
 * 而那次读与后面那次写之间有窗口 —— 两个写者（面板、模型）各拿一份旧名单写回时，
 * 后写的会把先写的覆盖掉（丢更新）。逐条改可以在写锁里现读现改，窗口消失。
 *
 * `hidden: true` = 关掉（进名单），`false` = 打开（出名单）。
 */
export function applyToolTableToggles(
  current: readonly string[],
  toggles: ReadonlyArray<{ name: string; hidden: boolean }>,
): string[] {
  const out = current.slice()
  for (const t of toggles) {
    const i = out.indexOf(t.name)
    if (t.hidden) { if (i < 0) out.push(t.name) } else if (i >= 0) out.splice(i, 1)
  }
  return out
}

/**
 * 纯函数：把注册时量到的体积按域分组，标出哪些被关掉，给出四档合计。
 *
 * 顺序：域按 `INJECT_DOMAIN_KEYS`（界面与注入通道同一顺序），域内按**注册顺序**
 * —— 改顺序等于改显示顺序，不额外定义"重要性"，免得出现第二份排序真相。
 *
 * `carrierHidden` 是"官方载体在场时我们主动让位"的名字（当前只有 `skill_manager_read`）。
 * 它是 **per-agent** 的（取决于那个 agent 的 scope 解析得到解析不到官方 `skill`），而报表是
 * 全局的 —— 所以由调用方给一份口径明确的名单（`tool-table-switch.ts` 传的是"标准预设下会
 * 让位"的保守估计），本函数只负责把它从**可见**里扣掉、单独计一档。
 */
export function buildToolTableReport(
  rows: readonly ToolTableRow[],
  hidden: readonly string[],
  carrierHidden: readonly string[] = [],
): ToolTableReport {
  const off = new Set(hidden.map((name) => String(name)))
  const carried = new Set(carrierHidden.map((name) => String(name)))
  // 「控制」组排在最前：它是**管着这张表的那一条工具**，放在末尾的「其它」组里
  // 等于把它放到离它要控制的东西最远的地方。
  const buckets = new Map<InjectDomainKey | 'control' | 'other', ToolTableTool[]>()
  buckets.set('control', [])
  for (const key of INJECT_DOMAIN_KEYS) buckets.set(key, [])
  for (const row of rows) {
    const name = String(row && row.name ? row.name : '').trim()
    if (name === '') continue
    // 认不出前缀的工具归到 `other` 而不是丢掉：丢掉 = 它在界面上根本不出现，
    // 于是"没登记的域"就永远关不掉，而且没人看得出来（静默降级）。
    const key = name === CONTROL_TOOL_NAME ? 'control' : (domainOfTool(name) ?? 'other')
    let list = buckets.get(key)
    if (list === undefined) { list = []; buckets.set(key, list) }
    list.push({ name, tok: estimateTok(row.bytes), hidden: off.has(name), defaultHidden: DEFAULT_HIDDEN_SET.has(name) })
  }
  const groups: ToolTableGroup[] = []
  let visibleTok = 0
  let hiddenTok = 0
  let visibleCount = 0
  let totalCount = 0
  let defaultHiddenCount = 0
  let defaultHiddenTok = 0
  let carrierHiddenCount = 0
  let carrierHiddenTok = 0
  for (const [key, tools] of buckets) {
    if (!tools.length) continue
    let tok = 0
    let offTok = 0
    for (const tool of tools) {
      tok += tool.tok
      totalCount += 1
      if (tool.hidden) {
        offTok += tool.tok
        if (tool.defaultHidden) { defaultHiddenCount += 1; defaultHiddenTok += tool.tok }
      } else if (carried.has(tool.name)) {
        // 让位那一档：**不发，但不是被谁关掉的** —— 单独计，绝不并进 visible。
        carrierHiddenCount += 1
        carrierHiddenTok += tool.tok
      } else { visibleTok += tool.tok; visibleCount += 1 }
    }
    hiddenTok += offTok
    groups.push({ key, tools, tok, hiddenTok: offTok })
  }
  return {
    groups, visibleTok, hiddenTok, totalTok: visibleTok + hiddenTok + carrierHiddenTok,
    visibleCount, hiddenCount: totalCount - visibleCount - carrierHiddenCount, totalCount,
    defaultHiddenCount, defaultHiddenTok, carrierHiddenCount, carrierHiddenTok,
  }
}
