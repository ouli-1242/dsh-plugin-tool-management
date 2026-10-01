// 导入预检链路：把来源目录读成候选清单、拒符号链接、拷进同目录临时件、原子替换目标。
//
// 声明从 skills/core.ts 按行号区间搬来，正文一字未改（唯一的容差是 `--export-top-level`
// 加的 `export ` 前缀，moved-verify 逐字对拍）。
//
// 为什么这一层要独立：它是「导入」这条链的下半段，向下只引 ./core-util.js 与 node:* /
// ../paths.js，**不回引 core.js** —— 所以 core.js 反过来引它是单向的，加载图无环。
// 留在 core.ts 里时，任何想把上传/导入段搬出去的尝试都会撞到这个环上（0.18.0 试过一回，
// 判给不做就是这个原因）。
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { attachCode, codedError, lstatOrNull, renameWithRetry, temporaryPath } from "./core-util.js";
import { isInsideRootResolved } from "../paths.js";
import { toKebab } from "./frontmatter.js";
import type {
  ImportCandidate,
  ImportFailure,
  ImportSourceRef,
  SkillWarning,
  SourceAnalysis,
} from "./core-types.js";

export const MAX_SOURCE_DEPTH = 64;
export async function analyzeSource(source: string): Promise<SourceAnalysis> {
  let st;
  try {
    st = await fs.lstat(source);
  } catch {
    return {
      kind: "none",
      error: `路径不存在: ${source}`,
      code: "error.source.notFound",
      params: { path: source },
    };
  }
  if (st.isSymbolicLink())
    return {
      kind: "none",
      error: `不支持包含符号链接的 skill 来源: ${source}`,
      code: "error.source.symlink",
      params: { path: source },
    };
  if (st.isDirectory()) {
    const sk = join(source, "SKILL.md");
    const skSt = await lstatOrNull(sk);
    // 预检与实际导入口径一致：SKILL.md 本身是链接时直接拒绝，避免 dry-run 通过、正式导入才失败。
    if (skSt && skSt.isSymbolicLink())
      return {
        kind: "none",
        error: `不支持包含符号链接的 skill 来源: ${sk}`,
        code: "error.source.symlink",
        params: { path: sk },
      };
    if (skSt && skSt.isFile()) {
      return {
        kind: "single",
        rawName: basename(source),
        kebab: toKebab(basename(source)),
        source,
        isDir: true,
        skillFile: sk,
      };
    }
    return { kind: "batch", rawName: basename(source), source, isDir: true };
  }
  if (st.isFile() && source.toLowerCase().endsWith(".md")) {
    if (basename(source).toLowerCase() === "skill.md") {
      const parent = dirname(source);
      return {
        kind: "single",
        rawName: basename(parent),
        kebab: toKebab(basename(parent)),
        source: parent,
        isDir: true,
        skillFile: source,
      };
    }
    const rawName = basename(source).slice(0, -3);
    return {
      kind: "single",
      rawName,
      kebab: toKebab(rawName),
      source,
      isDir: false,
      skillFile: source,
    };
  }
  return {
    kind: "none",
    error: `无法识别的 skill 来源: ${source}`,
    code: "error.source.unrecognized",
    params: { path: source },
  };
}
export async function collectCandidates(dir: string): Promise<ImportCandidate[]> {
  const items = await fs.readdir(dir, { withFileTypes: true });
  const out: ImportCandidate[] = [];
  for (const it of items) {
    if (it.isSymbolicLink())
      throw codedError(
        `不支持包含符号链接的 skill 来源: ${join(dir, it.name)}`,
        "error.source.symlink",
        { path: join(dir, it.name) },
      );
    if (it.isDirectory()) {
      const sk = join(dir, it.name, "SKILL.md");
      // lstatOrNull 吞掉 IO 异常（返回 null 即跳过）；symlink 必须抛出，不能被“跳过”逻辑掩盖。
      const st = await lstatOrNull(sk);
      if (st && st.isSymbolicLink())
        throw codedError(
          `不支持包含符号链接的 skill 来源: ${sk}`,
          "error.source.symlink",
          { path: sk },
        );
      if (st && st.isFile()) {
        out.push({
          source: join(dir, it.name),
          kebab: toKebab(it.name),
          rawName: it.name,
          isDir: true,
        });
      }
    } else if (
      it.isFile() &&
      it.name.toLowerCase().endsWith(".md") &&
      it.name.toLowerCase() !== "skill.md"
    ) {
      out.push({
        source: join(dir, it.name),
        kebab: toKebab(it.name.slice(0, -3)),
        rawName: it.name.slice(0, -3),
        isDir: false,
      });
    }
  }
  return out;
}
export async function assertNoSymbolicLinks(source: string): Promise<void> {
  const pending: { path: string; depth: number }[] = [
    { path: source, depth: 0 },
  ];
  while (pending.length) {
    // while 条件保证栈非空，断言只为让类型收敛。
    const current = pending.pop() as { path: string; depth: number };
    if (current.depth > MAX_SOURCE_DEPTH)
      throw codedError(
        `skill 来源目录层级超过 ${MAX_SOURCE_DEPTH} 层: ${source}`,
        "error.source.tooDeep",
        { depth: MAX_SOURCE_DEPTH, path: source },
      );
    const st = await fs.lstat(current.path);
    if (st.isSymbolicLink())
      throw codedError(
        `不支持包含符号链接的 skill 来源: ${current.path}`,
        "error.source.symlink",
        { path: current.path },
      );
    if (!st.isDirectory()) continue;
    const items = await fs.readdir(current.path, { withFileTypes: true });
    for (const item of items) {
      const path = join(current.path, item.name);
      if (item.isSymbolicLink())
        throw codedError(
          `不支持包含符号链接的 skill 来源: ${path}`,
          "error.source.symlink",
          { path },
        );
      if (item.isDirectory()) pending.push({ path, depth: current.depth + 1 });
    }
  }
}
export async function preflightCandidates(
  pending: ImportSourceRef[],
  conflicts: ImportSourceRef[],
  failed: ImportFailure[],
): Promise<void> {
  for (const group of [pending, conflicts]) {
    for (let i = group.length - 1; i >= 0; i--) {
      const candidate = group[i];
      try {
        await assertNoSymbolicLinks(candidate.source);
      } catch (error: any) {
        // 系统异常按可选 message 读取，保持既有失败明细文案。
        failed.push(
          attachCode(
            {
              source: candidate.source,
              error: String(error && error.message ? error.message : error),
            },
            error,
          ),
        );
        group.splice(i, 1);
      }
    }
  }
}
export async function copyToTemporary(
  source: string,
  target: string,
  isDir: boolean,
): Promise<string> {
  const temp = temporaryPath(target, "stage");
  try {
    await assertNoSymbolicLinks(source);
    if (isDir)
      await fs.cp(source, temp, { recursive: true, dereference: false });
    else await fs.copyFile(source, temp);
    await assertNoSymbolicLinks(temp);
    return temp;
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
export async function replaceWithCopy(
  source: string,
  dest: string,
  isDir: boolean,
  existing: string[] = [],
): Promise<SkillWarning[]> {
  const stage = await copyToTemporary(source, dest, isDir);
  const backups: { path: string; backup: string }[] = [];
  // 三处 rename 一律走 `renameWithRetry`：瞬时占用（Windows 杀软 / 索引器 / 资源管理器）返回的
  // EACCES / EBUSY / EPERM 正是它重试的那些码。此前只有 `:959` 的回滚用了带重试的版本，
  // 而**发布与它的补偿回滚用的是裸 rename** —— 发布因瞬时锁抛错时，紧随其后的回滚在同一刻、
  // 同一目录上大概率撞同一个句柄，于是留下"目标已空、真值还叫 backup"的半态（无自动恢复路径）。
  // 保护覆盖不均不是取舍，是漏。
  try {
    for (const path of existing) {
      const backup = temporaryPath(path, "backup");
      await renameWithRetry(path, backup);
      backups.push({ path, backup });
    }
    await renameWithRetry(stage, dest);
  } catch (error: any) {
    // 系统异常按可选 message 读取，保持既有回滚失败明细。
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    const rollbackFailures: string[] = [];
    for (const item of backups.reverse()) {
      try {
        await renameWithRetry(item.backup, item.path);
      } catch (rollbackError) {
        rollbackFailures.push(item.backup);
      }
    }
    if (rollbackFailures.length) {
      const causeText = String(error && error.message ? error.message : error);
      throw codedError(
        `${causeText}；覆盖导入回滚失败，备份保留在: ${rollbackFailures.join("、")}`,
        "error.import.rollbackFailed",
        { path: rollbackFailures.join("; "), error: causeText },
      );
    }
    throw error;
  }
  const warnings: SkillWarning[] = [];
  for (const item of backups) {
    try {
      await fs.rm(item.backup, { recursive: true, force: true });
    } catch (error: any) {
      // 系统异常按可选 message 读取，保持既有告警文案。
      warnings.push({
        code: "warning.backupUncleaned",
        params: {
          path: item.backup,
          error: String(error && error.message ? error.message : error),
        },
        error: `旧版本备份未清理: ${item.backup}（${String(error && error.message ? error.message : error)}）`,
      });
    }
  }
  return warnings;
}