// 官方内置技能来源：把宿主随会话注入的内置技能物成本插件自有的真实目录（单技能可启停），
// 并给出 Office 操作技能那段「Installed LibreOffice Kit」运行时说明。
//
// 从 core.ts 整段搬来，一行未改。这一段是本插件里唯一直接摸宿主安装形态的代码
// （resourcesDir / desktopPackageDir / resolvedPackageDir），单独成层后 core.ts 只管
// 文件与状态，宿主耦合集中在这里；两份模块级缓存（officeRuntimeSectionCache、
// officialRootCache）随段同搬，仍是每进程一份的单例。
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { SkillSource } from "./core-types.js";
import { resolveDshHome } from "./homes.js";
import { clearRuntimeNote, noteRuntime } from "../compat/runtime-notes.js";

// ── 官方内置技能来源（随宿主注入会话上下文的内置技能）──────────────────────
//
// 宿主按形态注入不同的官方技能，**名单由官方决定，本插件不写死**（整目录拷贝官方 assets，
// 官方给几个就是几个）：
//   - 桌面版：dsh-skill-office 的 assets（office 路由 + office-docx / office-pptx /
//     office-xlsx）+ diagnose-windows-sandbox-acl（dsh-sandbox-windows-acl 的门控是
//     `process.platform === "win32"`，rank 600）。
//   - 预设技能：dsh-agent-preset 的 skills 根（dsh-doc 等）—— 官方预设经
//     dsh-skill-filesystem 的 customSkillDirs 把这份目录接进会话上下文，属于
//     「官方自带」，一并收录；收不收看宿主默认预设接没接它（见下方「预设技能」段）。
//   - web 版：沙盒诊断技能由宿主注入（门控只看 win32 —— 用户截图实锤，
//     按「web 不注入」的误判把 web 挡在门外，会让页面不显示而宿主照注）；office
//     插件 web 宿主不装配、不注入，但用户要求技能页照样把它们暴露出来
//     统一管理（npm 包自带完整 assets，接管后可启停）。
//
// 官方自己在改这份名单：office 的三个**操作**技能（office-render / office-recalculate /
// office-export-pdf）曾以 SKILL.md 的形式随包发布，后来被撤下，渲染 / 换算 / 重算改由官方
// 的原生工具承担。所以「官方内置」列出的个数会随官方版本变 —— 这不是插件漏了。
//
// 它们或住在官方 asar 里、或由官方 provider 复制进临时目录自管，插件直接扫描/接管有两个
// 坑：宿主子进程里对 asar 的 promises 读法与拦截器解析都出现过时灵时不灵（同机两次启动
// 一组 4/1、一组全 0，实测）；沙盒技能的脚本要交给 PowerShell 子进程，asar 路径读不了。
//
// 因此这里把来源**物化**成插件自有的一份真实目录，**每种宿主形态各一份**
// （`$DSH_HOME/tool-management/official-skills/<desktop|web>/`）：每次宿主启动从官方源头
// 整目录覆盖拷贝（与官方 provider 的「私有资源副本」同一做法），扫描、启停、overlay、
// 脚本执行全部落在真实文件上。599 压过宿主 provider 的 600，停用即不注入。分形态是竞态
// 教训：原先共用一份目录，web 启动把它解析到的沙盒技能盖进去，桌面物化好的
// 一组只剩 1 个；改成各写各的子目录，互不清对方的账。共享布局的残留（旧条目
// 直接躺在 official-skills/ 下）按已知名单清理。
//
// 单个来源、随 DSH 技能之后排列，来源层语义同默认来源（不可移除、无来源开关）。

/** 官方来源的 key：只读、不可删，界面按它区分「官方内置」与用户来源。 */
export const OFFICIAL_SOURCE_KEY = "official";

/** electron 的 resources 目录；非桌面宿主（web 等普通 node 进程）没有这个属性。 */
function resourcesDir(): string | null {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  return typeof resources === "string" && resources !== "" ? resources : null;
}

