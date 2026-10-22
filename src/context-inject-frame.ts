// 注入文本的框架层：每域的面板文案模板，与把一段内容包成 <system-reminder> 帧的渲染。
//
// 从 context-inject.ts 整段搬来，一行未改。写法（md 四级结构、动作句、权威声明句、闭合标记
// 转义）的理由留在 DOMAIN_FRAME 那段注释里；这一层没有状态也不读宿主，纯字符串进出。
import type { InjectDomainKey } from './context-inject-contract.js'
import type { InjectSection } from './context-inject-select.js'

/**
 * 每个域的**框架**：标题 + 加粗的动作句 + 补充动作 + 权威声明。
 *
 * 为什么是这四件（用户「注入提示词还是不能很好提醒模型去主动使用」+
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
 *   4. **权威声明单独成句**。不能写成塞在名词短语里的括注（「（取代本次会话中更早的同类
 *      内容）」那种），括注容易被整句略过；Codex 的对应写法是完整陈述句
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
  /**
   * 标题（md 一级）：这条讲的是**此刻生效的哪一类东西**。
   *
   * （`本机当前的场景` / `本机技能目录` / `可委派的子智能体`）。用「当前」而不是「本机」，
   * 是因为这六个域列的**都不是"这台机器上有什么"，而是"此刻生效的是哪一份/哪一批"** ——
   * 场景与提示词是单选，记忆按当前场景筛，MCP / 技能 / 人设各自按可用性与深度筛过。
   * 「本机」暗示全量（列表里没有 ≠ 本机没有），恰恰是这一族一直在防的谎报；
   * 「当前」与正文口径也对得上（记忆授权语写「当前场景对应的记忆」、技能 `how` 行写
   * 「只列当前可调用的技能」）。
   *
   * `Current MCP servers` / `Current skills` / `Current subagents` / `Current prompt`）。
   *
   * ⚠️ 改这六个字串时**必须连带改点名它们的工具描述**（`tools/*.ts` 与 `subagents/tools.ts`
   * 里 `"…" reminder` 那几处，模型侧可见）与注释 —— 否则描述会指向一个不存在的块名。
   * `test/contracts.test.mjs` 有一条扫描钉着这件事。
   */
  title: string
  /**
   * 补充动作（工具名 / 触发条件 / 边界）；正文已经说过的不要写。
   *
   * ⚠️ **不要**在这里写"在哪个决策点该想起它"的动作句（"先核对这里" / "先确认服务器在不在" /
   * "先在这里找" / "先在这里选人设" / "先按它对齐"）。用户看到实际渲染后给的原则是
   * 「**上下文注入就是当前的情况，目的是让 agent 知道现在的情况，不需要它知道没用的信息，
   * 反推更是浪费 token**」—— 动作句本质是**指令**，不是当前情况；而它们要提醒的事，正文与
   * 板块标题已经说了。六句动作句合计约 105 tok/轮，去掉后每个板块只剩：标题 / 补充说明 /
   * 权威声明 / 正文。
   */
  how?: string | ((info: FrameRenderInfo) => string | undefined)
  /** 权威声明：「最新一份才是权威」这条得逐域说清取代的是什么。 */
  supersede: string
  /**
   * 与本份内容同生共死的**边界陈述**（不含"取代"语义），与 `supersede` 分开两件事。
   *
   * 为什么拆：把两句拼在 `supersede` 里（`Supersedes … Only currently callable skills are
   * listed.`）会让两个成立条件不同的事实同生同灭 ——
   * 「取代了旧的那份」只在**替换**时成立，「只列了能用的」在这块一出现时就成立。拼在一起
   * 只能同生同灭：首个块没有旧内容可取代（说了是废话），却连边界也一起丢了（那是防幻觉的）。
   * 分开之后：`supersede` 只在 `replacing` 时发，`boundary` 每次都发。
   */
  boundary?: string
}

