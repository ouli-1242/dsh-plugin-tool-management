// dsh-plugin-tool-management core —— 纯 Node 技能文件管理核心（仅 ZIP 解压使用 fflate，可独立单测）
// 移植自 dsh-skills-manager 的 core（Apache-2.0）；来源裁剪为 DSH / Agents / Codex / Claude。
//
// 覆盖 DSH 用户级与活动 Session 项目级技能根：
//   - 用户根目录：~/.dsh/skills、~/.agents/skills、~/.codex/skills、~/.claude/skills
//   - 项目根目录：<project>/.dsh/skills（可启停、创建、回收）、<project>/.agents/skills（本地策略启停、源文件只读）
//   - 条目形态：<root>/<name>/SKILL.md（bundle）或 <root>/<name>.md（flat），只读来源递归发现，可写来源只扫一层
//   - 前端展示 name、description 与启停状态，不做格式检查或自动修复
//
// 所有函数返回普通结果对象，业务校验失败返回 { ok: false, error, code?, params? }；
// error 保持中文原文（兼容性红线），code 为点分小写业务错误码，params 供前端词典占位符替换；
// 系统异常（fs ENOENT 等）透传 String(e.message)，不加 code。
// 文件写入错误由路由返回给调用方。

import { homedir } from "node:os";
import {
  join,
  basename,
  dirname,
  resolve,
  isAbsolute,
} from "node:path";
import {
  promises as fs,
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import {
  discoverReadonlyEntries,
  validDiscoveryName,
} from "./readonly-discovery.js";
import { isSameOrDescendant, isValidSegment } from "../paths.js";
import type {
  CreateSkillResult,
  CustomRoot,
  EntryLocation,
  EntryPathTarget,
  FailureResult,
  ImportCandidate,
  ImportConflict,
  ImportFailure,
  ImportImported,
  ImportOptions,
  ImportPending,
  ImportSkipped,
  ImportSourceRef,
  LogFn,
  ManagerState,
  ManagerStateDocument,
  ManagerStateReadResult,
  MarkWinnersOptions,
  ProjectRootProbe,
  ProjectSource,
  ProjectSourceCommon,
  ProviderCandidate,
  RenameOptions,
  RootInput,
  RootedEntry,
  ScanOptions,
  ScanResult,
  SkillDiagnostic,
  SkillDoc,
  SkillEntry,
  SkillPolicy,
  SkillSource,
  SkillSummary,
  SkillToggleResult,
  SkillWarning,
  SourceAnalysis,
  StateItem,
  StateProject,
  StateResult,
  StateRoot,
  StateSkill,
  StateSummary,
  TrashMetadata,
  TrashRestoreResult,
  TrashRootMetadata,
  UploadPath,
  WritableRootResult,
  WriteOptions,
} from "./core-types.js";
import {
  OFFICE_SKILL_NAMES,
  OFFICIAL_SOURCE_KEY,
  officialOfficeRuntimeSection,
  officialSkillRoot,
} from "./official.js";
import { resolveAgentsHome, resolveDshHome } from "./homes.js";
import { parseSkillDoc, toKebab, unquote } from "./frontmatter.js";

// 拆出去的公开函数照旧挂在 core.js 上（tools/skills.ts 引 toKebab，memories/* 与 ops/memory.ts
// 引 parseSkillDoc / unquote，契约测试也按 lib/skills/core.js 取它们）。
export { parseSkillDoc, toKebab, unquote } from "./frontmatter.js";

// 官方内置技能段与 home 解析拆到同目录的 official.ts / homes.ts 后，core.js 的公开面照旧
// （hub.ts、memories/*、subagents/service.ts 都按 ../skills/core.js 引 resolveDshHome）。
export { resolveAgentsHome, resolveDshHome } from "./homes.js";

// 业务错误码 / 条目路径谓词 / 可恢复 rename 的重试这一层 2026-10-01 剥到 ./core-util.js：
// 这几件被导入链路与技能读写**两侧同时**用到，留在本文件里就意味着任何搬出去的段都要反过来
// 引 core —— 那是运行时环。搬到这里，两侧都只向下引这一层。公开面照旧：entryPath 与
// renameWithRetry 仍有外部引方（index.ts 按 ./skills/core.js 引 renameWithRetry）。
export { entryPath, renameWithRetry } from "./core-util.js";
// 来源与路径底座（四来源 / 项目级来源 / root-state-trash 路径 / 路径比较口径）2026-10-01
// 剥到 ./skill-roots.js。那一层只向下引 ./official.js / ./homes.js / ./core-util.js，
// 不回引本文件；userRoots / projectRoots / trashRootPath 有外部引方（service.ts、
// system-trash.ts），而 core.js 的公开面里还挂着另外四件 —— 全部照旧从 core.js 出口走。
export {
  customRootKey,
  isDefaultSkillSource,
  managerHomePath,
  managerStatePath,
  projectRoots,
  trashRootPath,
  userRoots,
} from "./skill-roots.js";
import {
  customRootKey,
  dshRootPath,
  isDefaultSkillSource,
  managerHomePath,
  managerStatePath,
  overlapsUserSkillRoot,
  projectIdentity,
  projectRoots,
  projectSourceSafe,
  readonlyError,
  resolvedPath,
  rootByKey,
  rootDefinition,
  skillCreateRootPath,
  trashRootPath,
  userRoots,
} from "./skill-roots.js";
// 导入预检链路（来源读成候选 / 拒符号链 / 临时件拷贝 / 原子替换）2026-10-01 剥到
// ./import-pipeline.js。那一层只向下引 core-util.js、不回引本文件，所以这一侧引它是单向的。
import {
  analyzeSource,
  collectCandidates,
  MAX_SOURCE_DEPTH,
  preflightCandidates,
  replaceWithCopy,
} from "./import-pipeline.js";
import {
  attachCode,
  codedError,
  entryPath,
  lstatOrNull,
  renameWithRetry,
  MAX_ENTRY_NAME_LENGTH,
  pathIdentity,
  temporaryPath,
  TRANSIENT_RENAME_CODES,
} from "./core-util.js";

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECT_ROOT_KEY_RE = /^project-(?:dsh|agents):[a-f0-9]{16}$/;
const CUSTOM_ROOT_KEY_RE = /^custom-[a-f0-9]{16}$/;
const USER_DSH_POLICY_RANK = 399;
const WINDOWS_DEVICE_NAME_RE =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_BROWSE_ENTRIES = 500;
const MAX_UPLOAD_ARCHIVE_BYTES = 32 << 20;
const MAX_UPLOAD_ENTRY_BYTES = 32 << 20;
const MAX_UPLOAD_TOTAL_BYTES = 64 << 20;
const MAX_UPLOAD_ENTRIES = 1000;
const MAX_UPLOAD_PATH_LENGTH = 512;

/**
 * DSH 与外部 Agent 的用户级技能目录（4 个来源；外部来源由 manager provider 接入）。
 *
 * rank 与官方 filesystem provider 的用户级优先级衔接：DSH=400、Agents=500。
 * manager provider 以 450 接管公共 Agents（仍低于 DSH），Codex/Claude 依次排在其后。
 * DSH 之后紧随官方内置来源（随宿主注入会话的内置技能，见 materializeOfficialSkills；
 * 无可用源头时自然缺席）。
 */

/**
 * 默认来源：插件自己的读写根 —— `dsh`（官方技能目录）与 `hub`（新建/导入落点）。
 *
 * 用户裁定的是**不对称**语义，两个方向必须成对记住，只改一半就是漏改：
 *
 *   - 来源**路径**：必须读取。既不能「移除来源」（连目录都不扫），也不能「停用来源」
 *     （仍然扫描但仍算不读取的策略位）—— 界面上没有来源开关，服务端也拒绝这两个写操作。
 *     因为它们是插件自己的读写根：移除会让创建/导入无处落脚。
 *   - 路径**里面的技能**：可以删除（`deletable: true`，移入插件回收站，可恢复）。
 *
 * 其余来源（外部 Agent / 自定义绝对路径 / 项目级）恰好相反：来源可以停用或移除
 * （「不再读取这个文件夹」），但目录里的技能只读、不可删除。
 *
 * 一句话记法：**`mutable` 与 `deletable` 同向，`removable` 与 `mutable` 反向。**
 */

/** 是否为默认来源。接受 root 对象或 key 字符串；`dsh` / `hub` / `official` 的所有特判都走这里。 */

// ── 自定义技能目录（用户在管理页添加的任意只读来源）─────────────────────────
//
// 存储在 manager 状态文件的 customRoots 数组：{ key, path, label? }。
// key 由路径哈希派生（custom-<sha256-16>），因此 key 恒等于路径的身份；
// 目录以只读来源接入（bundle / flat / 递归发现，与 agents/codex/claude 同一
// 通道），启停走 sources 全局开关，停用某个技能走 disabledSkills 策略，
// 均不改源文件。

/** 由目录路径派生稳定的自定义来源 key。 */

/** 从状态值解析自定义来源定义；非法条目静默丢弃，key 与 path 不匹配的不信任。 */
export function customRootsFromState(stateValue: unknown): SkillSource[] {
  const state = stateValue as { customRoots?: unknown } | null | undefined;
  const list =
    state && Array.isArray(state.customRoots) ? state.customRoots : [];
  const out: SkillSource[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const path = typeof item.path === "string" ? item.path : "";
    const key = typeof item.key === "string" ? item.key : "";
    if (!isAbsolute(path) || !CUSTOM_ROOT_KEY_RE.test(key)) continue;
    if (key !== customRootKey(path)) continue;
    out.push({
      key,
      path,
      label:
        typeof item.label === "string" && item.label.trim()
          ? item.label.trim().slice(0, 64)
          : "自定义目录",
      // 用户加进来的来源（相对「按约定发现」的 dsh / hub / agents / codex / claude）：
      // 界面据此决定要不要给「永久删除」——只有自定义来源能真正从插件里删掉记录。
      custom: true,
      mutable: false,
      toggleable: true,
      native: false,
      scope: "user",
      rank: 600,
    });
  }
  return out;
}

/**
 * 添加自定义技能目录：要求绝对路径、真实存在的目录、与任何已知来源
 * （用户根 + 现有自定义根）不重叠——重叠来源会绕过停用策略。
 */
export async function addCustomRoot(
  inputPath: unknown,
  label: unknown,
  log: LogFn | undefined,
) {
  const requested = String(inputPath == null ? "" : inputPath).trim();
  if (!requested || !isAbsolute(requested))
    return {
      ok: false,
      error: `目录路径必须是绝对路径: ${requested}`,
      code: "error.custom.absolute",
      params: { path: requested },
    };
  let canonical;
  try {
    canonical = await fs.realpath(requested);
    const st = await fs.stat(canonical);
    if (!st.isDirectory())
      return {
        ok: false,
        error: `不是目录: ${canonical}`,
        code: "error.custom.notDirectory",
        params: { path: canonical },
      };
  } catch {
    return {
      ok: false,
      error: `无法读取目录: ${requested}`,
      code: "error.custom.unreadable",
      params: { path: requested },
    };
  }
  const current = await readManagerState();
  if (current.writable === false) return invalidManagerStateWrite();
  const existing = customRootsFromState(current.state);
  for (const known of userRoots()
    .map((root) => root.path)
    .concat(existing.map((root) => root.path))) {
    if (await pathsOverlap(canonical, known))
      return {
        ok: false,
        error: `目录与已有技能来源重叠: ${canonical} ↔ ${known}`,
        code: "error.custom.overlap",
        params: { path: canonical, other: known },
      };
  }
  const key = customRootKey(canonical);
  const cleanLabel = String(label == null ? "" : label).trim().slice(0, 64);
  const entry: CustomRoot = { key, path: canonical };
  if (cleanLabel) entry.label = cleanLabel;
  current.state.customRoots = [...existing.map((root) => ({ key: root.key, path: root.path, ...(root.label !== "自定义目录" ? { label: root.label } : {}) })), entry];
  // 新来源默认启用；用户可随后用来源开关停用。
  current.state.sources[key] = true;
  await writeManagerState(current.state);
  if (log) log("custom-add", `添加自定义技能目录 ${canonical} (${key})`);
  return { key, path: canonical, label: cleanLabel || "自定义目录" };
}

/** 移除自定义来源及其全部策略键（技能源文件不受影响）。 */
export async function removeCustomRoot(key: unknown, log: LogFn | undefined) {
  const clean = String(key == null ? "" : key).trim();
  if (!CUSTOM_ROOT_KEY_RE.test(clean))
    return {
      ok: false,
      error: `非法的自定义来源 key: ${clean}`,
      code: "error.custom.invalidKey",
      params: { key: clean },
    };
  const current = await readManagerState();
  if (current.writable === false) return invalidManagerStateWrite();
  const remaining = customRootsFromState(current.state);
  const target = remaining.find((root) => root.key === clean);
  if (!target)
    return {
      ok: false,
      error: `自定义来源不存在: ${clean}`,
      code: "error.custom.notFound",
      params: { key: clean },
    };
  current.state.customRoots = remaining
    .filter((root) => root.key !== clean)
    .map((root) => ({
      key: root.key,
      path: root.path,
      ...(root.label !== "自定义目录" ? { label: root.label } : {}),
    }));
  delete current.state.sources[clean];
  delete current.state.disabledSkills[clean];
  delete current.state.enabledSkills[clean];
  // 已移除记录一起清掉：否则「永久删除」之后状态文件里还留着一条指向不存在来源的脏键
  // （读取时的 normalize 会丢弃它，但没理由写进去）。
  if (Array.isArray(current.state.removedSources))
    current.state.removedSources = current.state.removedSources.filter(
      (key) => key !== clean,
    );
  await writeManagerState(current.state);
  if (log) log("custom-remove", `移除自定义技能目录 ${target.path} (${clean})`);
  return { key: clean, path: target.path };
}

/**
 * 从活动 Session cwd 推导项目技能根。只接受宿主上可解析的绝对目录，
 * 同一项目的多个 Session 会折叠到同一组稳定 key，避免跨 workspace 合并同名技能。
 */

/** 技能回收站：与其余四类同形（`hub/trash/<域>-trash/`）。 */

/** 插件日志（滚动 `.1`）：收在 hub 内，不再躺在 `$DSH_HOME` 根下。 */
export function logPath() {
  return join(managerHomePath(), "tool-management.log");
}

/**
 * 为前端内嵌目录选择器列出一个本机目录层级。
 * 不跟随目录符号链接；选择后的导入仍由 importSkill 做完整安全校验。
 */
export async function browseDirectories(inputPath: unknown) {
  const requested = String(inputPath == null ? "" : inputPath).trim();
  const target = requested === "" ? homedir() : requested;
  if (!isAbsolute(target)) {
    return {
      ok: false,
      error: `目录路径必须是绝对路径: ${target}`,
      code: "error.browse.absolute",
      params: { path: target },
    };
  }

  let canonical;
  let directory;
  try {
    canonical = await fs.realpath(target);
    directory = await fs.stat(canonical);
  } catch (error: any) {
    // 系统异常按可选 message 读取，保持既有判定分支不变。
    return {
      ok: false,
      error: `无法读取目录: ${target}`,
      code: "error.browse.unreadable",
      params: {
        path: target,
        error: String(error && error.message ? error.message : error),
      },
    };
  }
  if (!directory.isDirectory()) {
    return {
      ok: false,
      error: `不是目录: ${target}`,
      code: "error.browse.notDirectory",
      params: { path: target },
    };
  }

  const entries = [];
  let truncated = false;
  try {
    const items = await fs.readdir(canonical, { withFileTypes: true });
    for (const item of items) {
      // 目录链接不在浏览器中展开，避免选择器在不知情时跨越到另一棵目录树。
      if (!item.isDirectory() || item.isSymbolicLink()) continue;
      // Dirent 来自一次目录快照；再用 lstat 校验当前条目，既收紧 TOCTOU 窗口，
      // 也明确排除 Windows junction 等重解析目录。
      const childPath = join(canonical, item.name);
      const childStat = await lstatOrNull(childPath);
      if (!childStat || !childStat.isDirectory() || childStat.isSymbolicLink())
        continue;
      if (entries.length >= MAX_BROWSE_ENTRIES) {
        truncated = true;
        break;
      }
      entries.push({
        name: item.name,
        path: childPath,
        hidden: item.name.startsWith("."),
      });
    }
  } catch (error: any) {
    // 系统异常按可选 message 读取，保持既有判定分支不变。
    return {
      ok: false,
      error: `无法读取目录: ${canonical}`,
      code: "error.browse.unreadable",
      params: {
        path: canonical,
        error: String(error && error.message ? error.message : error),
      },
    };
  }
  entries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
      numeric: true,
    }),
  );

  const crumbs = [];
  let cursor = canonical;
  for (;;) {
    const parent = dirname(cursor);
    crumbs.unshift({
      name: parent === cursor ? cursor : basename(cursor),
      path: cursor,
      hidden: false,
    });
    if (parent === cursor) break;
    cursor = parent;
  }
  return { path: canonical, home: homedir(), crumbs, entries, truncated };
}