/** 桌面版官方 asar 里的包内目录（同步 fs 对 asar 的支持经过实测可靠）。 */
function desktopPackageDir(packageName: string, subpath: string): string | null {
  const resources = resourcesDir();
  if (resources === null) return null;
  const dir = join(
    resources,
    "app.asar",
    "dsh",
    "node_modules",
    ...packageName.split("/"),
    ...subpath.split("/"),
  );
  return existsSync(dir) ? dir : null;
}

/**
 * 从插件自身的解析链找官方包内目录（web 等非桌面宿主的途径；宿主进程里的裸名
 * 解析由官方模块拦截器路由到宿主副本）。包不可解析（旧宿主 / 单测环境）返回 null。
 */
function resolvedPackageDir(packageName: string, subpath: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    let manifest: string;
    try {
      manifest = require.resolve(`${packageName}/package.json`);
    } catch {
      // exports 未暴露 ./package.json 的包：从入口文件向上找同名 manifest。
      manifest = "";
      let dir = dirname(require.resolve(packageName));
      for (let i = 0; i < 6; i += 1) {
        const candidate = join(dir, "package.json");
        if (existsSync(candidate)) {
          manifest = candidate;
          break;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      if (manifest === "") return null;
    }
    const dir = join(dirname(manifest), ...subpath.split("/"));
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * 目录里是否至少有一个带 SKILL.md 的技能子目录。
 *
 * 不点名校验 / 不比对固定清单：官方技能集合会变（新增 / 改名 / 重排），只要源还是
 * 「子目录 + SKILL.md」这个形态就整目录接管；一个都没有说明这份源不完整，宁可返回
 * false 让上层不列出，也不物化一份空壳。
 */
function hasSkillDocs(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")),
    );
  } catch {
    return false;
  }
}

/**
 * office 技能源头。桌面版由宿主挂载：运行时真实目录优先（官方 assetRoot），其次 asar
 * 包内 assets。web 宿主不装配 office 插件（不注入），但 npm 包自带完整 assets —— 用户
 * 要求技能页照样暴露这些技能，走宿主进程解析链取包内一份。解析不到
 * 一律 null —— 不把拿不到真实文件的技能凭空列出来。
 */
function officialOfficeSource(): string | null {
  // 桌面壳通过 DSH_BUNDLED_OFFICE_SKILLS 指定宿主实际使用的 assets 根，照抄最稳。
  const bundled = process.env.DSH_BUNDLED_OFFICE_SKILLS;
  if (bundled !== undefined && bundled !== "" && hasSkillDocs(bundled))
    return bundled;
  const resources = resourcesDir();
  if (resources !== null) {
    const runtimeDir = join(resources, "runtime", "office-skills");
    if (hasSkillDocs(runtimeDir)) return runtimeDir;
    const asarDir = desktopPackageDir("@deepseek-ai/dsh-skill-office", "assets");
    if (asarDir !== null && hasSkillDocs(asarDir)) return asarDir;
  }
  const resolved = resolvedPackageDir("@deepseek-ai/dsh-skill-office", "assets");
  return resolved !== null && hasSkillDocs(resolved) ? resolved : null;
}

/** 沙盒诊断技能源头（桌面 asar 直连优先，其次宿主进程解析链；宿主门控仅看 win32，web/桌面皆注入）。 */
function officialSandboxSource(): string | null {
  if (process.platform !== "win32") return null;
  const source =
    desktopPackageDir(
      "@deepseek-ai/dsh-sandbox-windows-acl",
      "assets/diagnose-windows-sandbox-acl",
    ) ??
    resolvedPackageDir(
      "@deepseek-ai/dsh-sandbox-windows-acl",
      "assets/diagnose-windows-sandbox-acl",
    );
  return source !== null && existsSync(join(source, "SKILL.md")) ? source : null;
}

/**
 * 预设技能源头：dsh-agent-preset 的 skills 根。
 *
 * 官方预设经 dsh-skill-filesystem 的 customSkillDirs 把这份目录接进会话上下文，
 * 它和 office / sandbox 一样是「官方自带」，一并收录。桌面 asar 直连优先，其次宿主
 * 进程解析链；解析不到一律 null —— 不凭空列出。
 *
 * 这份目录**本身**不等于「宿主在注入」：接不接由预设决定（见 {@link presetInjectsPresetSkills}）。
 */
function officialPresetSource(): string | null {
  const source =
    desktopPackageDir("@deepseek-ai/dsh-agent-preset", "skills") ??
    resolvedPackageDir("@deepseek-ai/dsh-agent-preset", "skills");
  return source !== null && hasSkillDocs(source) ? source : null;
}

// ── 预设技能：宿主到底注入哪一份 ───────────────────────────────────────────
//
// 官方预设给 skill-filesystem 配 `customSkillDirs`，指向 agent-preset 的 skills 目录；
// 宿主把那份目录里的技能**整目录**注入会话上下文（没有逐个技能的选择余地）。
// 所以「宿主注入的预设技能」= 「接了这个目录的预设」×「那份目录里的技能」。
//
// 收不收这份目录，看**宿主默认预设**（用户选过的默认值优先）接没接它：接了才收 ——
// 没收的预设不注入那些技能，列进「官方内置」就是凭空多出来的条目。
// 宿主把预设组合放在 dsh-web-app 的 presets/<id>.patch.yml 里，判据是那份文件同时
// 出现 customSkillDirs 与 dsh-agent-preset（官方就用这条路径表达「接预设技能」）。
// 读不到组合文件 → 保守当「接了」：宁可多列一条，也不让官方自带技能从列表里消失。

/** 宿主默认预设的 id；官方部署的默认值是 standard，用户在名册里选过别的就以那个为准。 */
export const DEFAULT_PRESET_ID = "standard";

let officialPresetId = DEFAULT_PRESET_ID;

/**
 * 设定宿主默认预设的 id（由插件启动时按宿主名册的默认值设置）。
 *
 * 必须在第一次物化官方技能之前调用：物化结果按进程缓存，之后再改不重算。
 *
 * @param id - 宿主名册里的默认预设 id；空值表示沿用 standard。
 */
export function setOfficialPresetId(id: string | undefined): void {
  const clean = typeof id === "string" ? id.trim() : "";
  if (clean !== "") officialPresetId = clean;
}

/**
 * 宿主某个预设的组合文本；取不到返回 null。
 *
 * 按**两个包来源**依次找（桌面安装目录、解析到的 node_modules）。兼容页曾经自己拼
 * `join(hostRoot, 'dsh-web-app', ...)`，与这里可能读到不同的副本 —— 同一台机器上
 * 「技能页说接了、兼容页说没接」就是这么来的。判定只留这一份。
 *
 * @param presetId - 预设 id。
 * @returns 组合文本；两个来源都读不到时为 null。
 */
export function readHostPresetComposition(presetId: string): string | null {
  const subpath = `presets/${presetId}.patch.yml`;
  for (const path of [
    desktopPackageDir("@deepseek-ai/dsh-web-app", subpath),
    resolvedPackageDir("@deepseek-ai/dsh-web-app", subpath),
  ]) {
    if (path === null) continue;
    try {
      return readFileSync(path, "utf8");
    } catch {
      /* 换下一个来源 */
    }
  }
  return null;
}

/**
 * 一份预设组合文本里有没有「把预设技能目录接进会话上下文」这件事。
 *
 * 官方预设给 skill-filesystem 配 `customSkillDirs`，用一条路径表达式指向 agent-preset 的
 * skills 目录 —— 组合文本里同时出现 customSkillDirs 与 dsh-agent-preset 就是这个意思。
 *
 * @param text - 预设组合文本。
 * @returns 接了预设技能目录返回 true。
 */
export function presetCompositionWiresPresetSkills(text: string): boolean {
  return text.includes("customSkillDirs") && text.includes("dsh-agent-preset");
}

/**
 * 宿主这个预设有没有把预设技能目录接进会话上下文。
 *
 * 读不到组合文件时返回 `false`（**不列**）。
 *
 * 早先按「接了」处理，理由是保守多列 —— 但方向反了：列出来的条目会被当成"宿主真的注入
 * 了这份技能"，用户据此启停一个**根本不存在于上下文**的技能，界面显示开着、模型看不到。
 * 而漏列的代价只是少一行提示，用户还能在技能页看到官方目录里的真实技能。
 *
 * @param presetId - 预设 id。
 * @returns 组合文件明确接了才返回 true。
 */
function presetInjectsPresetSkills(presetId: string): boolean {
  const text = readHostPresetComposition(presetId);
  if (text === null) return false;
  return presetCompositionWiresPresetSkills(text);
}

// ── office 技能的「Installed LibreOffice Kit」段 ────────────────────────────
//
// 官方 dsh-office provider 在 get 时只给**操作**技能（曾为 office-render /
// office-recalculate / office-export-pdf）的正文**追加**一段「Installed LibreOffice
// Kit」：SKILL.md 明文要求「使用这段提供的 libreofficeKit.node 与 .cli 绝对路径，
// 禁止自行搜索/猜测」。创作技能只产出 OOXML，不执行 LibreOffice 命令，官方不给它们
// 补段。我们以覆盖方式接管后官方 provider 不再被问到，这段必须由我们补上 ——
// 否则模型拿到的操作技能缺执行 LibreOffice 命令所需的全部路径。文案与 JSON 形状逐字取自官方
// dsh-skill-office lib/index.js 的 officeRuntime()；node/cli 的落点按宿主形态各自核实：
//   - 桌面：官方明确要求 packaged 应用必须给**独立 node**（electron 本体不行）。
//     桌面壳通过 `DSH_BUNDLED_OFFICE_NODE` / `DSH_BUNDLED_OFFICE_CLI` 传真实路径
//     （运行时装在 `<resources>/runtime/primary-runtime/`，node 在其 dependencies/node/bin
//     下；cli 在 `app.asar.unpacked` 里 —— 独立 node 读不了 asar 内部）；变量缺席时才按
//     形态兜底。
//   - web：官方默认 process.execPath（宿主是普通 node 进程），cli 从宿主进程解析链取。
// 任一路径不是真实文件 → 用官方口径的「已停用」文案（SKILL.md 自有降级分支，模型不会
// 去猜路径），绝不给一个跑不起来的路径。

/**
 * 一个官方技能是否需要补 LibreOffice Kit 段。
 *
 * 官方按写死的技能名单注入；照抄名单会在官方增删操作技能时静默漏挂或错挂。改看正文：
 * 需要这段的技能自己会写明「使用下方提供的 Node / CLI 绝对路径」，正文里必然出现
 * LibreOffice。三个创作技能不提它，操作技能都提 —— 官方换名字 / 加技能也照样命中。
 *
 * @param body SKILL.md 正文（frontmatter 之后）
 * @returns 正文提到 LibreOffice 时为 true
 */
export function officeKitApplies(body: string): boolean {
  return /\blibreoffice\b/iu.test(body);
}

const OFFICE_RUNTIME_DISABLED =
  "\n\nLibreOffice Kit is disabled in this deployment.";

let officeRuntimeSectionCache: string | undefined;

/** 官方 provider 在 get 时追加的 LibreOffice Kit 段（每进程算一次，路径不随会话变）。 */
export function officialOfficeRuntimeSection(): string {
  if (officeRuntimeSectionCache === undefined)
    officeRuntimeSectionCache = computeOfficeRuntimeSection();
  return officeRuntimeSectionCache;
}

function computeOfficeRuntimeSection(): string {
  const env = process.env;
  const resources = resourcesDir();
  const runtimeRoot =
    env.DSH_PRIMARY_RUNTIME || env.DSH_BUNDLED_PRIMARY_RUNTIME || "";
  const nodeBin = join(
    "bin",
    process.platform === "win32" ? "node.exe" : "node",
  );
  let node: string;
  let cli: string | null;
  // 官方 provider 的路径来源就是这几个环境变量（cordis 装配逐字核对）：桌面壳会把独立
  // node 与 unpacked 的 cli 直接传进来。优先照抄，免得按形态猜错 —— 桌面上
  // DSH_BUNDLED_PRIMARY_RUNTIME 也在，若只看它会从解析链拿到 asar 内部的 cli，
  // 独立 node 读不了。
  if (env.DSH_BUNDLED_OFFICE_CLI === "") return OFFICE_RUNTIME_DISABLED;
  if (env.DSH_BUNDLED_OFFICE_CLI !== undefined) {
    cli = env.DSH_BUNDLED_OFFICE_CLI;
    node =
      env.DSH_BUNDLED_OFFICE_NODE ??
      (runtimeRoot !== ""
        ? join(resolve(runtimeRoot), "dependencies", "node", nodeBin)
        : process.execPath);
  } else if (resources !== null) {
    // 桌面兜底（壳未给 OFFICE_* 环境变量时）：运行时装在 runtime/primary-runtime 下；
    // 桌面的 cli 只认 unpacked 真实文件（独立 node 读不了 asar；electron 的 fs 补丁
    // 会让 existsSync 对 asar 内部也返回真，所以这里不用解析链兜底）。
    node = join(
      resources,
      "runtime",
      "primary-runtime",
      "dependencies",
      "node",
      nodeBin,
    );
    cli = join(
      resources,
      "app.asar.unpacked",
      "dsh",
      "node_modules",
      "@deepseek-ai",
      "libreoffice-kit",
      "lib",
      "cli.js",
    );
  } else if (runtimeRoot !== "") {
    // SDK / 容器部署：官方配置从运行时根推导（cordis 装配逐字核对）。
    node = join(resolve(runtimeRoot), "dependencies", "node", nodeBin);
    cli = resolvedPackageDir("@deepseek-ai/libreoffice-kit", "lib/cli.js");
  } else {
    node = process.execPath;
    cli = resolvedPackageDir("@deepseek-ai/libreoffice-kit", "lib/cli.js");
  }
  const usable = (path: string): boolean => {
    try {
      return isAbsolute(path) && statSync(path).isFile();
    } catch {
      return false;
    }
  };
  if (!usable(node) || cli === null || !usable(cli)) {
    // 可用的路径不存在时不把跑不起来的路径写进正文；同时留一条界面可见的降级，
    // 否则用户只会看到技能「少了那段说明」，不知道该修哪。
    noteRuntime({
      id: "office-kit",
      label: "LibreOffice Kit 路径",
      kind: "read",
      fallback: "inform-only",
      detail: "未找到可用的独立 Node 或 LibreOffice CLI，office 操作技能本轮使用官方的「已停用」文案。请检查 DSH 安装的 runtime 是否完整。",
      detailKey: "office-kit",
      params: { node, cli: cli ?? "" },
    });
    return OFFICE_RUNTIME_DISABLED;
  }
  clearRuntimeNote("office-kit");
  return `\n\n## Installed LibreOffice Kit\n\nUse these absolute paths for every LibreOffice Kit command. Pass the CLI entry as the first argument to Node.\n\n${JSON.stringify({ libreofficeKit: { node, cli } }, null, 2)}`;
}

function copyDirectorySync(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyDirectorySync(source, target);
    else if (entry.isFile()) copyFileSync(source, target);
  }
}

