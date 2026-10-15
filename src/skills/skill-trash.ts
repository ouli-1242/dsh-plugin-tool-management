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
  temporaryPath,
} from "./core-util.js";
import { rewriteDeclaredName } from "./frontmatter.js";
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
// `KEBAB_RE` 的单一真相源在 upload-pipeline（manager-state / core 也都从那里取）。
import { KEBAB_RE } from "./upload-pipeline.js";
import type {
  EntryPathTarget,
  FailureResult,
  LogFn,
  RenameOptions,
  RestoreOptions,
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
  // v0.4：hub 内技能目录同为用户级可写根（插件导入/上传的落点）。
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
/**
 * 目标根里第一个空出来的退号名：`foo` → `foo-1` → `foo-2`…（与界面 `uniqueName` 的
 * `'dash'` 档同一写法）。
 *
 * 用半角连字符而不是全角括号：技能条目名必须过 `KEBAB_RE`，`foo（1）` 会被 `toKebab` 抹成
 * `foo-1` —— 写出来本来就是 `foo-1`，不如一开始就按这个写，省得"看着叫甲、落盘叫乙"。
 *
 * 候选本身不合法（超长 / 空）时直接放弃：再往后试也不会变合法。
 */
async function nextFreeSkillName(root: string, name: string): Promise<string | null> {
  for (let i = 1; i <= 999; i += 1) {
    const candidate = `${name}-${i}`;
    if (entryPath(root, candidate) === null) return null;
    if ((await safeExistingEntryPaths(root, candidate)).length === 0) return candidate;
  }
  return null;
}
/**
 * 退号恢复时把技能**声明名**改成新的落盘名（用户 2026-10-14）。
 *
 * 为什么必须改：`canonicalSkillName()` 取的是 frontmatter 里的 `name:`，**不是文件夹名** ——
 * 技能页的同名判定、`preferredSkills` 首选表、喂给宿主的 provider 候选名，全都以它为准。
 * 只把目录改成 `foo-1` 而里面仍写着 `name: foo`，等于恢复出一份"看着叫 foo-1、其实还是 foo"
 * 的技能：它会跟原件被判成同名，技能页于是给它一颗「启用这个」——而那颗按钮挑的是**来源**，
 * 两份都在同一个来源目录里，按下去什么都不会变。
 *
 * 只重写 `name:` 那一行的值，其余 frontmatter（块标量、`disable-model-invocation` 等）与正文
 * **逐字节保留**（正则只吃一个行内片段，连 CRLF 都不动）：恢复的语义是"把原件放回去"，
 * 不是"按当前模板重写一遍"——后者会顺手把用户写在别的键上的东西抹掉。
 *
 * 不动内容的情形一律返回 false（调用方只用来记日志）：名字不过 `KEBAB_RE`、形态认不出、
 * 没有 frontmatter、原本就没有 `name:` 行、声明名本来就对。**认不出就一个字节都不写** ——
 * 猜错形态会把附件目录里的 SKILL.md 当成技能文档改掉；替用户补一个缺失的 `name:` 也不行，
 * 那会把一份坏技能伪装成好的。
 */
async function retitleRestoredSkill(
  root: string,
  name: string,
  metadata: TrashMetadata,
): Promise<boolean> {
  if (!KEBAB_RE.test(name)) return false;
  // 形态与上面的 `entryNameFor` 同一口径：bundle 收的是 `<原名>`，flat 收的是 `<原名>.md`。
  const isBundle = metadata.entries.includes(metadata.name);
  const isFlat = metadata.entries.includes(`${metadata.name}.md`);
  // 两个都认得出或都认不出 = 形状不明，不猜。
  if (isBundle === isFlat) return false;
  const docPath = isBundle
    ? join(root, name, "SKILL.md")
    : resolve(root, `${name}.md`);
  const doc = await fs.readFile(docPath, "utf8");
  // 声明名改写走 frontmatter.ts 的共享助手（导入撞名的退号也用它）：只换 `name:`
  // 一行的值，其余逐字节保留；认不出形态返回 null —— 一个字节都不写。
  // 不加引号：`KEBAB_RE` 已经保证这个名字只含 `[a-z0-9-]`，没有任何需要转义的字符 ——
  // 与插件自己的写手（`createSkill` / `updateSkill` 的 `name: ${name}`）同一形状，
  // 免得"新建出来叫 demo-1、恢复出来叫 \"demo-1\""这种无谓的差别。
  const content = rewriteDeclaredName(doc, name);
  if (content === null) return false;
  const temp = temporaryPath(docPath, "restore");
  try {
    await fs.writeFile(temp, content, "utf8");
    await renameWithRetry(temp, docPath);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return true;
}
export async function restoreTrash(
  id: string,
  log: LogFn | undefined,
  options: RestoreOptions = {},
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
  /*
   * 同名先问一句（用户 2026-10-14）：撞名时**默认仍拒绝**，但把候选名字一起回（`params.next`），
   * 界面弹窗才能如实写出"确认后会叫 `foo-1`"；用户确认后带 `dedupe: true` 重来，这一次真的
   * 按退号的名字落盘。
   *
   * `dedupe` 缺省即旧行为 —— 这条 op 目前只有界面在用，但保留"缺省拒"这层是为了不给未来的
   * 调用方埋一个"撞名就悄悄改名"的默认值。
   */
  let name = metadata.name;
  const conflicts = await safeExistingEntryPaths(root, metadata.name);
  if (conflicts.length) {
    const candidate = await nextFreeSkillName(root, metadata.name);
    if (options.dedupe !== true || candidate === null)
      return {
        ok: false,
        error: `已存在同名技能: ${metadata.name}`,
        // 专用错误码（四个回收站统一）：界面按它认出"这是撞名"并弹确认窗，而不是靠比文案。
        code: "error.dup.conflict",
        params: { name: metadata.name, ...(candidate ? { next: candidate } : {}) },
      };
    name = candidate;
  }
  const renamed = name !== metadata.name;
  /**
   * 回收站条目里的**顶层条目名**跟着退号，其余（bundle 目录里的附件 / 脚本）原样 ——
   * `entries` 装的是当初移进回收站时那批顶层名字：bundle 是 `<名>`，flat 是 `<名>.md`
   * （见 core.ts 的 deleteSkill）。只有这两个与名字有关，别的名字改了就是改坏内容。
   */
  const entryNameFor = (fileName: string): string => {
    if (!renamed) return fileName;
    if (fileName === metadata.name) return name;
    if (fileName === `${metadata.name}.md`) return `${name}.md`;
    return fileName;
  };
  await fs.mkdir(root, { recursive: true });
  const itemRoot = join(trashRootPath(), id);
  const moved: { source: string; destination: string }[] = [];
  try {
    for (const fileName of metadata.entries) {
      const source = join(itemRoot, fileName);
      const destination = join(root, entryNameFor(fileName));
      if (
        !isSameOrDescendant(itemRoot, source) ||
        !isSameOrDescendant(root, destination)
      )
        throw codedError("回收站条目路径非法", "error.trash.invalid", { id });
      await movePathWithFallback(source, destination, options.renameOptions);
      moved.push({ source, destination });
    }
    // 顶层名字改完，文档里声明的名字也要跟上 —— 否则"看着叫 foo-1、其实还是 foo"，
    // 技能页仍按 foo 判同名。失败即抛：半份的恢复（目录改了、声明没改）正是要修的那个 bug。
    if (renamed && (await retitleRestoredSkill(root, name, metadata)))
      if (log) log("restore", `恢复技能时改写声明名 ${metadata.name} -> ${name}`);
    await fs.rm(itemRoot, { recursive: true, force: true });
    if (log) log("restore", `从回收站恢复 ${name} -> ${root}`);
    return { id, name, renamed, root: trashRootMetadata(definition) };
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