import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as progress from "../lib/progress.ts";
import { isTerminalStatus, progressPathFor, reportPathFor, type BatchState, type TaskStatus } from "../lib/types.ts";

let tmp: string;
let listFile: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-batch-progress-test-"));
	listFile = path.join(tmp, "list.md");
	fs.writeFileSync(listFile, "fixture", "utf-8");
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
	vi.useRealTimers();
});

function makeState(overrides?: Partial<BatchState>): BatchState {
	return {
		listFile,
		batchTitle: "list",
		startedAt: 1_000,
		updatedAt: 1_000,
		retries: 3,
		onExhaust: "pause",
		tasks: [
			{
				index: 1,
				mode: "new",
				title: "任务一",
				prompt: "正文一",
				status: "ok",
				attempts: 1,
				sessionFile: path.join(tmp, "s1.jsonl"),
				startedAt: 1_000,
				endedAt: 2_000,
			},
			{
				index: 2,
				mode: "continue",
				title: "任务二",
				prompt: "正文二",
				status: "pending",
				attempts: 0,
			},
		],
		...overrides,
	};
}

describe("path helpers and status predicates (lib/types.ts)", () => {
	it("progressPathFor / reportPathFor", () => {
		expect(progressPathFor("/a/b/list.md")).toBe("/a/b/list.md.progress.json");
		expect(reportPathFor("/a/b/list.md")).toBe("/a/b/list.md.report.md");
	});

	it("isTerminalStatus truth table", () => {
		const terminal: TaskStatus[] = ["ok", "failed", "skipped"];
		const open: TaskStatus[] = ["pending", "running"];
		for (const s of terminal) expect(isTerminalStatus(s)).toBe(true);
		for (const s of open) expect(isTerminalStatus(s)).toBe(false);
	});
});

describe("loadProgress", () => {
	it("missing file → null", () => {
		expect(progress.loadProgress(listFile)).toBeNull();
	});

	it("invalid JSON → null", () => {
		fs.writeFileSync(progressPathFor(listFile), "{not json", "utf-8");
		expect(progress.loadProgress(listFile)).toBeNull();
	});

	it("schemaVersion !== 1 → null", () => {
		fs.writeFileSync(progressPathFor(listFile), JSON.stringify({ schemaVersion: 2, tasks: [] }), "utf-8");
		expect(progress.loadProgress(listFile)).toBeNull();
	});

	it("tasks not an array → null", () => {
		fs.writeFileSync(progressPathFor(listFile), JSON.stringify({ schemaVersion: 1, tasks: "nope" }), "utf-8");
		expect(progress.loadProgress(listFile)).toBeNull();
	});

	it("saveProgress → loadProgress round-trips faithfully", () => {
		const state = makeState();
		progress.saveProgress(state);
		const loaded = progress.loadProgress(listFile);
		expect(loaded).not.toBeNull();
		expect(loaded!.schemaVersion).toBe(1);
		expect(loaded!.listFile).toBe(listFile);
		expect(loaded!.batchTitle).toBe("list");
		expect(loaded!.retries).toBe(3);
		expect(loaded!.onExhaust).toBe("pause");
		expect(loaded!.tasks).toHaveLength(2);
		expect(loaded!.tasks[0]).toMatchObject({ index: 1, status: "ok", attempts: 1 });
		expect(loaded!.tasks[1]!.status).toBe("pending");
	});
});

describe("saveProgress", () => {
	it("refreshes updatedAt on overwrite", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const state = makeState();
		progress.saveProgress(state);
		const first = JSON.parse(fs.readFileSync(progressPathFor(listFile), "utf-8")!).updatedAt as number;
		vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
		progress.saveProgress(state);
		const second = JSON.parse(fs.readFileSync(progressPathFor(listFile), "utf-8")!).updatedAt as number;
		expect(second).toBeGreaterThan(first);
	});

	it("writes readable, indented JSON", () => {
		progress.saveProgress(makeState());
		const raw = fs.readFileSync(progressPathFor(listFile), "utf-8");
		expect(raw).toContain("\n\t"); // tab indentation
		expect(() => JSON.parse(raw)).not.toThrow();
	});
});

describe("finishProgress", () => {
	it("renames to .progress.json.done when present and returns the target path", () => {
		progress.saveProgress(makeState());
		const from = progressPathFor(listFile);
		const to = progress.finishProgress(listFile);
		expect(to).toBe(`${from}.done`);
		expect(fs.existsSync(from)).toBe(false);
		expect(fs.existsSync(to!)).toBe(true);
	});

	it("missing source → null without throwing", () => {
		expect(progress.finishProgress(listFile)).toBeNull();
	});
});

describe("backupDoneProgress", () => {
	it("backs up an existing .done into a timestamped .bak", () => {
		const donePath = `${progressPathFor(listFile)}.done`;
		fs.writeFileSync(donePath, "{}", "utf-8");
		progress.backupDoneProgress(listFile);
		expect(fs.existsSync(donePath)).toBe(false);
		const entries = fs.readdirSync(tmp).filter((e) => e.endsWith(".bak"));
		expect(entries).toHaveLength(1);
		expect(entries[0]!.startsWith("list.md.progress.json.done.")).toBe(true);
	});

	it("no-op without throwing when no .done exists", () => {
		expect(() => progress.backupDoneProgress(listFile)).not.toThrow();
		expect(fs.readdirSync(tmp).filter((e) => e.includes("progress"))).toHaveLength(0);
	});
});

describe("writeReport", () => {
	it("writes content verbatim to <manifest>.report.md", () => {
		const content = "# 报告\n\n内容行";
		progress.writeReport(listFile, content);
		expect(fs.readFileSync(reportPathFor(listFile), "utf-8")).toBe(content);
	});
});
