// 技能回收站：可写根目录的判定、把条目移进/移出回收站的落盘动作，与回收站清单的读写。
//
// 声明从 skills/core.ts 按行号区间搬来，正文一字未改（唯一的容差是 `--export-top-level`
// 加的 `export ` 前缀，moved-verify 逐字对拍）。
//
// 与 ./system-trash.ts 不是一回事：那一层管的是**操作系统**回收站（把删掉的东西交给
// explorer / Finder / gio），这一层管的是本插件自己的 `~/.dsh/tool-management/trash/`。
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { isSameOrDescendant } from "../paths.js";
import {
  codedError,
  entryPath,
  lstatOrNull,
  pathIdentity,
  renameWithRetry,
} from "./core-util.js";
import {
  dshRootPath,
  overlapsUserSkillRoot,
  projectIdentity,
  projectRoots,
  readonlyError,
  rootByKey,
  rootDefinition,
  skillCreateRootPath,
  trashRootPath,
} from "./skill-roots.js";
import type {
  EntryPathTarget,
  FailureResult,
  LogFn,
  RenameOptions,
  RootInput,
  SkillSource,
  TrashMetadata,
  TrashRestoreResult,
  TrashRootMetadata,
  WritableRootResult,
  WriteOptions,
} from "./core-types.js";

export function writableRootDefinition(root: RootInput): SkillSource | null {
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
export async function checkedWritableRootDefinition(
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
export async function removeMovedPath(path: string): Promise<void> {
  const st = await lstatOrNull(path);
  if (!st) return;
  if (st.isDirectory() && !st.isSymbolicLink())
    await fs.rm(path, { recursive: true, force: false });
  else await fs.unlink(path);
}
export async function movePathWithFallback(
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
export async function safeExistingEntryPaths(
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
export async function readTrashMetadata(id: string): Promise<TrashMetadata | null> {
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
export function trashRootMetadata(definition: SkillSource): TrashRootMetadata {
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
export async function restoreRootDefinition(
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