// 技能核心的类型面（回执形状、状态文档、扫描与导入结构）。
//
// 从 core.ts 整段搬来，一行未改；类型在编译期擦除，所以这一刀不动运行时一个字。
// 拆它的理由很直白：core.ts 那四千多行里，「每个函数返回什么形状」与「怎么读写磁盘」
// 原本挤在同一个文件里来回翻。
//
// 这些类型原先是 core.ts 的私有声明（无一 export），现在导出层只服务 core.ts 自己。

// ── 类型声明 ────────────────────────────────────────────────────────────────

/** 插件日志回调（service 层注入；同步/异步返回都接受）。 */
export type LogFn = (event: string, detail?: unknown) => void;

/** 业务失败结果：core 统一的 `{ ok: false, error, code?, params? }` 形状。 */
export interface FailureResult {
  ok: false;
  error: string;
  code?: string;
  params?: Record<string, unknown>;
}

/** 一条警告项（前端按 code + params 渲染，error 为兜底原文）。 */
export interface SkillWarning {
  code: string;
  params?: Record<string, unknown>;
  error?: string;
}

/** 一条 frontmatter 诊断项。 */
export interface SkillDiagnostic {
  level: string;
  code: string;
  params?: Record<string, unknown>;
}

/**
 * 技能来源描述符（用户级 / 自定义 / 项目级共用）。
 *
 * 各来源形状不完全一致，故除 key/path/label 与四个公共布尔位外全部可选。
 * `ok` 是判别位：本类型永不带 ok，与 FailureResult 的 `ok: false` 组成联合，
 * 让 `definition.ok === false` 能收窄（见 writableRootDefinition 的返回）。
 */
export interface SkillSource {
  key: string;
  path: string;
  label: string;
  mutable: boolean;
  toggleable: boolean;
  native: boolean;
  rank: number;
  deletable?: boolean;
  localeKey?: string;
  custom?: boolean;
  scope?: "user" | "project";
  kind?: "project-dsh" | "project-agents";
  projectRoot?: string;
  projectName?: string;
  workspaceCwds?: string[];
  ok?: undefined;
}

/** 项目级来源的公共字段（kind / key / path 等由各候选补齐）。 */
export interface ProjectSourceCommon {
  mutable: boolean;
  deletable: boolean;
  toggleable: boolean;
  native: boolean;
  scope: "project";
  projectRoot: string;
  projectName: string;
  workspaceCwds: string[];
}

/** 项目级来源描述符（项目根相关字段由 projectRoots 保证存在）。 */
export interface ProjectSource extends SkillSource {
  scope: "project";
  kind: "project-dsh" | "project-agents";
  projectRoot: string;
  projectName: string;
  workspaceCwds: string[];
}

/** 来源入参：key 字符串、来源描述符对象，或解析不到时的空值。 */
export type RootInput = string | SkillSource | null | undefined;

/** 可写来源解析结果（`ok === false` 时是业务失败）。 */
export type WritableRootResult = SkillSource | FailureResult | null;

/** 最近项目根探测结果：找到根 / 宿主不可读 / 未找到（null）。 */
export type ProjectRootProbe =
  | { root: string; cwd: string; unavailable?: undefined }
  | { root?: undefined; unavailable: true; cwd: unknown; code?: string }
  | null;

/** 解析后的 SKILL.md frontmatter（map 只含顶层标量）。 */
export interface SkillDoc {
  fields: { key: string; raw: string }[];
  map: Record<string, string | undefined>;
  body: string;
  hasFrontmatter: boolean;
}

/** 条目定位信息（frontmatter 摘要之外的字段）。 */
export interface EntryLocation {
  kind: "bundle" | "flat";
  docPath: string;
  entryPath: string;
  realDocPath: string;
  realEntryPath: string;
  linked: boolean;
}

/** 技能条目的 frontmatter 摘要（不含定位信息）。 */
export interface SkillSummary {
  name: string;
  declaredName: string;
  kind: "bundle" | "flat";
  docPath: string;
  description: string;
  modelInvocable: boolean;
  userInvocable: boolean;
  invocationPolicyValid: boolean;
  hasFrontmatter: boolean;
  loadable: boolean;
  diagnostics: SkillDiagnostic[];
}

