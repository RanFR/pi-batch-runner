# pi 批处理扩展开发计划

> 本文档是完整的开发任务书，供后续编码模型直接执行。开发前请通读全文，特别是「关键技术陷阱」一节——其中每一条都来自对 pi 1.4.0 扩展 API 类型声明的逐一核对，违反任何一条都会导致死锁、静默失效或状态丢失。

## 1. 背景与目标

用户需要顺序执行多个互不相关的提示词任务。现状是同时开多个 pi 窗口手动输入，存在两个问题：单位局域网大模型算力不足，无法支撑并发；手动开多个实例繁琐。

目标：提前准备好一份任务清单文件，在 pi 交互界面（TUI）中一条命令启动，扩展按顺序逐个执行：

1. 默认每个任务在**全新会话**中执行（上下文完全隔离，避免任务间互相占用上下文）；
2. 标记为「继续」的任务沿用上一个任务的会话（处理偶发的关联性任务）；
3. 单个任务失败时自动重试（次数可配置），重试耗尽后暂停并询问用户；
4. 全部执行完毕后显示汇总报告，停留在 pi 中供检查，不自动退出。

全程只在**一个 TUI 窗口**中运行和观察。

### 1.1 已与用户确认的决策

| 决策点 | 结论 |
|---|---|
| 运行形态 | TUI 单窗口观察（非无人值守脚本化） |
| 任务来源 | 单个清单文件，分隔符分条，每条标记「新会话/继续」 |
| 失败策略 | 自动重试 N 次（N 可配置）；重试耗尽后暂停并弹出选择框询问用户（重试/跳过/终止） |
| 全部完成后 | 显示执行汇总，停留在 pi 中，由用户手动退出 |

### 1.2 方案选型（为什么是扩展）

| 备选方案 | 否决原因 |
|---|---|
| shell 循环逐条跑 `pi -p "提示词"` | 每条一个新进程无法实现「同会话关联任务」（除非用 `--session-id` 链接，但无统一控制）；无 TUI 观察体验；无重试/暂停交互 |
| `pi --mode rpc` 外部驱动脚本 | RPC 模式无 TUI 界面，不满足「单窗口观察」 |
| 修改 pi 源码 | 用户明确要求不改动 |

pi 1.4.0 扩展 API 已具备全部所需原语（见第 3 节），纯扩展可实现，无需改源码。

## 2. 运行环境与交付物

- 目标版本：**pi 1.4.0**（`@earendil-works/pi-coding-agent` 精确版本 1.4.0，作为 devDependency 仅用于类型检查）。
- 扩展运行在 pi 进程内（jiti 加载 TS，无需编译步骤），运行时零外部依赖，只用 Node 内置模块（`fs`、`path`）。
- 开发目录：本仓库（即本文件所在目录），仓库根即扩展目录（`index.ts` 在根下）。
- 安装方式：将本目录（或其 symlink）放入 `~/.pi/agent/extensions/batch-runner/`；开发期用 `pi -e <本目录绝对路径>` 在任意测试工程中加载。
- 明确只支持 TUI 模式（`ctx.mode === "tui"`）：非 TUI 模式下执行 `/batch` 直接 `ctx.ui.notify` 报错并拒绝（print/rpc/json 模式没有交互 UI，暂停询问等流程无法工作）。

目录结构：

```
pi-batch-runner/               # 仓库根 = 扩展目录
├── PLAN.md                    # 本文档
├── package.json               # devDeps: @earendil-works/pi-coding-agent@1.4.0, typescript, vitest
├── tsconfig.json              # 仅类型检查用
├── index.ts                   # 扩展入口：注册命令、session_start 处理
├── lib/
│   ├── parser.ts              # 清单文件解析
│   ├── executor.ts            # 执行引擎（核心）
│   ├── progress.ts            # 进度文件读写
│   ├── report.ts              # 汇总渲染与状态栏文案
│   └── types.ts               # BatchTask / TaskStatus / RunConfig 等类型
├── test/
│   ├── parser.test.ts
│   ├── executor.test.ts       # mock ExtensionAPI 驱动执行引擎
│   └── fixtures/*.md          # 清单格式测试样例
└── examples/tasks.example.md  # 给用户的示例清单
```

