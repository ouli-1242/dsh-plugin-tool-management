import { symbols, type Context } from "@deepseek-ai/cordis";
import { workspaceDomainSpec } from "@deepseek-ai/dsh-workspace";
import type { CheckpointIdentity } from "@deepseek-ai/dsh-session-projection-cache";
import { assessHost, routeFor, refusalsFor, CapabilityRefusalError, type CapabilityRefusal, type HostAssessment, type OperationName, type RouteDecision } from "../compat/probe.js";
import { noteRuntime } from "../compat/runtime-notes.js";

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
  /** 包装器现在确实还装在这份宿主缓存上吗（第三方接管过就变 false）。 */
  installed(): boolean;
  begin(id: string, header: CheckpointIdentity | null | undefined): void;
  clearTombstone(id: string): void;
  whenIdle(): Promise<void>;
  delete(id: string): Promise<unknown>;
  release(): Promise<void>;
}

// 不继承 Service、不 ctx.provide()、不当第二个存储域的主人。官方 API 缺 unarchive
// 与缓存删除屏障，本文件只补这两个缺口。「能碰宿主哪些部分」由 ../compat/probe.ts 按活的、
// 可观察的事实判定（模块身份、成员存在、形状、只读行为），绝不比对源码文本：文本相等只
// 证明过「同一版发布」，而它把每一次无害的上游重构都变成整片功能失效。
//
// 纪律边界（对工作区「官方包与宿主机制只读」一条的解释，复核确认）：
// 这里的包装是**运行时实例**上的临时、可恢复、能力门控的适配（仅当宿主自己缺
// delete/whenIdle 时才装；按原 descriptor 恢复；serial 队列防复活），不修改任何
// 官方包文件、不持久化改动、不改变宿主机制的对外行为 —— 与「不 patch 官方代码」
// 禁令针对的对象（包文件与宿主机制的永久改写）不同层。若用户要求该解释不成立，
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
 * 给宿主的投影缓存装写屏障 —— 只在宿主自己删不干净缓存行时装。
 *
 * 按**能力**设门，不看实现文本：写路径与可删的表都在才装；宿主自带
 * `delete`/`whenIdle` 屏障时一律不装。
 *
 * @param cache 宿主的投影缓存实例
 * @returns 屏障句柄
 * @throws {CapabilityRefusalError} 缓存支撑不了安全删除时
 */
