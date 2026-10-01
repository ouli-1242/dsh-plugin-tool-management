// 技能核心的公共底座：业务错误码的构造与透传、条目路径谓词、可恢复 rename 的重试、
// 同目录临时文件名。
//
// 声明从 core.ts 逐个搬来（`--export-top-level` 只多 `export ` 前缀，正文一字未改）。
// 为什么要先有这一层：codedError / attachCode / lstatOrNull / renameWithRetry 这四件被
// **导入链路与技能读写两侧同时用到**，留在 core.ts 里就意味着任何从 core 搬出去的下游段
// 都要反过来引 core —— 那是运行时环。搬到这里，core.ts 与导入链路两侧都只向下引这一层。
// 这一层自己不引同目录的任何兄弟模块（只引 ../paths.js 与 node:*）。
import { basename, dirname, join, resolve } from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { isSameOrDescendant, isValidSegment } from "../paths.js";
import type { RenameOptions } from "./core-types.js";

export const MAX_ENTRY_NAME_LENGTH = 128;
export const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
// ── 业务错误码 ────────────────────────────────────────────────────────────────

/** 构造带 code/params 的业务 Error，供导入链路 throw 后透传到失败明细。 */
export function codedError(
  message: string,
  code: string,
  params?: Record<string, unknown>,
): Error & { code: string; params?: Record<string, unknown> } {
  const error = new Error(message) as Error & {
    code: string;
    params?: Record<string, unknown>;
  };
  error.code = code;
  error.params = params;
  return error;
}

/** 把业务 Error 的 code/params 附加到失败明细；系统异常（ENOENT 等，非 error.* 前缀）保持原文。 */
export function attachCode(item: any, error: unknown): any {
  // 透传并回写任意失败明细对象（形状由各调用点决定），故按 any 处理。
  const coded = error as { code?: unknown; params?: unknown } | null | undefined;
  if (coded && typeof coded.code === "string" && /^error\./.test(coded.code))
    item.code = coded.code;
  if (coded && coded.params) item.params = coded.params;
  return item;
}
export function pathIdentity(path: string): string {
  const canonical = resolve(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
export async function lstatOrNull(path: string) {
  try {
    return await fs.lstat(path);
  } catch {
    return null;
  }
}
/** 名称只允许一个普通路径段；不把既有技能名称限制为 kebab-case。 */
export function entryPath(root: string, name: string): string | null {
  // 段名谓词收敛到 paths.js（此前与 rules / subagents / imports 各写一套，口径不一）。
  // 原实现里 `basename(name) !== name` 那条已被谓词的「不含路径分隔符」覆盖。
  if (!isValidSegment(name, MAX_ENTRY_NAME_LENGTH)) return null;
  const rootPath = resolve(root);
  const path = resolve(rootPath, name);
  return isSameOrDescendant(rootPath, path) && rootPath !== path ? path : null;
}
/** 同目录临时文件加 rename，避免写入中断时截断原 SKILL.md。 */
/** Windows 上杀毒软件或索引器可能短暂占用目录；只重试明确可恢复的 rename 错误。 */
export async function renameWithRetry(
  source: string,
  destination: string,
  options: RenameOptions = {},
) {
  const rename =
    typeof options.rename === "function" ? options.rename : fs.rename;
  // Number.isInteger/isFinite 不收窄类型，故断言成 number 以保持既有比较表达式。
  const maxAttempts =
    Number.isInteger(options.maxAttempts) && (options.maxAttempts as number) > 0
      ? (options.maxAttempts as number)
      : 6;
  const delayMs =
    Number.isFinite(options.delayMs) && (options.delayMs as number) >= 0
      ? (options.delayMs as number)
      : 40;
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(source, destination);
    } catch (error: any) {
      // 系统 rename 异常按可选 code 读取，保持既有重试判定。
      if (
        !TRANSIENT_RENAME_CODES.has(error && error.code) ||
        attempt >= maxAttempts
      )
        throw error;
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, delayMs * attempt),
      );
    }
  }
}
export function temporaryPath(target: string, kind: string): string {
  return join(
    dirname(target),
    `.${basename(target)}.dssm-${kind}-${randomUUID()}`,
  );
}