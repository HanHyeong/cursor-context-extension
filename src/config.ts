/**
 * cursor-context — configuration constants and shared types.
 *
 * Machine-generated data lives in `.cursor-context/` at the project root
 * (outside `.pi/`), mirroring the original toolkit's separation of code
 * (`.claude/` / `.pi/`) from data. This keeps zero-touch writes possible:
 * pi protects `.pi/` writes, so storing runtime data there would require
 * an approval for every automatic update.
 *
 * Shared vs harness-scoped data layout (for coexistence with the original
 * Claude Code bash toolkit in the same project):
 *   .cursor-context/
 *     project-context.md       SHARED  — both harnesses read/write it
 *     backup/                   SHARED  — timestamped dirs, no collision
 *     harness-pi/              pi-only logs (this extension)
 *     metrics.jsonl            Claude Code-only (left untouched at root)
 *     context-feedback.jsonl   Claude Code-only
 *     evolve-log.jsonl         Claude Code-only
 *     evolve-proposals.md      Claude Code-only
 * The doc shares because it describes the project (harness-agnostic) and the
 * marker/fingerprint format is identical across harnesses. The logs are scoped
 * because they measure *this harness's* usage; sharing them would double-count
 * toward the evolve threshold and let one harness's `consumeSignals` wipe the
 * other's accumulated data.
 */

/** Directory holding machine-generated context data (relative to cwd). */
export const CONTEXT_DIR = ".cursor-context";

/**
 * Identifier of the harness writing the logs. This extension always runs
 * inside pi, so it is fixed to "pi". The original Claude Code bash toolkit
 * keeps writing to the legacy root paths (no `harness-*` segment), so the two
 * never collide. Overridable via env only for tests.
 */
export const HARNESS = process.env.CURSOR_CONTEXT_HARNESS_OVERRIDE ?? "pi";

/** Subdirectory holding this harness's scoping logs (relative to cwd). */
export const HARNESS_DIR = `${CONTEXT_DIR}/harness-${HARNESS}`;

/** The auto-generated project context document. SHARED across harnesses. */
export const CONTEXT_FILE = `${CONTEXT_DIR}/project-context.md`;

/** Metrics log: tool usage signals (deterministic, zero-token measurement). */
export const METRICS_FILE = `${HARNESS_DIR}/metrics.jsonl`;

/** Feedback log: session reflections (wrong/gap entries). */
export const FEEDBACK_FILE = `${HARNESS_DIR}/context-feedback.jsonl`;

/** Evolution history log. */
export const EVOLVE_LOG_FILE = `${HARNESS_DIR}/evolve-log.jsonl`;

/** Code-layer improvement proposals (human-applied). */
export const PROPOSALS_FILE = `${HARNESS_DIR}/evolve-proposals.md`;

/** Backup directory for evolve/refresh rollbacks. SHARED across harnesses. */
export const BACKUP_DIR = `${CONTEXT_DIR}/backup`;

/**
 * Legacy root log paths used by the Claude Code bash toolkit. Used by the
 * one-time migration: if a root log exists *and* no harness-scoped copy does
 * yet, move it under `harness-pi/` so prior signal isn't lost on first run.
 * These are NOT used for new writes — pi always writes under HARNESS_DIR.
 */
export const LEGACY_ROOT_METRICS = `${CONTEXT_DIR}/metrics.jsonl`;
export const LEGACY_ROOT_FEEDBACK = `${CONTEXT_DIR}/context-feedback.jsonl`;

/** Max body lines of the doc to inject (markers stripped before counting). */
export const MAX_CTX_LINES = 250;

/** Target body line budget for the doc (soft); injection hard cap is above. */
export const TARGET_BODY_LINES = 200;

/** Max lines of the directory tree in the snapshot. */
export const MAX_TREE_LINES = 60;

/** Max recent commits to show in the snapshot. */
export const MAX_COMMITS = 5;

/** Max changed files to show in the snapshot. */
export const MAX_CHANGED = 20;

/** Commit backstop: force a refresh after this many commits since generation. */
export const COMMIT_BACKSTOP = 20;

/** Evolve gate thresholds. */
export const EVOLVE_FEEDBACK_THRESHOLD = 5;
export const EVOLVE_METRICS_THRESHOLD = 300;

