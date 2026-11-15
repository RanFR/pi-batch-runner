import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ManifestParseError, parseManifest, tokenizeArgs } from "../lib/parser.ts";

describe("parseManifest", () => {
	it("parses basic separators and multiple tasks", () => {
		const tasks = parseManifest("---\n任务一\n提示词 A\n---\n任务二\n提示词 B\n");
		expect(tasks).toHaveLength(2);
		expect(tasks[0]).toMatchObject({ index: 1, mode: "new", title: "任务一", prompt: "提示词 A" });
		expect(tasks[1]).toMatchObject({ index: 2, mode: "new", title: "任务二", prompt: "提示词 B" });
	});

	it("ignores the file header before the first ---", () => {
		const tasks = parseManifest("# 批次说明\n日期：2025-06-20\n\n---\n任务一\n正文\n");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.title).toBe("任务一");
	});

	it("throws without a --- separator (0 tasks)", () => {
		expect(() => parseManifest("只有一些说明文字\n没有任务")).toThrow(ManifestParseError);
	});

	it("throws on an empty file", () => {
		expect(() => parseManifest("")).toThrow(ManifestParseError);
	});

	it("Chinese markers are NOT recognized (English-only): bracketed text stays in the title, default mode applies", () => {
		const tasks = parseManifest("---\n[新会话] A\n正文 a\n---\n[继续] B\n正文 b\n");
		expect(tasks[0]!.mode).toBe("new");
		expect(tasks[0]!.title).toBe("[新会话] A");
		expect(tasks[1]!.mode).toBe("new");
		expect(tasks[1]!.title).toBe("[继续] B");
	});

	it("English markers are case-insensitive", () => {
		const tasks = parseManifest("---\n[NEW] A\n正文\n---\n[Continue] B\n正文\n---\n[continue] C\n正文\n");
		expect(tasks.map((t) => t.mode)).toEqual(["new", "continue", "continue"]);
	});

	it("defaults to a new session without a marker", () => {
		const tasks = parseManifest("---\n修复登录页样式\n调整按钮位置\n");
		expect(tasks[0]!.mode).toBe("new");
		expect(tasks[0]!.title).toBe("修复登录页样式");
		expect(tasks[0]!.prompt).toBe("调整按钮位置");
	});

	it("text after the marker on a marked line is the title", () => {
		const tasks = parseManifest("---\n[new]重构导入模块\n正文第一行\n正文第二行\n");
		expect(tasks[0]!.title).toBe("重构导入模块");
		expect(tasks[0]!.prompt).toBe("正文第一行\n正文第二行");
	});

	it("single-line entry: title = first body line", () => {
		const tasks = parseManifest("---\n只写一句话的任务\n");
		expect(tasks[0]!.title).toBe("只写一句话的任务");
		expect(tasks[0]!.prompt).toBe("只写一句话的任务");
	});

	it("multi-line body keeps blank lines and is trimmed at both ends", () => {
		const tasks = parseManifest("---\n任务\n第一行\n\n第三行\n\n\n");
		expect(tasks[0]!.prompt).toBe("第一行\n\n第三行");
	});

	it("handles CRLF line endings", () => {
		const tasks = parseManifest("---\r\n[continue] 任务 A\r\n正文 1\r\n正文 2\r\n---\r\n任务 B\r\n正文 b\r\n");
		expect(tasks).toHaveLength(2);
		expect(tasks[0]).toMatchObject({ mode: "continue", title: "任务 A", prompt: "正文 1\n正文 2" });
	});

	it("skips empty and whitespace-only entries", () => {
		const tasks = parseManifest("---\n\n   \n---\n任务\n正文\n---\n\t\n---\n任务二\n正文二\n");
		expect(tasks).toHaveLength(2);
		expect(tasks[1]!.index).toBe(2);
	});

	it("ignores reserved-field lines after a bare marker (reserved for future extensions)", () => {
		const tasks = parseManifest("---\n[new]\nmodel: glm-5.3\ntimeout: 120\n重构导入模块\n正文\n");
		expect(tasks[0]!.title).toBe("重构导入模块");
		expect(tasks[0]!.prompt).toBe("正文");
	});

	it("captures a name: field after a bare marker as the session name (title and prompt unaffected)", () => {
		const tasks = parseManifest("---\n[new]\nname: 数据导入重构\n重构导入模块\n正文\n");
		expect(tasks[0]!.name).toBe("数据导入重构");
		expect(tasks[0]!.title).toBe("重构导入模块");
		expect(tasks[0]!.prompt).toBe("正文");
	});

	it("throws when the name: value is empty", () => {
		expect(() => parseManifest("---\n[new]\nname:   \n标题\n正文\n")).toThrow(ManifestParseError);
		expect(() => parseManifest("---\n[new]\nname:\n标题\n正文\n")).toThrow(/name 字段值不能为空/);
	});

	it('throws when a "continue" task carries name: (message includes the task index)', () => {
		const run = () => parseManifest("---\n任务一\n正文一\n---\n[continue]\nname: x\n标题\n正文二\n");
		expect(run).toThrow(ManifestParseError);
		expect(run).toThrow(/任务 2：name 字段仅对「新会话」任务有效/);
	});

	it("repeated name: lines — the last one wins", () => {
		const tasks = parseManifest("---\n[new]\nname: 第一个\nname: 第二个\n标题\n正文\n");
		expect(tasks[0]!.name).toBe("第二个");
	});

	it("a name: line after the title belongs to the body (regression: never swallow body text)", () => {
		const tasks = parseManifest("---\n[new] 标题\nname: x\n正文\n");
		expect(tasks[0]!.name).toBeUndefined();
		expect(tasks[0]!.prompt).toBe("name: x\n正文");
	});

	it("key: value lines after the title are treated as body (never swallowed)", () => {
		const tasks = parseManifest("---\nRefactor: import module\nmodel: 应该留在正文\n");
		expect(tasks[0]!.title).toBe("Refactor: import module");
		expect(tasks[0]!.prompt).toBe("model: 应该留在正文");
	});

	it("an unmarked entry's first line is the title even when it looks like key: value", () => {
		const tasks = parseManifest("---\n修复: 登录页\n正文\n");
		expect(tasks[0]!.title).toBe("修复: 登录页");
		expect(tasks[0]!.prompt).toBe("正文");
	});

	it("throws for a bare marker with no content at all (empty prompt)", () => {
		expect(() => parseManifest("---\n[new]\n---\n任务\n正文\n")).toThrow(/提示词正文为空/);
	});

	it("separators allow surrounding whitespace", () => {
		const tasks = parseManifest("---  \n任务\n正文\n  ---\n任务二\n正文二\n");
		expect(tasks).toHaveLength(2);
	});

	it("indexes increment consecutively", () => {
		const tasks = parseManifest("---\nA\na\n---\nB\nb\n---\nC\nc\n---\nD\nd\n");
		expect(tasks.map((t) => t.index)).toEqual([1, 2, 3, 4]);
	});
});

