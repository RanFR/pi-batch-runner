/**
 * Executor unit tests: hand-written fakes (no real pi process / real model).
 *
 * Fake semantics:
 * - Root-session send returns void (pi.sendUserMessage); sends on fresh/
 *   switched sessions return a Promise that resolves on settle
 *   (ReplacedSessionContext.sendUserMessage);
 * - Task results are driven by an outcomes queue: "ok" | "error" | "aborted" |
 *   "noshow" (never settles after send, for the send-failure watchdog) |
 *   "silent" (the run happens normally but settled is never published on the
 *   bus, modeling a broken event bridge);
 * - sleep yields a real macrotask while advancing a virtual clock, so settled
 *   timers get a chance to run first.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBatch, createStopHandle, lastAssistantMessage, type StartPoint, type StopHandle } from "../lib/executor.ts";
import type { BatchContext, BatchLeg, BatchState, BranchEntryView, EngineDeps, OnExhaust, SettledBus, TaskMode } from "../lib/types.ts";

// ============================================================================
// Fake infrastructure
// ============================================================================

type Outcome = "ok" | "error" | "aborted" | "noshow" | "reject" | "silent";

interface SelectCall {
	title: string;
	options: string[];
}

interface NotifyCall {
	message: string;
	type?: string;
}

interface FakeSession {
	sessionFile: string;
	branch: BranchEntryView[];
	pending: number;
	idle: boolean;
	sends: string[];
	children: FakeSession[];
	newSessionCalls: number;
	newSessionNames: Array<string | undefined>;
	switchCalls: string[];
	/** Whether send returns a Promise (fresh-context behavior). */
	returnsPromise: boolean;
	resolvers: Array<() => void>;
	leg: BatchLeg;
	depth: number;
}

interface Harness {
	bus: SettledBus & { publish: (e: { aborted: boolean }) => void };
	ui: {
		select: (title: string, options: string[]) => Promise<string | undefined>;
		notify: (message: string, type?: "info" | "warning" | "error") => void;
		setStatus: (key: string, text: string | undefined) => void;
		setWidget: (key: string, content: string[] | undefined) => void;
	};
	selects: SelectCall[];
	selectResponses: string[];
	notifies: NotifyCall[];
	statuses: Array<string | undefined>;
	widgets: Array<string[] | undefined>;
	root: FakeSession;
	allSessions: FakeSession[];
	log: string[];
	outcomes: Outcome[];
	errorMessage: string;
	newSessionCancelled: boolean;
	batchEnded: number;
	vnow: number;
	stop: StopHandle;
	onSend?: (session: FakeSession, prompt: string) => void;
	sendFailTimeoutMs: number;
	sendFailVoidGraceMs?: number;
	neverDrain?: boolean;
	throwOnWait?: boolean;
	switchFails?: boolean;
	settle: (outcome: Outcome) => void;
	makeSession: (depth: number, sessionFile?: string) => FakeSession;
}

