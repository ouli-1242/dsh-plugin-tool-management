// 宿主探测的公开类型面：能力判定、身份比对、评估快照、拒绝文案。
//
// 为什么单独一层：probe.ts 的判定逻辑、host-probe.ts 的取数原语、capability-specs.ts
// 的能力表都要读这些类型。留在 probe.ts 里会让三者互相 import 出类型环，
// 同目录已有先例 —— memories/constants.ts 正是为断环而抽出的常量层。

/** 一项能力的四种状态：可用、缺成员、形状不符、根本没有。 */
export type CapabilityState = 'ok' | 'missing-member' | 'shape-mismatch' | 'not-available'

/** 一项能力的探测结论（静态检查 + 活体探针合成）。 */
export interface CapabilityFinding {
  /** 稳定 id：界面与日志都按它对齐。 */
  readonly id: string
  /** 给人看的短标签（中文，与插件其余界面一致）。 */
  readonly label: string
  readonly kind: 'read' | 'write' | 'delete'
  /** 这项能力长在哪个宿主服务上。 */
  readonly owner: 'workspace' | 'projectionCache' | 'sessions' | 'persistence' | 'settings' | 'presetRoster' | 'fs' | 'tools' | 'agentContext' | 'connection' | 'plugin'
  readonly state: CapabilityState
  /** 缺了这项能力还能怎么做。 */
  readonly fallback:
    | 'native-entry'      // an official entry point covers it
    | 'refuse-operation'  // routeFor() returns `none`: the operation is refused, not degraded
    | 'disable-destructive' // the button is disabled with an explanation
    /**
     * 只上报、不拦路：功能照常，少的是一道保险（如补丁写入的解析校验不可用）。
     * 界面据此显示「不影响写入」，而不是「相关按钮已禁用」——后者是一句假话。
     */
    | 'inform-only'
  /** 一行用户能照着动手的说明。 */
  readonly detail: string
  /**
   * 结构化文案（运行时上报透传）：客户端按键出对应语言的句子，没有就回退 `detail`。
   * 与 `RuntimeNote` / 功能总览同名同义 —— 服务端给数值与原因，句子归客户端。
   */
  readonly detailKey?: string
  readonly params?: Record<string, string | number>
  /** 状态为 missing-member 时，具体缺了哪些成员。 */
  readonly missing: readonly string[]
  /**
   * 成员的源码文本是否仍等于本插件那份同实现。
   *
   * 只作诊断：打包正常时两者是同一个函数对象；不是时该修的是**身份**（模块重复），
   * 它从来不是拒绝数据操作的理由。
   */
  readonly textMatch?: boolean
  /**
   * 该槽位**缺席**是路由事实而不是故障：插件针对这个缺口自带一份实现，宿主没有这个成员时
   * 功能经适配器路线完整可用。
   *
   * 这类槽位绝不能报成「降级」：本插件适配的那一版 DSH 本来就没有它们，把好用的功能说成
   * 降级（更糟：说「相关按钮已停用」）是在编造用户安装环境的状况。
   */
  readonly optional?: boolean
}

/** 宿主身份：版本、物理模块路径、与插件是否同源。 */
export interface HostIdentity {
  readonly version: string
  /** 包名 → 解析到的入口路径；解析不出来为 null。 */
  readonly modules: Record<string, string | null>
  readonly sameAsHost: Record<string, boolean | null>
  readonly blockers: readonly string[]
  /**
   * 已解析到、但**没能与宿主比对**的包（宿主的解析锚点里找不到它）。
   * 与 `sameAsHost === false`（两份拷贝）性质不同：那是"比过了、不一样"，
   * 这是"压根没比成"。界面据此显式说明，不让它退化成看不懂的「无法比对」。
   */
  readonly unverified: readonly string[]
  /**
   * 身份校验的**说明**，不是阻塞项：讲清楚为什么这一格是「比不了」而不是「坏了」。
   *
   * 目前只有一种来源 —— 桌面版把官方包装进 `resources/app.asar`，宿主与插件物理上
   * 不可能是同一份文件（归档 vs 磁盘）。这种情况按**版本**判定并把插件的实际来源
   * 讲出来，绝不进 `blockers`：那里每一条都会把整块身份标红，并附一句让用户去
   * `host-deps.mjs --fix` 的指令 —— 而在桌面版上，那条指令只会把插件的依赖
   * junction 到 npx 缓存里另一个版本的宿主上（实测：0.2.0-rc.2 → 0.1.7-rc.2）。
   */
  readonly notes: readonly HostIdentityNote[]
}

/**
 * 一条身份说明：`kind` 只是给界面/icons 分类用的稳定标签。
 *
 * 说明里带**已判定的包清单**（不是"所有比不了的包"）：身份校验里「比不了」有多种
 * 成因，界面只有拿到这份清单，才不会把归档宿主那几个包又塞进另一句
 * 「宿主的解析锚点里找不到它」里 —— 那句话对它们不成立（锚点找得到，归档里）。
 */
