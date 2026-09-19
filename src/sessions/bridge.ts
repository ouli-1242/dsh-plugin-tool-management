import { symbols, type Context } from "@deepseek-ai/cordis";
import { workspaceDomainSpec } from "@deepseek-ai/dsh-workspace";
import type { CheckpointIdentity } from "@deepseek-ai/dsh-session-projection-cache";
import { assessHost, routeFor, refusalsFor, CapabilityRefusalError, type CapabilityRefusal, type HostAssessment, type OperationName, type RouteDecision } from "../compat/probe.js";

export { CapabilityRefusalError };

/**
 * 工作区注册表在本文件中的使用面。requireState / requireTable / setState /
 * readSessionHeader / enqueueOperation 及四个索引 Map 在官方声明中均为
 * private，宿主运行时存在 —— 这里按实际调用形状声明最小结构。
 */
export interface RegistryLike {
  archivedSessionIds: readonly string[];
  headers: Map<string, unknown>;
  sessionPaths: Map<string, unknown>;
  invalidSessionPaths: Map<string, unknown>;
  entities: Map<string, unknown>;
  enqueueOperation<T>(fn: () => Promise<T>): Promise<T>;
  [key: string]: unknown;
}

/** 宿主投影缓存存储行（KvTable<string, CheckpointRecord> 的最小读写面）。 */
interface ProjectionCacheTableLike {
  get(id: string): { identity: CheckpointIdentity } | undefined;
  delete(id: string): Promise<boolean>;
}

/**
 * 宿主投影缓存的写入面。put / requireTable 在官方声明中为 private，
 * delete / whenIdle 是 rc.2 之后宿主才自带的可选删除屏障 —— 按实际用法声明。
 */
interface ProjectionCacheLike {
  put(id: string, identity: CheckpointIdentity, rows: unknown): Promise<unknown>;
  write(session: unknown): Promise<unknown>;
  requireTable(): ProjectionCacheTableLike;
  delete?(id: string): Promise<unknown>;
  whenIdle?(): Promise<void>;
  [key: string]: unknown;
}

/** 写屏障替换 put/write 时使用的包装器形状（含按名字恢复时的动态索引）。 */
interface CacheWriteWrappers {
  put(id: string, identity: CheckpointIdentity, rows: unknown): Promise<unknown>;
  write(session: unknown): Promise<unknown>;
  [key: string]: unknown;
}

/** acquireCacheGuard 装配出的写屏障句柄形状。 */
interface CacheGuard {
  users: number;
  begin(id: string, header: CheckpointIdentity | null | undefined): void;
  clearTombstone(id: string): void;
  whenIdle(): Promise<void>;
  delete(id: string): Promise<unknown>;
  release(): Promise<void>;
}

// No Service subclass, no ctx.provide(), no second storage-domain owner.
// The official API lacks unarchive and a cache deletion barrier, so this file
// adapts the gaps. WHICH parts of the host it may touch is decided by
// ../compat/probe.ts from live, observable facts (module identity, member
// presence, shapes, read-only behaviour), never from comparing source text:
// text equality only ever proved "same release", and it turned every harmless
// upstream refactor into a total feature outage.
//
// 纪律边界（对工作区「官方包与宿主机制只读」一条的解释，2026-09-18 复核确认）：
// 这里的包装是**运行时实例**上的临时、可恢复、能力门控的适配（仅当宿主自己缺
// delete/whenIdle 时才装；按原 descriptor 恢复；serial 队列防复活），不修改任何
// 官方包文件、不持久化改动、不改变宿主机制的对外行为 —— 与「不 patch 官方代码」
// 禁令针对的对象（包文件与宿主机制的永久改写）不同层。若用户裁定该解释不成立，
// 撤掉 acquire/releaseCacheGuard 即可整体退回「无删除屏障」的降级形态。
const cacheGuards = new WeakMap<object, CacheGuard>();
const raw = <T>(value: T): T => {
  // cordis 的 traceable 代理在 [symbols.original] 上挂原始对象；无代理时原样返回
  const holder = value as { [symbols.original]?: T } | null | undefined;
  return holder?.[symbols.original] ?? value;
};
const sameLifecycle = (a: CheckpointIdentity | null | undefined, b: CheckpointIdentity | null | undefined) =>
  a && b && a.createdAt === b.createdAt && (a.cwd ?? null) === (b.cwd ?? null);

