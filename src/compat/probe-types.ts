// 宿主探测的公开类型面：能力判定、身份比对、评估快照、拒绝文案。
//
// 为什么单独一层：probe.ts 的判定逻辑、host-probe.ts 的取数原语、capability-specs.ts
// 的能力表都要读这些类型。留在 probe.ts 里会让三者互相 import 出类型环，
// 同目录已有先例 —— memories/constants.ts 正是为断环而抽出的常量层。

export type CapabilityState = 'ok' | 'missing-member' | 'shape-mismatch' | 'not-available'

export interface CapabilityFinding {
  /** Stable id used by the UI and by logs. */
  readonly id: string
  /** Short human label (Chinese, matching the plugin's other surfaces). */
  readonly label: string
  readonly kind: 'read' | 'write' | 'delete'
  /** Which host service the capability lives on. */
  readonly owner: 'workspace' | 'projectionCache' | 'sessions' | 'persistence' | 'settings' | 'presetRoster' | 'fs' | 'plugin'
  readonly state: CapabilityState
  /** What can be done without this capability. */
  readonly fallback:
    | 'native-entry'      // an official entry point covers it
    | 'refuse-operation'  // routeFor() returns `none`: the operation is refused, not degraded
    | 'disable-destructive' // the button is disabled with an explanation
    /**
     * 只上报、不拦路：功能照常，少的是一道保险（如补丁写入的解析校验不可用）。
     * 界面据此显示「不影响写入」，而不是「相关按钮已禁用」——后者是一句假话。
     */
    | 'inform-only'
  /** One line a user can act on. */
  readonly detail: string
  /** Members that were absent, when state is missing-member. */
  readonly missing: readonly string[]
  /**
   * Whether the member's source text still equals this plugin's own copy of
   * the implementation. Diagnostic only: with the packaging fixed the two are
   * the same function object, and where they are not, identity is the thing to
   * repair — never a reason to refuse data operations.
   */
  readonly textMatch?: boolean
  /**
   * True for slots whose ABSENCE is a routing fact rather than a failure: the
   * plugin ships its own implementation for exactly this gap, so a host without
   * the member keeps full functionality through the adapter route.
   *
   * These must never be reported as "degraded": the DSH release this plugin was
   * verified against does not have them, and telling the user that a working
   * feature is degraded (worse: "the affected buttons are disabled") is a
   * factual lie about their installation.
   */
  readonly optional?: boolean
}

export interface HostIdentity {
  readonly version: string
  /** package name -> resolved entry path, or null when unresolvable. */
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
 * 这一条来自 issue #1（2026-09-23）：`realPathOf()` 以前 `catch { return value }`
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

export interface HostAssessment {
  readonly identity: HostIdentity
  readonly findings: readonly CapabilityFinding[]
  /**
   * Capabilities that are genuinely unavailable — optional slots excluded.
   * `findings` remains the full picture (the UI renders every slot, marking the
   * optional-absent ones as "adapter takes over").
   */
  readonly degraded: readonly CapabilityFinding[]
  /** True when the delete operation has a viable route (native or adapter). */
  readonly mayDelete: boolean
  readonly generatedAt: number
}

/** A capability the current operation needs but the host cannot provide. */
export interface CapabilityRefusal {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly recovery: string
}