import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { CapabilityRefusalError, createHistoryBridge, requiredSessionCapabilities } from "./bridge.js";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hubPath } from "../hub.js";
import { sessionDir } from "@deepseek-ai/dsh-spill-local";
import { trackTombstone } from "./tombstone.js";
//#region lib/types/index.js
/**
 * 独立归档门面：消费当前宿主服务，不注册或替换 workspaceRegistry。
 * 外部服务有原生接口时优先委托；官方缺口由受检查的兼容层补齐。
 *
 * 实测边界（2026-09-14，对抗式审查）：现装宿主**没有任何**原生归档扩展接口
 * ——全量 grep `archivedSessionDetails` / `deleteArchivedSessions` / `unarchiveSessions`
 * 均不存在，`@michengai/dsh-archive-manager` 也未安装。因此下面所有
 * `typeof this.registry.X === "function"` 的委托分支在当前环境**都是死代码**，
 * 实际执行路径永远是 history/bridge.js 的私有适配（依赖官方声明为 private 的方法，
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
function jsonlSessionDirectory(persistence, header, location) {
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
	const encode = (text) =>
		text.replace(
			/[^A-Za-z0-9._-]/g,
			(ch) => `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
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

function unknownSessionMessage(sessionId) {
	return `unknown session "${sessionId}" (UNKNOWN_SESSION)`;
}
var ArchiveUnknownSessionError = class extends Error {
	sessionId;
	constructor(sessionId) {
		super(unknownSessionMessage(sessionId));
		this.sessionId = sessionId;
		this.name = "ArchiveUnknownSessionError";
	}
};
/** 头部投影到“日志身份”字段（与投影缓存的 identity 语义一致）。cwd 缺失统一归一为 null，避免一侧带键一侧不带键时的比较歧义。 */
function headerIdentity(header) {
	return {
		createdAt: header.createdAt,
		cwd: header.cwd ?? null,
	};
}
const sessionIdSchema = {
	parse(value) {
		if (typeof value !== "string" || value.length === 0)
			throw new TypeError(
				`sessionId must be a non-empty string, got ${String(value)}`,
			);
		return value;
	},
};
const workspaceIdSchema = {
	parse(value) {
		if (typeof value !== "string" || value.length === 0)
			throw new TypeError(
				`workspaceId must be a non-empty string, got ${String(value)}`,
			);
		return value;
	},
};
const archivedSetSchema = {
	parse(value) {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("result must be an object");
		const ids = value.archivedSessionIds;
		if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
			throw new TypeError("archivedSessionIds must be a string array");
		return value;
	},
};
const deletedSchema = {
	parse(value) {
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
	parse(value) {
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
			value.sessionIds.every((id) => typeof id === "string" && id.length > 0)
		)
			return value;
		throw new TypeError(
			"target.scope must be all, ungrouped, workspace with a non-empty workspaceId, or sessions with non-empty sessionIds",
		);
	},
};
const unarchivedBatchSchema = {
	parse(value) {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("result must be an object");
		if (
			!Array.isArray(value.archivedSessionIds) ||
			value.archivedSessionIds.some((id) => typeof id !== "string")
		)
			throw new TypeError("archivedSessionIds must be a string array");
		if (
			!Array.isArray(value.unarchivedSessionIds) ||
			value.unarchivedSessionIds.some((id) => typeof id !== "string")
		)
			throw new TypeError("unarchivedSessionIds must be a string array");
		return value;
	},
};
const archivedWorkspaceBatchSchema = {
	parse(value) {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("result must be an object");
		if (
			!Array.isArray(value.archivedSessionIds) ||
			value.archivedSessionIds.some((id) => typeof id !== "string")
		)
			throw new TypeError("archivedSessionIds must be a string array");
		if (
			!Array.isArray(value.archivedSessionIdsAdded) ||
			value.archivedSessionIdsAdded.some((id) => typeof id !== "string")
		)
			throw new TypeError("archivedSessionIdsAdded must be a string array");
		return value;
	},
};
const deletedBatchSchema = {
	parse(value) {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("result must be an object");
		for (const key of [
			"requestedSessionIds",
			"deletedSessionIds",
			"skippedSessionIds",
		]) {
			if (
				!Array.isArray(value[key]) ||
				value[key].some((id) => typeof id !== "string")
			)
				throw new TypeError(`${key} must be a string array`);
		}
		if (
			!Array.isArray(value.failures) ||
			value.failures.some(
				(failure) =>
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
	parse(value) {
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			!Array.isArray(value.items)
		)
			throw new TypeError("result.items must be an array");
		if (
			value.items.some(
				(item) =>
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
				value.repairedSessionIds.some((id) => typeof id !== "string"))
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
 * 先归一化。仅用于**分组与快照索引**，不参与任何写入或归属判定。
 * @param {string} path - 原始路径。
 * @returns {string} 归一化后的比较键（空路径返回空串）。
 */
function workspacePathKey(path) {
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
function workspaceBaseName(path) {
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
	/** 本进程内已物理删除的会话；阻止父类把 stale list() 重新编入索引。 */
	deletedSessionIds = /* @__PURE__ */ new Set();
	/** 墓碑插入顺序，用于在上限处淘汰最旧项。 */
	deletedSessionOrder = [];
	/** 墓碑上限：足够挡住 stale list()，又避免长驻进程无限增长。 */
	deletedSessionTombstoneLimit = 4096;
	/** 被删生命周期的日志身份（createdAt/cwd）：冷复用探针区分“同 id 新会话”与 stale list() 的依据。 */
	deletedIdentities = /* @__PURE__ */ new Map();
	/** 会话 → 归档时刻（epoch ms）；保留期自动删除的基线。 */
	archivedAtMap = /* @__PURE__ */ new Map();
	archivedAtFile = null;
	archivedAtLoaded = false;
	/**
	 * 「见过的登记」快照：归一化路径 → { path, title, id, at }。
	 * 宿主删除工作区是硬删、不留墓碑（dsh-workspace `deleteKnown`），登记一没，
	 * 归档会话的归属就只剩会话自己的 cwd。本表把**活着时见过**的登记标题留下来，
	 * 使按目录重建的分组仍能显示用户命名，并能区分「曾经登记过、现在被移除」
	 * 与「从未登记过的目录」。只读辅助信息，不参与任何归属判定或写入。
	 */
	workspaceSnapshotMap = /* @__PURE__ */ new Map();
	workspaceSnapshotFile = null;
	workspaceSnapshotLoaded = false;
	/** 快照上限：足够覆盖常见工作区数，又避免长驻进程无限增长。 */
	workspaceSnapshotLimit = 200;
	/**
	 * 启动期一次性迁移（插件目录 → hub）的完成信号。两个账本都是**首次用到才读盘**，
	 * 但"首次用到"可能与迁移并发，因此读盘前先等它落定；未提供时立即就绪。
	 */
	ready = Promise.resolve();
	constructor(ctx, registry, config = {}) {
		this.ctx = ctx;
		this.registry = registry;
		this.archivedAtFile = config.archivedAtFile || defaultArchivedAtFile();
		this.workspaceSnapshotFile = config.workspaceSnapshotFile || defaultWorkspaceSnapshotFile();
		if (config.ready && typeof config.ready.then === "function") {
			this.ready = Promise.resolve(config.ready).then(() => undefined, () => undefined);
		}
		this.ledgerTail = Promise.resolve();
		this.bridge = createHistoryBridge(ctx, registry, (id, at) => this.recordArchive(id, at));
		this.registry = this.bridge.registry;
		this.bridge.observe();
	}
	async dispose() { await this.bridge.dispose(); await this.ledgerTail; }
	get headers() { return this.registry.headers; }
	get sessionPaths() { return this.registry.sessionPaths; }
	get invalidSessionPaths() { return this.registry.invalidSessionPaths; }
	get entities() { return this.registry.entities; }
	get archivedSessionIds() { return this.registry.archivedSessionIds; }
	requireState() { return this.bridge.state(); }
	requireTable() { return this.bridge.table(); }
	setState(state) { return this.bridge.setState(state); }
	enqueueOperation(fn) { return this.bridge.enqueue(fn); }
	readSessionHeader(id) { return this.bridge.readHeader(id); }
	getProjectionCache() { return this.bridge.cache(); }
	/** 宿主能力评估快照（供 HTTP compat-status op 与设置页使用）。 */
	capabilities(force = false) { return this.bridge.capabilities(force); }
	/** 指定能力 id 中不可用的那些；不抛错，供只读路径降级。 */
	capabilityRefusals(ids) { return this.bridge.refusalsFor("read", ids); }
	recordArchive(id, at) {
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
			const obj = JSON.parse(raw);
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
			const obj = {};
			for (const [k, v] of this.archivedAtMap) obj[k] = v;
			await mkdir(dirname(this.archivedAtFile), { recursive: true });
			await writeFile(this.archivedAtFile, JSON.stringify(obj), "utf8");
		} catch (e) {
			this.ctx.logger?.warn?.(`history: could not persist archived-at ledger: ${String(e)}`);
		}
	}
	archivedAt(sessionId) {
		return this.archivedAtMap.get(sessionId);
	}
	/**
	 * 读取「见过的登记」快照（首次调用读盘）。键为 `workspacePathKey` 归一化路径。
	 * @returns {Promise<Map<string, { path: string, title: string, id?: string, at: number }>>} 快照副本。
	 */
	async workspaceSnapshot() {
		await this.ensureWorkspaceSnapshotLoaded();
		const out = /* @__PURE__ */ new Map();
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
			const items = parsed && typeof parsed === "object" && parsed.items && typeof parsed.items === "object" ? parsed.items : parsed;
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
			const items = {};
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
	async rememberWorkspaces(records) {
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
	async ensureWorkspaceAccounting(sessionIds) {
		const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).map((id) => String(id ?? "").trim()).filter(Boolean))];
		const result = { registered: [], attached: [], skipped: [] };
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
			} catch (error) {
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
				} catch (error) {
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
			} catch (error) {
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
	async registerWorkspace(path, title) {
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
		const record = {
			id: String(entity.id),
			path: String(entity.path ?? target),
			title: String(entity.title ?? "") || workspaceBaseName(target) || target,
		};
		await this.rememberWorkspaces([record]);
		const { attached, attachSkipped } = await this.attachKnownSessions(entity, record.path);
		return { ...record, created, attached, attachSkipped };
	}
	/**
	 * 把宿主索引里**属于该目录**的已知会话挂回这条登记（幂等；已在册的不重复上报）。
	 * 只信 `registry.sessionPaths`（宿主按真实目录建的规范路径索引），不猜路径。
	 * @param {{ sessionIds?: string[], attachSession?: (id: string) => Promise<void> }} entity - 宿主登记对象。
	 * @param {string} path - 该登记的规范路径。
	 * @returns {Promise<{ attached: string[], attachSkipped: Array<{ sessionId: string, reason: string }> }>} 挂回结果。
	 */
	async attachKnownSessions(entity, path) {
		const attached = [];
		const attachSkipped = [];
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
			} catch (error) {
				attachSkipped.push({ sessionId, reason: String(error?.message ?? error) });
			}
		}
		return { attached, attachSkipped };
	}
	/**
	 * 归档委托宿主。官方 UI 不经过本方法，而由 domain/changed 事件
	 * 同步归档时刻；重复归档不重置保留期。
	 */
	async archiveSession(sessionId) {
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
	async archivedSessionDetails() {
		await this.reconcileArchiveLedger();
		if (typeof this.registry.archivedSessionDetails === "function") {
			const result = await this.registry.archivedSessionDetails();
			return { ...result, items: result.items.map((item) => ({ ...item, archivedAt: item.archivedAt ?? this.archivedAtMap.get(item.sessionId) })) };
		}
		const items = [];
		for (const sessionId of [...new Set(this.requireState().archivedSessionIds)]) {
			const entry = { sessionId, archivedAt: this.archivedAtMap.get(sessionId) };
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
	async archivedSessionMetadata() {
		const items = [];
		const repairedSessionIds = [];
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
	async repairArchivedProjection(header) {
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
	async readStoredProjectionSource(persistence, sessionId) {
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
	async unarchiveSession(sessionId) {
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
	async archiveWorkspaceSessions(workspaceId) {
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
	async unarchiveSessions(target) {
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
	async deleteArchivedSessions(target) {
		if (typeof this.registry.deleteArchivedSessions === "function") {
			const result = await this.registry.deleteArchivedSessions(target);
			await this.reconcileArchiveLedger();
			return result;
		}
		// 适配路径（无宿主原生批量入口）：在任何会话被删除之前确认整条链路可用。
		this.bridge.checkWorkspace("delete");
		if (typeof this.registry.deleteSession === "function") {
			const requestedSessionIds = this.archivedSessionIdsForTarget(target);
			const result = { requestedSessionIds, deletedSessionIds: [], skippedSessionIds: [], failures: [] };
			for (const id of requestedSessionIds) {
				try { await this.deleteSession(id); result.deletedSessionIds.push(id); }
				catch (error) { result.failures.push({ sessionId: id, message: String(error) }); }
			}
			return result;
		}
		return this.enqueueOperation(async () => {
			const requestedSessionIds = this.archivedSessionIdsForTarget(target);
			const deletedSessionIds = [];
			const skippedSessionIds = [];
			const failures = [];
			for (const sessionId of requestedSessionIds) {
				try {
					await this.deleteSessionCore(sessionId);
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
	async cleanupUnknownArchivedSession(sessionId) {
		await this.bridge.beginDelete(sessionId);
		const projCache = this.getProjectionCache();
		await projCache?.whenIdle?.();
		if (projCache !== void 0) {
			await projCache.delete(sessionId);
			// 等待删除期间可能已进入的写回观察到墓碑并完成补删，再允许
			// 同 id 的未来新生命周期写入缓存。
			await projCache.whenIdle?.();
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
	archivedSessionIdsForTarget(target) {
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
	async deleteSession(sessionId) {
		if (typeof this.registry.deleteSession === "function") {
			const result = await this.registry.deleteSession(sessionId);
			await this.reconcileArchiveLedger();
			return result;
		}
		return this.enqueueOperation(() => this.deleteSessionCore(sessionId));
	}
	/** 串行化后的删除主体（级联路径复用：它已持有操作链，绝不能再入队）。 */
	async deleteSessionCore(sessionId) {
		if (typeof this.registry.deleteSession === "function") return this.registry.deleteSession(sessionId);
		if (this.deleting?.has(sessionId)) throw new Error(`cyclic subagent lineage at "${sessionId}"`);
		this.deleting ??= new Set();
		this.deleting.add(sessionId);
		try {
			return await this.deleteLocalSession(sessionId);
		} catch (error) {
			// Failed deletion must not permanently suppress a still-live session.
			this.getProjectionCache()?.clearTombstone?.(sessionId);
			throw error;
		} finally {
			this.deleting.delete(sessionId);
		}
	}
	async deleteLocalSession(sessionId) {
		if (!(await this.sessionKnown(sessionId)))
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
		// 先记录被删生命周期的日志身份：目录删除后头部不可再读，
		// 冷复用探针（sessionKnown 墓碑分支）靠它区分同 id 的新生命周期。
		const deletedHeader = this.headers.get(sessionId) ?? live?.header;
		// Install the barrier BEFORE flush/detach can schedule a final cache put.
		await this.bridge.beginDelete(sessionId, deletedHeader);
		if (live !== void 0) {
			// 持久化屏障先行：不能有未落盘的转录写入与目录删除竞争
			//（持久化后端按批关闭句柄，flush 过的会话不再持有打开的文件）。
			await sessions.flush(live);
			// 从存储分离；`session/disposed` 同步触发，驱动浏览器端的
			// `host/session-removed` 帧并启动投影缓存的最终写后落盘。
			const entry = sessions.liveEntryFor(live);
			sessions.detachEntered(entry);
		} else if (sessions !== void 0)
			await this.publishColdSessionRemoval(sessionId, sessions);
		const projCache = this.getProjectionCache();
		// dispose 的写后落盘必须先于缓存行删除完成，
		// 否则该行会在删除之后被写回（复活）。
		await projCache?.whenIdle?.();
		if (projCache !== void 0) await projCache.delete(sessionId);
		await this.deleteDescendants(sessionId);
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
	publishDeletedSession(sessionId) {
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
	clearTombstone(sessionId) {
		this.deletedSessionIds.delete(sessionId);
		this.deletedIdentities.delete(sessionId);
		const idx = this.deletedSessionOrder.indexOf(sessionId);
		if (idx !== -1) this.deletedSessionOrder.splice(idx, 1);
		// workspace 与 projection-cache 共同描述同一删除生命周期；新生命周期
		// 被接纳时必须同步撤销两处墓碑，否则缓存写入仍会永久被拦截。
		this.getProjectionCache()?.clearTombstone?.(sessionId);
	}
	forgetIndexedSession(sessionId) {
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
	async sessionKnown(id) {
		if (this.ctx.get("sessions")?.get(id) !== void 0) {
			this.clearTombstone(id);
			return true;
		}
		if (this.deletedSessionIds.has(id)) return this.coldReuseKnown(id);
		// Refresh from authoritative persistence, not the host's stale header cache.
		const header = (await this.listStoredHeaders()).find((item) => item.id === id);
		if (!header) return false;
		await this.indexHeader(header);
		return true;
	}
	/**
	 * 墓碑分支的冷复用探针：其他进程以同 id 重建并落盘的新会话（日志身份
	 * 不同）撤墓碑放行并重新编入索引；stale list() 里同生命周期的旧头部
	 * 仍视为未知。身份不可考（删除时未取到头部）时保守维持未知。
	 */
	async coldReuseKnown(id) {
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
	async indexHeader(header) {
		if (this.deletedSessionIds.has(header.id)) return;
		return this.registry.indexHeader(header);
	}
	/** 统一旧版头部数组与 0.1.3 的持久化快照，供父类索引和本插件枚举共用。 */
	async listStoredHeaders() {
		return (await this.ctx.sessionPersistence.list()).map(
			(item) => item.header ?? item,
		);
	}
	async indexHeaders(items) {
		for (const item of items) await this.indexHeader(item.header ?? item);
	}
	/** 为未处于实时状态的持久化会话发布相同的移除事件。 */
	async publishColdSessionRemoval(sessionId, sessions) {
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
	async removeTranscriptDirectory(sessionId) {
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
					} catch (error) {
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
	async removeFromWorkspaceAccounts(sessionId) {
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
			const entity = this.entities.get(workspaceId);
			if (entity !== void 0) entity.record = next;
		}
	}
	/** 尽力而为的级联删除：删除 `sessionId` 的 SUBAGENT 子会话。
	 * 仅头部标记 `origin: "subagent"` 的会话参与：单凭 `parentSession` 有歧义
	 *（fork 分支也携带它），而 fork 分支是独立的用户会话，绝不能被级联删除。 */
	async deleteDescendants(sessionId) {
		try {
			const descendants = [];
			const sessions = this.ctx.get("sessions");
			if (sessions !== void 0)
				for (const session of sessions.list()) {
					if (
						session.header.parentSession === sessionId &&
						session.header.origin === "subagent"
					)
						descendants.push(session.id);
				}
			for (const header of await this.listStoredHeaders()) {
				if (
					header.parentSession === sessionId &&
					header.origin === "subagent" &&
					!descendants.includes(header.id)
				)
					descendants.push(header.id);
			}
			for (const childId of descendants) {
				try {
					if (!(await this.sessionKnown(childId))) continue;
					await this.deleteSessionCore(childId);
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
	async cleanSpill(sessionId) {
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