## 3. 可行性依据（1.4.0 API 对照）

以下 API 均已核对 1.4.0 发行包的 `dist/core/extensions/types.d.ts` 与 `@earendil-works/pi-ai` 类型声明：

| 需求 | API | 说明 |
|---|---|---|
| 注册命令 | `pi.registerCommand(name, { description, getArgumentCompletions?, handler })` | handler 收到 `(args: string, ctx: ExtensionCommandContext)` |
| 发送提示词 | `pi.sendUserMessage(content, { expandPromptTemplates })`（void，触发一轮运行）；会话切换后用 `ReplacedSessionContext.sendUserMessage` | 见陷阱 2 |
| 等待任务真正结束 | `pi.on("agent_settled", ...)`（事件带 `aborted: boolean`）+ `ctx.waitForIdle()` 双保险 | 见陷阱 3 |
| 失败判定 | settled 后读最后一条 assistant 消息的 `stopReason`（`"error"` / `"aborted"`，含 `errorMessage`） | `AssistantMessage.stopReason: StopReason` |
| 新开会话 | `ctx.newSession({ withSession })`，回调收到 `ReplacedSessionContext`（继承 ExtensionCommandContext，且额外有 `sendUserMessage`/`sendMessage`） | 见陷阱 2 |
| 同会话继续 | 不切换会话，直接再次 `sendUserMessage` | |
| 恢复指定会话 | `ctx.switchSession(sessionPath, { withSession })` | 用于断点续跑关联任务 |
| 暂停询问 | `ctx.ui.select(title, options, opts?)` / `ctx.ui.confirm` / `ctx.ui.notify` | `ExtensionUIContext` |
| 状态栏 | `ctx.ui.setStatus(key, text \| undefined)` | 批处理进度常驻 footer |
| 完成后停留 | 什么都不做即停留（不调用 `ctx.shutdown()`） | 用户已确认 |
| 读取当前会话文件路径 | `ctx.sessionManager`（具体方法名以类型声明为准，开发时核对 `session-manager.d.ts`） | 写入进度文件，供续跑 |

## 4. 清单文件格式规范

设计原则：肉眼可读、纯文本、最小心智负担。示例（`examples/tasks.example.md`）：

```markdown
# 2025-06-20 数据平台批次
首个 --- 之前的内容整段忽略，可写批次说明、日期等。

---
[新会话] 重构数据导入模块
把 src/import/ 下的解析器重构为流式实现，保持现有测试通过。
提示词正文支持任意多行，直到下一个 --- 或文件结束。

---
[继续] 补充导入模块边界测试
基于上一个任务的重构结果，补充错误路径的单元测试。

---
修复登录页样式
（没有标记时默认视为 [新会话]）
```

解析规则：

1. 以单独一行 `---`（前后允许空白）分隔任务条目；首个 `---` 之前的内容全部忽略。
2. 每个条目第一行若匹配 `^\[(新会话|new)\]` 或 `^\[(继续|continue)\]`（大小写不敏感），则为模式标记行；无标记时默认「新会话」（安全默认：隔离）。
3. 标记行中标记之后、或（无标记时）条目第一行非空文本 = 任务标题（用于状态栏、进度、汇总、会话命名）；其余非空行为提示词正文。标题可选：若第一行与正文难以区分，规则定为——第一行是标题，其余是正文；若条目只有一行，则标题 = 正文首行。
4. 提示词正文中的空行保留（拼接后 trim 首尾）；`@路径` 引用不在此展开，交给 `sendUserMessage({ expandPromptTemplates: true })` 按 pi 正常规则处理。
5. 首条任务标记为「继续」时：在**当前交互会话**中继续执行（文档中说明该行为，用户可用它接着手工会话跑批次）。
6. 编码 UTF-8；行尾兼容 CRLF/LF。
7. 解析结果为 0 个任务时报错。

