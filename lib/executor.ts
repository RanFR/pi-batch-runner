/**
 * Execution engine (core).
 *
 * Design notes (verified against pi 1.4.0 sources, re-checked on 1.5.2 with
 * no changes):
 *
 * 1. The engine is driven by the /batch command handler: newSession/
 *    switchSession/waitForIdle may only run inside a command-handler context —
 *    calling them from event handlers deadlocks. The agent_settled subscription
 *    is used for signaling only.
 * 2. "New session" boundaries advance through the callback chain of
 *    ctx.newSession({ withSession }): inside the callback the fresh context's
 *    sendUserMessage / waitForIdle / newSession / ui are used; only plain data
 *    (task records, config) crosses boundaries. Callback chain depth equals the
 *    number of "new session" boundaries; consecutive tasks within one session
 *    loop inside the same callback.
 * 3. Completion is judged by subscribing to agent_settled first (via the
 *    injected SettledBus, before sending), then waiting for settled, then
 *    waitForIdle() as a double check (pi's internal waitForIdle resolves only
 *    after agent_settled dispatch completes, and the Promise of
 *    ReplacedSessionContext.sendUserMessage resolves only when the whole run
 *    ends — the two paths cross-validate). Send-failure watchdog: after the
 *    timeout, still isIdle with no settled event means failure, and whether the
 *    session branch advanced distinguishes "never started running" from "run
 *    finished but the event never arrived" (broken event bridge). A void send
 *    (root session) has no second completion signal, so it gets an extra grace
 *    period to tolerate slow auth / weak networks.
 * 4. Failure is judged by the stopReason ("error"/"aborted") of the last
 *    assistant message on the branch; settled.aborted means the user pressed Esc.
 * 5. Batch state uses the progress file as the single source of truth; this
 *    module holds no module-level state that spans sessions.
 */

import * as fs from "node:fs";
import * as progress from "./progress.ts";
import * as report from "./report.ts";
import {
	PENDING_DRAIN_TIMEOUT_MS,
	RETRY_DELAY_MS,
	type BatchContext,
	type BatchLeg,
	type BatchState,
	type EngineDeps,
	type TaskRecord,
} from "./types.ts";

/**
 * Batch stop control (held by index.ts's activeBatch). /reload re-evaluates the
 * module and resets module-level state: losing activeBatch only breaks the
 * re-entrancy guard and stop; losing settledListener makes a running batch miss
 * its completion events and degenerate into a watchdog failure loop (/reload is
 * forbidden while a batch runs; see the index.ts header).
 */
export interface StopHandle {
	/** "no" = running normally; "gentle" = stop after the current task ends naturally; "now" = abort the current task and stop. */
	stopFlag: "no" | "gentle" | "now";
	/** Ensures the summary runs exactly once. */
	finalized: boolean;
}

/** Creates a fresh stop handle (stopFlag = "no", not finalized). */
export function createStopHandle(): StopHandle {
	return { stopFlag: "no", finalized: false };
}

/**
 * Where a batch starts.
 * - direct: continue at item `index` (0-based) of the current leg (new-session
 *   boundaries are handled by the engine loop);
 * - fresh: open a new session first, then continue at `index` (fallback for a
 *   resumed "continue" task whose previous session is gone);
 * - switch: switch to the given session file first, then continue at `index`
 *   (resume finds the original session).
 */
export type StartPoint =
	{ kind: "direct"; index: number } | { kind: "fresh"; index: number } | { kind: "switch"; sessionFile: string; index: number };

type Outcome = "ok" | "error" | "aborted" | "send-failed";

/** Outcome of a single attempt. */
interface AttemptResult {
	/** What happened during the attempt. */
	outcome: Outcome;
	/** Error summary, when the attempt failed. */
	error?: string;
}

function msgOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Diagnostic log: appends to /tmp/pi-batch-debug.log when PI_BATCH_DEBUG=1. */
function debug(msg: string): void {
	if (!process.env.PI_BATCH_DEBUG) return;
	try {
		fs.appendFileSync("/tmp/pi-batch-debug.log", `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// ignore
	}
}

/** Flattens whitespace and truncates an error message, with a fallback label. */
function shortError(text: string | undefined, max = 120): string {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	if (!flat) return "未知错误";
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Returns the base name of a path. */
function fileName(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx === -1 ? p : p.slice(idx + 1);
}

/** Fills in default dependencies (now/sleep/bell/sendFailTimeoutMs). */
function withDefaults(deps: EngineDeps): Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps {
	return {
		...deps,
		now: deps.now ?? (() => Date.now()),
		sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
		bell:
			deps.bell ??
			(() => {
				try {
					process.stdout.write("\x07");
				} catch {
					// No terminal attached: safe to ignore.
				}
			}),
	};
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Starts a batch: resolves the start point (direct/fresh/switch) and enters the
 * execution loop; guarantees exactly one final summary.
 */
export async function startBatch(deps: EngineDeps, leg: BatchLeg, state: BatchState, start: StartPoint, stop: StopHandle): Promise<void> {
	const d = withDefaults(deps);
	try {
		if (start.kind === "switch") {
			await startWithSwitch(d, leg, state, start.sessionFile, start.index, stop);
			return;
		}
		if (start.kind === "fresh") {
			await startWithFresh(d, leg, state, start.index, stop);
			return;
		}
		await runFrom(d, leg, state, start.index, stop);
	} catch (e) {
		// Engine-level safety net: any unexpected exception must still finalize
		// (summary + activeBatch cleanup).
		try {
			await finalizeBatch(d, leg, state, stop, `内部错误：${shortError(msgOf(e))}`);
		} catch {
			deps.onBatchEnd?.();
		}
	}
}

/** Resume: switches to the previous task's session file; falls back to a fresh session on failure. */
async function startWithSwitch(
	d: Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	sessionFile: string,
	index: number,
	stop: StopHandle,
): Promise<void> {
	let entered = false;
	let switchError: unknown;
	try {
		const res = await leg.ctx.switchSession(sessionFile, {
			withSession: async (fresh) => {
				entered = true;
				await runFrom(d, fresh, state, index, stop);
			},
		});
		if (!entered || res.cancelled) {
			await finalizeBatch(d, leg, state, stop, "会话切换被取消");
		}
		return;
	} catch (e) {
		switchError = e;
	}
	// Fallback: run in a fresh session.
	leg.ctx.ui.notify(`无法恢复会话 ${fileName(sessionFile)}：${shortError(msgOf(switchError))}，改为新会话执行`, "warning");
	await startWithFresh(d, leg, state, index, stop);
}

/** Continues in a fresh session (shared by the fallback path and resumes whose first task is "new"). */
async function startWithFresh(
	d: Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	index: number,
	stop: StopHandle,
): Promise<void> {
	const res = await leg.ctx.newSession({
		// Explicit session name (manifest `name:` line); when undefined the
		// session stays unnamed (no setup is passed for undefined names).
		name: state.tasks[index]?.name,
		withSession: async (fresh) => {
			await runFrom(d, fresh, state, index, stop);
		},
	});
	if (res.cancelled) {
		await finalizeBatch(d, leg, state, stop, "会话切换被取消");
	}
}

// ============================================================================
// Execution loop (advancing through the callback chain)
// ============================================================================

/**
 * Runs tasks starting at `startIndex` (0-based).
 *
 * On a "new session" task: newSession (named via the manifest `name:` line when
 * present, unnamed otherwise) → inside the callback, run this task then loop on;
 * when the callback returns, the old leg simply ends (return — no advancing and
 * no finalization; the deepest leg finalizes).
 *
 * "Continue" tasks and a first task marked "continue" are sent in the current
 * session directly.
 */
async function runFrom(
	d: Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	startIndex: number,
	stop: StopHandle,
): Promise<void> {
	let i = startIndex;
	while (i < state.tasks.length) {
		if (stop.stopFlag === "gentle") break; // Gentle stop: do not advance.

		const record = state.tasks[i]!;
		if (record.mode === "new") {
			progress.saveProgress(state);
			const res = await leg.ctx.newSession({
				// Explicit session name (manifest `name:` line); unnamed when absent.
				name: record.name,
				withSession: async (fresh) => {
					// This task runs in a brand-new session; later tasks keep
					// advancing inside the same callback chain.
					const action = await runTask(d, fresh, state, i, stop);
					if (action === "advance") {
						await runFrom(d, fresh, state, i + 1, stop);
					} else {
						await finalizeBatch(d, fresh, state, stop);
					}
				},
			});
			if (res.cancelled) {
				await finalizeBatch(d, leg, state, stop, "会话切换被取消");
			}
			return; // Control has moved into the fresh callback.
		}

		const action = await runTask(d, leg, state, i, stop);
		if (action === "advance") {
			i++;
			continue;
		}
		break; // stop / terminate → finalize.
	}
	await finalizeBatch(d, leg, state, stop);
}

// ============================================================================
// Single task: attempt loop + retries + pause prompt
// ============================================================================

/** What the caller should do after a task's attempt loop returns. */
type TaskAction = "advance" | "stop" | "terminate";

async function runTask(
	d: Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	i: number,
	stop: StopHandle,
): Promise<TaskAction> {
	const record = state.tasks[i]!;
	let lastStatusAt = 0;

	for (;;) {
		if (stop.stopFlag === "gentle") return "stop";
		debug(`runTask task=${record.index} attempt=${record.attempts} stop=${stop.stopFlag}`);

		if (record.status === "pending") {
			// First start (including tasks reset by resume); manual retries keep the count.
			record.status = "running";
			record.attempts = 0;
			record.startedAt = d.now();
			record.endedAt = undefined;
			// Assign directly (no ?? fallback): before a brand-new session's first
			// message is persisted, getSessionFile() is undefined; keeping the old
			// value would mis-attribute the task to the previous task's session.
			// undefined is the honest value; it is refreshed after success anyway.
			record.sessionFile = leg.ctx.sessionManager.getSessionFile();
			progress.saveProgress(state);
		}
		record.attempts++;
		progress.saveProgress(state);
		leg.ctx.ui.setStatus("batch", report.statusText(state, d.now()));

		const result = await attemptOnce(d, leg, state, record, () => {
			const nowMs = d.now();
			if (nowMs - lastStatusAt >= 5_000) {
				lastStatusAt = nowMs;
				leg.ctx.ui.setStatus("batch", report.statusText(state, nowMs));
			}
		});
		debug(`runTask task=${record.index} outcome=${result.outcome}`);
		// Refresh the landing session regardless of outcome (failed tasks also
		// need correct session attribution in the report; after send failures
		// getSessionFile() may be undefined for a while, so keep the old value).
		record.sessionFile = leg.ctx.sessionManager.getSessionFile() ?? record.sessionFile;

		if (result.outcome === "ok") {
			record.status = "ok";
			record.endedAt = d.now();
			record.error = undefined;
			progress.saveProgress(state);
			leg.ctx.ui.setStatus("batch", report.statusText(state, d.now()));
			return "advance";
		}

		if (result.outcome === "aborted") {
			record.error = "用户中断（Esc）";
			progress.saveProgress(state);
			if (stop.stopFlag === "now") {
				// stop --now: the intent to stop is explicit; terminate the whole
				// batch without prompting.
				record.status = "failed";
				record.endedAt = d.now();
				record.error = "批次被停止（stop --now）";
				progress.saveProgress(state);
				return "terminate";
			}
			d.bell();
			const choice = await leg.ctx.ui.select(`任务 ${record.index} 被手动中断：${record.title}`, ["重试本条", "跳过，继续下一条", "终止整批"]);
			if (choice === "重试本条") {
				await d.sleep(RETRY_DELAY_MS);
				continue;
			}
			if (choice === "跳过，继续下一条") {
				record.status = "skipped";
				record.endedAt = d.now();
				progress.saveProgress(state);
				return "advance";
			}
			record.status = "failed";
			record.endedAt = d.now();
			progress.saveProgress(state);
			return "terminate";
		}

		// error / send-failed: record the error and retry.
		record.error = result.error;
		progress.saveProgress(state);

		if (record.attempts <= state.retries) {
			leg.ctx.ui.notify(
				`任务 ${record.index} 失败（第 ${record.attempts}/${state.retries + 1} 次）：${shortError(result.error)}，${Math.round(RETRY_DELAY_MS / 1000)}s 后重试…`,
				"warning",
			);
			await d.sleep(RETRY_DELAY_MS);
			continue;
		}

		// Retries exhausted.
		record.status = "failed";
		record.endedAt = d.now();
		progress.saveProgress(state);

		if (state.onExhaust === "skip") return "advance";
		if (state.onExhaust === "abort") return "terminate";

		// pause: show a dialog (no timeout — waits for a human; dismissing with
		// Esc counts as terminate).
		d.bell();
		const choice = await leg.ctx.ui.select(
			`任务 ${record.index} 重试耗尽（已尝试 ${record.attempts} 次）：${record.title}\n${shortError(result.error)}`,
			["重试本条(同会话)", "跳过，继续下一条", "终止整批"],
		);
		if (choice === "重试本条(同会话)") {
			continue;
		}
		if (choice === "跳过，继续下一条") return "advance";
		return "terminate";
	}
}

// ============================================================================
// Single attempt: drain queue → subscribe → send → await settled → judge
// ============================================================================

async function attemptOnce(
	d: Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	record: TaskRecord,
	onTick: () => void,
): Promise<AttemptResult> {
	// (0) If queued messages / an unfinished run exist before sending, wait for
	// them to drain (bounded so we never wait forever).
	const drainDeadline = d.now() + PENDING_DRAIN_TIMEOUT_MS;
	while (leg.ctx.hasPendingMessages()) {
		await leg.ctx.waitForIdle();
		if (!leg.ctx.hasPendingMessages()) break;
		if (d.now() > drainDeadline) {
			return { outcome: "send-failed", error: "等待既有排队消息消化超时（5 分钟），已放弃本次发送" };
		}
		await d.sleep(200);
	}
	await leg.ctx.waitForIdle(); // Make sure the agent is idle before sending.

	// (1) Subscribe before sending (race safety: settled must be attached first).
	let settledEvent: { aborted: boolean } | undefined;
	let resolveSettled: () => void = () => {};
	const settledP = new Promise<void>((resolve) => {
		resolveSettled = resolve;
	});
	const off = d.settled.subscribe((e) => {
		debug(`settled received task=${record.index}`);
		settledEvent = e;
		resolveSettled();
	});

	// (2) Send the prompt (expandPromptTemplates: true, matching manual input).
	// Record the branch length before sending: if the watchdog fires and the
	// branch has advanced, a run did happen but the agent_settled event was
	// never delivered (broken event bridge) — distinct from "never started".
	const branchLenBefore = leg.ctx.sessionManager.getBranch().length;
	let sendPromise: Promise<void> | undefined;
	try {
		const ret: void | Promise<void> = leg.send(record.prompt, { expandPromptTemplates: true });
		debug(`send task=${record.index} promise=${ret instanceof Object ? "yes" : "void"}`);
		if (ret && typeof (ret as Promise<void>).then === "function") {
			sendPromise = ret as Promise<void>;
		}
	} catch (e) {
		off();
		return { outcome: "send-failed", error: `发送失败：${shortError(msgOf(e))}` };
	}

	let sendResolved = false;
	let sendError: unknown;
	const sendP = sendPromise
		? sendPromise.then(
				() => {
					sendResolved = true;
				},
				(e: unknown) => {
					sendError = e;
				},
			)
		: undefined;

	// (3) Wait for settled / send failure / watchdog.
	const startedAt = d.now();
	const timeoutMs = d.sendFailTimeoutMs ?? 10_000;
	// A void send (root-session pi.sendUserMessage without a returned Promise)
	// has no sendP second signal, and pi's prompt() has two async points before
	// _startRun (input handler and auth probing over the network): isIdle stays
	// true during slow auth, which would misjudge send-failure within the base
	// window, so void sends get an extra grace period (60s total by default).
	const effectiveTimeoutMs = sendP ? timeoutMs : timeoutMs + (d.sendFailVoidGraceMs ?? 50_000);
	try {
		for (;;) {
			const racers: Promise<"settled" | "send" | "tick">[] = [
				settledP.then(() => "settled" as const),
				d.sleep(500).then(() => "tick" as const),
			];
			// Do not re-enqueue sendP once settled: avoids a tight loop with no
			// backoff when the send branch resolves early.
			if (sendP && !sendResolved && sendError === undefined) racers.push(sendP.then(() => "send" as const));
			const winner = await Promise.race(racers);

			if (winner === "settled") break;
			if (winner === "send") {
				if (sendError !== undefined) {
					return { outcome: "send-failed", error: `发送失败：${shortError(msgOf(sendError))}` };
				}
				if (!settledEvent) {
					debug(`early-send-resolve task=${record.index}`);
					// Extreme cases (message queued/delayed): the send promise resolved
					// early but the turn has not settled yet; back off and keep waiting
					// (sendP is no longer enqueued; ticks drive the loop from here on).
					await d.sleep(250);
					continue;
				}
				break;
			}
			// tick: refresh the status bar + send-failure watchdog.
			onTick();
			if (!settledEvent && d.now() - startedAt > effectiveTimeoutMs && leg.ctx.isIdle() && (!sendP || sendResolved)) {
				if (leg.ctx.sessionManager.getBranch().length > branchLenBefore) {
					// The branch advanced: a run did happen, only the settled event
					// never arrived (e.g. a broken event bridge after /reload).
					return {
						outcome: "send-failed",
						error: "运行已结束但未收到 agent_settled 事件（疑似 /reload 或手工切换会话致事件桥断裂，请停止批次后重新启动）",
					};
				}
				return {
					outcome: "send-failed",
					error: `发送后 ${Math.round(effectiveTimeoutMs / 1000)}s 内未开始任何运行（请检查模型与认证配置）`,
				};
			}
		}
	} finally {
		off();
	}

	// (4) Double check: waitForIdle after settled (normally returns immediately;
	// messages queued meanwhile are waited out naturally).
	await leg.ctx.waitForIdle();

	// (5) Judge the outcome.
	if (settledEvent?.aborted) return { outcome: "aborted" };
	const last = lastAssistantMessage(leg.ctx);
	if (last && (last.stopReason === "error" || last.stopReason === "aborted")) {
		return {
			outcome: "error",
			error: last.errorMessage || `模型停止原因：${last.stopReason}`,
		};
	}
	return { outcome: "ok" };
}

/** Last assistant message on the current branch (with stopReason / errorMessage). */
export function lastAssistantMessage(ctx: BatchContext): { stopReason?: string; errorMessage?: string } | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let k = branch.length - 1; k >= 0; k--) {
		const entry = branch[k]!;
		if (entry.type === "message" && entry.message?.role === "assistant") {
			return entry.message;
		}
	}
	return undefined;
}

// ============================================================================
// Finalization
// ============================================================================

/** Finalizes a batch: notify + widget + report.md + progress rename + state cleanup. Idempotent. */
export async function finalizeBatch(
	d: Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	stop: StopHandle,
	reasonNote?: string,
): Promise<void> {
	if (stop.finalized) return;
	stop.finalized = true;

	const endedAt = d.now();

	// Defensive: no task should remain "running" (reset to pending — it never
	// really finished, so it gets no endedAt).
	for (const t of state.tasks) {
		if (t.status === "running") {
			t.status = "pending";
			t.endedAt = undefined;
			t.error = t.error ?? "批次提前结束";
		}
	}
	progress.saveProgress(state);

	const counts = report.countTasks(state);
	const line = reasonNote ? `${report.summaryLine(state)}（${reasonNote}）` : report.summaryLine(state);
	try {
		d.bell();
		leg.ctx.ui.notify(line, counts.failed > 0 ? "warning" : "info");
		leg.ctx.ui.setWidget("batch-summary", report.widgetLines(state, endedAt));
	} catch {
		// Best effort: keep the report even when the UI is unavailable.
	}

	try {
		progress.writeReport(state.listFile, report.renderReportMarkdown(state, endedAt));
	} catch (e) {
		try {
			leg.ctx.ui.notify(`汇总报告写入失败：${shortError(msgOf(e))}`, "warning");
		} catch {
			// ignore
		}
	}
	try {
		progress.finishProgress(state.listFile);
	} catch {
		// If the rename fails, keeping the original progress file is fine.
	}
	try {
		leg.ctx.ui.setStatus("batch", undefined);
	} catch {
		// ignore
	}
	d.onBatchEnd?.();
}
