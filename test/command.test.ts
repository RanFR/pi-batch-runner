/**
 * Command-layer tests: drive the real index.ts extension factory with a fake
 * ExtensionAPI / ExtensionCommandContext.
 *
 * - Each test dynamically imports index.ts after vi.resetModules(), isolating
 *   the module-level activeBatch/settledListener between tests;
 * - The fake pi.sendUserMessage models the root session (returns void); the
 *   fresh contexts built by fake newSession/switchSession model
 *   ReplacedSessionContext (sendUserMessage returns a Promise resolving on
 *   settle);
 * - In holdSettle mode nothing settles automatically; tests advance explicitly
 *   via world.settleCurrent(outcome) (orchestration-style tests).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Fake infrastructure
// ============================================================================

type UiType = "info" | "warning" | "error" | undefined;
type Outcome = "ok" | "error" | "aborted";

interface FakeMessage {
	role: string;
	stopReason?: string;
	errorMessage?: string;
}

interface FakeEntry {
	type: string;
	message?: FakeMessage;
}

interface SessionState {
	sessionFile: string;
	branch: FakeEntry[];
	pending: number;
	idle: boolean;
	resolvers: Array<() => void>;
	returnsPromise: boolean;
	sends: string[];
}

interface CommandLike {
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

interface SetupOpts {
	mode?: string;
	hasUI?: boolean;
	isIdle?: boolean;
	holdSettle?: boolean;
	newSessionCancelled?: boolean;
	selectResponses?: string[];
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const openWorlds: Array<{ tmp: string }> = [];

const TWO_CONTINUE = "---\n[continue] 任务一\n正文一\n---\n[continue] 任务二\n正文二\n";
const THREE_CONTINUE = `${TWO_CONTINUE}---\n[continue] 任务三\n正文三\n`;

function writeManifest(world: { tmp: string }, name: string, content: string): string {
	const p = path.join(world.tmp, name);
	fs.writeFileSync(p, content, "utf-8");
	return p;
}

const progressPath = (world: { tmp: string }): string => path.join(world.tmp, "list.md.progress.json");
const donePath = (world: { tmp: string }): string => `${progressPath(world)}.done`;
const reportPath = (world: { tmp: string }): string => path.join(world.tmp, "list.md.report.md");

function readDone(world: { tmp: string }): any {
	return JSON.parse(fs.readFileSync(donePath(world), "utf-8"));
}

function savedTask(index: number, mode: "new" | "continue", status: string, extra?: Record<string, unknown>) {
	return { index, mode, title: `任务${index}`, prompt: `正文${index}`, status, attempts: 0, ...extra };
}

function writeProgress(world: { tmp: string }, tasks: unknown[], extra?: Record<string, unknown>): void {
	const state = {
		schemaVersion: 1,
		listFile: path.join(world.tmp, "list.md"),
		batchTitle: "list",
		startedAt: 1_000,
		updatedAt: 1_000,
		retries: 3,
		onExhaust: "pause",
		tasks,
		...(extra ?? {}),
	};
	fs.writeFileSync(progressPath(world), JSON.stringify(state, null, "\t"), "utf-8");
}

const lastNotify = (world: { notifies: Array<{ message: string; type?: UiType }> }) => world.notifies.at(-1)!;

async function setup(worldOpts?: SetupOpts) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-batch-cmd-test-"));
	openWorlds.push({ tmp });

	const world = {
		tmp,
		root: {
			sessionFile: path.join(tmp, "root-session.jsonl"),
			branch: [] as FakeEntry[],
			pending: 0,
			idle: worldOpts?.isIdle ?? true,
			resolvers: [] as Array<() => void>,
			returnsPromise: false,
			sends: [] as string[],
		} as SessionState,
		childSessions: [] as SessionState[],
		sent: [] as Array<{ content: string; options?: { expandPromptTemplates?: boolean }; from: SessionState }>,
		notifies: [] as Array<{ message: string; type?: UiType }>,
		selects: [] as Array<{ title: string; options: string[] }>,
		selectResponses: [...(worldOpts?.selectResponses ?? [])],
		statuses: [] as Array<string | undefined>,
		widgets: [] as Array<string[] | undefined>,
		abortCalls: 0,
		newSessionCalls: [] as Array<{ name: string | undefined; hasSetup: boolean }>,
		appendSessionNames: [] as string[],
		switchCalls: [] as string[],
		settledHandlers: [] as Array<(e: { aborted: boolean }) => void>,
		holdSettle: worldOpts?.holdSettle ?? false,
		newSessionCancelled: worldOpts?.newSessionCancelled ?? false,
		lastSentSession: undefined as SessionState | undefined,
		command: undefined as CommandLike | undefined,
		rootCtx: undefined as any,
		settleCurrent: (outcome: Outcome = "ok"): void => {
			settleSession(world.lastSentSession ?? world.root, outcome);
		},
	};

	function publish(e: { aborted: boolean }): void {
		for (const h of world.settledHandlers) h(e);
	}

	function settleSession(st: SessionState, outcome: Outcome): void {
		st.branch.push({
			type: "message",
			message: {
				role: "assistant",
				stopReason: outcome === "ok" ? "stop" : outcome,
				errorMessage: outcome === "error" ? "模拟错误 boom" : undefined,
			},
		});
		st.idle = true;
		for (const r of st.resolvers.splice(0)) r();
		publish({ aborted: outcome === "aborted" });
	}

	function makeSendFor(st: SessionState): (content: string, options?: { expandPromptTemplates?: boolean }) => void | Promise<void> {
		return (content, options) => {
			world.sent.push({ content, options, from: st });
			st.sends.push(content);
			world.lastSentSession = st;
			st.idle = false;
			const p = new Promise<void>((resolve) => {
				st.resolvers.push(() => resolve());
			});
			if (world.holdSettle) return st.returnsPromise ? p : undefined;
			setTimeout(() => settleSession(st, "ok"), 0);
			return st.returnsPromise ? p : undefined;
		};
	}

	function freshChild(sessionFile?: string): any {
		const st: SessionState = {
			sessionFile: sessionFile ?? path.join(tmp, `session-${world.childSessions.length + 1}.jsonl`),
			branch: [],
			pending: 0,
			idle: true,
			resolvers: [],
			returnsPromise: true,
			sends: [],
		};
		world.childSessions.push(st);
		return makeSessionCtx(st);
	}

	/** The root command context and fresh (ReplacedSessionContext-shaped) contexts share the same structure. */
	function makeSessionCtx(st: SessionState): any {
		return {
			mode: worldOpts?.mode ?? "tui",
			hasUI: worldOpts?.hasUI ?? true,
			cwd: tmp,
			isIdle: () => st.idle,
			hasPendingMessages: () => st.pending > 0,
			waitForIdle: async () => {
				st.pending = 0;
				while (!st.idle) await tick();
			},
			abort: () => {
				world.abortCalls++;
			},
			sendUserMessage: makeSendFor(st),
			sessionManager: {
				getSessionFile: () => st.sessionFile,
				getBranch: () => st.branch,
			},
			ui: {
				select: async (title: string, options: string[]) => {
					world.selects.push({ title, options });
					return world.selectResponses.shift();
				},
				notify: (message: string, type?: UiType) => {
					world.notifies.push({ message, type });
				},
				setStatus: (_key: string, text: string | undefined) => {
					world.statuses.push(text);
				},
				setWidget: (_key: string, content: string[] | undefined) => {
					world.widgets.push(content);
				},
			},
			newSession: async (o: {
				name?: string;
				setup?: (sm: { appendSessionInfo: (n: string) => string }) => Promise<void>;
				withSession: (fresh: unknown) => Promise<void>;
			}) => {
				world.newSessionCalls.push({ name: o.name, hasSetup: typeof o.setup === "function" });
				if (o.setup)
					await o.setup({
						appendSessionInfo: (n: string) => {
							world.appendSessionNames.push(n);
							return n;
						},
					});
				if (world.newSessionCancelled) return { cancelled: true };
				await o.withSession(freshChild());
				return { cancelled: false };
			},
			switchSession: async (p: string, o: { withSession: (fresh: unknown) => Promise<void> }) => {
				world.switchCalls.push(p);
				await o.withSession(freshChild(p));
				return { cancelled: false };
			},
		};
	}

	const pi = {
		on: (event: string, cb: (e: { aborted: boolean }) => void) => {
			if (event === "agent_settled") world.settledHandlers.push(cb);
		},
		registerCommand: (name: string, cmdOpts: CommandLike) => {
			expect(name).toBe("batch");
			world.command = cmdOpts;
		},
		sendUserMessage: (content: string, options?: { expandPromptTemplates?: boolean }) => makeSendFor(world.root)(content, options),
	};

	world.rootCtx = makeSessionCtx(world.root);

	vi.resetModules();
	const mod = await import("../index.ts");
	(mod.default as (pi: unknown) => void)(pi);
	const cmd = world.command;
	if (!cmd) throw new Error("/batch command not registered");

	// Default manifest: two "continue" tasks (tests may overwrite the same file).
	writeManifest(world, "list.md", TWO_CONTINUE);
	return { world, cmd, ctx: world.rootCtx };
}