/**
 * v0.4 新建/导入技能的落点：hub 内 `tool-management/skills/`（用户要求插件产物集中）。
 * hub 根缺失（旧版本状态文件/异常）时退回官方 DSH 技能目录，保证创建功能永不因布局变化而失效。
 */

/** 只读来源的拒绝结果；action 为可翻译语义值（toggle/delete）。 */

/**
 * 来源可写但**没有删除权**时的拒绝结果 —— 防御性分支。
 *
 * 来源表里可写的三种根（dsh / hub / 项目级 `.dsh/skills`）现在都带 `deletable: true`，
 * 正常路径走不到这里。它守的是「以后新增可写来源时忘了标 deletable」：那种情况下
 * 必须拒绝删除，而不是照搬一个用户目录进回收站。
 */
function notDeletableError(
  definition: SkillSource | null | undefined,
): FailureResult {
  return {
    ok: false,
    code: "error.skill.notDeletable",
    params: { root: definition && definition.key ? definition.key : "" },
    error:
      "该来源没有开启删除（可写来源需要显式标记 deletable: true 才提供删除）",
  };
}

/**
 * 默认来源（dsh / hub）被要求「停用」或「移除」时的拒绝结果。
 *
 * 这两种来源是插件自己的读写根，**必须读取**：停用会让它退化成"读出来但不可调用"，
 * 移除则连目录都不扫，两者都与「路径不能不读取」冲突。
 *
 * 被拒的只有**来源层**操作 —— 来源**里面的技能**照常可以删除（那是 `deletable`，
 * 与来源的 removable / 停用无关），提示里要写清这一点，否则用户会以为整个来源被锁死。
 */
function reservedSourceError(
  root: SkillSource | null | undefined,
): FailureResult {
  const key = root && root.key ? root.key : "";
  const origin =
    key === "dsh"
      ? "DSH 技能目录是默认来源，必须读取"
      : key === "hub"
        ? "导入技能目录是默认来源、插件新建/导入的落点，必须读取"
        : "官方内置技能目录随宿主发布，不能移除（移除只会让插件失去管理权）";
  return {
    ok: false,
    code: "error.source.reserved",
    params: { root: key, origin },
    error: `${origin}：不能停用或移除（里面的技能可以删除）`,
  };
}

/** 只允许用户 DSH 根 / hub 根，或由活动 Session 推导出的项目 DSH 根参与文件写入。 */
function writableRootDefinition(root: RootInput): SkillSource | null {
  const definition = rootDefinition(root);
  if (!definition || definition.mutable !== true) return null;
  if (definition.key === "dsh")
    return resolve(definition.path) === resolve(dshRootPath())
      ? rootByKey("dsh")
      : null;
  // v0.4：hub 内技能目录同为用户级可写根（插件新建/导入的落点）。
  if (definition.key === "hub")
    return resolve(definition.path) === resolve(skillCreateRootPath())
      ? rootByKey("hub")
      : null;
  if (
    definition.scope !== "project" ||
    definition.kind !== "project-dsh" ||
    typeof definition.projectRoot !== "string" ||
    !isAbsolute(definition.projectRoot) ||
    definition.key !==
      `project-dsh:${projectIdentity(definition.projectRoot)}` ||
    resolve(definition.path) !==
      resolve(join(definition.projectRoot, ".dsh", "skills"))
  )
    return null;
  return definition;
}

async function checkedWritableRootDefinition(
  root: RootInput,
): Promise<WritableRootResult> {
  const definition = writableRootDefinition(root);
  if (!definition || definition.scope !== "project") return definition;
  if (await overlapsUserSkillRoot(definition.path)) {
    return {
      ok: false,
      error: `项目技能目录与用户技能目录重叠，拒绝写入: ${definition.path}`,
      code: "error.root.unsafe",
      params: { path: definition.path },
    };
  }
  // 项目仓库内容不可信；拒绝通过 .dsh 或 skills 链接把写入重定向到项目之外。
  // definition.scope === "project" 时 projectRoot 必有值（见 ProjectSource），断言只为让类型收敛。
  for (const path of [
    join(definition.projectRoot as string, ".dsh"),
    definition.path,
  ]) {
    const st = await lstatOrNull(path);
    if (st && (!st.isDirectory() || st.isSymbolicLink())) {
      return {
        ok: false,
        error: `项目技能目录不安全，拒绝写入: ${path}`,
        code: "error.root.unsafe",
        params: { path },
      };
    }
  }
  return definition;
}

/** 解析真实路径；中间若有目录链接，按落地目录比较重叠。 */

/** 即使末级路径尚不存在，也解析最近既存祖先中的链接，供权限域重叠判断。 */

/** 两个路径重叠时，覆盖导入可能删除自身来源，必须拒绝。 */
async function pathsOverlap(a: string, b: string): Promise<boolean> {
  const left = await resolvedPath(a);
  const right = await resolvedPath(b);
  return isSameOrDescendant(left, right) || isSameOrDescendant(right, left);
}

/** 预解析技能根后的根内校验，供逐条目扫描复用同一次 realpath，减少重复 IO。 */
async function isInsideResolvedRoot(
  rootReal: string,
  path: string,
): Promise<boolean> {
  return isSameOrDescendant(rootReal, await resolvedPath(path));
}

function isDshRoot(root: unknown): boolean {
  return typeof root === "string" && resolve(root) === resolve(dshRootPath());
}

async function removeMovedPath(path: string): Promise<void> {
  const st = await lstatOrNull(path);
  if (!st) return;
  if (st.isDirectory() && !st.isSymbolicLink())
    await fs.rm(path, { recursive: true, force: false });
  else await fs.unlink(path);
}

