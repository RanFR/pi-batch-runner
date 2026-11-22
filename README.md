<div align="center">

# pi-batch-runner

**[pi](https://github.com/earendil-works/pi) 的批处理扩展：一条命令，跑完整批提示词任务**

在同一个 TUI 窗口中，按清单文件顺序逐个执行多个互不相关的任务 —— 顺序执行、自动重试、断点续跑，完成后停留在 pi 中供检查。

[特性](#特性) · [快速开始](#快速开始) · [用法](#用法) · [清单文件格式](#清单文件格式) · [运行行为](#运行行为) · [开发](#开发)

</div>

---

## 为什么需要它

单位局域网内的大模型算力有限，无法并发运行多个 pi 实例；手动开多个窗口、逐条粘贴提示词既繁琐又容易漏跑。pi-batch-runner 把「一批任务」变成一个清单文件，一条命令启动：引擎按顺序逐条执行，单条失败自动重试，中途断掉可以续跑，全部完成后给出汇总报告。

## 特性

**顺序执行，上下文隔离**
默认每个任务都在全新会话中运行（互不污染），可通过 `name:` 字段为新会话显式命名，效果等同单独在 pi 中输入 `/name`。

**会话接力**
标记为「继续」的任务沿用上一个任务的会话，适合「先重构、再补测试」这类有前后依赖的组合；首条任务标记「继续」时，直接在当前交互会话中执行。

**自动重试与耗尽策略**
任务以 error 收场时自动重试（`--retries`，默认 3 次）；重试耗尽后按 `--on-exhaust` 决定暂停询问、跳过继续，还是终止整批。

**断点续跑**
进度文件实时落盘。批次中断后再次启动，pi 会询问「从断点继续 / 从头重新开始 / 取消」，断点是「继续」任务时自动找回前置会话。

**汇总报告**
全部任务定案后：通知汇总 + 编辑器上方常驻 widget + 写入 `<清单文件>.report.md`，并停留在 pi 中（不自动退出）。

**随时干预**
`Esc` 中止当前任务、`/batch stop` 温和停止、`/batch stop --now` 立即终止、`/batch status` 查看进度。

## 快速开始

### 环境要求

- [pi](https://github.com/earendil-works/pi) 1.6.0，TUI 交互模式（print / rpc / json 模式没有交互 UI，启动时会被拒绝）
- Node.js ≥ 20

### 安装

```bash
# 方式一：symlink 本仓库到扩展目录
ln -s /path/to/pi-batch-runner ~/.pi/agent/extensions/batch-runner

# 方式二：开发期临时加载，不必放入扩展目录
pi -e /path/to/pi-batch-runner
```

离线机器安装：在联网机器上执行 `npm run pack`，得到 `dist/pi-batch-runner-<version>.tar.gz`（附 sha256 校验），拷贝到目标机解压后运行包内安装脚本：

```bash
# Linux / macOS（--copy 复制安装，默认 symlink；--force 覆盖已有安装）
bash install.sh

# Windows PowerShell 5.1+（默认 Junction 安装，无需管理员；-Copy / -Force / -Target <dir>）
powershell -ExecutionPolicy Bypass -File install.ps1
```

安装包为白名单打包，运行时零外部依赖（仅 Node 内置模块），目标机无需 `npm install`。

重启 pi 后，`/batch` 命令即可使用。

### 编写第一个清单

新建 `tasks.md`（语法见[清单文件格式](#清单文件格式)，示例见 [`examples/tasks.example.md`](examples/tasks.example.md)）：

```markdown
# 2025-06-20 数据平台批次
首个 --- 之前的内容整段忽略，可写批次说明。

---
[new] 重构数据导入模块
把 src/import/ 下的解析器重构为流式实现，保持现有测试通过。

---
[continue] 补充导入模块边界测试
基于上一个任务的重构结果，补充错误路径的单元测试。
```

### 启动批次

```bash
/batch tasks.md --dry-run   # 建议先预览任务列表，确认无误后再正式执行
/batch tasks.md             # 启动
```

## 用法

```
/batch <清单文件>                      启动批处理（相对路径基于 cwd；含空格用引号包裹）
/batch <清单文件> --dry-run            仅解析并预览任务列表，不执行
/batch <清单文件> --start <N>          从第 N 条任务开始（1-based，之前的任务标记为跳过）
/batch <清单文件> --retries <N>        覆盖自动重试次数（默认 3）
/batch <清单文件> --on-exhaust <mode>  重试耗尽后的行为：pause（默认）/ skip / abort
/batch stop                            温和停止：当前任务自然结束后停止，不再推进
/batch stop --now                      立即中止当前任务并停止整批
/batch status                          查看当前/最近批次的进度与各任务状态
```

### 选项

| 选项 | 说明 | 默认值 |
|---|---|---|
| `--dry-run` | 仅解析清单并预览任务列表，不执行 | 关闭 |
| `--start <N>` | 从第 N 条任务开始（1-based），之前的任务标记为跳过 | `1` |
| `--retries <N>` | 单条任务失败后的自动重试次数 | `3` |
| `--on-exhaust <mode>` | 重试耗尽后的行为，取值见下表 | `pause` |

`--on-exhaust` 三种取值：

- `pause`（默认）：弹选择框询问（重试本条 / 跳过，继续下一条 / 终止整批）；关闭对话框视为终止
- `skip`：记录失败并继续下一条
- `abort`：终止整批，进入汇总

### 关于 `@` 文件补全

pi 编辑器输入 `@` 会触发文件补全，而补全结果以 `@路径` 原样进入命令参数。`/batch` 会自动剥掉这个前缀，因此 `/batch @tasks.md`、`/batch @"含 空格.md"` 与裸路径写法完全等价；`@` 出现在路径内部或引号内时按字面处理。

### 断点续跑时的选项语义

本次命令行**显式传入**的 `--retries` / `--on-exhaust` 会覆盖进度文件中保存的上次配置（并提示），未传入则沿用上次配置；`--start` 在续跑时被忽略（起点由断点决定，选择「从头重新开始」时 `--start` 正常生效）。

## 清单文件格式

纯文本、肉眼可读，以单独一行 `---` 分隔任务条目；首个 `---` 之前的内容整段忽略（可写批次说明）。完整示例见 [`examples/tasks.example.md`](examples/tasks.example.md)。

### 规则

1. **标题与正文**：每条任务的第一行是标题（用于状态栏、进度与汇总），其余行为提示词正文；只有一个条目一行时，该行同时作为标题与提示词。正文空行保留，整体 trim；兼容 CRLF；UTF-8；解析结果为 0 个任务时报错。
2. **会话标记**：`[new]` / `[continue]`（大小写不敏感，仅支持英文）写在首行开头；无标记默认**新会话**（安全默认：上下文隔离）。「继续」任务沿用上一个任务的会话；**首条任务标记「继续」时，在当前交互会话中执行**（可用它接着手工会话跑批次）。
3. **保留字段**：裸标记行（标记后无标题）之后、标题行之前，允许出现 `key: value` 字段行：`name:` 为显式会话命名，仅对「新会话」条目有效（「继续」条目带 `name:` 或值为空报错；重复 `name:` 以最后一个为准；不写 `name:` 则新会话不命名）；`model:` / `timeout:` / `retries:` / `max-turns:` / `on-exhaust:` 当前版本识别后忽略（为未来扩展预留）。标题确定后出现的 `key: value` 行一律视为正文，普通文本不会被吞掉。
4. **模板展开**：提示词中的 `@文件` 引用与模板由 pi 正常展开（`expandPromptTemplates: true`），与手工输入行为一致。

## 运行行为

- **执行**：逐条顺序执行；「新会话」任务通过 `newSession` 切入全新会话（当前交互会话不被污染），并按清单 `name:` 字段为新会话显式命名；未指定 `name:` 时新会话不命名。
- **完成判定**：`agent_settled` 事件 + `waitForIdle()` 双保险。失败判定读分支上最后一条 assistant 消息的 `stopReason`（`error` / `aborted`）。pi 自身的 run 内瞬时错误重试照常工作，本扩展的重试针对**最终以 error 收场**的运行；「模型答非所问」不可检测、不在范围内。
- **发送看门狗**：若发送后长时间没有任何运行启动（新会话发送 10 秒、根会话 void 发送放宽到 60 秒，以容忍慢认证 / 弱网），按发送失败处理并重试；若检测到运行已结束但未收到完成事件（如 `/reload` 后事件桥断裂），会给出对应提示。
- **中断**：任务运行中按 `Esc` 会中止当前任务并弹出选择框（重试 / 跳过 / 终止），不会静默继续。
- **进度文件**：`<清单文件>.progress.json` 随执行实时落盘，批次结束后改名 `.progress.json.done`。启动时若存在未完成进度会询问「从断点继续 / 从头重新开始 / 取消」；断点是「继续」任务时自动 `switchSession` 找回前置会话（会话文件丢失则降级为新会话并提示）。若目标会话的原始工作目录已被移动 / 删除，pi 会先弹出 Continue / Fork / Cancel 对话框——选择 Fork 将在当前目录以新会话继续批次，选择 Cancel 视为会话切换被取消并收尾批次。
- **汇总**：全部任务定案后，notify 汇总 + 编辑器上方常驻 widget + 写入 `<清单文件>.report.md`，停留在 pi 中（不自动退出）。

## 运行中干预

| 操作 | 效果 |
|---|---|
| `Esc` | 中止当前任务，弹出重试 / 跳过 / 终止选择框 |
| `/batch stop` | 温和停止：当前任务自然结束后不再推进 |
| `/batch stop --now` | 立即中止当前任务并终止整批 |
| `/batch status` | 查看当前 / 最近批次的进度与各任务状态 |
| `/reload` | **禁止**：扩展模块被重新求值，运行中批次的事件桥断裂，此后每个任务都会被看门狗误判为失败。任务运行中 pi 会直接拒绝 `/reload`（报错等待运行结束），但**任务间空闲窗口**执行 `/reload` 仍会破坏批次。请先 `/batch stop` 再 `/reload` |
| `/new` / `/resume` / `/fork` | 不建议：引擎持有的会话上下文失效，批次会以内部错误结束（汇总报告仍会生成） |
| 直接输入新消息 | 会被 pi 排队在当前 run 之后执行，批处理相应推迟——**不建议**；需要干预用上表操作 |

## 开发

```bash
npm install        # 安装 devDependencies
npm run typecheck  # tsc --noEmit
npm test           # vitest（parser / executor / progress / report / command 单测，不依赖真实 pi 进程与模型）
npm run lint       # ESLint
npm run format     # Prettier（format:check 仅校验）
npm run pack       # 打包离线分发包到 dist/
```

运行时零外部依赖（仅 Node 内置模块）；`@earendil-works/pi-coding-agent` 仅作为 devDependency 供类型检查。`lib/` 下的模块不依赖 pi 的类型（单元测试用手写 fake 驱动引擎），pi 的真实类型只在入口 `index.ts` 做结构化适配。

### 目录结构

```
index.ts            扩展入口：命令注册、参数处理、类型适配、事件桥、stop/status 子命令
lib/types.ts        类型与常量（BatchTask / BatchState / 引擎窄接口 / 可注入依赖）
lib/parser.ts       清单解析 + 参数 tokenize
lib/executor.ts     执行引擎（重试、会话边界闭包链、断点起点、汇总收尾）
lib/progress.ts     progress / report 文件读写与 done 改名
lib/report.ts       状态栏 / widget / report.md 渲染
test/               单元测试与 fixtures
examples/           示例清单
scripts/pack.sh     离线分发包打包脚本（含 install.sh / install.ps1 生成）
```

### 诊断

设 `PI_BATCH_DEBUG=1` 启动 pi，引擎与命令层会向 `/tmp/pi-batch-debug.log` 追加日志。

## 许可证

本项目基于 MIT 许可证发布，作者 [RanFR](https://github.com/RanFR)。
