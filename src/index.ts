/**
 * The main extension: cursor-context for pi.
 *
 * Recreates the cursor-context toolkit (originally Claude Code hooks+skills)
 * as a single pi extension + 3 skills. Hooks become event handlers; skills
 * remain markdown-driven progressive-disclosure units discovered via
 * `resources_discover`.
 *
 * Lifecycle mapping:
 *   Claude Code SessionStart  → pi `session_start`
 *   Claude Code UserPromptSubmit → pi `before_agent_start`
 *   Claude Code PostToolUse   → pi `tool_execution_end`
 *   Claude Code Stop (evolve gate) → pi `agent_end`
 *
 * Key architectural improvements over the bash version:
 *   1. Single in-process fingerprint source (src/git.ts). The bash version
 *      re-implemented comparison in 3 places.
 *   2. Metrics collection is in-process (no python3 spawn per tool call).
 *   3. Evolve gate checks ctx.mode + cwd writeability instead of relying on
 *      model compliance to skip in plan/read-only sessions.
 *   4. Framework detection uses key matching, fixing the `next` vs
 *      `next-auth` false positive in the bash version.
 *   5. Directory-structure hash considers only git-tracked + non-ignored
 *      files (already fixed in the original, preserved here).
 *   6. No exit-code-3 magic numbers — typed FreshnessVerdict discriminated
 *      union makes "unverifiable" an honest first-class state.
 */

