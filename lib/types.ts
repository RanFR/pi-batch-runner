/**
 * 批处理扩展共享类型。
 *
 * 本模块是纯数据与窄接口定义，不依赖 pi 的类型（lib/ 下所有模块保持零外部依赖，
 * 只用 Node 内置模块），便于单元测试用手写 fake 驱动执行引擎。
 * pi 真实类型仅在 index.ts 入口处做结构适配。
 */

// ============================================================================
// 清单解析结果
// ============================================================================

/** 单条任务的会话模式 */
export type TaskMode = "new" | "continue";

/** 清单文件解析出的一条任务 */
export interface BatchTask {
	/** 1-based 序号（清单中的顺序） */
	index: number;
	/** 会话模式：new = 全新会话；continue = 沿用上一个任务的会话 */
	mode: TaskMode;
	/** 任务标题（用于状态栏、进度、汇总、会话命名） */
	title: string;
	/** 提示词正文（多行，已 trim 首尾） */
	prompt: string;
}

/** 解析失败 */
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
// 批次状态（内存对象 + progress 文件落盘镜像）
// ============================================================================

export type TaskStatus = "pending" | "running" | "ok" | "failed" | "skipped";

/** 单个任务的执行记录（progress 文件中的镜像；prompt 一并保留，断点续跑自包含） */
export interface TaskRecord {
	index: number;
	mode: TaskMode;
	title: string;
	/** 提示词正文（来自清单解析） */
	prompt: string;
	status: TaskStatus;
	/** 已尝试次数（含失败重试；成功尝试也计入） */
	attempts: number;
	/** 最近一次尝试所在会话文件路径 */
	sessionFile?: string;
	/** 最近一次失败的错误摘要 */
	error?: string;
	startedAt?: number;
	endedAt?: number;
}

export type OnExhaust = "pause" | "skip" | "abort";

/** 批次运行状态。progress 文件 schema 即本结构 + schemaVersion。 */
export interface BatchState {
	/** 清单文件绝对路径 */
	listFile: string;
	/** 批次标题（清单文件名去扩展名） */
	batchTitle: string;
	startedAt: number;
	updatedAt: number;
	retries: number;
	onExhaust: OnExhaust;
	tasks: TaskRecord[];
}

/** progress 文件内容 */
export interface ProgressFile extends BatchState {
	schemaVersion: 1;
}

/** progress 文件路径：<清单文件>.progress.json */
export function progressPathFor(listFile: string): string {
	return `${listFile}.progress.json`;
}

/** 汇总报告路径：<清单文件>.report.md */
export function reportPathFor(listFile: string): string {
	return `${listFile}.report.md`;
}

/** 批次是否已终结（全部任务定案） */
export function isTerminalStatus(status: TaskStatus): boolean {
	return status === "ok" || status === "failed" || status === "skipped";
}

// ============================================================================
// 执行引擎所需的窄上下文视图
//
// 真实的 ExtensionCommandContext / ReplacedSessionContext 在 index.ts 中被适配为
// BatchContext（只暴露引擎用到的方法），单元测试用普通对象实现同一接口。
// ============================================================================

/** 引擎用到的 UI 操作子集 */
export interface BatchUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, content: string[] | undefined): void;
}

/** 会话分支条目的窄视图（只读，用于结果判定） */
export interface BranchEntryView {
	type: string;
	message?: {
		role: string;
		stopReason?: string;
		errorMessage?: string;
	};
}

/**
 * 引擎眼中的会话上下文（对应 ExtensionCommandContext / ReplacedSessionContext）。
 * 「新会话」边界后，withSession 回调拿到的新上下文同样适配为本接口。
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
	 * 会话切换回调收到完整的 BatchLeg（新上下文 + 对应的发送函数）。
	 * 引擎在回调内使用 fresh leg 推进后续任务；旧 leg 同时失效。
	 * name：新会话的显示名（经 newSession 的 setup 直接写入 sessionManager，
	 * 避免使用替换后已失效的旧 pi 门面）。
	 */
	newSession(options: {
		name?: string;
		withSession: (freshLeg: BatchLeg) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;
	switchSession(
		sessionPath: string,
		options: { withSession: (freshLeg: BatchLeg) => Promise<void> },
	): Promise<{ cancelled: boolean }>;
}

/**
 * 发送提示词的函数。
 * - 首条 leg 用 pi.sendUserMessage（返回 void，错误被 pi 运行时吞掉并上报）；
 * - 会话切换后用 ReplacedSessionContext.sendUserMessage（返回 Promise，run 结束才 resolve）。
 * 引擎对两种返回都兼容：返回 Promise 时把它作为额外的完成信号。
 */
export interface BatchSend {
	(content: string, options?: { expandPromptTemplates?: boolean }): void | Promise<void>;
}

/** 一条执行腿：一个活跃会话上下文 + 对应的发送函数 */
export interface BatchLeg {
	ctx: BatchContext;
	send: BatchSend;
}

// ============================================================================
// 执行引擎依赖（可注入，便于测试）
// ============================================================================

/** agent_settled 事件源（index.ts 在 factory 期一次性订阅并桥接到闭包监听槽位；
 *  运行期 subscribe/unsubscribe 不触碰 pi 门面，避免会话替换后的 stale 错误） */
export interface SettledBus {
	subscribe(cb: (event: { aborted: boolean }) => void): () => void;
}

/** 引擎可注入依赖 */
export interface EngineDeps {
	/** settled 事件源（先订阅后发送的关键） */
	settled: SettledBus;
	/** 时钟（毫秒），默认 Date.now */
	now?: () => number;
	/** 睡眠，默认 setTimeout；测试可注入即时 resolve */
	sleep?: (ms: number) => Promise<void>;
	/** 发送失败判定窗口（毫秒），默认 10_000；测试可调小 */
	sendFailTimeoutMs?: number;
	/** 终端响铃，默认 process.stdout.write("\x07") */
	bell?: () => void;
	/** 批次终结后的回调（index.ts 用来清理 activeBatch） */
	onBatchEnd?: () => void;
}

// ============================================================================
// 命令配置
// ============================================================================

/** /batch 启动配置（命令行参数解析结果 + 默认值） */
export interface RunConfig {
	retries: number;
	onExhaust: OnExhaust;
	/** 1-based 起始任务号（--start） */
	startAt: number;
	dryRun: boolean;
}

export const DEFAULT_RETRIES = 3;
export const DEFAULT_ON_EXHAUST: OnExhaust = "pause";
export const RETRY_DELAY_MS = 2_000;
export const PENDING_DRAIN_TIMEOUT_MS = 5 * 60_000;
