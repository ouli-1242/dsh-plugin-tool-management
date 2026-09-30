// $DSH_HOME / ~/.agents 两个用户级 home 的解析。
//
// 单独一层是为了断环：core.ts 与 official.ts 都要读它，让它留在 core.ts 里就等于
// official.ts 反向 import core.js。同目录已有先例（memories/constants.ts 也是为断环抽出）。
// 两个函数的口径照旧读环境变量，没有引入任何新解析。
import { homedir } from "node:os";
import { join } from "node:path";

// ── 路径解析 ────────────────────────────────────────────────────────────────

export function resolveDshHome(): string {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function resolveAgentsHome(): string {
  return process.env.DSH_AGENTS_HOME || join(homedir(), ".agents");
}