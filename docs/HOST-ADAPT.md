# 宿主适配规格

本文件是插件与 DSH 宿主之间的适配契约规格：范围怎么算、清单怎么记、宿主换代时怎么办。

**读者**：改 `src/compat/` `src/update-check.ts` `scripts/compat-matrix.mjs` 的人，以及要判断「这个宿主能不能装」的维护者。
**不是**面向终端用户的文档 —— 用户视角看 `docs/COMPATIBILITY.md`（生成物）与 `docs/TROUBLESHOOTING.md`。

本文件分两部分：**当前生效的口径**（代码现在就是这样）与**目标态**（清单制，尚未实现）。混着读会得出错误结论 —— 目标态的部分明确标了「未实现」。

---

## 一、当前生效的口径

### 1.1 三个常量

| 常量 | 位置 | 当前值 |
| --- | --- | --- |
| `VERIFIED_HOST_VERSION` | `src/compat/host-roots.ts` | `0.2.2-rc.2` |
| `EXPECTED_PEER_RANGE` | `src/compat/probe.ts` | `>=0.2.2-rc.1 <0.2.3` |
| `EXPECTED_MIN_HOST_VERSION` | `src/compat/probe.ts` | 从 `EXPECTED_PEER_RANGE` 派生，不手写 |

`EXPECTED_MIN_HOST_VERSION` 从范围派生而不是单独手写，是为了避免两处漂移。它取的是范围的**下界**（`0.2.2-rc.1`），而 `VERIFIED_HOST_VERSION` 是**最后验证过的那一版**（`0.2.2-rc.2`）—— 两者不同是正常的：范围下界是「这一代里最早能装的一版」，基准是「最近一次对着验证的一版」，同代内追加 rc 只动后者（见 §2.2 与 §3.4）。这个导出仍然保留是因为它进了 `compat-status` 的载荷。

### 1.2 三处同源

同一个字符串必须同时出现在三处，任何一处漂移都会让「界面 / doctor 报的范围」与「安装期真正校验的范围」各说各话 —— 而两者都自称是插件的兼容范围：

1. `src/compat/probe.ts` 的 `EXPECTED_PEER_RANGE`
2. `package.json` 的 `engines.dsh`
3. `package.json` 里全部 11 个 `@deepseek-ai/dsh-*` 的 `peerDependencies` 范围

`test/contracts.test.mjs` 钉住这条同源关系，同时钉住：范围不含 `^`、范围只有一个 `||` 分支（不累积历史各代）、`engines.dsh` 与 peer 范围是同一个字符串。

**不用 `^`**：它的隐含上界是 `<0.3.0`，而 `0.2.2-rc.1` 这个已适配版本自己都满足不了 `^0.2.2-rc.1`（预发布只在同元组比较器带预发布标签时才匹配）。

改完范围要跑 `npm install --package-lock-only` 刷新 lock，否则 lock 快照与 `package.json` 各说各话。

### 1.3 兼容矩阵是生成物

`docs/COMPATIBILITY.md` 由 `node scripts/compat-matrix.mjs` 生成，**不要手改**。三档口径（「已验证」/「未实测」/「未适配」）与清单展示都只在 `scripts/compat-matrix.mjs` 里改。

---

## 二、预发布版本与 semver

### 2.1 官方全程走预发布渠道

DSH 的版本号形如 `0.2.2-rc.1`，稳定版 `0.2.2` 并不总是先到。semver 有一条硬规则：**带预发布标签的版本，只有在比较器也带预发布标签、且 `[major,minor,patch]` 元组相同的时候才能匹配。**

所以 `>=0.2.2-rc.1` 匹配不了 `0.2.3-rc.1` —— 元组不同。范围只能逐段写。

### 2.2 同一元组内的 rc 会被一个分支天然覆盖

本机 semver 实测（`>=0.2.2-rc.1 <0.2.3`）：

| 宿主版本 | 默认语义 | 带 `includePrerelease` |
| --- | --- | --- |
| `0.2.2-rc.1` | 匹配 | 匹配 |
| `0.2.2-rc.2` | 匹配 | 匹配 |
| `0.2.2-rc.3` | 匹配 | 匹配 |
| `0.2.3-rc.1` | **不匹配** | 匹配 |

即：**追加同代 rc 不必改范围**，只有跨元组（如 `0.2.3-rc.1`）才需要新增 `||` 分支。

### 2.3 `includePrerelease` 用在哪、不用在哪

这是最容易搞反的一处，三处用法各不相同：

