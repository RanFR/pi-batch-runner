/**
 * pi-batch-runner：pi 批处理扩展。
 *
 * 在单个 TUI 窗口中顺序执行清单文件里的多个提示词任务：
 * - 默认每个任务在全新会话中执行（上下文隔离）；
 * - 标记「继续」的任务沿用上一个任务的会话；
 * - 单任务失败自动重试（--retries，默认 3），耗尽后按 --on-exhaust（默认 pause）处理；
 * - 全部完成后显示汇总并停留在 pi 中。
 *
 * 用法：
 *   /batch <清单文件> [--dry-run] [--start N] [--retries N] [--on-exhaust pause|skip|abort]
 *   /batch stop [--now]
 *   /batch status
 *
 * 仅支持 TUI 模式；print/rpc/json 模式下启动会被拒绝。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { startBatch, createStopHandle, type StartPoint, type StopHandle } from "./lib/executor.ts";
import { ManifestParseError, parseManifest, tokenizeArgs } from "./lib/parser.ts";
import * as progress from "./lib/progress.ts";
import * as report from "./lib/report.ts";
import type { BatchContext, BatchLeg, BatchState, EngineDeps, SettledBus, TaskRecord } from "./lib/types.ts";
import { DEFAULT_ON_EXHAUST, DEFAULT_RETRIES } from "./lib/types.ts";

const USAGE = [
	"用法：",
	"  /batch <清单文件> [--dry-run] [--start N] [--retries N] [--on-exhaust pause|skip|abort]",
	"  /batch stop [--now]    温和停止 / 立即中止当前任务并停止",
	"  /batch status          查看批次进度",
].join("\n");

/**
 * 模块级「接线」状态。
 *
 * 实测（pi 1.4.0）：每次会话替换（newSession/switchSession）都会新建 resourceLoader
 * 并重新执行扩展工厂函数（jiti 仅缓存工厂函数对象本身，模块只求值一次）。
 * 工厂体内的 let 变量随每次执行重建，跨替换不可用；只有模块级变量存活。
 *
 * 因此这里只允许存放「接线」性质的状态：事件监听槽位、防重入标志。
 * 批次数据一律以 progress 文件为唯一事实源（PLAN 陷阱 5）。
 *
 * ⚠ /reload 会以新代际重新求值本模块：settledListener / activeBatch 全部归零。
 * 运行中批次的引擎闭包仍持有旧的 SettledBus（写入旧模块实例的槽位），而事件只会
 * 派发给新实例注册的处理器 → 引擎永远收不到 agent_settled，看门狗逐任务误判
 * send-failed，批次退化为失败循环。批处理期间禁止 /reload（README「运行中干预」）。
 */
let settledListener: ((event: { aborted: boolean }) => void) | undefined;
let activeBatch: ActiveBatch | null = null;

interface ActiveBatch {
	stop: StopHandle;
	listFile: string;
}

/** 诊断日志：设 PI_BATCH_DEBUG=1 时写 /tmp/pi-batch-debug.log */
function debugCmd(msg: string): void {
	if (!process.env.PI_BATCH_DEBUG) return;
	try {
		fs.appendFileSync("/tmp/pi-batch-debug.log", `${new Date().toISOString()} [cmd] ${msg}\n`);
	} catch {
		// ignore
	}
}

/**
 * 会话切换回调拿到的 fresh 上下文类型（ReplacedSessionContext）。
 * 1.4.0 包根未导出该类型名，从 newSession 的 withSession 回调签名结构推导。
 */
type ReplacedSessionContext = Parameters<
	NonNullable<
		NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["withSession"]
	>
>[0];

/** 引擎所需的窄上下文视图（ExtensionCommandContext / ReplacedSessionContext 的结构子集） */
function adaptCtx(ctx: ExtensionCommandContext): BatchContext {
	return {
		isIdle: () => ctx.isIdle(),
		hasPendingMessages: () => ctx.hasPendingMessages(),
		waitForIdle: () => ctx.waitForIdle(),
		abort: () => ctx.abort(),
		sessionManager: {
			getSessionFile: () => ctx.sessionManager.getSessionFile(),
			getBranch: () => ctx.sessionManager.getBranch().map(adaptEntry),
		},
		ui: {
			select: (title, options) => ctx.ui.select(title, options),
			notify: (message, type) => ctx.ui.notify(message, type),
			setStatus: (key, text) => ctx.ui.setStatus(key, text),
			setWidget: (key, content) => ctx.ui.setWidget(key, content),
		},
		newSession: (opts) =>
			ctx.newSession({
				// 新会话命名：经 setup 直写 sessionManager（会话替换后旧 pi 门面不可用）
				...(opts.name
					? {
						setup: async (sm: { appendSessionInfo: (name: string) => string }) => {
							sm.appendSessionInfo(opts.name!);
						}
					}
					: {}),
				withSession: (fresh) => opts.withSession(adaptFreshLeg(fresh)),
			}),
		switchSession: (p, opts) =>
			ctx.switchSession(p, {
				withSession: (fresh) => opts.withSession(adaptFreshLeg(fresh)),
			}),
	};
}