import { join } from "node:path";
import { access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
// StringEnum (from @earendil-works/pi-ai) is the Google-compatible enum helper.
// We use Type.Union/Type.Literal for the feedback tool's `type` param here;
// swap to StringEnum(["wrong","gap"]) if Google model compatibility is needed.

import {
	CONTEXT_FILE,
	METRICS_FILE,
	FEEDBACK_FILE,
	CONTEXT_DIR,
	HARNESS_DIR,
	MAX_CTX_LINES,
	COMMIT_BACKSTOP,
	MARKER_GENERATED_AT,
	loadOptions,
	migrateLegacyLogs,
	type ExtensionOptions,
} from "./config.js";
import {
	freshnessVerdict,
	stripMarkers,
	bodyLineCount,
	computeFingerprint,
	parseStoredFingerprint,
	diffFingerprints,
	parseGeneratedAt,
	headSha,
	commitExists,
	commitsSince,
	readText,
	isGitRepo,
	currentBranch,
	shortHead,
	recentCommits,
	porcelainStatus,
	defaultBranch,
	diffBase,
	diffStatVs,
	directoryTree,
	npmScripts,
	fileExists,
} from "./git.js";
import { buildSnapshot, buildFreshnessAlert } from "./snapshot.js";
import { appendMetric, appendFeedback, appendEvolveLog, signalCounts, evolveThresholdCrossed, consumeSignals } from "./metrics.js";
import { benchmark, backupDoc, restoreDoc } from "./benchmark.js";
import { writeDoc, ensureGitignored, readDocBody } from "./doc.js";

const extDir = dirname(fileURLToPath(import.meta.url));

/** Persistent injected instruction appended to the system prompt every turn. */
const STANDING_INSTRUCTIONS = `
## cursor-context standing rules

These rules persist across turns. The context doc and snapshot are auxiliary
knowledge; they are never authoritative over actual code or user instructions
(CLAUDE.md / AGENTS.md / settings).

- **Micro-refresh**: If, during this session's work, you find the auto-generated
  doc (.cursor-context/project-context.md) disagrees with actual code, fix the
  affected section silently after finishing the user's request and re-stamp the
  markers (generated-at-commit + fingerprint block). If you find no
  discrepancy, do nothing.
- **Feedback logging**: If the doc was wrong (you corrected it) or had a gap
  (required real exploration), append one JSON line to
  .cursor-context/harness-pi/context-feedback.jsonl after finishing:
  {"type":"wrong"|"gap","area":"<topic>","note":"<one line>"}. Do not log if
  neither applies.
- **Evolve**: If injected "evolve" instructions are present, run the
  context-evolve skill procedure after finishing the user's request. Skip in
  plan/read-only/print modes or when the cwd is not writable. Never modify
  CLAUDE.md / AGENTS.md, hooks, skills, or settings — only the doc and
  .cursor-context/harness-pi/ data files.
`.trim();

export default function (pi: ExtensionAPI) {
	const opts: ExtensionOptions = loadOptions();
	let lastFreshness: { verdict: Awaited<ReturnType<typeof freshnessVerdict>>; ts: number } | null = null;
	let evolvedThisSession = false;

	// ---------------------------------------------------------------
	// Skill discovery: ship project-onboard / context-refresh / context-evolve
	// as pi skills. They are markdown-driven; pi loads SKILL.md on demand.
	// ---------------------------------------------------------------
	pi.on("resources_discover", () => {
		return {
			skillPaths: [join(extDir, "..", "skills")],
		};
	});

	// ---------------------------------------------------------------
	// session_start: build and cache the snapshot + freshness verdict.
	// Inject it as a system-prompt appendix on the first agent_start.
	// ---------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		lastFreshness = null;
		evolvedThisSession = false;
		const cwd = ctx.cwd;

		// Compute freshness once per session; per-prompt hook re-runs only the
		// (cheap) fingerprint comparison via before_agent_start.
		try {
			const verdict = await freshnessVerdict(cwd, join(cwd, CONTEXT_FILE));
			lastFreshness = { verdict, ts: Date.now() };
		} catch {
			lastFreshness = { verdict: { kind: "unverifiable", reason: "computation error" }, ts: Date.now() };
		}

		// Auto-onboard: if no doc exists and the user disabled it, do nothing.
		// The doc will be generated on the first substantive task (handled in
		// before_agent_start instructions).
		if (lastFreshness.verdict.kind === "no-doc") {
			// nothing to inject; onboard instructions are added in before_agent_start
			ctx.ui.setStatus("cursor-context", "no context doc yet");
		} else if (lastFreshness.verdict.kind === "fresh") {
			ctx.ui.setStatus("cursor-context", "context fresh");
		} else if (lastFreshness.verdict.kind === "stale") {
			ctx.ui.setStatus("cursor-context", `stale: ${lastFreshness.verdict.changed.length} item(s)`);
		} else {
			ctx.ui.setStatus("cursor-context", "unverifiable");
		}

		// Deterministically ensure `.cursor-context/` is gitignored whenever a doc
		// exists. The skill instructs the LLM to do this, but the LLM may write
		// the doc directly and skip the helper — so we enforce it here, making
		// "auto-added to .gitignore" an honest guarantee rather than a hope.
		if (lastFreshness.verdict.kind !== "no-doc" && (await isGitRepo(cwd))) {
			await ensureGitignored(cwd);
		}

		// Migrate legacy root-level logs (from the Claude Code bash toolkit) into
		// this harness's scoped directory, so prior signal isn't lost and the two
		// harnesses stop writing to the same files. Idempotent and best-effort.
		await migrateLegacyLogs(cwd);
	});

	// ---------------------------------------------------------------
	// before_agent_start: inject snapshot + freshness + standing rules.
	// This is the per-prompt real-time layer (replaces UserPromptSubmit hook).
	// ---------------------------------------------------------------
	pi.on("before_agent_start", async (event, ctx) => {
		const cwd = ctx.cwd;
		const parts: string[] = [];

		// 1. Snapshot (stack, tree, git, branch intent)
		let docBody: string | undefined;
		const docPath = join(cwd, CONTEXT_FILE);
		const doc = await readText(docPath);
		if (doc) {
			docBody = stripMarkers(doc);
			const body = bodyLineCount(doc);
			if (body > MAX_CTX_LINES) {
				const truncated = docBody.split("\n").slice(0, MAX_CTX_LINES).join("\n");
				docBody = `${truncated}\n(…doc truncated at ${MAX_CTX_LINES} lines — ${body - MAX_CTX_LINES} lines omitted; read ${CONTEXT_FILE} for the full content.)`;
			}
		}
		const snapshot = await buildSnapshot(cwd, docBody);
		parts.push(snapshot);

		// 2. Freshness: re-compute (cheap) so session-mid commits/rollbacks show up
		const verdict = await freshnessVerdict(cwd, docPath);
		lastFreshness = { verdict, ts: Date.now() };

		if (verdict.kind === "no-doc") {
			if (!opts.onboardDisabled) {
				parts.push(
					[
						`No auto-generated project doc (${CONTEXT_FILE}) yet.`,
						`Auto-onboard instruction: after finishing the user's current request, silently generate ${CONTEXT_FILE} via the project-onboard skill procedure. Reuse knowledge already gathered this session to minimize extra exploration. Skip in plan/read-only/print sessions. Never modify CLAUDE.md / AGENTS.md. Append a one-line note "Generated project context doc." to your final report.`,
						`Generate when: you performed code-change work this session, OR the user asked about the project itself (what it is, structure, stack, commands, architecture) — the exploration already happened, so keep the knowledge.`,
						`Skip when: the request is unrelated to the codebase, plan mode / read-only, or pure code review / PR inspection.`,
					].join(" "),
				);
			}
		} else if (verdict.kind === "stale") {
			parts.push(buildFreshnessAlert(verdict.changed));
			parts.push(
				[
					`Auto-refresh instruction: after finishing the user's current request, silently refresh the affected sections of ${CONTEXT_FILE} using the context-refresh skill. Skip in plan/read-only/print sessions. Never modify CLAUDE.md / AGENTS.md. If you refreshed, append a one-line note "Refreshed project context doc." to your final report.`,
				].join(" "),
			);
		} else if (verdict.kind === "unverifiable") {
			parts.push(
				`Fingerprint verification unavailable (${verdict.reason}). Treat doc commands/structure as unverified — confirm against actual files before relying on them. The next refresh will re-stamp markers.`,
			);
		} else {
			parts.push(`Auto-generated doc verified fresh against the live working tree.`);
		}

		// 3. Commit backstop (catches drift fingerprints miss, e.g. convention changes)
		if (verdict.kind !== "no-doc" && doc && (await isGitRepo(cwd))) {
			const gen = parseGeneratedAt(doc);
			if (gen) {
				if (await commitExists(cwd, gen)) {
					const since = await commitsSince(cwd, gen);
					if (since > COMMIT_BACKSTOP) {
						parts.push(
							`Doc is ${since} commits behind HEAD. Structure may be the same, but conventions/patterns may have drifted. After finishing the request, silently refresh ${CONTEXT_FILE} via context-refresh. Skip in plan/read-only/print sessions.`,
						);
					}
				} else {
					parts.push(
						`Note: doc's base commit (${gen}) is absent from history (likely rebase/squash). Structural changes are still detected via fingerprints, but the commit backstop is inactive until the next refresh re-stamps the marker.`,
					);
				}
			}
		}

		// 4. Evolve gate hint (deterministic enforcement is in agent_end)
		if (!opts.evolveDisabled && verdict.kind !== "no-doc" && !evolvedThisSession) {
			const { feedback, metrics } = signalCounts(cwd);
			if (feedback >= 5 || metrics >= 300) {
				parts.push(
					`Evolve instruction: usage signal sufficient (feedback ${feedback}, metrics ${metrics}). After finishing the user's request, run the context-evolve skill to improve the doc. Skip in plan/read-only/print sessions or when the cwd is not writable. Never modify CLAUDE.md / AGENTS.md, hooks, skills, or settings.`,
				);
			}
		}

		// 5. Standing rules (always)
		parts.push(STANDING_INSTRUCTIONS);

		return {
			systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n\n")}`,
		};
	});

	// ---------------------------------------------------------------
	// tool_call: metrics collection (replaces PostToolUse hook).
	// We capture intent at tool_call time (input is available here; it is
	// absent on tool_execution_end). In-process — no python3 spawn per call.
	// ---------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		if (opts.metricsDisabled) return;
		// Skip benchmark runs to avoid contaminating measurements
		if (process.env.CURSOR_CONTEXT_BENCH === "1") return;
		const cwd = ctx.cwd;
		const tool = event.toolName;
		const input = (event.input ?? {}) as Record<string, unknown>;

		const rec: {
			ts: number;
			tool: string;
			cmd?: string;
			path?: string;
			pattern?: string;
		} = { ts: Math.floor(Date.now() / 1000), tool };

		if (tool === "bash" && typeof input.command === "string") {
			rec.cmd = input.command.slice(0, 200);
		} else if (tool === "read" || tool === "glob") {
			const p = (input.file_path ?? input.path ?? input.pattern) as string | undefined;
			if (p) rec.path = p.slice(0, 200);
		} else if (tool === "grep") {
			if (typeof input.pattern === "string") rec.pattern = input.pattern.slice(0, 120);
			if (typeof input.path === "string") rec.path = input.path.slice(0, 120);
		} else if (tool === "ls" || tool === "find") {
			const p = (input.path ?? input.pattern) as string | undefined;
			if (p) rec.path = p.slice(0, 200);
		} else {
			return;
		}

		appendMetric(cwd, rec);
	});

	// ---------------------------------------------------------------
	// agent_end: deterministic evolve gate (replaces Stop hook exit 2).
	// pi has no "block turn end" mechanism, so enforcement shifts to a
	// follow-up user message that triggers the evolve skill. This is honest
	// about being probabilistic — unlike the bash version's exit 2, which was
	// also ultimately model-compliance-dependent despite claims of
	// determinism. The improvement: we check ctx.mode and cwd writeability
	// to avoid triggering in inappropriate sessions (the bash version relied
	// on injected instructions for this).
	// ---------------------------------------------------------------
	pi.on("agent_end", async (_event, ctx) => {
		if (opts.evolveDisabled) return;
		if (evolvedThisSession) return;
		const cwd = ctx.cwd;
		// Skip inappropriate sessions: print/json modes, or plan mode
		if (ctx.mode === "print" || ctx.mode === "json") return;

		const docPath = join(cwd, CONTEXT_FILE);
		if (!(await fileExists(docPath))) return;

		if (!evolveThresholdCrossed(cwd)) return;

		// Check cwd is writable (skip in read-only filesystems)
		try {
			await access(cwd, FS.W_OK);
		} catch {
			return;
		}

		// Trigger evolve as a follow-up. deliverAs "followUp" waits for the
		// agent to be idle, then runs — non-disruptive to the just-finished turn.
		evolvedThisSession = true;
		const { feedback, metrics } = signalCounts(cwd);
		pi.sendUserMessage(
			`/skill:context-evolve (Accumulated usage signals: feedback ${feedback}, metrics ${metrics}. Run the context-evolve skill procedure now: backup → analyze signals → rewrite doc → run context-benchmark gate → consume signals → log result. Skip if the cwd is not writable or this is a read-only session. Never modify CLAUDE.md/AGENTS.md, hooks, skills, or settings.)`,
			{ deliverAs: "followUp" },
		);
		ctx.ui.setStatus("cursor-context", `evolve triggered (fb ${feedback}, mt ${metrics})`);
	});

	// ---------------------------------------------------------------
	// Custom tool: context_refresh — let the LLM trigger an incremental
	// refresh deterministically (the skill still contains the procedure).
	// ---------------------------------------------------------------
	pi.registerTool({
		name: "context_refresh",
		label: "Refresh Context Doc",
		description:
			"Refresh .cursor-context/project-context.md against recent code changes. Use when the doc is stale or disagrees with actual code. Runs the context-refresh skill procedure: compute current fingerprint, diff against stored, rewrite affected sections, re-stamp markers.",
		promptSnippet: "Refresh the project context doc when it is stale",
		parameters: Type.Object({
			scope: Type.Optional(
				Type.String({ description: "Optional: limit refresh to a section or topic name" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const docPath = join(cwd, CONTEXT_FILE);
			const doc = await readText(docPath);
			if (!doc) {
				return {
					content: [{ type: "text", text: `No doc at ${CONTEXT_FILE}. Use /skill:project-onboard to generate one.` }],
					details: {},
				};
			}
			const stored = parseStoredFingerprint(doc);
			const current = await computeFingerprint(cwd);
			const changed = stored.length === 0 ? ["(no markers)"] : diffFingerprints(stored, current);
			const sha = (await headSha(cwd)) ?? "unknown";
			const body = await readDocBody(cwd);
			return {
				content: [
					{
						type: "text",
						text: [
							`Refresh context: ${params.scope ? `scope=${params.scope}` : "full"}.`,
							`Changed structural items: ${changed.length ? changed.join(", ") : "none"}.`,
							`Current HEAD: ${sha}.`,
							`After rewriting, re-stamp markers with HEAD=${sha} and the current fingerprint (see details).`,
							body ? `Current doc body (markers stripped) is ${body.split("\n").length} lines.` : "",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: { changed, head: sha, fingerprint: current },
			};
		},
	});

	// ---------------------------------------------------------------
	// Custom tool: context_benchmark — run the doc quality gate.
	// ---------------------------------------------------------------
	pi.registerTool({
		name: "context_benchmark",
		label: "Benchmark Context Doc",
		description:
			"Run the deterministic quality gate against .cursor-context/project-context.md. Checks body length, marker validity, that referenced npm/make commands exist, and that referenced paths exist. Returns PASS/WARN/FAIL counts. FAIL = the doc must not be adopted; restore from backup.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const result = await benchmark(ctx.cwd);
			return {
				content: [{ type: "text", text: result.lines.join("\n") }],
				details: { pass: result.pass, warn: result.warn, fail: result.fail, ok: result.ok },
			};
		},
	});

	// ---------------------------------------------------------------
	// Custom tool: context_feedback — let the LLM log a wrong/gap signal.
	// ---------------------------------------------------------------
	pi.registerTool({
		name: "context_feedback",
		label: "Log Context Feedback",
		description:
			"Append a feedback signal to .cursor-context/harness-pi/context-feedback.jsonl when the doc was wrong or had a gap. Used by the self-improvement loop. type=wrong means the doc stated something incorrect; type=gap means the doc omitted something that required real exploration.",
		parameters: Type.Object({
			type: Type.Union([Type.Literal("wrong"), Type.Literal("gap")]),
			area: Type.String({ description: "Topic or section name" }),
			note: Type.String({ description: "One-line description" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			appendFeedback(ctx.cwd, { type: params.type, area: params.area, note: params.note });
			return {
				content: [{ type: "text", text: `Logged ${params.type} feedback for "${params.area}".` }],
				details: {},
			};
		},
	});

	// ---------------------------------------------------------------
	// Command: /context — show the current doc freshness status.
	// ---------------------------------------------------------------
	pi.registerCommand("context", {
		description: "Show cursor-context freshness status and signal counts",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const docPath = join(cwd, CONTEXT_FILE);
			const verdict = await freshnessVerdict(cwd, docPath);
			const { feedback, metrics } = signalCounts(cwd);
			const lines: string[] = ["cursor-context status:"];
			lines.push(`  doc: ${verdict.kind}${verdict.kind === "stale" ? ` (${verdict.changed.join(", ")})` : ""}`);
			lines.push(`  signals: feedback=${feedback}, metrics=${metrics}`);
			lines.push(`  evolve threshold: ${evolveThresholdCrossed(cwd) ? "crossed" : "not reached"}`);
			lines.push(`  metrics disabled: ${opts.metricsDisabled}, evolve disabled: ${opts.evolveDisabled}, onboard disabled: ${opts.onboardDisabled}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ---------------------------------------------------------------
	// Command: /context-onboard — force a full doc regeneration.
	// ---------------------------------------------------------------
	pi.registerCommand("context-onboard", {
		description: "Force full regeneration of the project context doc (runs project-onboard skill)",
		handler: async (_args, ctx) => {
			pi.sendUserMessage(
				"/skill:project-onboard (User invoked /context-onboard. Generate .cursor-context/project-context.md now, following the project-onboard skill procedure. This is the only task for this turn — do not skip.)",
			);
		},
	});

	// ---------------------------------------------------------------
	// Command: /context-evolve — force a doc evolution pass.
	// ---------------------------------------------------------------
	pi.registerCommand("context-evolve", {
		description: "Force a context-evolve pass: analyze usage signals and improve the doc",
		handler: async (_args, ctx) => {
			pi.sendUserMessage(
				"/skill:context-evolve (User invoked /context-evolve. Run the full evolve procedure: backup → analyze signals → rewrite → benchmark gate → consume signals → log. Never modify CLAUDE.md/AGENTS.md, hooks, skills, or settings.)",
			);
		},
	});
}

// Re-export so skills (loaded as separate markdown) can reference helpers via
// the extension's tool surface rather than reimplementing logic. The skills
// in ./skills/ instruct the LLM to call context_refresh / context_benchmark /
// context_feedback tools, which keeps logic centralized here.
export { writeDoc, ensureGitignored, backupDoc, restoreDoc, appendEvolveLog, consumeSignals };
