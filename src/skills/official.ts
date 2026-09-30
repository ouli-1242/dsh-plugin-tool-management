// 官方内置技能来源：把宿主随会话注入的内置技能物成本插件自有的真实目录（单技能可启停），
// 并给出 Office 三件套那段「Installed LibreOffice Kit」运行时说明。
//
// 从 core.ts 整段搬来，一行未改。这一段是本插件里唯一直接摸宿主安装形态的代码
// （resourcesDir / desktopPackageDir / resolvedPackageDir），单独成层后 core.ts 只管
// 文件与状态，宿主耦合集中在这里；两份模块级缓存（officeRuntimeSectionCache、
// officialRootCache）随段同搬，仍是每进程一份的单例。
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { SkillSource } from "./core-types.js";
import { resolveDshHome } from "./homes.js";

// ── 官方内置技能来源（随宿主注入会话上下文的内置技能）──────────────────────
//
// 宿主按形态注入不同的官方技能（官方源码逐一核对，2026-09-30）：
//   - 桌面版 4 个：office-docx / office-pptx / office-xlsx（dsh-skill-office 只在桌面
//     宿主装配，assetRoot 指到 `<resources>/runtime/office-skills`）+ diagnose-windows-
//     sandbox-acl（dsh-sandbox-local 的门控是 `process.platform === "win32"`，rank 600）。
//   - web 版：沙盒诊断技能由宿主注入（门控只看 win32 —— 用户 2026-09-30 截图实锤，
//     0.16.5 按「web 不注入」的误判把 web 挡在门外，导致页面不显示、宿主照注）；office
//     插件 web 宿主不装配、不注入，但用户裁定（2026-09-30）技能页照样把这三个暴露出来
//     统一管理（npm 包自带完整 assets，接管后可启停）。
//
// 它们或住在官方 asar 里、或由官方 provider 复制进临时目录自管，插件直接扫描/接管有两个
// 坑：宿主子进程里对 asar 的 promises 读法与拦截器解析都出现过时灵时不灵（同机两次启动
// 一组 4/1、一组全 0，实测）；沙盒技能的脚本要交给 PowerShell 子进程，asar 路径读不了。
//
// 因此这里把来源**物化**成插件自有的一份真实目录，**每种宿主形态各一份**
// （`$DSH_HOME/tool-management/official-skills/<desktop|web>/`）：每次宿主启动从官方源头
// 整目录覆盖拷贝（与官方 provider 的「私有资源副本」同一做法），扫描、启停、overlay、
// 脚本执行全部落在真实文件上。599 压过宿主 provider 的 600，停用即不注入。分形态是竞态
// 教训：0.16.5 之前共用一份目录，web 启动把它解析到的沙盒技能盖进去，桌面物化好的
// 4 个只剩 1 个（实测）；改成各写各的子目录，互不清对方的账。共享布局的残留（旧条目
// 直接躺在 official-skills/ 下）按已知名单清理。
//
//   - 预设参考技能（dsh-agent-preset/skills）不注入会话上下文，不列入（用户裁定）。
//
// 单个来源、随 DSH 技能之后排列，来源层语义同默认来源（不可移除、无来源开关）。

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
 * office 技能源头。桌面版由宿主挂载：运行时真实目录优先（官方 assetRoot），其次 asar
 * 包内 assets。web 宿主不装配 office 插件（不注入），但 npm 包自带完整 assets —— 用户
 * 裁定（2026-09-30）技能页照样暴露这三个技能，走宿主进程解析链取包内一份。解析不到
 * 一律 null —— 不把拿不到真实文件的技能凭空列出来。
 */
function officialOfficeSource(): string | null {
  const resources = resourcesDir();
  if (resources !== null) {
    const runtimeDir = join(resources, "runtime", "office-skills");
    if (existsSync(join(runtimeDir, "office-docx"))) return runtimeDir;
    const asarDir = desktopPackageDir("@deepseek-ai/dsh-skill-office", "assets");
    if (asarDir !== null && existsSync(join(asarDir, "office-docx")))
      return asarDir;
  }
  return resolvedPackageDir("@deepseek-ai/dsh-skill-office", "assets");
}

/** 沙盒诊断技能源头（桌面 asar 直连优先，其次宿主进程解析链；宿主门控仅看 win32，web/桌面皆注入）。 */
function officialSandboxSource(): string | null {
  if (process.platform !== "win32") return null;
  return (
    desktopPackageDir(
      "@deepseek-ai/dsh-sandbox-windows-acl",
      "assets/diagnose-windows-sandbox-acl",
    ) ??
    resolvedPackageDir(
      "@deepseek-ai/dsh-sandbox-windows-acl",
      "assets/diagnose-windows-sandbox-acl",
    )
  );
}