function makeHarness(opts?: {
	outcomes?: Outcome[];
	selectResponses?: string[];
	retries?: number;
	onExhaust?: OnExhaust;
	newSessionCancelled?: boolean;
	sendFailTimeoutMs?: number;
	sendFailVoidGraceMs?: number;
	neverDrain?: boolean;
	throwOnWait?: boolean;
	switchFails?: boolean;
}): { harness: Harness; state: BatchState; tmp: string } {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-batch-test-"));
	const listFile = path.join(tmp, "list.md");
	fs.writeFileSync(listFile, "fixture", "utf-8");

	const harness = {
		selects: [],
		selectResponses: opts?.selectResponses ? [...opts.selectResponses] : [],
		notifies: [],
		statuses: [],
		widgets: [],
		allSessions: [],
		log: [],
		outcomes: opts?.outcomes ? [...opts.outcomes] : [],
		errorMessage: "模拟错误 boom",
		newSessionCancelled: opts?.newSessionCancelled ?? false,
		batchEnded: 0,
		vnow: 1_000_000,
		stop: createStopHandle(),
		sendFailTimeoutMs: opts?.sendFailTimeoutMs ?? 1500,
		sendFailVoidGraceMs: opts?.sendFailVoidGraceMs,
		neverDrain: opts?.neverDrain,
		throwOnWait: opts?.throwOnWait,
		switchFails: opts?.switchFails,
	} as unknown as Harness;

	const subscribers = new Set<(e: { aborted: boolean }) => void>();
	harness.bus = {
		subscribe(cb) {
			harness.log.push("subscribe");
			subscribers.add(cb);
			return () => subscribers.delete(cb);
		},
		publish(e) {
			for (const cb of subscribers) cb(e);
		},
	};

	harness.ui = {
		select: async (title, options) => {
			harness.selects.push({ title, options });
			return harness.selectResponses.shift();
		},
		notify: (message, type) => {
			harness.notifies.push({ message, type });
		},
		setStatus: (_key, text) => {
			harness.statuses.push(text);
		},
		setWidget: (_key, content) => {
			harness.widgets.push(content);
		},
	};

	harness.makeSession = (depth: number, sessionFile?: string): FakeSession => {
		const session = {
			sessionFile: sessionFile ?? path.join(tmp, `session-${harness.allSessions.length}.jsonl`),
			branch: [],
			pending: 0,
			idle: true,
			sends: [],
			children: [],
			newSessionCalls: 0,
			newSessionNames: [],
			switchCalls: [],
			returnsPromise: depth > 0,
			resolvers: [],
			depth,
		} as unknown as FakeSession;

		const settle = (outcome: Outcome) => {
			const stopReason = outcome === "ok" ? "stop" : outcome;
			session.branch.push({
				type: "message",
				message: {
					role: "assistant",
					stopReason,
					errorMessage: outcome === "error" ? harness.errorMessage : undefined,
				},
			});
			session.idle = true;
			harness.bus.publish({ aborted: outcome === "aborted" });
			for (const r of session.resolvers.splice(0)) r();
		};
		harness.settle = settle;

		session.leg = {
			ctx: {
				isIdle: () => session.idle,
				hasPendingMessages: () => session.pending > 0,
				waitForIdle: async () => {
					if (harness.throwOnWait) throw new Error("wait boom");
					if (!harness.neverDrain) session.pending = 0; // idle means the queue has drained
					while (!session.idle) await tick();
				},
				abort: () => {
					harness.log.push("abort");
				},
				sessionManager: {
					getSessionFile: () => session.sessionFile,
					getBranch: () => session.branch,
				},
				ui: harness.ui,
				newSession: async (o) => {
					session.newSessionCalls++;
					session.newSessionNames.push(o.name);
					harness.log.push(o.name ? `newSession:${o.name}` : "newSession");
					if (harness.newSessionCancelled) return { cancelled: true };
					const child = harness.makeSession(depth + 1);
					session.children.push(child);
					await o.withSession(child.leg);
					return { cancelled: false };
				},
				switchSession: async (p, o) => {
					session.switchCalls.push(p);
					harness.log.push(`switch:${p}`);
					if (harness.switchFails) throw new Error("switch boom");
					const target = harness.makeSession(depth + 1, p);
					await o.withSession(target.leg);
					return { cancelled: false };
				},
			} satisfies BatchContext,
			send: (content) => {
				harness.log.push(`send:${content}`);
				session.sends.push(content);
				harness.onSend?.(session, content);
				const outcome = harness.outcomes.length > 0 ? harness.outcomes.shift()! : "ok";
				if (outcome === "noshow") {
					// Send accepted but the run never starts: stay idle.
					return session.returnsPromise ? new Promise<void>(() => {}) : undefined;
				}
				if (outcome === "silent") {
					// The run happens normally (branch advances, idle flips, send
					// promise resolves) but agent_settled is never published on the
					// bus (models a broken event bridge after /reload).
					session.idle = false;
					const p = new Promise<void>((resolve) => {
						session.resolvers.push(() => resolve());
					});
					setTimeout(() => {
						session.branch.push({
							type: "message",
							message: { role: "assistant", stopReason: "stop", errorMessage: undefined },
						});
						session.idle = true;
						for (const r of session.resolvers.splice(0)) r();
					}, 0);
					return session.returnsPromise ? p : undefined;
				}
				if (outcome === "reject") {
					// Send promise rejects outright (ReplacedSessionContext.sendUserMessage failure path).
					return session.returnsPromise ? Promise.reject(new Error("send boom")) : undefined;
				}
				session.idle = false;
				const p = new Promise<void>((resolve) => {
					session.resolvers.push(() => resolve());
				});
				setTimeout(() => settle(outcome), 0);
				return session.returnsPromise ? p : undefined;
			},
		};

		harness.allSessions.push(session);
		return session;
	};

	harness.root = harness.makeSession(0);

	const state: BatchState = {
		listFile,
		batchTitle: "list",
		startedAt: 1,
		updatedAt: 1,
		retries: opts?.retries ?? 0,
		onExhaust: opts?.onExhaust ?? "pause",
		tasks: [],
	};

	return { harness, state, tmp };
}