/** `how` 求值时能看到的渲染上下文（由"只传 toolHidden"扩成对象）。 */
export interface FrameRenderInfo {
  /** 这个 agent 手里有没有某条工具（兼容页开关 + 人设工具限制，见 `HOW_NAMED_TOOLS`）。 */
  toolHidden: (name: string) => boolean
  /**
   * 本域正文（未转义的原文）。收它不是为了让 `how` 复述正文，而是为了让**解释只在被解释的
   * 东西真的出现时**才发 —— MCP 段是最典型的例子：没有备注、也没有离线的服务器时，那句
   * `user hint:` 说明与 `not connected now` 读法都在解释不存在的东西，纯属每轮白付。
   */
  text: string
  /** 这次是**替换**同一域的旧消息（`true`）还是该域在本会话的**第一份**（`false`）。 */
  replacing: boolean
}

/**
 * 权威声明的统一句（用户 看到实际注入后要求精简）。
 *
 * 此前五个域各写一份 —— `本份场景取代…同类场景` / `本份记忆取代…同类记忆` /
 * `本份状态…` / `本份目录…` —— 说的是**同一条规则**却用了四种措辞，模型读到四条不同的句子
 * 还得自己判断它们是不是一条。统一成一句：被取代的是"同类内容"，与域无关。
 *
 * 为什么不能并进 `cue`（那能省下整整一行 ≈16 tok/段）：用户 定过"权威声明单独
 * 成句" —— 它和动作句是两种东西（一句说"什么时候用它"，一句说"以哪份为准"），合并后容易
 * 被一眼带过。所以这里的收益只有约 6 tok/轮，**主要收益是消除四种措辞**，不是省字节。
 *
 * 截断 / 未列出这些提示。**用户自己写的内容一律原样注入**（场景名与说明、记忆正文、MCP
 * 备注、技能与人设的描述、`AGENTS.md` 正文、路径），一个字符都不动。理由：官方两条注入行
 * （`Instructions from:` 与 skill catalog）本来就是英文，混着中文只让模型多付一次对齐成本。
 *
 * 同日晚些时候二次收紧（用户：「让 agent 更能注意到信息，信息高效，也不要冗余」）：这一代
 * 每个句子都按「少一个词不改行为就删」过了一遍 —— 权威声明去掉自我指涉与场合限定
 * （`This replaces … in this session` → `Supersedes … of the same kind`），六个 `how` 行
 * 去掉「This preset has no …」这类铺垫、改成先说要做什么。**没有新增任何一行**：
 * 那条原则（注入只讲当前情况、不写解释与动作句）仍然生效，加字只会稀释指令。
 */
export const SUPERSEDE_NOTE = 'Supersedes earlier injected content of the same kind.'

/**
 * 框架文案的**版本号**：`DOMAIN_FRAME` 里任何一句（`title` / `how` / `boundary`）改了，这里 +1。
 *
 * 为什么要它：去重只比**域正文**（见 `RenderedDomain`），框架改了不会重发 —— 于是升级插件后，
 * 已存在的会话永远拿不到新文案，而 `how` 正是"这份内容该在哪个决策点被想起"的唯一载体。
 * 带上版本号，改文案的那一版会让每域各重发一次（一次性代价，下一版起恢复"内容不变就不发"）。
 *
 * 为什么不把 `how` 的取值本身并进键：函数型 `how` 取决于**这个 agent 手里有没有某条工具**
 * （`hiddenTools`），而工具注册在热重载 / 启动间隙会瞬时为空 —— 并进键会先注入一句
 * "你手里没有这个工具"（假话），下一步再撤回。静态字符串型 `how` 已经自动进键（见 `frameKeyOf`）。
 */
export const FRAME_REVISION = 1

/**
 * 框架指纹：决定"该域消息的框架是不是这一版"。
 *
 * 只收**静态**部分：`title`、字符串型 `how`、`boundary`。刻意**不收** `supersede` ——
 * 它只在替换时发，收进来会让"首帧 → 第二帧"这一差异被当成内容变化，每域多付一条消息
 * （那正是去重只比正文的原因）。函数型 `how` 也不收，由 `FRAME_REVISION` 兜住。
 */