// ── office 技能的「Installed LibreOffice Kit」段 ────────────────────────────
//
// 官方 dsh-office provider 在 get 时给三个 office 技能的正文**追加**一段
// 「Installed LibreOffice Kit」：SKILL.md 明文要求「使用这段提供的 libreofficeKit.node
// 与 .cli 绝对路径，禁止自行搜索/猜测」。我们以 599 接管后官方 provider 不再被问到，
// 这段必须由我们补上 —— 否则模型拿到的 office 技能缺执行 LibreOffice 命令所需的全部
// 路径（这个缺口 0.16.5 在桌面上就已存在）。文案与 JSON 形状逐字取自官方
// dsh-skill-office lib/index.js 的 officeRuntime()；node/cli 的落点按宿主形态各自核实：
//   - 桌面：官方明确要求 packaged 应用必须给**独立 node**（electron 本体不行）。
//     实测桌面把运行时装在 `<resources>/runtime/primary-runtime/`（DSH_PRIMARY_RUNTIME
//     指向它，SDK 部署可被同名环境变量改写），node 在其 dependencies/node/bin 下；cli
//     必须用 `app.asar.unpacked` 里的真实文件 —— 独立 node 读不了 asar 内部。
//   - web：官方默认 process.execPath（宿主是普通 node 进程），cli 从宿主进程解析链取。
// 任一路径不是真实文件 → 用官方口径的「已停用」文案（SKILL.md 自有降级分支，模型不会
// 去猜路径），绝不给一个跑不起来的路径。

export const OFFICE_SKILL_NAMES = new Set([
  "office-docx",
  "office-pptx",
  "office-xlsx",
]);

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
  const resources = resourcesDir();
  let node: string;
  let cli: string | null;
  const runtimeRoot =
    process.env.DSH_PRIMARY_RUNTIME || process.env.DSH_BUNDLED_PRIMARY_RUNTIME;
  if (runtimeRoot) {
    // SDK / 容器部署：官方配置从运行时根推导（cordis 装配逐字核对）。
    node = join(
      resolve(runtimeRoot),
      "dependencies",
      "node",
      "bin",
      process.platform === "win32" ? "node.exe" : "node",
    );
    cli = resolvedPackageDir("@deepseek-ai/libreoffice-kit", "lib/cli.js");
  } else if (resources !== null) {
    node = join(
      resources,
      "runtime",
      "primary-runtime",
      "dependencies",
      "node",
      "bin",
      process.platform === "win32" ? "node.exe" : "node",
    );
    // 桌面的 cli 只认 unpacked 真实文件（独立 node 读不了 asar；electron 的 fs 补丁
    // 会让 existsSync 对 asar 内部也返回真，所以这里不用解析链兜底）。
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
  if (!usable(node) || cli === null || !usable(cli))
    return OFFICE_RUNTIME_DISABLED;
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
 * 0.16.5 之前各形态共用一份目录（旧条目直接躺在 official-skills/ 下）；分形态目录后
 * 这些残留只会变成幽灵条目，按这份已知名单清掉。只清名单内的名字，绝不碰旁边的
 * `<form>/` 子目录 —— 那是另一种形态物化的现役目录。
 */
const LEGACY_OFFICIAL_ENTRY_NAMES = Object.freeze([
  "office-docx",
  "office-pptx",
  "office-xlsx",
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
  if (office === null && sandbox === null) return null;
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
    // office：整个 assets 根拷进来（office-*/ 与 scripts/ 的相对结构必须保留 ——
    // SKILL.md 用 `<skill-directory>/../scripts/check_office.py` 引用检查脚本）。
    if (office !== null) copyDirectorySync(office, root);
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

export function officialSkillRoot(): SkillSource | null {
  if (officialRootCache !== undefined) return officialRootCache;
  const dir = materializeOfficialSkills();
  officialRootCache =
    dir === null
      ? null
      : {
          key: OFFICIAL_SOURCE_KEY,
          path: dir,
          label: "官方内置",
          localeKey: "official",
          mutable: false,
          deletable: false,
          // 来源层无开关（同默认来源），单个技能可启停；overlay 以 599 压过官方
          // provider 的 600，脚本从物化副本的真实路径执行。
          //
          // 残余风险（2026-09-30 审查 §5 F12，如实标注、不修）：`599` 是个**数字契约** ——
          // 它只在"官方那个 provider 的 rank 恰好是 600"时成立。官方调档位（把内置技能提到
          // 599 以上、或降到 599 以下）会让接管失效：要么官方内置技能重新注入、与 599 层并存
          // （同名两份），要么本插件反向遮蔽掉本不该遮蔽的东西。rank 是纯数字、没有能力探测
          // 能提前发现，doctor 也查不了（要枚举官方 provider 的注册参数）。所以记为**已知
          // 假设**，列进 CHANGELOG 的宿主适配矩阵，官方更新时人工核对这一处。
          toggleable: true,
          native: false,
          scope: "user",
          rank: 599,
        };
  return officialRootCache;
}