# 兼容矩阵

> 本文件由 `node scripts/compat-matrix.mjs` 生成，请勿手工编辑。
>
> 插件 0.21.2 · 生成于 2026-10-22 · 验证基准 DSH `0.2.1-rc.2` · 安装期适配范围 `>=0.2.1-rc.2 <0.2.2`

这张表回答一个问题：**同一个插件，装在不同版本的 DSH 宿主上，哪些能力还在、哪些已经对不上。**
它只做静态判定（读宿主安装里的官方包，看原型上的成员在不在），不启动宿主、不碰会话数据。

## 怎么读

- **已验证** —— 该宿主版本正是本插件适配器最后验证的那一版，且这项能力在它的官方实现里存在。
- **未实测** —— 这项能力在这个宿主上存在，这个宿主也在适配范围内，但它不是验证基准。
  存在不等于行为一致：差一个 rc 也可能改了语义。以插件「兼容」页对**活宿主**的探测为准。
- **未适配** —— 这项能力在这个宿主上存在，但这个宿主版本**不在**本插件的适配范围内。
  插件不声明支持它；装也装不上（peer 校验会拦）。要跑这一代宿主，请装对应版本的插件。
- **不可用** —— 该宿主的官方实现里没有这项成员。依赖它的功能会被拒绝（写入类）或降级（读取类），
  而不是带着未知实现去改数据。
- **—** —— 这项能力只能在**活的宿主**上判定（实例字段的形状、行为试跑），静态视图不猜。
- **待确认** —— 用在「操作」表里：静态能查的要求全部齐备，但还有要求只能在活宿主上判定。
  这不是「不确定能不能用」，是「静态视图只能确认到这里」。

标了「可选」的能力缺失是**预期状态**：宿主的官方 API 本来就没有这个入口，插件会走适配器路径，
功能不受影响。所以「宿主」表的**缺失**列把可选项也数了进去（那是事实），而**结论**列只把
必需项的缺失当成问题。

## 宿主

| DSH 版本 | 安装形态 | 安装位置 | 在适配范围内 | 静态可查 | 缺失 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `0.2.1-rc.2`（基准） | npx 缓存 | `D:\Cache\npm\_npx\50d2c97abf8f4186\node_modules\@deepseek-ai` | 是 | 15/17 | 2 | 与本插件适配基准一致（另 2 项可选原生入口不存在，走适配器） |
| `0.2.0-rc.2` | npx 缓存 | `D:\Cache\npm\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai` | **否** | 15/17 | 2 | **超出适配范围**（本插件只适配 `0.2.1-rc.2`） |

## 能力

| 能力 | 类型 | 可选 | `0.2.1-rc.2` | `0.2.0-rc.2` |
| --- | --- | --- | --- | --- |
| `workspace.read-state` | read |  | 已验证 | 未适配 |
| `workspace.read-table` | read |  | 已验证 | 未适配 |
| `workspace.index-shape` | read |  | — | — |
| `workspace.read-header` | read |  | 已验证 | 未适配 |
| `workspace.enqueue` | write |  | 已验证 | 未适配 |
| `workspace.set-state` | write |  | 已验证 | 未适配 |
| `workspace.index-header` | write |  | 已验证 | 未适配 |
| `workspace.archive-native` | write | 可选 | 已验证 | 未适配 |
| `workspace.unarchive-native` | write | 可选 | 已验证 | 未适配 |
| `workspace.batch-native` | write | 可选 | 不可用 | 不可用 |
| `workspace.delete-native` | delete | 可选 | 不可用 | 不可用 |
| `sessions.detach-live` | delete |  | 已验证 | 未适配 |
| `sessions.cold-announce` | delete |  | 已验证 | 未适配 |
| `projection.write` | write |  | 已验证 | 未适配 |
| `projection.table-delete` | delete |  | — | — |
| `projection.delete-native` | delete | 可选 | — | — |
| `settings.document-path` | read |  | 已验证 | 未适配 |
| `fs.patch-io` | write |  | — | — |
| `preset.roster-surface` | read |  | — | — |
| `agentPreset.register` | write |  | 已验证 | 未适配 |
| `tools.restrict-method` | write |  | 已验证 | 未适配 |
| `agent.created-event` | read |  | — | — |
| `connection.admit` | read |  | 已验证 | 未适配 |

## 操作

一项操作可用，意味着它需要的**每一项**能力都齐备 —— 插件不会从「部分可用」悄悄滑进另一条路由。
「原生」是宿主自己的入口；「适配器」是插件在宿主公开成员上拼出来的等价路径。

| 操作 | `0.2.1-rc.2` | `0.2.0-rc.2` |
| --- | --- | --- |
| archive | 可用（原生） | 可用（原生） |
| unarchive | 可用（原生） | 可用（原生） |
| batch | 可用（适配器） | 可用（适配器） |
| delete | 待确认 | 待确认 |
| list | 待确认 | 待确认 |

「待确认」的来由：delete 卡在 `projection.table-delete`；list 卡在 `workspace.index-shape`。这几项读的是活实例上的字段与行为，静态视图看不到。

## 复现

```bash
node scripts/compat-matrix.mjs             # 重新生成本文件
node scripts/compat-matrix.mjs --dry-run   # 只打印到终端，不写文件
node scripts/doctor.mjs                    # 只看当前这台机器的宿主（含活宿主探测）
```

本脚本在 `mkdtemp` 出来的临时 `DSH_HOME` 下运行，每个宿主单独一个子进程，
只读宿主安装目录，**不读写真实的 `~/.dsh`**。找不到任何宿主时它会原样保留本文件并退出 1 ——
一份过期的表比没有表更糟。