describe("tokenizeArgs", () => {
	it("splits on spaces", () => {
		expect(tokenizeArgs("tasks.md --dry-run")).toEqual(["tasks.md", "--dry-run"]);
	});
	it("double quotes group a path containing spaces", () => {
		expect(tokenizeArgs('"my tasks.md" --retries 2')).toEqual(["my tasks.md", "--retries", "2"]);
	});
	it("strips pi's @ file-mention prefix from a bare token", () => {
		expect(tokenizeArgs("@tasks.md --dry-run")).toEqual(["tasks.md", "--dry-run"]);
	});
	it('strips the @ before a quoted path (pi inserts @"my tasks.md" for spaced names)', () => {
		expect(tokenizeArgs('@"my tasks.md" --retries 2')).toEqual(["my tasks.md", "--retries", "2"]);
	});
	it("strips @ wherever a token starts, not only in the first token", () => {
		expect(tokenizeArgs("--dry-run @tasks.md")).toEqual(["--dry-run", "tasks.md"]);
	});
	it("@ inside a token is untouched (only a token-leading @ is a mention)", () => {
		expect(tokenizeArgs("user@host.md")).toEqual(["user@host.md"]);
	});
	it("quoted tokens are verbatim: a leading @ inside quotes is kept", () => {
		expect(tokenizeArgs('"@weird name.md"')).toEqual(["@weird name.md"]);
	});
	it("a lone @ survives (nothing to point at)", () => {
		expect(tokenizeArgs("@")).toEqual(["@"]);
	});
	it("a double @@ strips only one layer (remaining @ treated as literal path)", () => {
		expect(tokenizeArgs("@@x.md")).toEqual(["@x.md"]);
	});
	it("empty string", () => {
		expect(tokenizeArgs("")).toEqual([]);
	});
	it("single quotes unsupported (pins current behavior: split as ordinary non-whitespace)", () => {
		expect(tokenizeArgs("'a b'")).toEqual(["'a", "b'"]);
	});
	it("unclosed double quote (pins current behavior: one single token)", () => {
		expect(tokenizeArgs('"abc')).toEqual(['"abc']);
	});
});