export function frameKeyOf(frame: DomainFrame): string {
  return [
    String(FRAME_REVISION),
    frame.title,
    typeof frame.how === 'string' ? frame.how : '',
    frame.boundary ?? '',
  ].join('\u0000')
}

/** 各域的框架文案（标题、引导语、`how` 行）；缺项时走 `fallbackFrame`。 */
export const DOMAIN_FRAME: Partial<Record<InjectDomainKey, DomainFrame>> = {
  scene: {
    // 场景段此前只有标题 + 正文 + 权威声明（没有 cue 是六个域的共同决定，理由见 `DomainFrame`）；
    //
    // 这一段的演进值得记下来，因为每一次都是被实际注入推着改的：
    //   ① 最早它把「场景说明」当**约定**授权（"一律照办，覆盖你的默认做法"）—— 而它的实例
    //      是「写代码」这种**标签**，让模型"照办一个标签"，这正是它读不懂这段的原因；
    //   ② 去掉授权后换成一句定义（"场景是用户给这台机器配的工作模式"）—— 定义不是动作，
    //      模型读完还是不知道该拿它做什么；
    //   ③ 再加一句因果（"下面四段都已按它筛过"）—— 用户 看到渲染效果后给了
    //      **原则**：「上下文注入就是当前的情况，目的是让 agent 知道现在的情况，不需要它
    //      知道没用的信息，反推更是浪费 token」。于是三句全删。
    //
    // 现在这一段只回答一个问题：**当前处在哪个场景、它是什么**（`**「代码」—— 写代码**`）。
    //
    // 定义**加回来，但只加一句**，且换掉当时失败的那个写法。
    //   - 当时失败的是"场景是用户给这台机器配的工作模式"——**只说是什么，不说它带来了什么**，
    //     模型读完仍无动作可做。这里补上后果：记忆 / 工具 / 人设都已经按它筛过。
    //     这一句**不含提示词**：全局提示词只有一份（`~/.dsh/AGENTS.md` 这条基线），
    //     在哪个对话里进场景都不换它 —— 说了"提示词也按它筛过"就是假话，而官方那条
    //     AGENTS.md 本来就在上下文里（换预设要到全局层去换）。
    //   - 与①的区别（那条授权语不能回来）：这里不授权"照办"，只说"你拿到的这些东西为什么长这样"。
    //     用户自己写的说明仍然只是注解，不是约定。
    //   - 为什么这句能过"不写机制"那条原则：它解释的不是宿主怎么算的，而是**模型眼前这份上下文
    //     为什么缺了几样**（`## Scene: 编程` 分组、看不到别的场景的记忆、工具比别处少）。
    //     这是它做判断时要用的事实，不是反推。
    //   - 代价 ≈24 tok/轮，只在这一域。
    title: 'Current scene',
    how: "A scene is the user's working mode: the memories, tools and personas you are given are already filtered to it.",
    supersede: SUPERSEDE_NOTE,
  },
  memory: {
    title: 'Current memories',
    // 但没给出口——被截掉的条目连名字都没列出来，模型既调不了 `memory_manager_read`（不知道
    // 传什么名字），也不知道该用 `memory_manager_list` 去发现。另外三个域的溢出行都点名了
    // 自己的 list 工具，唯独记忆段没有。
    //
    // 修法选了「frame `how` 条件点名」而不是「把 listToolVisible 管道接到记忆服务」：记忆 SWR
    // 缓存是指纹驱动的（缓存渲染结果，不是缓存数据按 agent 重渲染），重构成技能目录那种方式
    // 要动 4–5 个文件。而 `how` 已经能看 `{ text }`——MCP 就是这么按正文内容决定发不发的。
    // `text.includes('more not listed')` 只在折叠行出现时命中（rest > 0）；rest = 0（清单列全）
    // 时折叠行不出现，how 不发——那些条目有名字，模型调 `memory_manager_read` 就行。
    // 工具被关掉（兼容页 / 人设 toolsDeny）时不点名——与另外三域同一纪律。
    how: ({ text, toolHidden }) => {
      // 折叠行 `more not listed` 和截断标记 `(Truncated:` 两种信号都要覆盖：
      //   - 折叠行 = 清单部分列了 + 剩余没列 → 没名的那些需要 list 工具发现
      //   - 标记 = 连清单都没放进来 → 全部没名，更需要 list 工具
      //   - 清单列全（`## Not injected` + 所有名字，rest = 0）→ 两种信号都没有 → 不发 how：
      //     模型用 `memory_manager_read` 按名字读就行
      if (!text.includes('more not listed') && !text.includes('(Truncated:')) return undefined
      if (toolHidden('memory_manager_list')) return undefined
      return 'Not all memories fit here — see the rest with `memory_manager_list`.'
    },
    supersede: SUPERSEDE_NOTE,
  },
  mcp: {
    title: 'Current MCP servers',
    // how 只剩"怎么用备注"这半句：前半个分句「工具名是 `mcp__<服务器>__<工具>`」删掉了
    // —— 模型自己的工具表里就是这个命名（`mcp__context7__xxx`），告诉它格式是零信息量。
    //
    //   ① **什么时候想起这张表** —— 模型看不到 server 的连线状态，缺工具时它只会两种反应：
    //      说"没有这个工具"，或反复重试。这一域存在的意义就是给它第三种（表里有、只是没连上）。
    //   ② `not connected now` 那一档的读法 —— 不写清"此刻没有注册任何工具"，这一行会被读成
    //      "可用但状态存疑"，于是它照旧去调一个必然失败的工具名。
    //
    // 两句都**按需发**（用户：「mcp 如果用户没写备注不是白写了吗」）。写成常量串时，
    // "一台上线服务器、没有备注"这种最常见的情形里整段 = 三行说明解释一个不存在的东西 +
    // 一行 `- **github**` —— 说明比内容长，而且每轮都付。现在备注句只在真有备注时发，
    // 两者都没有就**不发行**（`undefined`）：正文只有名字时，标题加名字已经把话说完了。
    //
    // （「没连接的 mcp 注入上下文是垃圾信息，只有真启动的才需要注入」）。
    // 于是"缺工具"的三种反应里少了"表里有、只是没连上"那一种：模型看不到掉线的 server，
    // 也就无从提示"它在重连 / 检查网络"。这是该要求的直接代价，与 state-section.ts 文件头
    // 记的是同一件事。剩下的 `no tools enabled here` 是 server **此刻在跑**、只是工具被关掉，
    // 那句话仍然防着"别把它报成缺失"。
    how: ({ text }) => {
      const parts: string[] = []
      if (text.includes('user hint: ')) {
        parts.push("`user hint:` marks the user's own note on that server — read it before choosing one.")
      }
      if (text.includes('(no tools enabled here)')) {
        parts.push('A server marked `no tools enabled here` is up, but every one of its tools is switched off — do not report it as missing.')
      }
      return parts.length > 0 ? parts.join(' ') : undefined
    },
    supersede: SUPERSEDE_NOTE,
  },
  skills: {
    title: 'Current skills',
    // 两句都只在预设没挂官方 `skill` 工具时出现，差别只在点名不点名那个取正文的工具
    // （工具被用户在兼容页关掉时不点名 —— 点名一个模型手里没有的工具只会让它去猜名字）。
    //
    // 两句都要有：**怎么想起它**（"任务对得上就去读"）与**读完再用**（已经决定用之后的
    // 纪律）。官方那条行两者都有（`if … the task clearly matches … call the skill tool …
    // before taking task actions`），而这一域恰恰只在官方那条行**缺席**时才注入 —— 模型手上
    // 既没有 `skill` 工具、也没人告诉过它技能的调用时机，缺的正是这一句。同理补上"描述不是
    // 指令"（官方对应句 `do not infer or follow a skill's instructions until it has been
    // loaded`），免得它拿 500 字摘要当正文照做。
    // 不点名工具那一支**不能**说"read a skill's body before following it" —— 那是让模型去读
    // 一份它根本读不到的东西。
    //
    // 首句定义：官方那条行以 `A skill is a reusable set of
    // task-specific instructions.` 开头 —— 这句不是背景介绍，是后面两半句的**前提**：不懂"skill
    // 是按需加载的任务指令集"时，"任务对得上就读正文"读不出任何动作，只会被理解成"一个名字 +
    // 一句简介"。所以这里破例把定义放在动作句之前（正常纪律是先说要做什么，见 `SUPERSEDE_NOTE`
    // 那段注释）；措辞照抄官方，模型对它有现成先验。**只在官方载体缺席时发**（本域的唯一条件），
    // 官方在时整段不注入，不存在两份定义。
    // 措辞只说"手里没有读本体的工具"，不猜官方那条有没有 —— 官方 `skill` 工具在场时，
    // 本插件正是为了让模型不拿到两条装载入口而把 `skill_manager_read` 让位藏掉
    // （`CARRIER_DUPLICATES`），此时说"模型没有装载入口"就是假话。
    how: ({ toolHidden }) => toolHidden('skill_manager_read')
      ? 'A skill is a reusable set of task-specific instructions. No skill reader is in your hands here: names and summaries only — treat them as a capability list, not as instructions.'
      : 'A skill is a reusable set of task-specific instructions. No official `skill` tool here: when a task clearly matches one or the user names one, read its body with `skill_manager_read` before acting. Summaries only — never treat a description as instructions.',
    // 英文下不能再靠 `slice(0, -1)` 拼句（那会把句末句点削掉，接出
    // `…in this session Only skills…`）：整句照发，续句自带首字母大写。
    // 边界陈述用 `enabled` 而不是 `callable`：取正文的工具被关掉时**一条都调不到**，
    // 说 "callable" 在那个分支里就是假话。`enabled` 两支都成立（它们确实都是"启用中"的），
    // 也不再依赖工具在不在手里。
    supersede: SUPERSEDE_NOTE,
    boundary: 'Only enabled skills are listed.',
  },
  subagents: {
    title: 'Current subagents',
    // 分界规则（实测中模型的选择逼出来的）：官方那两个
    // 委派工具（`subagent` / `subagent_fork`）不带人设，而此前没有任何一句话说明何时该
    // 用谁 —— 模型在"审查刚读过的 README"时选了 `subagent_fork`（fork 能继承已读内容、
    // 省一次复述）。现在人设通道也有 `inherit`（同一套 fork 机制），分界只剩"要不要后台跑"。
    // 带人设的委派工具被关掉时改说"本会话没有这条通道"：不说的话，模型看到有人设目录却
    // 找不到对应的工具，会去拿官方那两个凑（它们不接受人设，等于白跑一趟）。
    //
    // `inherit` 那半句 删掉了：它在 `subagent_manager_run` 的
    // Modes 段与 `inherit` 参数说明里**各有一份**，三份都在每轮上下文里 = 同一件事付三次
    // token。留这两份（它们就在"要传这个参数"的那一刻），这里只留 how 行独有的那半句 ——
    // 与官方两个委派工具的分界规则。
    // 没说"什么算带人设的活"（要不要委派）。**例子刻意不写**——`subagent_manager_run` 的描述里
    // 已经有 "a review, an investigation, a piece of writing 且细节不必占自己的上下文"，两句写在同一份
    // 上下文里就是同一件事付两次。
    // 不点名那一支要补"只能参考、调不到"：只说"官方那两个不带人设"不够 ——
    // "目录里有人设 ≠ 能委派"这层没人说，模型会拿官方工具硬塞一个人设名进去。
    how: ({ toolHidden }) => toolHidden('subagent_manager_run')
      ? 'No persona-carrying delegation tool here; official `subagent` / `subagent_fork` carry no persona — use them only when none fits or for background work. The personas listed here are reference only, not callable.'
      : 'Persona work goes through `subagent_manager_run` — when a task matches one of these personas, delegate it there. Official `subagent` / `subagent_fork` carry no persona; use them only when none fits or for background work.',
    supersede: SUPERSEDE_NOTE,
  },
  prompt: {
    title: 'Current prompt',
    // 说明**这些规则是要遵循的**。记忆域有授权语、场景域有定义，唯独效力最强的这一域空着 ——
    // 而官方那条行给的是**降权**措辞（"可作参考"），我们当初刻意没抄，于是等于什么都没说。
    // 现在补一句正面的：要遵循，且用户当场说的优先。
    // 措辞用 "right now" 不用 "for this machine"：场景预设接管时，正文是
    // 场景绑定的那份 AGENTS.md，不是机器全局的 —— "for this machine" 在那个态下是假话。
    // "right now" 同时覆盖全局 AGENTS.md 与场景预设两种来源，由正文首行 `Instructions from:`
    // 给出具体出处。
    how: 'These are the instructions in force right now; follow them unless the user says otherwise in this conversation.',
    supersede: SUPERSEDE_NOTE,
  },
}

