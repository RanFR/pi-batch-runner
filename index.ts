/**
 * pi-batch-runner: batch-processing extension for pi.
 *
 * Runs multiple prompt tasks from a manifest file sequentially in a single TUI
 * window:
 * - By default each task runs in a fresh session (context isolation);
 * - Tasks marked "continue" reuse the previous task's session;
 * - A failed task retries automatically (--retries, default 3); once retries
 *   are exhausted, behavior follows --on-exhaust (default pause);
 * - When everything finishes, a summary is shown and pi stays open.
 *
 * Usage:
 *   /batch <manifest> [--dry-run] [--start N] [--retries N] [--on-exhaust pause|skip|abort]
 *   /batch stop [--now]
 *   /batch status
 *
 * TUI mode only; startup is rejected in print/rpc/json mode.
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { startBatch, createStopHandle, type StartPoint, type StopHandle } from "./lib/executor.ts";
import { ManifestParseError, parseManifest, tokenizeArgs } from "./lib/parser.ts";
import * as progress from "./lib/progress.ts";
import * as report from "./lib/report.ts";
import type { BatchContext, BatchLeg, BatchState, BatchTask, EngineDeps, SettledBus, TaskRecord } from "./lib/types.ts";
import { DEFAULT_ON_EXHAUST, DEFAULT_RETRIES } from "./lib/types.ts";

// User-facing strings (USAGE, notifications, dialogs) are intentionally in
// Chinese to match the rest of the product UI.
const USAGE = [
	"用法：",
	"  /batch <清单文件> [--dry-run] [--start N] [--retries N] [--on-exhaust pause|skip|abort]",
	"  /batch stop [--now]    温和停止 / 立即中止当前任务并停止",
	"  /batch status          查看批次进度",
].join("\n");

/**
 * Module-level "wiring" state.
 *
 * Observed behavior (pi 1.4.0, re-checked on 1.5.2 with no changes): every
 * session replacement (newSession/switchSession) creates a new resourceLoader
 * and re-runs the extension factory function (jiti only caches the factory
 * function object itself; the module is evaluated once). `let` variables inside
 * the factory body are rebuilt on each run and do not survive replacements;
 * only module-level variables persist.
 *
 * Therefore only "wiring" state may live here: event-listener slots and
 * re-entrancy flags. Batch data always uses the progress file as the single
 * source of truth (PLAN pitfall 5).
 *
 * Warning: /reload re-evaluates this module in a new generation, zeroing both
 * settledListener and activeBatch. The running engine closure still holds the
 * old SettledBus (written into the old module instance's slot), while events
 * are only dispatched to handlers registered by the new instance → the engine
 * never receives agent_settled, the watchdog misjudges every task as
 * send-failed, and the batch degenerates into a failure loop. /reload is
 * forbidden while a batch runs (see README "运行中干预").
 */
let settledListener: ((event: { aborted: boolean }) => void) | undefined;
let activeBatch: ActiveBatch | null = null;

interface ActiveBatch {
	stop: StopHandle;
	listFile: string;
}

/** Diagnostic log: appends to /tmp/pi-batch-debug.log when PI_BATCH_DEBUG=1. */
function debugCmd(msg: string): void {
	if (!process.env.PI_BATCH_DEBUG) return;
	try {
		fs.appendFileSync("/tmp/pi-batch-debug.log", `${new Date().toISOString()} [cmd] ${msg}\n`);
	} catch {
		// ignore
	}
}

/**
 * Fresh context type received by session-switch callbacks
 * (ReplacedSessionContext). Neither the 1.4.0 nor the 1.5.2 package root
 * exports the type name, so it is derived structurally from newSession's
 * withSession callback signature.
 */
type ReplacedSessionContext = Parameters<NonNullable<NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["withSession"]>>[0];

/** Adapts a real context into the narrow view the executor needs (structural subset of ExtensionCommandContext / ReplacedSessionContext). */
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
		newSession: (opts) => {
			// Naming goes through `setup` straight into the session manager:
			// the old pi facade is stale after the session replacement.
			const name = opts.name;
			return ctx.newSession({
				...(name
					? {
							setup: async (sm: { appendSessionInfo: (name: string) => string }) => {
								sm.appendSessionInfo(name);
							},
						}
					: {}),
				withSession: (fresh) => opts.withSession(adaptFreshLeg(fresh)),
			});
		},
		switchSession: (p, opts) =>
			ctx.switchSession(p, {
				withSession: (fresh) => opts.withSession(adaptFreshLeg(fresh)),
			}),
	};
}

/** Wraps the real post-switch context into the complete leg the executor needs (fresh context + matching send function). */
function adaptFreshLeg(fresh: ReplacedSessionContext): BatchLeg {
	return {
		ctx: adaptCtx(fresh),
		send: (content, options) => fresh.sendUserMessage(content, options),
	};
}