describe("parseManifest: separator edge cases (pinned behavior)", () => {
	it("a file starting with --- (empty header) parses the first task normally", () => {
		const tasks = parseManifest("---\n任务一\n正文\n");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toMatchObject({ index: 1, title: "任务一", prompt: "正文" });
	});

	it("---- (four hyphens) is not a separator: 0 tasks with no valid separator throws", () => {
		expect(() => parseManifest("----\n任务\n正文\n")).toThrow(ManifestParseError);
	});

	it("---abc is not a separator", () => {
		expect(() => parseManifest("---abc\n任务\n正文\n")).toThrow(ManifestParseError);
	});

	it("a body line like `a --- b` does not split", () => {
		const tasks = parseManifest("---\n任务\n前半 --- 后半\n");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.prompt).toBe("前半 --- 后半");
	});

	it("a BOM-prefixed --- still counts as a separator (\\s includes BOM; pinned)", () => {
		const tasks = parseManifest("\uFEFF---\n任务\n正文\n");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.title).toBe("任务");
	});
});

describe("parseManifest: reserved-field line details", () => {
	it("name:x (no space after the colon) is still captured as the session name", () => {
		const tasks = parseManifest("---\n[new]\nname:数据导出\n标题\n正文\n");
		expect(tasks[0]!.name).toBe("数据导出");
	});

	it("a name: value with inner spaces is kept verbatim (only ends trimmed)", () => {
		const tasks = parseManifest("---\n[new]\nname: my session name\n标题\n正文\n");
		expect(tasks[0]!.name).toBe("my session name");
	});

	it("Model: x (capitalized) does not match the field regex → treated as title", () => {
		const tasks = parseManifest("---\n[new]\nModel: x\n正文\n");
		expect(tasks[0]!.title).toBe("Model: x");
		expect(tasks[0]!.name).toBeUndefined();
	});

	it("retries / max-turns / on-exhaust reserved fields are ignored", () => {
		const tasks = parseManifest("---\n[new]\nretries: 5\nmax-turns: 10\non-exhaust: skip\n标题\n正文\n");
		expect(tasks[0]!.title).toBe("标题");
		expect(tasks[0]!.prompt).toBe("正文");
		expect(tasks[0]!.name).toBeUndefined();
	});

	it("whitespace around the marker-line title is normalized", () => {
		const tasks = parseManifest("---\n[new]  标题  \n正文\n");
		expect(tasks[0]!.title).toBe("标题");
	});
});

describe("parseManifest: example-file guard (examples/tasks.example.md contract)", () => {
	it("the example manifest parses into 4 tasks with documented modes and name fields", () => {
		const content = fs.readFileSync(new URL("../examples/tasks.example.md", import.meta.url), "utf-8");
		const tasks = parseManifest(content);
		expect(tasks.map((t) => t.mode)).toEqual(["new", "continue", "new", "new"]);
		expect(tasks.map((t) => t.index)).toEqual([1, 2, 3, 4]);
		expect(tasks[0]!.title).toBe("重构数据导入模块");
		expect(tasks[1]!.title).toBe("补充导入模块边界测试");
		expect(tasks[2]!.title).toBe("修复登录页样式");
		expect(tasks[3]!.name).toBe("数据导出专项");
		expect(tasks[3]!.title).toBe("优化导出模块性能");
		// All task prompts are non-empty.
		expect(tasks.every((t) => t.prompt.length > 0)).toBe(true);
	});
});
