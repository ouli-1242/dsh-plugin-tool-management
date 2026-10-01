// 技能来源与路径底座：四个用户级来源、项目级来源、各类 root/state/trash 路径的推导，
// 以及「这条路径算不算在那个来源里」的比较口径。
//
// 声明从 skills/core.ts 按行号区间搬来，正文一字未改（唯一的容差是 `--export-top-level`
// 加的 `export ` 前缀，moved-verify 逐字对拍）。
//
// 为什么先剥这一层：core.ts 里往上数的每一个域（manager 状态、启停策略、导入链路、上传、
// 回收站）都落在这组路径函数上，而它们自己只向下引 ./official.js / ./homes.js / node:*。
// 于是这一层搬出去是**单向**的：core.js 引它，它不引 core.js，加载图无环。
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { lstatOrNull, pathIdentity } from "./core-util.js";
import { OFFICIAL_SOURCE_KEY, officialSkillRoot } from "./official.js";
import { resolveAgentsHome, resolveDshHome } from "./homes.js";
import { isSameOrDescendant, isValidSegment } from "../paths.js";
import type {
  FailureResult,
  ProjectRootProbe,
  ProjectSource,
  ProjectSourceCommon,
  RootInput,
  SkillSource,
  SkillWarning,
} from "./core-types.js";
export function userRoots(): SkillSource[] {
  const official = officialSkillRoot();
  return [
    {
      key: "dsh",
      path: join(resolveDshHome(), "skills"),
      label: "DSH 技能",
      mutable: true,
      // 默认来源：路径不可移除、不可停用（必须读取），但里面的技能可删（见 isDefaultSkillSource）。
      deletable: true,
      // 注意：`toggleable` 指的是「这个来源里的**单个技能**能否启停」，与来源开关无关 ——
      // 来源层的启停/移除由 isDefaultSkillSource 判定，两者别混。
      toggleable: true,
      native: true,
      rank: 400,
    },
    // 官方内置紧随 DSH 技能之后（用户裁定）：同为一眼要看的来源，排在导入技能之前。
    ...(official === null ? [] : [official]),
    {
      // v0.4：插件**新建/导入**的技能落到 hub 内（用户要求：插件产生的文件收在
      // $DSH_HOME/tool-management/）。rank 高于 DSH 技能，同名时 hub 版本遮蔽官方目录里的；
      // 官方 ~/.dsh/skills/ 仍作为可切换来源列出（不搬走、不删）。
      //
      // 界面名「导入技能」：它是插件导入/新建技能的落点，不是"管理器自己的一类技能"。
      // 与 dsh 同为默认来源：路径必须读取（不可移除、不可停用），里面的技能可删。
      key: "hub",
      path: join(resolveDshHome(), "tool-management", "skills"),
      label: "导入技能",
      localeKey: "hub",
      mutable: true,
      deletable: true,
      toggleable: true,
      native: false,
      rank: 350,
    },
    {
      key: "agents",
      path: join(resolveAgentsHome(), "skills"),
      label: "公共 Agent",
      mutable: false,
      toggleable: true,
      native: true,
      rank: 450,
    },
    {
      key: "codex",
      path: join(
        process.env.DSH_CODEX_HOME || join(homedir(), ".codex"),
        "skills",
      ),
      label: "Codex",
      mutable: false,
      toggleable: true,
      native: false,
      rank: 520,
    },
    {
      key: "claude",
      path: join(
        process.env.DSH_CLAUDE_HOME || join(homedir(), ".claude"),
        "skills",
      ),
      label: "Claude",
      mutable: false,
      toggleable: true,
      native: false,
      rank: 530,
    },
  ];
}
export const DEFAULT_SOURCE_KEYS = Object.freeze(["dsh", "hub", OFFICIAL_SOURCE_KEY]);
export function isDefaultSkillSource(rootOrKey: unknown): boolean {
  const key =
    rootOrKey && typeof rootOrKey === "object"
      ? (rootOrKey as { key?: unknown }).key
      : rootOrKey;
  return DEFAULT_SOURCE_KEYS.includes(key as string);
}
export function projectIdentity(path: string): string {
  const canonical = pathIdentity(path);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
export function customRootKey(path: string): string {
  return "custom-" + projectIdentity(path);
}
export async function nearestProjectRoot(cwd: unknown): Promise<ProjectRootProbe> {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
  let start;
  try {
    start = await fs.realpath(resolve(cwd));
    if (!(await fs.stat(start)).isDirectory()) return null;
  } catch (error) {
    // 目录不存在（会话还开着、项目已被删）是最常见的一类：带上系统错误码，
    // 调用方对 ENOENT 静默跳过 —— 报警留给真正读不了的目录。
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    return { unavailable: true, cwd, ...(code ? { code } : {}) };
  }
  let current = start;
  for (;;) {
    try {
      await fs.lstat(join(current, ".git"));
      return { root: current, cwd: start };
    } catch {
      /* 继续向上查找最近的项目根 */
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
export async function projectSourceSafe(definition: ProjectSource) {
  // 只读来源允许目录链接，但重叠来源会绕过用户根的停用策略。
  if (definition.kind === "project-agents")
    return !(await overlapsUserSkillRoot(definition.path));
  const container = join(
    definition.projectRoot,
    definition.kind === "project-dsh" ? ".dsh" : ".agents",
  );
  for (const path of [container, definition.path]) {
    const st = await lstatOrNull(path);
    if (st && (!st.isDirectory() || st.isSymbolicLink())) return false;
  }
  return !(await overlapsUserSkillRoot(definition.path));
}
export async function projectRoots(
  projectCwds: string[] = [],
  diagnostics?: SkillWarning[],
): Promise<ProjectSource[]> {
  const projects = new Map<string, { root: string; cwds: Set<string> }>();
  for (const cwd of Array.isArray(projectCwds) ? projectCwds : []) {
    const found = await nearestProjectRoot(cwd);
    if (!found || !found.root) {
      // 目录不存在（ENOENT）= 会话开着、项目已删：这是常态而不是故障，静默跳过。
      // 报警只留给真实读不了的目录（权限、损坏的链接等）。
      if (found && found.unavailable && found.code === "ENOENT") continue;
      if (
        found &&
        found.unavailable &&
        Array.isArray(diagnostics) &&
        typeof cwd === "string" &&
        isAbsolute(cwd)
      ) {
        diagnostics.push({
          code: "warning.project.unavailable",
          params: { path: cwd },
          error: `活动会话的项目目录不可访问，项目技能未显示: ${cwd}`,
        });
      }
      continue;
    }
    const identity = pathIdentity(found.root);
    const existing = projects.get(identity) || {
      root: found.root,
      cwds: new Set<string>(),
    };
    existing.cwds.add(found.cwd);
    projects.set(identity, existing);
  }
  const roots: ProjectSource[] = [];
  for (const project of [...projects.values()].sort((a, b) =>
    a.root.localeCompare(b.root),
  )) {
    const id = projectIdentity(project.root);
    const common: ProjectSourceCommon = {
      mutable: false,
      // 未知/只读来源（外部 Agent 与自定义绝对路径）一律不可删；用户级 dsh / hub
      // 与本仓库的项目级 .dsh/skills 都是可删的（见上方两处 `deletable: true`）。
      deletable: false,
      toggleable: false,
      native: true,
      scope: "project",
      projectRoot: project.root,
      projectName: basename(project.root) || project.root,
      workspaceCwds: [...project.cwds].sort(),
    };
    const candidates: ProjectSource[] = [
      {
        ...common,
        key: `project-dsh:${id}`,
        kind: "project-dsh",
        localeKey: "projectDsh",
        path: join(project.root, ".dsh", "skills"),
        label: "Project DSH",
        rank: 100,
        mutable: true,
        deletable: true,
        toggleable: true,
      },
      {
        ...common,
        key: `project-agents:${id}`,
        kind: "project-agents",
        localeKey: "projectAgents",
        path: join(project.root, ".agents", "skills"),
        label: "Project Agent",
        rank: 200,
        toggleable: true,
      },
    ];
    for (const candidate of candidates) {
      if (await projectSourceSafe(candidate)) roots.push(candidate);
    }
  }
  return roots;
}
export function managerHomePath() {
  return join(resolveDshHome(), "tool-management");
}
export function managerStatePath() {
  return join(managerHomePath(), "skills-state.json");
}
export function trashRootPath() {
  return join(managerHomePath(), "trash", "skills-trash");
}
export function dshRootPath(): string {
  // userRoots() 恒含 dsh 来源（见上方列表），断言只为让类型收敛。
  return (userRoots().find((root) => root.key === "dsh") as SkillSource).path;
}
export function skillCreateRootPath() {
  const hub = userRoots().find((root) => root.key === "hub");
  return hub && hub.path ? hub.path : dshRootPath();
}
export function readonlyError(action: string): FailureResult {
  return {
    ok: false,
    code: "error.root.readonly",
    params: { action },
    error:
      action === "delete"
        ? "该技能来源不允许删除"
        : "该技能来源不允许启用或停用",
  };
}
export function rootDefinition(root: RootInput): SkillSource | null {
  if (root && typeof root === "object" && typeof root.key === "string")
    return root;
  if (typeof root !== "string") return null;
  const resolved = resolve(root);
  return userRoots().find((item) => resolve(item.path) === resolved) || null;
}
export function rootByKey(key: unknown): SkillSource | null {
  return userRoots().find((item) => item.key === key) || null;
}
export async function resolvedPath(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    return resolve(path);
  }
}
export async function comparisonPath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(await fs.realpath(current), ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}
export async function overlapsUserSkillRoot(path: string): Promise<boolean> {
  const candidate = await comparisonPath(path);
  for (const root of userRoots()) {
    const userPath = await comparisonPath(root.path);
    if (
      isSameOrDescendant(candidate, userPath) ||
      isSameOrDescendant(userPath, candidate)
    )
      return true;
  }
  return false;
}