function addTasks(state: BatchState, defs: Array<[TaskMode, string, string?]>): void {
	for (const [mode, title, name] of defs) {
		state.tasks.push({
			index: state.tasks.length + 1,
			mode,
			title,
			...(name !== undefined ? { name } : {}),
			prompt: `prompt-${state.tasks.length + 1}-${title}`,
			status: "pending",
			attempts: 0,
		});
	}
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function makeDeps(h: Harness): EngineDeps {
	return {
		settled: h.bus,
		now: () => h.vnow,
		sleep: async (ms: number) => {
			h.vnow += Math.max(ms, 250);
			await tick(); // Yield to macrotasks so settle timers can run.
		},
		sendFailTimeoutMs: h.sendFailTimeoutMs,
		sendFailVoidGraceMs: h.sendFailVoidGraceMs,
		onBatchEnd: () => {
			h.batchEnded++;
		},
	};
}

async function run(h: Harness, state: BatchState, start: StartPoint = { kind: "direct", index: 0 }): Promise<void> {
	await startBatch(makeDeps(h), h.root.leg, state, start, h.stop);
}

afterEach(() => {
	// No state shared across tests.
});

// ============================================================================
// Tests
// ============================================================================

describe("executor: sequential execution and advancing", () => {
	it("consecutive tasks in one session run in order and all succeed", async () => {
		const { harness: h, state, tmp } = makeHarness({ outcomes: ["ok", "ok", "ok"] });
		addTasks(state, [
			["continue", "任务一"],
			["continue", "任务二"],
			["continue", "任务三"],
		]);

		await run(h, state);

		expect(h.root.sends).toEqual(["prompt-1-任务一", "prompt-2-任务二", "prompt-3-任务三"]);
		expect(state.tasks.map((t) => t.status)).toEqual(["ok", "ok", "ok"]);
		expect(h.batchEnded).toBe(1);
		// Summary artifacts.
		expect(fs.existsSync(path.join(tmp, "list.md.progress.json"))).toBe(false);
		expect(fs.existsSync(path.join(tmp, "list.md.progress.json.done"))).toBe(true);
		expect(fs.existsSync(path.join(tmp, "list.md.report.md"))).toBe(true);
		const report = fs.readFileSync(path.join(tmp, "list.md.report.md"), "utf-8");
		expect(report).toContain("任务一");
		// Widget set and status bar cleared (last setStatus is undefined).
		expect(h.widgets.length).toBeGreaterThan(0);
		expect(h.statuses[h.statuses.length - 1]).toBeUndefined();
	});

	it("continue tasks do not trigger newSession; new tasks use the fresh leg from the withSession callback", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok", "ok", "ok", "ok"] });
		addTasks(state, [
			["new", "任务一"],
			["new", "任务二"],
			["continue", "任务三"],
			["new", "任务四"],
		]);

		await run(h, state);

		expect(h.root.newSessionCalls).toBe(1);
		const child = h.root.children[0]!;
		expect(child.newSessionCalls).toBe(1);
		// Task 1 runs in child; tasks 2/3 in grandchild; task 4 in great-grandchild.
		expect(child.sends).toEqual(["prompt-1-任务一"]);
		// No name given: newSession without a name (unnamed); log shows a bare newSession.
		expect(h.root.newSessionNames[0]).toBeUndefined();
		expect(h.log).toContain("newSession");
		const grand = child.children[0]!;
		expect(grand.sends).toEqual(["prompt-2-任务二", "prompt-3-任务三"]);
		const great = grand.children[0]!;
		expect(great.sends).toEqual(["prompt-4-任务四"]);
		expect(state.tasks.every((t) => t.status === "ok")).toBe(true);
		// Session files are recorded per leg.
		expect(state.tasks[0]!.sessionFile).toBe(child.sessionFile);
		expect(state.tasks[2]!.sessionFile).toBe(grand.sessionFile);
	});

	it("a new task with an explicit name is passed verbatim to newSession (no auto-generated name)", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok", "ok"] });
		addTasks(state, [
			["new", "任务一", "数据导入重构"],
			["continue", "任务二"],
		]);

		await run(h, state);

		expect(h.root.newSessionNames[0]).toBe("数据导入重构");
		expect(h.log).toContain("newSession:数据导入重构");
		// The auto-naming template (批次名 · 任务N 标题) no longer appears.
		expect(h.log.every((l) => !l.includes(" · 任务"))).toBe(true);
		expect(state.tasks.every((t) => t.status === "ok")).toBe(true);
	});

	it("a fresh resume start point also passes an explicit name through", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok"] });
		addTasks(state, [["new", "恢复的任务", "恢复会话名"]]);

		await run(h, state, { kind: "fresh", index: 0 });

		expect(h.root.newSessionNames[0]).toBe("恢复会话名");
		expect(state.tasks[0]!.status).toBe("ok");
	});

	it("a first task marked continue runs in the current session (no newSession)", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok"] });
		addTasks(state, [["continue", "接着手工会话跑"]]);

		await run(h, state);

		expect(h.root.newSessionCalls).toBe(0);
		expect(h.root.sends).toEqual(["prompt-1-接着手工会话跑"]);
		expect(state.tasks[0]!.status).toBe("ok");
	});

	it("subscribes before sending (settled race protection)", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok", "ok"] });
		addTasks(state, [
			["continue", "A"],
			["continue", "B"],
		]);

		await run(h, state);

		const firstSub = h.log.indexOf("subscribe");
		const firstSend = h.log.findIndex((l) => l.startsWith("send:"));
		expect(firstSub).toBeGreaterThanOrEqual(0);
		expect(firstSend).toBeGreaterThan(firstSub);
		// Each attempt re-subscribes before sending (a second subscribe precedes the second send).
		const secondSend = h.log.findIndex((l, i) => i > firstSend && l.startsWith("send:"));
		const secondSub = h.log.indexOf("subscribe", firstSub + 1);
		expect(secondSub).toBeGreaterThan(-1);
		expect(secondSub).toBeLessThan(secondSend);
	});
});