v1 不支持的任务级字段（`model:`、`timeout:` 等）留到 P3（见第 9 节），格式设计时在解析器中预留「未来扩展字段行（`key: value` 形式的条目头部行）」的忽略逻辑即可，不实现语义。

## 5. 命令接口

```
/batch <清单文件>                  启动批处理（相对路径基于 cwd）
/batch <清单文件> --dry-run        仅解析并预览任务列表，确认后不执行
/batch <清单文件> --start <N>      从第 N 条任务开始（1-based）
/batch <清单文件> --retries <N>    覆盖默认重试次数（默认 2）
/batch <清单文件> --on-exhaust <mode>   重试耗尽后的行为：pause（默认，弹选择框）/ skip / abort
/batch stop                        温和停止：当前任务自然结束后停止，不再推进
/batch stop --now                  立即中止当前任务（ctx.abort()）并停止
/batch status                      显示当前批次进度（任务游标、各任务状态）
```

- 参数用简单空格切分即可（路径不含空格的场景；含空格路径提示用户用引号包裹，手动解析引号）。
- `getArgumentCompletions`：对第一个参数提供 cwd 下 `.md`/`..txt` 文件的补全（读取目录，返回 `AutocompleteItem[]`；实现时以 pi-tui 类型声明为准）。
- 启动前置检查，任一不满足则 `notify` 报错返回：
  - `ctx.mode === "tui"`；
  - 当前无正在进行的批次（模块级 `activeBatch` 标志）；
  - `ctx.isIdle() === true`（有流式任务时拒绝，提示先等空闲）；
  - 清单文件存在且解析成功。

## 6. 核心设计：执行引擎

### 6.1 总体结构

执行引擎由**命令 handler 驱动**（不是事件驱动——见陷阱 1）。一条 `/batch` 命令的 handler 调起引擎，引擎顺序处理任务；遇到「新会话」边界时通过 `newSession({ withSession })` 的回调链把执行控制权带到新会话，闭包链携带纯数据状态。

```
模块级状态（仅用于防重入与 stop 标志，不用于跨会话数据）:
  activeBatch: BatchHandle | null      // { stopFlag: "no" | "gentle" | "now", startedAt }
  batchState: BatchState | null        // 见 6.5，同步镜像到 progress 文件

handler(args, ctx):
  解析参数 → 读清单 → parser 解析 → dry-run 则预览返回
  → 检测未完成 progress（见 6.6）→ 初始化 BatchState
  → engine.run(firstLeg)   // firstLeg = { ctx, send: pi.sendUserMessage }
```

### 6.2 单条任务的执行与完成判定（最关键逻辑）

```typescript
// 伪代码。sendOnce 抽象自 pi.sendUserMessage 或 ReplacedSessionContext.sendUserMessage，
// 便于单测 mock。
async function runTask(leg, task, onOutcome): Promise<"ok" | "error" | "aborted"> {
  // (1) 先订阅，再发送（防竞态：settled 必须在 send 之前挂上）
  let settled: { aborted: boolean } | undefined;
  let latch = new Promise(resolve => { off = pi.on("agent_settled", e => { settled = e; resolve(); }); });

  // (2) 发送提示词（expandPromptTemplates: true，让 @文件 / 模板与手工输入行为一致）
  leg.send(task.prompt, { expandPromptTemplates: true });

  // (3) 等待 settled；兜底：若 send 后 10 秒既无 agent_start 也一直 isIdle，视为发送失败（按失败重试处理）
  await withTimeout(latch, ...);

  // (4) 双保险：settled 后再 waitForIdle()（正常立即返回；若期间用户排队了新消息会自然等到其结束）
  await leg.ctx.waitForIdle();

  // (5) 结果判定
  if (settled.aborted) return "aborted";                    // 用户按了 Esc
  const last = lastAssistantMessage(leg.ctx);               // ctx.sessionManager 分支上最后一条 assistant 消息
  if (last?.stopReason === "error" || last?.stopReason === "aborted") return "error"; // 附 last.errorMessage
  return "ok";
}
```