/**
 * 物化官方内置技能到插件自有目录，返回该目录；无可用源头或拷贝失败返回 null。
 * 每次宿主启动整目录重建（官方包只随宿主更新变化，宿主更新必然重启宿主）。
 */
let officialRootCache: SkillSource | null | undefined;

/** 宿主形态子目录名：桌面（有 process.resourcesPath）与 web 等普通 node 进程各物化一份。 */
function officialFormName(): "desktop" | "web" {
  return resourcesDir() === null ? "web" : "desktop";
}

/**
 *原先各形态共用一份目录（旧条目直接躺在 official-skills/ 下）；分形态目录后
 * 这些残留只会变成幽灵条目，按这份已知名单清掉。只清名单内的名字，绝不碰旁边的
 * `<form>/` 子目录 —— 那是另一种形态物化的现役目录。
 *
 * 名单要跟上官方：官方撤下 office 的三个操作技能（office-render / office-recalculate /
 * office-export-pdf）后，旧布局里可能还躺着它们 —— 不清就会变成列表里点不开的幽灵条目。
 */
const LEGACY_OFFICIAL_ENTRY_NAMES = Object.freeze([
  "office",
  "office-docx",
  "office-pptx",
  "office-xlsx",
  "office-render",
  "office-recalculate",
  "office-export-pdf",
  "scripts",
  "diagnose-windows-sandbox-acl",
]);

