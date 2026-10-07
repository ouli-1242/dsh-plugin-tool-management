// 注入文本的框架层：每域的面板文案模板，与把一段内容包成 <system-reminder> 帧的渲染。
//
// 从 context-inject.ts 整段搬来，一行未改。写法（md 四级结构、动作句、权威声明句、闭合标记
// 转义）的理由留在 DOMAIN_FRAME 那段注释里；这一层没有状态也不读宿主，纯字符串进出。
import type { InjectDomainKey } from './context-inject-contract.js'
import type { InjectSection } from './context-inject-select.js'

/**
 * 每个域的**框架**：标题 + 加粗的动作句 + 补充动作 + 权威声明。
 *
 * 为什么是这四件（2026-09-18 第四版：用户「注入提示词还是不能很好提醒模型去主动使用」+
 * 「应该通过设计 md 格式突出重点信息」，写法参照 Claude Code 与 Codex CLI 两家官方源码）：
 *
 *   1. **动作句单独一行、加粗**。证据是 Claude Code 书里记的一次 eval
 *      （`claude-code-from-source/book/ch11-memory.md:193`）：同一段正文只换标题，
 *      「Before recommending from memory」（落在决策点上的动作线索）得 3/3，
 *      「Trusting what you recall」（抽象主题）得 0/3 —— 引导语的**形式**（决策点的动作）
 *      比**内容**更决定采纳率。所以标题只当标签用（这条讲的是这台机器的什么），
 *      动作另起一行、加粗，写"在哪个决策点该想起它"。
 *   2. **`##` 标题**：md 里最省字符的结构标记；也给工具描述一个能回指的锚点
 *      （Claude Code 的 AgentTool / SkillTool 描述都写 "listed in <system-reminder>
 *      messages in the conversation"，把目录的位置说给模型）。
 *   3. **补充动作用一行给工具名与触发条件**。两家的目录句都把工具名写死在里面
 *      （Claude Code「available for use with the Skill tool」、官方 skill-catalog
 *      「call the `skill` tool with the exact skill name before taking task actions」）——
 *      模型不会凭"应该有个工具"去猜工具名，但会给它一个明确的调用点。
 *   4. **权威声明单独成句**。原来那句「（取代本次会话中更早的同类内容）」是塞在名词短语里的
 *      括注，容易整句略过；Codex 的对应写法是完整陈述句
 *      （`codex-rs/core/src/context/world_state/agents_md.rs:9`："These AGENTS.md instructions
 *      replace all previously provided AGENTS.md instructions."），官方 skill-catalog 的更新帧
 *      同理（"This complete catalog replaces every earlier available-skills list in this
 *      session"）。这句必须留：注入按"内容变了才重发"工作，重发时旧那份还在上下文里，
 *      模型得知道以哪份为准。
 *
 * 各域的 `how` 只写**正文没说过**的事：一处内容一个出处（记忆与提示词两域因此没有 `how`
 * —— 记忆的授权与判据由正文首行那句加粗的「用户为本机写的参考信息：…」承担）。
 */
export interface DomainFrame {
  /** 标题（md 一级）：这条讲的是这台机器的什么。 */
  title: string
  /**
   * ⚠️ 这里曾经有过一个 `cue` 字段（加粗的"在哪个决策点该想起它"的动作句，2026-09-18 加的），
   * 2026-09-23 六个域**全部删掉**并移除字段本身。原因记在这里，免得被当成"少写了一句"再加回来：
   *
   * 用户看到实际渲染后给的原则是「**上下文注入就是当前的情况，目的是让 agent 知道现在的情况，
   * 不需要它知道没用的信息，反推更是浪费 token**」。那些动作句（"先核对这里" / "先确认服务器
   * 在不在" / "先在这里找" / "先在这里选人设" / "先按它对齐"）本质是**指令**，不是当前情况；
   * 而它们要提醒的事，正文与板块标题已经说了 —— 模型读注入时本来就在读"这台机器现在是什么样"。
   * 六句合计约 105 tok/轮，删掉后六个板块**只剩：标题 / 补充说明（how）/ 权威声明 / 正文**。
   */
  /** 补充动作（工具名 / 触发条件 / 边界）；正文已经说过的不要写。 */
  how?: string | ((toolHidden: (name: string) => boolean) => string | undefined)
  /** 权威声明：「最新一份才是权威」这条得逐域说清取代的是什么。 */
  supersede: string
}