describe("executor: failure retries and exhaustion", () => {
	it("error → auto retry → success; retry notices are warnings", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["error", "error", "ok"], retries: 3 });
		addTasks(state, [["continue", "易失败任务"]]);

		await run(h, state);

		expect(h.root.sends).toHaveLength(3);
		expect(state.tasks[0]).toMatchObject({ status: "ok", attempts: 3 });
		const warnings = h.notifies.filter((n) => n.type === "warning");
		expect(warnings.length).toBe(2);
		expect(warnings[0]!.message).toContain("第 1/4 次");
	});

	it("exhausted retries + onExhaust=skip: records the failure and moves on (no dialog)", async () => {
		const { harness: h, state } = makeHarness({
			outcomes: ["error", "error", "ok", "ok"],
			retries: 1,
			onExhaust: "skip",
		});
		addTasks(state, [
			["continue", "会挂的任务"],
			["continue", "后续任务"],
		]);

		await run(h, state);

		expect(h.selects).toHaveLength(0);
		expect(state.tasks[0]).toMatchObject({ status: "failed", attempts: 2 });
		expect(state.tasks[0]!.error).toContain("boom");
		expect(state.tasks[1]!.status).toBe("ok");
	});

	it("exhausted retries + onExhaust=abort: terminates the whole batch", async () => {
		const { harness: h, state } = makeHarness({
			outcomes: ["error", "error", "ok"],
			retries: 1,
			onExhaust: "abort",
		});
		addTasks(state, [
			["continue", "会挂的任务"],
			["continue", "不该运行的任务"],
		]);

		await run(h, state);

		expect(h.root.sends).toHaveLength(2); // One retry only; task 2 never runs.
		expect(state.tasks[0]!.status).toBe("failed");
		expect(state.tasks[1]!.status).toBe("pending");
	});

	it("exhausted retries + onExhaust=pause: all three dialog paths", async () => {
		// Path 1: skip.
		{
			const { harness: h, state } = makeHarness({
				outcomes: ["error", "error", "ok"],
				retries: 1,
				onExhaust: "pause",
				selectResponses: ["跳过，继续下一条"],
			});
			addTasks(state, [
				["continue", "挂"],
				["continue", "后续"],
			]);
			await run(h, state);
			expect(h.selects[0]!.options).toEqual(["重试本条(同会话)", "跳过，继续下一条", "终止整批"]);
			expect(state.tasks[0]!.status).toBe("failed");
			expect(state.tasks[1]!.status).toBe("ok");
		}
		// Path 2: retry in place (attempts accumulate), fail again → asked again → skip.
		{
			const { harness: h, state } = makeHarness({
				outcomes: ["error", "error", "error"],
				retries: 1,
				onExhaust: "pause",
				selectResponses: ["重试本条(同会话)", "跳过，继续下一条"],
			});
			addTasks(state, [["continue", "挂"]]);
			await run(h, state);
			expect(h.selects).toHaveLength(2);
			expect(state.tasks[0]).toMatchObject({ status: "failed", attempts: 3 });
		}
		// Path 3: terminate the batch.
		{
			const { harness: h, state } = makeHarness({
				outcomes: ["error", "error", "ok"],
				retries: 1,
				onExhaust: "pause",
				selectResponses: ["终止整批"],
			});
			addTasks(state, [
				["continue", "挂"],
				["continue", "不该运行"],
			]);
			await run(h, state);
			expect(state.tasks[1]!.status).toBe("pending");
		}
		// Path 4: dialog dismissed (undefined) → terminate.
		{
			const { harness: h, state } = makeHarness({
				outcomes: ["error", "error"],
				retries: 1,
				onExhaust: "pause",
				selectResponses: [],
			});
			addTasks(state, [["continue", "挂"]]);
			await run(h, state);
			expect(state.tasks[0]!.status).toBe("failed");
			expect(h.selects).toHaveLength(1);
		}
	});
});

