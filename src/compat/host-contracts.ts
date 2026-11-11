// 宿主**非 peer** 契约的共享清单：运行时探测（compat/probe.ts 的 runtime-only 上报）与
// `scripts/doctor.mjs` 都要读它们，所以只有这一份。
//
// 为什么单独一层：这些包**不在**本插件的 `peerDependencies` 里 —— 宿主不要求插件依赖它们，
// 但插件要么在运行时按**裸模块名**直接 require（MCP 客户端、人设、全局指令、技能目录），
// 要么把它们的**标识符**写死在自己代码里（共享资源工具的三个名字）。它们有两个共同点让
// 它们必须被看见：
//   (1) 官方改名或撤掉其中一个，对应功能**静默降级**（不抛错，只是少一半）；
//   (2) 它们不参与模块身份比对（不是硬依赖），所以"两份不同拷贝"那一栏根本看不到它们。
//
// 此前这份清单只活在 doctor 里：命令行看得到，兼容页看不到。而兼容页正是用户升级 DSH 后
// 第一眼看的界面 —— 于是同一个"官方把某个包撤了"的事实，CLI 报得出来、界面报不出来。
// 提升到这里之后两边读同一份（doctor 从 lib/ import，不再自己维护一份）。

/**
 * 一条 canary：某个**标识符字符串**必须继续出现在官方包的入口里。
 *
 * 这不是"实现细节快照"，而是**契约标识**：官方把它改名/拆函数，就是"该人工复核这条契约"的
 * 信号。反过来 needle 还在也不等于语义没变 —— 所以写的是 `why`（这条 needle 守着什么），
 * 而不是"它证明了什么"。
 */
export interface HostContractMarker {
  /** 必须继续出现的标识符（取自官方安装源码）。 */
  readonly needle: string
  /** 这条 needle 守着的契约。 */
  readonly why: string
  /**
   * 标记所在的包内文件（相对包根的 POSIX 路径，如 `lib/pipeline.js`）。
   * 缺省读包入口 —— 事件发射点 / 客户端 bundle 常常不在入口文件里。
   */
  readonly file?: string
}

/** 一条"官方包 + 它守住的 canary"的契约。 */
export interface HostModuleContract {
  /** 官方包名（插件按裸名 require，或把它的标识符写死在自己代码里）。 */
  readonly package: string
  /** 失去这个包 / canary 时受影响的功能（界面与 CLI 共用的一句说明）。 */
  readonly feature: string
  /** 漂移或缺失时用户能感知到的后果；兼容页把它显示在原因里。 */
  readonly impact?: string
  /**
   * 缺席是部署形态而不是故障 —— 例如宿主没有使用 JSONL 持久化后端。
   * 可选契约的包解析不到时界面显示「本宿主未使用」，而不是红色缺失。
   */
  readonly optional?: boolean
  /** 包的入口必须继续携带的标识符（空数组 = 只要求包本身还解析得到）。 */
  readonly markers: readonly HostContractMarker[]
  /**
   * 这条契约**无法自动验证**的部分：canary 只能证明标识符还在，证明不了时序 / 语义 /
   * 客户端真实渲染。随 `manualChecks` 返回给诊断 JSON；兼容页不展示。
   */
  readonly manual?: string
}

/**
 * `~/.dsh/AGENTS.md` 的**增量刷新**契约 —— 本插件"应用提示词预设"依赖它。
 *
 * 插件把预设正文写进全局 `AGENTS.md`，然后靠官方**每一步**重新读盘（对比 stat 的 version 与
 * 内容 SHA-1）决定要不要把新正文送进模型。官方一旦改成事件驱动、加 touchedPaths 白名单、或改
 * digest 口径，"应用预设"就会**静默失效**（旧正文继续注入），零报错。
 */