/**
 * `how` 行里**点名过的工具**（skills / subagents / memory 三个域会点名）。
 *
 * 为什么要有这份名单：一条 `how` 行是否成立，取决于它点名的工具在**这个 agent 手里**还在不在。
 * 名单放在这里而不是调用方 —— 与上面那几条 `how` 相邻，改一处不会漏另一处。
 *
 * "不在手里"有两条路，都要算：
 *   ① 兼容页「模型工具表」把它关掉（用户全局开关，名单在 index.ts 的 `hiddenTools` 里）；
 *   ② **人设的工具限制**把它砍掉（`decideToolFilter` → 官方 `tools.restrict`，只作用于那份
 *      人设启动的子代理）。②此前没人管：目录照注、`how` 行照样点名一个模型手里没有的工具，
 *      等于诱导它去调一个不存在的名字。
 *
 * `memory_manager_list` 加入：记忆段截断折叠行不点名查询工具时，
 * 被截掉的条目无名、模型无法发现它们。`how` 在折叠行出现时点名它，与技能 / 子智能体 /
 * MCP 三个域的溢出行同构。
 */
export const HOW_NAMED_TOOLS: readonly string[] = ['skill_manager_read', 'subagent_manager_run', 'memory_manager_list']

/** 域声明里没登记的 key（理论上到不了这里）：给一个不出错的通用框架。 */
export const fallbackFrame = (label: string): DomainFrame => ({
  title: `Current ${label}`,
  supersede: SUPERSEDE_NOTE,
})