/** 一条技能条目：摘要 + 定位信息（只读来源递归发现时也带摘要）。 */
export interface SkillEntry extends SkillSummary {
  entryPath: string;
  realDocPath: string;
  realEntryPath: string;
  linked: boolean;
  /** 同名去重时补写：来源 rank 与策略别名。 */
  providerRank?: number;
  policyAliases?: { rootKey: string; name: string }[];
}

/** 一次来源扫描的结果。 */
export interface ScanResult {
  exists: boolean;
  entries: SkillEntry[];
  truncated?: boolean;
}

/** 一次来源扫描的选项。 */
export interface ScanOptions {
  metadataOnly?: boolean;
}

/** 自定义来源记录（状态文件里的 `{ key, path, label? }`）。 */
export interface CustomRoot {
  key: string;
  path: string;
  label?: string;
}

/** 归一化后的 manager 状态。 */
export interface ManagerState {
  version: number;
  sources: Record<string, boolean>;
  disabledSkills: Record<string, string[]>;
  enabledSkills: Record<string, string[]>;
  customRoots: CustomRoot[];
  preferredSkills: Record<string, string>;
  removedSources: string[];
}

/** 状态文件原始文档（外部数据，字段形状按读取方式标注，逐字段运行时校验）。 */
export interface ManagerStateDocument {
  version?: unknown;
  sources?: Record<string, boolean>;
  disabledSkills: Record<string, string[]>;
  enabledSkills: Record<string, string[]>;
  customRoots?: unknown;
  preferredSkills?: Record<string, unknown>;
  removedSources?: unknown;
}

/** 读状态文件的结果。 */
export interface ManagerStateReadResult {
  state: ManagerState;
  warning: SkillWarning | null;
  writable: boolean;
}

/** 单个技能的本地策略判定。 */
export interface SkillPolicy {
  override: boolean | undefined;
  sourceEnabled: boolean;
  modelInvocable: boolean;
  userInvocable: boolean;
  enabled: boolean;
}

/** rename 注入点与重试参数（测试可注入假实现）。 */
export interface RenameOptions {
  rename?: (source: string, destination: string) => Promise<unknown>;
  maxAttempts?: number;
  delayMs?: number;
}

/** 写操作可选参数（service 层透传）。 */
export interface WriteOptions {
  renameOptions?: RenameOptions;
  projectCwds?: string[];
}

/** 导入选项。 */
export interface ImportOptions {
  conflict?: unknown;
  dryRun?: unknown;
  renameOptions?: RenameOptions;
}

/** 根下既存条目路径。 */
export interface EntryPathTarget {
  path: string;
  fileName: string;
  recursive: boolean;
}

/** 回收站条目的来源元数据（恢复时据此放回原处）。 */
export interface TrashRootMetadata {
  key: string;
  scope: "user" | "project";
  kind?: string;
  projectRoot?: string;
  projectName?: string;
  label: string;
}

/** 回收站条目元数据（磁盘 JSON，校验后使用）。 */
export interface TrashMetadata {
  version?: number;
  id: string;
  name: string;
  deletedAt?: string;
  entries: string[];
  root?: TrashRootMetadata;
}

/** 导入来源分析结果（字段随 kind 不同）。 */
export type SourceAnalysis =
  | {
      kind: "none";
      error: string;
      code: string;
      params?: Record<string, unknown>;
    }
  | {
      kind: "single";
      source: string;
      rawName: string;
      kebab: string;
      isDir: boolean;
      skillFile: string;
    }
  | { kind: "batch"; source: string; rawName: string; isDir: true };

/** 一个待导入候选。 */
export interface ImportCandidate {
  source: string;
  kebab: string;
  rawName: string;
  isDir: boolean;
}

/** 预检目标：待导入 / 既存冲突共用 source。 */
export interface ImportSourceRef {
  source: string;
}

/** 待导入条目。 */
export interface ImportPending {
  name: string;
  source: string;
  isDir: boolean;
  dest: string;
}

/** 与目标同名的既存条目。 */
export interface ImportConflict {
  name: string;
  source: string;
  isDir: boolean;
  paths: string[];
}

/** 导入失败明细。 */
export interface ImportFailure {
  source?: string;
  error: string;
  code?: string;
  params?: unknown;
}