/**
 * 权威声明的统一句（用户 2026-09-23 看到实际注入后要求精简）。
 *
 * 此前五个域各写一份 —— `本份场景取代…同类场景` / `本份记忆取代…同类记忆` /
 * `本份状态…` / `本份目录…` —— 说的是**同一条规则**却用了四种措辞，模型读到四条不同的句子
 * 还得自己判断它们是不是一条。统一成一句：被取代的是"同类内容"，与域无关。
 *
 * 为什么不能并进 `cue`（那能省下整整一行 ≈16 tok/段）：用户 2026-09-18 定过"权威声明单独
 * 成句" —— 它和动作句是两种东西（一句说"什么时候用它"，一句说"以哪份为准"），合并后容易
 * 被一眼带过。所以这里的收益只有约 6 tok/轮，**主要收益是消除四种措辞**，不是省字节。
 */
export const SUPERSEDE_NOTE = '本份取代本次会话中更早注入的同类内容。'

export const DOMAIN_FRAME: Partial<Record<InjectDomainKey, DomainFrame>> = {
  scene: {
    // 场景段只有标题 + 正文 + 权威声明（**没有 cue 是六个域的共同决定**，理由见 `DomainFrame`）。
    //
    // 这一段的演进值得记下来，因为每一次都是被实际注入推着改的：
    //   ① 最早它把「场景说明」当**约定**授权（"一律照办，覆盖你的默认做法"）—— 而它的实例
    //      是「写代码」这种**标签**，让模型"照办一个标签"，这正是它读不懂这段的原因；
    //   ② 去掉授权后换成一句定义（"场景是用户给这台机器配的工作模式"）—— 定义不是动作，
    //      模型读完还是不知道该拿它做什么；
    //   ③ 再加一句因果（"下面四段都已按它筛过"）—— 用户 2026-09-23 看到渲染效果后给了
    //      **原则**：「上下文注入就是当前的情况，目的是让 agent 知道现在的情况，不需要它
    //      知道没用的信息，反推更是浪费 token」。于是三句全删。
    //
    // 现在这一段只回答一个问题：**当前处在哪个场景、它是什么**（`**「代码」—— 写代码**`）。
    // 它还比别的段少一层：因果句也删了 —— 它解释的是"另外四段是怎么产生的"（机制），
    // 不是当前情况本身，而且"清单里没有 ≠ 本机没有"这层反推被用户明确判为浪费。
    title: '本机当前的场景',
    supersede: SUPERSEDE_NOTE,
  },
  memory: {
    title: '本机当前的记忆',
    supersede: SUPERSEDE_NOTE,
  },
  mcp: {
    title: '本机 MCP 服务器的当前状态',
    // how 只剩"怎么用备注"这半句：前半个分句「工具名是 `mcp__<服务器>__<工具>`」删掉了
    // —— 模型自己的工具表里就是这个命名（`mcp__context7__xxx`），告诉它格式是零信息量。
    how: '带「用户提示：」的行是用户写给这台服务器的决策提示，选服务器之前先看一眼。',
    supersede: SUPERSEDE_NOTE,
  },
  skills: {
    title: '本机技能目录',
    // 两句都只在预设没挂官方 `skill` 工具时出现，差别只在点名不点名那个取正文的工具
    // （工具被用户在兼容页关掉时不点名 —— 点名一个模型手里没有的工具只会让它去猜名字）。
    how: (toolHidden) => toolHidden('skill_manager_read')
      ? '本预设没有官方 `skill` 工具：目录只有摘要，读完再照做。'
      : '本预设没有官方 `skill` 工具：要正文用 `skill_manager_read`（按名字直接给正文与路径）；目录只有摘要，读完再照做。',
    supersede: `${SUPERSEDE_NOTE.slice(0, -1)}；只列当前可调用的技能。`,
  },
  subagents: {
    title: '可委派的子智能体',
    // 分界规则（2026-09-17 方案 C，本机实测 session-ee722e23 逼出来的）：官方那两个
    // 委派工具（`subagent` / `subagent_fork`）不带人设，而此前没有任何一句话说明何时该
    // 用谁 —— 模型在"审查刚读过的 README"时选了 `subagent_fork`（fork 能继承已读内容、
    // 省一次复述）。现在人设通道也有 `inherit`（同一套 fork 机制），分界只剩"要不要后台跑"。
    // 带人设的委派工具被关掉时改说"本会话没有这条通道"：不说的话，模型看到有人设目录却
    // 找不到对应的工具，会去拿官方那两个凑（它们不接受人设，等于白跑一趟）。
    how: (toolHidden) => toolHidden('subagent_manager_run')
      ? '本会话没有带人设的委派工具；官方 `subagent` / `subagent_fork` 不带人设，只在没有人设贴合、或要后台跑时用。'
      : '贴合人设的任务一律用 `subagent_manager_run`（要它看到本次会话就开 `inherit`）；官方 `subagent` / `subagent_fork` 不带人设，只在没有人设贴合、或要后台跑时用。',
    supersede: SUPERSEDE_NOTE,
  },
  prompt: {
    title: '本机提示词',
    supersede: SUPERSEDE_NOTE,
  },
}

