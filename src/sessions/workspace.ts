import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { CapabilityRefusalError, createSessionsBridge, requiredSessionCapabilities, type RegistryLike } from "./bridge.js";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hubPath } from "../hub.js";
import { sessionDir } from "@deepseek-ai/dsh-spill-local";
import { trackTombstone } from "./tombstone.js";
import type { CapabilityRefusal } from "../compat/probe.js";
import { noteRuntime } from "../compat/runtime-notes.js";
import type { SessionHeader } from "@deepseek-ai/dsh-session";
import type { Context } from "@deepseek-ai/cordis";

/**
 * A3-1：宿主补上了原生删除入口时上报一次（**不切换**，理由见 deleteSessionCore）。
 *
 * 上报本身就够用：它说明「本插件适配的那个缺口已经被官方补上了」，人工核对过原生语义
 * （级联 / spill / 记账 / 缓存行是否都覆盖）之后才谈切换。
 *
 * @param entry - 实际看到的是哪个原生入口（单删 / 批删），写进详情便于判断。
 */
function reportNativeDeleteAvailable(entry: "deleteSession" | "deleteArchivedSessions"): void {
	noteRuntime({
		id: "workspace.delete-native",
		label: "宿主原生删除入口",
		kind: "delete",
		fallback: "inform-only",
		detail: `宿主已提供原生 ${entry}：本插件仍走自有完整序列（级联子会话 + spill + 记账 + 缓存行），尚未切换到原生入口。`,
	});
}

/** 会话头部里本文件按运行时守卫读取的字段。 */
interface HeaderLike {
	id?: unknown;
	cwd?: unknown;
	createdAt?: unknown;
}

/** 宿主 JSONL 持久化后端在 `jsonlSessionDirectory` 里读到的字段。 */
interface TranscriptPersistenceLike {
	name?: unknown;
	root?: unknown;
	config?: { root?: unknown } | undefined;
}

/** `persistence.locate()` 的返回：kind 判后端布局，path 是定位到的工件路径。 */
interface TranscriptLocationLike {
	kind?: unknown;
	path: string;
}

/**
 * 宿主返回值校验器的输入：未经校验的外部记录。字段判型由各 `parse` 内的运行时检查
 * 完成，通过后原样返回该记录，因此这里按动态记录声明。
 */
type HostResultRecord = Record<string, any>;

/** 批量归档 / 恢复 / 删除的目标作用域（与客户端请求体一致）。 */
type ArchivedBatchTarget =
	| { scope: "all" }
	| { scope: "ungrouped" }
	| { scope: "workspace"; workspaceId: string }
	| { scope: "sessions"; sessionIds: string[] };

/** 批量删除结果：成功、并发消失与失败分别上报给客户端。 */
interface ArchivedDeleteBatchResult {
	requestedSessionIds: string[];
	deletedSessionIds: string[];
	skippedSessionIds: string[];
	failures: Array<{ sessionId: string; message: string }>;
}

/** 「见过的登记」快照记录（键为 `workspacePathKey` 归一化路径）。 */
interface WorkspaceSnapshotRecord {
	path: string;
	title: string;
	id?: string;
	at: number;
}

/** 宿主工作区登记实体在本文件里的使用面（官方 `Workspace` 接口的最小投影）。 */
interface WorkspaceLike {
	id?: unknown;
	path?: string;
	title?: string;
	sessionIds?: readonly string[];
	attachSession?(sessionId: string): Promise<void>;
}

/** 工作区归属恢复结果。 */
interface WorkspaceAccountingResult {
	registered: Array<{ path: string; title: string; created: boolean }>;
	attached: string[];
	skipped: Array<{ sessionId: string; reason: string }>;
}

/** 宿主注册表状态：workspaceIds 为权威显示顺序，archivedSessionIds 为归档集合。 */
interface WorkspaceRegistryState {
	workspaceIds: readonly string[];
	archivedSessionIds: readonly string[];
}

/** 宿主工作区记账表（`registry.requireTable()`）里本文件读写的字段。 */
interface WorkspaceRecordLike {
	sessionIds: readonly string[];
	updatedAt?: unknown;
	[key: string]: unknown;
}

/** 宿主工作区记账表：按 id 读取与更新。 */
interface WorkspaceTableLike {
	get(id: string): WorkspaceRecordLike | undefined;
	update(id: string, fn: (current: WorkspaceRecordLike) => WorkspaceRecordLike): Promise<WorkspaceRecordLike>;
}

/** 已归档会话的展示元数据行（任何一步失败只降级为缺字段，不阻断列表）。 */
interface ArchivedSessionDetail {
	sessionId: string;
	createdAt?: number;
	cwd?: string;
	title?: string;
	archivedAt?: number;
}

/** 会话原文读取源：完整事件日志 + 存储元数据。 */
interface StoredProjectionSource {
	meta?: SessionHeader;
	inheritedEventCount?: number;
	events: readonly unknown[];
}

/** 持久化后端的「读取完整日志」面：新版走 open() 句柄，旧版走 readFrom()。 */
interface ProjectionReadPersistence {
	readFrom?(sessionId: string, offset: number): Promise<StoredProjectionSource>;
	open(sessionId: string, access: "read"): Promise<{
		header: SessionHeader;
		inheritedEventCount?: number;
		read(offset: number): Promise<{ events: readonly unknown[] }>;
		close(): Promise<void>;
	}>;
}

/** 会话存储的冷分支面：`enter` 返回的 detach 与 `announce` 成对使用。 */
interface ColdSessionSessions {
	enter(session: unknown): () => void;
	announce(session: unknown): void;
}

/** 宿主投影缓存的删除面：delete / whenIdle / clearTombstone 在官方声明里不可见（运行时存在）。 */
interface ProjectionCacheLike {
	delete(id: string): Promise<unknown>;
	whenIdle?(): Promise<void>;
	clearTombstone?(id: string): void;
}

/** 注入的会话持久化服务：本文件只用它的全量列举（旧版直接返回头部，新版返回快照）。 */
interface SessionPersistenceListing {
	list(): Promise<ReadonlyArray<{ header: SessionHeader }>>;
}

/**
 * 本文件用到的宿主上下文面。官方 `Context` 的服务 getter 在声明里多为 private /
 * 随版本增删，本文件一律先按运行时守卫读取再调用，因此这里把动态读取放宽：
 * `get` 返回 any、按字符串名发布宿主事件（`api-session/removed` 不在官方 Events 里）。
 */
interface HostContext extends Context {
	get(name: string, strict?: boolean): any;
	emit(name: string, ...args: unknown[]): void;
	sessionPersistence: SessionPersistenceListing;
}

/** 构造期配置：账本文件位置与启动期一次性迁移的完成信号。 */
interface ArchiveWorkspaceConfig {
	archivedAtFile?: string;
	workspaceSnapshotFile?: string;
	ready?: PromiseLike<unknown>;
}

/**
 * 构造入参：宿主注入的工作区注册表实例。官方 `WorkspaceRegistry` 把四个索引 Map 与
 * requireState / enqueueOperation 等标为 private（运行时存在），因此入参只声明本文件
 * 真正依赖的公开面，其余成员在构造期收窄。
 */
interface HostWorkspaceRegistryInput {
	archivedSessionIds: readonly string[];
	archiveSession?(sessionId: string): Promise<void>;
	resolveByPath?(path: string): Promise<WorkspaceLike | undefined>;
	create?(path: string, title?: string): Promise<WorkspaceLike>;
}

/** 本文件实际使用的注册表面：索引 Map 与归档/索引入口在宿主运行时必定存在。 */
interface HostWorkspaceRegistry extends RegistryLike {
	archiveSession(sessionId: string): Promise<void>;
	indexHeader(header: SessionHeader): Promise<unknown>;
	archivedAt?(sessionId: string): number | undefined;
	archivedSessionDetails?(): Promise<{ items: Array<{ sessionId: string; archivedAt?: number }> }>;
	archiveWorkspaceSessions?(workspaceId: string): Promise<{ archivedSessionIds: string[]; archivedSessionIdsAdded: string[] }>;
	unarchiveSession?(sessionId: string): Promise<{ archivedSessionIds: string[] }>;
	unarchiveSessions?(target: ArchivedBatchTarget): Promise<{ archivedSessionIds: string[]; unarchivedSessionIds: string[] }>;
	deleteArchivedSessions?(target: ArchivedBatchTarget): Promise<ArchivedDeleteBatchResult>;
	deleteSession?(sessionId: string): Promise<{ deleted: true }>;
	resolveByPath?(path: string): Promise<WorkspaceLike | undefined>;
	create?(path: string, title?: string): Promise<WorkspaceLike>;
}