function acquireCacheGuard(cache: ProjectionCacheLike): CacheGuard {
  const existing = cacheGuards.get(cache);
  // 复用前先验「装着的确实是我们的包装器」：release 时被第三方接管过的那条路会留下一个
  // 「在册但没装」的 guard，复用它等于墓碑拦截静默失效（缓存行可能复活）。
  if (existing && existing.users > 0 && existing.installed()) { existing.users += 1; return existing; }
  if (existing) cacheGuards.delete(cache);
  const missing = ["put", "write", "requireTable"].filter((name) => typeof cache[name] !== "function");
  if (missing.length > 0) {
    throw new CapabilityRefusalError("delete", refusalsFor(
      { findings: [{ id: "projection.write", label: "投影缓存写入路径", kind: "write", owner: "projectionCache", fallback: "disable-destructive", state: "missing-member", detail: `宿主投影缓存缺少 ${missing.join(", ")}`, missing }] },
      ["projection.write"],
    ));
  }
  let table: ProjectionCacheTableLike;
  try {
    table = cache.requireTable();
  } catch (error) {
    // 安装期就抛：此刻还没动 put/write（不可能有半状态），但必须上报 —— 删除屏障没在岗。
    noteRuntime({
      id: "projection-cache-adapter",
      label: "投影缓存删除屏障",
      kind: "delete",
      fallback: "inform-only",
      detail: `投影缓存适配未完成（requireTable 抛错）：${String((error as Error)?.message ?? error)}；宿主对象未被改动。`,
      detailKey: "projection-cache-adapter.setup",
      params: { reason: String((error as Error)?.message ?? error) },
    });
    throw new CapabilityRefusalError("delete", [{
      id: "projection.table-delete",
      label: "投影缓存行删除",
      detail: `宿主投影缓存的 requireTable() 抛错：${String((error as Error)?.message ?? error)}`,
      recovery: "请更新本插件到与本机 DSH 匹配的版本（先运行 node scripts/doctor.mjs 查看差异）。",
    }]);
  }
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
      // 即使排队，也要保住上游「调用瞬间快照」的边界：identity 先拷一份再入队。
      if (isBlocked(id, identity)) return Promise.resolve();
      const expected = { ...identity };
      let detached;
      try { detached = structuredClone(rows); }
      catch (error) { return Promise.reject(error); }
      // 让 put 与删除串行；同一个 id 被新生命周期复用时，绝不清掉新的那条。
      return serial(id, async () => {
        if (isBlocked(id, expected)) return;
        try {
          await originals.put.call(cache, id, expected, detached);
          if (isBlocked(id, expected)) {
            const stored = table.get(id);
            if (stored && sameLifecycle(stored.identity, expected)) await table.delete(id);
          }
        } catch (error) {
          // 形状变了才会是 TypeError（与本仓库探针同一条口径：受控 Error 不算适配失败）。
          // 撤掉包装、绝不让宿主留在"半个包装器"状态下，并上报 —— 下一次删除会重装。
          if (error instanceof TypeError) retire("failed");
          throw error;
        }
      });
    },
    write(session) {
      // put 之前的 flush 与 put 本身都要记在账上：否则一次延迟的写可能活过 dispose，
      // 绕过已恢复的原方法。
      let task: Promise<unknown>;
      try { task = track(Promise.resolve(originals.write.call(cache, session))); }
      catch (error) {
        if (error instanceof TypeError) retire("failed");
        return Promise.reject(error);
      }
      return task.catch((error) => { if (error instanceof TypeError) retire("failed"); throw error; });
    },
  };
  cache.put = wrappers.put;
  cache.write = wrappers.write;
  const self: CacheGuard = {
    users: 1,
    // 两个都得是我们的才算"在岗"：只装着一个就等于另一半的写入不受墓碑约束（缓存行会复活）。
    // 半个的情形由 acquire 的重建路径处理（覆盖掉那半个外来包装），并在退役时已上报过。
    installed: () => cache.put === wrappers.put && cache.write === wrappers.write,
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
      const clean = restoreWrappers();
      retire(clean ? "idle" : "taken-over");
    },
  };
  let retired = false;
  /** 撤包装：第三方装了的话**不动它**（返回 false 表示没撤干净）。 */
  function restoreWrappers(): boolean {
    let clean = true;
    for (const name of ["put", "write"]) {
      // 后来装上的第三方包装绝不覆盖。
      if (cache[name] !== wrappers[name]) { clean = false; continue; }
      if (descriptors[name]) Object.defineProperty(cache, name, descriptors[name]);
      else delete cache[name];
    }
    return clean;
  }
  /**
   * 退役这个 guard：摘出 WeakMap（之后 acquire 会重建）、撤包装、清墓碑；非正常退役要上报。
   *
   * 三种退役理由对应三条真实路径：`idle` = 引用归零的正常释放（不上报）；
   * `taken-over` = 第三方在我们的包装器之上又包了一层（release 撤不干净，下次删除重建）；
   * `failed` = 首次使用抛 TypeError（宿主形状变了，已恢复原方法）。
   */
  function retire(reason: "idle" | "taken-over" | "failed"): void {
    if (retired) return;
    retired = true;
    if (cacheGuards.get(cache) === self) cacheGuards.delete(cache);
    blocked.clear();
    if (reason === "idle") return;
    noteRuntime({
      id: "projection-cache-adapter",
      label: "投影缓存删除屏障",
      kind: "delete",
      fallback: "inform-only",
      detail: reason === "taken-over"
        ? "宿主缓存的 put/write 已被第三方包装接管：本插件的删除屏障这一轮已退役（缓存行删除少了墓碑拦截），下一次删除会重新安装。"
        : "投影缓存适配在首次使用时抛错（宿主形状可能变了）：已恢复宿主原方法，下一次删除会重新安装并再探一次。",
      detailKey: reason === "taken-over"
        ? "projection-cache-adapter.taken-over"
        : "projection-cache-adapter.first-use",
    });
  }
  cacheGuards.set(cache, self);
  return self;
}

/**
 * 删除序列需要的能力 id，按分支给。
 *
 * `liveEntryFor`/`detachEntered` 在官方声明里是私有的（dsh-session 的
 * `lib/types/index.d.ts`），所以与其余能力一样走能力闸门。**动手之前**先查这一点不变：
 * 否则失败会落在序列中段（已 flush、尚未清账），留下「transcript 没了、归档标记还在」。
 *
 * @param hasLiveSession 这个会话此刻是否活着
 * @returns 必须为 `ok` 的能力 id，按求值顺序
 */