/**
 * `how` 行里**点名过的工具**（六个域里只有 skills / subagents 两个会点名）。
 *
 * 为什么要有这份名单：一条 `how` 行是否成立，取决于它点名的工具在**这个 agent 手里**还在不在。
 * 名单放在这里而不是调用方 —— 与上面那两条 `how` 相邻，改一处不会漏另一处。
 *
 * "不在手里"有两条路，都要算：
 *   ① 兼容页「模型工具表」把它关掉（用户全局开关，名单在 index.ts 的 `hiddenTools` 里）；
 *   ② **人设的工具限制**把它砍掉（`decideToolFilter` → 官方 `tools.restrict`，只作用于那份
 *      人设启动的子代理）。②此前没人管：目录照注、`how` 行照样点名一个模型手里没有的工具，
 *      等于诱导它去调一个不存在的名字（2026-10-07 修）。
 */
export const HOW_NAMED_TOOLS: readonly string[] = ['skill_manager_read', 'subagent_manager_run']

/** 域声明里没登记的 key（理论上到不了这里）：给一个不出错的通用框架。 */
export const fallbackFrame = (label: string): DomainFrame => ({
  title: `本机的${label}`,
  supersede: SUPERSEDE_NOTE,
})

export const domainFrame = (key: InjectDomainKey, label: string): DomainFrame => DOMAIN_FRAME[key] ?? fallbackFrame(label)

/**
 * 框架的伪 XML 标记。与官方两条注入行同款：`dsh-tool-skill` 与 `dsh-agent-instructions`
 * 都把**整条正文**包在里面（不是只包引导语）。Claude Code 那边把这对标记叫"可依赖的
 * 判别符"（`messages.ts:1797` 的 `ensureSystemReminderWrap` 保证任何注入文本都不落在外面）：
 * 模型据此把这段读成系统给的上下文，而不是用户刚打的字 —— 本插件的正文里混着用户写的
 * 自由文本（AGENTS.md / 记忆 / 备注），这层来源标记尤其不能少。
 */
export const FRAME_OPEN = '<system-reminder>'
export const FRAME_CLOSE = '</system-reminder>'

/**
 * 正文里的 `</system-reminder>` 拆掉闭合形态（写成 `<\/system-reminder>`）。
 *
 * 正文含用户自由文本（AGENTS.md、记忆、MCP 备注、技能描述），一句手写的闭合标记就能让框架
 * 提前结束，其后的内容读起来像用户当场说的话。照抄官方 `escapeInstructionFrameBody` 的实现
 * （`dsh-agent-instructions/lib/index.js:128`，同样是替换成带反斜杠的形态 —— 模型看到的
 * 字面量不变，标记不再闭合）。
 */
export function escapeFrameBody(body: string): string {
  return body.replaceAll(FRAME_CLOSE, '<\\/system-reminder>')
}