function cleanupLegacyOfficialLayout(root: string): void {
  for (const name of LEGACY_OFFICIAL_ENTRY_NAMES) {
    try {
      rmSync(join(root, name), { recursive: true, force: true });
    } catch {
      /* 残留清理失败不影响物化，下轮启动再试 */
    }
  }
}

function materializeOfficialSkills(): string | null {
  const office = officialOfficeSource();
  const sandbox = officialSandboxSource();
  // 预设技能只在宿主默认预设真的接了这份目录时收：没接的预设不注入它们，
  // 列进「官方内置」就是凭空多出来的条目（判据见 presetInjectsPresetSkills）。
  const preset = officialPresetSource();
  const presetInjected = preset !== null && presetInjectsPresetSkills(officialPresetId);
  if (office === null && sandbox === null && !presetInjected) return null;
  // 每种宿主形态只整目录重建**自己**这份（竞态教训见上方块注释）；对方形态的子目录
  // 与共享层残留清理互不干涉。
  const root = join(
    resolveDshHome(),
    "tool-management",
    "official-skills",
    officialFormName(),
  );
  try {
    rmSync(root, { recursive: true, force: true });
    // office：整个 assets 根拷进来（每个技能一个子目录，目录之间的相对结构原样保留）。
    if (office !== null) copyDirectorySync(office, root);
    // 预设技能：技能根下的每个技能目录整体拷进来。宿主默认预设没接这份目录时
    // 整份不收 —— 那些技能不会被注入，列出来就是凭空多出来的条目。
    if (presetInjected && preset !== null) copyPresetSkills(preset, root);
    if (sandbox !== null) {
      copyDirectorySync(sandbox, join(root, basename(sandbox)));
    }
    cleanupLegacyOfficialLayout(dirname(root));
    return root;
  } catch (error) {
    console.error(
      "[dsh-plugin-tool-management] official skills materialization failed:",
      String((error && (error as Error).message) || error),
    );
    return null;
  }
}

