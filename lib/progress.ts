/**
 * Progress-file and report I/O.
 *
 * - Progress file: `<manifest>.progress.json`, a disk mirror of BatchState and
 *   the single source of truth for batch state (the extension factory re-runs on
 *   every session replacement, so factory-scoped state is unreliable; see the
 *   module-level state notes in index.ts);
 * - When a batch finishes, the file is renamed to
 *   `<manifest>.progress.done.json` so the next launch does not offer a resume;
 * - Summary report: `<manifest>.report.md`.
 *
 * All writes are synchronous (task counts are small; full rewrites are fine).
 * Callers are responsible for catching IO errors.
 */

import * as fs from "node:fs";
import type { BatchState, ProgressFile } from "./types.ts";
import { progressPathFor, reportPathFor } from "./types.ts";

/**
 * Loads an unfinished progress file.
 *
 * @returns The parsed progress file, or null when it does not exist or is corrupt.
 */
export function loadProgress(listFile: string): ProgressFile | null {
	const path = progressPathFor(listFile);
	try {
		if (!fs.existsSync(path)) return null;
		const raw = fs.readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as ProgressFile;
		if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Writes the progress file (full rewrite); also refreshes `updatedAt`. */
export function saveProgress(state: BatchState): void {
	state.updatedAt = Date.now();
	const file: ProgressFile = { schemaVersion: 1, ...state };
	fs.writeFileSync(progressPathFor(state.listFile), JSON.stringify(file, null, "\t"), "utf-8");
}

/**
 * Finalizes a batch: renames progress → `.progress.done.json`.
 *
 * Idempotent: an existing target is removed first (on Windows renameSync throws
 * when the target exists, which would leave a stale progress file behind).
 *
 * @returns The done-file path, or null when the source file does not exist.
 */
export function finishProgress(listFile: string): string | null {
	const from = progressPathFor(listFile);
	const to = `${from}.done`;
	if (!fs.existsSync(from)) return null;
	if (fs.existsSync(to)) fs.rmSync(to);
	fs.renameSync(from, to);
	return to;
}

/** Backs up a stale `.progress.done.json` (used when restarting from scratch). */
export function backupDoneProgress(listFile: string): void {
	const donePath = `${progressPathFor(listFile)}.done`;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	try {
		if (fs.existsSync(donePath)) fs.renameSync(donePath, `${donePath}.${stamp}.bak`);
	} catch {
		// A failed backup must not block the main flow.
	}
}

/** Writes the summary report markdown. */
export function writeReport(listFile: string, content: string): void {
	fs.writeFileSync(reportPathFor(listFile), content, "utf-8");
}

// Historical note: the pendingName/session_start naming mechanism was replaced by writing the name directly via newSession({ setup }). The old
// pi facade goes stale after a session replacement (a fatal error in practice),
// and pi.setSessionName is unavailable inside session_start handlers, so the
// file-based relay was dropped.
