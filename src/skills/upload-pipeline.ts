// 上传落盘链路：把界面送来的 Base64 目录 / ZIP 校成一份合法来源，写进技能根目录。
//
// 声明从 skills/core.ts 按行号区间搬来，正文一字未改（唯一的容差是 `--export-top-level`
// 加的 `export ` 前缀，moved-verify 逐字对拍）。
//
// 为什么这一段终于能搬：它向下要的东西分三层齐了 —— 路径与来源在 ./skill-roots.js、
// 错误码与原子改名在 ./core-util.js、预检（读成候选 / 拒符号链 / 临时件 / 替换）在
// ./import-pipeline.js。0.18.0 那次试切判给不做，缺的就是这三层：当时它们全在 core.ts 里，
// 搬上传段必然反过来引 core，而 core 的 handlers 又引上传 ⇒ 运行时环。
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { isSameOrDescendant } from "../paths.js";
import { parseSkillDoc, toKebab } from "./frontmatter.js";
import {
  attachCode,
  codedError,
  entryPath,
  lstatOrNull,
  MAX_ENTRY_NAME_LENGTH,
  renameWithRetry,
} from "./core-util.js";
import {
  analyzeSource,
  collectCandidates,
  MAX_SOURCE_DEPTH,
  preflightCandidates,
  replaceWithCopy,
} from "./import-pipeline.js";
import { managerHomePath, resolvedPath, skillCreateRootPath } from "./skill-roots.js";
import type {
  ImportCandidate,
  ImportConflict,
  ImportFailure,
  ImportImported,
  ImportOptions,
  ImportPending,
  ImportSkipped,
  LogFn,
  UploadPath,
} from "./core-types.js";

export const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const WINDOWS_DEVICE_NAME_RE =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
export const MAX_UPLOAD_ARCHIVE_BYTES = 32 << 20;
export const MAX_UPLOAD_ENTRY_BYTES = 32 << 20;
export const MAX_UPLOAD_TOTAL_BYTES = 64 << 20;
export const MAX_UPLOAD_ENTRIES = 1000;
export const MAX_UPLOAD_PATH_LENGTH = 512;
export async function pathsOverlap(a: string, b: string): Promise<boolean> {
  const left = await resolvedPath(a);
  const right = await resolvedPath(b);
  return isSameOrDescendant(left, right) || isSameOrDescendant(right, left);
}
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
export function pathSegmentRewritten(part: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(part)) return true;
  return part !== part.replace(/[.\s]+$/, "");
}
export function normalizeUploadPath(input: unknown): UploadPath {
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
export function decodeUploadBase64(
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
export function uploadError(error: unknown) {
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
export async function writeUploadedEntries(
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
export async function writeUploadedZip(contentRoot: string, encoded: unknown): Promise<void> {
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
export interface UploadSource {
  name?: unknown;
  entries?: unknown;
  zip?: unknown;
}
export async function prepareUploadedSource(
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