/** Metrics log rotation: keep last this many lines when exceeding the cap. */
export const METRICS_ROTATE_AT = 2000;
export const METRICS_KEEP_AFTER_ROTATE = 1000;

/** Marker strings embedded in the doc header. */
export const MARKER_GENERATED_AT = "generated-at-commit:";
export const MARKER_FP_BEGIN = "context-fingerprint-begin";
export const MARKER_FP_END = "context-fingerprint-end";

/** Structural files whose content changes warrant a doc refresh. */
export const STRUCTURAL_FILES: readonly string[] = [
	"package.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"package-lock.json",
	"bun.lockb",
	"bun.lock",
	"pyproject.toml",
	"setup.py",
	"setup.cfg",
	"requirements.txt",
	"requirements-dev.txt",
	"go.mod",
	"go.sum",
	"Cargo.toml",
	"Cargo.lock",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"settings.gradle",
	"settings.gradle.kts",
	"Gemfile",
	"Gemfile.lock",
	"composer.json",
	"Dockerfile",
	"docker-compose.yml",
	"docker-compose.yaml",
	"compose.yaml",
	"Makefile",
	"tsconfig.json",
	"tsconfig.base.json",
];

/** Frameworks to detect in package.json (substring match on the manifest). */
export const FRAMEWORKS: readonly string[] = [
	"react",
	"next",
	"vue",
	"nuxt",
	"svelte",
	"@angular/core",
	"express",
	"fastify",
	"nestjs",
	"vite",
];

/** A single fingerprint entry: hash + structural-file/dir name. */
export interface FingerprintEntry {
	readonly hash: string;
	readonly name: string;
}

/**
 * Move any legacy root-level logs produced by the Claude Code bash toolkit
 * into this harness's scoped directory. Idempotent: only moves when the root
 * file exists and the scoped target does not, so a coexisting Claude Code
 * session that still writes to the root will not be disturbed by a second pi
 * migration run (the root file is left for Claude Code if pi already has its
 * own copy). Called once at session_start.
 */
export async function migrateLegacyLogs(cwd: string): Promise<void> {
	const { renameSync, existsSync, mkdirSync } = await import("node:fs");
	const { join } = await import("node:path");
	const scopedDir = join(cwd, HARNESS_DIR);
	try {
		mkdirSync(scopedDir, { recursive: true });
	} catch {
		return;
	}
	const pairs: Array<[string, string]> = [
		[join(cwd, LEGACY_ROOT_METRICS), join(cwd, METRICS_FILE)],
		[join(cwd, LEGACY_ROOT_FEEDBACK), join(cwd, FEEDBACK_FILE)],
	];
	for (const [src, dst] of pairs) {
		try {
			if (existsSync(src) && !existsSync(dst)) {
				// renameSync may fail across devices / if Claude Code holds a
				// write handle on macOS. Fall back to copy+truncate.
				try {
					renameSync(src, dst);
				} catch {
					const { readFileSync, writeFileSync, unlinkSync } = await import("node:fs");
					const buf = readFileSync(src);
					writeFileSync(dst, buf);
					unlinkSync(src);
				}
			}
		} catch {
			// best-effort; never let migration disrupt the session
		}
	}
}

/** Freshness verdict for the context doc. */
export type FreshnessVerdict =
	| { kind: "fresh" }
	| { kind: "stale"; changed: readonly string[] }
	| { kind: "unverifiable"; reason: string }
	| { kind: "no-doc" };

/** Options controlling extension behavior (read from env for power users). */
export interface ExtensionOptions {
	/** Disable the metrics collector (PostToolUse logging). */
	readonly metricsDisabled: boolean;
	/** Disable the evolve gate. */
	readonly evolveDisabled: boolean;
	/** Disable auto-onboarding (doc generation on first substantive task). */
	readonly onboardDisabled: boolean;
}

export function loadOptions(): ExtensionOptions {
	const env = process.env;
	return {
		metricsDisabled: env.CURSOR_CONTEXT_NO_METRICS === "1",
		evolveDisabled: env.CURSOR_CONTEXT_NO_EVOLVE === "1",
		onboardDisabled: env.CURSOR_CONTEXT_NO_ONBOARD === "1",
	};
}
