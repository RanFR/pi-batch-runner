/**
 * Shared types for the batch-runner extension.
 *
 * This module holds pure data shapes and narrow interfaces. It does not depend
 * on pi's types (every module under lib/ stays dependency-free except for Node
 * built-ins), so unit tests can drive the executor with hand-written fakes.
 * pi's real types are structurally adapted in the index.ts entry point only.
 */

// ============================================================================
// Manifest parsing results
// ============================================================================

/** Session mode of a single task. */
export type TaskMode = "new" | "continue";

/** One task parsed from a manifest file. */
export interface BatchTask {
	/** 1-based position (order in the manifest). */
	index: number;
	/** Session mode: "new" = fresh session; "continue" = reuse the previous task's session. */
	mode: TaskMode;
	/** Task title (status bar, progress, report; session naming, see {@link BatchTask.name}). */
	title: string;
	/**
	 * Explicit session name (from a `name:` reserved-field line). Only valid for
	 * bare-marker entries with mode === "new"; when undefined the new session is
	 * left unnamed.
	 */
	name?: string;
	/** Prompt body (multi-line, trimmed at both ends). */
	prompt: string;
}

/** Thrown when manifest parsing fails. */
export class ManifestParseError extends Error {
	constructor(
		message: string,
		public readonly line?: number,
	) {
		super(message);
		this.name = "ManifestParseError";
	}
}

// ============================================================================
// Batch state (in-memory object mirrored to the progress file)
// ============================================================================

export type TaskStatus = "pending" | "running" | "ok" | "failed" | "skipped";

/** Execution record of a single task (mirrored into the progress file; the prompt is kept too so a resume is self-contained). */
export interface TaskRecord {
	index: number;
	mode: TaskMode;
	title: string;
	/** Explicit session name (from the manifest `name:` line; only "new" tasks have a value, undefined = unnamed). */
	name?: string;
	/** Prompt body (from manifest parsing). */
	prompt: string;
	status: TaskStatus;
	/** Attempts so far (failed retries included; the successful attempt counts too). */
	attempts: number;
	/** Session file path of the most recent attempt. */
	sessionFile?: string;
	/** Error summary of the most recent failure. */
	error?: string;
	/** Epoch ms when the task first started. */
	startedAt?: number;
	/** Epoch ms when the task reached a terminal status. */
	endedAt?: number;
}

export type OnExhaust = "pause" | "skip" | "abort";

/** Running state of a batch. The progress-file schema is this shape plus `schemaVersion`. */
export interface BatchState {
	/** Absolute path of the manifest file. */
	listFile: string;
	/** Batch title (manifest file name without extension). */
	batchTitle: string;
	startedAt: number;
	updatedAt: number;
	retries: number;
	onExhaust: OnExhaust;
	/** Per-task records, in manifest order. */
	tasks: TaskRecord[];
}

/** Content of the progress file (BatchState plus a schema version). */
export interface ProgressFile extends BatchState {
	schemaVersion: 1;
}

/** Progress file path: `<manifest>.progress.json`. */
export function progressPathFor(listFile: string): string {
	return `${listFile}.progress.json`;
}

/** Report file path: `<manifest>.report.md`. */
export function reportPathFor(listFile: string): string {
	return `${listFile}.report.md`;
}

/** True when the status is final ("ok", "failed", or "skipped"). */
export function isTerminalStatus(status: TaskStatus): boolean {
	return status === "ok" || status === "failed" || status === "skipped";
}

// ============================================================================
// Narrow context view required by the executor
//
// The real ExtensionCommandContext / ReplacedSessionContext is adapted into a
// BatchContext in index.ts (exposing only the methods the engine uses); unit
// tests implement the same interface with plain objects.
// ============================================================================

/** UI operations used by the executor (subset of pi's extension UI). */
export interface BatchUi {
	/** Shows a selection dialog; resolves to undefined when dismissed. */
	select(title: string, options: string[]): Promise<string | undefined>;
	/** Shows a transient notification. */
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** Sets or clears a status-bar entry. */
	setStatus(key: string, text: string | undefined): void;
	/** Sets or clears a persistent widget above the editor. */
	setWidget(key: string, content: string[] | undefined): void;
}