/**
 * 一条注入消息的正文（纯函数）：`<system-reminder>` 里 = 框架（标题 + 动作 + 补充 + 权威
 * 声明）+ 空行 + 域正文。**所有域一律带框架**，没有例外。
 *
 * 历史（每一版都是被具体毛病逼出来的，别把结论当套话读）：
 *   - 第一版（2026-09-17 前）：五域共用「以下是本机插件的X（取代…）。」——「本机插件」是实现
 *     细节；通篇没有动作；五条消息句式一模一样，雷同的套话退化成背景噪声。
 *   - 第二版（2026-09-17）：动作前置（`**{线索}**：以下是{域}（取代…）。{补充}`），但只改了
 *     用户圈定的两域（记忆 / 子智能体），MCP、技能、提示词继续走老模板。
 *   - 第三版（2026-09-17）：instructions 形态不再裸送 —— 此前"原样送"的理由是"对齐官方
 *     AGENTS.md 那条行"，与官方实际行为不符（官方那条是包 `<system-reminder>` 的，含一句
 *     "这些工作区指令可作参考……"。真正的问题在极简类预设：官方通道被压掉后本插件是唯一
 *     承载者，裸文本没有任何标记，而提示词会因场景切换而变化、新旧两份效力相同、没有判据。
 *     只借官方**包框架**的形式，**不抄**它那句把用户规则降成"仅供参考"的措辞。
 *   - 第四版（2026-09-18，本条）：**动作仍然不够显眼**（用户：「还是不能很好提醒模型去主动
 *     使用」），且整条消息该按 md 排版突出关键信息。改成四级结构：`##` 标题当标签、
 *     加粗动作句单独一行、补充动作给工具名、权威声明单独成句（逐条理由见 `DOMAIN_FRAME`）。
 *     同时把**正文也包进标记里**（此前只有引导语在标记内、正文裸奔）—— 官方两条注入行都是
 *     整条包住的，正文里的用户自由文本更需要这层来源标记。
 */
export function renderDomainText(section: InjectSection, toolHidden: (name: string) => boolean = () => false): string {
  const frame = domainFrame(section.key, section.label)
  // 层级（2026-09-23 用户看到实际注入后指出「记忆内的场景怎么都是 ## 标题」）：**`#` 一级给板块**
  // （场景 / 记忆 / MCP / 技能 / 子智能体 / 提示词），域正文里的 `##` 才是它的下一层
  // （记忆段的 `## 场景：X`、超预算时的 `## 未注入的参考信息`）。此前标题也是 `##`，两者平级，
  // 模型读不出主次 —— 而"哪些内容归在哪个板块/场景下"正是它做判断时要用的结构。
  //
  // 开标签后**必须空一行**：markdown 里 `#` 紧跟在一行文字后面只是**段落续行**，不会被渲染成
  // 标题 —— 用户截图里 `## 本机当前的场景` 就是这么被吞掉的（和 `<system-reminder>` 挤成一段）。
  // 收尾同理：正文末尾先归一成单个空行，免得 `</system-reminder>` 粘在最后一行上。
  // 结构：标题 → 补充说明（有才发）→ 权威声明 → 正文。没有 cue 那一行（见 `DomainFrame` 的注释）。
  const lines = [FRAME_OPEN, '', `# ${frame.title}`]
  const how = typeof frame.how === 'function' ? frame.how(toolHidden) : frame.how
  if (how !== undefined) lines.push(how)
  lines.push(frame.supersede, '', escapeFrameBody(section.text).replace(/\n+$/, ''), '', FRAME_CLOSE)
  return lines.join('\n')
}

/** 「已清空」通知正文：某个域曾经注入过、现在没有内容时发一条（纯函数，测试用）。 */
export function clearedDomainText(key: InjectDomainKey, label: string): string {
  const frame = domainFrame(key, label)
  // 形状与 `renderDomainText` 一致（开标签后空行、板块 `#`、收尾空行）—— 这两条都是同一个
  // 通道发出去的消息，层级与留白不该有两套。
  return [
    FRAME_OPEN,
    '',
    `# ${frame.title}`,
    '**已清空** —— 本次会话中此前注入的同类内容不再有效。',
    '',
    FRAME_CLOSE,
  ].join('\n')
}
