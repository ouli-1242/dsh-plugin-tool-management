import { symbols } from "@deepseek-ai/cordis";
import { workspaceDomainSpec } from "@deepseek-ai/dsh-workspace";
import { assessHost, routeFor, refusalsFor, CapabilityRefusalError } from "../compat/probe.js";

export { CapabilityRefusalError };

// No Service subclass, no ctx.provide(), no second storage-domain owner.
// The official API lacks unarchive and a cache deletion barrier, so this file
// adapts the gaps. WHICH parts of the host it may touch is decided by
// ../compat/probe.ts from live, observable facts (module identity, member
// presence, shapes, read-only behaviour), never from comparing source text:
// text equality only ever proved "same release", and it turned every harmless
// upstream refactor into a total feature outage.
const cacheGuards = new WeakMap();
const raw = (value) => value?.[symbols.original] ?? value;
const sameLifecycle = (a, b) => a && b && a.createdAt === b.createdAt && (a.cwd ?? null) === (b.cwd ?? null);

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
function acquireCacheGuard(cache) {
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
  const isBlocked = (id, identity) => blocked.has(id) && (blocked.get(id) === null || sameLifecycle(blocked.get(id), identity));
  function track(task) {
    pending.add(task);
    task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  }
  function serial(id, fn) {
    const task = (queues.get(id) ?? Promise.resolve()).then(fn);
    const settled = task.then(() => {}, () => {});
    queues.set(id, settled);
    settled.then(() => { if (queues.get(id) === settled) queues.delete(id); });
    return track(task);
  }
  const wrappers = {
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
export function requiredSessionCapabilities(hasLiveSession) {
  return hasLiveSession
    ? ["sessions.detach-live"]
    : ["sessions.cold-announce"];
}

export function createHistoryBridge(ctx, suppliedRegistry, onArchive) {
  // Cordis returns a fresh traceable method proxy on access. Compare and adapt
  // the original object, not proxies; calls retain the service owner's context.
  const registry = raw(suppliedRegistry);
  const cache = raw(ctx.get("sessionProjectionCache"));
  let guard;
  let stopObserving;
  let assessment;
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
  function unavailable(ids) {
    const current = hostAssessment();
    if (current === undefined) return ids.map((id) => ({ id, label: id, detail: "宿主能力探测不可用", recovery: "请查看插件日志 dsh-plugin-tool-management.log" }));
    return refusalsFor(current, ids);
  }
  /** Throw when any listed capability is not usable; nothing is written before this runs. */
  function requireCapabilities(operation, ids) {
    const refusals = unavailable(ids);
    if (refusals.length > 0) throw new CapabilityRefusalError(operation, refusals);
  }
  const method = (name, ...args) => {
    if (typeof registry[name] !== "function") throw new Error(`宿主缺少归档兼容接口 ${name}，操作已停止`);
    return registry[name](...args);
  };
  /**
   * The adapter route needs the registry's read/write/delegate members. This is
   * a presence-and-shape check on the live object — the previous implementation
   * compared these methods' source text against this plugin's own copy of the
   * official prototype, which failed on any upstream refactor and, worse,
   * depended on the plugin loading a second copy of the package.
   */
  function checkWorkspace(operation = "archive") {
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
    refusalsFor(operation, ids) { return unavailable(ids); },    observe() {
      if (stopObserving) return;
      let previous = new Set(registry.archivedSessionIds);
      // Official durable domain notifications also cover archive operations
      // from the official sidebar or an external archive manager. No monkey
      // patch of archiveSession and no competing writer of its ledger.
      stopObserving = ctx.on("domain/changed", (change) => {
        if (change?.domain !== workspaceDomainSpec.name || change.table !== "" || !Array.isArray(change.value?.archivedSessionIds)) return;
        const next = new Set(change.value.archivedSessionIds);
        const at = Date.now();
        for (const id of next) if (!previous.has(id)) void onArchive(id, at).catch((error) => ctx.logger.warn(String(error)));
        for (const id of previous) if (!next.has(id)) void onArchive(id, null).catch((error) => ctx.logger.warn(String(error)));
        previous = next;
      });
    },
    checkWorkspace,
    checkIndexShape,
    enqueue(fn) { checkWorkspace("archive"); checkIndexShape(); return registry.enqueueOperation(fn); },
    state: () => method("requireState"),
    table: () => method("requireTable"),
    setState: (state) => method("setState", state),
    readHeader: (id) => method("readSessionHeader", id),
    /**
     * Install the cache delete barrier for one session, before anything is
     * flushed or detached. Prefers a host-native barrier when it exists.
     */
    async beginDelete(id, header) {
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