/** Narrows a real session-branch entry into the read-only view the executor inspects. */
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
	// agent_settled event bridge: re-register the handler on the current runner
	// at every factory execution (the old Extension object is discarded along
	// with the old runner). The handler connects to the engine through the
	// module-level listener slot and captures no pi/ctx runtime objects.
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
			// Note: pi 1.5.2's getArgumentCompletions(prefix) still provides no
			// session context, so the listing can only use process.cwd() (in the
			// rare case where the session cwd differs from the extension process
			// cwd, completions may not match — an upstream API limitation).
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
					// pi inserts command-argument completions verbatim from `value`
					// (no automatic quoting): file names containing spaces must carry
					// their own double quotes, or tokenizeArgs splits them into
					// multiple tokens; when the user already typed an opening quote,
					// close it too (same semantics as pi's built-in file completion).
					const value = openedQuote || /\s/.test(entry.name) ? `"${entry.name}"` : entry.name;
					items.push({ value, label: entry.name });
				}
			} catch {
				// Unreadable directory: only complete the subcommands.
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
	// Command dispatch
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

	/** Fallback when activeBatch is lost (e.g. after /reload): scan *.progress.json in the current cwd. */
	function findLatestProgress(ctx: ExtensionCommandContext): BatchState | null {
		// With multiple candidates, pick the most recently modified (ties broken
		// by file name) to avoid depending on readdir order.
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
					// stat failure counts as oldest; still a candidate.
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
	// /batch <manifest> [options]
	// ------------------------------------------------------------------

	async function startBatchCommand(tokens: string[], ctx: ExtensionCommandContext): Promise<void> {
		// Pre-flight checks.
		if (ctx.mode !== "tui") {
			const msg = "/batch 仅支持 TUI 交互模式（print/rpc/json 模式没有交互 UI）";
			ctx.ui.notify(msg, "error"); // Modes with a UI (rpc) go through notify.
			if (!ctx.hasUI) console.error(msg); // notify is a no-op in print/json; fall back to stderr.
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

		// Option parsing. The *Explicit flags drive the resume override semantics:
		// only options passed on this command line override the progress file's
		// saved values (see the resume branch below).
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

		// Read the manifest.
		const listFile = path.resolve(ctx.cwd, fileArg);
		if (!fs.existsSync(listFile)) {
			ctx.ui.notify(`清单文件不存在：${listFile}`, "error");
			return;
		}
		let tasks: BatchTask[];
		try {
			const content = fs.readFileSync(listFile, "utf-8");
			tasks = parseManifest(content);
		} catch (e) {
			const msg =
				e instanceof ManifestParseError ? `清单解析失败：${e.message}` : `读取清单失败：${e instanceof Error ? e.message : String(e)}`;
			ctx.ui.notify(msg, "error");
			return;
		}

		// --start bounds check: dry-run preview must fail too (otherwise the
		// preview would show all tasks and mislead the user).
		if (config.startAt > tasks.length) {
			ctx.ui.notify(`--start ${config.startAt} 超出任务总数（${tasks.length}）`, "error");
			return;
		}

		// dry-run: preview only.
		if (config.dryRun) {
			previewTasks(ctx, listFile, tasks, config.startAt);
			return;
		}

		// Resume detection: <manifest>.progress.json (not done) with non-terminal tasks.
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
					// The manifest was re-parsed: merge prompt/title/mode from the
					// manifest (authoritative) while keeping status from the file.
					if (saved.tasks.length !== tasks.length) {
						ctx.ui.notify("清单任务数与断点进度不一致（清单可能已修改），请选择「从头重新开始」", "error");
						return;
					}
					// Options explicitly passed on this command line override the old
					// values in the progress file; omitted ones carry over (avoiding a
					// silent fallback to defaults). --start is meaningless when
					// resuming (the breakpoint decides the start); if given, say so.
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
							// Tasks left "running" by the last interruption reset to
							// pending; attempts are not touched here — runTask zeroes
							// them on a pending task's first start (pinned by tests).
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
			// Brand-new batch.
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

		// Initialize the run.
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
		if (!state || !startPoint) return; // unreachable: every branch above sets both
		await startBatch(deps, leg, state, startPoint, stop);
	}

	/** Plans the resume start point: returns a startPoint plus an optional notice; null when no plan is possible. */
	function resumePlan(saved: BatchState, openIndex: number): { startPoint: StartPoint; notify?: string } | null {
		const record = saved.tasks[openIndex]!;
		if (record.mode === "new") {
			return { startPoint: { kind: "direct", index: openIndex } };
		}
		if (openIndex === 0) {
			// The first task is marked "continue": per the documented behavior,
			// continue in the current interactive session.
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

	/** dry-run preview. */
	function previewTasks(ctx: ExtensionCommandContext, listFile: string, tasks: ReturnType<typeof parseManifest>, startAt: number): void {
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
		return mode === "new" ? "[new]" : "[continue]";
	}
}