/** Narrow read-only view of a session branch entry (used to judge outcomes). */
export interface BranchEntryView {
	/** Entry type (e.g. "message"). */
	type: string;
	/** Message fields inspected by the executor, when the entry is a message. */
	message?: {
		/** Message role (e.g. "assistant"). */
		role: string;
		/** Stop reason of the last model turn ("error"/"aborted" indicate failure). */
		stopReason?: string;
		/** Error detail when the turn failed. */
		errorMessage?: string;
	};
}

/**
 * Session context as the engine sees it (mirrors ExtensionCommandContext /
 * ReplacedSessionContext). After a "new session" boundary, the fresh context
 * handed to the withSession callback is adapted to this same interface.
 */
export interface BatchContext {
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	waitForIdle(): Promise<void>;
	abort(): void;
	readonly sessionManager: {
		getSessionFile(): string | undefined;
		getBranch(): readonly BranchEntryView[];
	};
	readonly ui: BatchUi;
	/**
	 * Session-switch callbacks receive a full BatchLeg (fresh context plus its
	 * send function). The engine drives subsequent tasks inside the callback;
	 * the old leg becomes stale at the same time.
	 *
	 * `name` names the new session (written straight into the sessionManager via
	 * newSession's `setup`, avoiding the stale pi facade after replacement).
	 */
	newSession(options: { name?: string; withSession: (freshLeg: BatchLeg) => Promise<void> }): Promise<{ cancelled: boolean }>;
	switchSession(sessionPath: string, options: { withSession: (freshLeg: BatchLeg) => Promise<void> }): Promise<{ cancelled: boolean }>;
}

/**
 * Sends a prompt.
 * - The first leg uses pi.sendUserMessage (returns void; errors are swallowed
 *   and reported by pi's runtime);
 * - After a session switch, ReplacedSessionContext.sendUserMessage returns a
 *   Promise that resolves only when the run has finished.
 * The engine accepts both: a returned Promise serves as an extra completion
 * signal.
 */
export interface BatchSend {
	(content: string, options?: { expandPromptTemplates?: boolean }): void | Promise<void>;
}

/** One execution leg: an active session context plus its send function. */
export interface BatchLeg {
	ctx: BatchContext;
	send: BatchSend;
}

// ============================================================================
// Executor dependencies (injectable for testing)
// ============================================================================

/**
 * agent_settled event source (index.ts subscribes once during the factory phase
 * and bridges it to a module-level listener slot; subscribe/unsubscribe at run
 * time never touch the pi facade, avoiding stale errors after session
 * replacements).
 */
export interface SettledBus {
	/** Registers a listener; returns its unsubscribe function. The event carries `aborted` (true when the user aborted). */
	subscribe(cb: (event: { aborted: boolean }) => void): () => void;
}

/** Dependencies injectable into the executor. */
export interface EngineDeps {
	/** Settled-event source (subscribing before sending is essential). */
	settled: SettledBus;
	/** Clock in milliseconds; defaults to Date.now. */
	now?: () => number;
	/** Sleep; defaults to setTimeout. Tests can inject an instantly-resolved version. */
	sleep?: (ms: number) => Promise<void>;
	/** Send-failure watchdog window in milliseconds; defaults to 10_000. Tests can shrink it. */
	sendFailTimeoutMs?: number;
	/**
	 * Extra watchdog grace for void sends in milliseconds; defaults to 50_000.
	 * A void send (root-session pi.sendUserMessage without a returned Promise)
	 * lacks the second completion signal, and pi's prompt() has two async points
	 * before _startRun (input handler and auth probing over the network): isIdle
	 * stays true during slow auth, so a longer window avoids misjudging
	 * send-failure.
	 */
	sendFailVoidGraceMs?: number;
	/** Terminal bell; defaults to process.stdout.write("\x07"). */
	bell?: () => void;
	/** Callback after the batch is finalized (index.ts clears activeBatch). */
	onBatchEnd?: () => void;
}

// ============================================================================
// Command configuration
// ============================================================================

/** /batch launch configuration (parsed command-line options plus defaults). */
export interface RunConfig {
	retries: number;
	onExhaust: OnExhaust;
	/** 1-based first task to run (--start). */
	startAt: number;
	dryRun: boolean;
}

export const DEFAULT_RETRIES = 3;
export const DEFAULT_ON_EXHAUST: OnExhaust = "pause";
export const RETRY_DELAY_MS = 2_000;
export const PENDING_DRAIN_TIMEOUT_MS = 5 * 60_000;