/** sessions/bridge.ts 的适配面；`beginDelete` 的 header 在调用点可省略（缺省即 null）。 */
interface SessionsBridge extends ReturnType<typeof createSessionsBridge> {
	beginDelete(id: string, header?: unknown): Promise<void>;
	/** 只读降级查询：bridge 只按能力 id 判定，operation 仅作标签（调用点传 "read"）。 */
	refusalsFor(operation: string, ids: readonly string[]): CapabilityRefusal[];
}
//#region lib/types/index.js
/**
 * 独立归档门面：消费当前宿主服务，不注册或替换 workspaceRegistry。
 * 外部服务有原生接口时优先委托；官方缺口由受检查的兼容层补齐。
 *
 * 实测边界（2026-09-14，对抗式审查）：现装宿主**没有任何**原生归档扩展接口
 * ——全量 grep `archivedSessionDetails` / `deleteArchivedSessions` / `unarchiveSessions`
 * 均不存在，`@michengai/dsh-archive-manager` 也未安装。因此下面所有
 * `typeof this.registry.X === "function"` 的委托分支在当前环境**都是死代码**，
 * 实际执行路径永远是 sessions/bridge.ts 的私有适配（依赖官方声明为 private 的方法，
 * 并直接改 registry.headers / sessionPaths / invalidSessionPaths）。
 * 所以「不再替换服务、不再与外部插件争注册」成立，但**不能由此推出耦合下降或零侵入**。
 * 另：改为门面后新增的墓碑 indexHeader 守卫只覆盖本门面的调用；宿主自身的
 * WorkspaceRegistry.indexHeaders()（dsh-workspace index.js:706/735/466）不再经过它，
 * 「阻止 stale list 把已删会话编回索引」的保护范围是门面内部而非宿主全量。
 *
 * `deleteSession(sessionId)` 的顺序即语义：校验已知会话；实时会话先
 * flush 再 detach；等待投影缓存写入完成；移除归档标记和工作区记账；
 * 删除投影缓存，级联删除 SUBAGENT 子会话并清理 spill；最后才删除转录
 * 目录。fork 分支虽有 `parentSession`，但属于独立用户会话，不参与级联。
 *
 * 转录工件删除成功后才提交父会话记账清理；任一步失败均保留归档标记、工作区
 * 记账和头部索引，以便再次调用同一入口完成删除。SUBAGENT 级联跨多个转录
 * 工件，无法组成事务：子会话可能已先删除，重试会跳过它们并继续处理仍保留的
 * 父会话。
 * 物理删除成功后清理宿主索引（headers / sessionPaths / invalidSessionPaths），
 * 本门面的墓碑阻止重试时误认旧生命周期，并允许不同创建时间的同 id 新会话。
 * 方法只通过插件自己的 History HTTP ops 暴露，不注册同名宿主 RPC。
 * 兼容层不拦截官方的 indexHeader，因此不承诺修正外部后端返回陈旧列表的行为。
 */
/**
 * Compatibility adapter for the official JSONL backend's session-owned layout.
 * A generic locate() path does NOT grant ownership of its parent directory.
 * Unknown backends/layouts keep artifact-only deletion. Do not prune ancestors.
 */