| 位置 | 语义 | 为什么 |
| --- | --- | --- |
| 官方 `dsh-app-boot` 的 `evaluatePluginCompatibility` | `includePrerelease: true` | 宿主自己的安装期门槛；`engines.dsh` 存在时由它单独决策、忽略 peerDependencies（`node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`） |
| 本仓库 `scripts/compat-matrix.mjs` 的 `inRange`、`src/compat/probe.ts` 的 peer 范围判定 | **默认语义**（不带 `includePrerelease`） | 这两处判的是「npm 装期会不会拦下来」，而 npm 用默认语义 —— 另立一套会与真实安装结果对不上 |
| 本仓库 `src/update-check.ts` 的 `pickBestCompatible` | `includePrerelease: true` | 拿**候选插件版本自己的** `engines.dsh` 比当前宿主 —— 候选版本的范围是按它自己那一代写的，不带这个选项就跨元组比不过 |

`src/update-check.ts` 那处的具体后果：旧插件版本的范围 `>=0.2.1-rc.5 <0.2.2` 在默认语义下**不匹配**宿主 `0.2.2-rc.1`（跨元组），带 `includePrerelease` 才匹配。这正是它要的 —— 旧宿主装旧插件版本是正常结论。

### 2.4 安装期报什么错

跨元组的范围在 npm 装期报的**不是** ERESOLVE。本机实测（npm 11.19.1）：`peerDependencies` 要求 `>=0.2.3-rc.1 <0.2.4` 而该版本尚不存在时，npm 报

```
npm error code ETARGET
npm error notarget No matching version found for @deepseek-ai/dsh-session@>=0.2.3-rc.1 <0.2.4.
```

ERESOLVE 是**同一元组内**的版本冲突（两个依赖要互相冲突的版本）才报的。两者别混。

`--legacy-peer-deps` 只跳过安装期检查，**不让代码在宿主上变得兼容** —— 装完请看兼容页的降级项。

范围允许多个 `||` 分支，但每个分支必须对应确实验证过的一代。

---

## 三、目标态：清单制（**未实现**）

> 以下整节描述的是设计目标，**代码里还没有**。当前 `package.json` 没有 `dsh.verifiedHostVersions` 字段，`VERIFIED_HOST_VERSION` 仍是单值，`EXPECTED_PEER_RANGE` 只写一代，`test/contracts.test.mjs` 钉着单 `||` 分支，`scripts/compat-matrix.mjs` 按越界标「未适配」。
>
> 这些是**待迁移项，不是现行规则**。切换代码时把单值常量改成由清单派生，并按本节口径一并调整。

### 3.1 清单是什么

唯一真相是 `package.json` 的 `dsh.verifiedHostVersions`：**已验证适配的宿主版本字符串数组**（如 `["0.2.2-rc.1", "0.2.2-rc.2"]`）。

`EXPECTED_PEER_RANGE`、界面与文档里的「适配版本」都由它派生，不各写一份。

### 3.2 为什么更新检查读不到它

npm 简版元数据不含自定义字段。本机实测 registry 的 `install-v1` 响应，version 对象只有：

```
name, version, dependencies, devDependencies, peerDependencies, dist, engines, peerDependenciesMeta
```

所以**更新检查读不到清单**，它继续只认 `engines.dsh`；清单由本地插件、脚本、兼容矩阵与对外文档读取。

### 3.3 判定靠双重保险

官方发新版 → 用户拉取官方源码做对比 → 兼容页直接检测。**两项都过**才算适配、允许追加；任一项报不适配就走重置。

agent 不自判、不代替用户验证功能 —— 这两项检测都得由用户在真实环境完成。

### 3.4 兼容 → 追加；不兼容 → 重置

**兼容 → 追加，旧版本号保留**：两项都过时不改源码、不单独发版；等下一次插件发版把新宿主版本追加进数组，原有宿主版本一条都不删。

**不兼容 → 重置**：数组清空到只剩造成不兼容的那一版，范围下界抬到它，代码按这一代宿主重新适配；旧宿主交给已发布的旧插件版本。重置随下一次插件发版落地，不为重置单独发版。

清单与范围不是一回事：**清单是验证结论，范围是安装期声明。**

重置时把范围下界抬到那一代，`>=0.2.2-rc.3 <0.2.3` 就不再匹配 `0.2.2-rc.1` / `rc.2`（实测）—— 这是「只适配 rc3」在安装期的表达。下界不抬，界面与安装期会继续接受旧宿主，与清单矛盾。

累积声明等于把「装不上」换成「装上后个别能力可能静默失效」，兜底全靠双重保险：两项结论都留下，才允许在下一次发版时追加。

### 3.5 示例

下面的版本号与宿主版本都是**虚构示例**（不是本仓库的发版记录，不要拿去对照 `git log`）。

