/**
 * 执行引擎单元测试：手写 fake 驱动（不依赖真实 pi 进程 / 真实模型）。
 *
 * fake 语义：
 * - 根会话 send 返回 void（对应 pi.sendUserMessage）；新会话/切换目标的 send 返回
 *   Promise 且在 settle 时 resolve（对应 ReplacedSessionContext.sendUserMessage）；
 * - 任务结果由 outcomes 队列驱动："ok" | "error" | "aborted" | "noshow"（发送后永远不 settle，
 *   用于发送失败看门狗）；
 * - sleep 为真实 macrotask 让位 + 虚拟时钟推进，保证 settled 定时器有机会先执行。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startBatch, createStopHandle, lastAssistantMessage, type StartPoint, type StopHandle } from "../lib/executor.ts";
import type {
	BatchContext,
	BatchLeg,
	BatchState,
	BranchEntryView,
	EngineDeps,
	OnExhaust,
	SettledBus,
	TaskMode,
} from "../lib/types.ts";

// ============================================================================
// fake 基础设施
// ============================================================================

type Outcome = "ok" | "error" | "aborted" | "noshow" | "reject";

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
	/** send 是否返回 Promise（fresh 上下文行为） */
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
					if (!harness.neverDrain) session.pending = 0; // 空闲即队列已消化
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
					// 发送被接受但运行永远不启动：保持 idle
					return session.returnsPromise ? new Promise<void>(() => { }) : undefined;
				}
				if (outcome === "reject") {
					// send promise 直接拒绝（对应 ReplacedSessionContext.sendUserMessage 失败路径）
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
			await tick(); // 让位 macrotask，settle 定时器得以执行
		},
		sendFailTimeoutMs: h.sendFailTimeoutMs,
		onBatchEnd: () => {
			h.batchEnded++;
		},
	};
}

async function run(
	h: Harness,
	state: BatchState,
	start: StartPoint = { kind: "direct", index: 0 },
): Promise<void> {
	await startBatch(makeDeps(h), h.root.leg, state, start, h.stop);
}

afterEach(() => {
	// 无跨用例状态
});

// ============================================================================
// 用例
// ============================================================================

describe("executor：顺序执行与推进", () => {
	it("同会话连续任务顺序执行并全部成功", async () => {
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
		// 汇总产物
		expect(fs.existsSync(path.join(tmp, "list.md.progress.json"))).toBe(false);
		expect(fs.existsSync(path.join(tmp, "list.md.progress.json.done"))).toBe(true);
		expect(fs.existsSync(path.join(tmp, "list.md.report.md"))).toBe(true);
		const report = fs.readFileSync(path.join(tmp, "list.md.report.md"), "utf-8");
		expect(report).toContain("任务一");
		// widget 已设置且状态栏已清除（最后一个 setStatus 为 undefined）
		expect(h.widgets.length).toBeGreaterThan(0);
		expect(h.statuses[h.statuses.length - 1]).toBeUndefined();
	});

	it("「继续」任务不触发 newSession，「新会话」任务经 withSession 回调使用 fresh leg", async () => {
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
		// 任务一在 child，任务二/三在 grandchild，任务四在 great-grandchild
		expect(child.sends).toEqual(["prompt-1-任务一"]);
		// 未指定 name：newSession 不带 name（不命名）；日志为裸 newSession
		expect(h.root.newSessionNames[0]).toBeUndefined();
		expect(h.log).toContain("newSession");
		const grand = child.children[0]!;
		expect(grand.sends).toEqual(["prompt-2-任务二", "prompt-3-任务三"]);
		const great = grand.children[0]!;
		expect(great.sends).toEqual(["prompt-4-任务四"]);
		expect(state.tasks.every((t) => t.status === "ok")).toBe(true);
		// 会话文件随 leg 记录
		expect(state.tasks[0]!.sessionFile).toBe(child.sessionFile);
		expect(state.tasks[2]!.sessionFile).toBe(grand.sessionFile);
	});

	it("「新会话」任务带显式 name 时精确透传给 newSession（不再拼接自动名）", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok", "ok"] });
		addTasks(state, [
			["new", "任务一", "数据导入重构"],
			["continue", "任务二"],
		]);

		await run(h, state);

		expect(h.root.newSessionNames[0]).toBe("数据导入重构");
		expect(h.log).toContain("newSession:数据导入重构");
		// 自动命名模板（批次名 · 任务N 标题）不再出现
		expect(h.log.every((l) => !l.includes(" · 任务"))).toBe(true);
		expect(state.tasks.every((t) => t.status === "ok")).toBe(true);
	});

	it("断点续跑 fresh 起点同样透传显式 name", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok"] });
		addTasks(state, [["new", "恢复的任务", "恢复会话名"]]);

		await run(h, state, { kind: "fresh", index: 0 });

		expect(h.root.newSessionNames[0]).toBe("恢复会话名");
		expect(state.tasks[0]!.status).toBe("ok");
	});

	it("首条任务为「继续」时在当前会话执行（不 newSession）", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok"] });
		addTasks(state, [["continue", "接着手工会话跑"]]);

		await run(h, state);

		expect(h.root.newSessionCalls).toBe(0);
		expect(h.root.sends).toEqual(["prompt-1-接着手工会话跑"]);
		expect(state.tasks[0]!.status).toBe("ok");
	});

	it("订阅先于发送（settled 竞态防护）", async () => {
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
		// 每次尝试前都重新挂一次性订阅（第二次 send 之前有第二次 subscribe）
		const secondSend = h.log.findIndex((l, i) => i > firstSend && l.startsWith("send:"));
		const secondSub = h.log.indexOf("subscribe", firstSub + 1);
		expect(secondSub).toBeGreaterThan(-1);
		expect(secondSub).toBeLessThan(secondSend);
	});
});

