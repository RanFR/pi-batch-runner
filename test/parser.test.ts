import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ManifestParseError, parseManifest, tokenizeArgs } from "../lib/parser.ts";

describe("parseManifest", () => {
	it("解析基本分隔符与多任务", () => {
		const tasks = parseManifest("---\n任务一\n提示词 A\n---\n任务二\n提示词 B\n");
		expect(tasks).toHaveLength(2);
		expect(tasks[0]).toMatchObject({ index: 1, mode: "new", title: "任务一", prompt: "提示词 A" });
		expect(tasks[1]).toMatchObject({ index: 2, mode: "new", title: "任务二", prompt: "提示词 B" });
	});

	it("忽略首个 --- 之前的文件头", () => {
		const tasks = parseManifest("# 批次说明\n日期：2025-06-20\n\n---\n任务一\n正文\n");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.title).toBe("任务一");
	});

	it("无 --- 分隔符时报错（0 任务）", () => {
		expect(() => parseManifest("只有一些说明文字\n没有任务")).toThrow(ManifestParseError);
	});

	it("空文件报错", () => {
		expect(() => parseManifest("")).toThrow(ManifestParseError);
	});

	it("中文标记：新会话 / 继续", () => {
		const tasks = parseManifest("---\n[新会话] A\n正文 a\n---\n[继续] B\n正文 b\n");
		expect(tasks[0]!.mode).toBe("new");
		expect(tasks[1]!.mode).toBe("continue");
	});

	it("英文标记大小写不敏感", () => {
		const tasks = parseManifest("---\n[NEW] A\n正文\n---\n[Continue] B\n正文\n---\n[continue] C\n正文\n");
		expect(tasks.map((t) => t.mode)).toEqual(["new", "continue", "continue"]);
	});

	it("无标记默认新会话", () => {
		const tasks = parseManifest("---\n修复登录页样式\n调整按钮位置\n");
		expect(tasks[0]!.mode).toBe("new");
		expect(tasks[0]!.title).toBe("修复登录页样式");
		expect(tasks[0]!.prompt).toBe("调整按钮位置");
	});

	it("标记行中标记之后为标题", () => {
		const tasks = parseManifest("---\n[新会话]重构导入模块\n正文第一行\n正文第二行\n");
		expect(tasks[0]!.title).toBe("重构导入模块");
		expect(tasks[0]!.prompt).toBe("正文第一行\n正文第二行");
	});

	it("单行条目：标题 = 正文首行", () => {
		const tasks = parseManifest("---\n只写一句话的任务\n");
		expect(tasks[0]!.title).toBe("只写一句话的任务");
		expect(tasks[0]!.prompt).toBe("只写一句话的任务");
	});

	it("多行正文保留空行，整体 trim", () => {
		const tasks = parseManifest("---\n任务\n第一行\n\n第三行\n\n\n");
		expect(tasks[0]!.prompt).toBe("第一行\n\n第三行");
	});

	it("CRLF 行尾兼容", () => {
		const tasks = parseManifest("---\r\n[继续] 任务 A\r\n正文 1\r\n正文 2\r\n---\r\n任务 B\r\n正文 b\r\n");
		expect(tasks).toHaveLength(2);
		expect(tasks[0]).toMatchObject({ mode: "continue", title: "任务 A", prompt: "正文 1\n正文 2" });
	});

	it("空条目与纯空白条目跳过", () => {
		const tasks = parseManifest("---\n\n   \n---\n任务\n正文\n---\n\t\n---\n任务二\n正文二\n");
		expect(tasks).toHaveLength(2);
		expect(tasks[1]!.index).toBe(2);
	});

	it("裸标记后的保留字段行被忽略（未来扩展预留）", () => {
		const tasks = parseManifest("---\n[新会话]\nmodel: glm-5.3\ntimeout: 120\n重构导入模块\n正文\n");
		expect(tasks[0]!.title).toBe("重构导入模块");
		expect(tasks[0]!.prompt).toBe("正文");
	});

	it("裸标记后的 name: 字段捕获为会话名（标题与正文不受影响）", () => {
		const tasks = parseManifest("---\n[新会话]\nname: 数据导入重构\n重构导入模块\n正文\n");
		expect(tasks[0]!.name).toBe("数据导入重构");
		expect(tasks[0]!.title).toBe("重构导入模块");
		expect(tasks[0]!.prompt).toBe("正文");
	});

	it("name: 值为空时报错", () => {
		expect(() => parseManifest("---\n[新会话]\nname:   \n标题\n正文\n")).toThrow(ManifestParseError);
		expect(() => parseManifest("---\n[新会话]\nname:\n标题\n正文\n")).toThrow(/name 字段值不能为空/);
	});

	it("「继续」任务带 name: 时报错（消息含任务序号）", () => {
		const run = () => parseManifest("---\n任务一\n正文一\n---\n[继续]\nname: x\n标题\n正文二\n");
		expect(run).toThrow(ManifestParseError);
		expect(run).toThrow(/任务 2：name 字段仅对「新会话」任务有效/);
	});

	it("重复 name: 行以最后一个为准", () => {
		const tasks = parseManifest("---\n[新会话]\nname: 第一个\nname: 第二个\n标题\n正文\n");
		expect(tasks[0]!.name).toBe("第二个");
	});

	it("标题已确定后的 name: 行属于正文（防误吞回归）", () => {
		const tasks = parseManifest("---\n[新会话] 标题\nname: x\n正文\n");
		expect(tasks[0]!.name).toBeUndefined();
		expect(tasks[0]!.prompt).toBe("name: x\n正文");
	});

	it("标题确定后的 key: value 行视为正文（防误吞）", () => {
		const tasks = parseManifest("---\nRefactor: import module\nmodel: 应该留在正文\n");
		expect(tasks[0]!.title).toBe("Refactor: import module");
		expect(tasks[0]!.prompt).toBe("model: 应该留在正文");
	});

	it("无标记条目的首行即使形如 key: value 也作为标题", () => {
		const tasks = parseManifest("---\n修复: 登录页\n正文\n");
		expect(tasks[0]!.title).toBe("修复: 登录页");
		expect(tasks[0]!.prompt).toBe("正文");
	});

	it("裸标记且无任何内容时报错（提示词为空）", () => {
		expect(() => parseManifest("---\n[新会话]\n---\n任务\n正文\n")).toThrow(/提示词正文为空/);
	});

	it("分隔符允许前后空白", () => {
		const tasks = parseManifest("---  \n任务\n正文\n  ---\n任务二\n正文二\n");
		expect(tasks).toHaveLength(2);
	});

	it("序号连续递增", () => {
		const tasks = parseManifest("---\nA\na\n---\nB\nb\n---\nC\nc\n---\nD\nd\n");
		expect(tasks.map((t) => t.index)).toEqual([1, 2, 3, 4]);
	});
});