要点：

- **不能只等 `agent_end`**：agent_end 之后 pi 可能因重试、恢复、压缩重试、排队消息再开新 run；`agent_settled` 才表示「不会再自动继续」。
- **`sendUserMessage` 返回 void**，完成检测完全依赖事件 + `waitForIdle`。
- `lastAssistantMessage` 从 `ctx.sessionManager` 当前分支取最后一条 `role === "assistant"` 的消息（方法名开发时核对 `session-manager.d.ts`）。
- 发送前若 `ctx.hasPendingMessages()`（用户恰好插入了排队消息）：等待其消化完（`waitForIdle` + settled）后再发送，用小循环实现，设上限防死等。

### 6.3 失败重试与暂停询问

```
attempts = 0
loop:
  outcome = runTask(...)
  if outcome == ok: 记录成功（含耗时、会话文件路径）→ 下一条
  if outcome == error:
    attempts++
    if attempts <= retries:
      notify("任务 N 失败（第 attempts/次），重试…", "warning"); 短暂等待后原样重发（同会话）
    else:
      按 onExhaust 配置：
        pause  → ctx.ui.select("任务 N 重试耗尽", ["重试本条(同会话)", "跳过，继续下一条", "终止整批"])
                 选择结果分别处理；对话框无超时（等人）
        skip   → 记录 skipped，继续下一条
        abort  → 终止整批，进入汇总
  if outcome == aborted:   // 用户 Esc 打断了当前任务
    ctx.ui.select("任务 N 被手动中断", ["重试本条", "跳过，继续下一条", "终止整批"])  // 固定交互，不受 onExhaust 影响
```

注意：pi 自身对瞬时网络/接口错误已有 run 内自动重试；这里的重试针对**最终**以 error 收场的运行。「模型答非所问」不属于可检测失败，不在范围内（文档明示）。

### 6.4 会话边界：闭包链推进

```
async function runFrom(leg, tasks, i):
  while i < tasks.length:
    task = tasks[i]
    if task.mode == "新会话":
      记录 pendingSessionName 到 state 文件（见 6.7）
      await leg.ctx.newSession({
        withSession: (fresh) => runFrom({ ctx: fresh, send: fresh.sendUserMessage }, tasks, i)  // i 从本条重新开始
      })
      return   // 控制权已移交 fresh 回调，旧 leg 就地结束
    else:  // 「继续」或批次首条被标记继续
      outcome = 执行并处理重试/暂停（6.3，可能改写 i）
      i++
  全部完成 → 汇总（6.8）
```

- 首条任务为「新会话」时立即 `newSession`；当前交互会话保持原样不动（用户手工会话不被污染）。
- 回调链深度 = 「新会话」边界数。每个 `withSession` 回调内部同会话任务用 while 循环处理，不递归。
- 嵌套回调中捕获的只能是纯数据（任务数组、BatchState 对象、配置）；禁止捕获旧 `pi`、旧 `ctx`（陷阱 2）。
- `newSession` 返回 `{ cancelled: true }`（被 `session_before_switch` 处理器取消）时：视为终止整批，进入汇总。

### 6.5 BatchState（内存对象 + 落盘镜像）

```typescript
interface TaskRecord {
  index: number; mode: "new" | "continue"; title: string;
  status: "pending" | "running" | "ok" | "failed" | "skipped";
  attempts: number; sessionFile?: string; error?: string;
  startedAt?: number; endedAt?: number;
}
interface BatchState {
  file: string; startedAt: number; updatedAt: number;
  retries: number; onExhaust: "pause" | "skip" | "abort";
  tasks: TaskRecord[];   // status 汇总即进度
}
```

