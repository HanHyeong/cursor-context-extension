/**
 * Native git/fs helpers (single source of truth).
 *
 * The original bash toolkit spawned `git`, `git ls-files`, and `sha256sum` as
 * shell commands and re-implemented the fingerprint logic in multiple places.
 * In the pi extension we centralize all filesystem/git/hashing logic here as
 * typed async functions. Hooks and skills call these, never re-deriving the
 * fingerprint algorithm (drift between call sites was a real risk in bash).
 *
 * All functions are process-free: they return data, never print. Failures
 * resolve to empty/false rather than throwing — mirrors the original's
 * "exit 0 on every path" safety guarantee, but via typed optionals.
 */

import { createHash } from "node:crypto";
import { readFile, access, readdir, stat } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { join, relative } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import {
	CONTEXT_DIR,
	STRUCTURAL_FILES,
	MARKER_FP_BEGIN,
	MARKER_FP_END,
	MARKER_GENERATED_AT,
	type FingerprintEntry,
	type FreshnessVerdict,
} from "./config.js";

const execAsync = promisify(exec);

/** Default timeout for git commands (ms). Generous enough for 50k-file monorepos. */
const GIT_TIMEOUT = 10_000;

export interface ExecResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
}

/** Run a command, capturing output. Never throws; returns exit code. */
export async function run(
	command: string,
	args: readonly string[],
	opts: { cwd: string; timeout?: number; env?: NodeJS.ProcessEnv } = { cwd: process.cwd() },
): Promise<ExecResult> {
	const { cwd, timeout = GIT_TIMEOUT, env } = opts;
	try {
		const { stdout, stderr } = await execAsync(`${command} ${args.map(shellQuote).join(" ")}`, {
			cwd,
			timeout,
			env: env ?? process.env,
			maxBuffer: 20 * 1024 * 1024,
		});
		return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string; code?: number | string; signal?: string };
		const code = typeof e.code === "number" ? e.code : e.signal === "SIGTERM" ? 124 : 1;
		return { stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "", code };
	}
}

function shellQuote(s: string): string {
	if (/^[\w./:@=-]+$/.test(s)) return s;
	return `"${s.replace(/(["$`\\])/g, "\\$1")}"`;
}

/** Whether cwd is inside a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
	const r = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
	return r.code === 0 && r.stdout.trim() === "true";
}

/** Current branch name, or undefined for detached HEAD. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
	const r = await run("git", ["branch", "--show-current"], { cwd });
	if (r.code !== 0) return undefined;
	const b = r.stdout.trim();
	return b || undefined;
}

/** Short HEAD sha when on detached HEAD. */
export async function shortHead(cwd: string): Promise<string | undefined> {
	const r = await run("git", ["rev-parse", "--short", "HEAD"], { cwd });
	if (r.code !== 0) return undefined;
	return r.stdout.trim() || undefined;
}

/** Full HEAD sha. */
export async function headSha(cwd: string): Promise<string | undefined> {
	const r = await run("git", ["rev-parse", "HEAD"], { cwd });
	if (r.code !== 0) return undefined;
	return r.stdout.trim() || undefined;
}

/** `git log --oneline -n`, one line per entry. */
export async function recentCommits(cwd: string, n: number): Promise<readonly string[]> {
	const r = await run("git", ["log", `--oneline`, `-n`, String(n)], { cwd });
	if (r.code !== 0) return [];
	return r.stdout.split("\n").filter(Boolean);
}

/** `git status --porcelain` lines (already limited to max). */
export async function porcelainStatus(cwd: string, max: number): Promise<readonly string[]> {
	const r = await run("git", ["status", "--porcelain"], { cwd });
	if (r.code !== 0) return [];
	return r.stdout.split("\n").filter(Boolean).slice(0, max);
}

/** Files tracked by git. */
export async function lsFiles(cwd: string): Promise<readonly string[]> {
	const r = await run("git", ["ls-files"], { cwd });
	if (r.code !== 0) return [];
	return r.stdout.split("\n").filter(Boolean);
}