/**
 * 把预设技能根拷进物化目录。
 *
 * 同名时整目录替换而不是合并：预设技能是完整的一棵树（SKILL.md + references/ +
 * templates/），与别的来源同名时合并会拼出两边都不认识的混合体。
 *
 * 技能自己的文档按「相对技能基目录」引用 references/ 与 templates/，整体拷贝即可保住；
 * 它的说明里另有几处假设技能住在官方包内（如「基目录上两级是 agent-preset 的
 * package.json」），那是源码检出场景下的自证手段，物化成真实目录后不成立 —— 官方文档
 * 对此的兜底口径是「只报核实过的版本」，不实报即可。
 */
function copyPresetSkills(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      rmSync(target, { recursive: true, force: true });
      copyDirectorySync(source, target);
    } else if (entry.isFile()) {
      copyFileSync(source, target);
    }
  }
}

/** 官方内置技能的只读来源；materialize 不出真实目录时返回 null（不凭空列出）。 */
export function officialSkillRoot(): SkillSource | null {
  // **只缓存成功结果**。
  //
  // 早先连 `null` 一起缓存：物化失败一次（官方包在启动后才就位、或那一次拷贝碰到权限
  // 问题）之后，整个进程生命周期里「官方内置」整组都不会再出现，用户看不到也修不了，
  // 只能重启。物化本身是幂等的，失败后重试的代价只是一次目录拷贝。
  if (officialRootCache !== undefined) return officialRootCache;
  const dir = materializeOfficialSkills();
  if (dir === null) return null
  officialRootCache = {
    key: OFFICIAL_SOURCE_KEY,
    path: dir,
    label: "官方内置",
    localeKey: "official",
    mutable: false,
    deletable: false,
    // 来源层无开关（同默认来源），单个技能可启停；脚本从物化副本的真实路径执行。
    //
    // rank 只决定**本 provider 内部**同名候选的先后（官方 599 排在 hub / dsh / agents
    // 之后，被用户自己的同名技能盖住）。对宿主官方 provider 的接管不靠数字：
    // 全局层由宿主自己提供官方技能，我们只在每个 agent 的 scoped 层里注册同一份候选，
    // 层优先级「最近一层胜出」直接压过全局层 —— 官方改 rank 常量不会让接管失效。
    toggleable: true,
    native: false,
    scope: "user",
    rank: 599,
  };
  return officialRootCache;
}