- 进度文件：清单文件旁 `<清单文件名>.progress.json`，每次状态变化即写（任务数有限，整体重写即可）。
- 任务开始/结束时记录 `sessionFile`（当前会话文件路径）。「继续」任务与其前置任务 sessionFile 相同。
- 批次正常结束（全部 ok/skipped/failed 定案）或被终止后：progress 文件保留（作为报告数据源），并在汇总后重命名为 `<清单文件名>.progress.done.json`，避免下次误触发续跑询问。

### 6.6 断点续跑

`/batch <文件>` 启动时若存在 `<文件>.progress.json`（未 done）且有 `pending/running` 任务：

```
ctx.ui.select("检测到未完成的批次", ["从断点继续", "从头重新开始", "取消"])
```

- 从断点继续：从第一个非终态任务开始。
  - 若该任务为「新会话」→ 走正常 `newSession` 流程；
  - 若该任务为「继续」→ 其前置任务记录了 `sessionFile`，先 `switchSession(sessionFile, { withSession: fresh => runFrom(fresh leg, ...) })`；若文件已不存在或前置任务无记录，降级为「新会话」执行并 notify 说明。
- 从头重新开始：备份旧 progress 后重新初始化。

### 6.7 新会话命名（P2，机制此处定死）

`pi.setSessionName` 只在 ExtensionAPI 上，而切换后旧 `pi` 失效、`ReplacedSessionContext` 上没有该方法。方案：

1. 调 `newSession` **之前**把 `{ pendingName: "批次标题 · 任务N 标题" }` 写入 progress 文件；
2. 扩展注册 `pi.on("session_start")`（`reason === "new"` 时）：读 progress 文件，若有 `pendingName` 则 `pi.setSessionName(name)` 并清除字段。

该机制不依赖模块状态跨 runtime 存活（文件为载体），`session_start` 时序上先于 `withSession` 回调。P1 阶段先不实现命名，但 progress 文件的 schema 从一开始就带 `pendingName?` 字段。

### 6.8 汇总报告

全部任务定案后：

- `ctx.ui.notify("批次完成：成功 X / 失败 Y / 跳过 Z", y ? "warning" : "info")`；
- `ctx.ui.setWidget("batch-summary", lines)` 在编辑器上方常驻显示汇总表（任务号、状态、重试次数、耗时、会话文件名、错误摘要），用户可用 `/batch status` 再次弹出；
- 同时把完整报告写入清单文件旁 `<清单文件名>.report.md`；
- 清除状态栏 `setStatus("batch", undefined)`；清空 `activeBatch`；停留不退出（不调用 `ctx.shutdown()`）。

### 6.9 状态栏与运行中反馈

- 任务运行期间：`ctx.ui.setStatus("batch", "[batch] 任务 3/10 · 重构导入模块 · 第1次尝试 · 4m12s")`（节流更新，如每 5s）。
- 失败暂停等待用户选择时、批次完成时：`notify` + 终端响铃（`process.stdout.write("\x07")`）。
- 全部 UI 调用仍按 TUI-only 设计（第 2 节已保证 mode 检查）。

### 6.10 /batch stop 与用户干预

- `stop`（温和）：`activeBatch.stopFlag = "gentle"`，当前任务自然结束后引擎不再推进，进入汇总；
- `stop --now`：置 `"now"` 并 `ctx.abort()`，settled 以 aborted 到达，走 6.3 的中断询问分支——但此时该询问直接定案为「终止整批」（stop 意图明确，不再询问重试）；
- 用户在批处理运行中手动输入消息：会被 pi 排队并在当前 run 后触发新 run，settled 相应推迟——这是可接受行为，在扩展 README/文档中说明；不建议运行中插话，需要干预用 Esc 或 `/batch stop`。