describe("executor: interruption (Esc) and stopping", () => {
	it("aborted → choosing skip continues", async () => {
		const { harness: h, state } = makeHarness({
			outcomes: ["aborted", "ok"],
			selectResponses: ["跳过，继续下一条"],
		});
		addTasks(state, [
			["continue", "被打断"],
			["continue", "后续"],
		]);

		await run(h, state);

		expect(h.selects[0]!.options).toEqual(["重试本条", "跳过，继续下一条", "终止整批"]);
		expect(state.tasks[0]!.status).toBe("skipped");
		expect(state.tasks[1]!.status).toBe("ok");
	});

	it("aborted → choosing retry succeeds", async () => {
		const { harness: h, state } = makeHarness({
			outcomes: ["aborted", "ok"],
			selectResponses: ["重试本条"],
		});
		addTasks(state, [["continue", "被打断"]]);

		await run(h, state);

		expect(h.root.sends.filter((p) => p.includes("被打断"))).toHaveLength(2);
		expect(state.tasks[0]!.status).toBe("ok");
	});

	it("aborted → choosing terminate", async () => {
		const { harness: h, state } = makeHarness({
			outcomes: ["aborted", "ok"],
			selectResponses: ["终止整批"],
		});
		addTasks(state, [
			["continue", "被打断"],
			["continue", "不该运行"],
		]);

		await run(h, state);
		expect(state.tasks[1]!.status).toBe("pending");
	});

	it("stop --now: an aborted run terminates directly without a dialog", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["aborted", "ok"] });
		addTasks(state, [
			["continue", "任务一"],
			["continue", "任务二"],
		]);
		h.onSend = (_session, prompt) => {
			if (prompt.includes("任务一")) h.stop.stopFlag = "now";
		};

		await run(h, state);

		expect(h.selects).toHaveLength(0);
		// ctx.abort() is invoked by index.ts's stop command layer (see manual
		// acceptance); the engine only finalizes based on aborted.
		expect(state.tasks[0]!.status).toBe("failed");
		expect(state.tasks[1]!.status).toBe("pending");
	});

	it("gentle stop: no advancing after the current task ends naturally", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok", "ok", "ok"] });
		addTasks(state, [
			["continue", "任务一"],
			["continue", "任务二"],
			["continue", "任务三"],
		]);
		h.onSend = (_session, prompt) => {
			if (prompt.includes("任务二")) h.stop.stopFlag = "gentle";
		};

		await run(h, state);

		expect(state.tasks[0]!.status).toBe("ok");
		expect(state.tasks[1]!.status).toBe("ok");
		expect(state.tasks[2]!.status).toBe("pending");
		expect(h.notifies.some((n) => n.message.includes("未执行 1"))).toBe(true);
	});
});