export const AGENTS_MD_REFRESH_PACKAGE = '@deepseek-ai/dsh-agent-instructions'
/** 上面那套「每步重读」机制的源码记号 —— 少一个就说明官方换了驱动方式。 */
export const AGENTS_MD_REFRESH_MARKERS: readonly HostContractMarker[] = [
  { needle: 'agentInstructionsHook', why: '每步重读全局 AGENTS.md 的钩子入口' },
  { needle: 'trimmedInstructionDigest', why: '内容同一性 = 去掉首尾空白后的 SHA-1' },
  { needle: 'instructionContentSha1', why: 'SHA-1 摘要口径' },
  { needle: 'sameInstructionChange', why: '按 {action, scope, path, digest} 判「有没有变化」' },
]

/**
 * 运行时依赖的宿主包，以及每个包守着的契约。
 *
 * 与 `AGENTS_MD_REFRESH_MARKERS` 的分工：那一份是"同一个包内的若干标识符"，这一份是
 * "若干不同的包各要求什么"。合起来才是"官方撤掉了什么"的完整清单。
 *
 * 条目有两种：插件**按裸模块名 require** 的那几个（`markers` 多半为空），以及插件把它的
 * **标识符写死在自己代码里**的那几个 —— 后者靠 `markers` 里的 canary 盯住名字漂移。
 */
