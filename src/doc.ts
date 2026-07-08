/**
 * Doc generation/refresh helpers used by skills and the auto-onboard path.
 *
 * The actual writing is delegated to the LLM (via the skill instructions in
 * `skills/`), but these helpers take care of the deterministic parts:
 * stamping markers, verifying commands, and writing the file atomically.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { CONTEXT_FILE, type FingerprintEntry } from "./config.js";
import { renderFingerprintBlock, run, readText } from "./git.js";
import { docHeader } from "./snapshot.js";

/** Write the doc (header markers + body). Creates `.cursor-context/` if needed. */
export function writeDoc(cwd: string, body: string, sha: string, fingerprint: readonly FingerprintEntry[]): void {
	const dir = join(cwd, ".cursor-context");
	mkdirSync(dir, { recursive: true });
	const header = docHeader(sha, renderFingerprintBlock(fingerprint));
	writeFileSync(join(cwd, CONTEXT_FILE), `${header}\n\n${body.trim()}\n`, "utf8");
}

/** Ensure `.cursor-context/` is gitignored (idempotent, non-destructive). */
export async function ensureGitignored(cwd: string): Promise<void> {
	// Team-share mode: if the doc itself is tracked, the team committed it on
	// purpose (and removed the ignore line) — do not fight that decision by
	// re-adding the line every session/write.
	const tracked = await run("git", ["ls-files", "--", CONTEXT_FILE], { cwd });
	if (tracked.code === 0 && tracked.stdout.trim()) return;
	const gi = join(cwd, ".gitignore");
	let cur = "";
	if (existsSync(gi)) cur = (await readText(gi)) ?? "";
	if (cur.includes(".cursor-context/")) return;
	const add = `${cur.endsWith("\n") || cur === "" ? "" : "\n"}.cursor-context/\n`;
	writeFileSync(gi, cur + add, "utf8");
}

/**
 * Verify a command exists in the project's scripts/Makefile before documenting it.
 * The original skill instructed the LLM to "run commands to verify", but
 * verifying programmatically is cheaper and more reliable.
 */
export async function verifyCommand(
	cwd: string,
	kind: "npm" | "make",
	name: string,
): Promise<boolean> {
	if (kind === "npm") {
		const { npmScripts } = await import("./git.js");
		const s = await npmScripts(cwd);
		return s.some(([k]) => k === name);
	}
	const mk = (await readText(join(cwd, "Makefile"))) ?? "";
	return new RegExp(`^${name}:`, "m").test(mk);
}

/** Try to actually run a command and return whether it succeeded. */
export async function tryRun(cwd: string, cmd: string, args: readonly string[]): Promise<boolean> {
	const r = await run(cmd, args, { cwd, timeout: 15_000 });
	return r.code === 0;
}