function jsonlSessionDirectory(
	persistence: TranscriptPersistenceLike,
	header: HeaderLike,
	location: TranscriptLocationLike,
): string | undefined {
	if (
		persistence.name !== "session-persistence-jsonl" ||
		location.kind !== "jsonl"
	)
		return;
	// Official JSONL stores its resolved root at construction. Re-resolving a
	// relative config.root after process.chdir() would point to a different store.
	// This backend-specific field is optional; only absolute config is a safe fallback.
	const root = persistence.root ?? persistence.config?.root;
	if (
		typeof root !== "string" ||
		!isAbsolute(root) ||
		!isAbsolute(location.path)
	)
		return;
	// 新版使用不可变代际文件；删除整个已验证的会话目录，避免旧代际被重新发现。
	if (
		!/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(
			basename(location.path),
		)
	)
		return;
	if (typeof header.id !== "string" || header.id.length === 0) return;
	// Upstream encodes UTF-16 code units as ~XXXX (including lone surrogates).
	const encode = (text: string): string =>
		text.replace(
			/[^A-Za-z0-9._-]/g,
			(ch: string) => `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
		);
	const segment =
		header.id === "."
			? "~002E"
			: header.id === ".."
				? "~002E~002E"
				: encode(header.id);
	let project = "_no-cwd";
	if (header.cwd !== void 0) {
		if (typeof header.cwd !== "string" || header.cwd.length === 0) return;
		const readable =
			encode(header.cwd.replace(/[\\/:]+/g, "-")).replace(/^-+/, "") || "root";
		project = `--${readable.slice(0, 251)}--`;
	}
	const directory = join(resolve(root), project, segment);
	if (location.path !== join(directory, basename(location.path))) return;
	return directory;
}

function unknownSessionMessage(sessionId: string): string {
	return `unknown session "${sessionId}" (UNKNOWN_SESSION)`;
}
var ArchiveUnknownSessionError = class extends Error {
	sessionId: string;
	constructor(sessionId: string) {
		super(unknownSessionMessage(sessionId));
		this.sessionId = sessionId;
		this.name = "ArchiveUnknownSessionError";
	}
};
/** 头部投影到“日志身份”字段（与投影缓存的 identity 语义一致）。cwd 缺失统一归一为 null，避免一侧带键一侧不带键时的比较歧义。 */
function headerIdentity(header: HeaderLike): { createdAt: unknown; cwd: unknown } {
	return {
		createdAt: header.createdAt,
		cwd: header.cwd ?? null,
	};
}
const sessionIdSchema = {
	parse(value: unknown): string {
		if (typeof value !== "string" || value.length === 0)
			throw new TypeError(
				`sessionId must be a non-empty string, got ${String(value)}`,
			);
		return value;
	},
};
const workspaceIdSchema = {
	parse(value: unknown): string {
		if (typeof value !== "string" || value.length === 0)
			throw new TypeError(
				`workspaceId must be a non-empty string, got ${String(value)}`,
			);
		return value;
	},
};
const archivedSetSchema = {
	parse(value: HostResultRecord): HostResultRecord {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("result must be an object");
		const ids = value.archivedSessionIds;
		if (!Array.isArray(ids) || ids.some((id: unknown) => typeof id !== "string"))
			throw new TypeError("archivedSessionIds must be a string array");
		return value;
	},
};
const deletedSchema = {
	parse(value: HostResultRecord): HostResultRecord {
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			value.deleted !== true
		)
			throw new TypeError("deleted must be true");
		return value;
	},
};
const archivedBatchTargetSchema = {
	// 校验通过后原样返回记录，调用方按 scope 判别式收窄（宿主返回值校验器，故返回 any）。
	parse(value: HostResultRecord): any {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("target must be an object");
		if (value.scope === "all" || value.scope === "ungrouped") return value;
		if (
			value.scope === "workspace" &&
			typeof value.workspaceId === "string" &&
			value.workspaceId.length > 0
		)
			return value;
		if (
			value.scope === "sessions" &&
			Array.isArray(value.sessionIds) &&
			value.sessionIds.length > 0 &&
			value.sessionIds.every((id: unknown) => typeof id === "string" && id.length > 0)
		)
			return value;
		throw new TypeError(
			"target.scope must be all, ungrouped, workspace with a non-empty workspaceId, or sessions with non-empty sessionIds",
		);
	},
};
const unarchivedBatchSchema = {
	parse(value: HostResultRecord): HostResultRecord {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("result must be an object");
		if (
			!Array.isArray(value.archivedSessionIds) ||
			value.archivedSessionIds.some((id: unknown) => typeof id !== "string")
		)
			throw new TypeError("archivedSessionIds must be a string array");
		if (
			!Array.isArray(value.unarchivedSessionIds) ||
			value.unarchivedSessionIds.some((id: unknown) => typeof id !== "string")
		)
			throw new TypeError("unarchivedSessionIds must be a string array");
		return value;
	},
};
const archivedWorkspaceBatchSchema = {
	parse(value: HostResultRecord): HostResultRecord {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("result must be an object");
		if (
			!Array.isArray(value.archivedSessionIds) ||
			value.archivedSessionIds.some((id: unknown) => typeof id !== "string")
		)
			throw new TypeError("archivedSessionIds must be a string array");
		if (
			!Array.isArray(value.archivedSessionIdsAdded) ||
			value.archivedSessionIdsAdded.some((id: unknown) => typeof id !== "string")
		)
			throw new TypeError("archivedSessionIdsAdded must be a string array");
		return value;
	},
};
const deletedBatchSchema = {
	parse(value: HostResultRecord): HostResultRecord {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("result must be an object");
		for (const key of [
			"requestedSessionIds",
			"deletedSessionIds",
			"skippedSessionIds",
		]) {
			if (
				!Array.isArray(value[key]) ||
				value[key].some((id: unknown) => typeof id !== "string")
			)
				throw new TypeError(`${key} must be a string array`);
		}
		if (
			!Array.isArray(value.failures) ||
			value.failures.some(
				(failure: HostResultRecord) =>
					typeof failure !== "object" ||
					failure === null ||
					typeof failure.sessionId !== "string" ||
					typeof failure.message !== "string",
			)
		)
			throw new TypeError("failures must contain sessionId/message objects");
		return value;
	},
};
const archivedSessionMetadataSchema = {
	parse(value: HostResultRecord): HostResultRecord {
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			!Array.isArray(value.items)
		)
			throw new TypeError("result.items must be an array");
		if (
			value.items.some(
				(item: HostResultRecord) =>
					typeof item !== "object" ||
					item === null ||
					typeof item.sessionId !== "string" ||
					typeof item.createdAt !== "number" ||
					!Number.isFinite(item.createdAt),
			)
		)
			throw new TypeError("items must contain sessionId/createdAt objects");
		if (
			value.repairedSessionIds !== void 0 &&
			(!Array.isArray(value.repairedSessionIds) ||
				value.repairedSessionIds.some((id: unknown) => typeof id !== "string"))
		)
			throw new TypeError("repairedSessionIds must be a string array");
		return value;
	},
};
/**
 * 折叠进 dsh-plugin-tool-management 的归档工作区注册表。
 * 原始实现来自 @michengai/dsh-archive-manager（Apache-2.0），剥离了
 * Typert Remote 暴露层——本插件客户端经 HTTP API 调用，不依赖 typert 远程。
 * 账本默认位置已从「插件目录 data/」改为 hub 根 `$DSH_HOME/tool-management/`：
 * npm 安装下插件目录会被 `dsh plugin update` 整体替换，账本放那里等于升级即丢。
 */
function defaultArchivedAtFile() {
	return hubPath("history-archived-at.json");
}
function defaultWorkspaceSnapshotFile() {
	return hubPath("history-workspaces.json");
}
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
function workspacePathKey(path: unknown): string {
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
function workspaceBaseName(path: unknown): string {
	const raw = String(path ?? "").trim();
	if (!raw) return "";
	const trimmed = raw.replace(/[\\/]+$/, "");
	const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
	const segment = index >= 0 ? trimmed.slice(index + 1) : trimmed;
	if (segment) return segment;
	const root = trimmed.match(/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/);
	return root ? root[0] : trimmed || raw;
}
// Standalone facade over the existing registry. Never instantiate/register a
// second WorkspaceRegistry, and never open another copy of its storage domain.
var ArchiveWorkspaceRegistry = class {
	/** 宿主注入的上下文（服务读取按动态面处理，见 `HostContext`）。 */
	ctx: HostContext;
	/** 宿主注册表实例；构造期由入参收窄，随后被 bridge 收窄后的实例覆盖。 */
	registry: HostWorkspaceRegistry;
	/** sessions/bridge.ts 的适配句柄（能力门禁 + 私有接口包装）。 */
	bridge: SessionsBridge;
	/** 账本写入串行链（保证读-改-写不互相覆盖）。 */
	ledgerTail: Promise<void>;
	/** 删除中的会话 id 集合（防 SUBAGENT 级联自环），首次用到才建。 */
	deleting?: Set<string>;
	/** 本进程内已物理删除的会话；阻止父类把 stale list() 重新编入索引。 */
	deletedSessionIds = /* @__PURE__ */ new Set<string>();
	/** 墓碑插入顺序，用于在上限处淘汰最旧项。 */
	deletedSessionOrder: string[] = [];
	/** 墓碑上限：足够挡住 stale list()，又避免长驻进程无限增长。 */
	deletedSessionTombstoneLimit = 4096;
	/** 被删生命周期的日志身份（createdAt/cwd）：冷复用探针区分“同 id 新会话”与 stale list() 的依据。 */
	deletedIdentities = /* @__PURE__ */ new Map();
	/** 会话 → 归档时刻（epoch ms）；保留期自动删除的基线。 */
	archivedAtMap: Map<string, number> = /* @__PURE__ */ new Map();
	archivedAtFile!: string;
	archivedAtLoaded = false;
	/**
	 * 「见过的登记」快照：归一化路径 → { path, title, id, at }。
	 * 宿主删除工作区是硬删、不留墓碑（dsh-workspace `deleteKnown`），登记一没，
	 * 归档会话的归属就只剩会话自己的 cwd。本表把**活着时见过**的登记标题留下来，
	 * 使按目录重建的分组仍能显示用户命名，并能区分「曾经登记过、现在被移除」
	 * 与「从未登记过的目录」。只读辅助信息，不参与任何归属判定或写入。
	 */
	workspaceSnapshotMap: Map<string, WorkspaceSnapshotRecord> = /* @__PURE__ */ new Map();
	workspaceSnapshotFile!: string;
	workspaceSnapshotLoaded = false;
	/** 快照上限：足够覆盖常见工作区数，又避免长驻进程无限增长。 */
	workspaceSnapshotLimit = 200;
	/**
	 * 启动期一次性迁移（插件目录 → hub）的完成信号。两个账本都是**首次用到才读盘**，
	 * 但"首次用到"可能与迁移并发，因此读盘前先等它落定；未提供时立即就绪。
	 */
	ready = Promise.resolve();
	constructor(ctx: Context, registry: HostWorkspaceRegistryInput, config: ArchiveWorkspaceConfig = {}) {
		// 注入的 `sessionPersistence` 不在官方 `Context` 声明里（index.ts 的 inject 列表里有它），
		// 因此这里按本文件的使用面收窄（其余成员仍走官方 `Context`）。
		this.ctx = ctx as HostContext;
		// 入参按「官方声明可见的公开面」声明（四个索引 Map 在官方 `WorkspaceRegistry` 里是 private，
		// 运行时存在且由 bridge 的形状检查兜底），因此此处收窄为本文件实际使用的注册表面。
		this.registry = registry as HostWorkspaceRegistry;
		this.archivedAtFile = config.archivedAtFile || defaultArchivedAtFile();
		this.workspaceSnapshotFile = config.workspaceSnapshotFile || defaultWorkspaceSnapshotFile();
		if (config.ready && typeof config.ready.then === "function") {
			this.ready = Promise.resolve(config.ready).then(() => undefined, () => undefined);
		}
		this.ledgerTail = Promise.resolve();
		this.bridge = createSessionsBridge(ctx, registry as RegistryLike, (id, at) => this.recordArchive(id, at));
		// bridge 收窄后的注册表同样只声明运行时形状，这里还原为本文件的注册表面。
		this.registry = this.bridge.registry as HostWorkspaceRegistry;
		this.bridge.observe();
	}
	async dispose() { await this.bridge.dispose(); await this.ledgerTail; }
	get headers() { return this.registry.headers; }
	get sessionPaths() { return this.registry.sessionPaths; }
	get invalidSessionPaths() { return this.registry.invalidSessionPaths; }
	get entities() { return this.registry.entities; }
	get archivedSessionIds() { return this.registry.archivedSessionIds; }
	requireState(): WorkspaceRegistryState { return this.bridge.state() as WorkspaceRegistryState; }
	requireTable(): WorkspaceTableLike { return this.bridge.table() as WorkspaceTableLike; }
	setState(state: unknown) { return this.bridge.setState(state); }
	enqueueOperation<T>(fn: () => Promise<T>): Promise<T> { return this.bridge.enqueue(fn); }
	readSessionHeader(id: string): Promise<SessionHeader> { return this.bridge.readHeader(id) as Promise<SessionHeader>; }
	getProjectionCache(): ProjectionCacheLike | undefined { return this.bridge.cache() as unknown as ProjectionCacheLike | undefined; }
	/** 宿主能力评估快照（供 HTTP compat-status op 与设置页使用）。 */
	capabilities(force = false) { return this.bridge.capabilities(force); }
	/** 指定能力 id 中不可用的那些；不抛错，供只读路径降级。 */
	capabilityRefusals(ids: readonly string[]) { return this.bridge.refusalsFor("read", ids); }
	recordArchive(id: string, at: number | null) {
		const task = this.ledgerTail.then(async () => {
			await this.ensureArchivedAtLoaded();
			if (at === null) this.archivedAtMap.delete(id);
			else this.archivedAtMap.set(id, at);
			await this.saveArchivedAt();
		});
		this.ledgerTail = task.catch(() => {});
		return task;
	}
	reconcileArchiveLedger() {
		const task = this.ledgerTail.then(() => this.reconcileArchiveLedgerCore());
		this.ledgerTail = task.catch(() => {});
		return task;
	}
	async reconcileArchiveLedgerCore() {
		await this.ensureArchivedAtLoaded();
		const ids = new Set(this.registry.archivedSessionIds);
		let changed = false;
		for (const id of this.archivedAtMap.keys()) {
			if (!ids.has(id)) { this.archivedAtMap.delete(id); changed = true; }
		}
		for (const id of ids) {
			// Existing entries without a timestamp must get a full retention window,
			// never be expired using their potentially much older creation time.
			if (!this.archivedAtMap.has(id)) {
				this.archivedAtMap.set(id, this.registry.archivedAt?.(id) ?? Date.now());
				changed = true;
			}
		}
		if (changed) await this.saveArchivedAt();
	}
	async ensureArchivedAtLoaded() {
		await this.ready;
		if (this.archivedAtLoaded) return;
		this.archivedAtLoaded = true;
		try {
			const raw = await readFile(this.archivedAtFile, "utf8");
			// 账本文件由本文件写出（id → epoch ms）；非有限值在下面逐个跳过。
			const obj: Record<string, number> = JSON.parse(raw);
			if (obj && typeof obj === "object") {
				for (const [k, v] of Object.entries(obj)) {
					if (typeof k === "string" && Number.isFinite(v)) this.archivedAtMap.set(k, v);
				}
			}
		} catch (e) {
			/* 缺失文件视为空表 */
		}
	}
	async saveArchivedAt() {
		try {
			const obj: Record<string, number> = {};
			for (const [k, v] of this.archivedAtMap) obj[k] = v;
			await mkdir(dirname(this.archivedAtFile), { recursive: true });
			await writeFile(this.archivedAtFile, JSON.stringify(obj), "utf8");
		} catch (e) {
			this.ctx.logger?.warn?.(`history: could not persist archived-at ledger: ${String(e)}`);
		}
	}
	archivedAt(sessionId: string): number | undefined {
		return this.archivedAtMap.get(sessionId);
	}
	/**
	 * 读取「见过的登记」快照（首次调用读盘）。键为 `workspacePathKey` 归一化路径。
	 * @returns {Promise<Map<string, { path: string, title: string, id?: string, at: number }>>} 快照副本。
	 */
	async workspaceSnapshot(): Promise<Map<string, WorkspaceSnapshotRecord>> {
		await this.ensureWorkspaceSnapshotLoaded();
		const out = /* @__PURE__ */ new Map<string, WorkspaceSnapshotRecord>();
		for (const [key, record] of this.workspaceSnapshotMap) out.set(key, { ...record });
		return out;
	}
	async ensureWorkspaceSnapshotLoaded() {
		await this.ready;
		if (this.workspaceSnapshotLoaded) return;
		this.workspaceSnapshotLoaded = true;
		try {
			const raw = await readFile(this.workspaceSnapshotFile, "utf8");
			const parsed = JSON.parse(raw);
			const items: Record<string, Record<string, unknown>> = parsed && typeof parsed === "object" && parsed.items && typeof parsed.items === "object" ? parsed.items : parsed;
			if (items && typeof items === "object") {
				for (const [key, value] of Object.entries(items)) {
					if (!value || typeof value !== "object") continue;
					const path = typeof value.path === "string" ? value.path : "";
					const title = typeof value.title === "string" ? value.title : "";
					if (!path || !title) continue;
					this.workspaceSnapshotMap.set(key, {
						path,
						title,
						...(typeof value.id === "string" ? { id: value.id } : {}),
						at: Number.isFinite(value.at) ? Number(value.at) : 0,
					});
				}
			}
		} catch (e) {
			/* 缺失文件视为空表 */
		}
	}
	async saveWorkspaceSnapshot() {
		try {
			const items: Record<string, WorkspaceSnapshotRecord> = {};
			for (const [key, value] of this.workspaceSnapshotMap) items[key] = value;
			await mkdir(dirname(this.workspaceSnapshotFile), { recursive: true });
			await writeFile(this.workspaceSnapshotFile, JSON.stringify({ v: 1, items }), "utf8");
		} catch (error) {
			this.ctx.logger?.warn?.(`history: could not persist workspace snapshot: ${String(error)}`);
		}
	}
	/**
	 * 记下当前活着的登记（路径 / 标题）。内容未变化时不写盘；超出上限按 `at` FIFO 淘汰。
	 * 由 history-list 每次读取时顺手调用，因此覆盖的是「插件见过它活着」的登记。
	 * @param {Array<{ id?: string, path?: string, title?: string }>} records - 当前活登记快照。
	 */
	async rememberWorkspaces(records: Array<{ id?: string; path?: string; title?: string }>) {
		const list = Array.isArray(records) ? records : [];
		if (!list.length) return;
		const task = this.ledgerTail.then(async () => {
			await this.ensureWorkspaceSnapshotLoaded();
			const at = Date.now();
			let changed = false;
			for (const record of list) {
				const path = record && typeof record.path === "string" ? record.path : "";
				if (!path) continue;
				const key = workspacePathKey(path);
				if (!key) continue;
				const title = record && typeof record.title === "string" && record.title ? record.title : workspaceBaseName(path) || path;
				const id = record && typeof record.id === "string" ? record.id : undefined;
				const previous = this.workspaceSnapshotMap.get(key);
				if (previous && previous.path === path && previous.title === title && previous.id === id) continue;
				this.workspaceSnapshotMap.set(key, { path, title, ...(id === undefined ? {} : { id }), at });
				changed = true;
			}
			if (!changed) return;
			if (this.workspaceSnapshotMap.size > this.workspaceSnapshotLimit) {
				const ordered = [...this.workspaceSnapshotMap.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
				for (const [key] of ordered.slice(0, this.workspaceSnapshotMap.size - this.workspaceSnapshotLimit)) this.workspaceSnapshotMap.delete(key);
			}
			await this.saveWorkspaceSnapshot();
		});
		this.ledgerTail = task.catch(() => {});
		return task;
	}
	/**
	 * 恢复归档时把**工作区归属一起恢复**。宿主归档只把会话放进全局归档集合，
	 * 登记的 `sessionIds` 记账位保持不动 —— 所以登记还在时恢复即自动归位。但登记被删除后
	 * 再重建的那条记录 `sessionIds` 是空的，恢复出来的会话在宿主侧就落进「未分组」。
	 * 这里按会话 header 的 `cwd` 找到（必要时重建）对应登记，并把会话挂回其记账位：
	 * 全部走宿主自己的方法（`resolveByPath` / `create` / 实体的 `attachSession`）；
	 * 目录已不存在时不凭空登记，只如实上报跳过原因。
	 * @param {string[]} sessionIds - 要恢复归属的会话。
	 * @returns {Promise<{ registered: Array<{ path: string, title: string, created: boolean }>, attached: string[], skipped: Array<{ sessionId: string, reason: string }> }>} 归属恢复结果。
	 */
	async ensureWorkspaceAccounting(sessionIds: readonly string[]): Promise<WorkspaceAccountingResult> {
		const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).map((id) => String(id ?? "").trim()).filter(Boolean))];
		const result: WorkspaceAccountingResult = { registered: [], attached: [], skipped: [] };
		if (!ids.length) return result;
		const host = this.registry;
		if (typeof host.resolveByPath !== "function" || typeof host.create !== "function") {
			throw new Error("宿主未提供工作区登记入口（workspaceRegistry.resolveByPath / create），本次未做任何修改");
		}
		/** 同一目录只解析/登记一次；值为 { entity, record } 或 { failure }。 */
		const byPath = /* @__PURE__ */ new Map();
		for (const sessionId of ids) {
			let cwd;
			try {
				const header = await this.readSessionHeader(sessionId);
				cwd = header && typeof header.cwd === "string" && header.cwd ? header.cwd : undefined;
			} catch (error: any) {
				// 宿主/文件系统抛出的错误按动态形状读 message（strict 下 catch 变量为 unknown）。
				result.skipped.push({ sessionId, reason: `读不到会话头部：${String(error?.message ?? error)}` });
				continue;
			}
			if (cwd === undefined) {
				result.skipped.push({ sessionId, reason: "会话头部没有工作目录（cwd），无法恢复工作区归属" });
				continue;
			}
			const key = workspacePathKey(cwd);
			let entry = byPath.get(key);
			if (entry === undefined) {
				entry = {};
				byPath.set(key, entry);
				try {
					let entity = await host.resolveByPath(cwd);
					const created = entity === undefined;
					if (created) entity = await host.create(cwd);
					entry.entity = entity;
					const record = {
						path: String(entity?.path ?? cwd),
						title: String(entity?.title ?? "") || workspaceBaseName(cwd) || cwd,
						created,
					};
					entry.record = record;
					result.registered.push(record);
				} catch (error: any) {
					// 宿主 realpath 拒绝的原始错误按动态形状读 message。
					entry.failure = `无法解析工作区目录「${cwd}」：${String(error?.message ?? error)}`;
				}
			}
			if (entry.failure !== undefined) {
				result.skipped.push({ sessionId, reason: entry.failure });
				continue;
			}
			if (typeof entry.entity?.attachSession !== "function") {
				result.skipped.push({ sessionId, reason: "宿主登记对象没有 attachSession，无法把会话挂回该工作区" });
				continue;
			}
			try {
				const already = Array.isArray(entry.entity.sessionIds) && entry.entity.sessionIds.includes(sessionId);
				await entry.entity.attachSession(sessionId);
				// 只在**真的挂上**时上报：正常恢复（登记里本来就有这个会话）不该弹提示。
				if (!already) result.attached.push(sessionId);
			} catch (error: any) {
				// 宿主 attachSession 拒绝原因按动态形状读 message。
				result.skipped.push({ sessionId, reason: String(error?.message ?? error) });
			}
		}
		// 这次新建的登记记进快照：组标题与「已移除 / 未登记」判定都靠它。
		const fresh = result.registered.filter((record) => record.created).map((record) => ({ path: record.path, title: record.title }));
		if (fresh.length) await this.rememberWorkspaces(fresh);
		return result;
	}
	/**
	 * 为一个**已存在**的目录重新创建宿主工作区登记（用户显式点击才走这里），
	 * 并把**该目录下已知的会话挂回**这条登记 —— 登记被删除时它的 `sessionIds`
	 * 记账一起没了，不挂回的话这些会话在宿主侧仍然显示为「未分组」
	 * （已恢复的会话不会再有第二次「恢复」动作，只能靠这里补）。
	 * 只调用宿主自身的 resolveByPath / create / attachSession：同路径已有登记时
	 * 原样复用、不重复创建；目录不存在时宿主 realpath 直接拒绝，因此不会凭空登记
	 * 一个不存在的路径。不移动、不删除任何文件与会话。
	 * @param {string} path - 要登记的目录路径。
	 * @param {string} [title] - 可选展示标题；缺省由宿主取目录名。
	 * @returns {Promise<{ id: string, title: string, path: string, created: boolean, attached: string[], attachSkipped: Array<{ sessionId: string, reason: string }> }>} 登记与挂回结果。
	 */
	async registerWorkspace(path: string, title?: string) {
		const target = String(path ?? "").trim();
		if (!target) throw new Error("workspace path is required");
		const host = this.registry;
		if (typeof host.resolveByPath !== "function" || typeof host.create !== "function") {
			throw new Error("宿主未提供工作区登记入口（workspaceRegistry.resolveByPath / create），本次未做任何修改");
		}
		// 这一条走宿主自己的方法（ctx.workspaceRegistry 就是宿主服务本体），
		// 因此不需要 bridge 的归档适配能力门禁；真正的守卫是宿主 create 自己的
		// realpath + isDirectory 校验，以及下面的 resolveByPath 幂等判断。
		let entity = await host.resolveByPath(target);
		const created = entity === undefined;
		if (created) entity = await host.create(target, typeof title === "string" && title.trim() ? title.trim() : undefined);
		// 解析不到即走上面的 create 分支，此后 entity 必定已定义（类型层无法表达该不变式）。
		const record = {
			id: String(entity!.id),
			path: String(entity!.path ?? target),
			title: String(entity!.title ?? "") || workspaceBaseName(target) || target,
		};
		await this.rememberWorkspaces([record]);
		const { attached, attachSkipped } = await this.attachKnownSessions(entity!, record.path);
		return { ...record, created, attached, attachSkipped };
	}
	/**
	 * 把宿主索引里**属于该目录**的已知会话挂回这条登记（幂等；已在册的不重复上报）。
	 * 只信 `registry.sessionPaths`（宿主按真实目录建的规范路径索引），不猜路径。
	 * @param {{ sessionIds?: string[], attachSession?: (id: string) => Promise<void> }} entity - 宿主登记对象。
	 * @param {string} path - 该登记的规范路径。
	 * @returns {Promise<{ attached: string[], attachSkipped: Array<{ sessionId: string, reason: string }> }>} 挂回结果。
	 */
	async attachKnownSessions(entity: WorkspaceLike, path: string) {
		const attached: string[] = [];
		const attachSkipped: Array<{ sessionId: string; reason: string }> = [];
		const sessionPaths = this.registry?.sessionPaths;
		if (!(sessionPaths instanceof Map) || typeof entity?.attachSession !== "function") return { attached, attachSkipped };
		const key = workspacePathKey(path);
		const candidates = [];
		for (const [sessionId, sessionPath] of sessionPaths) {
			if (typeof sessionPath !== "string" || workspacePathKey(sessionPath) !== key) continue;
			if (Array.isArray(entity.sessionIds) && entity.sessionIds.includes(sessionId)) continue;
			candidates.push(String(sessionId));
		}
		for (const sessionId of candidates) {
			try {
				await entity.attachSession(sessionId);
				attached.push(sessionId);
			} catch (error: any) {
				// 宿主 attachSession 拒绝原因按动态形状读 message。
				attachSkipped.push({ sessionId, reason: String(error?.message ?? error) });
			}
		}
		return { attached, attachSkipped };
	}
	/**
	 * 归档委托宿主。官方 UI 不经过本方法，而由 domain/changed 事件
	 * 同步归档时刻；重复归档不重置保留期。
	 */
	async archiveSession(sessionId: string) {
		// 委托宿主原生入口；宿主没有原生入口时走本门面的适配路径（能力探测决定）。
		this.bridge.checkWorkspace("archive");
		await this.registry.archiveSession(sessionId);
		await this.reconcileArchiveLedger();
	}
	/**
	 * 列出已归档会话的展示元数据：sessionId / createdAt / cwd / title / archivedAt。
	 * title 经投影缓存 best-effort 读取（未播种会话用 inheritedEventCount=0）；
	 * 任何一步失败只降级为缺字段，不阻断列表。
	 */
	async archivedSessionDetails(): Promise<{ items: ArchivedSessionDetail[] }> {
		await this.reconcileArchiveLedger();
		if (typeof this.registry.archivedSessionDetails === "function") {
			const result = await this.registry.archivedSessionDetails();
			return { ...result, items: result.items.map((item) => ({ ...item, archivedAt: item.archivedAt ?? this.archivedAtMap.get(item.sessionId) })) };
		}
		const items: ArchivedSessionDetail[] = [];
		for (const sessionId of [...new Set(this.requireState().archivedSessionIds)]) {
			const entry: ArchivedSessionDetail = { sessionId, archivedAt: this.archivedAtMap.get(sessionId) };
			try {
				const header = await this.readSessionHeader(sessionId);
				if (typeof header?.createdAt === "number" && Number.isFinite(header.createdAt))
					entry.createdAt = header.createdAt;
				if (typeof header?.cwd === "string" && header.cwd) entry.cwd = header.cwd;
				const cache = this.ctx.get("sessionProjectionCache");
				if (cache !== undefined && typeof cache.cachedSnapshot === "function") {
					const snap = cache.cachedSnapshot(header, 0, ["title"]);
					const title = snap?.values?.title;
					if (typeof title === "string") entry.title = title;
				}
			} catch (error) {
				this.ctx.logger?.warn?.(
					`history: could not read details for archived session "${sessionId}": ${String(error)}`,
				);
			}
			items.push(entry);
		}
		return { items };
	}
	/**
	 * 归档设置页创建时间排序所需的最小元数据。老用户可能仍有会话原文和
	 * 归档标记、却没有投影缓存；这里按需从完整日志重建一次，再通知客户端
	 * 刷新会话列表。已有缓存不读原文，新老 DSH 的缓存布局都走同一 put。
	 */
	async archivedSessionMetadata(): Promise<{ items: Array<{ sessionId: string; createdAt: number }>; repairedSessionIds?: string[] }> {
		const items: Array<{ sessionId: string; createdAt: number }> = [];
		const repairedSessionIds: string[] = [];
		for (const sessionId of [
			...new Set(this.requireState().archivedSessionIds),
		]) {
			try {
				const header = await this.readSessionHeader(sessionId);
				if (await this.repairArchivedProjection(header))
					repairedSessionIds.push(sessionId);
				if (
					typeof header.createdAt === "number" &&
					Number.isFinite(header.createdAt)
				)
					items.push({ sessionId, createdAt: header.createdAt });
			} catch (error) {
				this.ctx.logger.warn(
					`archive-manager: could not read creation time for archived session "${sessionId}": ${String(error)}`,
				);
			}
		}
		return {
			items,
			...(repairedSessionIds.length === 0 ? {} : { repairedSessionIds }),
		};
	}
	/** 从会话原文补齐缺失的派生缓存；任何失败都只降级为原有无摘要列表。 */
	async repairArchivedProjection(header: SessionHeader) {
		const cache = this.ctx.get("sessionProjectionCache");
		const persistence = this.ctx.get("sessionPersistence");
		const projections = this.ctx.get("sessionProjections");
		if (
			cache === void 0 ||
			typeof cache.cachedSnapshot !== "function" ||
			typeof cache.put !== "function"
		)
			return false;
		if (
			persistence === void 0 ||
			(typeof persistence.readFrom !== "function" &&
				typeof persistence.open !== "function") ||
			projections === void 0 ||
			typeof projections.restore !== "function"
		)
			return false;
		try {
			// 未播种会话的继承事件数恒为零，先查缓存可避免读取完整会话原文。
			if (!header.isSeeded && cache.cachedSnapshot(header, 0) !== void 0)
				return false;
			const stored = await this.readStoredProjectionSource(persistence, header.id);
			const meta = stored.meta ?? header;
			if (meta.isSeeded === true && stored.inheritedEventCount === void 0) {
				this.ctx.logger.warn(
					`archive-manager: projection repair for seeded archived session "${header.id}" skipped because its inherited event count is unavailable`,
				);
				return false;
			}
			const inheritedEventCount = stored.inheritedEventCount ?? 0;
			if (meta.isSeeded !== true && inheritedEventCount !== 0) {
				this.ctx.logger.warn(
					`archive-manager: projection repair for unseeded archived session "${header.id}" skipped because its inherited event count is not zero`,
				);
				return false;
			}
			if (cache.cachedSnapshot(meta, inheritedEventCount) !== void 0) return false;
			const restored = projections.restore(
				{},
				stored.events,
				0,
				meta,
				inheritedEventCount,
			);
			if (
				restored === void 0 ||
				typeof restored !== "object" ||
				restored.checkpoint === void 0
			)
				return false;
			await cache.put(
				header.id,
				{
					// 支持的宿主头部均有 version；新版缓存校验格式代际，旧版逐字段比较忽略此键。
					formatVersion: meta.version,
					createdAt: meta.createdAt,
					...(meta.cwd === void 0 ? {} : { cwd: meta.cwd }),
					isSeeded: meta.isSeeded ?? false,
					inheritedEventCount,
				},
				restored.checkpoint,
			);
			return true;
		} catch (error) {
			this.ctx.logger.warn(
				`archive-manager: projection repair for archived session "${header.id}" failed: ${String(error)}`,
			);
			return false;
		}
	}
	/** 新版读句柄必须关闭；旧版仍沿用 readFrom，避免激活 Agent 或写入会话日志。 */
	async readStoredProjectionSource(persistence: ProjectionReadPersistence, sessionId: string): Promise<StoredProjectionSource> {
		if (typeof persistence.readFrom === "function")
			return persistence.readFrom(sessionId, 0);
		const handle = await persistence.open(sessionId, "read");
		try {
			const { events } = await handle.read(0);
			return {
				meta: handle.header,
				inheritedEventCount: handle.inheritedEventCount,
				events,
			};
		} finally {
			await handle.close();
		}
	}
	/**
	 * 把一个会话移出注册表全局归档集合，恢复其正常可见性（其记账位从未
	 * 移动，会话在原工作区位置重新出现）。幂等：未归档的已知会话直接返回
	 * 当前集合不写入；未知会话与 `archiveSession` 一样抛错。
	 * @param sessionId - 要取消归档的会话。
	 * @returns 更新后的完整归档集合。
	 */
	async unarchiveSession(sessionId: string) {
		this.bridge.checkWorkspace("unarchive");
		if (typeof this.registry.unarchiveSession === "function") {
			const result = await this.registry.unarchiveSession(sessionId);
			await this.reconcileArchiveLedger();
			return result;
		}
		return this.enqueueOperation(async () => {
			if (!(await this.sessionKnown(sessionId)))
				throw new ArchiveUnknownSessionError(sessionId);
			const state = this.requireState();
			if (!state.archivedSessionIds.includes(sessionId))
				return { archivedSessionIds: [...state.archivedSessionIds] };
			const next = {
				...state,
				archivedSessionIds: state.archivedSessionIds.filter(
					(id) => id !== sessionId,
				),
			};
			await this.setState(next);
			await this.ensureArchivedAtLoaded();
			if (this.archivedAtMap.delete(sessionId)) await this.saveArchivedAt();
			return { archivedSessionIds: [...next.archivedSessionIds] };
		});
	}
	/**
	 * 将一个工作区内所有会话加入归档集合。先确认所有待归档会话仍存在，
	 * 再执行单次状态写入，因此未知会话不会导致项目只归档一部分。
	 */
	async archiveWorkspaceSessions(workspaceId: string) {
		this.bridge.checkWorkspace("batch");
		if (typeof this.registry.archiveWorkspaceSessions === "function") {
			const result = await this.registry.archiveWorkspaceSessions(workspaceId);
			await this.reconcileArchiveLedger();
			return result;
		}
		return this.enqueueOperation(async () => {
			workspaceId = workspaceIdSchema.parse(workspaceId);
			const workspace = this.requireTable().get(workspaceId);
			if (workspace === void 0)
				throw new Error(`unknown workspace "${workspaceId}"`);
			const state = this.requireState();
			const archived = new Set(state.archivedSessionIds);
			const archivedSessionIdsAdded = [...new Set(workspace.sessionIds)].filter(
				(sessionId) => !archived.has(sessionId),
			);
			for (const sessionId of archivedSessionIdsAdded) {
				if (!(await this.sessionKnown(sessionId)))
					throw new ArchiveUnknownSessionError(sessionId);
			}
			if (archivedSessionIdsAdded.length === 0)
				return {
					archivedSessionIds: [...state.archivedSessionIds],
					archivedSessionIdsAdded,
				};
			const next = {
				...state,
				archivedSessionIds: [
					...state.archivedSessionIds,
					...archivedSessionIdsAdded,
				],
			};
			await this.setState(next);
			return {
				archivedSessionIds: [...next.archivedSessionIds],
				archivedSessionIdsAdded,
			};
		});
	}
	/**
	 * 按宿主权威归档集合一次恢复全部、一个工作区或未分组的归档会话。
	 * 目标全部来自已归档集合，因此即使日志已被外部移除，也会清掉陈旧归档标记。
	 */
	async unarchiveSessions(target: ArchivedBatchTarget) {
		if (typeof this.registry.unarchiveSessions === "function") {
			const result = await this.registry.unarchiveSessions(target);
			await this.reconcileArchiveLedger();
			return result;
		}
		if (typeof this.registry.unarchiveSession === "function") {
			const ids = this.archivedSessionIdsForTarget(target);
			for (const id of ids) await this.unarchiveSession(id);
			return { unarchivedSessionIds: ids, archivedSessionIds: [...this.registry.archivedSessionIds] };
		}
		return this.enqueueOperation(async () => {
			const unarchivedSessionIds = this.archivedSessionIdsForTarget(target);
			if (unarchivedSessionIds.length === 0)
				return {
					archivedSessionIds: [...this.requireState().archivedSessionIds],
					unarchivedSessionIds: [],
				};
			const restored = new Set(unarchivedSessionIds);
			const state = this.requireState();
			const next = {
				...state,
				archivedSessionIds: state.archivedSessionIds.filter(
					(id) => !restored.has(id),
				),
			};
			await this.setState(next);
			return {
				archivedSessionIds: [...next.archivedSessionIds],
				unarchivedSessionIds,
			};
		});
	}
	/**
	 * 按作用域永久删除归档会话。跨会话文件删除无法组成事务，因此继续处理
	 * 后续目标并把成功、并发消失和失败分别返回给客户端。
	 */
	async deleteArchivedSessions(target: ArchivedBatchTarget) {
		// 与单删同一条纪律（A3-1）：宿主补上原生批量入口也**先不切换** —— 只上报。
		if (typeof this.registry.deleteArchivedSessions === "function") reportNativeDeleteAvailable("deleteArchivedSessions");
		// 适配路径（无宿主原生批量入口）：在任何会话被删除之前确认整条链路可用。
		this.bridge.checkWorkspace("delete");
		return this.enqueueOperation(async () => {
			const requestedSessionIds = this.archivedSessionIdsForTarget(target);
			// 批首取一次权威快照：批内每一条删除都要一次全库 `listStoredHeaders()`（含逐会话
			// 读首行），这批复用同一份。取不到就退回逐条取 —— 快照失败不该废掉整批。
			const storedIndex = await this.storedHeaderIndex().catch(() => undefined);
			const deletedSessionIds: string[] = [];
			const skippedSessionIds: string[] = [];
			const failures: Array<{ sessionId: string; message: string }> = [];
			for (const sessionId of requestedSessionIds) {
				try {
					await this.deleteSessionCore(sessionId, storedIndex);
					deletedSessionIds.push(sessionId);
				} catch (error) {
					if (error instanceof ArchiveUnknownSessionError) {
						// 转录已消失时仍需清完可达的持久痕迹；只有全部完成才算
						// skipped，否则保留归档标记并作为 failure 暴露，允许重试。
						try {
							await this.cleanupUnknownArchivedSession(sessionId);
							skippedSessionIds.push(sessionId);
						} catch (cleanupError) {
							failures.push({ sessionId, message: String(cleanupError) });
						}
						continue;
					}
					failures.push({ sessionId, message: String(error) });
				}
			}
			return {
				requestedSessionIds,
				deletedSessionIds,
				skippedSessionIds,
				failures,
			};
		});
	}
	/**
	 * 清理已无转录的陈旧归档项。缓存墓碑只在清除在途写入期间短暂持有：
	 * workspace 没有可记录的旧 header 身份，永久保留它会挡住未来的冷复用。
	 * 归档标记最后清除，前序可失败步骤出错时批量入口仍能再次命中。
	 */
	async cleanupUnknownArchivedSession(sessionId: string) {
		await this.bridge.beginDelete(sessionId);
		const projCache = this.getProjectionCache();
		await projCache?.whenIdle?.();
		if (projCache !== void 0) {
			await projCache.delete(sessionId);
			// 等待删除期间可能已进入的写回观察到墓碑并完成补删，再允许
			// 同 id 的未来新生命周期写入缓存。
			await projCache.whenIdle?.();
			// 预留位：宿主**没有** `clearTombstone` 入口（全官方树 grep 零命中），
			// 所以这里命中的是本插件 `bridge` guard 的墓碑（blocked.delete）——
			// "已删会话会不会被误复活" 100% 取决于插件自己的两份内存墓碑
			//（workspace 侧 FIFO-4096 + guard.blocked 无上限），插件重载即全清。
			// 将来宿主补了 delete+whenIdle 时 bridge 会提前 return，这行才退化成对宿主对象的空转。
			projCache.clearTombstone?.(sessionId);
		}
		await this.cleanSpill(sessionId);
		await this.removeFromWorkspaceAccounts(sessionId);
		const state = this.requireState();
		if (state.archivedSessionIds.includes(sessionId)) {
			await this.setState({
				...state,
				archivedSessionIds: state.archivedSessionIds.filter(
					(id) => id !== sessionId,
				),
			});
		}
		await this.recordArchive(sessionId, null);
	}
	/** 以归档集合顺序解析批量目标，避免依赖浏览器尚未加载完整的摘要投影。 */
	archivedSessionIdsForTarget(target: ArchivedBatchTarget): string[] {
		target = archivedBatchTargetSchema.parse(target);
		const state = this.requireState();
		const archivedSessionIds = [...new Set(state.archivedSessionIds)];
		if (target.scope === "all") return archivedSessionIds;
		if (target.scope === "sessions") {
			const selected = new Set(target.sessionIds);
			return archivedSessionIds.filter((id) => selected.has(id));
		}
		if (target.scope === "workspace") {
			const workspace = this.requireTable().get(target.workspaceId);
			if (workspace === void 0)
				throw new Error(`unknown workspace "${target.workspaceId}"`);
			const accounted = new Set(workspace.sessionIds);
			return archivedSessionIds.filter((id) => accounted.has(id));
		}
		const accounted = /* @__PURE__ */ new Set();
		const table = this.requireTable();
		for (const workspaceId of state.workspaceIds) {
			for (const sessionId of table.get(workspaceId)?.sessionIds ?? [])
				accounted.add(sessionId);
		}
		return archivedSessionIds.filter((id) => !accounted.has(id));
	}
	/**
	 * 永久删除一个会话及其全部痕迹（转录目录、工作区记账、归档标记、
	 * 投影缓存行）。
	 * @param sessionId - 要删除的会话。
	 * @returns 持久化完成后的 `{ deleted: true }`。
	 * @throws {@link ArchiveUnknownSessionError} 会话未知时抛出。
	 */
	async deleteSession(sessionId: string) {
		if (typeof this.registry.deleteSession === "function") reportNativeDeleteAvailable("deleteSession");
		return this.enqueueOperation(() => this.deleteSessionCore(sessionId));
	}
	/** 串行化后的删除主体（级联路径复用：它已持有操作链，绝不能再入队）。
	 * @param storedIndex - 可选的批首 `id → header` 快照，见 {@link storedHeaderIndex}。 */
	async deleteSessionCore(sessionId: string, storedIndex?: Map<string, SessionHeader>) {
		// A3-1（第 3 版改向）：宿主补上原生 `deleteSession` 时**先不切换** —— 原生分支跳过本插件
		// 的级联删子会话 / spill 清理 / 记账清理，等于行为静默缩水；而"切过去的代码"今天不可达，
		// 写成即等于它会在官方补上入口的那次升级上首次运行，且无从事前验证。保持自有完整序列
		//（＝今天的能力），只上报一次「宿主已提供原生入口」，切换留到人工核对过原生语义之后。
		if (typeof this.registry.deleteSession === "function") reportNativeDeleteAvailable("deleteSession");
		if (this.deleting?.has(sessionId)) throw new Error(`cyclic subagent lineage at "${sessionId}"`);
		this.deleting ??= new Set();
		this.deleting.add(sessionId);
		try {
			return await this.deleteLocalSession(sessionId, storedIndex);
		} catch (error) {
			// Failed deletion must not permanently suppress a still-live session.
			// （`clearTombstone` 是**预留位**：宿主无此入口，实际命中的是本插件 bridge guard
			//  的墓碑 —— 说明见 `cleanupUnknownArchivedSession` 里那一处。）
			this.getProjectionCache()?.clearTombstone?.(sessionId);
			throw error;
		} finally {
			this.deleting.delete(sessionId);
		}
	}
	async deleteLocalSession(sessionId: string, storedIndex?: Map<string, SessionHeader>) {
		if (!(await this.sessionKnown(sessionId, storedIndex)))
			throw new ArchiveUnknownSessionError(sessionId);
		const sessions = this.ctx.get("sessions");
		// 快速失败：删掉的顺序（flush → detach → 清缓存 → 删目录 → 清记账）里，
		// 实时会话接口一旦缺失，失败点会落在「转录已删但记账还在」的中段。
		// 这里在任何破坏性步骤（含 beginDelete 装的写屏障）之前先把实现检查完。
		if (sessions !== void 0 && typeof sessions.get !== "function")
			throw new Error("宿主会话实现缺少 get（官方接口已变动）；操作在改动任何数据前停止，请更新本插件");
		const live = sessions?.get(sessionId);
		// 能力门禁（在任何破坏性步骤之前）：实时分支需要 flush/liveEntryFor/detachEntered，
		// 冷分支需要 enter/announce。缺失即在此停止，失败点不会落到链路中段。
		const sessionRefusals = this.bridge.refusalsFor("delete", requiredSessionCapabilities(live !== void 0));
		if (sessionRefusals.length > 0) throw new CapabilityRefusalError("delete", sessionRefusals);
		// A3-2：转录清理（`removeTranscriptDirectory`）还要 `readSessionHeader` 与
		// `persistence.locate()`，而它们排在「装屏障 → flush → detach → 清缓存行」**之后**。
		// 缺任何一个，失败点都落在中段，留下"转录还在、记账已清"的半删态 —— 与上面
		// `sessions.get` 同一条纪律：破坏性步骤之前先把实现检查完。
		const headerRefusals = this.bridge.refusalsFor("delete", ["workspace.read-header"]);
		if (headerRefusals.length > 0) throw new CapabilityRefusalError("delete", headerRefusals);
		const persistence = this.ctx.get("sessionPersistence") as { locate?: unknown } | undefined;
		if (persistence === void 0 || typeof persistence.locate !== "function")
			throw new Error("宿主持久化后端未暴露 locate()（官方接口已变动）；操作在改动任何数据前停止，请更新本插件");
		// 先记录被删生命周期的日志身份：目录删除后头部不可再读，
		// 冷复用探针（sessionKnown 墓碑分支）靠它区分同 id 的新生命周期。
		const deletedHeader = this.headers.get(sessionId) ?? live?.header;
		// Install the barrier BEFORE flush/detach can schedule a final cache put.
		await this.bridge.beginDelete(sessionId, deletedHeader);
		if (live !== void 0) {
			// 持久化屏障先行：不能有未落盘的转录写入与目录删除竞争
			//（持久化后端按批关闭句柄，flush 过的会话不再持有打开的文件）。
			await sessions.flush(live);
		// 从存储分离；`session/disposed` 同步触发（payload 是 **Session 对象**），
		// 由官方 `dsh-api-session-controller` 降级成 `api-session/removed`（payload 已降为
		// **SessionId 字符串**）再转发到浏览器，并启动投影缓存的最终写后落盘。
		// 名字别写成 `host/session-removed` —— 那个帧名在整个已安装树里不存在
		//（`host/…` 是 cordis 服务/槽位名的前缀，不是线上帧命名空间）。
		// 注意 `api-session/removed` 也是"发布回滚"与"作用域剪枝"发出的同一事件
		//（官方 `dsh-session/lib/types/index.d.ts`），所以收到它**不能**等同于"用户删了会话"。
			const entry = sessions.liveEntryFor(live);
			sessions.detachEntered(entry);
		} else if (sessions !== void 0)
			await this.publishColdSessionRemoval(sessionId, sessions);
		const projCache = this.getProjectionCache();
		// dispose 的写后落盘必须先于缓存行删除完成，
		// 否则该行会在删除之后被写回（复活）。
		await projCache?.whenIdle?.();
		if (projCache !== void 0) await projCache.delete(sessionId);
		await this.deleteDescendants(sessionId, storedIndex);
		await this.cleanSpill(sessionId);
		await this.removeTranscriptDirectory(sessionId);
		// 只有物理工件删除成功后才能提交记账清理；否则批量目标会因归档标记
		// 或工作区记账提前消失而无法重试。
		const state = this.requireState();
		if (state.archivedSessionIds.includes(sessionId)) {
			await this.setState({
				...state,
				archivedSessionIds: state.archivedSessionIds.filter(
					(id) => id !== sessionId,
				),
			});
		}
		await this.removeFromWorkspaceAccounts(sessionId);
		// 物理删除已成功：此时再清父类索引。后续记账失败时保留索引，便于重试。
		this.forgetIndexedSession(sessionId);
		await this.recordArchive(sessionId, null);
		if (deletedHeader !== void 0)
			this.deletedIdentities.set(sessionId, headerIdentity(deletedHeader));
		this.publishDeletedSession(sessionId);
		return { deleted: true };
	}
	/** 删除完成后通知全部客户端；新版不再通过伪造冷会话生命周期触发通知。 */
	publishDeletedSession(sessionId: string) {
		try {
			this.ctx.emit("api-session/removed", sessionId);
		} catch (error) {
			this.ctx.logger.warn(
				`archive-manager: session "${sessionId}" deleted but removal notification failed: ${String(error)}`,
			);
		}
	}
	/**
	 * 从父类内存索引中遗忘已删除会话，并阻止后续 indexHeaders 把它加回。
	 * 实时会话以同 id 重新出现时（自定义 id 复用）会撤掉墓碑。
	 */
	clearTombstone(sessionId: string) {
		this.deletedSessionIds.delete(sessionId);
		this.deletedIdentities.delete(sessionId);
		const idx = this.deletedSessionOrder.indexOf(sessionId);
		if (idx !== -1) this.deletedSessionOrder.splice(idx, 1);
		// workspace 与 projection-cache 共同描述同一删除生命周期；新生命周期
		// 被接纳时必须同步撤销两处墓碑，否则缓存写入仍会永久被拦截。
		// 右侧那处同样是**预留位**（宿主无 `clearTombstone`，命中的是 bridge guard 的墓碑）。
		this.getProjectionCache()?.clearTombstone?.(sessionId);
	}
	forgetIndexedSession(sessionId: string) {
		for (const evicted of trackTombstone(
			this.deletedSessionIds,
			this.deletedSessionOrder,
			sessionId,
			this.deletedSessionTombstoneLimit,
		))
			this.deletedIdentities.delete(evicted);
		this.headers.delete(sessionId);
		this.sessionPaths.delete(sessionId);
		this.invalidSessionPaths.delete(sessionId);
	}
	/**
	 * 已删除会话对归档/删除入口都视为未知。实时复用同一 id 时撤墓碑，
	 * 避免挡住新会话。
	 */
	async sessionKnown(id: string, storedIndex?: Map<string, SessionHeader>) {
		if (this.ctx.get("sessions")?.get(id) !== void 0) {
			this.clearTombstone(id);
			return true;
		}
		if (this.deletedSessionIds.has(id)) return this.coldReuseKnown(id);
		// Refresh from authoritative persistence, not the host's stale header cache.
		// 批量删除会传入**批首快照**（同一批里 k 次全库 list() 是纯浪费）；不传就是逐条取新鲜数据。
		const header = storedIndex !== void 0
			? storedIndex.get(id)
			: (await this.listStoredHeaders()).find((item) => item.id === id);
		if (!header) return false;
		await this.indexHeader(header);
		return true;
	}
	/**
	 * 墓碑分支的冷复用探针：其他进程以同 id 重建并落盘的新会话（日志身份
	 * 不同）撤墓碑放行并重新编入索引；stale list() 里同生命周期的旧头部
	 * 仍视为未知。身份不可考（删除时未取到头部）时保守维持未知。
	 */
	async coldReuseKnown(id: string) {
		const deletedIdentity = this.deletedIdentities.get(id);
		if (deletedIdentity === void 0) return false;
		const persistence = this.ctx.get("sessionPersistence");
		if (persistence === void 0 || typeof persistence.list !== "function")
			return false;
		let header;
		try {
			header = (await this.listStoredHeaders()).find((item) => item.id === id);
		} catch (error) {
			this.ctx.logger.warn(
				`archive-manager: cold-reuse probe for "${id}" failed: ${String(error)}`,
			);
			return false;
		}
		if (header === void 0) return false;
		const listed = headerIdentity(header);
		if (
			listed.createdAt === deletedIdentity.createdAt &&
			listed.cwd === deletedIdentity.cwd
		)
			return false;
		this.clearTombstone(id);
		await this.indexHeader(header);
		return true;
	}
	/**
	 * 父类 indexHeaders 只增不减；跳过墓碑 id，避免 stale persistence.list()
	 * 把已删除会话重新编入 headers。
	 */
	async indexHeader(header: SessionHeader) {
		if (this.deletedSessionIds.has(header.id)) return;
		return this.registry.indexHeader(header);
	}
	/** 统一旧版头部数组与 0.1.3 的持久化快照，供父类索引和本插件枚举共用。 */
	async listStoredHeaders(): Promise<SessionHeader[]> {
		return (await this.ctx.sessionPersistence.list()).map(
			(item) => item.header ?? item,
		);
	}
	/**
	 * `id → header` 索引，供**一次批量操作内部**复用：`listStoredHeaders()` 每次都是
	 * 全库遍历 + 逐会话读首行，批量里逐条调用就是 O(k·n)。
	 *
	 * 只在批内有效 —— 它不随删除自动剔除，也不代表"此刻磁盘上的最新"；需要后者做判据的
	 * 地方（`coldReuseKnown` 的同 id 新生命周期比对）仍然自己取新鲜数据。
	 */
	async storedHeaderIndex(): Promise<Map<string, SessionHeader>> {
		const index = new Map<string, SessionHeader>();
		for (const header of await this.listStoredHeaders())
			index.set(header.id, header);
		return index;
	}
	async indexHeaders(items: Array<SessionHeader & { header?: SessionHeader }>) {
		for (const item of items) await this.indexHeader(item.header ?? item);
	}
	/** 为未处于实时状态的持久化会话发布相同的移除事件。 */
	async publishColdSessionRemoval(sessionId: string, sessions: ColdSessionSessions) {
		const persistence = this.ctx.get("sessionPersistence");
		if (persistence === void 0 || typeof persistence.prepare !== "function")
			return;
		try {
			const preparation = await persistence.prepare(sessionId);
			const detach = sessions.enter(preparation.session);
			try {
				sessions.announce(preparation.session);
			} finally {
				detach();
				preparation[Symbol.dispose]();
			}
		} catch (error) {
			this.ctx.logger.warn(
				`archive-manager: could not publish removal for stored session "${sessionId}": ${String(error)}`,
			);
		}
	}
	/** 官方 JSONL 已知布局清理会话专属目录；其他后端只删除定位到的工件。 */
	async removeTranscriptDirectory(sessionId: string) {
		const persistence = this.ctx.get("sessionPersistence");
		if (persistence === void 0 || typeof persistence.locate !== "function") {
			throw new Error(
				`cannot delete session "${sessionId}": the session persistence backend does not expose locate() to resolve its transcript artifact`,
			);
		}
		const header = await this.readSessionHeader(sessionId);
		const location = persistence.locate(header);
		if (location === void 0 || typeof location.path !== "string") {
			throw new Error(
				`cannot delete session "${sessionId}": the session persistence backend could not resolve its transcript artifact`,
			);
		}
		let target = { path: location.path, kind: "transcript artifact" };
		try {
			const directory = jsonlSessionDirectory(persistence, header, location);
			if (directory !== void 0) {
				target = { path: directory, kind: "session directory" };
				// The configured storage root may itself be an intentional alias, but
				// project/session links must not redirect recursive deletion elsewhere.
				// These checks assume trusted, stable storage ancestors; lstat + rm
				// is not an atomic defense against another process swapping directories.
				for (const path of [dirname(directory), directory]) {
					let stat;
					try {
						stat = await lstat(path);
					} catch (error: any) {
						// Node 文件系统错误的 code 按动态形状读取（此处只关心 ENOENT）。
						if (error?.code === "ENOENT") continue; // Already removed on an earlier attempt.
						throw error;
					}
					if (stat.isSymbolicLink())
						throw new Error(`refusing to delete through symbolic link "${path}"`);
					if (!stat.isDirectory())
						throw new Error(`expected session storage directory "${path}"`);
				}
			} else if (persistence.name === "session-persistence-jsonl") {
				this.ctx.logger.warn(
					`archive-manager: session "${sessionId}": JSONL directory ownership could not be verified; falling back to artifact-only deletion at "${location.path}" (parent directory retained)`,
				);
			}
			await rm(target.path, { recursive: true, force: true });
			// 新版 locate() 只是当前代际的诊断路径；以存储观察确认删除已生效，
			// 避免不存在的目标被 force 忽略后，仍把可读会话记为已删除。
			if (
				typeof persistence.stat === "function" &&
				(await persistence.stat(sessionId)) !== void 0
			) {
				throw new Error(
					`session "${sessionId}" is still present in persistence after artifact removal`,
				);
			}
		} catch (error) {
			const message = `cannot delete session "${sessionId}": cleanup of ${target.kind} "${target.path}" failed; bookkeeping retained for retry`;
			const detail = `${message}: ${String(error)}`;
			this.ctx.logger.warn(`archive-manager: ${detail}`);
			throw new Error(detail, { cause: error });
		}
	}
	/** 把 id 从每个工作区记录中移除，并刷新实体快照。 */
	async removeFromWorkspaceAccounts(sessionId: string) {
		const table = this.requireTable();
		const state = this.requireState();
		for (const workspaceId of state.workspaceIds) {
			const record = table.get(workspaceId);
			if (record === void 0 || !record.sessionIds.includes(sessionId)) continue;
			const next = await table.update(workspaceId, (current) => ({
				...current,
				sessionIds: current.sessionIds.filter((id) => id !== sessionId),
				updatedAt: /* @__PURE__ */ new Date().toISOString(),
			}));
			// 实体快照的形状由宿主 `WorkspaceEntity` 决定（`record` 是私有字段，运行时存在）。
			const entity = this.entities.get(workspaceId) as { record?: unknown } | undefined;
			if (entity === void 0) continue;
			// A3-3：官方把 `record` 改名或改成只读访问器时，这一行会**静默无效** —— 界面读到旧
			// 快照（会话计数不动），看起来却"什么都没发生"。写完立刻读回，没写进去就上报；
			// 仍然照写（不因为探测而少做一次更新）。
			let applied = false;
			try { entity.record = next; applied = entity.record === next; } catch { applied = false; }
			if (!applied) {
				noteRuntime({
					id: "workspace.entity-record",
					label: "工作区实体快照更新",
					kind: "write",
					fallback: "inform-only",
					detail: "工作区实体的 record 字段写不进去（宿主 WorkspaceEntity 形状可能已变）：实体快照可能停留在旧值，界面上的会话计数可能不刷新。",
				});
			}
		}
	}
	/** 尽力而为的级联删除：删除 `sessionId` 的 SUBAGENT 子会话。
	 * 仅头部标记 `origin: "subagent"` 的会话参与：单凭 `parentSession` 有歧义
	 *（fork 分支也携带它），而 fork 分支是独立的用户会话，绝不能被级联删除。
	 * @param storedIndex - 可选的批首 `id → header` 快照，见 {@link storedHeaderIndex}。 */
	async deleteDescendants(sessionId: string, storedIndex?: Map<string, SessionHeader>) {
		try {
			const descendants: string[] = [];
			const sessions = this.ctx.get("sessions");
			if (sessions !== void 0)
				for (const session of sessions.list()) {
					if (
						session.header.parentSession === sessionId &&
						session.header.origin === "subagent"
					)
						descendants.push(session.id);
				}
			const headers = storedIndex !== void 0
				? [...storedIndex.values()]
				: await this.listStoredHeaders();
			for (const header of headers) {
				if (
					header.parentSession === sessionId &&
					header.origin === "subagent" &&
					!descendants.includes(header.id)
				)
					descendants.push(header.id);
			}
			for (const childId of descendants) {
				try {
					if (!(await this.sessionKnown(childId, storedIndex))) continue;
					await this.deleteSessionCore(childId, storedIndex);
				} catch (error) {
					if (error instanceof ArchiveUnknownSessionError) continue;
					this.ctx.logger.warn(
						`archive-manager: cascade delete of subagent session "${childId}" (child of "${sessionId}") failed: ${String(error)}`,
					);
				}
			}
		} catch (error) {
			this.ctx.logger.warn(
				`archive-manager: descendant enumeration for deleted session "${sessionId}" failed: ${String(error)}`,
			);
		}
	}
	/** 尽力而为的 spill 清理：移除该会话作用域的 spill 目录。 */
	async cleanSpill(sessionId: string) {
		try {
			const spill = this.ctx.get("spillStore");
			if (spill === void 0 || typeof spill.root !== "string") return;
			await rm(sessionDir(spill.root, sessionId), {
				recursive: true,
				force: true,
			});
		} catch (error) {
			this.ctx.logger.warn(
				`archive-manager: spill cleanup for deleted session "${sessionId}" failed: ${String(error)}`,
			);
		}
	}
};
//#endregion
export { ArchiveWorkspaceRegistry, ArchiveWorkspaceRegistry as default, workspaceBaseName, workspacePathKey };
