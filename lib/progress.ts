/**
 * 进度文件与汇总报告的读写。
 *
 * - progress 文件：<清单文件>.progress.json，BatchState 的落盘镜像，是批次状态的唯一事实源
 *   （扩展工厂在每次会话替换时都会重新执行，工厂体内的状态不可靠，见 index.ts 模块级状态说明
 *   与 PLAN 陷阱 5）；
 * - 批次终结后重命名为 <清单文件>.progress.done.json，避免下次误触发续跑询问；
 * - 汇总报告：<清单文件>.report.md。
 *
 * 所有写操作同步执行（任务数量有限，整体重写即可），由调用方捕获 IO 异常。
 */

import * as fs from "node:fs";
import type { BatchState, ProgressFile } from "./types.ts";
import { progressPathFor, reportPathFor } from "./types.ts";

/** 读取未完成的 progress 文件；不存在或损坏时返回 null */
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

/** 写入 progress 文件（整体重写） */
export function saveProgress(state: BatchState): void {
	state.updatedAt = Date.now();
	const file: ProgressFile = { schemaVersion: 1, ...state };
	fs.writeFileSync(progressPathFor(state.listFile), JSON.stringify(file, null, "\t"), "utf-8");
}

/**
 * 批次终结：progress → .progress.done.json（幂等：目标已存在时先删除，
 * 避免 Windows 上 renameSync 目标存在时抛错残留 progress 文件）。
 * 返回 done 文件路径；源文件不存在时返回 null。
 */
export function finishProgress(listFile: string): string | null {
	const from = progressPathFor(listFile);
	const to = `${from}.done`;
	if (!fs.existsSync(from)) return null;
	if (fs.existsSync(to)) fs.rmSync(to);
	fs.renameSync(from, to);
	return to;
}

/** 删除过期的 .progress.done.json（重新从头开始时备份旧进度用） */
export function backupDoneProgress(listFile: string): void {
	const donePath = `${progressPathFor(listFile)}.done`;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	try {
		if (fs.existsSync(donePath)) fs.renameSync(donePath, `${donePath}.${stamp}.bak`);
	} catch {
		// 备份失败不阻塞主流程
	}
}

/** 写汇总报告 markdown */
export function writeReport(listFile: string, content: string): void {
	fs.writeFileSync(reportPathFor(listFile), content, "utf-8");
}

// ============================================================================
// （原 PLAN 6.7 的 pendingName/session_start 命名机制已改为 newSession({ setup })
// 直写 sessionManager：会话替换后旧 pi 门面 stale（实测致命错误），
// pi.setSessionName 在 session_start 处理器中不可用，故废弃该文件中转机制。）
// ============================================================================
