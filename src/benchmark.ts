/**
 * Benchmark gate (deterministic doc-quality checker).
 *
 * Replaces `context-benchmark.sh`. A new/evolved doc must pass before being
 * adopted; on failure the previous doc is restored from backup. The gate
 * and the metrics collector are permanently excluded from evolution — a
 * system that can rewrite its own scorer degenerates.
 *
 * Hard checks (FAIL) reject the doc; soft checks (WARN) are advisory.
 */

import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

import { CONTEXT_FILE, BACKUP_DIR, TARGET_BODY_LINES, MAX_CTX_LINES } from "./config.js";
import {
	readText,
	bodyLineCount,
	computeFingerprint,
	parseStoredFingerprint,
	diffFingerprints,
	npmScripts,
	fileExists,
	run,
} from "./git.js";

export interface BenchmarkResult {
	readonly pass: number;
	readonly warn: number;
	readonly fail: number;
	readonly lines: readonly string[];
	readonly ok: boolean;
}

/** Run the benchmark gate against the doc at `cwd/${CONTEXT_FILE}`. */
export async function benchmark(cwd: string): Promise<BenchmarkResult> {
	const docPath = `${cwd}/${CONTEXT_FILE}`;
	const lines: string[] = [];
	let pass = 0,
		warn = 0,
		fail = 0;
	const ok = () => (pass++, lines.push(`PASS`));
	const warn_ = (m: string) => (warn++, lines.push(`WARN: ${m}`));
	const fail_ = (m: string) => (fail++, lines.push(`FAIL: ${m}`));

	if (!existsSync(docPath)) {
		lines.push("FAIL: doc missing");
		return { pass: 0, warn: 0, fail: 1, lines, ok: false };
	}
	const doc = (await readText(docPath)) ?? "";

	// 1. Body length
	const body = bodyLineCount(doc);
	if (body <= TARGET_BODY_LINES) ok();
	else if (body <= MAX_CTX_LINES) warn_(`body ${body} lines (over ${TARGET_BODY_LINES} — diet recommended)`);
	else fail_(`body ${body} lines — exceeds ${MAX_CTX_LINES}, injection truncates`);

	// 2. Freshness markers
	const stored = parseStoredFingerprint(doc);
	if (stored.length === 0) {
		warn_("fingerprint block absent (record on next refresh)");
	} else {
		const current = await computeFingerprint(cwd);
		if (current.length === 0) warn_("cannot compute fingerprint (no structural files)");
		else {
			const changed = diffFingerprints(stored, current);
			if (changed.length === 0) ok();
			else fail_(`fingerprint mismatch — re-stamp markers (changed: ${changed.join(", ")})`);
		}
	}

	// 3. npm scripts referenced in the doc must exist
	const scripts = await npmScripts(cwd);
	if (scripts.length > 0) {
		const names = new Set(scripts.map((s) => s[0]));
		const used = new Set<string>();
		for (const m of doc.matchAll(/(?:npm|pnpm|yarn|bun)\s+run\s+([A-Za-z0-9:_-]+)/g)) {
			if (m[1]) used.add(m[1]);
		}
		const missing = [...used].filter((n) => !names.has(n));
		if (missing.length > 0) fail_(`doc references missing npm scripts: ${missing.join(", ")}`);
		else ok();
	}

	// 4. Makefile targets referenced must exist
	if (await fileExists(join(cwd, "Makefile"))) {
		const mk = (await readText(join(cwd, "Makefile"))) ?? "";
		const used = new Set<string>();
		for (const m of doc.matchAll(/\bmake\s+([A-Za-z0-9_-]+)/g)) {
			if (m[1]) used.add(m[1]);
		}
		const missing = [...used].filter((t) => !new RegExp(`^${t}:`, "m").test(mk));
		if (missing.length > 0) fail_(`doc references missing make targets: ${missing.join(", ")}`);
		else ok();
	}

	// 5. Backtick relative paths referenced should exist (heuristic)
	const paths = new Set<string>();
	for (const m of doc.matchAll(/`([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*)`/g)) {
		if (m[1]) paths.add(m[1]);
	}
	let checked = 0;
	const bad: string[] = [];
	for (const p of [...paths].slice(0, 30)) {
		if (p.includes("...") || p.startsWith("http")) continue;
		checked++;
		if (!(await fileExists(join(cwd, p)))) bad.push(p);
	}
	if (bad.length > 0) warn_(`doc references missing paths: ${bad.join(", ")}`);
	else if (checked > 0) ok();

	lines.push(`result: PASS=${pass} WARN=${warn} FAIL=${fail}`);
	return { pass, warn, fail, lines, ok: fail === 0 };
}

/** Backup the current doc to a timestamped dir, returning the backup path. */
export function backupDoc(cwd: string, ts: number): string | undefined {
	const src = `${cwd}/${CONTEXT_FILE}`;
	if (!existsSync(src)) return undefined;
	const dir = `${cwd}/${BACKUP_DIR}/evolve-${ts}`;
	try {
		mkdirSync(dir, { recursive: true });
		copyFileSync(src, `${dir}/project-context.md`);
		return `${dir}/project-context.md`;
	} catch {
		return undefined;
	}
}

/** Restore the doc from a backup path. */
export function restoreDoc(cwd: string, backupPath: string): boolean {
	try {
		copyFileSync(backupPath, `${cwd}/${CONTEXT_FILE}`);
		return true;
	} catch {
		return false;
	}
}