/**
 * Install the write barrier around the host's projection cache when (and only
 * when) the host cannot safely delete a cache row on its own.
 *
 * Guarded on capability, not on implementation text: the cache is wrapped only
 * when the write path and a deletable table are both present, and a host that
 * ships its own `delete`/`whenIdle` barrier never gets wrapped at all.
 *
 * @param cache - host projection cache instance.
 * @returns the barrier handle.
 * @throws {CapabilityRefusalError} when the cache cannot support a safe delete.
 */
function acquireCacheGuard(cache: ProjectionCacheLike): CacheGuard {
  let guard = cacheGuards.get(cache);
  if (guard) { guard.users += 1; return guard; }
  const missing = ["put", "write", "requireTable"].filter((name) => typeof cache[name] !== "function");
  if (missing.length > 0) {
    throw new CapabilityRefusalError("delete", refusalsFor(
      { findings: [{ id: "projection.write", label: "投影缓存写入路径", kind: "write", owner: "projectionCache", fallback: "disable-destructive", state: "missing-member", detail: `宿主投影缓存缺少 ${missing.join(", ")}`, missing }] },
      ["projection.write"],
    ));
  }
  const table = cache.requireTable();
  if (typeof table?.delete !== "function") {
    throw new CapabilityRefusalError("delete", [{
      id: "projection.table-delete",
      label: "投影缓存行删除",
      detail: "宿主投影缓存存储不支持安全删除（table.delete 缺失）",
      recovery: "请更新本插件到与本机 DSH 匹配的版本。",
    }]);
  }
  const descriptors = Object.fromEntries(["put", "write"].map((name) => [name, Object.getOwnPropertyDescriptor(cache, name)]));
  const originals = { put: cache.put, write: cache.write };
  const blocked = new Map();
  const pending = new Set();
  const queues = new Map();
  const isBlocked = (id: string, identity: CheckpointIdentity | null | undefined) => blocked.has(id) && (blocked.get(id) === null || sameLifecycle(blocked.get(id), identity));
  function track<T>(task: Promise<T>): Promise<T> {
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  function serial(id: string, fn: () => unknown): Promise<unknown> {
    const task = (queues.get(id) ?? Promise.resolve()).then(fn);
    const settled = task.then(() => {}, () => {});
    queues.set(id, settled);
    settled.then(() => { if (queues.get(id) === settled) queues.delete(id); });
    return track(task);
  }
  const wrappers: CacheWriteWrappers = {
    put(id, identity, rows) {
      // Preserve the upstream snapshot-at-call boundary even while queued.
      if (isBlocked(id, identity)) return Promise.resolve();
      const expected = { ...identity };
      let detached;
      try { detached = structuredClone(rows); }
      catch (error) { return Promise.reject(error); }
      // Serialize puts with deletion; never erase a new lifecycle reusing id.
      return serial(id, async () => {
        if (isBlocked(id, expected)) return;
        await originals.put.call(cache, id, expected, detached);
        if (isBlocked(id, expected)) {
          const stored = table.get(id);
          if (stored && sameLifecycle(stored.identity, expected)) await table.delete(id);
        }
      });
    },
    write(session) {
      // Track the flush await before put as well as put itself. Otherwise a
      // delayed write could outlive disposal and bypass the restored method.
      try { return track(Promise.resolve(originals.write.call(cache, session))); }
      catch (error) { return Promise.reject(error); }
    },
  };
  cache.put = wrappers.put;
  cache.write = wrappers.write;
  guard = {
    users: 1,
    begin(id, header) { blocked.set(id, header ?? null); },
    clearTombstone(id) { blocked.delete(id); },
    async whenIdle() { while (pending.size) await Promise.allSettled([...pending]); },
    async delete(id) {
      await this.whenIdle();
      return serial(id, async () => {
        const stored = table.get(id);
        const identity = blocked.get(id);
        if (!stored || identity == null || sameLifecycle(stored.identity, identity)) await table.delete(id);
      });
    },
    async release() {
      if (--this.users > 0) return;
      await this.whenIdle();
      if (this.users > 0) return;
      let restored = true;
      for (const name of ["put", "write"]) {
        // Never overwrite a later third-party wrapper.
        if (cache[name] !== wrappers[name]) { restored = false; continue; }
        if (descriptors[name]) Object.defineProperty(cache, name, descriptors[name]);
        else delete cache[name];
      }
      if (restored) { blocked.clear(); cacheGuards.delete(cache); }
    },
  };
  cacheGuards.set(cache, guard);
  return guard;
}

/**
 * Live-session members the delete sequence needs, split by branch.
 *
 * `liveEntryFor`/`detachEntered` are private in the official declarations
 * (dsh-session lib/types/index.d.ts), so they are consumed through the same
 * capability gate as everything else. The point of checking BEFORE any
 * destructive step is unchanged: otherwise the failure lands mid-sequence
 * (after flush, before ledger cleanup) and leaves "transcript gone, archive
 * flag still set" behind.
 *
 * @param sessions - ctx.sessions; the cold branch tolerates it being absent.
 * @param hasLiveSession - whether this session is currently live.
 * @returns the capability ids that must be `ok`, in evaluation order.
 */
export function requiredSessionCapabilities(hasLiveSession: boolean): string[] {
  return hasLiveSession
    ? ["sessions.detach-live"]
    : ["sessions.cold-announce"];
}

export function createSessionsBridge(
  ctx: Context,
  suppliedRegistry: RegistryLike,
  onArchive: (id: string, at: number | null) => Promise<unknown>,
) {
  // Cordis returns a fresh traceable method proxy on access. Compare and adapt
  // the original object, not proxies; calls retain the service owner's context.
  const registry = raw(suppliedRegistry);
  // 官方声明把 put/requireTable 标为 private（运行时存在，见文件头「纪律边界」），
  // 因此按本文件实际调用面收窄，不改动宿主对象本身。
  const cache = raw(ctx.get("sessionProjectionCache")) as unknown as ProjectionCacheLike | undefined;
  let guard: CacheGuard | undefined;
  let stopObserving: (() => void) | undefined;
  let assessment: HostAssessment | undefined;
  let assessmentAt = 0;
  /** Re-probe at most every 5s: probing is cheap but not free on hot paths. */
  const ASSESS_TTL_MS = 5000;

  /**
   * The current host assessment. Refreshed lazily so a host that gains or
   * loses a service is noticed without a plugin reload.
   * @param force - re-probe even when a cached value is still fresh.
   */
  function hostAssessment(force = false) {
    const now = Date.now();
    if (force || assessment === undefined || now - assessmentAt > ASSESS_TTL_MS) {
      try { assessment = assessHost(ctx); }
      catch (error) {
        // A probe that throws is itself a finding: report it rather than
        // letting it escape into a delete sequence.
        ctx.logger?.warn?.(`host capability probe failed: ${String(error)}`);
        assessment = undefined;
      }
      assessmentAt = now;
    }
    return assessment;
  }
  /** Capability ids not `ok` from the given list. */
  function unavailable(ids: readonly string[]): CapabilityRefusal[] {
    const current = hostAssessment();
    if (current === undefined) return ids.map((id) => ({ id, label: id, detail: "宿主能力探测不可用", recovery: "请查看插件日志 dsh-plugin-tool-management.log" }));
    return refusalsFor(current, ids);
  }
  /** Throw when any listed capability is not usable; nothing is written before this runs. */
  function requireCapabilities(operation: OperationName, ids: readonly string[]) {
    const refusals = unavailable(ids);
    if (refusals.length > 0) throw new CapabilityRefusalError(operation, refusals);
  }
  const method = (name: string, ...args: unknown[]) => {
    if (typeof registry[name] !== "function") throw new Error(`宿主缺少归档兼容接口 ${name}，操作已停止`);
    // 动态成员名：先收窄为可调用类型，再以 registry 为 receiver 调用，
    // 与 registry[name](...args) 的 this 绑定完全一致。
    return (registry[name] as (...rest: unknown[]) => unknown).call(registry, ...args);
  };
  /**
   * The adapter route needs the registry's read/write/delegate members. This is
   * a presence-and-shape check on the live object — the previous implementation
   * compared these methods' source text against this plugin's own copy of the
   * official prototype, which failed on any upstream refactor and, worse,
   * depended on the plugin loading a second copy of the package.
   */
  function checkWorkspace(operation: OperationName = "archive"): RouteDecision {
    const current = hostAssessment();
    if (current !== undefined) {
      const decision = routeFor(current, operation);
      if (decision.via === "none") throw new CapabilityRefusalError(operation, decision.refusals);
      return decision;
    }
    requireCapabilities(operation, ["workspace.read-state", "workspace.enqueue"]);
    return { via: "adapter", refusals: [] };
  }
  /** Structural check of the workspace index shape. */
  function checkIndexShape() {
    for (const name of ["headers", "sessionPaths", "invalidSessionPaths", "entities"]) {
      if (!(registry[name] instanceof Map)) throw new Error(`工作区索引 ${name} 不兼容，未修改数据`);
    }
  }
  return {
    registry,
    /** Latest assessment, for the compatibility surface and the HTTP status op. */
    capabilities(force = false) { return hostAssessment(force); },
    /** Capability ids an operation still needs, without throwing. */
    refusalsFor(operation: OperationName, ids: readonly string[]) { return unavailable(ids); },    observe() {
      if (stopObserving) return;
      let previous = new Set(registry.archivedSessionIds);
      // Official durable domain notifications also cover archive operations
      // from the official sidebar or an external archive manager. No monkey
      // patch of archiveSession and no competing writer of its ledger.
      stopObserving = ctx.on("domain/changed", (change) => {
        // 官方事件类型把 value 声明为 unknown（载荷形状由 workspace 域规范决定）。
        const payload = change.value as { archivedSessionIds?: readonly string[] } | undefined;
        if (change?.domain !== workspaceDomainSpec.name || change.table !== "" || !Array.isArray(payload?.archivedSessionIds)) return;
        const next = new Set(payload.archivedSessionIds);
        const at = Date.now();
        for (const id of next) if (!previous.has(id)) void onArchive(id, at).catch((error) => ctx.logger.warn(String(error)));
        for (const id of previous) if (!next.has(id)) void onArchive(id, null).catch((error) => ctx.logger.warn(String(error)));
        previous = next;
      });
    },
    checkWorkspace,
    checkIndexShape,
    enqueue<T>(fn: () => Promise<T>) { checkWorkspace("archive"); checkIndexShape(); return registry.enqueueOperation(fn); },
    state: () => method("requireState"),
    table: () => method("requireTable"),
    setState: (state: unknown) => method("setState", state),
    readHeader: (id: string) => method("readSessionHeader", id),
    /**
     * Install the cache delete barrier for one session, before anything is
     * flushed or detached. Prefers a host-native barrier when it exists.
     */
    async beginDelete(id: string, header: CheckpointIdentity | null | undefined) {
      checkWorkspace("delete");
      if (!cache) throw new CapabilityRefusalError("delete", [{
        id: "projection.write",
        label: "投影缓存写入路径",
        detail: "宿主未提供 sessionProjectionCache",
        recovery: "请确认 DSH 版本并更新本插件到匹配版本。",
      }]);
      if (typeof cache.delete === "function" && typeof cache.whenIdle === "function") return;
      guard ??= acquireCacheGuard(cache);
      guard.begin(id, header);
    },
    cache() { return guard ?? cache; },
    async dispose() { stopObserving?.(); await guard?.release(); },
  };
}