export type HostIdentityNote = HostIdentityAsarNote | HostIdentityRealpathNote

/** 归档宿主：两侧版本一致、只是打包方式不同（桌面版）。 */
export interface HostIdentityAsarNote {
  readonly kind: 'asar-host'
  /** 归档文件名（如 `app.asar`），从宿主锚点里取，界面不硬编码。 */
  readonly asarName: string
  readonly hostRoot: string
  /** 归档宿主的版本；两侧版本相同才认定「同版本、打包方式不同」。 */
  readonly hostVersion: string | null
  readonly pluginVersion: string | null
  /** 已判定的包：`hostPath`/`pluginPath` 两侧都能解析到。 */
  readonly packages: readonly HostIdentityPackage[]
}

/**
 * 路径**没能取到真实形态**（realpath 失败）时的说明。
 *
 * 这一条来自 ：`realPathOf()` 以前 `catch { return value }`
 * 把「这条路径不可解析」静默降级成「拿输入去比较」，于是路径问题看起来就是
 * 「插件与宿主加载的是两份不同拷贝」—— 结论是编的，用户照着它去修只会白费功夫。
 * 现在这类包给 `sameAsHost = null`（比不了），并在这里把原因原样报出来。
 */
export interface HostIdentityRealpathNote {
  readonly kind: 'realpath'
  /** 真实形态取不到的包，连同它们的解析结果与失败原因。 */
  readonly failures: readonly HostIdentityRealpathFailure[]
  /** 宿主侧的失败原因（与该包无关，整轮共用一条，故单独提出来）。 */
  readonly hostReason?: string
  /** 插件侧的失败原因。 */
  readonly pluginReason?: string
}

/** 一条 realpath 失败记录：包名 + 该侧解析到的入口 + 失败原因。 */
export interface HostIdentityRealpathFailure {
  readonly name: string
  /** `plugin`（本插件解析到的）或 `host`（宿主锚点解析到的）。 */
  readonly side: 'host' | 'plugin'
  readonly path: string
  /** `error.code` 或异常消息，原样带给用户 —— 权限与长度限制的原因长在这里。 */
  readonly reason: string
}

/** 归档宿主清单里的一项：包名 + 两侧实际解析到的入口。 */
export interface HostIdentityPackage {
  readonly name: string
  readonly hostPath: string
  readonly pluginPath: string
}

/** 一次完整评估：身份 + 逐项能力 + 降级清单。 */
export interface HostAssessment {
  readonly identity: HostIdentity
  readonly findings: readonly CapabilityFinding[]
  /**
   * 真正拿不到的能力 —— 可选槽位不算。`findings` 仍是全貌（界面每个槽位都渲染，
   * 可选而缺席的标成「适配器接管」）。
   */
  readonly degraded: readonly CapabilityFinding[]
  /** 删除操作还有路可走（原生或适配器）时为 true。 */
  readonly mayDelete: boolean
  readonly generatedAt: number
  /**
   * 宿主**非 peer** 契约的实况（`compat/host-contracts.ts` 那份清单的运行时探测量）。
   *
   * 与 `findings` 的分工：那一张表是"本插件通过 `ctx.get` 拿到的宿主服务"，服务不在场就探测
   * 不到；这一份是"插件按裸模块名 require 的官方包"，它们在**模块层**而不是服务层，所以服务
   * 在场与否与它们无关。两者都是"升级后可能悄悄少一块"的来源，界面一起列出来。
   *
   * `undefined` = 本轮没量（例如找不到宿主安装锚点）。界面据此显示"判断不了"，而不是"正常"。
   */
  readonly contracts?: HostContractStatus
}

/** 一个"裸模块名"包在宿主侧的实况。 */
export interface HostContractPackageStatus {
  /** 官方包名。 */
  readonly package: string
  /** 失去它时受影响的功能。 */
  readonly feature: string
  /** 从宿主安装锚点解析到的入口；`null` = 宿主不再暴露这个包。 */
  readonly resolved: string | null
  /** 入口里缺失的 canary 标识符（空数组 = 都在）。 */
  readonly missingMarkers: readonly string[]
}

/** 宿主非 peer 契约的整体实况。 */
export interface HostContractStatus {
  readonly packages: readonly HostContractPackageStatus[]
  /** 宿主不再暴露的包（功能静默降级的来源）。 */
  readonly missing: readonly string[]
  /** canary 缺失的包（契约可能已漂移，需人工复核）。 */
  readonly drifted: ReadonlyArray<{ readonly package: string; readonly missingMarkers: readonly string[] }>
}

/** 当前操作需要、而宿主给不出的能力。 */
export interface CapabilityRefusal {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly recovery: string
}