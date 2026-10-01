// manager 状态层：本插件对技能来源的**记账**——状态文档的形状与归一、读写与失败回落、
// 生效启停策略的解析，以及喂给它的来源扫描与同名去重（entryOf / scanEntries / markWinners）。
//
// 声明从 skills/core.ts 按行号区间搬来，正文一字未改（唯一的容差是 `--export-top-level`
// 加的 `export ` 前缀，moved-verify 逐字对拍）。
//
// 为什么这三件事是一层：`effectiveSkillPolicy` 读的、`writeManagerState` 写的、
// `scanDeduplicatedRoots` 喂的都是同一份进程内 singleton `state`（下面那个 const）。
// 拆成两层就得让一层去引另一层的私有状态，等于没拆。
//
// singleton 换了住户没换 semantics：`state` 仍是**每进程一份**的模块级 const，
// core.ts 与其余各域引到的都是同一个对象 —— 与搬走前逐字相同的引用，不是拷贝。
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { isSameOrDescendant } from "../paths.js";
import { parseSkillDoc, unquote } from "./frontmatter.js";
import { discoverReadonlyEntries, validDiscoveryName } from "./readonly-discovery.js";
import {
  codedError,
  entryPath,
  lstatOrNull,
  MAX_ENTRY_NAME_LENGTH,
  pathIdentity,
  renameWithRetry,
} from "./core-util.js";
import {
  customRootKey,
  isDefaultSkillSource,
  managerHomePath,
  managerStatePath,
  projectRoots,
  resolvedPath,
  rootDefinition,
  userRoots,
} from "./skill-roots.js";
import { listTrash } from "./skill-trash.js";
import { KEBAB_RE } from "./upload-pipeline.js";
import type {
  CustomRoot,
  ManagerState,
  ManagerStateDocument,
  ManagerStateReadResult,
  MarkWinnersOptions,
  RootInput,
  RootedEntry,
  ScanOptions,
  ScanResult,
  SkillDiagnostic,
  SkillDoc,
  SkillEntry,
  SkillPolicy,
  SkillSource,
  SkillSummary,
  SkillWarning,
  StateItem,
  StateResult,
  StateSkill,
} from "./core-types.js";