describe("executor：失败重试与耗尽", () => {
	it("error → 自动重试 → 成功；重试通知为 warning", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["error", "error", "ok"], retries: 3 });
		addTasks(state, [["continue", "易失败任务"]]);

		await run(h, state);

		expect(h.root.sends).toHaveLength(3);
		expect(state.tasks[0]).toMatchObject({ status: "ok", attempts: 3 });
		const warnings = h.notifies.filter((n) => n.type === "warning");
		expect(warnings.length).toBe(2);
		expect(warnings[0]!.message).toContain("第 1/4 次");
	});

	it("重试耗尽 + onExhaust=skip：记录失败并继续下一条（不弹选择框）", async () => {
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

	it("重试耗尽 + onExhaust=abort：终止整批", async () => {
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

		expect(h.root.sends).toHaveLength(2); // 只重试一次，不运行任务 2
		expect(state.tasks[0]!.status).toBe("failed");
		expect(state.tasks[1]!.status).toBe("pending");
	});

	it("重试耗尽 + onExhaust=pause：选择框三条路径", async () => {
		// 路径 1：跳过
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
		// 路径 2：重试本条（计数累计）后再挂 → 再次询问 → 跳过
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
		// 路径 3：终止整批
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
		// 路径 4：选择框被关闭（undefined）→ 终止
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

describe("executor：中断（Esc）与停止", () => {
	it("aborted → 选择「跳过」继续", async () => {
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

	it("aborted → 选择「重试本条」后成功", async () => {
		const { harness: h, state } = makeHarness({
			outcomes: ["aborted", "ok"],
			selectResponses: ["重试本条"],
		});
		addTasks(state, [["continue", "被打断"]]);

		await run(h, state);

		expect(h.root.sends.filter((p) => p.includes("被打断"))).toHaveLength(2);
		expect(state.tasks[0]!.status).toBe("ok");
	});

	it("aborted → 选择「终止整批」", async () => {
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

	it("stop --now：aborted 直接定案终止，不弹选择框", async () => {
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
		// ctx.abort() 由 index 的 stop 命令层调用（见手工验收），引擎只负责按 aborted 定案
		expect(state.tasks[0]!.status).toBe("failed");
		expect(state.tasks[1]!.status).toBe("pending");
	});

	it("温和停止：当前任务自然结束后不再推进", async () => {
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

describe("executor：发送失败与排队消息", () => {
	it("发送后始终空闲（无运行启动）→ 看门狗按失败处理", async () => {
		const { harness: h, state } = makeHarness({
			outcomes: ["noshow", "ok"],
			retries: 0,
			onExhaust: "skip",
			sendFailTimeoutMs: 750,
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

	it("发送前存在排队消息：先等待消化再发送", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok"] });
		addTasks(state, [["continue", "任务一"]]);
		h.root.pending = 2;

		await run(h, state);

		expect(h.root.sends).toEqual(["prompt-1-任务一"]);
		expect(state.tasks[0]!.status).toBe("ok");
	});

	it("error 结果带 errorMessage：写入任务记录", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["error"], retries: 0, onExhaust: "skip" });
		addTasks(state, [["continue", "会挂"]]);

		await run(h, state);
		expect(state.tasks[0]!.error).toBe("模拟错误 boom");
	});
});

describe("executor：断点续跑起点", () => {
	it("switch 起点：切换到前置会话文件并从指定任务继续", async () => {
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

	it("fresh 起点（降级）：新会话中继续", async () => {
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

	it("direct 起点跳过已完成任务，从断点任务开始", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok"] });
		addTasks(state, [
			["new", "已完成"],
			["new", "断点任务"],
		]);
		state.tasks[0]!.status = "ok";

		await run(h, state, { kind: "direct", index: 1 });

		// 断点任务是 new 模式 → 引擎在循环内 newSession
		expect(h.root.newSessionCalls).toBe(1);
		expect(h.root.children[0]!.sends).toEqual(["prompt-2-断点任务"]);
	});
});

describe("executor：收尾行为", () => {
	it("newSession 被取消 → 视为终止整批并收尾", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["ok"], newSessionCancelled: true });
		addTasks(state, [["new", "任务一"]]);

		await run(h, state);

		expect(h.root.newSessionCalls).toBe(1);
		expect(h.root.sends).toHaveLength(0);
		expect(state.tasks[0]!.status).toBe("pending");
		expect(h.notifies.some((n) => n.message.includes("会话切换被取消"))).toBe(true);
		expect(h.batchEnded).toBe(1);
	});

	it("汇总通知区分 warning（有失败）与 info（全成功）", async () => {
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

	it("progress 文件在任务开始/结束时即时落盘", async () => {
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
// 补充：结果判定 / 发送异常 / 降级与兜底 / 排水超时 / 预设停止
// ============================================================================

describe("lastAssistantMessage（导出函数单测）", () => {
	it("空 branch → undefined", () => {
		const ctx = { sessionManager: { getSessionFile: () => undefined, getBranch: () => [] } } as unknown as BatchContext;
		expect(lastAssistantMessage(ctx)).toBeUndefined();
	});

	it("从分支末尾向前找最后一条 assistant，跳过 user 与非 message 条目", () => {
		const branch: BranchEntryView[] = [
			{ type: "message", message: { role: "user" } },
			{ type: "summary" },
			{ type: "message", message: { role: "assistant", stopReason: "stop", errorMessage: undefined } },
			{ type: "message", message: { role: "user" } },
		];
		const ctx = { sessionManager: { getSessionFile: () => undefined, getBranch: () => branch } } as unknown as BatchContext;
		expect(lastAssistantMessage(ctx)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("branch 上没有 assistant → undefined", () => {
		const branch: BranchEntryView[] = [{ type: "message", message: { role: "user" } }];
		const ctx = { sessionManager: { getSessionFile: () => undefined, getBranch: () => branch } } as unknown as BatchContext;
		expect(lastAssistantMessage(ctx)).toBeUndefined();
	});
});

describe("executor：发送异常", () => {
	it("send 同步抛异常 → send-failed（retries 0 + skip → failed）", async () => {
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

	it("send 返回 rejected Promise → send-failed，后续任务正常", async () => {
		const { harness: h, state } = makeHarness({ outcomes: ["reject", "ok"], retries: 0, onExhaust: "skip" });
		addTasks(state, [
			["new", "发不出去"],
			["continue", "后续"],
		]);

		await run(h, state);

		expect(state.tasks[0]).toMatchObject({ status: "failed", attempts: 1 });
		expect(state.tasks[0]!.error).toContain("发送失败");
		expect(state.tasks[0]!.error).toContain("send boom");
		expect(state.tasks[1]!.status).toBe("ok");
	});
});

describe("executor：降级与内部错误兜底", () => {
	it("switch 起点 switchSession 抛错 → notify 降级 → 新会话中继续执行", async () => {
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

	it("fresh 起点 + newSession 被取消 → 终止整批并收尾", async () => {
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

	it("waitForIdle 抛错 → startBatch 兜底收尾（内部错误汇总 + running 重置 pending + report 仍生成）", async () => {
		const { harness: h, state, tmp } = makeHarness({ outcomes: ["ok"], throwOnWait: true });
		addTasks(state, [["continue", "任务一"]]);

		await run(h, state);

		expect(h.notifies.some((n) => n.message.includes("内部错误"))).toBe(true);
		expect(h.batchEnded).toBe(1);
		expect(fs.existsSync(path.join(tmp, "list.md.report.md"))).toBe(true);
		expect(state.tasks[0]!.status).toBe("pending");
		expect(state.tasks[0]!.error).toBe("批次提前结束");
	});
});

describe("executor：排队消化超时与预设停止", () => {
	it("排队消息永不消化 → 超过 5 分钟排水上限按 send-failed 处理", async () => {
		const { harness: h, state } = makeHarness({ retries: 0, onExhaust: "skip", neverDrain: true });
		addTasks(state, [["continue", "排不上队"]]);
		h.root.pending = 2;

		await run(h, state);

		expect(state.tasks[0]).toMatchObject({ status: "failed" });
		expect(state.tasks[0]!.error).toContain("等待既有排队消息消化超时");
	}, 20_000);

	it("运行前已置 stopFlag=gentle → 立即收尾，全部任务保持 pending", async () => {
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
