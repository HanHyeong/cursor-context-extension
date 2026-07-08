/**
 * Project snapshot builder.
 *
 * Produces the compact session-start context block: detected stack,
 * directory tree (depth 2), git state, and branch-intent diff --stat.
 *
 * The original bash hook emitted this as stdout to Claude Code's hook
 * injection. Here we return a string that `before_agent_start` injects as a
 * system-prompt appendix, or that a tool returns. Keeping it a pure
 * function makes it unit-testable and reusable across hooks and commands.
 */

import {
	MAX_CHANGED,
	MAX_COMMITS,
	MAX_TREE_LINES,
	CONTEXT_FILE,
	MARKER_FP_BEGIN,
	MARKER_FP_END,
	MARKER_GENERATED_AT,
} from "./config.js";
import {
	currentBranch,
	shortHead,
	recentCommits,
	porcelainStatus,
	diffStatVs,
	defaultBranch,
	diffBase,
	directoryTree,
	npmScripts,
	isGitRepo,
} from "./git.js";

/** Lines describing the detected tech stack. */
async function detectStack(cwd: string): Promise<readonly string[]> {
	const out: string[] = [];
	const { fileExists } = await import("./git.js");
	const has = (f: string) => fileExists(`${cwd}/${f}`);

	if (await has("package.json")) {
		out.push("- Node.js project (package.json)");
		if (await has("pnpm-lock.yaml")) out.push("  - package manager: pnpm");
		if (await has("yarn.lock")) out.push("  - package manager: yarn");
		if (await has("package-lock.json")) out.push("  - package manager: npm");
		if ((await has("bun.lockb")) || (await has("bun.lock"))) out.push("  - package manager: bun");
		// Framework detection: match manifest keys, not bare substrings, so that
		// `next` does not collide with `next-auth`. Fixed from the bash version.
		const pkg = (await import("./git.js").then((m) => m.readText(`${cwd}/package.json`))) ?? "";
		for (const fw of ["react", "next", "vue", "nuxt", "svelte", "@angular/core", "express", "fastify", "nestjs", "vite"]) {
			if (new RegExp(`"${fw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`).test(pkg)) {
				out.push(`  - framework/tool: ${fw}`);
			}
		}
		const scripts = await npmScripts(cwd);
		if (scripts.length > 0) {
			out.push("  - available scripts:");
			for (const [k, v] of scripts.slice(0, 15)) {
				out.push(`    - npm run ${k}: ${v}`);
			}
		}
	}

	const checks: readonly [string, string][] = [
		["pyproject.toml", "- Python project (pyproject.toml)"],
		["requirements.txt", "- Python project (requirements.txt)"],
		["go.mod", "- Go project (go.mod)"],
		["Cargo.toml", "- Rust project (Cargo.toml)"],
		["pom.xml", "- Java/Maven project"],
		["Gemfile", "- Ruby project (Gemfile)"],
		["composer.json", "- PHP project (composer.json)"],
		["Dockerfile", "- Dockerfile present"],
	];
	for (const [f, label] of checks) {
		if (await has(f)) out.push(label);
	}
	if ((await has("docker-compose.yml")) || (await has("docker-compose.yaml")) || (await has("compose.yaml"))) {
		out.push("- Docker Compose config present");
	}
	const { fileExists: fe } = await import("./git.js");
	if (await fe(`${cwd}/.github/workflows`)) {
		out.push("- GitHub Actions CI config present");
	}

	if (out.length === 0) out.push("- No known manifest files (manual exploration needed)");
	return out;
}

/**
 * Build the full project-context snapshot block.
 *
 * @param cwd working directory
 * @param docBody optional already-stripped doc body to append (markers removed)
 */
export async function buildSnapshot(cwd: string, docBody?: string): Promise<string> {
	const L: string[] = [];
	L.push("<project-context-snapshot>");
	L.push(
		"Auto-generated project snapshot. Use it as a starting point for understanding project context and interpreting terse requests.",
	);
	L.push(
		"Priority rules: (1) This snapshot and the context doc are auxiliary — when they differ from actual code, actual code always wins. (2) When they overlap or conflict with user instructions (CLAUDE.md / AGENTS.md), user instructions always win.",
	);
	L.push("");

	// 1. Stack
	L.push("## Tech stack");
	for (const line of await detectStack(cwd)) L.push(line);
	L.push("");

	// 2. Directory tree
	L.push(`## Directory structure (depth 2, tracked files)`);
	const tree = await directoryTree(cwd, MAX_TREE_LINES);
	for (const l of tree.lines) L.push(`- ${l}`);
	L.push(`(total tracked files: ${tree.total})`);
	L.push("");

	// 3. Git state
	if (await isGitRepo(cwd)) {
		L.push("## Git state");
		const branch = await currentBranch(cwd);
		L.push(`- current branch: ${branch ?? `detached HEAD (${(await shortHead(cwd)) ?? "?"})`}`);
		L.push("- recent commits:");
		for (const c of await recentCommits(cwd, MAX_COMMITS)) L.push(`  - ${c}`);
		const changed = await porcelainStatus(cwd, MAX_CHANGED);
		if (changed.length > 0) {
			L.push("- uncommitted changes:");
			for (const c of changed) L.push(`  - ${c}`);
		} else {
			L.push("- working tree clean");
		}

		// Branch-intent: diff --stat of this branch vs the default branch.
		const db = await defaultBranch(cwd);
		if (db && branch && branch !== db) {
			const base = await diffBase(cwd, db);
			if (base) {
				const ds = await diffStatVs(cwd, base);
				if (ds) {
					L.push(`- cumulative work on this branch vs ${base} (helps interpret terse requests like "continue"):`);
					const lines = ds.split("\n");
					if (lines.length > 12) {
						for (const l of lines.slice(0, 10)) L.push(`  ${l}`);
						L.push("  (…truncated…)");
						L.push(`  ${lines[lines.length - 1]}`);
					} else {
						for (const l of lines) L.push(`  ${l}`);
					}
				}
			}
		}
		L.push("");
	}

	// 4. Context doc body (already marker-stripped by caller)
	if (docBody && docBody.trim()) {
		L.push(`### Auto-generated project doc (${CONTEXT_FILE})`);
		L.push(docBody.trimEnd());
		L.push("");
	}

	L.push("</project-context-snapshot>");
	return L.join("\n");
}

/** A freshness-alert block for per-prompt injection when the doc is stale. */
export function buildFreshnessAlert(changed: readonly string[]): string {
	const L: string[] = ["<context-freshness-alert>"];
	L.push(
		"The project's structural state differs from the context doc's generation point (live working-tree comparison). Changed items:",
	);
	for (const c of changed) L.push(`- ${c}`);
	L.push(
		"Do not trust doc sections related to these items (commands, stack, structure) during this request — verify against actual files. After finishing the user's request, silently refresh the affected doc sections using the context-refresh skill. Skip refresh in read-only or print sessions. Never modify CLAUDE.md / AGENTS.md.",
	);
	L.push("</context-freshness-alert>");
	return L.join("\n");
}

/** Marker header to embed at the top of a freshly generated/refreshed doc. */
export function docHeader(headSha: string, fingerprintBlock: string): string {
	return [
		`<!-- ${MARKER_GENERATED_AT} ${headSha} -->`,
		`<!-- ${fingerprintBlock} -->`,
		"<!-- This file is auto-generated by cursor-context. You may edit it by hand, but the next auto-refresh may overwrite it. Put durable instructions in CLAUDE.md / AGENTS.md. -->",
	].join("\n");
}