/** 取某域的框架；没登记过的域按 `label` 现造一个，绝不给 `undefined`。 */
export const domainFrame = (key: InjectDomainKey, label: string): DomainFrame => DOMAIN_FRAME[key] ?? fallbackFrame(label)

/**
 * 框架的伪 XML 标记。与官方两条注入行同款：`dsh-tool-skill` 与 `dsh-agent-instructions`
 * 都把**整条正文**包在里面（不是只包引导语）。Claude Code 那边把这对标记叫"可依赖的
 * 判别符"（`messages.ts:1797` 的 `ensureSystemReminderWrap` 保证任何注入文本都不落在外面）：
 * 模型据此把这段读成系统给的上下文，而不是用户刚打的字 —— 本插件的正文里混着用户写的
 * 自由文本（AGENTS.md / 记忆 / 备注），这层来源标记尤其不能少。
 */
export const FRAME_OPEN = '<system-reminder>'
/** 注入块的收尾标记，与开头的 `<system-reminder>` 成对 —— 官方那两条注入行同形。 */
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
 * `renderDomainText` 的产出：整条消息正文 + **域正文原文**。
 *
 * 为什么要多给一个 `body`：调用方要比对"内容变没变"来决定发不发，而框架里
 * 有两行**按场合**发（`supersede` 只在替换时发，`how` / `boundary` 按正文内容按需发）——
 * 于是同一条域正文有两种合法形态。比整条正文会把首帧那一差异判成"内容变了"，每个域在第二步
 * 多重发一次（用户实测：场景 / 记忆 / MCP / 子智能体每轮都重发）。比 `body` 则两种形态都判为
 * 没变。`body` 与 `section.text` 逐字节相同（只差 `escapeFrameBody` 的闭合标记转义），
 * 调用方直接与 `section.text` 比即可。
 */
