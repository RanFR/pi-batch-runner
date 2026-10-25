/**
 * 执行引擎（核心）。
 *
 * 设计要点（对应 PLAN 第 6/7 节，全部经 pi 1.4.0 源码核对）：
 *
 * 1. 引擎由 /batch 命令 handler 驱动：newSession/switchSession/waitForIdle 只能在命令处理器
 *    上下文中调用，事件处理器里调用会死锁。agent_settled 订阅只用于「发信号」。
 * 2. 「新会话」边界通过 ctx.newSession({ withSession }) 的回调链推进：回调内用 fresh 上下文的
 *    sendUserMessage / waitForIdle / newSession / ui；跨边界只携带纯数据（任务记录、配置）。
 *    回调链深度 = 「新会话」边界数；同一会话内的连续任务在回调内 while 循环处理。
 * 3. 完成判定：先订阅 agent_settled（经注入的 SettledBus，订阅先于发送），发送后等待 settled；
 *    settled 后再 waitForIdle() 双保险（pi 内部 waitForIdle 在 agent_settled 派发完成后才 resolve，
 *    且 ReplacedSessionContext.sendUserMessage 的 Promise 也只在整轮 run 结束后 resolve，
 *    两条路径互为校验）。发送失败的看门狗：超时后仍 isIdle 且无 settled → 按失败处理。
 * 4. 失败判定看分支上最后一条 assistant 消息的 stopReason（"error"/"aborted"），
 *    settled.aborted 表示用户 Esc。
 * 5. 批次状态以 progress 文件为唯一事实源；本模块不持有跨会话的模块级状态。
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

/** 批次停止控制（index.ts 的 activeBatch 持有；模块级丢失的最坏后果是防重入失效） */
export interface StopHandle {
	/** no = 正常运行；gentle = 当前任务自然结束后停止；now = 中止当前任务并停止 */
	stopFlag: "no" | "gentle" | "now";
	/** 汇总只做一次 */
	finalized: boolean;
}

export function createStopHandle(): StopHandle {
	return { stopFlag: "no", finalized: false };
}

/**
 * 批次起点。
 * - direct：从当前 leg 的第 index 项（0-based）继续（新会话边界由引擎在循环内处理）；
 * - fresh：先开新会话再从 index 继续（断点续跑时「继续」任务丢失前置会话的降级路径）；
 * - switch：先切换到指定会话文件再从 index 继续（断点续跑找回原会话）。
 */
export type StartPoint =
	| { kind: "direct"; index: number }
	| { kind: "fresh"; index: number }
	| { kind: "switch"; sessionFile: string; index: number };

type Outcome = "ok" | "error" | "aborted" | "send-failed";

interface AttemptResult {
	outcome: Outcome;
	error?: string;
}

function msgOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** 诊断日志：设 PI_BATCH_DEBUG=1 时写 /tmp/pi-batch-debug.log */
function debug(msg: string): void {
	if (!process.env.PI_BATCH_DEBUG) return;
	try {
		fs.appendFileSync("/tmp/pi-batch-debug.log", `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// ignore
	}
}

function shortError(text: string | undefined, max = 120): string {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	if (!flat) return "未知错误";
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function fileName(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx === -1 ? p : p.slice(idx + 1);
}

/** 解析默认依赖（now/sleep/bell/sendFailTimeoutMs） */
function withDefaults(deps: EngineDeps): Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps {
	return {
		...deps,
		now: deps.now ?? (() => Date.now()),
		sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
		bell: deps.bell ?? (() => {
			try {
				process.stdout.write("\x07");
			} catch {
				// 无终端时可忽略
			}
		}),
	};
}

// ============================================================================
// 入口
// ============================================================================

/** 启动批次：处理起点（direct/fresh/switch）后进入执行循环；保证恰好一次汇总收尾。 */
export async function startBatch(
	deps: EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	start: StartPoint,
	stop: StopHandle,
): Promise<void> {
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
		// 引擎级兜底：任何未预期异常都要收尾（汇总 + 清理 activeBatch）
		try {
			await finalizeBatch(d, leg, state, stop, `内部错误：${shortError(msgOf(e))}`);
		} catch {
			deps.onBatchEnd?.();
		}
	}
}

/** 断点续跑：切换到前置任务的会话文件；失败则降级为新会话执行。 */
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
	// 降级：新会话执行
	leg.ctx.ui.notify(`无法恢复会话 ${fileName(sessionFile)}：${shortError(msgOf(switchError))}，改为新会话执行`, "warning");
	await startWithFresh(d, leg, state, index, stop);
}

/** 新会话中继续（降级路径与首条即「新会话」的断点续跑共用） */
async function startWithFresh(
	d: Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	index: number,
	stop: StopHandle,
): Promise<void> {
	const res = await leg.ctx.newSession({
		name: `${state.batchTitle} · 任务${state.tasks[index]?.index ?? index + 1} ${state.tasks[index]?.title ?? ""}`.trimEnd(),
		withSession: async (fresh) => {
			await runFrom(d, fresh, state, index, stop);
		},
	});
	if (res.cancelled) {
		await finalizeBatch(d, leg, state, stop, "会话切换被取消");
	}
}

// ============================================================================
// 执行循环（闭包链推进）
// ============================================================================

/**
 * 从第 i（0-based）个任务开始执行。
 * 遇到「新会话」任务：newSession（带会话名）→ 回调内先执行本条任务再循环推进；
 * 回调返回后旧 leg 就地结束（return，不再推进也不收尾——收尾由最深层的 leg 完成）。
 * 「继续」任务与首条被标记继续的任务：在当前会话直接发送。
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
		if (stop.stopFlag === "gentle") break; // 温和停止：不再推进

		const record = state.tasks[i]!;
		if (record.mode === "new") {
			progress.saveProgress(state);
			const res = await leg.ctx.newSession({
				name: `${state.batchTitle} · 任务${record.index} ${record.title}`,
				withSession: async (fresh) => {
					// 本条任务在全新会话中执行；后续任务在同一回调链内循环推进
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
			return; // 控制权已移交 fresh 回调
		}

		const action = await runTask(d, leg, state, i, stop);
		if (action === "advance") {
			i++;
			continue;
		}
		break; // stop / terminate → 收尾
	}
	await finalizeBatch(d, leg, state, stop);
}

// ============================================================================
// 单任务执行：尝试循环 + 重试 + 暂停询问
// ============================================================================

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
			// 首次开始（含断点续跑重置后的任务）；手动重试不重置计数
			record.status = "running";
			record.attempts = 0;
			record.startedAt = d.now();
			record.endedAt = undefined;
			record.sessionFile = leg.ctx.sessionManager.getSessionFile() ?? record.sessionFile;
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

		if (result.outcome === "ok") {
			record.status = "ok";
			record.endedAt = d.now();
			record.sessionFile = leg.ctx.sessionManager.getSessionFile() ?? record.sessionFile;
			record.error = undefined;
			progress.saveProgress(state);
			leg.ctx.ui.setStatus("batch", report.statusText(state, d.now()));
			return "advance";
		}

		if (result.outcome === "aborted") {
			record.error = "用户中断（Esc）";
			progress.saveProgress(state);
			if (stop.stopFlag === "now") {
				// stop --now：停止意图明确，不再询问，直接终止整批
				record.status = "failed";
				record.endedAt = d.now();
				record.error = "批次被停止（stop --now）";
				progress.saveProgress(state);
				return "terminate";
			}
			d.bell();
			const choice = await leg.ctx.ui.select(
				`任务 ${record.index} 被手动中断：${record.title}`,
				["重试本条", "跳过，继续下一条", "终止整批"],
			);
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

		// error / send-failed：记录错误并重试
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

		// 重试耗尽
		record.status = "failed";
		record.endedAt = d.now();
		progress.saveProgress(state);

		if (state.onExhaust === "skip") return "advance";
		if (state.onExhaust === "abort") return "terminate";

		// pause：弹选择框（无超时，等人；Esc 关闭视为终止）
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
// 单次尝试：排队消化 → 订阅 → 发送 → 等待 settled → 判定
// ============================================================================

async function attemptOnce(
	d: Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	record: TaskRecord,
	onTick: () => void,
): Promise<AttemptResult> {
	// (0) 发送前若存在排队消息/未结束的运行：等待消化完（设上限防死等）
	const drainDeadline = d.now() + PENDING_DRAIN_TIMEOUT_MS;
	while (leg.ctx.hasPendingMessages()) {
		await leg.ctx.waitForIdle();
		if (!leg.ctx.hasPendingMessages()) break;
		if (d.now() > drainDeadline) {
			return { outcome: "send-failed", error: "等待既有排队消息消化超时（5 分钟），已放弃本次发送" };
		}
		await d.sleep(200);
	}
	await leg.ctx.waitForIdle(); // 确保空闲后再发

	// (1) 先订阅，再发送（防竞态：settled 必须在 send 之前挂上）
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

	// (2) 发送提示词（expandPromptTemplates: true，与手工输入行为一致）
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

	// (3) 等待 settled / 发送失败 / 看门狗
	const startedAt = d.now();
	const timeoutMs = d.sendFailTimeoutMs ?? 10_000;
	try {
		for (;;) {
			const racers: Promise<"settled" | "send" | "tick">[] = [
				settledP.then(() => "settled" as const),
				d.sleep(500).then(() => "tick" as const),
			];
			// sendP 已决后不再入列：避免 send 分支提前 resolve 时形成无退避的紧循环
			if (sendP && !sendResolved && sendError === undefined) racers.push(sendP.then(() => "send" as const));
			const winner = await Promise.race(racers);

			if (winner === "settled") break;
			if (winner === "send") {
				if (sendError !== undefined) {
					return { outcome: "send-failed", error: `发送失败：${shortError(msgOf(sendError))}` };
				}
				if (!settledEvent) {
					debug(`early-send-resolve task=${record.index}`);
					// 消息被排队/延迟等极端情况：send promise 提前 resolve，但本轮尚未 settle；
					// 退避后继续等 settled（sendP 已不再入列，后续靠 tick 推进）
					await d.sleep(250);
					continue;
				}
				break;
			}
			// tick：刷新状态栏 + 发送失败看门狗
			onTick();
			if (!settledEvent && d.now() - startedAt > timeoutMs && leg.ctx.isIdle() && (!sendP || sendResolved)) {
				return {
					outcome: "send-failed",
					error: `发送后 ${Math.round(timeoutMs / 1000)}s 内未开始任何运行（请检查模型与认证配置）`,
				};
			}
		}
	} finally {
		off();
	}

	// (4) 双保险：settled 后再 waitForIdle（正常立即返回；期间排队的新消息会自然等到其结束）
	await leg.ctx.waitForIdle();

	// (5) 结果判定
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

/** 当前分支上最后一条 assistant 消息（含 stopReason / errorMessage） */
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
// 汇总收尾
// ============================================================================

/** 批次收尾：notify + widget + report.md + progress 改名 + 状态清理。幂等。 */
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

	// 防御：不应有停留在 running 的任务
	for (const t of state.tasks) {
		if (t.status === "running") {
			t.status = "pending";
			t.endedAt = endedAt;
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
	} catch (e) {
		// UI 不可用时尽力保留报告
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
		// 改名失败保留原 progress 文件即可
	}
	try {
		leg.ctx.ui.setStatus("batch", undefined);
	} catch {
		// ignore
	}
	d.onBatchEnd?.();
}