/** 导入成功明细。 */
export interface ImportImported {
  name: string;
  overwritten: boolean;
  warnings: SkillWarning[];
}

/** 导入跳过明细。 */
export interface ImportSkipped {
  name: string;
  source: string;
}

/** 上传条目路径解析结果。 */
export interface UploadPath {
  path: string;
  directory: boolean;
}

/** 同名分组的最小条目形状（root + entry）。 */
export interface RootedEntry {
  root: SkillSource;
  entry: SkillEntry;
}

/** 状态快照里的技能行（markWinners 会补写视图字段）。 */
export interface StateSkill {
  name: string;
  declaredName: string;
  kind: string;
  description: string;
  modelInvocable: boolean;
  userInvocable: boolean;
  invocationPolicyValid: boolean;
  hasFrontmatter: boolean;
  loadable: boolean;
  managerEnabled: boolean;
  managerOverride: boolean | null;
  effectiveModelInvocable: boolean;
  effectiveUserInvocable: boolean;
  diagnostics: SkillDiagnostic[];
  path: string;
  preferred?: boolean;
  /**
   * 被同名赢家覆盖。
   *
   * `enabled` 是**赢家**的启用状态（不是本条目的）：赢家被停用时，本条同样不会生效 ——
   * 停用不参与选赢家、停用赢家仍要挡住低优先级副本（见 `listProviderCandidates` 的注释），
   * 所以「被覆盖」不等于「另一份在跑」。界面据此选文案（2026-09-30 审查 F8）。
   */
  shadowedBy?: { root: string; name: string; enabled: boolean };
  winner?: boolean;
  enabled?: boolean;
  canonicalName?: string;
}

/** 状态快照里的来源行。 */
export interface StateRoot {
  key: string;
  path: string;
  label: string;
  mutable: boolean;
  deletable: boolean;
  removable: boolean;
  custom: boolean;
  defaultSource: boolean;
  toggleable: boolean;
  native: boolean;
  rank: number;
  scope: string;
  kind?: string;
  localeKey?: string;
  projectRoot?: string;
  projectName?: string;
  workspaceCwds?: string[];
  exists: boolean;
  truncated: boolean;
  removed: boolean;
  enabled: boolean;
  skills: StateSkill[];
}

/** 状态快照里参与同名决胜的条目。 */
export interface StateItem {
  root: SkillSource;
  entry: SkillEntry;
  managerEnabled: boolean;
  policy: SkillPolicy;
  view: StateSkill;
}

/** markWinners 选项。 */
export interface MarkWinnersOptions {
  preferred?: Record<string, string> | null;
  markShadowed?: boolean;
  markWinner?: boolean;
}

/** 状态快照里的项目分组。 */
export interface StateProject {
  root?: string;
  name?: string;
  workspaceCwds?: string[];
}

/** 状态快照计数。 */
export interface StateSummary {
  total: number;
  enabled: number;
  disabled: number;
  issues: number;
}

/** state() 返回的状态快照。 */
export interface StateResult {
  roots: StateRoot[];
  projects: StateProject[];
  trash: TrashMetadata[];
  warnings: SkillWarning[];
  summary?: StateSummary;
}

/** manager provider 候选。 */
export interface ProviderCandidate {
  name: string;
  description: string;
  invocation: { modelInvocable: boolean; userInvocable: boolean };
  provider: string;
  source: string;
  rank: number;
  locator: {
    rootKey: string;
    entryName: string;
    path: string;
    realEntryPath: string;
    realDocPath: string;
  };
  resourceBase: { kind: "directory"; path: string };
  path: string;
  metadata: {
    dshSkillsManager: {
      root: string;
      readOnly: boolean;
      sourceReadOnly: boolean;
      policyOnly: boolean;
    };
  };
}

/** 技能启停回执（`ok` 恒不出现，与 FailureResult 组成判别联合供调用方收窄）。 */
export interface SkillToggleResult {
  ok?: true;
  root: string;
  name: string;
  enabled: boolean;
}

/** 新建技能回执。 */
export interface CreateSkillResult {
  ok?: true;
  name: string;
  path: string;
  root: string;
}

/** 回收站恢复回执。 */
export interface TrashRestoreResult {
  ok?: true;
  id: string;
  name: string;
  root: TrashRootMetadata;
}