export interface RenderedDomain {
  /** 整条消息正文（含 `<system-reminder>` 框架）—— 这就是发给模型的内容。 */
  text: string
  /** 域正文原文（框架剥掉后的那一部分）—— 只用于"发不发"的比对。 */
  body: string
  /**
   * 框架指纹（见 `frameKeyOf`）。与 `body` **一起**构成"发不发"的判据：
   * 正文没变但框架变了（插件升级 / 改了 `how` 的静态部分）也要重发一次。
   */
  frameKey: string
}

/**
 * 「设置作用域」那一行：把**当前隔离粒度**说给模型听。
 *
 * 为什么需要它：工具 schema 是静态的，`scope` 参数的说明只能把三档并列写一遍
 * （"this conversation; its whole workspace under workspace isolation; machine-wide once
 * isolation is off"）—— 于是模型读完仍不知道自己处在哪一档，用户问「这个开关影响谁」
 * 时只能把那句并列再念一遍。这一行把三选一收成一档（≈7–13 tok/轮，只挂一条消息）。
 *
 * 为什么是**状态**而不是指令：它说的是"此刻设置写在哪一层"，正是注入通道该讲的东西；
 * 动作（"改会话就传 scope=session"）已经在工具参数里，这里不重复。
 *
 * `undefined` = 粒度读不到：整句不发，宁可少一句，也不发一句猜的。
 */
