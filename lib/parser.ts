/**
 * Manifest file parsing.
 *
 * Format spec (PLAN section 4):
 * - Entries are separated by a lone `---` line (surrounding whitespace allowed);
 *   everything before the first `---` is ignored (may hold batch notes);
 * - If an entry's first line matches ^[new] or ^[continue] (case-insensitive)
 *   it is a mode-marker line; without a marker the default mode is "new";
 *   Chinese markers ([新会话] / [继续]) are NOT recognized — such text is kept
 *   verbatim as (part of) the title;
 * - Non-empty text after the marker = task title; without a marker, the first
 *   non-empty line = title; remaining non-empty lines = prompt body; when an
 *   entry is a single line, the title doubles as the prompt;
 * - After a bare marker line (marker with no title) and before the title line,
 *   reserved `key: value` field lines are allowed: `name` has semantics
 *   (explicit session naming, only for bare-marker "new" entries; a `name` on a
 *   "continue" task or an empty value is an error; the last `name` wins). All
 *   other keys are reserved for future extension and ignored. `key: value` lines
 *   appearing after the title is decided are treated as prompt body, so regular
 *   text is never swallowed;
 * - Blank lines in the prompt body are preserved; the body is trimmed at both
 *   ends; CRLF/LF both work; zero parsed tasks is an error.
 */

import { ManifestParseError, type BatchTask, type TaskMode } from "./types.ts";

export { ManifestParseError };

/** v1 reserved fields: ignored only between a bare marker line and the title line. */
const RESERVED_FIELD_KEYS = new Set(["model", "timeout", "retries", "max-turns", "on-exhaust"]);

const MARKER_RE = /^\s*\[(new|continue)\]\s*(.*)$/i;
const FIELD_LINE_RE = /^([a-z][a-z0-9_-]*):\s*(.*)$/;
const SEPARATOR_RE = /^\s*---\s*$/;

/** Normalizes a raw marker into the task mode (English-only markers, case-insensitive). */
function normalizeMode(marker: string): TaskMode {
	return marker.toLowerCase() === "new" ? "new" : "continue";
}

/**
 * Parses manifest text into a task list.
 *
 * @returns Parsed tasks in manifest order.
 * @throws {@link ManifestParseError} when no task is found or an entry is invalid.
 */
export function parseManifest(content: string): BatchTask[] {
	const normalized = content.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");

	// Everything before the first `---` is ignored.
	let i = 0;
	while (i < lines.length && !SEPARATOR_RE.test(lines[i] ?? "")) i++;
	// Skip the `---` line itself.
	i++;

	const tasks: BatchTask[] = [];

	while (i < lines.length) {
		// Collect one entry (up to the next `---` or end of file).
		const entryLines: string[] = [];
		while (i < lines.length && !SEPARATOR_RE.test(lines[i] ?? "")) {
			entryLines.push(lines[i] ?? "");
			i++;
		}
		i++; // Skip the separator.

		if (entryLines.join("").trim() === "") continue; // Skip empty entries.

		const task = parseEntry(entryLines, tasks.length + 1);
		if (task) tasks.push(task);
	}

	if (tasks.length === 0) {
		throw new ManifestParseError("清单中未找到任何任务：请确认文件以 --- 分隔任务条目");
	}
	return tasks;
}

/** Parses a single entry; returns undefined for empty content (callers already filter empties; kept defensively). */
function parseEntry(entryLines: string[], oneBasedIndex: number): BatchTask | undefined {
	let mode: TaskMode = "new";
	let explicitTitle = "";
	let sessionName: string | undefined;
	let cursor = 0;

	// (1) Optional mode-marker line.
	const first = entryLines[0] ?? "";
	const markerMatch = MARKER_RE.exec(first);
	if (markerMatch) {
		mode = normalizeMode(markerMatch[1] ?? "");
		explicitTitle = (markerMatch[2] ?? "").trim();
		cursor = 1;

		// (2) Bare marker line: the title may come after future reserved-field lines.
		if (explicitTitle === "") {
			while (cursor < entryLines.length) {
				const line = (entryLines[cursor] ?? "").trim();
				if (line === "") {
					cursor++;
					continue;
				}
				const fieldMatch = FIELD_LINE_RE.exec(line);
				if (fieldMatch && RESERVED_FIELD_KEYS.has(fieldMatch[1] ?? "")) {
					cursor++; // Reserved field: ignore.
					continue;
				}
				if (fieldMatch && fieldMatch[1] === "name") {
					const value = (fieldMatch[2] ?? "").trim();
					if (value === "") {
						throw new ManifestParseError(`任务 ${oneBasedIndex}：name 字段值不能为空`, oneBasedIndex);
					}
					sessionName = value; // Repeated `name:`: the last one wins.
					cursor++;
					continue;
				}
				break; // First non-field line = title.
			}
			if (sessionName !== undefined && mode === "continue") {
				throw new ManifestParseError(`任务 ${oneBasedIndex}：name 字段仅对「新会话」任务有效`, oneBasedIndex);
			}
			if (cursor < entryLines.length) {
				explicitTitle = (entryLines[cursor] ?? "").trim();
				cursor++;
			}
		}
	} else {
		// (3) No marker: first non-empty line = title.
		while (cursor < entryLines.length && (entryLines[cursor] ?? "").trim() === "") cursor++;
		if (cursor < entryLines.length) {
			explicitTitle = (entryLines[cursor] ?? "").trim();
			cursor++;
		}
	}

	// (4) Remaining lines = prompt body.
	const body = entryLines.slice(cursor).join("\n").replace(/^\n+/, "").replace(/\n+$/, "").trim();

	if (explicitTitle === "" && body === "") {
		// A marker with no content at all is an explicit writing mistake:
		// raise instead of silently skipping.
		if (markerMatch) {
			throw new ManifestParseError(`任务 ${oneBasedIndex} 提示词正文为空`, oneBasedIndex);
		}
		return undefined;
	}

	// Title fallback: single-line entries use the first body line as both title and prompt.
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

	return { index: oneBasedIndex, mode, title, name: sessionName, prompt };
}

/** Returns the first line of `text`, trimmed. */
function firstLineOf(text: string): string {
	const idx = text.indexOf("\n");
	return (idx === -1 ? text : text.slice(0, idx)).trim();
}

/**
 * Splits raw command arguments into tokens.
 *
 * Double quotes group a path containing spaces into a single token.
 *
 * @example
 * tokenizeArgs('"my tasks.md" --dry-run'); // => ["my tasks.md", "--dry-run"]
 */
export function tokenizeArgs(raw: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw)) !== null) {
		tokens.push(m[1] ?? m[2] ?? "");
	}
	return tokens;
}
