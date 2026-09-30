// 工作区路径的归一化比较键与展示名。
//
// 从 sessions/workspace.ts 整段搬来，一行未改。workspacePathKey 的口径注释里写着它不是
// 「只用于分组」而是决定会话挂回哪条登记，也写着它比宿主 realpathNormalize 更宽 ——
// 那两条是本插件的已知假设，改这个文件前先读它们。

/**
 * 路径比较键：工作区的唯一性在宿主侧是 realpath 字符串相等（dsh-workspace
 * `realpathNormalize`），Windows 盘符大小写与分隔符拼写却可能不同，因此比较前
 * 先归一化。
 *
 * ⚠ 它不是"只用于分组"：它决定**哪些会话被挂回哪条登记** —— `registerWorkspace` 会调
 * `attachKnownSessions`，后者按这个键挑选会话并写宿主记账（`sessionIds`）；
 * `ensureWorkspaceAccounting` 也拿它当去重键后 `host.create` + 挂回。
 * 而且它比宿主更宽：宿主 `realpathNormalize` 只是 `fs.realpath`（**不做大小写归一**），
 * 本函数在 Windows 上 `toLowerCase()` ⇒ `C:\Proj` 与 `c:\proj` 在插件里同组、在宿主里
 * 可以是两条登记。挂回前应以宿主 `resolveByPath` 实际返回的 id 复核，而不是按归一字符串匹配。
 * @param {string} path - 原始路径。
 * @returns {string} 归一化后的比较键（空路径返回空串）。
 */
export function workspacePathKey(path: unknown): string {
	const raw = String(path ?? "").trim();
	if (!raw) return "";
	const windows = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\");
	let out = windows ? raw.replace(/\//g, "\\") : raw;
	while (out.length > 1 && (out.endsWith("\\") || out.endsWith("/"))) out = out.slice(0, -1);
	return windows ? out.toLowerCase() : out;
}
/**
 * 展示用目录名（与宿主 `defaultWorkspaceTitle` 同义：末段，无末段则用根拼写）。
 * @param {string} path - 原始路径。
 * @returns {string} 非空展示名。
 */
export function workspaceBaseName(path: unknown): string {
	const raw = String(path ?? "").trim();
	if (!raw) return "";
	const trimmed = raw.replace(/[\\/]+$/, "");
	const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
	const segment = index >= 0 ? trimmed.slice(index + 1) : trimmed;
	if (segment) return segment;
	const root = trimmed.match(/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/);
	return root ? root[0] : trimmed || raw;
}