/** rename 跨盘返回 EXDEV 时：先完整复制，再在源盘原子隐藏源条目，最后清理隐藏副本。 */
async function movePathWithFallback(
  source: string,
  destination: string,
  options: RenameOptions = {},
) {
  try {
    await renameWithRetry(source, destination, options);
    return { copied: false, cleanupError: null };
  } catch (error: any) {
    // 系统异常按可选 code 读取，保持既有 EXDEV 判定。
    if (!error || error.code !== "EXDEV") throw error;
  }

  const quarantine = join(
    dirname(source),
    `.${basename(source)}.dssm-move-${randomUUID()}`,
  );
  try {
    await fs.cp(source, destination, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    // 源与 quarantine 位于同一目录；成功后原技能名立即消失，避免递归删除留下半份可见条目。
    await renameWithRetry(source, quarantine, options);
  } catch (error) {
    await removeMovedPath(destination).catch(() => undefined);
    throw error;
  }

  let cleanupError = null;
  try {
    await removeMovedPath(quarantine);
  } catch (error: any) {
    // 调用方按可选 message 读取该清理异常，保持既有告警文案。
    cleanupError = error;
  }
  return { copied: true, cleanupError, quarantine };
}

async function writeFileAtomically(
  path: string,
  content: string,
): Promise<void> {
  const temp = join(
    dirname(path),
    `.${basename(path)}.dssm-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temp, content, "utf8");
    // Windows 上目标文件会被杀软/索引器短暂占住（EPERM/EACCES/EBUSY）——
    // 场景模式进出时这里写的是技能来源/策略状态，rename 被撞 = 运行时已切、
    // 状态没落盘。与 memories-index.json 同一处理：重试瞬时占用，全失败才抛。
    await renameWithRetry(temp, path);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 解析布尔字段值；合法布尔返回 true/false，非法返回 undefined。 */
export function parseBoolValue(raw: unknown): boolean | undefined {
  const v = unquote(raw).trim().toLowerCase();
  if (v === "true" || v === "yes" || v === "on" || v === "1") return true;
  if (v === "false" || v === "no" || v === "off" || v === "0") return false;
  return undefined;
}

// ── 条目定位 / 扫描 ─────────────────────────────────────────────────────────

/** 按名称解析条目（bundle 优先，其次 flat）。找不到返回 null。 */
export async function resolveEntry(
  root: RootInput,
  name: string,
): Promise<EntryLocation | null> {
  const definition = rootDefinition(root);
  if (definition && !definition.mutable) {
    if (!validDiscoveryName(name)) return null;
    return (
      (await discoverReadonlyEntries(definition.path)).entries.find(
        (entry) => entry.name === name,
      ) || null
    );
  }
  // 传入 definition 对象时取它的 path；其余情况按 key 字符串处理。
  root = definition ? definition.path : (root as string);
  try {
    const bundlePath = entryPath(root, name);
    if (bundlePath === null) return null;
    const rootPath = resolve(root);
    const rootStat = await lstatOrNull(rootPath);
    if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink())
      return null;
    const rootReal = await resolvedPath(rootPath);
    const bundleStat = await lstatOrNull(bundlePath);
    if (
      bundleStat &&
      bundleStat.isDirectory() &&
      !bundleStat.isSymbolicLink()
    ) {
      const bundleDoc = join(bundlePath, "SKILL.md");
      const docStat = await lstatOrNull(bundleDoc);
      if (
        docStat &&
        docStat.isFile() &&
        !docStat.isSymbolicLink() &&
        (await isInsideResolvedRoot(rootReal, bundleDoc))
      ) {
        return {
          kind: "bundle",
          docPath: bundleDoc,
          entryPath: bundlePath,
          realDocPath: await fs.realpath(bundleDoc),
          realEntryPath: await fs.realpath(bundlePath),
          linked: false,
        };
      }
    }
    const flatDoc = resolve(rootPath, `${name}.md`);
    if (!isSameOrDescendant(rootPath, flatDoc) || rootPath === flatDoc)
      return null;
    const flatStat = await lstatOrNull(flatDoc);
    if (
      flatStat &&
      flatStat.isFile() &&
      !flatStat.isSymbolicLink() &&
      (await isInsideResolvedRoot(rootReal, flatDoc))
    ) {
      const realDocPath = await fs.realpath(flatDoc);
      return {
        kind: "flat",
        docPath: flatDoc,
        entryPath: flatDoc,
        realDocPath,
        realEntryPath: realDocPath,
        linked: false,
      };
    }
    return null;
  } catch {
    // lstat 与 realpath/readFile 之间允许来源变化，调用方统一按不存在处理。
    return null;
  }
}

function entryOf(
  name: string,
  kind: "bundle" | "flat",
  docPath: string,
  doc: Pick<SkillDoc, "map" | "hasFrontmatter">,
): SkillSummary {
  const declaredName = doc.map.name !== undefined ? unquote(doc.map.name) : "";
  const description =
    doc.map.description !== undefined ? unquote(doc.map.description) : "";
  const modelValue = parseBoolValue(doc.map["disable-model-invocation"]);
  const userValue = parseBoolValue(doc.map["user-invocable"]);
  const modelDisabled = modelValue === true;
  const userDisabled = userValue === false;
  const invocationPolicyValid =
    (doc.map["disable-model-invocation"] === undefined ||
      modelValue !== undefined) &&
    (doc.map["user-invocable"] === undefined || userValue !== undefined);
  const diagnostics: SkillDiagnostic[] = [];
  if (!doc.hasFrontmatter)
    diagnostics.push({
      level: "error",
      code: "diagnostic.frontmatter.missing",
    });
  if (doc.hasFrontmatter && !declaredName)
    diagnostics.push({ level: "error", code: "diagnostic.name.missing" });
  else if (declaredName && !KEBAB_RE.test(declaredName))
    diagnostics.push({
      level: "error",
      code: "diagnostic.name.invalid",
      params: { name: declaredName },
    });
  if (doc.hasFrontmatter && !description)
    diagnostics.push({
      level: "error",
      code: "diagnostic.description.missing",
    });
  if (!invocationPolicyValid)
    diagnostics.push({ level: "error", code: "diagnostic.invocation.invalid" });
  return {
    name,
    declaredName,
    kind,
    docPath,
    description,
    modelInvocable: !modelDisabled,
    userInvocable: !userDisabled,
    invocationPolicyValid,
    hasFrontmatter: doc.hasFrontmatter,
    // 调用策略值异常可以由 manager 本地策略覆盖；结构本身合法即可加载。
    loadable:
      doc.hasFrontmatter && KEBAB_RE.test(declaredName) && description !== "",
    diagnostics,
  };
}

/** 只读来源递归发现；可写 DSH 根维持顶层扫描及链接写边界。 */
export async function scanEntries(
  root: RootInput,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const definition = rootDefinition(root);
  if (definition && !definition.mutable) {
    const discovered = await discoverReadonlyEntries(definition.path);
    // metadataOnly 时条目的摘要字段由调用方按需读取（见 visibleEntryForRoot）。
    if (options.metadataOnly) return discovered as unknown as ScanResult;
    const entries: SkillEntry[] = [];
    for (const entry of discovered.entries) {
      try {
        entries.push({
          ...entryOf(
            entry.name,
            entry.kind,
            entry.docPath,
            parseSkillDoc(await fs.readFile(entry.realDocPath, "utf8")),
          ),
          ...entry,
        });
      } catch {
        /* 忽略已失效或不可读技能。 */
      }
    }
    return { ...discovered, entries };
  }
  // 传入 definition 对象时取它的 path；其余情况按 key 字符串处理。
  root = definition ? definition.path : (root as string);
  const rootStat = await lstatOrNull(resolve(root));
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink())
    return { exists: false, entries: [] };
  let items;
  try {
    items = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { exists: false, entries: [] };
  }
  const byName = new Map<string, SkillEntry>();
  const rootReal = await resolvedPath(root);
  for (const it of items) {
    try {
      if (it.isSymbolicLink()) continue;
      if (it.isDirectory() && entryPath(root, it.name) !== null) {
        const docPath = join(root, it.name, "SKILL.md");
        const st = await lstatOrNull(docPath);
        if (
          !st ||
          !st.isFile() ||
          st.isSymbolicLink() ||
          !(await isInsideResolvedRoot(rootReal, docPath))
        )
          continue;
        const doc = options.metadataOnly
          ? { map: {}, hasFrontmatter: false }
          : parseSkillDoc(await fs.readFile(docPath, "utf8"));
        byName.set(it.name, {
          ...entryOf(it.name, "bundle", docPath, doc),
          entryPath: join(root, it.name),
          realDocPath: await fs.realpath(docPath),
          realEntryPath: await fs.realpath(join(root, it.name)),
          linked: false,
        });
      } else if (
        it.isFile() &&
        it.name.toLowerCase().endsWith(".md") &&
        it.name.toLowerCase() !== "skill.md" &&
        entryPath(root, it.name.slice(0, -3)) !== null
      ) {
        const skillName = it.name.slice(0, -3);
        if (byName.has(skillName)) continue;
        const docPath = join(root, it.name);
        if (!(await isInsideResolvedRoot(rootReal, docPath))) continue;
        const doc = options.metadataOnly
          ? { map: {}, hasFrontmatter: false }
          : parseSkillDoc(await fs.readFile(docPath, "utf8"));
        const realDocPath = await fs.realpath(docPath);
        byName.set(skillName, {
          ...entryOf(skillName, "flat", docPath, doc),
          entryPath: docPath,
          realDocPath,
          realEntryPath: realDocPath,
          linked: false,
        });
      }
    } catch {
      /* 跳过不可读条目 */
    }
  }
  const entries: SkillEntry[] = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return { exists: true, entries };
}

/** 同一真实技能优先归属直接 SSOT；同类条目再按来源 rank 决胜。 */
async function scanDeduplicatedRoots(
  roots: SkillSource[] = userRoots(),
  options: ScanOptions = {},
): Promise<Map<string, ScanResult>> {
  const results = await Promise.all(
    roots.map(
      async (root): Promise<[SkillSource, ScanResult]> => [
        root,
        await scanEntries(root, options),
      ],
    ),
  );
  const scans = new Map<string, ScanResult>();
  const groups = new Map<string, Array<{ root: SkillSource; entry: SkillEntry }>>();
  for (const [root, scan] of results) {
    scans.set(root.key, scan);
    for (const entry of scan.entries) {
      const identity = pathIdentity(
        entry.realEntryPath || entry.entryPath || entry.docPath,
      );
      const group = groups.get(identity) || [];
      group.push({ root, entry });
      groups.set(identity, group);
    }
  }
  const winners = new Set<SkillEntry>();
  for (const group of groups.values()) {
    group.sort(
      (left, right) =>
        Number(left.entry.linked) - Number(right.entry.linked) ||
        left.root.rank - right.root.rank,
    );
    const winner = group[0];
    winner.entry.providerRank = Math.min(
      ...group.map((item) => item.root.rank),
    );
    winner.entry.policyAliases = group.map((item) => ({
      rootKey: item.root.key,
      name: item.entry.name,
    }));
    winners.add(winner.entry);
  }
  for (const scan of scans.values()) {
    scan.entries = scan.entries.filter((entry) => winners.has(entry));
  }
  return scans;
}

/** 详情与列表共享路径去重，扫描定位信息时不读取无关技能正文。 */
async function visibleEntryForRoot(
  root: SkillSource,
  name: string,
): Promise<SkillEntry | null> {
  if (!validDiscoveryName(name)) return null;
  // custom 来源只扫自身（不在 userRoots 里，否则根本找不到条目）。
  const roots =
    root.scope === "project" || CUSTOM_ROOT_KEY_RE.test(root.key || "")
      ? [root]
      : userRoots();
  const scans = await scanDeduplicatedRoots(roots, { metadataOnly: true });
  return (
    scans.get(root.key)?.entries.find((entry) => entry.name === name) || null
  );
}

// ── Manager 本地策略（外部源只读，启停状态写入 DSH_HOME）────────────────────

function defaultManagerState(): ManagerState {
  const sources = Object.create(null);
  const disabledSkills = Object.create(null);
  const enabledSkills = Object.create(null);
  for (const root of userRoots()) {
    // 默认来源（dsh / hub）没有来源开关，所以不落进 sources 表 —— 它们永远「读取」。
    // 旧版本可能往这里写过 hub 的 false，normalizeManagerState 会顺手丢掉。
    if (!isDefaultSkillSource(root.key)) sources[root.key] = true;
    disabledSkills[root.key] = [];
    enabledSkills[root.key] = [];
  }
  return {
    version: 1,
    sources,
    disabledSkills,
    enabledSkills,
    customRoots: [],
    // 同名技能「首选来源」：技能名 → 来源 key。缺键 = 按来源 rank 取最高优先级者。
    preferredSkills: Object.create(null),
    // 用户从技能页「移除」的来源：插件**不再读取**这些目录（技能不出现在列表里，
    // 也不参与 provider 候选）。与「停用来源」不同——停用仍列出技能、只是不可调用。
    // 源文件一个字节都不动；清空这个数组即可恢复。
    removedSources: [],
  };
}

function validStateSkillName(name: unknown): boolean {
  return validDiscoveryName(name);
}

/**
 * 首选表的键是技能**声明名**（不是文件名）——声明名允许大小写与空格（此时技能本身带
 * name.invalid 诊断，但仍可被选择）。这里只做「能当 JSON 键、不像路径」的宽松校验，
 * 避免一个脏键把整份状态文件判为非法（那会让全部技能 fail-closed 停用）。
 */
function validPreferredSkillName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_ENTRY_NAME_LENGTH &&
    !name.includes("\0") &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

/** 状态文件已存在但不可用时一律关闭外部来源，避免损坏配置重新暴露技能。 */
function failClosedManagerState(): ManagerState {
  const state = defaultManagerState();
  for (const key of Object.keys(state.sources)) state.sources[key] = false;
  return state;
}

function validPolicyLists(value: unknown, allowMissing = false): boolean {
  if (value === undefined && allowMissing) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [key, list] of Object.entries(value)) {
    if (
      !userRoots().some((root) => root.key === key) &&
      !PROJECT_ROOT_KEY_RE.test(key)
    )
      continue;
    if (!Array.isArray(list) || list.some((name) => !validStateSkillName(name)))
      return false;
  }
  return true;
}

function validManagerStateDocument(value: ManagerStateDocument): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1
  )
    return false;
  if (
    !value.sources ||
    typeof value.sources !== "object" ||
    Array.isArray(value.sources)
  )
    return false;
  if (
    !validPolicyLists(value.disabledSkills) ||
    !validPolicyLists(value.enabledSkills, true)
  )
    return false;
  // 自定义来源列表：可选字段；容器必须是数组（条目级合法性由 normalize 逐条裁剪）。
  if (value.customRoots !== undefined && !Array.isArray(value.customRoots))
    return false;
  // 已移除的来源：可选字段；数组里的每一项必须能当来源 key 用。
  if (value.removedSources !== undefined) {
    if (
      !Array.isArray(value.removedSources) ||
      value.removedSources.some(
        (key) => typeof key !== "string" || key.length === 0 || key.length > 128,
      )
    )
      return false;
  }
  // 同名首选表：可选字段；只校验容器与值类型，键值逐条在 normalize 里裁剪（见 validPreferredSkillName）。
  if (value.preferredSkills !== undefined) {
    if (
      !value.preferredSkills ||
      typeof value.preferredSkills !== "object" ||
      Array.isArray(value.preferredSkills)
    )
      return false;
    for (const key of Object.values(value.preferredSkills))
      if (typeof key !== "string") return false;
  }
  for (const root of userRoots()) {
    if (isDefaultSkillSource(root.key)) continue;
    if (typeof value.sources[root.key] !== "boolean") return false;
    const list = value.disabledSkills[root.key];
    if (!Array.isArray(list) || list.some((name) => !validStateSkillName(name)))
      return false;
  }
  const enabledSkills = value.enabledSkills || ({} as Record<string, string[]>);
  for (const key of new Set([
    ...Object.keys(value.disabledSkills),
    ...Object.keys(enabledSkills),
  ])) {
    const disabled = new Set(value.disabledSkills[key] || []);
    if ((enabledSkills[key] || []).some((name) => disabled.has(name)))
      return false;
  }
  return true;
}

function normalizeManagerState(value: ManagerStateDocument): ManagerState {
  const normalized = defaultManagerState();
  if (!value || typeof value !== "object" || Array.isArray(value))
    return normalized;
  // 自定义来源先归一，其 sources/policy 键才有归属。
  normalized.customRoots = normalizeCustomRoots(value.customRoots);
  const customKeys = new Set(normalized.customRoots.map((root) => root.key));
  for (const root of userRoots()) {
    // 默认来源不接收 sources 标志：旧版本写过的 `sources.hub = false` 在这里被丢弃，
    // 于是「曾经把 hub 停用掉」的用户升级后自动回到必须读取的状态（技能不丢，只是策略位作废）。
    if (
      !isDefaultSkillSource(root.key) &&
      value.sources &&
      typeof value.sources[root.key] === "boolean"
    )
      normalized.sources[root.key] = value.sources[root.key];
    const list = value.disabledSkills && value.disabledSkills[root.key];
    if (Array.isArray(list))
      normalized.disabledSkills[root.key] = [
        ...new Set(list.filter((name) => validStateSkillName(name))),
      ].sort();
    const enabled = value.enabledSkills && value.enabledSkills[root.key];
    if (Array.isArray(enabled))
      normalized.enabledSkills[root.key] = [
        ...new Set(enabled.filter((name) => validStateSkillName(name))),
      ].sort();
  }
  if (value.sources && typeof value.sources === "object" && !Array.isArray(value.sources)) {
    for (const [key, flag] of Object.entries(value.sources)) {
      if (customKeys.has(key) && typeof flag === "boolean")
        normalized.sources[key] = flag;
    }
  }
  for (const field of ["disabledSkills", "enabledSkills"] as const) {
    const source = value[field];
    if (source && typeof source === "object" && !Array.isArray(source)) {
      for (const [key, list] of Object.entries(source)) {
        if (!PROJECT_ROOT_KEY_RE.test(key) && !customKeys.has(key)) continue;
        if (!Array.isArray(list)) continue;
        normalized[field][key] = [
          ...new Set(list.filter(validStateSkillName)),
        ].sort();
      }
    }
  }
  // 同名首选表：键必须是技能声明名、值必须指向一个已知来源（用户级 / 自定义 / 项目级），
  // 否则丢弃该条（源目录被移除后残留的首选会自然失效）。
  const preferred = value.preferredSkills;
  if (preferred && typeof preferred === "object" && !Array.isArray(preferred)) {
    for (const [name, rootKey] of Object.entries(preferred)) {
      if (!validPreferredSkillName(name) || typeof rootKey !== "string") continue;
      if (
        !userRoots().some((root) => root.key === rootKey) &&
        !customKeys.has(rootKey) &&
        !PROJECT_ROOT_KEY_RE.test(rootKey)
      )
        continue;
      normalized.preferredSkills[name] = rootKey;
    }
  }
  // 已移除的来源：只保留「确实是已知来源 key」的条目，其余丢弃（避免脏键让整份状态非法）。
  {
    const raw = Array.isArray(value.removedSources) ? value.removedSources : [];
    const known = new Set([
      ...userRoots().map((root) => root.key),
      ...customKeys,
    ]);
    normalized.removedSources = [
      ...new Set(
        raw.filter(
          (key) =>
            typeof key === "string" &&
            known.has(key) &&
            !isDefaultSkillSource(key),
        ),
      ),
    ].sort();
  }
  return normalized;
}

/**
 * 参与扫描的来源 = 全部来源 − 用户已移除的。
 *
 * 「移除来源」与「停用来源」是两件事：
 *   - 停用（`sources[key] = false`）：仍然读取并列出技能，只是不可调用；
 *   - 移除（出现在 `removedSources`）：**连目录都不读**，技能不出现在列表里，
 *     也不参与 provider 候选。源文件不动，清掉这个标记即恢复。
 */
export function activeUserRoots(stateValue: unknown): SkillSource[] {
  const state = stateValue as { removedSources?: unknown } | null | undefined;
  const removed = new Set(
    state && Array.isArray(state.removedSources) ? state.removedSources : [],
  );
  return userRoots().filter((root) => !removed.has(root.key));
}

/** 裁剪自定义来源列表：非法条目丢弃，key/path 绑定校验，label 规整。 */
function normalizeCustomRoots(value: unknown): CustomRoot[] {
  if (!Array.isArray(value)) return [];
  const out: CustomRoot[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const path = typeof item.path === "string" ? item.path : "";
    const key = typeof item.key === "string" ? item.key : "";
    if (!isAbsolute(path) || !CUSTOM_ROOT_KEY_RE.test(key)) continue;
    if (key !== customRootKey(path) || seen.has(key)) continue;
    seen.add(key);
    out.push(
      typeof item.label === "string" && item.label.trim()
        ? { key, path, label: item.label.trim().slice(0, 64) }
        : { key, path },
    );
  }
  return out;
}

/**
 * 读状态文件。
 *
 * **校验的是「归一化之后」的文档，不是磁盘上的原始 JSON** —— 这一条是踩出来的：
 * 校验器要求每个 `userRoots()` 来源都在 `sources` 里有布尔值、在 `disabledSkills` 里有数组，
 * 而来源列表会随版本增加（v0.4 加了 `hub` 来源）。于是**版本升级本身**就会把一份完好的旧
 * 状态文件判成「非法」，紧接着 fail-closed：所有来源停用、写入锁定，Skills 页弹
 * 「状态文件不可读，已拒绝覆盖」。文件其实一个字节都没坏。
 *
 * 归一化会把缺失的键补成默认值（新来源默认启用），所以「我们后来加过键」与「文件真的坏了」
 * 由此区分开：前者修复后通过，后者（不是对象、version 不是 1、字段类型不对）仍然拒绝。
 */
export async function readManagerState(): Promise<ManagerStateReadResult> {
  try {
    const raw = await fs.readFile(managerStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    // 版本号在归一化时不会被保留（恒为 1），所以要在解析结果上直接判：
    // 缺失按 1 处理（更早的文档没有这个字段），存在但不是 1 才判非法。
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && parsed.version !== undefined && parsed.version !== 1)
      throw codedError("invalid manager state schema", "error.state.invalid");
    // 结构守卫：字段**可以缺**（旧文档），但**一旦存在就必须形状正确**。
    // 少了这道守卫，归一化会把「类型写错」当成「键缺失」一起补默认值——于是 `sources: []`
    // 或 `disabledSkills: { dsh: "x" }` 这种真损坏反而被自愈放行，静默丢掉文件里的策略。
    // 契约：**缺键自愈（我们后来加过的东西），类型错必须报错。**
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const field of ["sources", "disabledSkills", "enabledSkills"]) {
        const value = parsed[field];
        if (value === undefined) continue;
        if (value === null || typeof value !== "object" || Array.isArray(value))
          throw codedError("invalid manager state schema", "error.state.invalid");
        // 策略表的每个桶必须是数组（条目级合法性仍由 normalize 逐条裁剪）。
        if (field === "disabledSkills" || field === "enabledSkills") {
          for (const bucket of Object.values(value))
            if (!Array.isArray(bucket))
              throw codedError("invalid manager state schema", "error.state.invalid");
        }
      }
    }
    const normalized = normalizeManagerState(parsed);
    if (!validManagerStateDocument(normalized))
      throw codedError("invalid manager state schema", "error.state.invalid");
    return {
      state: normalized,
      warning: null,
      writable: true,
    };
  } catch (error: any) {
    // 系统异常按可选 code 读取，保持既有 ENOENT 判定。
    if (error && error.code === "ENOENT")
      return { state: defaultManagerState(), warning: null, writable: true };
    return {
      state: failClosedManagerState(),
      writable: false,
      warning: {
        code: "warning.state.invalid",
        params: { path: managerStatePath() },
        error: `技能管理器状态文件不可读，所有技能已安全停用且状态写入已锁定: ${managerStatePath()}`,
      },
    };
  }
}

async function writeManagerState(value: ManagerState): Promise<void> {
  await fs.mkdir(managerHomePath(), { recursive: true });
  await writeFileAtomically(
    managerStatePath(),
    `${JSON.stringify(normalizeManagerState(value), null, 2)}\n`,
  );
}

function managerSkillOverride(
  policy: ManagerState,
  rootKey: string,
  name: string,
  policyAliases: { rootKey: string; name: string }[] = [],
): boolean | undefined {
  if ((policy.enabledSkills[rootKey] || []).includes(name)) return true;
  if ((policy.disabledSkills[rootKey] || []).includes(name)) return false;
  let inheritedEnable = false;
  for (const alias of policyAliases) {
    if (alias.rootKey === rootKey && alias.name === name) continue;
    if ((policy.disabledSkills[alias.rootKey] || []).includes(alias.name))
      return false;
    if ((policy.enabledSkills[alias.rootKey] || []).includes(alias.name))
      inheritedEnable = true;
  }
  if (inheritedEnable) return true;
  return undefined;
}

function effectiveSkillPolicy(
  policyResult: ManagerStateReadResult,
  root: SkillSource,
  entry: SkillEntry,
): SkillPolicy {
  const override = managerSkillOverride(
    policyResult.state,
    root.key,
    entry.name,
    entry.policyAliases,
  );
  const sourceEnabled =
    isDefaultSkillSource(root) ||
    root.scope === "project" ||
    policyResult.state.sources[root.key] !== false;
  if (policyResult.writable === false || !sourceEnabled || override === false) {
    return {
      override,
      sourceEnabled,
      modelInvocable: false,
      userInvocable: false,
      enabled: false,
    };
  }
  if (override === true) {
    return {
      override,
      sourceEnabled,
      modelInvocable: true,
      userInvocable: true,
      enabled: true,
    };
  }
  const modelInvocable = entry.invocationPolicyValid && entry.modelInvocable;
  const userInvocable = entry.invocationPolicyValid && entry.userInvocable;
  return {
    override,
    sourceEnabled,
    modelInvocable,
    userInvocable,
    enabled: modelInvocable && userInvocable,
  };
}

function invalidManagerStateWrite(): FailureResult {
  return {
    ok: false,
    code: "error.state.invalid",
    params: { path: managerStatePath() },
    error: `技能管理器状态文件不可读，已拒绝覆盖: ${managerStatePath()}`,
  };
}

/**
 * 停用 / 启用一个来源（仍然扫描目录、仍然列出技能，只是不可调用）。
 *
 * 默认来源（dsh / hub）不允许停用 —— 停用等于「不读取」，而它们必须读取。
 * 其余来源（外部 Agent、自定义绝对路径）随来源开关。
 */
export async function setSourceEnabled(
  rootOrKey: RootInput,
  enabled: boolean,
  log: LogFn | undefined,
) {
  // 支持传 key（静态来源）或 definition 对象（自定义来源由 service 层从状态文件生成）。
  const root =
    rootOrKey && typeof rootOrKey === "object" && typeof rootOrKey.key === "string"
      ? rootOrKey
      : rootByKey(rootOrKey);
  if (!root || !root.toggleable) return readonlyError("toggle");
  if (isDefaultSkillSource(root)) return reservedSourceError(root);
  const current = await readManagerState();
  if (current.writable === false) return invalidManagerStateWrite();
  current.state.sources[root.key] = enabled === true;
  await writeManagerState(current.state);
  if (log)
    log(
      enabled ? "source-enable" : "source-disable",
      `${enabled ? "启用" : "停用"}来源 ${root.key}: ${root.path}`,
    );
  return { root: root.key, enabled: enabled === true };
}

/**
 * 移除 / 恢复一个来源（用户要求：「是不读取这个文件夹了，不是把文件夹删除」）。
 *
 * - `removed = true`：来源进入 `removedSources`，插件**不再读取该目录** —— 技能不出现在
 *   技能页，也不参与 provider 候选。**源文件与目录一个字节都不动。**
 * - `removed = false`：清除标记，下一步扫描即恢复。
 *
 * 与 `setSourceEnabled(false)` 的区别：停用仍然读目录、仍然列出技能（只是不可调用）；
 * 移除是"当它不存在"。`dsh`（官方技能目录）与 `hub`（导入技能落点）不允许移除 ——
 * 它们是插件自身的读写根，移除会让创建/导入无处落脚（见 isDefaultSkillSource）。
 */
export async function setSourceRemoved(
  rootOrKey: RootInput,
  removed: boolean,
  log: LogFn | undefined,
) {
  const root =
    rootOrKey && typeof rootOrKey === "object" && typeof rootOrKey.key === "string"
      ? rootOrKey
      : rootByKey(rootOrKey);
  if (!root) return readonlyError(removed === true ? "remove" : "restore");
  if (isDefaultSkillSource(root)) return reservedSourceError(root);
  if (root.scope === "project") return readonlyError("remove");
  const current = await readManagerState();
  if (current.writable === false) return invalidManagerStateWrite();
  const set = new Set(
    Array.isArray(current.state.removedSources) ? current.state.removedSources : [],
  );
  if (removed === true) set.add(root.key);
  else set.delete(root.key);
  current.state.removedSources = [...set].sort();
  await writeManagerState(current.state);
  if (log)
    log(
      removed === true ? "source-remove" : "source-restore",
      `${removed === true ? "移除（不再读取）" : "恢复读取"}来源 ${root.key}: ${root.path}`,
    );
  return { root: root.key, removed: removed === true };
}

async function checkedPolicyRootDefinition(
  root: RootInput,
): Promise<WritableRootResult> {
  const definition = rootDefinition(root);
  if (!definition || !definition.toggleable) return null;
  if (definition.scope !== "project") {
    // 自定义来源的 definition 由 service 层从状态文件生成，key 已与路径绑定。
    if (CUSTOM_ROOT_KEY_RE.test(definition.key || "")) return definition;
    const canonical = rootByKey(definition.key);
    return canonical && resolve(canonical.path) === resolve(definition.path)
      ? canonical
      : null;
  }
  const validProjectRoot =
    (definition.kind === "project-dsh" ||
      definition.kind === "project-agents") &&
    PROJECT_ROOT_KEY_RE.test(definition.key) &&
    typeof definition.projectRoot === "string" &&
    isAbsolute(definition.projectRoot) &&
    definition.key ===
      `${definition.kind}:${projectIdentity(definition.projectRoot)}` &&
    resolve(definition.path) ===
      resolve(
        join(
          definition.projectRoot,
          definition.kind === "project-dsh" ? ".dsh" : ".agents",
          "skills",
        ),
      );
  if (!validProjectRoot) return null;
  // validProjectRoot 已校验 projectRoot 为字符串，断言只为让类型收敛。
  if (!(await projectSourceSafe(definition as ProjectSource))) {
    return {
      ok: false,
      error: `项目技能目录不安全，拒绝写入状态: ${definition.path}`,
      code: "error.root.unsafe",
      params: { path: definition.path },
    };
  }
  return definition;
}

async function setPolicySkillEnabled(
  root: RootInput,
  name: string,
  enabled: boolean,
  log: LogFn | undefined,
): Promise<SkillToggleResult | FailureResult> {
  const definition = await checkedPolicyRootDefinition(root);
  if (definition && definition.ok === false) return definition;
  if (!definition) return readonlyError("toggle");
  const resolved = await resolveEntry(definition, name);
  if (resolved === null)
    return {
      ok: false,
      error: `技能不存在: ${name}`,
      code: "error.skill.notFound",
      params: { name },
    };
  let summary;
  try {
    summary = entryOf(
      name,
      resolved.kind,
      resolved.docPath,
      parseSkillDoc(
        await fs.readFile(resolved.realDocPath || resolved.docPath, "utf8"),
      ),
    );
  } catch {
    return {
      ok: false,
      error: `技能不存在: ${name}`,
      code: "error.skill.notFound",
      params: { name },
    };
  }
  if (!summary.hasFrontmatter) {
    return {
      ok: false,
      error: `技能缺少完整 frontmatter，无法${enabled ? "启用" : "停用"}: ${name}`,
      code: "error.skill.noFrontmatter",
      params: { name, action: enabled ? "enable" : "disable" },
    };
  }
  if (!summary.loadable) {
    return {
      ok: false,
      error: `技能结构不完整，无法${enabled ? "启用" : "停用"}: ${name}`,
      code: "error.skill.notLoadable",
      params: { name, action: enabled ? "enable" : "disable" },
    };
  }
  const current = await readManagerState();
  if (current.writable === false) return invalidManagerStateWrite();
  const disabled = new Set(current.state.disabledSkills[definition.key] || []);
  const explicitlyEnabled = new Set(
    current.state.enabledSkills[definition.key] || [],
  );
  if (enabled) {
    disabled.delete(name);
    explicitlyEnabled.add(name);
  } else {
    explicitlyEnabled.delete(name);
    disabled.add(name);
  }
  current.state.disabledSkills[definition.key] = [...disabled].sort();
  current.state.enabledSkills[definition.key] = [...explicitlyEnabled].sort();
  await writeManagerState(current.state);
  if (log)
    log(
      enabled ? "policy-enable" : "policy-disable",
      `${enabled ? "启用" : "停用"} ${definition.key}/${name}（本地策略，源文件不变）`,
    );
  return { root: definition.key, name, enabled: enabled === true };
}

// ── 启用 / 停用（同时控制模型与 / 手动调用，非破坏）──────────────────────────

/** enabled=true 恢复模型与 / 手动调用；false 同时停用两种调用入口。 */
export async function setSkillEnabled(
  root: RootInput,
  name: string,
  enabled: boolean,
  log: LogFn | undefined,
): Promise<SkillToggleResult | FailureResult> {
  return setPolicySkillEnabled(root, name, enabled, log);
}

/**
 * 批量显式停用技能（v0.8.5：新建 / 导入 / 回收站恢复默认不启动 —— 用户裁定）。
 * 直接写 disabledSkills 名单（与 setSkillEnabled 同一张表），不做 frontmatter 等
 * 二次校验——调用方传入的必然是刚落盘/刚恢复的条目。
 * 必须在调用方的写锁（service 的 write()）内执行。
 * @param {{ root: string, name: string }[]} entries - root = 来源 key。
 */
export async function markSkillsDisabled(
  entries: unknown,
  log: LogFn | undefined,
) {
  const list = Array.isArray(entries) ? entries : [];
  const clean = list
    .map((e) => ({ root: String((e && e.root) || ""), name: String((e && e.name) || "") }))
    .filter((e) => e.root !== "" && e.name !== "");
  if (!clean.length) return { ok: true };
  const current = await readManagerState();
  if (current.writable === false) return invalidManagerStateWrite();
  let dirty = false;
  for (const e of clean) {
    const prev = current.state.disabledSkills[e.root] || [];
    if (prev.indexOf(e.name) >= 0) continue;
    current.state.disabledSkills[e.root] = [...prev, e.name].sort();
    dirty = true;
  }
  if (dirty) {
    await writeManagerState(current.state);
    if (log) log("skill-disable-default", `默认停用 ${clean.map((e) => `${e.root}/${e.name}`).join("、")}`);
  }
  return { ok: true };
}

/**
 * 同名技能「首选来源」：默认同名技能按来源 rank 取优先级最高者生效、其余显示为被覆盖；
 * 这里让用户显式指定哪个同名技能生效（preferred=false 取消，回到 rank 顺序）。
 * 只写本地策略，不改任何源文件。
 */
export async function setPreferredSkill(
  root: RootInput,
  name: string,
  preferred: boolean,
  log: LogFn | undefined,
) {
  const definition = await checkedPolicyRootDefinition(root);
  if (definition && definition.ok === false) return definition;
  if (!definition) return readonlyError("toggle");
  const resolved = await resolveEntry(definition, name);
  if (resolved === null)
    return {
      ok: false,
      error: `技能不存在: ${name}`,
      code: "error.skill.notFound",
      params: { name },
    };
  let summary;
  try {
    summary = entryOf(
      name,
      resolved.kind,
      resolved.docPath,
      parseSkillDoc(
        await fs.readFile(resolved.realDocPath || resolved.docPath, "utf8"),
      ),
    );
  } catch {
    return {
      ok: false,
      error: `技能不存在: ${name}`,
      code: "error.skill.notFound",
      params: { name },
    };
  }
  if (!summary.loadable)
    return {
      ok: false,
      error: `技能结构不完整，无法设为同名首选: ${name}`,
      code: "error.skill.notLoadable",
      params: { name, action: "prefer" },
    };
  // 首选表按**声明名**索引（与 groupLoadableSkillsByName 的分组键同源），不是文件名。
  const canonicalName = summary.declaredName || name;
  const current = await readManagerState();
  if (current.writable === false) return invalidManagerStateWrite();
  const map = { ...(current.state.preferredSkills || {}) };
  if (preferred === false) delete map[canonicalName];
  else map[canonicalName] = definition.key;
  current.state.preferredSkills = map;
  await writeManagerState(current.state);
  if (log)
    log(
      preferred === false ? "skill-unprefer" : "skill-prefer",
      preferred === false
        ? `取消同名首选 ${canonicalName}`
        : `同名首选 ${canonicalName} → ${definition.key}`,
    );
  // 首选**可以**指向停用来源：这个写操作只记录一次选择，不启停任何东西，所以照旧写成功。
  // 但「记录成功」不等于「已经生效」—— 停用不参与选赢家、且停用赢家仍要挡住低优先级副本
  // （见 listProviderCandidates），于是首选来源自己停用时，同名两份**都不生效**。
  // 这里如实回话：调用方（含模型，`skill-prefer` 是模型可调的）不能以为「已改为生效」。
  // 不返回 ok:false —— 那会让界面的「启用这个」（prefer 之后紧跟 enable）在 enable 之前就中断。
  const effective = effectiveSkillPolicy(current, definition, {
    ...summary,
    ...resolved,
  });
  const base = {
    name: canonicalName,
    root: preferred === false ? null : definition.key,
  };
  if (preferred === false || effective.enabled) return base;
  return {
    ...base,
    effective: false,
    warning:
      `已记录同名首选，但它不会生效：${canonicalName}（${definition.label || definition.key}）` +
      `当前处于停用状态，而它仍然挡住同名的其他副本 —— 两份都不生效。` +
      `启用其中一份即可（启用这份，或改用另一份）。`,
  };
}

async function safeExistingEntryPaths(
  root: string,
  name: string,
): Promise<EntryPathTarget[]> {
  const paths: EntryPathTarget[] = [];
  const bundle = entryPath(root, name);
  if (bundle === null) return paths;
  const flat = resolve(root, `${name}.md`);
  const bundleStat = await lstatOrNull(bundle);
  if (bundleStat && (bundleStat.isDirectory() || bundleStat.isSymbolicLink()))
    paths.push({ path: bundle, fileName: name, recursive: true });
  const flatStat = await lstatOrNull(flat);
  if (flatStat && (flatStat.isFile() || flatStat.isSymbolicLink()))
    paths.push({ path: flat, fileName: `${name}.md`, recursive: false });
  return paths;
}

async function readTrashMetadata(id: string): Promise<TrashMetadata | null> {
  if (entryPath(trashRootPath(), id) === null) return null;
  try {
    const value = JSON.parse(
      await fs.readFile(join(trashRootPath(), id, "metadata.json"), "utf8"),
    );
    if (
      !value ||
      value.id !== id ||
      typeof value.name !== "string" ||
      !Array.isArray(value.entries)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Windows Defender / 索引器可能持续占用刚写入的 stage 目录，导致容器目录 rename
 * 在短重试窗口后仍返回 EPERM。此时保留 stage 作为唯一可回滚副本，逐项复制到最终目录，
 * 并最后写 metadata：listTrash() 在复制完整前不会暴露半成品。
 */
async function publishTrashStage(
  stage: string,
  finalPath: string,
  metadata: TrashMetadata,
  renameOptions: RenameOptions = {},
) {
  try {
    await renameWithRetry(stage, finalPath, renameOptions);
    return { fallback: false, cleanupError: null };
  } catch (error: any) {
    // 系统异常按可选 code 读取，保持既有可恢复码判定。
    if (!TRANSIENT_RENAME_CODES.has(error && error.code)) throw error;
  }

  await fs.mkdir(finalPath);
  try {
    for (const fileName of metadata.entries) {
      await fs.cp(join(stage, fileName), join(finalPath, fileName), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
    }
    await fs.writeFile(
      join(finalPath, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    await fs
      .rm(finalPath, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  }

  let cleanupError = null;
  try {
    await fs.rm(stage, { recursive: true, force: true });
  } catch (error: any) {
    // 调用方按可选 message 读取该清理异常，保持既有告警文案。
    cleanupError = error;
  }
  return { fallback: true, cleanupError };
}

/**
 * 回收站条目的来源元数据 —— 恢复时靠它把技能放回原处。
 *
 * 用户级可写来源不止 dsh 一个（hub 也是，而且它是「导入技能」页删除的主战场），
 * 所以这里必须按 scope 分岔：早先只特判 `dsh`，hub 会被记成项目级、`projectRoot`
 * 为 undefined，恢复时被判「原项目当前不在活动工作区中」—— 删除进去就再也拿不回来。
 */
function trashRootMetadata(definition: SkillSource): TrashRootMetadata {
  if (definition.scope !== "project")
    return { key: definition.key, scope: "user", label: definition.label };
  return {
    key: definition.key,
    scope: "project",
    kind: "project-dsh",
    projectRoot: definition.projectRoot,
    projectName: definition.projectName,
    label: definition.label,
  };
}

async function restoreRootDefinition(
  metadata: TrashMetadata,
  options: WriteOptions = {},
): Promise<WritableRootResult> {
  // version 1 entries predate scoped Trash and always belong to $DSH_HOME/skills.
  if (!metadata.root) return rootByKey("dsh");
  // 用户级来源按 key 重新解析：路径来自 userRoots()，不信元数据里记住的 path
  // （DSH_HOME 换过之后，旧路径可能已经不在读取范围内了）。
  if (metadata.root.scope === "user") return rootByKey(metadata.root.key);
  if (
    metadata.root.scope !== "project" ||
    metadata.root.kind !== "project-dsh" ||
    typeof metadata.root.key !== "string" ||
    typeof metadata.root.projectRoot !== "string" ||
    !isAbsolute(metadata.root.projectRoot)
  )
    return {
      ok: false,
      error: `回收站条目来源非法: ${metadata.id}`,
      code: "error.trash.invalid",
      params: { id: metadata.id },
    };
  const roots = await projectRoots(options.projectCwds);
  const normalizedProjectRoot = pathIdentity(metadata.root.projectRoot);
  const root = roots.find(
    (item) =>
      item.key === (metadata.root as TrashRootMetadata).key &&
      item.kind === "project-dsh" &&
      pathIdentity(item.projectRoot) === normalizedProjectRoot,
  );
  if (!root) {
    return {
      ok: false,
      error: `原项目当前不在活动工作区中，无法恢复: ${metadata.root.projectRoot}`,
      code: "error.trash.projectUnavailable",
      params: { path: metadata.root.projectRoot },
    };
  }
  return checkedWritableRootDefinition(root);
}

/** 把项目级 DSH 根中的单个技能移入 manager-owned 回收站。 */
export async function deleteSkill(
  root: RootInput,
  name: string,
  log: LogFn | undefined,
  options: WriteOptions = {},
) {
  const definition = await checkedWritableRootDefinition(root);
  if (definition && definition.ok === false) return definition;
  if (!definition) return readonlyError("delete");
  // 删除只对插件可管理的来源开放（用户级 dsh / hub、项目级 .dsh/skills）；外部 Agent
  // 目录与自定义绝对路径来源只读，返回明确错误而不是"假装删了"。
  if (definition.deletable !== true) return notDeletableError(definition);
  const resolved = await resolveEntry(definition, name);
  if (resolved === null)
    return {
      ok: false,
      error: `技能不存在: ${name}`,
      code: "error.skill.notFound",
      params: { name },
    };
  const targets = await safeExistingEntryPaths(definition.path, name);
  const id = `${Date.now()}-${randomUUID()}`;
  const trashRoot = trashRootPath();
  const stage = join(trashRoot, `.stage-${randomUUID()}`);
  const finalPath = join(trashRoot, id);
  const moved: Array<EntryPathTarget & { destination: string }> = [];
  await fs.mkdir(stage, { recursive: true });
  try {
    for (const target of targets) {
      const destination = join(stage, target.fileName);
      const transferred = await movePathWithFallback(
        target.path,
        destination,
        options.renameOptions,
      );
      if (transferred.cleanupError && log)
        log(
          "trash-source-warning",
          `技能已跨盘移入回收站，但源盘隐藏副本等待后续清理: ${transferred.quarantine}（${transferred.cleanupError.message || transferred.cleanupError}）`,
        );
      moved.push({ ...target, destination });
    }
    const metadata = {
      version: 2,
      id,
      name,
      deletedAt: new Date().toISOString(),
      entries: moved.map((item) => item.fileName),
      root: trashRootMetadata(definition),
    };
    await fs.writeFile(
      join(stage, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
    const published = await publishTrashStage(
      stage,
      finalPath,
      metadata,
      options.renameOptions,
    );
    if (published.cleanupError && log)
      log(
        "trash-stage-warning",
        `回收站已发布，但临时目录等待后续清理: ${stage}（${published.cleanupError.message || published.cleanupError}）`,
      );
    if (log) log("trash", `移到回收站 ${name} -> ${finalPath}`);
    return { id, name, deletedAt: metadata.deletedAt, root: metadata.root };
  } catch (error: any) {
    // 系统异常按可选 message 读取，保持既有回滚失败明细。
    const rollbackFailures: { path: string; error: string }[] = [];
    for (const item of moved.reverse()) {
      try {
        await movePathWithFallback(
          item.destination,
          item.path,
          options.renameOptions,
        );
      } catch (rollbackError: any) {
        // 系统异常按可选 message 读取，保持既有回滚失败明细。
        rollbackFailures.push({
          path: item.destination,
          error: String(
            rollbackError && rollbackError.message
              ? rollbackError.message
              : rollbackError,
          ),
        });
      }
    }
    if (rollbackFailures.length) {
      const causeText = String(error && error.message ? error.message : error);
      throw codedError(
        `${causeText}；移入回收站回滚失败，未恢复内容保留在: ${stage}`,
        "error.trash.rollbackFailed",
        { path: stage, error: causeText },
      );
    }
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function listTrash(): Promise<TrashMetadata[]> {
  let items;
  try {
    items = await fs.readdir(trashRootPath(), { withFileTypes: true });
  } catch {
    return [];
  }
  const result: TrashMetadata[] = [];
  for (const item of items) {
    if (!item.isDirectory() || item.name.startsWith(".")) continue;
    const metadata = await readTrashMetadata(item.name);
    if (metadata) result.push(metadata);
  }
  return result.sort((a, b) =>
    String(b.deletedAt).localeCompare(String(a.deletedAt)),
  );
}

export async function restoreTrash(
  id: string,
  log: LogFn | undefined,
  options: WriteOptions = {},
): Promise<TrashRestoreResult | FailureResult> {
  const metadata = await readTrashMetadata(id);
  if (!metadata)
    return {
      ok: false,
      error: `回收站条目不存在: ${id}`,
      code: "error.trash.notFound",
      params: { id },
    };
  const definition = await restoreRootDefinition(metadata, options);
  if (!definition || definition.ok === false)
    return definition || readonlyError("restore");
  const root = definition.path;
  const conflicts = await safeExistingEntryPaths(root, metadata.name);
  if (conflicts.length)
    return {
      ok: false,
      error: `无法恢复，同名技能已存在: ${metadata.name}`,
      code: "error.trash.conflict",
      params: { name: metadata.name },
    };
  await fs.mkdir(root, { recursive: true });
  const itemRoot = join(trashRootPath(), id);
  const moved: { source: string; destination: string }[] = [];
  try {
    for (const fileName of metadata.entries) {
      const source = join(itemRoot, fileName);
      const destination = join(root, fileName);
      if (
        !isSameOrDescendant(itemRoot, source) ||
        !isSameOrDescendant(root, destination)
      )
        throw codedError("回收站条目路径非法", "error.trash.invalid", { id });
      await movePathWithFallback(source, destination, options.renameOptions);
      moved.push({ source, destination });
    }
    await fs.rm(itemRoot, { recursive: true, force: true });
    if (log) log("restore", `从回收站恢复 ${metadata.name} -> ${root}`);
    return { id, name: metadata.name, root: trashRootMetadata(definition) };
  } catch (error) {
    for (const item of moved.reverse())
      await movePathWithFallback(
        item.destination,
        item.source,
        options.renameOptions,
      ).catch(() => undefined);
    throw error;
  }
}

export async function permanentlyDeleteTrash(
  id: string,
  log: LogFn | undefined,
) {
  const metadata = await readTrashMetadata(id);
  if (!metadata)
    return {
      ok: false,
      error: `回收站条目不存在: ${id}`,
      code: "error.trash.notFound",
      params: { id },
    };
  await fs.rm(join(trashRootPath(), id), { recursive: true, force: true });
  if (log) log("trash-delete", `永久删除回收站条目 ${metadata.name} (${id})`);
  return { id, name: metadata.name };
}

// ── 导入 ────────────────────────────────────────────────────────────────────

/** 分析来源：单 skill 目录 / 单 .md 文件 / 批量目录。 */

/** 导入内容不接受符号链接，避免把目标目录外的内容带入技能目录。 */

/** dry-run 预检执行与正式导入相同的符号链接/深度检查，预检失败即结论，不再进入覆盖确认。
 *  预检与实导之间来源被替换的竞态仍由实导阶段的复制后校验兜底。 */

/** 先复制到同目录临时路径，复制失败时不触碰现有技能。 */

/** 临时副本就绪后再替换；替换失败时尽力恢复旧条目。 */

/**
 * 导入技能到目标根。
 * options: { conflict: 'skip'|'overwrite', dryRun: boolean }
 * 成功返回 { kind, imported, skipped, failed }；失败返回 { ok:false, error }。
 */
export async function importSkill(
  source: string,
  log: LogFn | undefined,
  options: ImportOptions = {},
) {
  const targetRoot = skillCreateRootPath();
  const conflict = options.conflict === "overwrite" ? "overwrite" : "skip";
  const dryRun = options.dryRun === true;

  const analysis = await analyzeSource(source);
  if (analysis.kind === "none")
    return {
      ok: false,
      error: analysis.error || "无法识别的 skill 来源",
      code: analysis.code || "error.source.unrecognized",
      params: analysis.params,
    };
  if (await pathsOverlap(analysis.source, targetRoot))
    return {
      ok: false,
      error: "导入来源不能与 DSH 技能目录相同、包含或位于其中",
      code: "error.import.overlap",
    };

  let candidates: ImportCandidate[] = [];
  if (analysis.kind === "single") {
    candidates = [
      {
        source: analysis.source,
        kebab: analysis.kebab,
        rawName: analysis.rawName,
        isDir: analysis.isDir,
      },
    ];
  } else {
    try {
      candidates = await collectCandidates(source);
    } catch (error: any) {
      // 系统异常按可选 message 读取，保持既有失败明细文案。
      return attachCode(
        {
          ok: false,
          error: String(error && error.message ? error.message : error),
        },
        error,
      );
    }
    if (candidates.length === 0)
      return {
        ok: false,
        error: `目录下未找到任何 skill 条目（需含 SKILL.md 的子目录或 .md 文件）: ${source}`,
        code: "error.import.emptySource",
        params: { path: source },
      };
  }

  const pending: ImportPending[] = [];
  const conflicts: ImportConflict[] = [];
  const failed: ImportFailure[] = [];
  const imported: ImportImported[] = [];
  const skipped: ImportSkipped[] = [];

  const nameCount = new Map<string, number>();
  for (const candidate of candidates) {
    if (
      candidate.kebab &&
      KEBAB_RE.test(candidate.kebab) &&
      entryPath(targetRoot, candidate.kebab) !== null
    )
      nameCount.set(candidate.kebab, (nameCount.get(candidate.kebab) || 0) + 1);
  }

  function failureResult() {
    return {
      ok: false,
      // 聚合失败明细的原文；前端优先展示已翻译的 failed 明细，此处仅作兜底。
      error: failed.map((item) => item.error).join("；"),
      code: "error.import.failed",
      kind: analysis.kind,
      imported,
      skipped,
      failed,
    };
  }

  for (const c of candidates) {
    if (
      !c.kebab ||
      !KEBAB_RE.test(c.kebab) ||
      entryPath(targetRoot, c.kebab) === null
    ) {
      failed.push({
        source: c.source,
        error: `无法生成合法 kebab-case 名称（原始名: ${c.rawName || basename(c.source)}）`,
        code: "error.import.invalidName",
        params: { name: c.rawName || basename(c.source) },
      });
      continue;
    }
    // 上方计数循环已为该 kebab 记数（合法名称且目标可写），断言只为让类型收敛。
    if ((nameCount.get(c.kebab) as number) > 1) {
      failed.push({
        source: c.source,
        error: `批量来源中存在多个同名插件: ${c.kebab}`,
        code: "error.import.duplicateName",
        params: { name: c.kebab },
      });
      continue;
    }
    const dest = c.isDir
      ? join(targetRoot, c.kebab)
      : join(targetRoot, `${c.kebab}.md`);
    const paths: string[] = [
      join(targetRoot, c.kebab),
      join(targetRoot, `${c.kebab}.md`),
    ];
    const existing: string[] = [];
    for (const path of paths) {
      try {
        await fs.stat(path);
        existing.push(path);
      } catch {}
    }
    if (existing.length) {
      conflicts.push({
        name: c.kebab,
        source: c.source,
        isDir: c.isDir,
        paths: existing,
      });
      continue;
    }
    pending.push({ name: c.kebab, source: c.source, isDir: c.isDir, dest });
  }

  if (pending.length === 0 && conflicts.length === 0) return failureResult();

  if (dryRun) {
    // 预检即结论：与正式导入同口径执行符号链接/深度检查，避免预检通过、确认覆盖后实导才失败。
    await preflightCandidates(pending, conflicts, failed);
    if (pending.length === 0 && conflicts.length === 0) return failureResult();
    return { kind: analysis.kind, pending, conflicts, failed };
  }

  if (
    pending.length > 0 ||
    (conflict === "overwrite" && conflicts.length > 0)
  ) {
    await fs.mkdir(targetRoot, { recursive: true });
  }

  for (const p of pending) {
    try {
      const warnings = await replaceWithCopy(p.source, p.dest, p.isDir);
      imported.push({ name: p.name, overwritten: false, warnings });
      if (log) log("import", `导入 ${p.source} -> ${p.dest}`);
    } catch (e: any) {
      // 系统异常按可选 message 读取，保持既有失败明细文案。
      failed.push(
        attachCode(
          { source: p.source, error: String(e && e.message ? e.message : e) },
          e,
        ),
      );
    }
  }

  if (conflict === "overwrite") {
    for (const c of conflicts) {
      try {
        const dest = c.isDir
          ? join(targetRoot, c.name)
          : join(targetRoot, `${c.name}.md`);
        const warnings = await replaceWithCopy(
          c.source,
          dest,
          c.isDir,
          c.paths,
        );
        imported.push({ name: c.name, overwritten: true, warnings });
        if (log) log("import-overwrite", `覆盖导入 ${c.source} -> ${dest}`);
      } catch (e: any) {
        // 系统异常按可选 message 读取，保持既有失败明细文案。
        failed.push(
          attachCode(
            { source: c.source, error: String(e && e.message ? e.message : e) },
            e,
          ),
        );
      }
    }
  } else {
    for (const c of conflicts) skipped.push({ name: c.name, source: c.source });
  }

  if (failed.length && imported.length === 0) return failureResult();
  return { kind: analysis.kind, imported, skipped, failed };
}

// ── 浏览器上传导入 ──────────────────────────────────────────────────────────

/**
 * 一个上传路径段会不会被文件系统**改写**成别的东西。
 *
 * 为什么必须单判这一条（2026-09-30 审查 P2-17，实为路径逃逸而非口径分叉）：
 * 下面的 `part === ".."` 只挡**恰好**是 `..` 的段，而 Windows 的路径归一化会把段尾的
 * **点与空格**静默裁掉 —— `.. `（`..` 加一个空格）在 `CreateFileW` / `CreateDirectoryW`
 * 眼里就是 `..`。于是 `join(contentRoot, ".. ", "x")` 看着在根内（`isSameOrDescendant`
 * 也判在根内：它按字符串比，`".. "` 不等于 `".."`，`relative` 得到的 `".. /x"` 也不以
 * `"../"` 开头），实际会写到**暂存目录之外**。同一条判据顺带覆盖 `...` / `. ` /
 * `foo.`（最后一个不逃逸，但会让磁盘上的名字与界面显示的名字不一致 —— `paths.ts` 的
 * `trailing-dot-or-space` 就是为这个存在的）。
 *
 * 只挡"会被改写"的形态，**不挡** `.gitignore` / `.DS_Store` 这类正常点文件：技能包带它们
 * 是常态（macOS 解压出来的包必带 `.DS_Store`），一律拒绝会让正常技能导不进来。
 * 注意 `../imports/upload.ts` 的 `normalizeEntryPath` 走的是更宽的一条（拒绝**所有**
 * 点开头的段）—— 那里是历史口径，方向更保守，两边都安全，不必强行统一。
 */
function pathSegmentRewritten(part: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(part)) return true;
  return part !== part.replace(/[.\s]+$/, "");
}

/**
 * 校验浏览器或 ZIP 提供的相对路径。上传内容始终写成普通文件，不解释 ZIP 的链接元数据。
 * 这样既不依赖浏览器泄露本机绝对路径，也不会让归档跨出管理器暂存目录。
 */
function normalizeUploadPath(input: unknown): UploadPath {
  const raw = String(input == null ? "" : input).replace(/\\/g, "/");
  if (
    !raw ||
    raw.length > MAX_UPLOAD_PATH_LENGTH ||
    raw.includes("\0") ||
    raw.startsWith("/") ||
    /^[A-Za-z]:/.test(raw) ||
    raw.startsWith("//")
  ) {
    throw codedError(`上传条目路径非法: ${raw}`, "error.upload.path", {
      path: raw,
    });
  }
  const directory = raw.endsWith("/");
  const parts = raw
    .split("/")
    .filter((part, index, all) =>
      directory && index === all.length - 1 ? false : true,
    );
  if (
    !parts.length ||
    parts.length > MAX_SOURCE_DEPTH ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        pathSegmentRewritten(part) ||
        part.length > MAX_ENTRY_NAME_LENGTH ||
        WINDOWS_DEVICE_NAME_RE.test(part),
    )
  ) {
    throw codedError(`上传条目路径非法: ${raw}`, "error.upload.path", {
      path: raw,
    });
  }
  return { path: parts.join("/"), directory };
}

function decodeUploadBase64(
  value: unknown,
  maxBytes: number,
  code = "error.upload.tooLarge",
): Buffer {
  const raw = String(value == null ? "" : value);
  const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
  const dataLength = raw.length - padding;
  const firstPadding = raw.indexOf("=");
  if (
    raw.length % 4 !== 0 ||
    (firstPadding !== -1 && firstPadding !== dataLength)
  ) {
    throw codedError("上传内容不是合法 Base64", "error.upload.encoding");
  }
  const decodedLength = (raw.length / 4) * 3 - padding;
  if (decodedLength > maxBytes)
    throw codedError(`上传内容超过 ${maxBytes} 字节限制`, code, {
      limit: maxBytes,
    });
  // 避免对数 MiB 字符串使用带重复分组的正则；V8 可能在合法大文件上耗尽调用栈。
  for (let index = 0; index < dataLength; index += 1) {
    const char = raw.charCodeAt(index);
    if (
      !(
        (char >= 65 && char <= 90) ||
        (char >= 97 && char <= 122) ||
        (char >= 48 && char <= 57) ||
        char === 43 ||
        char === 47
      )
    ) {
      throw codedError("上传内容不是合法 Base64", "error.upload.encoding");
    }
  }
  const bytes = Buffer.from(raw, "base64");
  return bytes;
}

function uploadError(error: unknown) {
  // 按可选 message 读取抛出值，保持既有兜底文案。
  const cause = error as { message?: unknown } | null | undefined;
  return attachCode(
    {
      ok: false,
      error: String(cause && cause.message ? cause.message : error),
    },
    error,
  );
}

async function writeUploadedEntries(
  contentRoot: string,
  entries: unknown,
): Promise<void> {
  if (!Array.isArray(entries) || entries.length === 0)
    throw codedError("上传内容为空", "error.upload.empty");
  if (entries.length > MAX_UPLOAD_ENTRIES)
    throw codedError(
      `上传条目超过 ${MAX_UPLOAD_ENTRIES} 个`,
      "error.upload.tooMany",
      { limit: MAX_UPLOAD_ENTRIES },
    );
  let total = 0;
  const seen = new Set();
  for (const entry of entries) {
    const normalized = normalizeUploadPath(entry && entry.path);
    const key = normalized.path.toLowerCase();
    if (seen.has(key))
      throw codedError(
        `上传内容包含重复路径: ${normalized.path}`,
        "error.upload.duplicate",
        { path: normalized.path },
      );
    seen.add(key);
    if (normalized.directory) continue;
    const bytes = decodeUploadBase64(
      entry && entry.data,
      MAX_UPLOAD_ENTRY_BYTES,
    );
    total += bytes.length;
    if (total > MAX_UPLOAD_TOTAL_BYTES)
      throw codedError(
        `上传内容总大小超过 ${MAX_UPLOAD_TOTAL_BYTES} 字节`,
        "error.upload.tooLarge",
        { limit: MAX_UPLOAD_TOTAL_BYTES },
      );
    const target = join(contentRoot, ...normalized.path.split("/"));
    if (!isSameOrDescendant(contentRoot, target))
      throw codedError(
        `上传条目路径非法: ${normalized.path}`,
        "error.upload.path",
        { path: normalized.path },
      );
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
}

async function writeUploadedZip(contentRoot: string, encoded: unknown): Promise<void> {
  const archive = decodeUploadBase64(
    encoded,
    MAX_UPLOAD_ARCHIVE_BYTES,
    "error.upload.archiveTooLarge",
  );
  let count = 0;
  let total = 0;
  let files;
  try {
    files = unzipSync(archive, {
      filter(info) {
        const normalized = normalizeUploadPath(info.name);
        count += 1;
        if (count > MAX_UPLOAD_ENTRIES)
          throw codedError(
            `ZIP 条目超过 ${MAX_UPLOAD_ENTRIES} 个`,
            "error.upload.tooMany",
            { limit: MAX_UPLOAD_ENTRIES },
          );
        if (!normalized.directory && info.originalSize > MAX_UPLOAD_ENTRY_BYTES)
          throw codedError(
            `ZIP 条目过大: ${normalized.path}`,
            "error.upload.tooLarge",
            { limit: MAX_UPLOAD_ENTRY_BYTES },
          );
        total += normalized.directory ? 0 : info.originalSize;
        if (total > MAX_UPLOAD_TOTAL_BYTES)
          throw codedError(
            `ZIP 解压后总大小超过 ${MAX_UPLOAD_TOTAL_BYTES} 字节`,
            "error.upload.tooLarge",
            { limit: MAX_UPLOAD_TOTAL_BYTES },
          );
        return !normalized.directory;
      },
    });
  } catch (error: any) {
    // 业务错误（我们抛的 error.* 前缀）透传；其余按 ZIP 解压失败处理。
    if (error && /^error\./.test(String(error.code || ""))) throw error;
    throw codedError(
      `ZIP 无法解压: ${String(error && error.message ? error.message : error)}`,
      "error.upload.zipInvalid",
    );
  }
  const entries = Object.entries(files).map(([path, bytes]) => ({
    path,
    data: Buffer.from(bytes).toString("base64"),
  }));
  await writeUploadedEntries(contentRoot, entries);
}

/** 浏览器上传来源入参（entries 或 zip 二者取一）。 */
interface UploadSource {
  name?: unknown;
  entries?: unknown;
  zip?: unknown;
}

async function prepareUploadedSource(
  sessionRoot: string,
  input: UploadSource,
): Promise<string> {
  const contentRoot = join(sessionRoot, "content");
  await fs.mkdir(contentRoot, { recursive: true });
  if (input && input.zip !== undefined)
    await writeUploadedZip(contentRoot, input.zip);
  else await writeUploadedEntries(contentRoot, input && input.entries);

  const rootSkill = join(contentRoot, "SKILL.md");
  const rootSkillStat = await lstatOrNull(rootSkill);
  if (!rootSkillStat || !rootSkillStat.isFile()) return contentRoot;

  const doc = parseSkillDoc(await fs.readFile(rootSkill, "utf8"));
  const fallback = String((input && input.name) || "uploaded-skill")
    .replace(/\.zip$/i, "")
    .replace(/^skill\.md$/i, "uploaded-skill");
  const skillName = toKebab(doc.map.name || fallback);
  if (
    !skillName ||
    !KEBAB_RE.test(skillName) ||
    entryPath(contentRoot, skillName) === null
  ) {
    throw codedError(
      `无法生成合法 kebab-case 名称（原始名: ${doc.map.name || fallback}）`,
      "error.import.invalidName",
      { name: doc.map.name || fallback },
    );
  }
  const batchRoot = join(sessionRoot, "batch");
  const wrappedRoot = join(batchRoot, skillName);
  await fs.mkdir(batchRoot, { recursive: true });
  await renameWithRetry(contentRoot, wrappedRoot);
  return batchRoot;
}

/**
 * 接收浏览器读取后的内容，在 manager 私有目录暂存并复用现有原子导入链路。
 * input: { name, entries:[{path,data(base64)}] } 或 { name, zip:base64 }。
 */
export async function importUploadedSkill(
  input: unknown,
  log: LogFn | undefined,
  options: ImportOptions = {},
) {
  const uploadHome = join(managerHomePath(), "uploads");
  const sessionRoot = join(uploadHome, `.upload-${randomUUID()}`);
  try {
    await fs.mkdir(sessionRoot, { recursive: true });
    const source = await prepareUploadedSource(
      sessionRoot,
      (input as UploadSource | null | undefined) || {},
    );
    return await importSkill(source, log, options);
  } catch (error) {
    return uploadError(error);
  } finally {
    await fs
      .rm(sessionRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

// ── 创建 / 详情 / Provider ─────────────────────────────────────────────────

function yamlString(value: unknown): string {
  return JSON.stringify(String(value));
}

/** 新建技能入参。 */
interface CreateSkillInput {
  name: unknown;
  description?: unknown;
  body?: unknown;
  form?: unknown;
}

/** 新建技能选项。 */
interface CreateSkillOptions {
  root?: RootInput;
}

export async function createSkill(
  input: CreateSkillInput,
  log: LogFn | undefined,
  options: CreateSkillOptions = {},
): Promise<CreateSkillResult | FailureResult> {
  // v0.4：默认落点由「DSH 技能目录」改为 hub 内的 `tool-management/skills/`；
  // 调用方显式传 options.root（如项目根）时仍以调用方为准。
  const requestedRoot = Object.prototype.hasOwnProperty.call(options, "root")
    ? options.root
    : rootByKey("hub") || rootByKey("dsh");
  const definition = await checkedWritableRootDefinition(requestedRoot);
  if (definition && definition.ok === false) return definition;
  if (!definition) {
    // 区分「来源根本不存在」与「来源存在但只读」：旧实现两种都回
    // 「该技能来源不允许启用或停用」，创建失败时这条提示既指错动作又指错原因。
    if (!rootDefinition(requestedRoot)) {
      return {
        ok: false,
        code: "error.root.unknown",
        params: { root: String(requestedRoot == null ? "" : requestedRoot) },
        error: `技能来源不存在：${requestedRoot == null || requestedRoot === "" ? "(空)" : requestedRoot}`,
      };
    }
    return readonlyError("create");
  }
  const root = definition.path;
  const requestedName = String((input && input.name) || "").trim();
  const name = toKebab(requestedName);
  const description = String((input && input.description) || "").trim();
  const body = String((input && input.body) || "").trim();
  const form = String((input && input.form) || "bundle") === "flat" ? "flat" : "bundle";
  if (!name || !KEBAB_RE.test(name) || entryPath(root, name) === null)
    return {
      ok: false,
      error: `无法生成合法 kebab-case 名称（原始名: ${requestedName}）`,
      code: "error.import.invalidName",
      params: { name: requestedName },
    };
  if (!description)
    return {
      ok: false,
      error: "技能简介不能为空",
      code: "error.create.descriptionRequired",
    };
  if (!body)
    return {
      ok: false,
      error: "技能正文不能为空",
      code: "error.create.bodyRequired",
    };
  if (description.length > 500 || body.length > 1 << 18)
    return { ok: false, error: "技能内容过长", code: "error.create.tooLarge" };
  if (
    await safeExistingEntryPaths(root, name).then((items) => items.length > 0)
  )
    return {
      ok: false,
      error: `同名技能已存在: ${name}`,
      code: "error.create.conflict",
      params: { name },
    };
  await fs.mkdir(root, { recursive: true });
  const content = `---\nname: ${name}\ndescription: ${yamlString(description)}\n---\n\n${body}\n`;
  if (form === "flat") {
    // flat 形态：直接写 <root>/<name>.md（规则/单文件技能用；bundle 见下方目录分支）
    const flatPath = resolve(root, `${name}.md`);
    await writeFileAtomically(flatPath, content);
    if (log) log("create", `创建 ${flatPath}`);
    return { name, path: flatPath, root: definition.key };
  }
  // 上方 entryPath(root, name) === null 的守卫已保证目标非空，断言只为让类型收敛。
  const target = entryPath(root, name) as string;
  const stage = temporaryPath(target, "create");
  try {
    await fs.mkdir(stage);
    await fs.writeFile(join(stage, "SKILL.md"), content, "utf8");
    await renameWithRetry(stage, target);
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  if (log) log("create", `创建 ${join(target, "SKILL.md")}`);
  return { name, path: join(target, "SKILL.md"), root: definition.key };
}

/** 更新技能入参。与 `CreateSkillInput` 的差别就在"可选"：省略 = 保持原样。 */
interface UpdateSkillInput {
  name: unknown;
  description?: unknown;
  body?: unknown;
}

/**
 * 改写一份**已存在**的技能（bundle 的 `SKILL.md` 或 flat 的 `<name>.md`）。
 *
 * 为什么是独立函数、而不是给 `createSkill` 加一个 `allowOverwriteInOwnRoot` 开关：
 * 「静默覆盖」这件事不该出现在同一个入口的签名里 —— 调用方读到的函数名必须已经说明了
 * 它是破坏性的，否则一次参数写错就从"新建"变成"覆盖别人的技能"。
 *
 * 写入复用同一套原子写（stage 文件 + `renameWithRetry`）。bundle 形态**只换 SKILL.md**，
 * 目录里其余文件（附件、脚本、参考文档）原样留着 —— 整目录替换会把它们全删掉。
 *
 * 边界：只在 `options.root`（默认 hub = `$DSH_HOME/tool-management/skills`）**里面已经
 * 存在**的那一份上写。文件不在那里就是"不存在"，**绝不新建**（新建是 `createSkill` 的事，
 * 它的冲突检查会拒掉同名）。
 *
 * 「胜出者必须是 hub 这一份」这层判定不在这里：它要读来源排序与首选设置，属于状态层
 * （见 service.ts 的 `skill-update` op）。本函数只保证"不越出给定根"。
 */
export async function updateSkill(
  input: UpdateSkillInput,
  log: LogFn | undefined,
  options: CreateSkillOptions = {},
): Promise<CreateSkillResult | FailureResult> {
  const requestedRoot = Object.prototype.hasOwnProperty.call(options, "root")
    ? options.root
    : rootByKey("hub") || rootByKey("dsh");
  const definition = await checkedWritableRootDefinition(requestedRoot);
  if (definition && definition.ok === false) return definition;
  if (!definition) {
    if (!rootDefinition(requestedRoot)) {
      return {
        ok: false,
        code: "error.root.unknown",
        params: { root: String(requestedRoot == null ? "" : requestedRoot) },
        error: `技能来源不存在：${requestedRoot == null || requestedRoot === "" ? "(空)" : requestedRoot}`,
      };
    }
    return readonlyError("update");
  }
  const root = definition.path;
  const requestedName = String((input && input.name) || "").trim();
  const name = toKebab(requestedName);
  if (!name || !KEBAB_RE.test(name) || entryPath(root, name) === null)
    return {
      ok: false,
      error: `无法生成合法 kebab-case 名称（原始名: ${requestedName}）`,
      code: "error.import.invalidName",
      params: { name: requestedName },
    };
  // 形态判定与 `resolveEntry` 同口径：bundle 目录优先，其次 flat 单文件。
  const bundleDir = entryPath(root, name) as string;
  const bundleDoc = join(bundleDir, "SKILL.md");
  const flatDoc = resolve(root, `${name}.md`);
  const exists = async (p: string): Promise<boolean> =>
    await fs.stat(p).then(() => true).catch(() => false);
  const existingDoc = (await exists(bundleDoc)) ? bundleDoc : (await exists(flatDoc)) ? flatDoc : null;
  if (!existingDoc)
    return {
      ok: false,
      code: "error.update.notFound",
      error: `技能不存在（本插件落点里没有 ${name}）：本工具只改本插件自己写的技能，不新建、也不动官方根里的`,
      params: { name },
    };
  const current = parseSkillDoc(await fs.readFile(existingDoc, "utf8"));
  const curDescription = unquote(String(current.map.description ?? "")).trim();
  const curBody = String(current.body ?? "").trim();
  // 省略 = 保持。注意区分"未给"与"给了空串"：空串是显式意图，会被下面的必填校验挡下并
  // 说明缺哪个 —— 静默保留会让模型以为清掉了。
  const description = input && input.description !== undefined
    ? String(input.description).trim()
    : curDescription;
  const body = input && input.body !== undefined ? String(input.body).trim() : curBody;
  if (!description)
    return { ok: false, error: "技能简介不能为空", code: "error.create.descriptionRequired" };
  if (!body)
    return { ok: false, error: "技能正文不能为空", code: "error.create.bodyRequired" };
  if (description.length > 500 || body.length > 1 << 18)
    return { ok: false, error: "技能内容过长", code: "error.create.tooLarge" };
  const content = `---\nname: ${name}\ndescription: ${yamlString(description)}\n---\n\n${body}\n`;
  if (existingDoc === flatDoc) {
    await writeFileAtomically(flatDoc, content);
    if (log) log("update", `更新 ${flatDoc}`);
    return { name, path: flatDoc, root: definition.key };
  }
  const stage = temporaryPath(existingDoc, "update");
  try {
    await fs.writeFile(stage, content, "utf8");
    await renameWithRetry(stage, existingDoc);
  } catch (error) {
    await fs.rm(stage, { force: true }).catch(() => undefined);
    throw error;
  }
  if (log) log("update", `更新 ${existingDoc}`);
  return { name, path: existingDoc, root: definition.key };
}

export async function skillDetail(
  keyOrRoot: RootInput,
  name: string,
  options: { projectCwds?: string[] } = {},
) {
  const scopedRoots = await projectRoots(options.projectCwds);
  // 支持传 key 或 definition（自定义来源由 service 层解析后传入）。
  const root =
    (keyOrRoot && typeof keyOrRoot === "object" && typeof keyOrRoot.key === "string" ? keyOrRoot : null) ||
    rootByKey(keyOrRoot) ||
    scopedRoots.find((item) => item.key === keyOrRoot);
  if (!root) {
    const unknownRoot = (keyOrRoot && typeof keyOrRoot === "object" && keyOrRoot.key) || keyOrRoot;
    return {
      ok: false,
      error: `未知技能来源: ${unknownRoot}`,
      code: "error.root.unknown",
      params: { root: unknownRoot },
    };
  }
  const entry = await visibleEntryForRoot(root, name);
  if (!entry)
    return {
      ok: false,
      error: `技能不存在: ${name}`,
      code: "error.skill.notFound",
      params: { name },
    };
  let raw;
  try {
    raw = await fs.readFile(entry.realDocPath || entry.docPath, "utf8");
  } catch {
    return {
      ok: false,
      error: `技能不存在: ${name}`,
      code: "error.skill.notFound",
      params: { name },
    };
  }
  const doc = parseSkillDoc(raw);
  const summary = entryOf(name, entry.kind, entry.docPath, doc);
  return {
    root: root.key,
    name,
    declaredName: summary.declaredName,
    description: summary.description,
    path: entry.docPath,
    kind: entry.kind,
    body: doc.body.trim(),
    frontmatter: summary.hasFrontmatter
      ? Object.fromEntries(Object.entries(doc.map))
      : null,
    diagnostics: summary.diagnostics,
    loadable: summary.loadable,
    sourceReadOnly: !root.mutable,
  };
}

/**
 * 生成 manager provider 候选：保留禁用候选以阻止低优先级重名副本意外激活。
 *
 * **同名首选必须传进分组**（2026-09-30 审查 F8）。此前这里调
 * `groupLoadableSkillsByName(items)` 时没带 `preferred`，而管理页（`markWinners`）带了 ——
 * 于是「同名首选」只在界面上生效：用户把 A 设为首选，界面把 A 标成「同名首选」、把 B 标成
 * 「被覆盖」，模型侧却仍按 rank 拿到 B。**界面说的和模型用的不是同一份**，且没有任何一处报错。
 *
 * 分组函数本身是共用的（同一份排序规则），缺的只是这个参数；传进去两侧即同源。
 * 未命中（键已失效 / 来源被移除）时分组函数自己退化为纯 rank 顺序，与界面一致。
 */
export async function listProviderCandidates(
  options: { cwd?: string } = {},
): Promise<ProviderCandidate[]> {
  const policyResult = await readManagerState();
  const candidates: ProviderCandidate[] = [];
  const user = activeUserRoots(policyResult.state).concat(
    customRootsFromState(policyResult.state).filter(
      (root) => !policyResult.state.removedSources.includes(root.key),
    ),
  );
  const userScans = await scanDeduplicatedRoots(user);
  const items = user.flatMap((root) =>
    (userScans.get(root.key) as ScanResult).entries.map((entry) => ({
      root,
      entry,
    })),
  );
  const cwd =
    options && typeof options.cwd === "string" ? options.cwd : undefined;
  if (cwd) {
    const roots = await projectRoots([cwd]);
    for (const root of roots) {
      const scanned = (await scanDeduplicatedRoots([root])).get(
        root.key,
      ) as ScanResult;
      for (const entry of scanned.entries) items.push({ root, entry });
    }
  }
  // 与管理页 markWinners 同一个 preferred 表、同一个分组函数 —— 界面与模型必须挑同一个赢家。
  const preferredSkills = policyResult.state.preferredSkills || null;
  for (const group of groupLoadableSkillsByName(items, preferredSkills).values()) {
    const { root, entry } = group[0];
    const project = root.scope === "project";
    const policyOnly = root.mutable;
    const policy = effectiveSkillPolicy(policyResult, root, entry);
    // 近作用域先于 rank 决胜；冲突时必须提供真正的赢家，避免预设原生副本回流。
    // 禁用状态不参与选赢家，禁用赢家仍需阻断低优先级副本。
    const needsOverlay =
      !policyOnly ||
      group.length > 1 ||
      policy.override !== undefined ||
      !entry.invocationPolicyValid ||
      policyResult.writable === false;
    if (!needsOverlay) continue;
    candidates.push({
      name: entry.declaredName,
      description: entry.description,
      invocation: {
        modelInvocable: policy.modelInvocable,
        userInvocable: policy.userInvocable,
      },
      provider: "dsh-plugin-tool-management-external",
      source: project
        ? (root.kind as string)
        : root.key === "official"
          ? "bundled"
          : root.key === "dsh"
          ? "user-dsh"
          : CUSTOM_ROOT_KEY_RE.test(root.key)
            ? "custom"
            : `agent-${root.key}`,
      rank: project
        ? root.rank - 1
        : root.key === "dsh"
          ? USER_DSH_POLICY_RANK
          : (entry.providerRank ?? root.rank),
      locator: {
        rootKey: root.key,
        entryName: entry.name,
        path: entry.docPath,
        realEntryPath: entry.realEntryPath,
        realDocPath: entry.realDocPath,
      },
      resourceBase: {
        kind: "directory",
        path: entry.kind === "bundle" ? entry.realEntryPath : root.path,
      },
      path: entry.docPath,
      metadata: {
        dshSkillsManager: {
          root: root.key,
          readOnly: !root.mutable,
          sourceReadOnly: !root.mutable,
          policyOnly,
        },
      },
    });
  }
  return candidates;
}

export async function getProviderSkill(
  candidate: ProviderCandidate | null | undefined,
  options: { cwd?: string } = {},
) {
  const locator = candidate && candidate.locator;
  if (
    !locator ||
    typeof locator.path !== "string" ||
    typeof locator.rootKey !== "string" ||
    typeof locator.realEntryPath !== "string" ||
    typeof locator.realDocPath !== "string"
  )
    return undefined;
  let root: SkillSource | null | undefined = rootByKey(locator.rootKey);
  if (
    !root &&
    PROJECT_ROOT_KEY_RE.test(locator.rootKey) &&
    typeof options.cwd === "string"
  ) {
    root = (await projectRoots([options.cwd])).find(
      (item) => item.key === locator.rootKey,
    );
  }
  // 自定义技能目录不住在 `userRoots()` 里，它住在状态文件的 `customRoots` 里，所以
  // `rootByKey()` 恒取不到。少了这一支就是「列得出、调不动」：`state()` 扫的是
  // `userRoots() + customRootsFromState()`，官方 catalog 因此把目录里的技能列给模型，
  // 而模型真去 `skill` 工具取正文时这里返回 undefined —— 症状是
  // `skill "brainstorming" is unknown or no longer available`（用户 2026-09-22 报的）。
  if (
    !root &&
    CUSTOM_ROOT_KEY_RE.test(locator.rootKey)
  ) {
    root = customRootsFromState((await readManagerState()).state).find(
      (item) => item.key === locator.rootKey,
    );
  }
  if (!root) return undefined;
  try {
    const entry = await resolveEntry(root, String(locator.entryName || ""));
    if (!entry || resolve(entry.docPath) !== resolve(locator.path))
      return undefined;
    if (
      pathIdentity(entry.realEntryPath) !== pathIdentity(locator.realEntryPath)
    )
      return undefined;
    if (pathIdentity(entry.realDocPath) !== pathIdentity(locator.realDocPath))
      return undefined;
    const doc = parseSkillDoc(
      await fs.readFile(entry.realDocPath || entry.docPath, "utf8"),
    );
    const summary = entryOf(locator.entryName, entry.kind, entry.docPath, doc);
    if (!summary.loadable || summary.declaredName !== candidate.name)
      return undefined;
    // 官方 office 技能：补上官方 provider 在 get 时追加的 LibreOffice Kit 段
    // （SKILL.md 明文引用这段的 node/cli 路径，见上方块注释）。
    const officeRuntime =
      locator.rootKey === OFFICIAL_SOURCE_KEY &&
      OFFICE_SKILL_NAMES.has(locator.entryName)
        ? officialOfficeRuntimeSection()
        : "";
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      provider: candidate.provider,
      source: candidate.source,
      resourceBase: candidate.resourceBase,
      path: candidate.path,
      metadata: candidate.metadata,
      content: doc.body.trim() + officeRuntime,
    };
  } catch {
    return undefined;
  }
}

// ── 状态快照 ────────────────────────────────────────────────────────────────

function canonicalSkillName(item: RootedEntry): string {
  return item.entry.declaredName || item.entry.name;
}

/**
 * 真实路径去重后按声明名分组；管理页与当前工作区 provider 共用来源优先级。
 *
 * `preferred`（技能名 → 来源 key）是用户对同名技能的显式选择：命中的来源排到同名前，
 * 其余仍按来源 rank 排序；未命中（或键已失效）时退化为纯 rank 顺序。
 */
export function groupLoadableSkillsByName<T extends RootedEntry>(
  items: T[],
  preferred?: Record<string, string> | null,
): Map<string, T[]> {
  const preferredFor = (item: RootedEntry) => {
    if (!preferred) return null;
    const key = preferred[canonicalSkillName(item)];
    return typeof key === "string" ? key : null;
  };
  const ordered = [...items].sort((a, b) => {
    const rankA = preferredFor(a) === a.root.key ? 0 : 1;
    const rankB = preferredFor(b) === b.root.key ? 0 : 1;
    if (rankA !== rankB) return rankA - rankB;
    return a.root.rank - b.root.rank;
  });
  const groups = new Map<string, T[]>();
  for (const item of ordered) {
    if (!item.entry.loadable) continue;
    const name = canonicalSkillName(item);
    const group = groups.get(name) || [];
    group.push(item);
    groups.set(name, group);
  }
  return groups;
}

function markWinners(
  items: StateItem[],
  options: MarkWinnersOptions = {},
): Map<string, StateItem> {
  const winners = new Map<string, StateItem>();
  const preferred = options.preferred;
  for (const [
    canonicalName,
    [winner, ...shadowed],
  ] of groupLoadableSkillsByName(items, preferred)) {
    winners.set(canonicalName, winner);
    // `preferred` = 「这份显式选择**记录在案**且它确实赢了同名之争」，**不等于它正在生效**：
    // 首选来源自己停用时它照样赢（停用不参与选赢家），此时 `view.enabled === false`，
    // 而其余副本拿到 `shadowedBy.enabled === false` —— 界面据此说「两份都不生效」。
    // 这里仍要打上 preferred，否则界面拿不到「取消首选」那颗按钮，用户就没法撤销这次选择。
    if (preferred && preferred[canonicalName] === winner.root.key)
      winner.view.preferred = true;
    if (options.markShadowed !== false) {
      // `enabled` 传赢家的启用状态：界面靠它区分「另一份在跑」与「两份都不生效」。
      // 少了这个字段，被覆盖的一行只能说「同名技能 X 正在生效」—— 而 X 停用时那是假话。
      const winnerEnabled = winner.policy.enabled === true;
      for (const item of shadowed)
        item.view.shadowedBy = {
          root: winner.root.key,
          name: winner.entry.name,
          enabled: winnerEnabled,
        };
    }
    if (options.markWinner !== false) winner.view.winner = true;
    winner.view.enabled = winner.policy.enabled;
    winner.view.canonicalName = canonicalName;
  }
  return winners;
}

/** DSH、常见 Agent、自定义目录与活动 Session 项目根的技能快照。 */
export async function state(
  options: { projectCwds?: string[] } = {},
): Promise<StateResult> {
  const policyResult = await readManagerState();
  const removedKeys = new Set<string>(
    Array.isArray(policyResult.state.removedSources)
      ? policyResult.state.removedSources
      : [],
  );
  // 已移除的来源仍然出现在 roots 里（界面要能显示「已移除」并允许恢复），但**不扫描**：
  // 技能不入列表、不参与重名决胜 —— 这正是用户要的「不读取这个文件夹」。
  // 注意这里必须用**全部**来源 + 自定义来源，不能只用 activeUserRoots()，
  // 否则被移除的来源会连行都不剩，界面就无从提供「恢复读取」。
  const user = [...userRoots(), ...customRootsFromState(policyResult.state)];
  const scannable = user.filter((root) => !removedKeys.has(root.key));
  const userScans = await scanDeduplicatedRoots(scannable);
  const projectWarnings: SkillWarning[] = [];
  const scoped = await projectRoots(options.projectCwds, projectWarnings);
  const trash = await listTrash();
  const result: StateResult = {
    roots: [],
    projects: [],
    trash,
    warnings: [
      ...(policyResult.warning ? [policyResult.warning] : []),
      ...projectWarnings,
    ],
  };
  // 回收站没有自动清理：超龄条目通过 warnings 提示用户到 Skills 管理页处理，
  // 避免静默删除用户可能还想恢复的内容。
  const TRASH_STALE_DAYS = 30;
  const staleTrashCount = trash.filter((item) => {
    const deletedAt = Date.parse(String(item && item.deletedAt));
    return Number.isFinite(deletedAt) && Date.now() - deletedAt > TRASH_STALE_DAYS * 86400000;
  }).length;
  if (staleTrashCount > 0)
    result.warnings.push({
      code: "warning.trash.stale",
      params: { count: staleTrashCount, days: TRASH_STALE_DAYS },
      error: `回收站中有 ${staleTrashCount} 个条目已超过 ${TRASH_STALE_DAYS} 天，建议到 Skills 管理页清理`,
    });
  const all: StateItem[] = [];
  for (const root of [...scoped, ...user]) {
    const isRemoved = removedKeys.has(root.key);
    const { exists, entries, truncated } = isRemoved
      ? { exists: false, entries: [], truncated: false }
      : root.scope === "project"
        ? ((await scanDeduplicatedRoots([root])).get(root.key) as ScanResult)
        : (userScans.get(root.key) as ScanResult);
    if (isRemoved) {
      // 已移除：登记一行（供界面显示与恢复），但没有任何技能。
      result.roots.push({
        key: root.key,
        ...(root.kind ? { kind: root.kind } : {}),
        ...(root.localeKey ? { localeKey: root.localeKey } : {}),
        path: root.path,
        label: root.label,
        mutable: root.mutable,
        deletable: root.deletable === true,
        removable: !isDefaultSkillSource(root) && root.scope !== "project",
        // 自定义来源（用户手加的目录）：只有它能「永久删除」——按约定发现的来源删不掉。
        custom: root.custom === true,
        // 默认来源（dsh / hub）：界面据此隐藏来源开关、只显示「可管理」标记。
        defaultSource: isDefaultSkillSource(root),
        toggleable: root.toggleable,
        native: root.native,
        rank: root.rank,
        scope: root.scope || "user",
        exists: false,
        truncated: false,
        removed: true,
        enabled: false,
        skills: [],
      });
      continue;
    }
    // 即使项目 .dsh/skills 尚不存在，也要把可写根返回给创建表单；只读项目根仍按实际存在性展示。
    if (root.scope === "project" && !exists && root.kind !== "project-dsh")
      continue;
    if (truncated)
      result.warnings.push({
        code: "warning.scan.truncated",
        params: { path: root.path },
        error: `技能扫描达到遍历上限，部分技能未显示: ${root.path}`,
      });
    const skills: StateSkill[] = [];
    for (const e of entries) {
      const policy = effectiveSkillPolicy(policyResult, root, e);
      const managerEnabled =
        policyResult.writable !== false &&
        policy.sourceEnabled &&
        policy.override !== false;
      skills.push({
        name: e.name,
        declaredName: e.declaredName,
        kind: e.kind,
        description: e.description,
        modelInvocable: e.modelInvocable,
        userInvocable: e.userInvocable,
        invocationPolicyValid: e.invocationPolicyValid,
        hasFrontmatter: e.hasFrontmatter,
        loadable: e.loadable,
        managerEnabled,
        managerOverride: policy.override === undefined ? null : policy.override,
        effectiveModelInvocable: policy.modelInvocable,
        effectiveUserInvocable: policy.userInvocable,
        diagnostics: e.diagnostics,
        path: e.docPath,
      });
      all.push({
        root,
        entry: e,
        managerEnabled,
        policy,
        view: skills[skills.length - 1],
      });
    }
    result.roots.push({
      key: root.key,
      ...(root.kind ? { kind: root.kind } : {}),
      ...(root.localeKey ? { localeKey: root.localeKey } : {}),
      path: root.path,
      label: root.label,
      mutable: root.mutable,
      // 是否提供「删除」：dsh / hub / 项目级 .dsh/skills 为 true；
      // 外部 Agent 与自定义绝对路径来源为 false（只读）。
      deletable: root.deletable === true,
      toggleable: root.toggleable,
      native: root.native,
      rank: root.rank,
      scope: root.scope || "user",
      ...(root.projectRoot
        ? {
            projectRoot: root.projectRoot,
            projectName: root.projectName,
            workspaceCwds: root.workspaceCwds,
          }
        : {}),
      exists,
      truncated: truncated === true,
      // 界面用：能否从管理器「移除」（不再读取）。dsh / hub / 项目级不可移除。
      removable: !isDefaultSkillSource(root) && root.scope !== "project",
      // 自定义来源（用户手加的目录）：只有它能「永久删除」——按约定发现的来源删不掉。
      custom: root.custom === true,
      // 默认来源（dsh / hub）：界面据此隐藏来源开关（它们不能停用），换成「可管理」标记。
      defaultSource: isDefaultSkillSource(root),
      removed: false,
      enabled:
        policyResult.writable !== false &&
        (root.scope === "project" ||
          isDefaultSkillSource(root) ||
          policyResult.state.sources[root.key] !== false),
      skills,
    });
  }
  const userItems = all.filter((item) => item.root.scope !== "project");
  const preferredSkills = policyResult.state.preferredSkills || null;
  markWinners(userItems, { preferred: preferredSkills });
  const projectGroups = new Map();
  for (const item of all.filter(
    (candidate) => candidate.root.scope === "project",
  )) {
    const group = projectGroups.get(item.root.projectRoot) || [];
    group.push(item);
    projectGroups.set(item.root.projectRoot, group);
  }
  for (const projectItems of projectGroups.values()) {
    // 用户级条目参与该 workspace 的优先级判定，但不把其全局视图标记为“被某项目覆盖”。
    const userCopies = userItems.map((item) => ({
      ...item,
      view: { ...item.view },
    }));
    markWinners([...projectItems, ...userCopies], { preferred: preferredSkills });
  }
  const seenProjects = new Set();
  for (const root of result.roots.filter((item) => item.scope === "project")) {
    if (seenProjects.has(root.projectRoot)) continue;
    seenProjects.add(root.projectRoot);
    result.projects.push({
      root: root.projectRoot,
      name: root.projectName,
      workspaceCwds: root.workspaceCwds,
    });
  }
  result.summary = {
    total: all.length,
    enabled: all.filter((item) => item.view.enabled === true).length,
    disabled: all.filter(
      (item) => item.entry.loadable && item.policy.enabled === false,
    ).length,
    issues: all.reduce(
      (count, item) =>
        count + item.entry.diagnostics.length + (item.view.shadowedBy ? 1 : 0),
      0,
    ),
  };
  return result;
}

export { KEBAB_RE };