## 7. 关键技术陷阱（开发必读）

1. **`newSession` / `switchSession` / `waitForIdle` 只能在命令处理器上下文中调用**（`ExtensionCommandContext` / `ReplacedSessionContext`），在事件处理器（如 `agent_settled`）里调用会死锁运行时。执行循环必须由 `/batch` 命令的 handler 驱动；`agent_settled` 订阅只用来「发信号」，不做控制流决策以外的重活。
2. **会话切换后旧上下文全部失效**：旧 `pi`（ExtensionAPI）与旧 `ctx` 在 `newSession` 完成后不可再用。切换之后的所有工作必须写在 `withSession(fresh)` 回调里，用 `fresh.sendUserMessage` / `fresh.waitForIdle` / `fresh.newSession` / `fresh.ui`；跨边界只通过闭包携带纯数据（任务数组、BatchState）。
3. **`agent_end` 不是结束信号**：重试、恢复、压缩重试、排队消息都会在 `agent_end` 后再开新 run。完成判定用 `agent_settled`（事件携带 `aborted`）+ `waitForIdle()` 双保险。
4. **订阅先于发送**：`agent_settled` 的监听必须在 `sendUserMessage` 之前挂好，否则竞态丢事件；每个任务开始前重新挂一次性 latch。
5. **不要用模块级变量承载批次数据**：会话替换（session replacement）会重建扩展 runtime，模块是否重新求值无保证。批次状态以 progress 文件为唯一事实源；模块级仅允许 `activeBatch`（防重入）与 `stopFlag`——它们丢失的最坏后果是防重入失效，可接受（重入时二次检测 progress 也能兜住）。也不要用 `pi.appendEntry()`（写入会话文件、随会话失效，且会污染模型上下文重建）。
6. **`sendUserMessage` 是 void**：不要期望它返回完成 Promise；一切等待靠事件。
7. **失败判定看 `stopReason`**：settled 后读分支上最后一条 assistant 消息，`stopReason === "error" | "aborted"`（带 `errorMessage`）才判失败；`settled.aborted === true` 表示用户 Esc。不要用「最后一条消息是否含 tool call」之类猜测。
8. **TUI-only 守卫**：所有 `ctx.ui.*` 交互前确保 `ctx.mode === "tui"`（入口统一检查即可）。扩展也会被 print/rpc/json 模式加载，勿在工厂函数里做任何启动动作（工厂里禁止进程/定时器/IO；命令注册即可）。
9. **用户排队消息的竞态**：发送前若 `ctx.hasPendingMessages()`，先等其消化（settled + waitForIdle）再发，循环设上限（如 5 分钟）防死等。
10. **回调链深度**：「新会话」边界数即 `withSession` 嵌套深度；同会话连续任务务必在回调内循环处理。几百个任务、几十个边界的批次都安全，无需 trampoline。
11. **版本锚定**：类型 devDependency 精确 `1.4.0`；不要参考主仓 main 分支的新增 API。所有 `ctx.sessionManager` 上的方法名以 1.4.0 的 `session-manager.d.ts` 为准再调用。
12. **遵守 pi 仓库规范**（若开发在 pi 源码仓中进行）：本扩展是独立目录，不触碰 pi 源码；测试不调用真实模型 API。

## 8. 测试计划

### 8.1 单元测试（vitest，不依赖真实 pi 进程）

- `parser.test.ts`：分隔符、标记（中英文、大小写）、默认新会话、标题提取、多行正文、CRLF、文件头忽略、0 任务报错、`key: value` 未来字段忽略。
- `executor.test.ts`：mock `pi` / `ctx`（手写 fake：`sendUserMessage` 记录调用并异步触发 mock `agent_settled`、`waitForIdle` 立即解决、`sessionManager` 返回构造的分支消息），覆盖：
  - 顺序执行与任务间推进；
  - error → 重试 N 次 → 成功；
  - 重试耗尽 → pause/skip/abort 三种配置路径（select mock 返回值）；
  - aborted → 三选一交互各路径；
  - 「新会话」边界 → 断言 `newSession` 调用且 `withSession` 回调内继续使用 fresh ctx；
  - 「继续」任务不触发 `newSession`；
  - progress 文件写入时机与 done 重命名；
  - `stop --now` 路径；
  - 订阅先于发送（通过调用顺序断言）。