export function scopeLineOf(mode: 'global' | 'session' | 'workspace' | undefined): string | undefined {
  if (mode === 'session') return 'Settings scope: this conversation only.'
  if (mode === 'workspace') return 'Settings scope: shared by every conversation in this workspace.'
  if (mode === 'global') return 'Settings scope: machine-wide, shared by every conversation (isolation off).'
  return undefined
}

/**
 * 把一段域内容包成一条 `<system-reminder>` 消息。**所有域一律带框架**，没有例外。
 *
 * 结构：`#` 标题 → 作用域行（只有承载它的那一条有）→ 补充说明（有才发）→ 权威声明
 * （只在替换时）→ 边界陈述（有才发）→ 正文。
 * 每一层为什么存在见 `DOMAIN_FRAME`；标题用一级、正文用二级的理由见函数体内的注释。
 *
 * @param section 选出来的一段域内容
 * @param toolHidden 某个工具在这个 agent 手里是否不可见（决定 `how` 点不点名工具）
 * @param replacing 这是替换同一域的旧消息，还是该域在本会话的第一份
 * @param scopeLine 当前隔离粒度那一行；只有调用方选定的**一条**消息带它（见 `scopeLineOf`）
 * @returns 整条消息正文，外加未加框架的域正文（只用于"发不发"的比对）
 */