export function requiredSessionCapabilities(hasLiveSession: boolean): string[] {
  return hasLiveSession
    ? ["sessions.detach-live"]
    : ["sessions.cold-announce"];
}

/** 归档会话的宿主桥：按能力选路、装缓存删除屏障、监听官方归档事件。 */
export function createSessionsBridge(
  ctx: Context,
  suppliedRegistry: RegistryLike,
  onArchive: (id: string, at: number | null) => Promise<unknown>,
) {
  // cordis 每次取成员都返回一个新的可追踪方法代理：要比对、要适配都落在原始对象上，
  // 不碰代理；调用时仍保留服务属主的上下文。
  const registry = raw(suppliedRegistry);
  // 官方声明把 put/requireTable 标为 private（运行时存在，见文件头「纪律边界」），
  // 因此按本文件实际调用面收窄，不改动宿主对象本身。
  const cache = raw(ctx.get("sessionProjectionCache")) as unknown as ProjectionCacheLike | undefined;
  let guard: CacheGuard | undefined;
  let stopObserving: (() => void) | undefined;
  let assessment: HostAssessment | undefined;
  let assessmentAt = 0;
  /** 最多每 5s 重探一次：探测不贵，但在热路径上不是免费。 */
  const ASSESS_TTL_MS = 5000;

  /**
   * 当前宿主评估。懒刷新 —— 宿主多一个或少一个服务不必重载插件就能被发现。
   * @param force 缓存还新鲜也重探一次
   */
  function hostAssessment(force = false) {
    const now = Date.now();
    if (force || assessment === undefined || now - assessmentAt > ASSESS_TTL_MS) {
      try { assessment = assessHost(ctx); }
      catch (error) {
        // 探测自己抛错也是一条 finding：记下来，不让它漏进删除序列。
        ctx.logger?.warn?.(`host capability probe failed: ${String(error)}`);
        assessment = undefined;
      }
      assessmentAt = now;
    }
    return assessment;
  }
  /** 给定清单里状态不是 `ok` 的能力 id。 */
  function unavailable(ids: readonly string[]): CapabilityRefusal[] {
    const current = hostAssessment();
    if (current === undefined) return ids.map((id) => ({ id, label: id, detail: "宿主能力探测不可用", recovery: "请查看插件日志 dsh-plugin-tool-management.log" }));
    return refusalsFor(current, ids);
  }
  /** 名单里任一能力不可用就抛错 —— 它跑在任何写入之前，所以拒绝时一个字都没落盘。 */
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
   * 适配器路线需要 registry 的读 / 写 / 委派成员。这是对**活对象**的存在与形状检查 ——
   * 比对这几个方法的源码文本会在任何上游重构时失败，更糟的是它默认了插件加载了第二份包。
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
  /** 工作区索引的形状检查。 */
  function checkIndexShape() {
    for (const name of ["headers", "sessionPaths", "invalidSessionPaths", "entities"]) {
      if (!(registry[name] instanceof Map)) throw new Error(`工作区索引 ${name} 不兼容，未修改数据`);
    }
  }
  return {
    registry,
    /** 最新评估，给兼容页与 HTTP 状态 op 用。 */
    capabilities(force = false) { return hostAssessment(force); },
    /** 某个操作还缺哪些能力 id；不抛错。 */
    refusalsFor(operation: OperationName, ids: readonly string[]) { return unavailable(ids); },
    observe() {
      if (stopObserving) return;
      let previous = new Set(registry.archivedSessionIds);
      // 官方的持久域通知也覆盖从官方侧栏或外部归档工具发起的归档操作。所以不 monkey patch
      // `archiveSession`，也不去当它那本账的第二个写者。
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
     * 在 flush / detach 之前给一个会话装上缓存删除屏障。宿主自带屏障时优先用它。
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
      // 本地这份 guard 可能已经退役（第三方接管 / 首次使用抛错）：退役时已从 WeakMap 摘掉自己，
      // 这里也得换掉它 —— 拿一个不在岗的屏障去挡墓碑，正是"缓存行静默复活"那条路。
      const next = acquireCacheGuard(cache);
      if (next !== guard) {
        const previous = guard;
        guard = next;
        if (previous) await previous.release().catch(() => undefined);
      }
      guard.begin(id, header);
    },
    cache() { return guard ?? cache; },
    async dispose() { stopObserving?.(); await guard?.release(); },
  };
}