export const PROJECT_ROOT_KEY_RE = /^project-(?:dsh|agents):[a-f0-9]{16}$/;
export const CUSTOM_ROOT_KEY_RE = /^custom-[a-f0-9]{16}$/;
export function customRootsFromState(stateValue: unknown): SkillSource[] {
  const state = stateValue as { customRoots?: unknown } | null | undefined;
  const list =
    state && Array.isArray(state.customRoots) ? state.customRoots : [];
  const out: SkillSource[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const path = typeof item.path === "string" ? item.path : "";
    const key = typeof item.key === "string" ? item.key : "";
    if (!isAbsolute(path) || !CUSTOM_ROOT_KEY_RE.test(key)) continue;
    if (key !== customRootKey(path)) continue;
    out.push({
      key,
      path,
      label:
        typeof item.label === "string" && item.label.trim()
          ? item.label.trim().slice(0, 64)
          : "自定义目录",
      // 用户加进来的来源（相对「按约定发现」的 dsh / hub / agents / codex / claude）：
      // 界面据此决定要不要给「永久删除」——只有自定义来源能真正从插件里删掉记录。
      custom: true,
      mutable: false,
      toggleable: true,
      native: false,
      scope: "user",
      rank: 600,
    });
  }
  return out;
}
export async function isInsideResolvedRoot(
  rootReal: string,
  path: string,
): Promise<boolean> {
  return isSameOrDescendant(rootReal, await resolvedPath(path));
}
export async function writeFileAtomically(
  path: string,
  content: string,
): Promise<void> {
  const temp = join(
    dirname(path),
    `.${basename(path)}.dssm-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temp, content, "utf8");
    // Windows 上目标文件会被杀软/索引器短暂占住（EPERM/EACCES/EBUSY）——
    // 场景模式进出时这里写的是技能来源/策略状态，rename 被撞 = 运行时已切、
    // 状态没落盘。与 memories-index.json 同一处理：重试瞬时占用，全失败才抛。
    await renameWithRetry(temp, path);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
export function parseBoolValue(raw: unknown): boolean | undefined {
  const v = unquote(raw).trim().toLowerCase();
  if (v === "true" || v === "yes" || v === "on" || v === "1") return true;
  if (v === "false" || v === "no" || v === "off" || v === "0") return false;
  return undefined;
}
export function entryOf(
  name: string,
  kind: "bundle" | "flat",
  docPath: string,
  doc: Pick<SkillDoc, "map" | "hasFrontmatter">,
): SkillSummary {
  const declaredName = doc.map.name !== undefined ? unquote(doc.map.name) : "";
  const description =
    doc.map.description !== undefined ? unquote(doc.map.description) : "";
  const modelValue = parseBoolValue(doc.map["disable-model-invocation"]);
  const userValue = parseBoolValue(doc.map["user-invocable"]);
  const modelDisabled = modelValue === true;
  const userDisabled = userValue === false;
  const invocationPolicyValid =
    (doc.map["disable-model-invocation"] === undefined ||
      modelValue !== undefined) &&
    (doc.map["user-invocable"] === undefined || userValue !== undefined);
  const diagnostics: SkillDiagnostic[] = [];
  if (!doc.hasFrontmatter)
    diagnostics.push({
      level: "error",
      code: "diagnostic.frontmatter.missing",
    });
  if (doc.hasFrontmatter && !declaredName)
    diagnostics.push({ level: "error", code: "diagnostic.name.missing" });
  else if (declaredName && !KEBAB_RE.test(declaredName))
    diagnostics.push({
      level: "error",
      code: "diagnostic.name.invalid",
      params: { name: declaredName },
    });
  if (doc.hasFrontmatter && !description)
    diagnostics.push({
      level: "error",
      code: "diagnostic.description.missing",
    });
  if (!invocationPolicyValid)
    diagnostics.push({ level: "error", code: "diagnostic.invocation.invalid" });
  return {
    name,
    declaredName,
    kind,
    docPath,
    description,
    modelInvocable: !modelDisabled,
    userInvocable: !userDisabled,
    invocationPolicyValid,
    hasFrontmatter: doc.hasFrontmatter,
    // 调用策略值异常可以由 manager 本地策略覆盖；结构本身合法即可加载。
    loadable:
      doc.hasFrontmatter && KEBAB_RE.test(declaredName) && description !== "",
    diagnostics,
  };
}
export async function scanEntries(
  root: RootInput,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const definition = rootDefinition(root);
  if (definition && !definition.mutable) {
    const discovered = await discoverReadonlyEntries(definition.path);
    // metadataOnly 时条目的摘要字段由调用方按需读取（见 visibleEntryForRoot）。
    if (options.metadataOnly) return discovered as unknown as ScanResult;
    const entries: SkillEntry[] = [];
    for (const entry of discovered.entries) {
      try {
        entries.push({
          ...entryOf(
            entry.name,
            entry.kind,
            entry.docPath,
            parseSkillDoc(await fs.readFile(entry.realDocPath, "utf8")),
          ),
          ...entry,
        });
      } catch {
        /* 忽略已失效或不可读技能。 */
      }
    }
    return { ...discovered, entries };
  }
  // 传入 definition 对象时取它的 path；其余情况按 key 字符串处理。
  root = definition ? definition.path : (root as string);
  const rootStat = await lstatOrNull(resolve(root));
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink())
    return { exists: false, entries: [] };
  let items;
  try {
    items = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { exists: false, entries: [] };
  }
  const byName = new Map<string, SkillEntry>();
  const rootReal = await resolvedPath(root);
  for (const it of items) {
    try {
      if (it.isSymbolicLink()) continue;
      if (it.isDirectory() && entryPath(root, it.name) !== null) {
        const docPath = join(root, it.name, "SKILL.md");
        const st = await lstatOrNull(docPath);
        if (
          !st ||
          !st.isFile() ||
          st.isSymbolicLink() ||
          !(await isInsideResolvedRoot(rootReal, docPath))
        )
          continue;
        const doc = options.metadataOnly
          ? { map: {}, hasFrontmatter: false }
          : parseSkillDoc(await fs.readFile(docPath, "utf8"));
        byName.set(it.name, {
          ...entryOf(it.name, "bundle", docPath, doc),
          entryPath: join(root, it.name),
          realDocPath: await fs.realpath(docPath),
          realEntryPath: await fs.realpath(join(root, it.name)),
          linked: false,
        });
      } else if (
        it.isFile() &&
        it.name.toLowerCase().endsWith(".md") &&
        it.name.toLowerCase() !== "skill.md" &&
        entryPath(root, it.name.slice(0, -3)) !== null
      ) {
        const skillName = it.name.slice(0, -3);
        if (byName.has(skillName)) continue;
        const docPath = join(root, it.name);
        if (!(await isInsideResolvedRoot(rootReal, docPath))) continue;
        const doc = options.metadataOnly
          ? { map: {}, hasFrontmatter: false }
          : parseSkillDoc(await fs.readFile(docPath, "utf8"));
        const realDocPath = await fs.realpath(docPath);
        byName.set(skillName, {
          ...entryOf(skillName, "flat", docPath, doc),
          entryPath: docPath,
          realDocPath,
          realEntryPath: realDocPath,
          linked: false,
        });
      }
    } catch {
      /* 跳过不可读条目 */
    }
  }
  const entries: SkillEntry[] = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return { exists: true, entries };
}
export async function scanDeduplicatedRoots(
  roots: SkillSource[] = userRoots(),
  options: ScanOptions = {},
): Promise<Map<string, ScanResult>> {
  const results = await Promise.all(
    roots.map(
      async (root): Promise<[SkillSource, ScanResult]> => [
        root,
        await scanEntries(root, options),
      ],
    ),
  );
  const scans = new Map<string, ScanResult>();
  const groups = new Map<string, Array<{ root: SkillSource; entry: SkillEntry }>>();
  for (const [root, scan] of results) {
    scans.set(root.key, scan);
    for (const entry of scan.entries) {
      const identity = pathIdentity(
        entry.realEntryPath || entry.entryPath || entry.docPath,
      );
      const group = groups.get(identity) || [];
      group.push({ root, entry });
      groups.set(identity, group);
    }
  }
  const winners = new Set<SkillEntry>();
  for (const group of groups.values()) {
    group.sort(
      (left, right) =>
        Number(left.entry.linked) - Number(right.entry.linked) ||
        left.root.rank - right.root.rank,
    );
    const winner = group[0];
    winner.entry.providerRank = Math.min(
      ...group.map((item) => item.root.rank),
    );
    winner.entry.policyAliases = group.map((item) => ({
      rootKey: item.root.key,
      name: item.entry.name,
    }));
    winners.add(winner.entry);
  }
  for (const scan of scans.values()) {
    scan.entries = scan.entries.filter((entry) => winners.has(entry));
  }
  return scans;
}
export function defaultManagerState(): ManagerState {
  const sources = Object.create(null);
  const disabledSkills = Object.create(null);
  const enabledSkills = Object.create(null);
  for (const root of userRoots()) {
    // 默认来源（dsh / hub）没有来源开关，所以不落进 sources 表 —— 它们永远「读取」。
    // 旧版本可能往这里写过 hub 的 false，normalizeManagerState 会顺手丢掉。
    if (!isDefaultSkillSource(root.key)) sources[root.key] = true;
    disabledSkills[root.key] = [];
    enabledSkills[root.key] = [];
  }
  return {
    version: 1,
    sources,
    disabledSkills,
    enabledSkills,
    customRoots: [],
    // 同名技能「首选来源」：技能名 → 来源 key。缺键 = 按来源 rank 取最高优先级者。
    preferredSkills: Object.create(null),
    // 用户从技能页「移除」的来源：插件**不再读取**这些目录（技能不出现在列表里，
    // 也不参与 provider 候选）。与「停用来源」不同——停用仍列出技能、只是不可调用。
    // 源文件一个字节都不动；清空这个数组即可恢复。
    removedSources: [],
  };
}
export function validStateSkillName(name: unknown): boolean {
  return validDiscoveryName(name);
}
export function validPreferredSkillName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_ENTRY_NAME_LENGTH &&
    !name.includes("\0") &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}
export function failClosedManagerState(): ManagerState {
  const state = defaultManagerState();
  for (const key of Object.keys(state.sources)) state.sources[key] = false;
  return state;
}
export function validPolicyLists(value: unknown, allowMissing = false): boolean {
  if (value === undefined && allowMissing) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [key, list] of Object.entries(value)) {
    if (
      !userRoots().some((root) => root.key === key) &&
      !PROJECT_ROOT_KEY_RE.test(key)
    )
      continue;
    if (!Array.isArray(list) || list.some((name) => !validStateSkillName(name)))
      return false;
  }
  return true;
}
export function validManagerStateDocument(value: ManagerStateDocument): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1
  )
    return false;
  if (
    !value.sources ||
    typeof value.sources !== "object" ||
    Array.isArray(value.sources)
  )
    return false;
  if (
    !validPolicyLists(value.disabledSkills) ||
    !validPolicyLists(value.enabledSkills, true)
  )
    return false;
  // 自定义来源列表：可选字段；容器必须是数组（条目级合法性由 normalize 逐条裁剪）。
  if (value.customRoots !== undefined && !Array.isArray(value.customRoots))
    return false;
  // 已移除的来源：可选字段；数组里的每一项必须能当来源 key 用。
  if (value.removedSources !== undefined) {
    if (
      !Array.isArray(value.removedSources) ||
      value.removedSources.some(
        (key) => typeof key !== "string" || key.length === 0 || key.length > 128,
      )
    )
      return false;
  }
  // 同名首选表：可选字段；只校验容器与值类型，键值逐条在 normalize 里裁剪（见 validPreferredSkillName）。
  if (value.preferredSkills !== undefined) {
    if (
      !value.preferredSkills ||
      typeof value.preferredSkills !== "object" ||
      Array.isArray(value.preferredSkills)
    )
      return false;
    for (const key of Object.values(value.preferredSkills))
      if (typeof key !== "string") return false;
  }
  for (const root of userRoots()) {
    if (isDefaultSkillSource(root.key)) continue;
    if (typeof value.sources[root.key] !== "boolean") return false;
    const list = value.disabledSkills[root.key];
    if (!Array.isArray(list) || list.some((name) => !validStateSkillName(name)))
      return false;
  }
  const enabledSkills = value.enabledSkills || ({} as Record<string, string[]>);
  for (const key of new Set([
    ...Object.keys(value.disabledSkills),
    ...Object.keys(enabledSkills),
  ])) {
    const disabled = new Set(value.disabledSkills[key] || []);
    if ((enabledSkills[key] || []).some((name) => disabled.has(name)))
      return false;
  }
  return true;
}
export function normalizeManagerState(value: ManagerStateDocument): ManagerState {
  const normalized = defaultManagerState();
  if (!value || typeof value !== "object" || Array.isArray(value))
    return normalized;
  // 自定义来源先归一，其 sources/policy 键才有归属。
  normalized.customRoots = normalizeCustomRoots(value.customRoots);
  const customKeys = new Set(normalized.customRoots.map((root) => root.key));
  for (const root of userRoots()) {
    // 默认来源不接收 sources 标志：旧版本写过的 `sources.hub = false` 在这里被丢弃，
    // 于是「曾经把 hub 停用掉」的用户升级后自动回到必须读取的状态（技能不丢，只是策略位作废）。
    if (
      !isDefaultSkillSource(root.key) &&
      value.sources &&
      typeof value.sources[root.key] === "boolean"
    )
      normalized.sources[root.key] = value.sources[root.key];
    const list = value.disabledSkills && value.disabledSkills[root.key];
    if (Array.isArray(list))
      normalized.disabledSkills[root.key] = [
        ...new Set(list.filter((name) => validStateSkillName(name))),
      ].sort();
    const enabled = value.enabledSkills && value.enabledSkills[root.key];
    if (Array.isArray(enabled))
      normalized.enabledSkills[root.key] = [
        ...new Set(enabled.filter((name) => validStateSkillName(name))),
      ].sort();
  }
  if (value.sources && typeof value.sources === "object" && !Array.isArray(value.sources)) {
    for (const [key, flag] of Object.entries(value.sources)) {
      if (customKeys.has(key) && typeof flag === "boolean")
        normalized.sources[key] = flag;
    }
  }
  for (const field of ["disabledSkills", "enabledSkills"] as const) {
    const source = value[field];
    if (source && typeof source === "object" && !Array.isArray(source)) {
      for (const [key, list] of Object.entries(source)) {
        if (!PROJECT_ROOT_KEY_RE.test(key) && !customKeys.has(key)) continue;
        if (!Array.isArray(list)) continue;
        normalized[field][key] = [
          ...new Set(list.filter(validStateSkillName)),
        ].sort();
      }
    }
  }
  // 同名首选表：键必须是技能声明名、值必须指向一个已知来源（用户级 / 自定义 / 项目级），
  // 否则丢弃该条（源目录被移除后残留的首选会自然失效）。
  const preferred = value.preferredSkills;
  if (preferred && typeof preferred === "object" && !Array.isArray(preferred)) {
    for (const [name, rootKey] of Object.entries(preferred)) {
      if (!validPreferredSkillName(name) || typeof rootKey !== "string") continue;
      if (
        !userRoots().some((root) => root.key === rootKey) &&
        !customKeys.has(rootKey) &&
        !PROJECT_ROOT_KEY_RE.test(rootKey)
      )
        continue;
      normalized.preferredSkills[name] = rootKey;
    }
  }
  // 已移除的来源：只保留「确实是已知来源 key」的条目，其余丢弃（避免脏键让整份状态非法）。
  {
    const raw = Array.isArray(value.removedSources) ? value.removedSources : [];
    const known = new Set([
      ...userRoots().map((root) => root.key),
      ...customKeys,
    ]);
    normalized.removedSources = [
      ...new Set(
        raw.filter(
          (key) =>
            typeof key === "string" &&
            known.has(key) &&
            !isDefaultSkillSource(key),
        ),
      ),
    ].sort();
  }
  return normalized;
}
export function normalizeCustomRoots(value: unknown): CustomRoot[] {
  if (!Array.isArray(value)) return [];
  const out: CustomRoot[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const path = typeof item.path === "string" ? item.path : "";
    const key = typeof item.key === "string" ? item.key : "";
    if (!isAbsolute(path) || !CUSTOM_ROOT_KEY_RE.test(key)) continue;
    if (key !== customRootKey(path) || seen.has(key)) continue;
    seen.add(key);
    out.push(
      typeof item.label === "string" && item.label.trim()
        ? { key, path, label: item.label.trim().slice(0, 64) }
        : { key, path },
    );
  }
  return out;
}
export async function readManagerState(): Promise<ManagerStateReadResult> {
  try {
    const raw = await fs.readFile(managerStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    // 版本号在归一化时不会被保留（恒为 1），所以要在解析结果上直接判：
    // 缺失按 1 处理（更早的文档没有这个字段），存在但不是 1 才判非法。
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && parsed.version !== undefined && parsed.version !== 1)
      throw codedError("invalid manager state schema", "error.state.invalid");
    // 结构守卫：字段**可以缺**（旧文档），但**一旦存在就必须形状正确**。
    // 少了这道守卫，归一化会把「类型写错」当成「键缺失」一起补默认值——于是 `sources: []`
    // 或 `disabledSkills: { dsh: "x" }` 这种真损坏反而被自愈放行，静默丢掉文件里的策略。
    // 契约：**缺键自愈（我们后来加过的东西），类型错必须报错。**
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const field of ["sources", "disabledSkills", "enabledSkills"]) {
        const value = parsed[field];
        if (value === undefined) continue;
        if (value === null || typeof value !== "object" || Array.isArray(value))
          throw codedError("invalid manager state schema", "error.state.invalid");
        // 策略表的每个桶必须是数组（条目级合法性仍由 normalize 逐条裁剪）。
        if (field === "disabledSkills" || field === "enabledSkills") {
          for (const bucket of Object.values(value))
            if (!Array.isArray(bucket))
              throw codedError("invalid manager state schema", "error.state.invalid");
        }
      }
    }
    const normalized = normalizeManagerState(parsed);
    if (!validManagerStateDocument(normalized))
      throw codedError("invalid manager state schema", "error.state.invalid");
    return {
      state: normalized,
      warning: null,
      writable: true,
    };
  } catch (error: any) {
    // 系统异常按可选 code 读取，保持既有 ENOENT 判定。
    if (error && error.code === "ENOENT")
      return { state: defaultManagerState(), warning: null, writable: true };
    return {
      state: failClosedManagerState(),
      writable: false,
      warning: {
        code: "warning.state.invalid",
        params: { path: managerStatePath() },
        error: `技能管理器状态文件不可读，所有技能已安全停用且状态写入已锁定: ${managerStatePath()}`,
      },
    };
  }
}
export async function writeManagerState(value: ManagerState): Promise<void> {
  await fs.mkdir(managerHomePath(), { recursive: true });
  await writeFileAtomically(
    managerStatePath(),
    `${JSON.stringify(normalizeManagerState(value), null, 2)}\n`,
  );
}
export function managerSkillOverride(
  policy: ManagerState,
  rootKey: string,
  name: string,
  policyAliases: { rootKey: string; name: string }[] = [],
): boolean | undefined {
  if ((policy.enabledSkills[rootKey] || []).includes(name)) return true;
  if ((policy.disabledSkills[rootKey] || []).includes(name)) return false;
  let inheritedEnable = false;
  for (const alias of policyAliases) {
    if (alias.rootKey === rootKey && alias.name === name) continue;
    if ((policy.disabledSkills[alias.rootKey] || []).includes(alias.name))
      return false;
    if ((policy.enabledSkills[alias.rootKey] || []).includes(alias.name))
      inheritedEnable = true;
  }
  if (inheritedEnable) return true;
  return undefined;
}
export function effectiveSkillPolicy(
  policyResult: ManagerStateReadResult,
  root: SkillSource,
  entry: SkillEntry,
): SkillPolicy {
  const override = managerSkillOverride(
    policyResult.state,
    root.key,
    entry.name,
    entry.policyAliases,
  );
  const sourceEnabled =
    isDefaultSkillSource(root) ||
    root.scope === "project" ||
    policyResult.state.sources[root.key] !== false;
  if (policyResult.writable === false || !sourceEnabled || override === false) {
    return {
      override,
      sourceEnabled,
      modelInvocable: false,
      userInvocable: false,
      enabled: false,
    };
  }
  if (override === true) {
    return {
      override,
      sourceEnabled,
      modelInvocable: true,
      userInvocable: true,
      enabled: true,
    };
  }
  const modelInvocable = entry.invocationPolicyValid && entry.modelInvocable;
  const userInvocable = entry.invocationPolicyValid && entry.userInvocable;
  return {
    override,
    sourceEnabled,
    modelInvocable,
    userInvocable,
    enabled: modelInvocable && userInvocable,
  };
}
export function canonicalSkillName(item: RootedEntry): string {
  return item.entry.declaredName || item.entry.name;
}
export function groupLoadableSkillsByName<T extends RootedEntry>(
  items: T[],
  preferred?: Record<string, string> | null,
): Map<string, T[]> {
  const preferredFor = (item: RootedEntry) => {
    if (!preferred) return null;
    const key = preferred[canonicalSkillName(item)];
    return typeof key === "string" ? key : null;
  };
  const ordered = [...items].sort((a, b) => {
    const rankA = preferredFor(a) === a.root.key ? 0 : 1;
    const rankB = preferredFor(b) === b.root.key ? 0 : 1;
    if (rankA !== rankB) return rankA - rankB;
    return a.root.rank - b.root.rank;
  });
  const groups = new Map<string, T[]>();
  for (const item of ordered) {
    if (!item.entry.loadable) continue;
    const name = canonicalSkillName(item);
    const group = groups.get(name) || [];
    group.push(item);
    groups.set(name, group);
  }
  return groups;
}
export function markWinners(
  items: StateItem[],
  options: MarkWinnersOptions = {},
): Map<string, StateItem> {
  const winners = new Map<string, StateItem>();
  const preferred = options.preferred;
  for (const [
    canonicalName,
    [winner, ...shadowed],
  ] of groupLoadableSkillsByName(items, preferred)) {
    winners.set(canonicalName, winner);
    // `preferred` = 「这份显式选择**记录在案**且它确实赢了同名之争」，**不等于它正在生效**：
    // 首选来源自己停用时它照样赢（停用不参与选赢家），此时 `view.enabled === false`，
    // 而其余副本拿到 `shadowedBy.enabled === false` —— 界面据此说「两份都不生效」。
    // 这里仍要打上 preferred，否则界面拿不到「取消首选」那颗按钮，用户就没法撤销这次选择。
    if (preferred && preferred[canonicalName] === winner.root.key)
      winner.view.preferred = true;
    if (options.markShadowed !== false) {
      // `enabled` 传赢家的启用状态：界面靠它区分「另一份在跑」与「两份都不生效」。
      // 少了这个字段，被覆盖的一行只能说「同名技能 X 正在生效」—— 而 X 停用时那是假话。
      const winnerEnabled = winner.policy.enabled === true;
      for (const item of shadowed)
        item.view.shadowedBy = {
          root: winner.root.key,
          name: winner.entry.name,
          enabled: winnerEnabled,
        };
    }
    if (options.markWinner !== false) winner.view.winner = true;
    winner.view.enabled = winner.policy.enabled;
    winner.view.canonicalName = canonicalName;
  }
  return winners;
}
export async function state(
  options: { projectCwds?: string[] } = {},
): Promise<StateResult> {
  const policyResult = await readManagerState();
  const removedKeys = new Set<string>(
    Array.isArray(policyResult.state.removedSources)
      ? policyResult.state.removedSources
      : [],
  );
  // 已移除的来源仍然出现在 roots 里（界面要能显示「已移除」并允许恢复），但**不扫描**：
  // 技能不入列表、不参与重名决胜 —— 这正是用户要的「不读取这个文件夹」。
  // 注意这里必须用**全部**来源 + 自定义来源，不能只用 activeUserRoots()，
  // 否则被移除的来源会连行都不剩，界面就无从提供「恢复读取」。
  const user = [...userRoots(), ...customRootsFromState(policyResult.state)];
  const scannable = user.filter((root) => !removedKeys.has(root.key));
  const userScans = await scanDeduplicatedRoots(scannable);
  const projectWarnings: SkillWarning[] = [];
  const scoped = await projectRoots(options.projectCwds, projectWarnings);
  const trash = await listTrash();
  const result: StateResult = {
    roots: [],
    projects: [],
    trash,
    warnings: [
      ...(policyResult.warning ? [policyResult.warning] : []),
      ...projectWarnings,
    ],
  };
  // 回收站没有自动清理：超龄条目通过 warnings 提示用户到 Skills 管理页处理，
  // 避免静默删除用户可能还想恢复的内容。
  const TRASH_STALE_DAYS = 30;
  const staleTrashCount = trash.filter((item) => {
    const deletedAt = Date.parse(String(item && item.deletedAt));
    return Number.isFinite(deletedAt) && Date.now() - deletedAt > TRASH_STALE_DAYS * 86400000;
  }).length;
  if (staleTrashCount > 0)
    result.warnings.push({
      code: "warning.trash.stale",
      params: { count: staleTrashCount, days: TRASH_STALE_DAYS },
      error: `回收站中有 ${staleTrashCount} 个条目已超过 ${TRASH_STALE_DAYS} 天，建议到 Skills 管理页清理`,
    });
  const all: StateItem[] = [];
  for (const root of [...scoped, ...user]) {
    const isRemoved = removedKeys.has(root.key);
    const { exists, entries, truncated } = isRemoved
      ? { exists: false, entries: [], truncated: false }
      : root.scope === "project"
        ? ((await scanDeduplicatedRoots([root])).get(root.key) as ScanResult)
        : (userScans.get(root.key) as ScanResult);
    if (isRemoved) {
      // 已移除：登记一行（供界面显示与恢复），但没有任何技能。
      result.roots.push({
        key: root.key,
        ...(root.kind ? { kind: root.kind } : {}),
        ...(root.localeKey ? { localeKey: root.localeKey } : {}),
        path: root.path,
        label: root.label,
        mutable: root.mutable,
        deletable: root.deletable === true,
        removable: !isDefaultSkillSource(root) && root.scope !== "project",
        // 自定义来源（用户手加的目录）：只有它能「永久删除」——按约定发现的来源删不掉。
        custom: root.custom === true,
        // 默认来源（dsh / hub）：界面据此隐藏来源开关、只显示「可管理」标记。
        defaultSource: isDefaultSkillSource(root),
        toggleable: root.toggleable,
        native: root.native,
        rank: root.rank,
        scope: root.scope || "user",
        exists: false,
        truncated: false,
        removed: true,
        enabled: false,
        skills: [],
      });
      continue;
    }
    // 即使项目 .dsh/skills 尚不存在，也要把可写根返回给创建表单；只读项目根仍按实际存在性展示。
    if (root.scope === "project" && !exists && root.kind !== "project-dsh")
      continue;
    if (truncated)
      result.warnings.push({
        code: "warning.scan.truncated",
        params: { path: root.path },
        error: `技能扫描达到遍历上限，部分技能未显示: ${root.path}`,
      });
    const skills: StateSkill[] = [];
    for (const e of entries) {
      const policy = effectiveSkillPolicy(policyResult, root, e);
      const managerEnabled =
        policyResult.writable !== false &&
        policy.sourceEnabled &&
        policy.override !== false;
      skills.push({
        name: e.name,
        declaredName: e.declaredName,
        kind: e.kind,
        description: e.description,
        modelInvocable: e.modelInvocable,
        userInvocable: e.userInvocable,
        invocationPolicyValid: e.invocationPolicyValid,
        hasFrontmatter: e.hasFrontmatter,
        loadable: e.loadable,
        managerEnabled,
        managerOverride: policy.override === undefined ? null : policy.override,
        effectiveModelInvocable: policy.modelInvocable,
        effectiveUserInvocable: policy.userInvocable,
        diagnostics: e.diagnostics,
        path: e.docPath,
      });
      all.push({
        root,
        entry: e,
        managerEnabled,
        policy,
        view: skills[skills.length - 1],
      });
    }
    result.roots.push({
      key: root.key,
      ...(root.kind ? { kind: root.kind } : {}),
      ...(root.localeKey ? { localeKey: root.localeKey } : {}),
      path: root.path,
      label: root.label,
      mutable: root.mutable,
      // 是否提供「删除」：dsh / hub / 项目级 .dsh/skills 为 true；
      // 外部 Agent 与自定义绝对路径来源为 false（只读）。
      deletable: root.deletable === true,
      toggleable: root.toggleable,
      native: root.native,
      rank: root.rank,
      scope: root.scope || "user",
      ...(root.projectRoot
        ? {
            projectRoot: root.projectRoot,
            projectName: root.projectName,
            workspaceCwds: root.workspaceCwds,
          }
        : {}),
      exists,
      truncated: truncated === true,
      // 界面用：能否从管理器「移除」（不再读取）。dsh / hub / 项目级不可移除。
      removable: !isDefaultSkillSource(root) && root.scope !== "project",
      // 自定义来源（用户手加的目录）：只有它能「永久删除」——按约定发现的来源删不掉。
      custom: root.custom === true,
      // 默认来源（dsh / hub）：界面据此隐藏来源开关（它们不能停用），换成「可管理」标记。
      defaultSource: isDefaultSkillSource(root),
      removed: false,
      enabled:
        policyResult.writable !== false &&
        (root.scope === "project" ||
          isDefaultSkillSource(root) ||
          policyResult.state.sources[root.key] !== false),
      skills,
    });
  }
  const userItems = all.filter((item) => item.root.scope !== "project");
  const preferredSkills = policyResult.state.preferredSkills || null;
  markWinners(userItems, { preferred: preferredSkills });
  const projectGroups = new Map();
  for (const item of all.filter(
    (candidate) => candidate.root.scope === "project",
  )) {
    const group = projectGroups.get(item.root.projectRoot) || [];
    group.push(item);
    projectGroups.set(item.root.projectRoot, group);
  }
  for (const projectItems of projectGroups.values()) {
    // 用户级条目参与该 workspace 的优先级判定，但不把其全局视图标记为“被某项目覆盖”。
    const userCopies = userItems.map((item) => ({
      ...item,
      view: { ...item.view },
    }));
    markWinners([...projectItems, ...userCopies], { preferred: preferredSkills });
  }
  const seenProjects = new Set();
  for (const root of result.roots.filter((item) => item.scope === "project")) {
    if (seenProjects.has(root.projectRoot)) continue;
    seenProjects.add(root.projectRoot);
    result.projects.push({
      root: root.projectRoot,
      name: root.projectName,
      workspaceCwds: root.workspaceCwds,
    });
  }
  result.summary = {
    total: all.length,
    enabled: all.filter((item) => item.view.enabled === true).length,
    disabled: all.filter(
      (item) => item.entry.loadable && item.policy.enabled === false,
    ).length,
    issues: all.reduce(
      (count, item) =>
        count + item.entry.diagnostics.length + (item.view.shadowedBy ? 1 : 0),
      0,
    ),
  };
  return result;
}