describe("executor: send failures and queued messages", () => {
	it("stays idle after send (no run starts) → watchdog fails the task (void send, zero grace)", async () => {
		const { harness: h, state } = makeHarness({
			outcomes: ["noshow", "ok"],
			retries: 0,
			onExhaust: "skip",
			sendFailTimeoutMs: 750,
			sendFailVoidGraceMs: 0,
		});
		addTasks(state, [
			["continue", "发不出去"],
			["continue", "后续"],
		]);

		await run(h, state);

		expect(state.tasks[0]).toMatchObject({ status: "failed", attempts: 1 });
		expect(state.tasks[0]!.error).toContain("未开始任何运行");
		expect(state.tasks[1]!.status).toBe("ok");
	});

	it("void-send watchdog includes the grace period: message reports base window + grace (tolerates slow auth / weak network)", async () => {
		const { harness: h, state } = makeHarness({
			outcomes: ["noshow", "ok"],
			retries: 0,
			onExhaust: "skip",
			sendFailTimeoutMs: 400,
			sendFailVoidGraceMs: 600,
		});
		addTasks(state, [
			["continue", "发不出去"],
			["continue", "后续"],
		]);

		await run(h, state);

		expect(state.tasks[0]).toMatchObject({ status: "failed" });
		// 400ms base window + 600ms grace = 1000ms → the message says 1s (0s without grace).
		expect(state.tasks[0]!.error).toContain("1s 内未开始任何运行");
		expect(state.tasks[0]!.error).not.toContain("事件桥");
	});

	it("run finished but settled never arrived (broken event bridge) → fails with an event-bridge/agent_settled hint", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["silent"], retries: 0, onExhaust: "skip" });
		addTasks(state, [["new", "桥断了"]]);

		await run(h, state);

		expect(state.tasks[0]).toMatchObject({ status: "failed" });
		expect(state.tasks[0]!.error).toContain("agent_settled");
		expect(state.tasks[0]!.error).toContain("事件桥");
	});

	it("queued messages before sending: drain first, then send", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok"] });
		addTasks(state, [["continue", "任务一"]]);
		h.root.pending = 2;

		await run(h, state);

		expect(h.root.sends).toEqual(["prompt-1-任务一"]);
		expect(state.tasks[0]!.status).toBe("ok");
	});

	it("an error outcome with errorMessage: written into the task record", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["error"], retries: 0, onExhaust: "skip" });
		addTasks(state, [["continue", "会挂"]]);

		await run(h, state);
		expect(state.tasks[0]!.error).toBe("模拟错误 boom");
	});
});

describe("executor: resume start points", () => {
	it("switch start: switches to the previous session file and continues at the given task", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok", "ok"] });
		addTasks(state, [
			["new", "已完成"],
			["continue", "断点任务"],
		]);
		state.tasks[0]!.status = "ok";
		const prevSessionFile = path.join("/tmp", "prev-session.jsonl");
		state.tasks[0]!.sessionFile = prevSessionFile;

		await run(h, state, { kind: "switch", sessionFile: prevSessionFile, index: 1 });

		expect(h.root.switchCalls).toEqual([prevSessionFile]);
		expect(h.root.sends).toHaveLength(0);
		expect(state.tasks[1]).toMatchObject({ status: "ok" });
		expect(state.tasks[1]!.sessionFile).toBe(prevSessionFile);
	});

	it("fresh start (fallback): continues in a new session", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok"] });
		addTasks(state, [
			["new", "已完成"],
			["continue", "断点任务"],
		]);
		state.tasks[0]!.status = "ok";

		await run(h, state, { kind: "fresh", index: 1 });

		expect(h.root.newSessionCalls).toBe(1);
		expect(h.root.children[0]!.sends).toEqual(["prompt-2-断点任务"]);
	});

	it("direct start skips completed tasks and begins at the breakpoint task", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok"] });
		addTasks(state, [
			["new", "已完成"],
			["new", "断点任务"],
		]);
		state.tasks[0]!.status = "ok";

		await run(h, state, { kind: "direct", index: 1 });

		// The breakpoint task is "new" → the engine calls newSession inside the loop.
		expect(h.root.newSessionCalls).toBe(1);
		expect(h.root.children[0]!.sends).toEqual(["prompt-2-断点任务"]);
	});
});

