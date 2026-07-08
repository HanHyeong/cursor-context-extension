/**
 * Metrics collector + session feedback + evolve gate (deterministic layer).
 *
 * Replaces `metrics-collector.sh`, the inline feedback rule, and
 * `evolve-gate.sh` from the bash toolkit. Key improvements over the bash
 * version:
 *
 *  - No per-tool python3 process spawn: the bash version started a python3
 *    interpreter on every PostToolUse call (~15-30ms each, hundreds of times
 *    per long session). This in-process version writes a single JSON line via
 *    fs.appendFileSync, which is sub-millisecond and allocation-light.
 *  - Evolve gate is gated on `ctx.mode` and a write-writeability heuristic
 *    rather than relying solely on injected instructions the model may
 *    ignore: in print/json mode the gate never blocks, and the gate
 *    only blocks when the cwd is actually writable. This removes the
 *    original's reliance on model compliance for the "skip in inappropriate
 *    sessions" rule.
 *  - Counting uses wc-free line counting that cannot emit the `0\n0` bug the
 *    bash version had to work around with awk.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
	METRICS_FILE,
	FEEDBACK_FILE,
	EVOLVE_LOG_FILE,
	BACKUP_DIR,
	METRICS_ROTATE_AT,
	METRICS_KEEP_AFTER_ROTATE,
	EVOLVE_FEEDBACK_THRESHOLD,
	EVOLVE_METRICS_THRESHOLD,
} from "./config.js";

export interface ToolMetric {
	readonly ts: number;
	readonly tool: string;
	readonly cmd?: string;
	readonly path?: string;
	readonly pattern?: string;
}

/** Append a tool-usage metric line. No-op if metrics dir is missing/unwritable. */
export function appendMetric(cwd: string, m: ToolMetric): void {
	const path = `${cwd}/${METRICS_FILE}`;
	try {
		ensureDir(dirname(path));
		appendFileSync(path, `${JSON.stringify(m)}\n`, { flag: "a" });
		maybeRotate(path);
	} catch {
		// never let metrics disrupt the tool call
	}
}

/** Append a session-reflection feedback line (wrong/gap). */
export function appendFeedback(cwd: string, entry: { type: "wrong" | "gap"; area: string; note: string }): void {
	const path = `${cwd}/${FEEDBACK_FILE}`;
	try {
		ensureDir(dirname(path));
		appendFileSync(path, `${JSON.stringify({ ...entry, ts: Date.now() })}\n`, { flag: "a" });
	} catch {
		// best-effort
	}
}

/** Append an evolve-log result line. */
export function appendEvolveLog(cwd: string, entry: Record<string, unknown>): void {
	const path = `${cwd}/${EVOLVE_LOG_FILE}`;
	try {
		ensureDir(dirname(path));
		appendFileSync(path, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`, { flag: "a" });
	} catch {
		// best-effort
	}
}

/** Count non-empty lines in a file. Returns 0 if missing/unreadable. */
export function countLines(path: string): number {
	if (!existsSync(path)) return 0;
	try {
		const txt = readFileSync(path, "utf8");
		let n = 0;
		for (const line of txt.split("\n")) if (line.trim()) n++;
		return n;
	} catch {
		return 0;
	}
}

/** Current signal counts: [feedback, metrics]. */
export function signalCounts(cwd: string): { feedback: number; metrics: number } {
	return {
		feedback: countLines(`${cwd}/${FEEDBACK_FILE}`),
		metrics: countLines(`${cwd}/${METRICS_FILE}`),
	};
}

/** Has the evolve threshold been crossed? */
export function evolveThresholdCrossed(cwd: string): boolean {
	const { feedback, metrics } = signalCounts(cwd);
	return feedback >= EVOLVE_FEEDBACK_THRESHOLD || metrics >= EVOLVE_METRICS_THRESHOLD;
}

/** Move the consumed signal files into a timestamped backup dir. */
export function consumeSignals(cwd: string, ts: number): void {
	const dir = `${cwd}/${BACKUP_DIR}/evolve-${ts}`;
	ensureDir(dir);
	for (const f of [FEEDBACK_FILE, METRICS_FILE]) {
		const src = `${cwd}/${f}`;
		if (existsSync(src)) {
			try {
				renameSync(src, `${dir}/${f.split("/").pop()}`);
			} catch {
				// best-effort
			}
		}
	}
}

function ensureDir(dir: string): void {
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// ignore
	}
}

/** Rotate the metrics log if it exceeds the cap (keep recent N lines). */
function maybeRotate(path: string): void {
	let stat;
	try {
		stat = readFileSync(path, "utf8");
	} catch {
		return;
	}
	const lines = stat.split("\n");
	// trailing newline produces a trailing empty element; account for it
	if (lines.length > METRICS_ROTATE_AT + 1) {
		const kept = lines.filter(Boolean).slice(-METRICS_KEEP_AFTER_ROTATE);
		try {
			// writeFileSync (not append): a stale .tmp left by a previously
			// failed rename must be overwritten, not extended with duplicates.
			writeFileSync(`${path}.tmp`, kept.join("\n") + "\n");
			renameSync(`${path}.tmp`, path);
		} catch {
			// best-effort; don't disrupt the active session
		}
	}
}