### 8.2 TUI 手工验收（tmux）

参照 pi 仓库 `.pi/skills/interactive-testing.md` 的 tmux 方法（若无权限读该文件，用等价方式：`tmux new-session -d -x 200 -y 50 'pi -e <扩展目录>'` + `tmux send-keys`）。用一个便宜/本地模型跑 3 条任务的示例清单：

1. 观察任务 1 自动开新会话执行、settled 后任务 3（新会话）切换会话执行；
2. 「继续」任务停留在同一会话（`/status` 或会话文件数验证：2 个新会话文件、任务 2 与任务 1 同文件）；
3. 人为制造失败（临时把 provider 指向无效端点）验证重试与暂停选择框；
4. 运行中 Esc 验证中断询问；
5. `/batch stop`、`/batch stop --now`、断点续跑（中途 `Ctrl+C` 杀掉 pi 后重启 `/batch`）；
6. 状态栏、汇总 widget、report 文件内容。

### 8.3 验收标准

- [ ] `examples/tasks.example.md` 一条命令全流程跑通：默认新会话隔离、「继续」同会话；
- [ ] 失败自动重试可配置，耗尽后按配置暂停询问/跳过/终止；
- [ ] Esc 中断进入询问而非静默继续；
- [ ] 断点续跑：进程被杀后重启可从断点继续，「继续」任务能找回原会话；
- [ ] 汇总（notify + widget + report.md）数据完整：状态、次数、耗时、会话文件；
- [ ] 状态栏实时显示 `任务 N/M · 标题 · 尝试次数 · 用时`；
- [ ] 非 TUI 模式启动被拒绝并有明确提示；
- [ ] 批处理运行中二次 `/batch` 被拒绝；
- [ ] 单元测试全部通过；全程未修改 pi 源码、未引入运行时依赖。

## 9. 开发阶段划分

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| P0 | 仓库骨架、package.json/tsconfig、类型导入跑通、`/batch` 空命令注册 | `pi -e` 加载后 `/batch` 有响应 |
| P1 | parser + dry-run 预览 + 启动前置检查 + parser 单测 | 预览正确列出任务与模式 |
| P2 | 同会话执行引擎：settled 等待、失败判定、重试、状态栏；executor 单测（无边界） | 示例清单单会话连续任务自动跑完 |
| P3 | 「新会话」边界：`newSession` + `withSession` 闭包链 + 会话命名（6.7）；executor 边界单测 | 完整示例清单跑通，会话文件按预期生成且命名 |
| P4 | 暂停询问三交互、Esc 处理、`/batch stop` 两档 | 全部交互路径可演示 |
| P5 | progress 文件 + 断点续跑（含 switchSession 找回会话） | 杀进程重启后续跑成功 |
| P6 | 汇总（notify/widget/report.md）+ `/batch status` | 验收标准全部满足 |
| P7 | tmux 手工验收全清单、README（用户文档：格式、命令、行为说明、运行中插话的影响） | 交付 |

## 10. 需要用户后续提供/确认的事项

- 默认重试次数定为 3（`--retries` 可覆盖）。若期望其他默认值，在 P2 前告知。
- 「重试耗尽后暂停询问」为默认（`--on-exhaust pause`）。无人值守倾向可改默认 skip，但与 TUI 形态的决策一致优先 pause。
- 清单文件格式若希望改用其他风格（如 YAML frontmatter、目录多文件），在 P1 前提出；解析器独立成模块，替换成本低。