describe("executor: finalization", () => {
	it("a cancelled newSession → treated as terminating the batch and finalized", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok"], newSessionCancelled: true });
		addTasks(state, [["new", "任务一"]]);

		await run(h, state);

		expect(h.root.newSessionCalls).toBe(1);
		expect(h.root.sends).toHaveLength(0);
		expect(state.tasks[0]!.status).toBe("pending");
		expect(h.notifies.some((n) => n.message.includes("会话切换被取消"))).toBe(true);
		expect(h.batchEnded).toBe(1);
	});

	it("summary notification distinguishes warning (failures) from info (all good)", async () => {
		{
			const { harness: h, state } = makeHarness({ outcomes: ["ok", "ok"] });
			addTasks(state, [
				["continue", "A"],
				["continue", "B"],
			]);
			await run(h, state);
			expect(h.notifies.at(-1)!.type).toBe("info");
		}
		{
			const { harness: h, state } = makeHarness({
				outcomes: ["error", "error", "ok"],
				retries: 1,
				onExhaust: "skip",
			});
			addTasks(state, [["continue", "挂"]]);
			await run(h, state);
			expect(h.notifies.at(-1)!.type).toBe("warning");
		}
	});

	it("the progress file is persisted immediately as tasks start/finish", async () => {
		const { harness: h, state, tmp } = makeHarness({ outcomes: ["ok", "ok"] });
		addTasks(state, [
			["continue", "A"],
			["continue", "B"],
		]);
		let sawRunning = false;
		const origSend = h.root.leg.send;
		h.root.leg.send = (content, options) => {
			const raw = fs.readFileSync(path.join(tmp, "list.md.progress.json"), "utf-8");
			if (raw.includes('"status": "running"')) sawRunning = true;
			return origSend(content, options);
		};

		await run(h, state);
		expect(sawRunning).toBe(true);
	});
});

// ============================================================================
// Extras: outcome judgment / send exceptions / fallbacks / drain timeout / preset stop
// ============================================================================

describe("lastAssistantMessage (exported-function unit tests)", () => {
	it("empty branch → undefined", () => {
		const ctx = { sessionManager: { getSessionFile: () => undefined, getBranch: () => [] } } as unknown as BatchContext;
		expect(lastAssistantMessage(ctx)).toBeUndefined();
	});

	it("finds the last assistant from the branch end, skipping user and non-message entries", () => {
		const branch: BranchEntryView[] = [
			{ type: "message", message: { role: "user" } },
			{ type: "summary" },
			{ type: "message", message: { role: "assistant", stopReason: "stop", errorMessage: undefined } },
			{ type: "message", message: { role: "user" } },
		];
		const ctx = { sessionManager: { getSessionFile: () => undefined, getBranch: () => branch } } as unknown as BatchContext;
		expect(lastAssistantMessage(ctx)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("no assistant on the branch → undefined", () => {
		const branch: BranchEntryView[] = [{ type: "message", message: { role: "user" } }];
		const ctx = { sessionManager: { getSessionFile: () => undefined, getBranch: () => branch } } as unknown as BatchContext;
		expect(lastAssistantMessage(ctx)).toBeUndefined();
	});
});

describe("executor: send exceptions", () => {
	it("send throws synchronously → send-failed (retries 0 + skip → failed)", async () => {
		const { harness: h, state } = makeHarness({ retries: 0, onExhaust: "skip" });
		h.onSend = () => {
			throw new Error("sync boom");
		};
		addTasks(state, [["continue", "发不出去"]]);

		await run(h, state);

		expect(state.tasks[0]).toMatchObject({ status: "failed", attempts: 1 });
		expect(state.tasks[0]!.error).toContain("发送失败");
		expect(state.tasks[0]!.error).toContain("sync boom");
	});

	it("send returns a rejected Promise → send-failed, later tasks proceed", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["reject", "ok"], retries: 0, onExhaust: "skip" });
		addTasks(state, [
			["new", "发不出去"],
			["continue", "后续"],
		]);

		await run(h, state);

		expect(state.tasks[0]).toMatchObject({ status: "failed", attempts: 1 });
		expect(state.tasks[0]!.error).toContain("发送失败");
		expect(state.tasks[0]!.error).toContain("send boom");
		// Failed tasks also refresh their landing session: sessionFile points at
		// the new session of this attempt, not the stale pre-send value (the
		// report.md session column stays present and correct).
		expect(state.tasks[0]!.sessionFile).toBe(h.root.children[0]!.sessionFile);
		expect(state.tasks[1]!.status).toBe("ok");
	});
});