export function renderDomainText(
  section: InjectSection,
  toolHidden: (name: string) => boolean = () => false,
  replacing: boolean = true,
  scopeLine?: string,
): RenderedDomain {
  const frame = domainFrame(section.key, section.label)
  // 粒度进了指纹：切档之后这一条必须重发，否则模型手里那句永远是旧档 ——
  // 正文一个字没变，只有这一行变，`body` 比对抓不到它。
  const frameKey = frameKeyOf(frame) + (scopeLine === undefined ? '' : '\u0001' + scopeLine)
  // 层级（用户看到实际注入后指出「记忆内的场景怎么都是 ## 标题」）：**`#` 一级给板块**
  // （场景 / 记忆 / MCP / 技能 / 子智能体 / 提示词），域正文里的 `##` 才是它的下一层
  // （记忆段的 `## Scene: X`、超预算时的 `## Not injected (…)`）。此前标题也是 `##`，两者平级，
  // 模型读不出主次 —— 而"哪些内容归在哪个板块/场景下"正是它做判断时要用的结构。
  //
  // 开标签后**必须空一行**：markdown 里 `#` 紧跟在一行文字后面只是**段落续行**，不会被渲染成
  // 标题 —— 用户截图里 `## 本机当前的场景` 就是这么被吞掉的（和 `<system-reminder>` 挤成一段）。
  // 收尾同理：正文末尾先归一成单个空行，免得 `</system-reminder>` 粘在最后一行上。
  // 结构：标题 → 补充说明（有才发）→ 权威声明（只在替换时）→ 边界陈述（有才发）→ 正文。
  // 没有 cue 那一行（见 `DomainFrame` 的注释）。
  const info: FrameRenderInfo = { toolHidden, text: section.text, replacing }
  const lines = [FRAME_OPEN, '', `# ${frame.title}`]
  // 作用域行紧贴标题：它是"此刻的处境"，`how` 才是动作句，顺序不能反。
  if (scopeLine !== undefined) lines.push(scopeLine)
  // 差异行：官方那份整段还在，这里只补一句"本对话另有启停"。
  // 不套 `how` 与 `boundary` —— 那两句说的是整份目录，配在一行差异上是假话。
  if (section.delta === true) {
    lines.push('', escapeFrameBody(section.text).replace(/\n+$/, ''), '', FRAME_CLOSE)
    return { text: lines.join('\n'), body: section.text, frameKey }
  }
  const how = typeof frame.how === 'function' ? frame.how(info) : frame.how
  if (how !== undefined) lines.push(how)
  // 权威声明只在**替换**时发：本会话的第一份没有旧内容可取代，那句话
  // 只是占一行。边界陈述反过来 —— 它不依赖"有没有旧的"，第一份就要发。
  if (replacing) lines.push(frame.supersede)
  if (frame.boundary !== undefined) lines.push(frame.boundary)
  lines.push('', escapeFrameBody(section.text).replace(/\n+$/, ''), '', FRAME_CLOSE)
  return { text: lines.join('\n'), body: section.text, frameKey }
}

/** 「已清空」通知正文：某个域曾经注入过、现在没有内容时发一条（纯函数，测试用）。 */
export function clearedDomainText(key: InjectDomainKey, label: string, reason?: string): string {
  const frame = domainFrame(key, label)
  // 通知的措辞按**原因**分叉。不能只用一句「同一类内容不再有效」——
  // "这一域为什么消失"有四种，其中三种下那句话是**假话**：
  //   - `official`：官方载体接管了（技能目录由 `dsh-tool-skill` 送、提示词由
  //     `dsh-agent-instructions` 送）。此时同类内容**仍然有效、而且更强**，只是换了个发送方。
  //     说"不再有效"会让模型把官方那一份也当成作废 —— 标准预设里这正是最常见的一次切换。
  //   - `empty`：真的没有内容了（全部删掉 / 场景切走）—— 只有这一种情形下那句话是对的。
  //   - `off` / `child`：是**故意不送**（用户关掉这一域，或该域不适用于子会话），内容本身
  //     可能还在，所以只能说"不再展示"，不能说"不存在"。
  //   - `error` 走不到这里：那条路径刻意不发「已清空」（见调用方注释）。
  const body = reason === 'official'
    ? '**Replaced** — the official channel now sends this content; earlier injected content of the same kind is stale.'
    : reason === 'off' || reason === 'child'
      ? '**Cleared** — this reminder is not sent here; earlier injected content of the same kind no longer applies.'
      : '**Cleared** — earlier injected content of the same kind no longer applies.'
  // 形状与 `renderDomainText` 一致（开标签后空行、板块 `#`、收尾空行）—— 这两条都是同一个
  // 通道发出去的消息，层级与留白不该有两套。
  return [
    FRAME_OPEN,
    '',
    `# ${frame.title}`,
    body,
    '',
    FRAME_CLOSE,
  ].join('\n')
}