export const BARE_HOST_MODULE_CONTRACTS: readonly HostModuleContract[] = [
  {
    package: '@deepseek-ai/dsh-mcp-client',
    feature: 'MCP 客户端（MCP 服务器装配的宿主出口）',
    impact: 'MCP 配置写入、停用守卫与工具计数会失配',
    markers: [
      { needle: 'mcp__', why: 'MCP 工具名前缀（插件按它拼全名、识别停用项与计数）' },
      { needle: 'serverName', why: 'MCP 服务器条目的配置键（插件写补丁用的就是它）' },
      { needle: 'transport', why: 'MCP 传输类型配置键（stdio / streamable-http）' },
      { needle: 'toolCallTimeoutMs', why: 'MCP 工具调用超时配置键' },
      { needle: 'SERVER_NAME_PATTERN', why: '服务器名校验规则（插件表单与补丁解析按同一形状接受名字）' },
      { needle: 'mcp__${serverName}__${rawName}', why: 'MCP 工具全名拼法（插件按 server__tool 拆名、停用与计数）' },
      { needle: 'mcp:${server}', why: '服务器 instructions 的 prompt 段名（插件按同名段遮蔽别的对话的服务器）' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-mcp-resources',
    feature: 'MCP 共享资源工具（官方那三个资源工具的宿主出口）',
    impact: '逐会话可见性摘除、执行侧守卫与 prompt 段遮蔽会认不出这三个工具',
    markers: [
      { needle: 'list_mcp_resources', why: '共享资源工具的名字（插件的逐会话可见性摘除与执行侧守卫按这三个名字认它）' },
      { needle: 'list_mcp_resource_templates', why: '同上（三个共享资源工具之一）' },
      { needle: 'read_mcp_resource', why: '同上（三个共享资源工具之一）' },
      { needle: 'mcp-resource-servers', why: '资源服务器清单的 prompt 段名（插件按同名段替换成只列本会话可见服务器）' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-persona',
    feature: '人设（子代理人格的读取与解析）',
    impact: '注入边界对「压制型预设」的判定会失真',
    markers: [
      { needle: 'includeRuntimeContext', why: '预设是否关掉官方运行时上下文（注入边界判定）' },
      { needle: 'suppressRuntimeContext', why: '运行时上下文压制入口（极简预设依赖它）' },
    ],
  },
  {
    package: AGENTS_MD_REFRESH_PACKAGE,
    feature: 'AGENTS.md 注入（应用提示词预设）',
    impact: '「应用提示词预设」可能静默失效：写入后官方不再每步重读',
    markers: AGENTS_MD_REFRESH_MARKERS,
  },
  {
    package: '@deepseek-ai/dsh-tool-skill',
    feature: '技能目录（官方技能挂载的宿主出口）',
    impact: '官方技能工具让位判定与目录截断长度会失配',
    markers: [
      { needle: 'DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH', why: '技能目录描述截断长度（本插件的目录与子智能体目录都对齐它）' },
      { needle: 'name: "skill"', why: '官方技能工具名（插件据此决定是否让出 skill_manager_read）' },
    ],
  },
]

/**
 * 官方 JSONL 会话目录布局的 canary —— 历史适配器（`src/sessions/workspace.ts` →
 * `jsonlSessionDirectory`）硬编码了它。
 *
 * 这些是**行为常量**，不是装饰：任何一个变了，适配器就再也不能确认某个转写目录属于它正要删的
 * 那个会话，删除会退化成"只删工件、保留父目录"，而唯一征兆只是插件侧一行日志。那种退化被刻意
 * 做成非致命（工件仍然删掉，且删后经 `persistence.stat` 复核），所以对着一台没活着的宿主做静态
 * 检查，是用户在自己翻出孤儿目录之前唯一能知道漂移的办法。
 */
export const JSONL_LAYOUT_PACKAGE = '@deepseek-ai/dsh-session-persistence-jsonl'
/** 会话 JSONL 磁盘布局的源码记号（条目形状、文件命名、目录结构）。 */
export const JSONL_LAYOUT_MARKERS: readonly HostContractMarker[] = [
  { needle: 'session-persistence-jsonl', why: '适配器的后端名门槛' },
  { needle: '_no-cwd', why: '会话头没有 cwd 时落进的桶' },
  { needle: '251', why: '项目段截断长度' },
  { needle: 'padStart(4', why: '~XXXX UTF-16 转义编码' },
]

/**
 * 宿主**行为契约**：插件没有 require 这些包，但把它们的字符串契约写死在自己代码里
 * （事件名、磁盘布局、配置键、方言标记）。官方改掉其中一个，对应功能会静默失效。
 *
 * 与 {@link BARE_HOST_MODULE_CONTRACTS} 的分工：那一份是「插件按裸模块名要用的包」，
 * 这一份是「插件观测宿主行为时依赖的包」。两者都走同一套 canary 判定与展示。
 */
export const HOST_BEHAVIOR_CONTRACTS: readonly HostModuleContract[] = [
  {
    package: '@deepseek-ai/dsh-agent',
    feature: 'Agent 生命周期事件',
    impact: '上下文注入、子代理工具限制与停用可见性会静默失效',
    markers: [
      { needle: 'agent/pre-step', why: '上下文注入与令牌门禁挂载的 waterfall 事件' },
      { needle: 'agent/created', why: '子代理创建时施加工具限制、补基线快照的事件' },
      { needle: 'agent/disposed', why: '会话销毁时摘除停用可见性的事件' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-storage-domain',
    feature: '存储域变更事件',
    impact: '归档 / 恢复后列表不会自动刷新',
    markers: [
      { needle: 'domain/changed', why: '工作区登记表变化后刷新历史列表的事件' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-app-boot',
    feature: '补丁文件方言（cordis.patch.yml）',
    impact: '插件写出的补丁可能让 DSH 下次启动失败',
    markers: [
      { needle: 'parsePatchList', why: '补丁列表解析器（顶层数组 / 每项映射的断言在它里面）' },
      { needle: 'userPatchesSchema', why: '用户补丁条目的 schema' },
      { needle: 'loadOverlayPatches', why: 'profile 补丁文件的加载入口' },
      { needle: 'loadOptionalPatches', why: 'bundle 补丁文件的加载入口' },
      { needle: 'tag:yaml.org,2002:js', why: '补丁里的 !!js 表达式标签' },
    ],
  },
  {
    package: JSONL_LAYOUT_PACKAGE,
    feature: '会话转写目录布局',
    impact: '删除可能只删转写工件、留下孤儿目录',
    optional: true,
    markers: JSONL_LAYOUT_MARKERS,
  },
  {
    package: '@deepseek-ai/dsh-subagent',
    feature: '子智能体运行时（provider 激活）',
    impact: '带人设的子代理委派无法启动',
    markers: [
      { needle: 'startActivation', why: '子代理运行时启动入口（插件挂 provider 与派活都走它）' },
      { needle: 'delivery', why: '激活结果的投递方式字段（parent / caller）' },
      { needle: 'stopReason', why: '子代理结果终止原因' },
      { needle: 'output', why: '子代理最终输出字段' },
    ],
    manual: 'startActivation 的请求字段（provider / label / request / signal / delivery）与回执字段（result / dispose）只能人工核对：探测里真调它会启动一个子代理。',
  },
  {
    package: '@deepseek-ai/dsh-agent-preset-registry',
    feature: '预设名册读取与临时子预设',
    impact: '注入边界矩阵与带人设的子代理委派会失效',
    markers: [
      { needle: 'readDocument', why: '预设组合文本读取入口' },
      { needle: 'composedPreset', why: '按 agent 取组合预设 id（注入边界与工具提示用）' },
      { needle: 'register', why: '临时子预设注册（带人设的子代理委派）' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-tools',
    feature: '工具限制、执行守卫与工具清单',
    impact: '人设工具限制、MCP 工具计数与停用拦截会失效',
    markers: [
      { needle: 'restrict', why: '工具限制施加入口（人设 tools / toolsDeny 与逐会话可见性）' },
      { needle: 'schemas', why: '工具清单读取入口（MCP 工具计数）' },
      { needle: 'checkGuards', why: '执行守卫分发入口（停用工具与逐会话开关的执行侧拦截）' },
      { needle: 'tools/change', why: '工具表变化事件（可见性重排的触发点）' },
      { needle: 'tools/pre-execute', why: '工具执行前 waterfall（三个确认门与停用裁决）', file: 'lib/pipeline.js' },
    ],
    manual: '只能证明守卫分发入口与事件名还在；守卫在真实调用链里是否被调到、exec 载荷字段是否仍是 name / arguments / agent 无法在不触发工具调用的情况下验证。',
  },
  {
    package: '@deepseek-ai/dsh-system-prompt',
    feature: '系统提示词段遮蔽（MCP 跨会话 prompt 隔离）',
    impact: '别的对话的 MCP 服务器名与 instructions 会进入本对话提示词',
    markers: [
      { needle: 'section', why: '按 agent 作用域注册同名段以遮蔽全局段' },
      { needle: 'getSectionOrder', why: '取得 MCP_SERVERS 段的排序位' },
      { needle: 'MCP_SERVERS', why: 'MCP 段的排序名' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-client-connection',
    feature: 'Web 连接准入',
    impact: 'HTTP 鉴权退回本地回环判定',
    markers: [
      { needle: 'admit', why: 'Web 连接准入入口（HTTP 鉴权栅栏）' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-settings',
    feature: '设置文档路径',
    impact: 'DSH 主目录推导失败，MCP 页与补丁读写不可用',
    markers: [
      { needle: 'documentPath', why: '设置文档路径 getter（DSH 主目录推导源）' },
      { needle: 'prepareDocument', why: '设置文档准备入口' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-session',
    feature: '会话事件序号与可见消息',
    impact: '注入表面的事件定位与去重会失配；自主记忆的后台复习不再被触发',
    markers: [
      { needle: 'SessionSeq', why: '会话事件序号（注入表面按它定位事件）' },
      { needle: 'deriveMessages', why: '模型可见消息的公开出口（注入表面按它读各域最新正文）' },
      { needle: 'eventAt', why: '同步事件读取（deriveMessages 缺席时的兜底路径）' },
      // 自主记忆的冷路径只认这三个事件名：压缩触发复习、请求头给模型路由、真人消息喂证据缓存。
      // 任何一个改名，对应那一段会**静默失效** —— 复习不触发 / 复习拿不到路由 / 引句核对
      // 永远降级，日志里只有我们自己写的那几行。
      { needle: 'compaction/summary', why: '压缩事件名（后台复习唯一的触发点）' },
      { needle: 'request/header', why: '请求头事件名（复习用这一轮的模型路由）' },
      { needle: 'user/message', why: '用户消息事件名（证据缓存，逐字引句核对）' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-spill-local',
    feature: '会话溢出目录',
    impact: '会话转写目录定位失配，删除可能找不到工件',
    markers: [
      { needle: 'sessionDir', why: '会话溢出目录解析入口（历史适配器按它定位会话目录）' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-llm',
    feature: '上下文消息构造与模型目录',
    impact: '上下文注入消息构造失败，场景模型候选与思考档位退化为手填',
    markers: [
      { needle: 'createUserMessage', why: '合成 user 消息的工厂（pre-step 注入用）' },
      { needle: 'listProviders', why: '模型来源枚举入口（场景模型候选）' },
      { needle: 'listModels', why: '模型枚举入口（来源下可选模型）' },
      { needle: 'resolveModelInfo', why: '模型能力解析入口（思考档位清单）' },
      { needle: 'efforts', why: '思考档位清单字段' },
    ],
    manual: 'listModels / resolveModelInfo 是异步且可能联网的调用；探测只核对方法存在，返回对象里的 id / name / reasoning.efforts / defaultEffort 形状无法在探测里验证。',
  },
  {
    package: '@deepseek-ai/dsh-skill',
    feature: '技能 provider 注册、候选协议与按会话分层的清单',
    impact: '技能启停、官方内置技能接管与技能目录会静默失效；技能清单会串到别的会话',
    markers: [
      { needle: 'registerProvider', why: 'provider 注册入口（全局层与每个 agent 层各注册一份）' },
      { needle: 'invalidate', why: '注册生命周期里的失效通知（来源变化后重读候选）' },
      { needle: 'candidates', why: 'provider 候选观测的 candidates 字段' },
      { needle: 'complete', why: '候选观测的完成标记（未完成不缓存）' },
      { needle: 'locator', why: '候选上的发现定位符（get 时原样带回）' },
      { needle: 'scopeChainOf', why: '官方清单按查看方 agent 的 scope 链分层（清单按会话隔离的依据）' },
      { needle: 'provider.list(options)', why: 'provider 拿到含 scope 的同一份 options（provider 按会话收紧的依据）' },
    ],
    manual: 'provider 的 list/get 返回形状与 control.signal / control.invalidate 的调用时序只能核对字符串：探测里真注册一个 provider 会进入技能目录并触发失效事件。scope 链的语义（查看方 agent 决定分层）同样只能核对字符串。',
  },
  {
    package: '@deepseek-ai/dsh-api-session-controller',
    feature: '会话侧技能清单的 scope 解析',
    impact: '宿主 `/` 菜单的「技能」段与官方 skill 工具不再按会话区分：别的会话开着的技能会串过来',
    // 与客户端 UI 契约那一份同包 —— 那边盯客户端 bundle，这边盯服务端 RPC 怎么取 scope。
    // 同样按可选契约报：这个包缺席是部署形态，不是故障。
    optional: true,
    markers: [
      { needle: 'scope = live ?? lease?.key', why: '查看会话的 agent（活着就取它，否则取预设租约）当 scope 传给官方清单' },
      { needle: 'isUserInvocable', why: '官方清单只保留用户可调用的技能（被收紧的条目据此不再出现）' },
    ],
    manual: 'scope 的取值链（活着的 agent → 预设租约 → 无）只能核对字符串：真正验证要开两个会话各开一条技能，看清单是否分开。',
  },
  {
    package: '@deepseek-ai/dsh-host-plugin-inventory',
    feature: 'Loader 插件条目清单（附带 MCP 的实时信息）',
    impact: 'loader 上临时挂载 / 重启 / 删除的等待会退化为固定延迟',
    markers: [
      { needle: 'entryId', why: 'Loader 条目 id（插件按裸 id 匹配补丁行）' },
      { needle: 'moduleName', why: '条目模块名（识别临时挂载的 MCP 客户端）' },
      { needle: 'fiberPhase', why: '条目运行阶段（判断是否已启用）' },
      { needle: 'enabled', why: '条目启用标记（重启 / 删除的等待条件）' },
    ],
    manual: 'list() 是异步且返回实时 Loader 树；探测只核对方法存在，entries 里的字段组合无法在不等待宿主加载完成的情况下验证。',
  },
  {
    package: '@deepseek-ai/dsh-user-approval',
    feature: '审批策略读取（完全权限判定）',
    impact: '完全权限模式下的确认门判定会失真',
    markers: [
      { needle: 'effectivePolicy', why: '按会话解析生效审批策略的成员' },
    ],
    manual: 'effectivePolicy(session) 是私有实现细节且需要活的会话对象；探测只核对成员存在，返回值（never / ask 等）无法安全验证。',
  },
  {
    package: '@deepseek-ai/dsh-session-projection-cache',
    feature: '投影缓存快照（会话标题与消息数）',
    impact: '归档会话列表的标题退化为工作区名或短 id，hasMessages 恒真',
    markers: [
      { needle: 'cachedSnapshot', why: '零 I/O 读取缓存行（标题与 titleInput 行）的入口' },
      { needle: 'cachedPredecessorTitle', why: '旧格式代际的标题提示面' },
      { needle: 'rows', why: '缓存记录里的投影行表' },
    ],
    manual: 'cachedSnapshot 的真实返回值取决于磁盘上的缓存记录与格式代际；探测只能用哨兵确认方法不抛错，无法验证 title / titleInput 的实际投影形状。',
  },
  {
    package: '@deepseek-ai/dsh-session-title',
    feature: '会话标题投影键（title / titleInput）',
    impact: '历史列表与作用域摘要读不到标题，空会话会混进列表',
    markers: [
      { needle: 'titleInput', why: '标题输入投影键（插件按 rows.titleInput.val.count 判有没有消息）' },
      { needle: 'count', why: 'titleInput 的计数状态字段' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-storage-json',
    feature: 'JSON 存储布局（per-record 目录）',
    impact: '磁盘直读投影缓存找不到记录，标题与 hasMessages 静默退化',
    markers: [
      { needle: 'per-record', why: '每记录一文件的布局名（storages/<domain>/<table>/<key>.json）' },
      { needle: 'global.json', why: 'per-record 目录里的全局槽文件' },
      { needle: '<table>/<key>.json', why: '记录文件的目录形状' },
    ],
    manual: '磁盘路径还取决于宿主实际使用的存储后端与根目录；探测只能核对 JSON 后端的布局标记，无法确认本机一定走这个后端。',
  },
  {
    package: '@deepseek-ai/dsh-fs-local',
    feature: '本地文件服务的写入实现',
    impact: '补丁文件与令牌文件的原子写入路径失配',
    markers: [
      { needle: 'writeText', why: '文本原子写入实现（插件写补丁文件走它）' },
      { needle: 'resolve(path', why: '目标解析实现（把路径变成可写目标）' },
    ],
    manual: 'writeText 的五个实参语义与沙箱策略交互只能人工核对：探测里真调它会写文件。',
  },
  {
    package: '@deepseek-ai/dsh-host-webserver',
    feature: 'HTTP 路由注册（插件面板 API）',
    impact: '面板整页 404，所有页面操作不可用',
    markers: [
      { needle: 'register(route)', why: '命名路由注册入口' },
      { needle: 'exact', why: '精确路径路由类型（插件 API 用的 kind）' },
      { needle: 'prefixes', why: '前缀路由表（匹配顺序的另一半）' },
    ],
    manual: 'register 的 route 形状与匹配优先级只能核对源码标记；真注册一条路由会占用宿主路由表。',
  },
  {
    package: '@deepseek-ai/dsh-sandbox-policy',
    feature: '沙箱策略解析（写补丁文件前的授权）',
    impact: '补丁写入的沙箱授权解析失败，MCP 页保存不可用',
    markers: [
      { needle: 'resolve(request', why: '策略解析入口' },
      { needle: 'workspaceRoot', why: '解析结果里的工作区根字段' },
      { needle: 'additionalWritableRoots', why: '解析结果里的额外可写目录字段' },
    ],
  },
]

/**
 * 宿主**客户端**契约：插件前端分片依赖的模块加载器、插槽名与客户端服务。
 *
 * 与 {@link HOST_BEHAVIOR_CONTRACTS} 同一套 canary 判定，但读者是浏览器那半：这些包只在
 * `lib/client.js` 里定义槽位与服务，宿主升级改掉一个名字，插件注册的页面 / 侧栏 / 输入框
 * 锁定会静默消失，服务端探测完全看不见。`optional`：headless 宿主不装配客户端包，缺席不是故障。
 */
export const HOST_CLIENT_UI_CONTRACTS: readonly HostModuleContract[] = [
  {
    package: '@deepseek-ai/dsh-client-modules',
    feature: '客户端模块加载器（插件前端分片入口）',
    impact: '插件的设置页与侧栏面板整块不加载',
    optional: true,
    markers: [
      { needle: '__ModuleLoader__', why: '浏览器端模块加载入口（插件分片靠它注册）', file: 'lib/client.js' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-client-ui-settings-general',
    feature: '设置页分节与分节图标插槽',
    impact: '「工具管理」不再出现在设置导航里，或图标回退成通用字形',
    optional: true,
    markers: [
      { needle: 'settings.section', why: '设置分节插槽名（插件注册设置页入口）', file: 'lib/client.js' },
      { needle: 'settings.section.icon', why: '设置分节图标插槽名（插件注册导航图标）', file: 'lib/client.js' },
    ],
    manual: 'canary 只证明插槽名还在；宿主是否仍渲染这个插槽、插槽参数（size / active）是否不变仍需人工看一眼。',
  },
  {
    package: '@deepseek-ai/dsh-client-ui-sidebar',
    feature: '侧栏面板列表插槽',
    impact: '「工具管理」侧栏入口消失',
    optional: true,
    markers: [
      { needle: 'sidebar.panellist', why: '侧栏面板列表插槽名（插件注册入口行）', file: 'lib/client.js' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-client-ui-conversation',
    feature: '对话输入框锁定（ComposerBlocks）',
    impact: '租约 / 令牌要求的输入框锁定失效',
    optional: true,
    markers: [
      { needle: 'storeFor', why: '按会话读取输入框锁定状态的注册面', file: 'lib/client.js' },
    ],
    manual: '只能证明 ComposerBlocks 的按会话存储面还在；set(id, {reason}) 的实际拦截效果仍需在对话里确认。',
  },
  {
    package: '@deepseek-ai/dsh-client-ui-layout',
    feature: '布局面板选择（收起侧栏面板）',
    impact: '删除侧栏入口时不能自动收起已打开的面板',
    optional: true,
    markers: [
      { needle: 'activePanelId', why: '当前活动面板的读取面', file: 'lib/client.js' },
      { needle: 'selectPanel', why: '切换 / 清空活动面板的入口', file: 'lib/client.js' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-client-ui-workspace',
    feature: '工作区目录选择器',
    impact: '场景 / 工作区面板里的「选择目录」不可用',
    optional: true,
    markers: [
      { needle: 'pickDirectory', why: '官方目录选择通道', file: 'lib/client.js' },
    ],
  },
  {
    package: '@deepseek-ai/dsh-api-session-controller',
    feature: '客户端会话列表（当前会话与刷新通知）',
    impact: '输入框锁定与作用域下拉拿不到当前会话 / 列表变化',
    optional: true,
    markers: [
      // needle 只认**标识符**，不认包裹它的引号：官方发布形态一变（压缩构建把 `"` 换成
      // 反引号），带引号的 needle 就会误报漂移，而契约其实没变。
      { needle: 'reflect.provide(', why: '客户端 sessions 服务注册入口', file: 'lib/client.js' },
      { needle: 'session-controller.client.sessions', why: '客户端会话服务的作用域标签（注册点与之同处）', file: 'lib/client.js' },
      { needle: 'projectList', why: '会话列表快照投影（list.getSnapshot 的数据源）', file: 'lib/client.js' },
    ],
    manual: '只能证明 sessions 服务与列表投影还在；list.current / selection.sessionId 的实际字段仍需浏览器里确认。',
  },
]