describe("executor: fallbacks and internal-error safety net", () => {
	it("switchSession throws on a switch start → notify fallback → continues in a fresh session", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok"], switchFails: true });
		addTasks(state, [
			["new", "已完成"],
			["continue", "断点任务"],
		]);
		state.tasks[0]!.status = "ok";
		state.tasks[0]!.sessionFile = path.join("/tmp", "prev-session.jsonl");

		await run(h, state, { kind: "switch", sessionFile: state.tasks[0]!.sessionFile, index: 1 });

		expect(h.notifies.some((n) => n.type === "warning" && n.message.includes("无法恢复会话"))).toBe(true);
		expect(h.root.newSessionCalls).toBe(1);
		expect(h.root.children[0]!.sends).toEqual(["prompt-2-断点任务"]);
		expect(state.tasks[1]!.status).toBe("ok");
	});

	it("fresh start + cancelled newSession → terminates the batch and finalizes", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok"], newSessionCancelled: true });
		addTasks(state, [
			["new", "已完成"],
			["continue", "断点任务"],
		]);
		state.tasks[0]!.status = "ok";

		await run(h, state, { kind: "fresh", index: 1 });

		expect(h.notifies.some((n) => n.message.includes("会话切换被取消"))).toBe(true);
		expect(state.tasks[1]!.status).toBe("pending");
		expect(h.batchEnded).toBe(1);
	});

	it("waitForIdle throws → startBatch safety net (internal-error summary + running reset to pending + report still written)", async () => {
		const { harness: h, state, tmp } = makeHarness({ outcomes: ["ok"], throwOnWait: true });
		addTasks(state, [["continue", "任务一"]]);

		await run(h, state);

		expect(h.notifies.some((n) => n.message.includes("内部错误"))).toBe(true);
		expect(h.batchEnded).toBe(1);
		expect(fs.existsSync(path.join(tmp, "list.md.report.md"))).toBe(true);
		expect(state.tasks[0]!.status).toBe("pending");
		expect(state.tasks[0]!.error).toBe("批次提前结束");
		// A task reset to pending never really finished: it must not carry an
		// endedAt (report semantic noise).
		expect(state.tasks[0]!.endedAt).toBeUndefined();
	});
});

describe("executor: drain timeout and preset stop", () => {
	it("queued messages never drain → send-failed after the 5-minute drain ceiling", async () => {
		const { harness: h, state } = makeHarness({ retries: 0, onExhaust: "skip", neverDrain: true });
		addTasks(state, [["continue", "排不上队"]]);
		h.root.pending = 2;

		await run(h, state);

		expect(state.tasks[0]).toMatchObject({ status: "failed" });
		expect(state.tasks[0]!.error).toContain("等待既有排队消息消化超时");
	}, 20_000);

	it("stopFlag=gentle preset before running → finalizes immediately, all tasks stay pending", async () => {
		const { harness: h, state } = makeHarness({ outcomes: [] });
		addTasks(state, [
			["continue", "任务一"],
			["continue", "任务二"],
		]);
		h.stop.stopFlag = "gentle";

		await run(h, state);

		expect(h.root.sends).toHaveLength(0);
		expect(state.tasks.map((t) => t.status)).toEqual(["pending", "pending"]);
		expect(h.notifies.some((n) => n.message.includes("未执行 2"))).toBe(true);
	});
});