describe("tokenizeArgs", () => {
	it("空格切分", () => {
		expect(tokenizeArgs("tasks.md --dry-run")).toEqual(["tasks.md", "--dry-run"]);
	});
	it("双引号包裹含空格路径", () => {
		expect(tokenizeArgs('"my tasks.md" --retries 2')).toEqual(["my tasks.md", "--retries", "2"]);
	});
	it("空字符串", () => {
		expect(tokenizeArgs("")).toEqual([]);
	});
	it("单引号不支持（钉住现状：按普通非空白字符切分）", () => {
		expect(tokenizeArgs("'a b'")).toEqual(["'a", "b'"]);
	});
	it("未闭合双引号（钉住现状：整体作为一个 token）", () => {
		expect(tokenizeArgs('"abc')).toEqual(['"abc']);
	});
});

describe("parseManifest：分隔符边界（钉住现状）", () => {
	it("文件首行即 --- （空文件头）→ 正常解析首个任务", () => {
		const tasks = parseManifest("---\n任务一\n正文\n");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toMatchObject({ index: 1, title: "任务一", prompt: "正文" });
	});

	it("----（四连字符）不是分隔符：无合法分隔符时 0 任务报错", () => {
		expect(() => parseManifest("----\n任务\n正文\n")).toThrow(ManifestParseError);
	});

	it("---abc 不是分隔符", () => {
		expect(() => parseManifest("---abc\n任务\n正文\n")).toThrow(ManifestParseError);
	});

	it("正文行 a --- b 不分割", () => {
		const tasks = parseManifest("---\n任务\n前半 --- 后半\n");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.prompt).toBe("前半 --- 后半");
	});

	it("BOM 前缀的 --- 仍视为分隔符（\\s 含 BOM，钉住现状）", () => {
		const tasks = parseManifest("\uFEFF---\n任务\n正文\n");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.title).toBe("任务");
	});
});

describe("parseManifest：保留字段行细节", () => {
	it("name:x（冒号后无空格）仍捕获为会话名", () => {
		const tasks = parseManifest("---\n[新会话]\nname:数据导出\n标题\n正文\n");
		expect(tasks[0]!.name).toBe("数据导出");
	});

	it("name: 值含内部空格原样保留（仅 trim 首尾）", () => {
		const tasks = parseManifest("---\n[新会话]\nname: my session name\n标题\n正文\n");
		expect(tasks[0]!.name).toBe("my session name");
	});

	it("Model: x（大写开头）不匹配字段正则 → 作为标题", () => {
		const tasks = parseManifest("---\n[新会话]\nModel: x\n正文\n");
		expect(tasks[0]!.title).toBe("Model: x");
		expect(tasks[0]!.name).toBeUndefined();
	});

	it("retries / max-turns / on-exhaust 保留字段被忽略", () => {
		const tasks = parseManifest("---\n[新会话]\nretries: 5\nmax-turns: 10\non-exhaust: skip\n标题\n正文\n");
		expect(tasks[0]!.title).toBe("标题");
		expect(tasks[0]!.prompt).toBe("正文");
		expect(tasks[0]!.name).toBeUndefined();
	});

	it("标记行标题前后空白归一", () => {
		const tasks = parseManifest("---\n[新会话]  标题  \n正文\n");
		expect(tasks[0]!.title).toBe("标题");
	});
});

describe("parseManifest：示例文件守护（examples/tasks.example.md 契约）", () => {
	it("示例清单解析为 4 个任务，模式与 name 字段符合文档", () => {
		const content = fs.readFileSync(new URL("../examples/tasks.example.md", import.meta.url), "utf-8");
		const tasks = parseManifest(content);
		expect(tasks.map((t) => t.mode)).toEqual(["new", "continue", "new", "new"]);
		expect(tasks.map((t) => t.index)).toEqual([1, 2, 3, 4]);
		expect(tasks[0]!.title).toBe("重构数据导入模块");
		expect(tasks[1]!.title).toBe("补充导入模块边界测试");
		expect(tasks[2]!.title).toBe("修复登录页样式");
		expect(tasks[3]!.name).toBe("数据导出专项");
		expect(tasks[3]!.title).toBe("优化导出模块性能");
		// 所有任务提示词非空
		expect(tasks.every((t) => t.prompt.length > 0)).toBe(true);
	});
});