/** 把切换后的真实上下文包成引擎所需的完整 leg（新上下文 + 对应的发送函数） */
function adaptFreshLeg(fresh: ReplacedSessionContext): BatchLeg {
	return {
		ctx: adaptCtx(fresh),
		send: (content, options) => fresh.sendUserMessage(content, options),
	};
}

function adaptEntry(entry: SessionEntry): ReturnType<BatchContext["sessionManager"]["getBranch"]>[number] {
	if (entry.type === "message") {
		const m = entry.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
		return {
			type: entry.type,
			message: m ? { role: m.role ?? "", stopReason: m.stopReason, errorMessage: m.errorMessage } : undefined,
		};
	}
	return { type: entry.type };
}

export default function batchRunnerExtension(pi: ExtensionAPI): void {
	// agent_settled 事件桥：每次工厂执行都在当前 runner 上重新注册处理器
	// （旧 Extension 对象随旧 runner 一起被丢弃），处理器与引擎通过模块级
	// 监听槽位对接，不捕获任何 pi/ctx 运行时对象。
	pi.on("agent_settled", (event) => {
		settledListener?.({ aborted: event.aborted });
	});
	const settledBus: SettledBus = {
		subscribe(cb) {
			settledListener = cb;
			return () => {
				if (settledListener === cb) settledListener = undefined;
			};
		},
	};

	pi.registerCommand("batch", {
		description: "批处理：顺序执行清单中的提示词任务（/batch <清单.md> [选项] | stop | status）",
		getArgumentCompletions: (prefix) => {
			// 注：pi 1.4.0 的 getArgumentCompletions(prefix) 不提供会话上下文，
			// 目录只能取 process.cwd()（会话 cwd 与扩展进程 cwd 不一致的极端场景下
			// 补全源可能不符，属上游 API 限制）
			const raw = prefix.trim();
			const openedQuote = raw.startsWith('"');
			const p = openedQuote ? raw.slice(1) : raw;
			const items: { value: string; label: string; description?: string }[] = [];
			if ("stop".startsWith(p)) items.push({ value: "stop", label: "stop", description: "停止当前批次" });
			if ("status".startsWith(p)) items.push({ value: "status", label: "status", description: "查看批次进度" });
			try {
				for (const entry of fs.readdirSync(process.cwd(), { withFileTypes: true })) {
					if (!entry.isFile() || !/\.(md|txt)$/i.test(entry.name)) continue;
					if (p && !entry.name.startsWith(p)) continue;
					// pi 对命令参数补全按 value 原样插入（不自动加引号）：含空格的文件名
					// 必须自带双引号，否则 tokenizeArgs 会拆成多个 token；用户已输入
					// 开引号时同样闭合（与 pi 内建文件补全的 buildCompletionValue 语义一致）
					const value = openedQuote || /\s/.test(entry.name) ? `"${entry.name}"` : entry.name;
					items.push({ value, label: entry.name });
				}
			} catch {
				// 目录不可读时只补全子命令
			}
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			try {
				await dispatch(args, ctx);
			} catch (e) {
				ctx.ui.notify(`/batch 出错：${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});

	// ------------------------------------------------------------------
	// 命令分发
	// ------------------------------------------------------------------

	async function dispatch(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
		debugCmd(`dispatch args=${JSON.stringify(rawArgs)} mode=${ctx.mode} activeBatch=${activeBatch ? "yes" : "null"}`);
		const tokens = tokenizeArgs(rawArgs.trim());
		if (tokens.length === 0) {
			ctx.ui.notify(USAGE, "info");
			return;
		}

		const head = tokens[0]!;
		if (head === "stop") {
			await stopBatch(ctx, tokens.includes("--now"));
			return;
		}
		if (head === "status") {
			showStatus(ctx);
			return;
		}
		await startBatchCommand(tokens, ctx);
	}

	// ------------------------------------------------------------------
	// /batch stop
	// ------------------------------------------------------------------

	async function stopBatch(ctx: ExtensionCommandContext, immediately: boolean): Promise<void> {
		debugCmd(`stop requested immediately=${immediately} activeBatch=${activeBatch ? activeBatch.listFile : "null"}`);
		if (!activeBatch) {
			ctx.ui.notify("当前没有运行中的批次", "info");
			return;
		}
		if (immediately) {
			activeBatch.stop.stopFlag = "now";
			ctx.ui.notify("正在中止当前任务并停止批次…", "warning");
			debugCmd("stopFlag=now");
			try {
				ctx.abort();
			} catch (e) {
				ctx.ui.notify(`中止失败：${e instanceof Error ? e.message : String(e)}`, "error");
			}
		} else {
			activeBatch.stop.stopFlag = "gentle";
			debugCmd("stopFlag=gentle");
			ctx.ui.notify("将在当前任务自然结束后停止批次（不再推进后续任务）…", "info");
		}
	}

	// ------------------------------------------------------------------
	// /batch status
	// ------------------------------------------------------------------

	function showStatus(ctx: ExtensionCommandContext): void {
		const listFile = activeBatch?.listFile;
		const state = listFile ? progress.loadProgress(listFile) : findLatestProgress(ctx);
		if (!state) {
			ctx.ui.notify("当前没有正在运行或未完成的批次", "info");
			return;
		}
		ctx.ui.notify(report.summaryLine(state), "info");
		ctx.ui.setWidget("batch-summary", report.widgetLines(state, Date.now()));
	}

	function findLatestProgress(ctx: ExtensionCommandContext): BatchState | null {
		// 退化路径：activeBatch 丢失（如 /reload）后，尝试当前 cwd 下的 *.progress.json。
		// 多个候选时按修改时间取最新（并列时按文件名定序），避免依赖 readdir 顺序的不确定性。
		try {
			let best: { name: string; mtime: number; state: BatchState } | undefined;
			for (const entry of fs.readdirSync(ctx.cwd)) {
				if (!entry.endsWith(".progress.json")) continue;
				const listFile = entry.slice(0, -".progress.json".length);
				const state = progress.loadProgress(path.resolve(ctx.cwd, listFile));
				if (!state) continue;
				let mtime = 0;
				try {
					mtime = fs.statSync(path.join(ctx.cwd, entry)).mtimeMs;
				} catch {
					// stat 失败按最旧处理，仍可作为候选
				}
				if (!best || mtime > best.mtime || (mtime === best.mtime && entry > best.name)) {
					best = { name: entry, mtime, state };
				}
			}
			return best?.state ?? null;
		} catch {
			// ignore
		}
		return null;
	}

	// ------------------------------------------------------------------
	// /batch <清单文件> [选项]
	// ------------------------------------------------------------------

	async function startBatchCommand(tokens: string[], ctx: ExtensionCommandContext): Promise<void> {
		// 启动前置检查
		if (ctx.mode !== "tui") {
			const msg = "/batch 仅支持 TUI 交互模式（print/rpc/json 模式没有交互 UI）";
			ctx.ui.notify(msg, "error"); // 有 UI 的模式（rpc）走 notify
			if (!ctx.hasUI) console.error(msg); // print/json 模式 notify 是空操作，落到 stderr
			return;
		}
		if (activeBatch) {
			ctx.ui.notify("已有批处理在运行：/batch status 查看进度，/batch stop [--now] 停止后再启动", "error");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("智能体正在运行，请等待空闲后再启动批处理", "error");
			return;
		}

		// 参数解析（explicit 标志用于断点续跑时的配置覆盖语义：显式传入才覆盖，见下方续跑分支）
		const config = { retries: DEFAULT_RETRIES, onExhaust: DEFAULT_ON_EXHAUST, startAt: 1, dryRun: false };
		let retriesExplicit = false;
		let onExhaustExplicit = false;
		let startExplicit = false;
		let fileArg: string | undefined;
		for (let k = 0; k < tokens.length; k++) {
			const tok = tokens[k]!;
			if (tok === "--dry-run") {
				config.dryRun = true;
			} else if (tok === "--start" || tok === "--retries" || tok === "--on-exhaust") {
				const value = tokens[++k];
				if (value === undefined) {
					ctx.ui.notify(`缺少 ${tok} 的参数值\n${USAGE}`, "error");
					return;
				}
				if (tok === "--start") {
					const n = Number.parseInt(value, 10);
					if (!Number.isInteger(n) || n < 1) {
						ctx.ui.notify(`--start 需要 ≥ 1 的整数，收到：${value}`, "error");
						return;
					}
					config.startAt = n;
					startExplicit = true;
				} else if (tok === "--retries") {
					const n = Number.parseInt(value, 10);
					if (!Number.isInteger(n) || n < 0) {
						ctx.ui.notify(`--retries 需要 ≥ 0 的整数，收到：${value}`, "error");
						return;
					}
					config.retries = n;
					retriesExplicit = true;
				} else {
					if (value !== "pause" && value !== "skip" && value !== "abort") {
						ctx.ui.notify(`--on-exhaust 只支持 pause|skip|abort，收到：${value}`, "error");
						return;
					}
					config.onExhaust = value;
					onExhaustExplicit = true;
				}
			} else if (tok.startsWith("--")) {
				ctx.ui.notify(`未知选项：${tok}\n${USAGE}`, "error");
				return;
			} else if (fileArg === undefined) {
				fileArg = tok;
			} else {
				ctx.ui.notify(`多余参数：${tok}（路径含空格请用引号包裹）\n${USAGE}`, "error");
				return;
			}
		}
		if (!fileArg) {
			ctx.ui.notify(`缺少清单文件参数\n${USAGE}`, "error");
			return;
		}

		// 读取清单
		const listFile = path.resolve(ctx.cwd, fileArg);
		if (!fs.existsSync(listFile)) {
			ctx.ui.notify(`清单文件不存在：${listFile}`, "error");
			return;
		}
		let tasks;
		try {
			const content = fs.readFileSync(listFile, "utf-8");
			tasks = parseManifest(content);
		} catch (e) {
			const msg = e instanceof ManifestParseError ? `清单解析失败：${e.message}` : `读取清单失败：${e instanceof Error ? e.message : String(e)}`;
			ctx.ui.notify(msg, "error");
			return;
		}

		// --start 越界校验：dry-run 预览同样需要报错（否则预览会展示全部任务，误导用户）
		if (config.startAt > tasks.length) {
			ctx.ui.notify(`--start ${config.startAt} 超出任务总数（${tasks.length}）`, "error");
			return;
		}

		// dry-run：仅预览
		if (config.dryRun) {
			previewTasks(ctx, listFile, tasks, config.startAt);
			return;
		}

		// 断点检测：<清单>.progress.json（未 done）且有未终结任务
		const saved = progress.loadProgress(listFile);
		let startPoint: StartPoint | undefined;
		let state: BatchState | undefined;
		if (saved) {
			const firstOpen = saved.tasks.find((t) => t.status === "pending" || t.status === "running");
			if (firstOpen) {
				const choice = await ctx.ui.select("检测到未完成的批次", ["从断点继续", "从头重新开始", "取消"]);
				if (choice === "取消" || choice === undefined) {
					ctx.ui.notify("已取消", "info");
					return;
				}
				if (choice === "从断点继续") {
					// 清单重新解析过：以清单为准合并 prompt/标题/模式，状态沿用 progress 文件
					if (saved.tasks.length !== tasks.length) {
						ctx.ui.notify("清单任务数与断点进度不一致（清单可能已修改），请选择「从头重新开始」", "error");
						return;
					}
					// 本次命令行显式传入的配置覆盖进度文件中的旧值；未传入的沿用（避免静默回退到默认值）。
					// --start 在续跑时无意义（起点由断点决定），显式传入时明确提示被忽略。
					const overrides: string[] = [];
					if (retriesExplicit) {
						saved.retries = config.retries;
						overrides.push(`--retries=${config.retries} 已覆盖上次配置`);
					}
					if (onExhaustExplicit) {
						saved.onExhaust = config.onExhaust;
						overrides.push(`--on-exhaust=${config.onExhaust} 已覆盖上次配置`);
					}
					if (startExplicit) overrides.push("--start 已忽略（续跑起点由断点决定，从头重新开始时可用）");
					if (overrides.length > 0) ctx.ui.notify(`断点续跑：${overrides.join("；")}`, "info");
					const resumed = resumePlan(saved, firstOpen.index - 1);
					if (!resumed) {
						ctx.ui.notify("断点信息不完整，已取消。可重新执行 /batch 并选择「从头重新开始」", "error");
						return;
					}
					if (resumed.notify) ctx.ui.notify(resumed.notify, "warning");
					state = {
						...saved,
						tasks: saved.tasks.map((r, k) => ({
							...r,
							// 上次中断时停在 running 的任务重置为 pending；attempts 不在此处改动，
							// runTask 对 pending 任务首次开始时会清零（测试已钉住该行为）
							status: r.status === "running" ? ("pending" as const) : r.status,
							mode: tasks[k]!.mode,
							title: tasks[k]!.title,
							name: tasks[k]!.name,
							prompt: tasks[k]!.prompt,
						})),
					};
					startPoint = resumed.startPoint;
				} else {
					progress.backupDoneProgress(listFile);
				}
			} else {
				progress.backupDoneProgress(listFile);
			}
		}

		if (!state) {
			// 全新批次
			state = {
				listFile,
				batchTitle: path.basename(listFile).replace(/\.(md|txt)$/i, ""),
				startedAt: Date.now(),
				updatedAt: Date.now(),
				retries: config.retries,
				onExhaust: config.onExhaust,
				tasks: tasks.map((t, k): TaskRecord => ({
					index: k + 1,
					mode: t.mode,
					title: t.title,
					name: t.name,
					prompt: t.prompt,
					status: k + 1 < config.startAt ? "skipped" : "pending",
					attempts: 0,
					error: k + 1 < config.startAt ? `--start ${config.startAt} 跳过` : undefined,
				})),
			};
			startPoint = { kind: "direct", index: config.startAt - 1 };
		}

		// 初始化运行
		const stop = createStopHandle();
		activeBatch = { stop, listFile };
		progress.saveProgress(state);
		ctx.ui.setStatus("batch", report.statusText(state, Date.now()));

		const deps: EngineDeps = {
			settled: settledBus,
			bell: () => {
				try {
					process.stdout.write("\x07");
				} catch {
					// ignore
				}
			},
			onBatchEnd: () => {
				activeBatch = null;
			},
		};
		const leg: BatchLeg = { ctx: adaptCtx(ctx), send: (content, options) => pi.sendUserMessage(content, options) };
		await startBatch(deps, leg, state, startPoint!, stop);
	}

	/** 断点续跑起点规划：返回 startPoint 与可选提示；无法规划返回 null */
	function resumePlan(
		saved: BatchState,
		openIndex: number,
	): { startPoint: StartPoint; notify?: string } | null {
		const record = saved.tasks[openIndex]!;
		if (record.mode === "new") {
			return { startPoint: { kind: "direct", index: openIndex } };
		}
		if (openIndex === 0) {
			// 首条被标记「继续」：按文档行为在当前交互会话继续
			return { startPoint: { kind: "direct", index: 0 } };
		}
		const prev = saved.tasks[openIndex - 1]!;
		if (prev.sessionFile && fs.existsSync(prev.sessionFile)) {
			return { startPoint: { kind: "switch", sessionFile: prev.sessionFile, index: openIndex } };
		}
		return {
			startPoint: { kind: "fresh", index: openIndex },
			notify: `任务 ${record.index} 的前置会话文件不可用，该任务及后续「继续」链将改用新会话执行`,
		};
	}

	/** dry-run 预览 */
	function previewTasks(
		ctx: ExtensionCommandContext,
		listFile: string,
		tasks: ReturnType<typeof parseManifest>,
		startAt: number,
	): void {
		const lines: string[] = [];
		lines.push(`── 批处理预览 · ${path.basename(listFile)} · 共 ${tasks.length} 个任务${startAt > 1 ? ` · 从第 ${startAt} 条开始` : ""}`);
		for (const t of tasks) {
			const skipNote = t.index < startAt ? "（--start 跳过）" : "";
			const nameNote = t.name ? ` · 会话名: ${t.name}` : "";
			lines.push(`${statusIcon(t.mode)} ${String(t.index).padStart(2, " ")} ${t.title}${skipNote}${nameNote}`);
		}
		ctx.ui.setWidget("batch-summary", lines);
		ctx.ui.notify(`预览模式：共 ${tasks.length} 个任务，未执行。去掉 --dry-run 以运行。`, "info");
	}

	function statusIcon(mode: "new" | "continue"): string {
		return mode === "new" ? "[新会话]" : "[继续]  ";
	}
}
