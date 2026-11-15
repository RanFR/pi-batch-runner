import { describe, expect, it } from "vitest";
import { countTasks, formatDuration, renderReportMarkdown, summaryLine, statusText, widgetLines } from "../lib/report.ts";
import type { BatchState, TaskRecord, TaskStatus } from "../lib/types.ts";

function record(index: number, status: TaskStatus, overrides?: Partial<TaskRecord>): TaskRecord {
	return {
		index,
		mode: "new",
		title: `任务${index}`,
		prompt: `正文${index}`,
		status,
		attempts: 1,
		startedAt: 1_000,
		endedAt: 61_000,
		...overrides,
	};
}

function makeState(tasks: TaskRecord[], overrides?: Partial<BatchState>): BatchState {
	return {
		listFile: "/tmp/pi-batch-report-test/list.md",
		batchTitle: "list",
		startedAt: 1_000,
		updatedAt: 2_000,
		retries: 3,
		onExhaust: "pause",
		tasks,
		...overrides,
	};
}

describe("formatDuration", () => {
	it("formats seconds", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(1_000)).toBe("1s");
		expect(formatDuration(12_400)).toBe("12s");
	});

	it("rounds 59_999 up: first to 60s, then carries into minutes (pinned)", () => {
		expect(formatDuration(59_999)).toBe("1m00s");
	});

	it("zero-pads minute format", () => {
		expect(formatDuration(61_000)).toBe("1m01s");
		expect(formatDuration(252_000)).toBe("4m12s");
	});

	it("zero-pads hour format", () => {
		expect(formatDuration(3_600_000)).toBe("1h00m");
		expect(formatDuration(3_732_000)).toBe("1h02m");
	});

	it("invalid input → -", () => {
		expect(formatDuration(-1)).toBe("-");
		expect(formatDuration(Number.NaN)).toBe("-");
		expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("-");
	});
});

describe("countTasks", () => {
	it("counts all five statuses plus total", () => {
		const state = makeState([record(1, "ok"), record(2, "failed"), record(3, "skipped"), record(4, "running"), record(5, "pending")]);
		expect(countTasks(state)).toEqual({ ok: 1, failed: 1, skipped: 1, running: 1, pending: 1, total: 5 });
	});
});

describe("statusText", () => {
	it("with a running task: task i/N · title(truncated to 24) · attempt N · elapsed", () => {
		const state = makeState([
			record(1, "ok"),
			record(2, "running", { title: "R".repeat(50), attempts: 2, startedAt: 1_000, endedAt: undefined }),
		]);
		const text = statusText(state, 73_000); // 72s elapsed
		expect(text).toBe(`[batch] 任务 2/2 · ${"R".repeat(23)}… · 第2次尝试 · 1m12s`);
	});

	it("without a running task: completed X/Y", () => {
		const state = makeState([record(1, "ok"), record(2, "ok"), record(3, "pending")]);
		expect(statusText(state, 5_000)).toBe("[batch] list · 完成 2/3");
	});
});

describe("summaryLine", () => {
	it("all successful: only 成功 N", () => {
		const state = makeState([record(1, "ok"), record(2, "ok")]);
		expect(summaryLine(state)).toBe("批次「list」结束：成功 2");
	});

	it("failed / skipped / pending appear only when non-zero", () => {
		const state = makeState([record(1, "ok"), record(2, "failed"), record(3, "skipped"), record(4, "pending")]);
		expect(summaryLine(state)).toBe("批次「list」结束：成功 1 / 失败 1 / 跳过 1 / 未执行 1");
	});
});

describe("widgetLines", () => {
	it("maps status icons", () => {
		const state = makeState([record(1, "ok"), record(2, "failed"), record(3, "skipped"), record(4, "running"), record(5, "pending")]);
		const lines = widgetLines(state, 2_000);
		expect(lines[0]).toContain("── 批处理 · list ·");
		expect(lines[1]!.startsWith("✓")).toBe(true);
		expect(lines[2]!.startsWith("✗")).toBe(true);
		expect(lines[3]!.startsWith("»")).toBe(true);
		expect(lines[4]!.startsWith("▶")).toBe(true);
		expect(lines[5]!.startsWith("·")).toBe(true);
	});

	it("continue mode hides the session file; new mode shows it (name truncated to 18)", () => {
		const longFile = `/tmp/x/${"f".repeat(30)}.jsonl`;
		const state = makeState([
			record(1, "ok", { mode: "continue", sessionFile: longFile }),
			record(2, "ok", { mode: "new", sessionFile: longFile }),
			record(3, "ok", { mode: "new" }),
		]);
		const lines = widgetLines(state, 2_000);
		expect(lines[1]).not.toContain("[f");
		expect(lines[2]).toContain(`[${"f".repeat(17)}…]`);
		expect(lines[3]).not.toContain("[f");
	});

	it("truncates the error suffix to 40", () => {
		const state = makeState([record(1, "failed", { error: "E".repeat(50) })]);
		const line = widgetLines(state, 2_000)[1]!;
		expect(line).toContain(`· ${"E".repeat(39)}…`);
	});

	it("a running line includes the attempt count and elapsed time", () => {
		const state = makeState([record(1, "running", { attempts: 3, startedAt: 1_000, endedAt: undefined })]);
		const line = widgetLines(state, 61_000)[1]!;
		expect(line).toContain("第3次尝试 · 1m00s");
	});
});

describe("renderReportMarkdown", () => {
	it("has a header, stats, table, and footer", () => {
		const state = makeState([
			record(1, "ok", { sessionFile: "/tmp/s1.jsonl" }),
			record(2, "failed", { error: " boom " }),
			record(3, "skipped"),
			record(4, "pending", { startedAt: undefined, endedAt: undefined }),
		]);
		const md = renderReportMarkdown(state, 61_000);
		const lines = md.split("\n");
		expect(lines[0]).toBe("# 批处理报告 · list");
		expect(md).toContain("- 清单文件：`/tmp/pi-batch-report-test/list.md`");
		expect(md).toContain("- 重试次数：3 · 耗尽行为：pause");
		expect(md).toContain("- 结果：成功 1 / 失败 1 / 跳过 1 / 未执行 1（共 4）");
		expect(md).toContain("| # | 模式 | 任务 | 状态 | 尝试 | 耗时 | 会话文件 | 错误 |");
		expect(md).toContain("| 1 | 新会话 | 任务1 | 成功 | 1 | 1m00s | `s1.jsonl` |  |");
		expect(md).toContain("| 2 | 新会话 | 任务2 | 失败 | 1 | 1m00s |  | boom |");
		expect(md).toContain("| 3 | 新会话 | 任务3 | 跳过 | 1 | 1m00s |  |  |");
		expect(md).toContain("| 4 | 新会话 | 任务4 | 未执行 | 1 | - |  |  |");
		expect(md.trimEnd().endsWith("> 由 pi-batch-runner 扩展生成")).toBe(true);
	});

	it("escapes | in errors as \\|", () => {
		const state = makeState([record(1, "failed", { error: "a|b" })]);
		const md = renderReportMarkdown(state, 2_000);
		expect(md).toContain("a\\|b");
	});

	it("truncates titles to 40", () => {
		const state = makeState([record(1, "ok", { title: "T".repeat(50) })]);
		const md = renderReportMarkdown(state, 2_000);
		expect(md).toContain(`| ${"T".repeat(39)}… |`);
	});
});
