# Changelog

## [Unreleased]

- **破坏性变更：清单标记仅支持英文** —— 会话模式标记收窄为 `[new]` / `[continue]`（大小写不敏感）；中文标记 `[新会话]` / `[继续]` 不再被识别，含此类字样的行将整体作为标题处理。`--dry-run` 预览与示例文件、README 同步更新。已有进度文件不受影响（进度仅存模式枚举，不存标记文本），但**旧清单文件需手工改标记后才能继续使用**。
- 工程标准化（无功能改动，运行时行为与 157 项单测完全一致）：
  - 引入 **ESLint**（typescript-eslint recommended）与 **Prettier**（配置贴近原有风格：tab 缩进、150 列、双引号），取代 VS Code 内置格式化器 + 自写 verify-formatting 校验脚本；`npm run lint` / `npm run format` / `npm run format:check`。
  - 全部代码注释英文化并补齐 TSDoc（`@param` / `@returns` / `@throws` / `@example`）；用户可见的 UI 文案（命令提示、通知、清单语法、报告内容）保持中文不变。
  - 测试标题（describe/it）同步英文化；断言中的中文 UI 字符串不变。
  - 代码异味清理：移除 `adaptCtx` 与 `startBatch` 调用点的非空断言 `!`（改为局部常量 + 不变式守卫）；`let tasks` 补充显式类型；移除未使用变量/导入。
  - pre-commit hook 改为对暂存文件运行 ESLint + Prettier 检查；`.vscode` 默认格式化器切换为 Prettier。

## [1.0.1] - 2026-11-12

- 升级类型 devDependency `@earendil-works/pi-coding-agent` 至 **1.5.2**（运行时仍零外部依赖，无功能改动；所用扩展 API 经 1.4.0 → 1.5.2 逐一核对无签名变化，typecheck 与 157 项单测全绿）。
- README 补充 pi 1.5.x 行为说明：pi 1.5.0+ 在任务运行中会直接拒绝 `/reload`（任务间空闲窗口执行仍会破坏批次）；pi 1.5.2 起断点续跑 `switchSession` 遇前置会话原始目录缺失会弹 Continue / Fork / Cancel 对话框。
- 分发包附带 CHANGELOG.md：pi 1.5.0+ 会在扩展更新后的下次启动显示更新摘要。

## [1.0.0] - 2026-10-26

- 首个版本：`/batch` 命令在单个 TUI 窗口顺序执行清单任务，支持 `[新会话]`/`[继续]` 模式、`name:` 会话命名、自动重试（`--retries`）、重试耗尽策略（`--on-exhaust`）、断点续跑（progress 文件）、`--dry-run` 预览、汇总报告与状态栏 widget，`/batch stop`（温和/立即）与 `/batch status` 子命令。