/** Files tracked + untracked-but-not-ignored (for directory-structure hash). */
export async function lsAllFiles(cwd: string): Promise<readonly string[]> {
	const r = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd });
	if (r.code !== 0) return [];
	return r.stdout.split("\n").filter(Boolean);
}

/** `git diff --stat base...HEAD` output (the branch-intent signal). */
export async function diffStatVs(cwd: string, base: string): Promise<string | undefined> {
	const r = await run("git", ["diff", "--stat", `${base}...HEAD`], { cwd });
	if (r.code !== 0) return undefined;
	const out = r.stdout;
	return out.trim() || undefined;
}

/** Resolve the default branch (origin/HEAD, else main, else master). */
export async function defaultBranch(cwd: string): Promise<string | undefined> {
	const sym = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd });
	if (sym.code === 0) {
		const b = sym.stdout.trim().replace(/^origin\//, "");
		if (b) return b;
	}
	for (const cand of ["main", "master"]) {
		const has = await run("git", ["show-ref", "--verify", "-q", `refs/remotes/origin/${cand}`], { cwd });
		if (has.code === 0) return cand;
		const hasLocal = await run("git", ["show-ref", "--verify", "-q", `refs/heads/${cand}`], { cwd });
		if (hasLocal.code === 0) return cand;
	}
	return undefined;
}

/** Resolve `base` for diffing: prefer origin/<db>, fall back to local <db>. */
export async function diffBase(cwd: string, db: string): Promise<string | undefined> {
	const hasRemote = await run("git", ["show-ref", "--verify", "-q", `refs/remotes/origin/${db}`], { cwd });
	if (hasRemote.code === 0) return `origin/${db}`;
	const hasLocal = await run("git", ["show-ref", "--verify", "-q", `refs/heads/${db}`], { cwd });
	if (hasLocal.code === 0) return db;
	return undefined;
}

/** Whether a commit object exists (for marker validation after rebase/squash). */
export async function commitExists(cwd: string, sha: string): Promise<boolean> {
	const r = await run("git", ["cat-file", "-e", sha], { cwd });
	return r.code === 0;
}

/** Count commits since a given sha. Returns 0 on any failure. */
export async function commitsSince(cwd: string, sha: string): Promise<number> {
	const r = await run("git", ["rev-list", "--count", `${sha}..HEAD`], { cwd });
	if (r.code !== 0) return 0;
	const n = Number.parseInt(r.stdout.trim(), 10);
	return Number.isFinite(n) ? n : 0;
}

/** `git diff --stat <sha>..HEAD` (for incremental refresh analysis). */
export async function diffStatSince(cwd: string, sha: string): Promise<string | undefined> {
	const r = await run("git", ["diff", "--stat", `${sha}..HEAD`], { cwd });
	if (r.code !== 0) return undefined;
	return r.stdout.trim() || undefined;
}

/** Read a file as utf-8, return undefined if missing/unreadable. */
export async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Does a path exist? */
export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, FS.F_OK);
		return true;
	} catch {
		return false;
	}
}

/** SHA-256 of a file's contents, or undefined if unreadable. */
export async function hashFile(absPath: string): Promise<string | undefined> {
	const buf = await readFile(absPath).catch(() => null);
	if (!buf) return undefined;
	return createHash("sha256").update(buf).digest("hex");
}