afterEach(() => {
	for (const w of openWorlds.splice(0)) fs.rmSync(w.tmp, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// ============================================================================
// Routing and no-batch guards
// ============================================================================

describe("command layer: routing and no-batch guards", () => {
	it("empty args → usage (info)", async () => {
		const { world, cmd, ctx } = await setup();
		await cmd.handler("", ctx);
		expect(lastNotify(world).type).toBe("info");
		expect(lastNotify(world).message).toContain("用法");
		expect(lastNotify(world).message).toContain("--dry-run");
	});

	it("stop (no running batch) → 当前没有运行中的批次", async () => {
		const { world, cmd, ctx } = await setup();
		await cmd.handler("stop", ctx);
		expect(lastNotify(world).message).toBe("当前没有运行中的批次");
	});

	it("status (no progress file) → 当前没有正在运行或未完成的批次", async () => {
		const { world, cmd, ctx } = await setup();
		await cmd.handler("status", ctx);
		expect(lastNotify(world).message).toBe("当前没有正在运行或未完成的批次");
	});

	it("status (progress file in cwd) → summary notify + widget", async () => {
		const { world, cmd, ctx } = await setup();
		writeProgress(world, [savedTask(1, "new", "ok"), savedTask(2, "continue", "pending")]);
		await cmd.handler("status", ctx);
		expect(lastNotify(world).message).toBe("批次「list」结束：成功 1 / 未执行 1");
		const widget = world.widgets.at(-1)!;
		expect(widget?.[0]).toContain("── 批处理 · list ·");
	});

	it("status (multiple progress files in cwd) → picks the newest mtime, readdir order irrelevant", async () => {
		const { world, cmd, ctx } = await setup();
		writeProgress(world, [savedTask(1, "new", "ok"), savedTask(2, "continue", "ok")]);
		const other = {
			schemaVersion: 1,
			listFile: path.join(world.tmp, "other.md"),
			batchTitle: "other",
			startedAt: 1,
			updatedAt: 1,
			retries: 3,
			onExhaust: "pause",
			tasks: [savedTask(1, "new", "pending")],
		};
		fs.writeFileSync(path.join(world.tmp, "other.md.progress.json"), JSON.stringify(other), "utf-8");
		// Set mtimes explicitly: other is 10s newer than list (removes write-order
		// and timer-resolution flakiness).
		const now = Date.now();
		fs.utimesSync(path.join(world.tmp, "other.md.progress.json"), new Date(now), new Date(now));
		fs.utimesSync(progressPath(world), new Date(now - 10_000), new Date(now - 10_000));

		await cmd.handler("status", ctx);

		expect(lastNotify(world).message).toContain("「other」");
	});
});

// ============================================================================
// Argument validation (all side-effect free)
// ============================================================================

describe("command layer: argument validation (zero side effects)", () => {
	const cases: Array<[string, string]> = [
		["list.md --foo", "未知选项：--foo"],
		["--dry-run", "缺少清单文件参数"],
		["list.md --start", "缺少 --start 的参数值"],
		["list.md --retries", "缺少 --retries 的参数值"],
		["list.md --on-exhaust", "缺少 --on-exhaust 的参数值"],
		["list.md --start 0", "--start 需要 ≥ 1 的整数"],
		["list.md --start abc", "--start 需要 ≥ 1 的整数"],
		["list.md --start -1", "--start 需要 ≥ 1 的整数"],
		["list.md --retries -1", "--retries 需要 ≥ 0 的整数"],
		["list.md --retries abc", "--retries 需要 ≥ 0 的整数"],
		["list.md --on-exhaust bang", "--on-exhaust 只支持 pause|skip|abort"],
		["list.md extra.md", "多余参数"],
		["nope.md", "清单文件不存在"],
		["list.md --dry-run --start 5", "超出任务总数"],
	];

	for (const [args, expected] of cases) {
		it(`"${args}" → ${expected}`, async () => {
			const { world, cmd, ctx } = await setup();
			await cmd.handler(args, ctx);
			expect(lastNotify(world).type).toBe("error");
			expect(lastNotify(world).message).toContain(expected);
			expect(world.sent).toHaveLength(0);
			expect(fs.existsSync(progressPath(world))).toBe(false);
		});
	}

	it("--start beyond the task count", async () => {
		const { world, cmd, ctx } = await setup();
		await cmd.handler("list.md --start 5", ctx);
		expect(lastNotify(world).message).toBe("--start 5 超出任务总数（2）");
		expect(world.sent).toHaveLength(0);
	});

	it("--start 1.5 is truncated to 1 by parseInt (pins current behavior: runs normally)", async () => {
		const { world, cmd, ctx } = await setup();
		await cmd.handler("list.md --start 1.5", ctx);
		expect(world.sent).toHaveLength(2);
		expect(readDone(world).tasks.map((t: any) => t.status)).toEqual(["ok", "ok"]);
	});
});

// ============================================================================
// pi @ file-mention compatibility
// ============================================================================

// pi's editor inserts file completions as `@path` / `@"path with spaces"` and
// the core passes command args to extensions verbatim, so the raw args can
// carry the `@`; the batch must resolve them like plain paths (regression
// guard for the tokenizeArgs normalization).
describe("command layer: pi @ file-mention compatibility", () => {
	it("@list.md runs like a plain path", async () => {
		const { world, cmd, ctx } = await setup();
		await cmd.handler("@list.md", ctx);
		expect(world.sent).toHaveLength(2);
		expect(readDone(world).tasks.map((t: any) => t.status)).toEqual(["ok", "ok"]);
	});

	it('@"my list.md" (quoted at-prefix, spaced filename) runs like the bare quoted form', async () => {
		const { world, cmd, ctx } = await setup();
		writeManifest(world, "my list.md", TWO_CONTINUE);
		await cmd.handler('@"my list.md"', ctx);
		expect(world.sent).toHaveLength(2);
		const done = JSON.parse(fs.readFileSync(path.join(world.tmp, "my list.md.progress.json.done"), "utf-8"));
		expect(done.tasks.map((t: any) => t.status)).toEqual(["ok", "ok"]);
	});

	it("@list.md --dry-run → preview only, nothing sent", async () => {
		const { world, cmd, ctx } = await setup();
		await cmd.handler("@list.md --dry-run", ctx);
		expect(world.sent).toHaveLength(0);
		expect(world.widgets.at(-1)?.[0]).toContain("批处理预览");
	});

	it("@nope.md → 清单文件不存在, error cites the normalized (bare) path", async () => {
		const { world, cmd, ctx } = await setup();
		await cmd.handler("@nope.md", ctx);
		expect(lastNotify(world).type).toBe("error");
		expect(lastNotify(world).message).toContain(path.join(world.tmp, "nope.md"));
		expect(world.sent).toHaveLength(0);
		expect(fs.existsSync(progressPath(world))).toBe(false);
	});
});

// ============================================================================
// Pre-flight rejections
// ============================================================================

describe("command layer: pre-flight rejections", () => {
	it("print mode without UI → notify error + console.error", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { world, cmd, ctx } = await setup({ mode: "print", hasUI: false });
		await cmd.handler("list.md", ctx);
		expect(lastNotify(world).type).toBe("error");
		expect(lastNotify(world).message).toContain("仅支持 TUI");
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("rpc mode (with UI) → notify only, nothing on stderr", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { world, cmd, ctx } = await setup({ mode: "rpc", hasUI: true });
		await cmd.handler("list.md", ctx);
		expect(lastNotify(world).type).toBe("error");
		expect(lastNotify(world).message).toContain("仅支持 TUI");
		expect(spy).not.toHaveBeenCalled();
	});

	it("agent busy (not idle) → refuses to start", async () => {
		const { world, cmd, ctx } = await setup({ isIdle: false });
		await cmd.handler("list.md", ctx);
		expect(lastNotify(world).message).toBe("智能体正在运行，请等待空闲后再启动批处理");
		expect(world.sent).toHaveLength(0);
	});
});

// ============================================================================
// Manifest read errors
// ============================================================================

describe("command layer: manifest read errors", () => {
	it("path is a directory → 读取清单失败", async () => {
		const { world, cmd, ctx } = await setup();
		fs.mkdirSync(path.join(world.tmp, "dir.md"));
		await cmd.handler("dir.md", ctx);
		expect(lastNotify(world).type).toBe("error");
		expect(lastNotify(world).message).toContain("读取清单失败");
		expect(world.sent).toHaveLength(0);
	});

	it("manifest without separators → 清单解析失败", async () => {
		const { world, cmd, ctx } = await setup();
		writeManifest(world, "broken.md", "只有说明\n没有任务\n");
		await cmd.handler("broken.md", ctx);
		expect(lastNotify(world).message).toContain("清单解析失败");
		expect(world.sent).toHaveLength(0);
	});
});

// ============================================================================
// dry-run preview and paths with spaces
// ============================================================================

describe("command layer: dry-run preview", () => {
	const NAMED_MANIFEST = [
		"---",
		"[new] 任务一",
		"正文一",
		"---",
		"[continue] 任务二",
		"正文二",
		"---",
		"[new]",
		"name: 专项",
		"优化导出模块性能",
		"正文三",
		"",
	].join("\n");

	it("preview widget, session-name annotations, and notice; zero side effects", async () => {
		const { world, cmd, ctx } = await setup();
		writeManifest(world, "list.md", NAMED_MANIFEST);
		await cmd.handler("list.md --dry-run", ctx);

		const widget = world.widgets.at(-1)!;
		expect(widget[0]).toContain("批处理预览 · list.md · 共 3 个任务");
		expect(widget[1]).toBe("[new]  1 任务一");
		expect(widget[2]).toContain("[continue]");
		expect(widget[2]).toContain("任务二");
		expect(widget[3]).toContain("会话名: 专项");
		expect(lastNotify(world).message).toContain("预览模式：共 3 个任务，未执行");
		expect(world.sent).toHaveLength(0);
		expect(fs.existsSync(progressPath(world))).toBe(false);
	});

	it("--start 2: header notes the start, earlier tasks annotated as skipped", async () => {
		const { world, cmd, ctx } = await setup();
		writeManifest(world, "list.md", NAMED_MANIFEST);
		await cmd.handler("list.md --dry-run --start 2", ctx);

		const widget = world.widgets.at(-1)!;
		expect(widget[0]).toContain("从第 2 条开始");
		expect(widget[1]).toContain("（--start 跳过）");
		expect(world.sent).toHaveLength(0);
	});

	it("path with spaces (double-quoted) + dry-run", async () => {
		const { world, cmd, ctx } = await setup();
		writeManifest(world, "my tasks.md", TWO_CONTINUE);
		await cmd.handler('"my tasks.md" --dry-run', ctx);
		const widget = world.widgets.at(-1)!;
		expect(widget[0]).toContain("批处理预览 · my tasks.md · 共 2 个任务");
	});
});

// ============================================================================
// Tab completion
// ============================================================================

describe("command layer: tab completion", () => {
	it("empty prefix: stop/status + .md/.txt files in tmp, other extensions excluded", async () => {
		const { world, cmd } = await setup();
		fs.writeFileSync(path.join(world.tmp, "notes.txt"), "x", "utf-8");
		fs.writeFileSync(path.join(world.tmp, "image.png"), "x", "utf-8");
		const spy = vi.spyOn(process, "cwd").mockReturnValue(world.tmp);
		const items = cmd.getArgumentCompletions!("") ?? [];
		expect(items.map((i) => i.value).sort()).toEqual(["list.md", "notes.txt", "status", "stop"]);
		spy.mockRestore();
	});

	it('"st" → only stop/status', async () => {
		const { world, cmd } = await setup();
		const spy = vi.spyOn(process, "cwd").mockReturnValue(world.tmp);
		const items = cmd.getArgumentCompletions!("st") ?? [];
		expect(items.map((i) => i.value)).toEqual(["stop", "status"]);
		spy.mockRestore();
	});

	it('"zzz" → null (no candidates)', async () => {
		const { cmd } = await setup();
		const spy = vi.spyOn(process, "cwd").mockReturnValue("/nonexistent-pi-batch-test");
		expect(cmd.getArgumentCompletions!("zzz")).toBeNull();
		spy.mockRestore();
	});

	it("file names with spaces: completion value gets double quotes (matching tokenizeArgs); typed opening quote matches and closes", async () => {
		const { world, cmd } = await setup();
		fs.writeFileSync(path.join(world.tmp, "my tasks.md"), "x", "utf-8");
		const spy = vi.spyOn(process, "cwd").mockReturnValue(world.tmp);

		const items = cmd.getArgumentCompletions!("my") ?? [];
		expect(items).toEqual([{ value: '"my tasks.md"', label: "my tasks.md" }]);

		const quoted = cmd.getArgumentCompletions!('"my ta') ?? [];
		expect(quoted.map((i) => i.value)).toEqual(['"my tasks.md"']);
		spy.mockRestore();
	});
});

// ============================================================================
// Normal execution and artifacts
// ============================================================================

describe("command layer: normal execution and artifacts", () => {
	it("2 continue tasks all succeed: send options / report / progress rename / status-bar cleanup", async () => {
		const { world, cmd, ctx } = await setup();
		await cmd.handler("list.md", ctx);

		expect(world.sent).toHaveLength(2);
		expect(world.sent.map((s) => s.content)).toEqual(["正文一", "正文二"]);
		expect(world.sent[0]!.options).toEqual({ expandPromptTemplates: true });
		expect(fs.existsSync(progressPath(world))).toBe(false);
		expect(fs.existsSync(donePath(world))).toBe(true);
		expect(fs.existsSync(reportPath(world))).toBe(true);
		const done = readDone(world);
		expect(done.tasks.map((t: any) => t.status)).toEqual(["ok", "ok"]);
		expect(world.statuses.at(-1)).toBeUndefined();
		const summary = world.notifies.at(-1)!;
		expect(summary.message).toBe("批次「list」结束：成功 2");
		expect(summary.type).toBe("info");
	});

	it("--start 2: task 1 marked skipped, the rest execute", async () => {
		const { world, cmd, ctx } = await setup();
		writeManifest(world, "list.md", THREE_CONTINUE);
		await cmd.handler("list.md --start 2", ctx);

		const done = readDone(world);
		expect(done.tasks[0]).toMatchObject({ status: "skipped", error: "--start 2 跳过" });
		expect(done.tasks.map((t: any) => t.status)).toEqual(["skipped", "ok", "ok"]);
		expect(world.sent.map((s) => s.content)).toEqual(["正文二", "正文三"]);
	});

	it("CLI options persist: --retries 2 --on-exhaust abort", async () => {
		const { world, cmd, ctx } = await setup();
		await cmd.handler("list.md --retries 2 --on-exhaust abort", ctx);
		const done = readDone(world);
		expect(done.retries).toBe(2);
		expect(done.onExhaust).toBe("abort");
	});

	it("a new task with name: → newSession receives the name and setup writes the session name", async () => {
		const { world, cmd, ctx } = await setup();
		writeManifest(world, "list.md", "---\n[new]\nname: 专项A\n标题A\n正文A\n---\n[continue] 跟进\n正文B\n");
		await cmd.handler("list.md", ctx);

		// adaptCtx converts name into a setup closure: the raw ctx.newSession
		// never sees a name field — the only channel is setup →
		// appendSessionInfo (pins the wiring).
		expect(world.newSessionCalls).toEqual([{ name: undefined, hasSetup: true }]);
		expect(world.appendSessionNames).toEqual(["专项A"]);
		expect(world.childSessions[0]!.sends).toEqual(["正文A", "正文B"]);
		expect(readDone(world).tasks.map((t: any) => t.status)).toEqual(["ok", "ok"]);
	});

	it("a new task without name → unnamed (no setup)", async () => {
		const { world, cmd, ctx } = await setup();
		writeManifest(world, "list.md", "---\n[new] 无名任务\n正文\n");
		await cmd.handler("list.md", ctx);

		expect(world.newSessionCalls).toEqual([{ name: undefined, hasSetup: false }]);
		expect(world.appendSessionNames).toEqual([]);
		expect(readDone(world).tasks[0]!.status).toBe("ok");
	});
});

// ============================================================================
// Resume from breakpoint
// ============================================================================

describe("command layer: resume from breakpoint", () => {
	it("choosing cancel → cancelled, zero sends, progress untouched", async () => {
		const { world, cmd, ctx } = await setup({ selectResponses: ["取消"] });
		writeProgress(world, [savedTask(1, "new", "ok"), savedTask(2, "continue", "pending")]);
		await cmd.handler("list.md", ctx);

		expect(lastNotify(world).message).toBe("已取消");
		expect(world.sent).toHaveLength(0);
		expect(fs.existsSync(progressPath(world))).toBe(true);
		expect(fs.existsSync(donePath(world))).toBe(false);
	});

	it("choosing restart → old .done backed up as .bak, all tasks rerun", async () => {
		const { world, cmd, ctx } = await setup({ selectResponses: ["从头重新开始"] });
		fs.writeFileSync(donePath(world), "old", "utf-8");
		writeProgress(world, [savedTask(1, "new", "ok"), savedTask(2, "continue", "pending")]);
		await cmd.handler("list.md", ctx);

		expect(fs.readdirSync(world.tmp).filter((f) => f.endsWith(".bak"))).toHaveLength(1);
		expect(world.sent.map((s) => s.content)).toEqual(["正文一", "正文二"]);
		expect(readDone(world).tasks.map((t: any) => t.status)).toEqual(["ok", "ok"]);
	});

	it("choosing resume but task counts mismatch → error, nothing executes", async () => {
		const { world, cmd, ctx } = await setup({ selectResponses: ["从断点继续"] });
		writeProgress(world, [savedTask(1, "new", "ok"), savedTask(2, "continue", "ok"), savedTask(3, "continue", "pending")]);
		await cmd.handler("list.md", ctx);

		expect(lastNotify(world).type).toBe("error");
		expect(lastNotify(world).message).toContain("清单任务数与断点进度不一致");
		expect(world.sent).toHaveLength(0);
	});

	it('breakpoint on a "new" task → continues directly from that task', async () => {
		const { world, cmd, ctx } = await setup({ selectResponses: ["从断点继续"] });
		writeManifest(world, "list.md", "---\n[new] 任务一\n正文一\n---\n[new] 任务二\n正文二\n");
		writeProgress(world, [savedTask(1, "new", "ok"), savedTask(2, "new", "pending")]);
		await cmd.handler("list.md", ctx);

		expect(world.newSessionCalls).toHaveLength(1);
		expect(world.switchCalls).toHaveLength(0);
		expect(world.sent.map((s) => s.content)).toEqual(["正文二"]);
		expect(readDone(world).tasks.map((t: any) => t.status)).toEqual(["ok", "ok"]);
	});

	it('breakpoint on a "continue" task with the previous session file present → switchSession restores it', async () => {
		const { world, cmd, ctx } = await setup({ selectResponses: ["从断点继续"] });
		const prevSession = path.join(world.tmp, "prev.jsonl");
		fs.writeFileSync(prevSession, "{}", "utf-8");
		writeProgress(world, [savedTask(1, "new", "ok", { sessionFile: prevSession }), savedTask(2, "continue", "pending")]);
		await cmd.handler("list.md", ctx);

		expect(world.switchCalls).toEqual([prevSession]);
		expect(world.sent.map((s) => s.content)).toEqual(["正文二"]);
		expect(world.sent[0]!.from.sessionFile).toBe(prevSession);
		expect(readDone(world).tasks[1]).toMatchObject({ status: "ok", sessionFile: prevSession });
	});

	it("previous session file missing → warning and fallback to a fresh session", async () => {
		const { world, cmd, ctx } = await setup({ selectResponses: ["从断点继续"] });
		writeProgress(world, [
			savedTask(1, "new", "ok", { sessionFile: path.join(world.tmp, "missing.jsonl") }),
			savedTask(2, "continue", "pending"),
		]);
		await cmd.handler("list.md", ctx);

		const warning = world.notifies.find((n) => n.type === "warning" && n.message.includes("前置会话文件不可用"));
		expect(warning).toBeTruthy();
		expect(world.newSessionCalls).toHaveLength(1);
		expect(readDone(world).tasks[1]!.status).toBe("ok");
	});

	it("breakpoint task left running → resets then succeeds; counters reset on first start (pinned)", async () => {
		const { world, cmd, ctx } = await setup({ selectResponses: ["从断点继续"] });
		const prevSession = path.join(world.tmp, "prev.jsonl");
		fs.writeFileSync(prevSession, "{}", "utf-8");
		writeProgress(world, [savedTask(1, "new", "ok", { sessionFile: prevSession }), savedTask(2, "continue", "running", { attempts: 2 })]);
		await cmd.handler("list.md", ctx);

		expect(readDone(world).tasks[1]).toMatchObject({ status: "ok", attempts: 1 });
	});

	it("explicit --retries/--on-exhaust on resume override the saved config and say so", async () => {
		const { world, cmd, ctx } = await setup({ selectResponses: ["从断点继续"] });
		const prevSession = path.join(world.tmp, "prev.jsonl");
		fs.writeFileSync(prevSession, "{}", "utf-8");
		writeProgress(world, [savedTask(1, "new", "ok", { sessionFile: prevSession }), savedTask(2, "continue", "pending")], {
			retries: 5,
			onExhaust: "abort",
		});
		await cmd.handler("list.md --retries 0 --on-exhaust skip", ctx);

		expect(readDone(world).retries).toBe(0);
		expect(readDone(world).onExhaust).toBe("skip");
		expect(world.notifies.some((n) => n.message.includes("断点续跑") && n.message.includes("--retries=0"))).toBe(true);
		expect(world.notifies.some((n) => n.message.includes("--on-exhaust=skip"))).toBe(true);
	});

	it("resume without explicit options keeps the saved config (no silent fallback to defaults, no notice)", async () => {
		const { world, cmd, ctx } = await setup({ selectResponses: ["从断点继续"] });
		const prevSession = path.join(world.tmp, "prev.jsonl");
		fs.writeFileSync(prevSession, "{}", "utf-8");
		writeProgress(world, [savedTask(1, "new", "ok", { sessionFile: prevSession }), savedTask(2, "continue", "pending")], {
			retries: 5,
			onExhaust: "abort",
		});
		await cmd.handler("list.md", ctx);

		expect(readDone(world).retries).toBe(5);
		expect(readDone(world).onExhaust).toBe("abort");
		expect(world.notifies.some((n) => n.message.includes("断点续跑："))).toBe(false);
	});

	it("--start is ignored on resume with a notice (the breakpoint decides the start)", async () => {
		const { world, cmd, ctx } = await setup({ selectResponses: ["从断点继续"] });
		const prevSession = path.join(world.tmp, "prev.jsonl");
		fs.writeFileSync(prevSession, "{}", "utf-8");
		writeProgress(world, [savedTask(1, "new", "ok", { sessionFile: prevSession }), savedTask(2, "continue", "pending")]);
		await cmd.handler("list.md --start 2", ctx);

		expect(world.notifies.some((n) => n.message.includes("--start 已忽略"))).toBe(true);
		// Still resumes from the breakpoint (task 2).
		expect(world.sent.map((s) => s.content)).toEqual(["正文二"]);
	});
});

// ============================================================================
// Runtime intervention (orchestration: holdSettle with manual settling)
// ============================================================================

describe("command layer: runtime intervention (orchestration)", () => {
	it("a second /batch while running is rejected; the original batch finishes", async () => {
		const { world, cmd, ctx } = await setup({ holdSettle: true });
		const first = cmd.handler("list.md", ctx);
		await vi.waitFor(() => expect(world.sent).toHaveLength(1), { timeout: 5_000 });

		await cmd.handler("list.md", ctx);
		expect(lastNotify(world).message).toContain("已有批处理在运行");

		world.settleCurrent("ok");
		await vi.waitFor(() => expect(world.sent).toHaveLength(2), { timeout: 5_000 });
		world.settleCurrent("ok");
		await first;

		expect(readDone(world).tasks.map((t: any) => t.status)).toEqual(["ok", "ok"]);
	}, 15_000);

	it("/batch stop: stops after the current task ends naturally (no further advancing)", async () => {
		const { world, cmd, ctx } = await setup({ holdSettle: true });
		const first = cmd.handler("list.md", ctx);
		await vi.waitFor(() => expect(world.sent).toHaveLength(1), { timeout: 5_000 });

		await cmd.handler("stop", ctx);
		expect(lastNotify(world).message).toContain("将在当前任务自然结束后停止批次");

		world.settleCurrent("ok");
		await first;

		const done = readDone(world);
		expect(done.tasks.map((t: any) => t.status)).toEqual(["ok", "pending"]);
		expect(world.sent).toHaveLength(1);
		expect(world.notifies.some((n) => n.message.includes("未执行 1"))).toBe(true);
	}, 15_000);

	it("/batch stop --now: aborts the current task and terminates the batch", async () => {
		const { world, cmd, ctx } = await setup({ holdSettle: true });
		const first = cmd.handler("list.md", ctx);
		await vi.waitFor(() => expect(world.sent).toHaveLength(1), { timeout: 5_000 });

		await cmd.handler("stop --now", ctx);
		expect(lastNotify(world).message).toContain("正在中止当前任务并停止批次");
		expect(world.abortCalls).toBe(1);

		world.settleCurrent("aborted");
		await first;

		const done = readDone(world);
		expect(done.tasks[0]).toMatchObject({ status: "failed", error: "批次被停止（stop --now）" });
		expect(done.tasks[1]!.status).toBe("pending");
	}, 15_000);
});