| 插件版本 | 宿主升级 | 结论 | 该插件版本声明的适配版本 |
| --- | --- | --- | --- |
| `<基准版>` | 基准 `0.2.2-rc.1` | — | `0.2.2-rc.1` |
| `<追加版>` | 升到 `0.2.2-rc.2` | 仍适配 → 追加 | `0.2.2-rc.1`、`0.2.2-rc.2` |
| `<重置版>` | 升到 `0.2.2-rc.3` | 出现不适配 → 重置 | 仅 `0.2.2-rc.3` |

### 3.6 结论怎么留痕

**不另建文件**：追加时在该版本 `CHANGELOG.md` 写一行「适配 X（源码对比 + 兼容页均通过）」；重置时写明影响范围与旧宿主该停在哪个插件版本。

对外展示：`docs/COMPATIBILITY.md` 头部列出本版本声明适配的全部宿主版本；`CHANGELOG.md` 记本版做了什么，不重复清单。

### 3.7 清单里没有 ≠ 不能用

那是「未声明验证」，不是「不兼容」。`doctor.mjs` 的 "differs from verified" 与兼容页的「未实测」是预期状态，不要当成缺陷去修。

稳定版（`0.2.2`）与 rc 按实际验证过的版本分别记账。

---

## 四、升级宿主后的动作

这 4 步与 `AGENTS.md`「宿主适配」节同源（那边是正本，改一处要改另一处）：

1. 先升级宿主 dsh，**不动插件**；用户拉取官方源码做对比，并用兼容页直接检测。
2. 两项都过：记下结论，不发版、不改源码、版本号不动；等下次插件发版时把该宿主版本追加进清单。
3. 任一项报不适配：在下一次发版时重置清单、`EXPECTED_PEER_RANGE`、`engines.dsh` 与 11 个 peer，然后 `npm install --package-lock-only`。
4. 按插件版本号规则发新版本（换代则换段归零）；`npm run build` 全量同步；`node scripts/compat-matrix.mjs` 重生成 `docs/COMPATIBILITY.md`；`CHANGELOG.md` 记录追加或重置。

---

## 五、读官方源码（`app.asar` 内的 TypeScript 源）

桌面版把宿主全部代码打进 `resources/app.asar`，**里面有完整的 `.ts` 源码**（不只是编译产物）。
该文件带 Archive 属性、不能当目录打开，但可以直接按字节读 —— 不要因为"打不开"就退回靠类型猜。

格式：`[8 字节 pickle 头][4 字节 header 大小 N][N 字节 JSON 头][文件数据区]`。
数据区起点 = `16 + N`；每个文件头里的 `offset` 是相对数据区起点的偏移。

```js
const fs = require('fs')
const b = fs.readFileSync('D:/Apps/DeepSeek Harness/resources/app.asar')
const N = b.readUInt32LE(12)
const hdr = JSON.parse(b.slice(16, 16 + N).toString('utf8'))
const base = 16 + N
function get(p) {
  let n = hdr
  for (const seg of p.split('/').filter(Boolean)) { n = n.files[seg]; if (!n) return null }
  if (n.files) return null
  return b.slice(base + Number(n.offset), base + Number(n.offset) + n.size).toString('utf8')
}
// 例：get('dsh/node_modules/@deepseek-ai/dsh-llm/src/call-config.ts')
```

注意两点：

- 少数文件（如 `package.json`）的存储内容前面粘着上一份文件的尾巴，读出来要先从第一个 `{` 截起；
  `.ts` / `.js` 源文件没有这个问题。
- 读源码是为了**确认真实契约**（字段形状、是否校验未知键、默认值怎么补），不是复制实现。
  官方依赖仍然只读，不 patch、不 fork。

---

## 六、更新检查的约束

代码在 `src/update-check.ts`，**约束与理由都写在源码头注释里** —— 改这块之前先读那段注释，那里是真相：

- 判据只有一条：**每个候选版本自己的 `engines.dsh`**。不拿当前版本的范围去套别人的版本。
- 绝不自动更新，也不在后台下载任何东西。
- 网络：只请求 npm registry，不穿透用户代理；检测到代理环境变量直接跳过。
- 安装命令必须 pin 到确切版本，不许出 `@latest`。

三条不在源码注释里、只有本文件记的：

- **不要改成读 `dsh.verifiedHostVersions`** —— registry 简版元数据不含该字段（见 §3.2），改了只会拿到 `undefined`。
- 重置后旧宿主会命中已发布的旧插件版本，这是「留在当前版本」的正常结论；**不得把这些旧版本标 `deprecated`** —— `pickBestCompatible` 会跳过它们，旧宿主会被误报 `no-compatible-version`。
- `hub/update-check.json` 是纯缓存，删掉只是下次重新查。