/** SHA-256 of an arbitrary string. */
export function hashString(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Compute the structural fingerprint of the working tree.
 *
 * Mirrors the original `emit_fingerprint`: content hashes of structural
 * manifest/build/CI files plus a directory-structure hash (depth-1 dirs and
 * depth-2 dirs that contain depth-3+ files). Untracked scratch files inside
 * an *existing* directory do not change the dir hash — only structural files
 * and new top-level directories do.
 *
 * Returns entries sorted by name (stable, comparable as a set).
 */
export async function computeFingerprint(cwd: string): Promise<readonly FingerprintEntry[]> {
	const entries: FingerprintEntry[] = [];

	// Structural files: hash actual working-tree contents (includes uncommitted).
	for (const f of STRUCTURAL_FILES) {
		const abs = join(cwd, f);
		const h = await hashFile(abs);
		if (h) entries.push({ hash: h, name: f });
	}

	// CI workflow files.
	const wfDir = join(cwd, ".github", "workflows");
	try {
		const stats = await readdir(wfDir, { withFileTypes: true });
		const wfs = stats
			.filter((d) => d.isFile() && (d.name.endsWith(".yml") || d.name.endsWith(".yaml")))
			.map((d) => d.name)
			.sort();
		for (const wf of wfs) {
			const abs = join(wfDir, wf);
			const h = await hashFile(abs);
			if (h) entries.push({ hash: h, name: `.github/workflows/${wf}` });
		}
	} catch {
		// no CI dir
	}

	// Directory-structure hash: depth-1 dirs + depth-2 dirs that have depth-3+ files.
	// git ls-files always emits "/" separators regardless of platform, so split
	// on "/" (not path.sep — on Windows that would treat every path as depth-1
	// and turn the hash into a full-file-list hash, causing false stale alarms).
	if (await isGitRepo(cwd)) {
		const [tracked, files] = await Promise.all([lsFiles(cwd), lsAllFiles(cwd)]);
		const trackedSet = new Set(tracked);
		const dirs = new Set<string>();
		for (const f of files) {
			const parts = f.split("/");
			// Exclude UNTRACKED files under the context dir: before it is
			// gitignored (first generation, or metrics arriving ahead of the
			// doc) they are untracked-but-not-ignored, so including them would
			// make the doc invalidate its own fingerprint the moment it (or
			// the gitignore entry) is created. TRACKED files under it (team-
			// share mode commits the doc) stay included: they are stable and
			// the coexisting bash toolkit sees them too, keeping the hashes
			// comparable across harnesses.
			if (parts[0] === CONTEXT_DIR && !trackedSet.has(f)) continue;
			if (parts.length >= 2) dirs.add(parts[0]!);
			if (parts.length >= 3) dirs.add(`${parts[0]}/${parts[1]}`);
		}
		const sorted = [...dirs].sort();
		entries.push({ hash: hashString(sorted.join("\n")), name: "directory-structure" });
	}

	return entries.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Render fingerprint entries as the doc marker block text. */
export function renderFingerprintBlock(entries: readonly FingerprintEntry[]): string {
	const lines = entries.map((e) => `${e.hash}  ${e.name}`).join("\n");
	return `${MARKER_FP_BEGIN}\n${lines}\n${MARKER_FP_END}`;
}

/**
 * Extract stored fingerprint entries from a doc's marker block.
 * Returns [] when no valid marker block is present.
 */
export function parseStoredFingerprint(doc: string): readonly FingerprintEntry[] {
	const lines: string[] = [];
	let inBlock = false;
	for (const raw of doc.split(/\r?\n/)) {
		if (raw.includes(MARKER_FP_BEGIN)) {
			inBlock = true;
			continue;
		}
		if (raw.includes(MARKER_FP_END)) {
			inBlock = false;
			continue;
		}
		if (inBlock) {
			const m = /^([0-9a-f]{64})\s{2,}\s*(\S.*)$/.exec(raw);
			if (m) lines.push(JSON.stringify({ hash: m[1], name: m[2] }));
		}
	}
	if (lines.length === 0) return [];
	try {
		return lines.map((l) => JSON.parse(l) as FingerprintEntry);
	} catch {
		return [];
	}
}

/**
 * Compare stored vs current fingerprint and return the names that differ.
 * Empty = identical (or no markers — handled by the verdict below).
 */
export function diffFingerprints(
	stored: readonly FingerprintEntry[],
	current: readonly FingerprintEntry[],
): readonly string[] {
	const storedMap = new Map(stored.map((e) => [e.name, e.hash]));
	const currentMap = new Map(current.map((e) => [e.name, e.hash]));
	const names = new Set<string>([...storedMap.keys(), ...currentMap.keys()]);
	const changed: string[] = [];
	for (const n of names) {
		if (storedMap.get(n) !== currentMap.get(n)) changed.push(n);
	}
	return changed.toSorted((a, b) => a.localeCompare(b));
}

/**
 * Freshness verdict for a doc against the live working tree.
 * This is the single source of truth used by both the session-start hook and
 * the per-prompt freshness check.
 */
export async function freshnessVerdict(cwd: string, docPath: string): Promise<FreshnessVerdict> {
	const doc = await readText(docPath);
	if (!doc) return { kind: "no-doc" };
	const stored = parseStoredFingerprint(doc);
	if (stored.length === 0) {
		return { kind: "unverifiable", reason: "fingerprint markers absent" };
	}
	const current = await computeFingerprint(cwd);
	if (current.length === 0) {
		return { kind: "unverifiable", reason: "no structural files in working tree" };
	}
	const changed = diffFingerprints(stored, current);
	if (changed.length === 0) return { kind: "fresh" };
	return { kind: "stale", changed };
}

/** Extract the generated-at-commit sha from a doc, or undefined. */
export function parseGeneratedAt(doc: string): string | undefined {
	const m = new RegExp(`${MARKER_GENERATED_AT}\\s*([0-9a-f]{7,40})`).exec(doc);
	return m?.[1];
}

/** Strip marker/noise lines from a doc body for injection (hashes + HTML comments). */
export function stripMarkers(doc: string): string {
	return doc
		.split(/\r?\n/)
		.filter((l) => !/^\s*<!--/.test(l) && !/^[0-9a-f]{64}\s{2,}/.test(l) && !l.includes(MARKER_FP_END))
		.join("\n");
}

/** Count non-marker body lines of a doc. */
export function bodyLineCount(doc: string): number {
	return stripMarkers(doc).split("\n").filter(Boolean).length;
}

/**
 * Build the directory tree snapshot (depth 2, git-tracked files).
 * Falls back to a shallow `find` when not a git repo.
 */
export async function directoryTree(cwd: string, maxLines: number): Promise<{ lines: readonly string[]; total: number }> {
	if (await isGitRepo(cwd)) {
		const files = await lsFiles(cwd);
		const dirs = new Set<string>();
		for (const f of files) {
			// git ls-files emits "/" on every platform — do not use path.sep.
			const parts = f.split("/");
			if (parts.length === 1) dirs.add(parts[0]!);
			else dirs.add(`${parts[0]}/${parts[1]}${parts.length > 2 ? "/…" : ""}`);
		}
		const sorted = [...dirs].sort();
		return { lines: sorted.slice(0, maxLines), total: files.length };
	}
	// Non-git fallback: shallow find, skipping common heavy dirs.
	const skip = ["node_modules", ".git", ".venv", "dist", "build", ".pi", ".cursor-context"];
	const out: string[] = [];
	try {
		const stats = await readdir(cwd, { withFileTypes: true });
		for (const d of stats.sort((a, b) => a.name.localeCompare(b.name))) {
			if (skip.includes(d.name)) continue;
			out.push(d.name);
			if (d.isDirectory()) {
				try {
					const sub = await readdir(join(cwd, d.name), { withFileTypes: true });
					for (const s of sub.sort((a, b) => a.name.localeCompare(b.name))) {
						out.push(`${d.name}/${s.name}`);
						if (out.length >= maxLines) break;
					}
				} catch {
					// permission, etc.
				}
			}
			if (out.length >= maxLines) break;
		}
	} catch {
		// cwd unreadable
	}
	return { lines: out.slice(0, maxLines), total: out.length };
}

/** Read package.json#scripts as [name, script][] (best-effort, JSON parse). */
export async function npmScripts(cwd: string): Promise<readonly [string, string][]> {
	const pkg = await readText(join(cwd, "package.json"));
	if (!pkg) return [];
	try {
		const j = JSON.parse(pkg) as { scripts?: Record<string, string> };
		return Object.entries(j.scripts ?? {});
	} catch {
		return [];
	}
}

/** Async stat-based existence check (catches broken symlinks safely). */
export async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Whether a path is writable (single source for the trigger gates). */
export async function isWritable(path: string): Promise<boolean> {
	try {
		await access(path, FS.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** Relative-to-cwd path of a project file, normalized. */
export function relPath(cwd: string, abs: string): string {
	const r = relative(cwd, abs);
	return r || abs;
}
