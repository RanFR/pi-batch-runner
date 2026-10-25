/**
 * 清单文件解析。
 *
 * 格式规范（PLAN 第 4 节）：
 * - 以单独一行 `---`（前后允许空白）分隔任务条目；首个 `---` 之前的内容全部忽略；
 * - 条目第一行若匹配 ^[(新会话|new)] 或 ^[(继续|continue)]（大小写不敏感）则为模式标记行；
 *   无标记时默认「新会话」；
 * - 标记行中标记之后的非空文本 = 任务标题；无标记时条目第一行非空文本 = 标题；
 *   其余非空行为提示词正文；条目只有一行时标题 = 正文首行；
 * - 裸标记行（标记后无标题）之后、标题行之前，允许出现保留字段行 `key: value`
 *   （v1 仅为未来扩展预留解析位，识别后忽略，不实现语义）；
 *   标题已确定后出现的 `key: value` 行一律视为正文，避免误吞普通文本；
 * - 提示词正文中的空行保留，整体 trim 首尾；
 * - 行尾兼容 CRLF/LF；解析结果为 0 个任务时报错。
 */

import { ManifestParseError, type BatchTask, type TaskMode } from "./types.ts";

export { ManifestParseError };

/** v1 保留字段：仅出现在「裸标记行之后、标题行之前」时被忽略 */
const RESERVED_FIELD_KEYS = new Set(["model", "timeout", "retries", "max-turns", "on-exhaust"]);

const MARKER_RE = /^\s*\[(新会话|new|继续|continue)\]\s*(.*)$/i;
const FIELD_LINE_RE = /^([a-z][a-z0-9_-]*):\s*(.*)$/;
const SEPARATOR_RE = /^\s*---\s*$/;

/** 从标记原文归一化任务模式 */
function normalizeMode(marker: string): TaskMode {
	const m = marker.toLowerCase();
	if (m === "新会话" || m === "new") return "new";
	return "continue";
}

/** 解析清单文本，返回任务列表；0 个任务时抛出 ManifestParseError */
export function parseManifest(content: string): BatchTask[] {
	const normalized = content.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");

	// 首个 --- 之前的内容全部忽略
	let i = 0;
	while (i < lines.length && !SEPARATOR_RE.test(lines[i] ?? "")) i++;
	// 跳过首个 --- 本身
	i++;

	const tasks: BatchTask[] = [];

	while (i < lines.length) {
		// 收集一个条目（到下一个 --- 或文件结束）
		const entryLines: string[] = [];
		while (i < lines.length && !SEPARATOR_RE.test(lines[i] ?? "")) {
			entryLines.push(lines[i] ?? "");
			i++;
		}
		i++; // 跳过分隔符

		if (entryLines.join("").trim() === "") continue; // 空条目跳过

		const task = parseEntry(entryLines, tasks.length + 1);
		if (task) tasks.push(task);
	}

	if (tasks.length === 0) {
		throw new ManifestParseError("清单中未找到任何任务：请确认文件以 --- 分隔任务条目");
	}
	return tasks;
}

/** 解析单个条目；内容为空时返回 undefined（调用方已过滤空条目，防御性保留） */
function parseEntry(entryLines: string[], oneBasedIndex: number): BatchTask | undefined {
	let mode: TaskMode = "new";
	let explicitTitle = "";
	let cursor = 0;

	// (1) 模式标记行（可选）
	const first = entryLines[0] ?? "";
	const markerMatch = MARKER_RE.exec(first);
	if (markerMatch) {
		mode = normalizeMode(markerMatch[1] ?? "");
		explicitTitle = (markerMatch[2] ?? "").trim();
		cursor = 1;

		// (2) 裸标记行：允许在未来扩展字段行出现后再确定标题
		if (explicitTitle === "") {
			while (cursor < entryLines.length) {
				const line = (entryLines[cursor] ?? "").trim();
				if (line === "") {
					cursor++;
					continue;
				}
				const fieldMatch = FIELD_LINE_RE.exec(line);
				if (fieldMatch && RESERVED_FIELD_KEYS.has(fieldMatch[1] ?? "")) {
					cursor++; // 保留字段：忽略
					continue;
				}
				break; // 第一行非字段文本 = 标题
			}
			if (cursor < entryLines.length) {
				explicitTitle = (entryLines[cursor] ?? "").trim();
				cursor++;
			}
		}
	} else {
		// (3) 无标记：第一行非空文本 = 标题
		while (cursor < entryLines.length && (entryLines[cursor] ?? "").trim() === "") cursor++;
		if (cursor < entryLines.length) {
			explicitTitle = (entryLines[cursor] ?? "").trim();
			cursor++;
		}
	}

	// (4) 剩余行为正文
	const body = entryLines
		.slice(cursor)
		.join("\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "")
		.trim();

	if (explicitTitle === "" && body === "") {
		// 有标记但无任何内容：空条目是明确的书写错误，报错而非静默跳过
		if (markerMatch) {
			throw new ManifestParseError(`任务 ${oneBasedIndex} 提示词正文为空`, oneBasedIndex);
		}
		return undefined;
	}

	// 标题回退：条目只有一行时，标题 = 正文首行（该行同时作为提示词）
	let title: string;
	let prompt: string;
	if (explicitTitle !== "") {
		title = explicitTitle;
		prompt = body !== "" ? body : explicitTitle;
	} else {
		title = firstLineOf(body);
		prompt = body;
	}

	if (prompt === "") {
		throw new ManifestParseError(`任务 ${oneBasedIndex}（${title}）提示词正文为空`, oneBasedIndex);
	}

	return { index: oneBasedIndex, mode, title, prompt };
}

function firstLineOf(text: string): string {
	const idx = text.indexOf("\n");
	return (idx === -1 ? text : text.slice(0, idx)).trim();
}

/** 解析参数切分：支持双引号包裹含空格路径 */
export function tokenizeArgs(raw: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw)) !== null) {
		tokens.push(m[1] ?? m[2] ?? "");
	}
	return tokens;
}
