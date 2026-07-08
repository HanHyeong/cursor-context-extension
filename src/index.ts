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
 *   Claude Code PostToolUse   → pi `tool_call`
 *   Claude Code Stop (evolve gate) → pi `agent_end`
 *
 * Key architectural improvements over the bash version:
 *   1. Single in-process fingerprint source (src/git.ts). The bash version
 *      re-implemented comparison in 3 places.
 *   2. Metrics collection is in-process (no python3 spawn per tool call).
 *   3. Evolve gate checks ctx.mode + cwd writeability instead of relying on
 *      model compliance to skip in read-only/print sessions.
 *   4. Framework detection uses key matching, fixing the `next` vs
 *      `next-auth` false positive in the bash version.
 *   5. Directory-structure hash considers only git-tracked + non-ignored
 *      files (already fixed in the original, preserved here).
 *   6. No exit-code-3 magic numbers — typed FreshnessVerdict discriminated
 *      union makes "unverifiable" an honest first-class state.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
// StringEnum (from @earendil-works/pi-ai) is the Google-compatible enum helper.
// We use Type.Union/Type.Literal for the feedback tool's `type` param here;
// swap to StringEnum(["wrong","gap"]) if Google model compatibility is needed.

import {
	CONTEXT_FILE,
	MAX_CTX_LINES,
	COMMIT_BACKSTOP,
	ONBOARD_EXPLORATION_THRESHOLD,
	ONBOARD_MAX_ATTEMPTS,
	EXPLORATION_TOOLS,
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
	fileExists,
	isWritable,
} from "./git.js";
import { buildSnapshot, buildFreshnessAlert } from "./snapshot.js";
import { appendMetric, appendFeedback, appendEvolveLog, signalCounts, evolveThresholdCrossed, consumeSignals } from "./metrics.js";
import { benchmark, backupDoc, restoreDoc } from "./benchmark.js";
import { writeDoc, ensureGitignored } from "./doc.js";

const extDir = dirname(fileURLToPath(import.meta.url));

/** Persistent injected instruction appended to the system prompt every turn. */
const STANDING_INSTRUCTIONS = `
## cursor-context standing rules

These rules persist across turns. The context doc and snapshot are auxiliary
knowledge; they are never authoritative over actual code or user instructions
(CLAUDE.md / AGENTS.md / settings).

- **Micro-refresh**: If, during this session's work, you find the auto-generated
  doc (.cursor-context/project-context.md) disagrees with actual code, fix the
  affected section silently after finishing the user's request and rewrite the
  doc via the context_write_doc tool (it stamps the generated-at-commit +
  fingerprint markers automatically). If you find no discrepancy, do nothing.
- **Feedback logging**: If the doc was wrong (you corrected it) or had a gap
  (required real exploration), append one JSON line to
  .cursor-context/harness-pi/context-feedback.jsonl after finishing:
  {"type":"wrong"|"gap","area":"<topic>","note":"<one line>"}. Do not log if
  neither applies.
- **Evolve**: If injected "evolve" instructions are present, run the
  context-evolve skill procedure after finishing the user's request. Skip in
  read-only/print modes or when the cwd is not writable. Never modify
  CLAUDE.md / AGENTS.md, hooks, skills, or settings — only the doc and
  .cursor-context/harness-pi/ data files.
`.trim();

export default function (pi: ExtensionAPI) {
	const opts: ExtensionOptions = loadOptions();
	let lastFreshness: { verdict: Awaited<ReturnType<typeof freshnessVerdict>>; ts: number } | null = null;
	let evolvedThisSession = false;
	// Auto-onboard mirrors evolve: a deterministic follow-up trigger rather
	// than relying solely on the "after finishing the current request"
	// instruction (which is never reached when the code change *is* the
	// current request — the LLM ends the turn immediately after editing).
	// Bounded attempts (not a one-shot latch) so a follow-up turn that ends
	// without producing the doc gets one retry instead of going silent.
	let onboardAttemptsThisSession = 0;
	// Set by the tool_result handler on successful edit/write; gates the
	// auto-onboard trigger so read-only sessions don't spawn a doc generation
	// follow-up.
	let codeChangedThisSession = false;
	// Exploration calls (read/grep/find/ls/bash) this session. Covers the
	// "user asked about the project" generation case, where no edit/write
	// happens but the exploration knowledge is worth persisting — and bash-only
	// sessions, whose file mutations edit/write detection cannot see.
	let explorationThisSession = 0;

	// Skill files shipped with this extension (single root shared with the
	// resources_discover handler). sendUserMessage does NOT expand /skill:
	// commands (pi expands them only for interactive input), so programmatic
	// triggers must point the model at the skill file explicitly.
	const skillsDir = join(extDir, "..", "skills");
	const onboardSkillFile = join(skillsDir, "project-onboard", "SKILL.md");
	const evolveSkillFile = join(skillsDir, "context-evolve", "SKILL.md");

	// Shared instruction clauses for every onboard/evolve trigger message.
	// One source: divergent copies of these strings are how the model ends up
	// with contradictory procedures in a single session.
	const onboardProcedure =
		`Read ${onboardSkillFile} now and follow its procedure to generate ${CONTEXT_FILE}, writing the doc with the context_write_doc tool (it stamps the freshness markers automatically). Never modify CLAUDE.md / AGENTS.md.`;
	const evolveProcedure =
		`Read ${evolveSkillFile} now and follow the context-evolve skill procedure: backup → analyze signals → rewrite doc (via the context_write_doc tool) → run context-benchmark gate → consume signals → log result. Never modify CLAUDE.md/AGENTS.md, hooks, skills, or settings.`;

	// ---------------------------------------------------------------
	// Skill discovery: ship project-onboard / context-refresh / context-evolve
	// as pi skills. They are markdown-driven; pi loads SKILL.md on demand.
	// ---------------------------------------------------------------
	pi.on("resources_discover", () => {
		return {
			skillPaths: [skillsDir],
		};
	});

	// ---------------------------------------------------------------
	// session_start: build and cache the snapshot + freshness verdict.
	// Inject it as a system-prompt appendix on the first agent_start.
	// ---------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		lastFreshness = null;
		evolvedThisSession = false;
		onboardAttemptsThisSession = 0;
		codeChangedThisSession = false;
		explorationThisSession = 0;
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
			// Truncate on the SAME basis the context_benchmark gate uses
			// (bodyLineCount = non-blank body lines): a doc that passes the
			// gate must never be truncated here, and the "omitted" figure
			// counts the same units that were measured.
			const contentTotal = bodyLineCount(doc);
			if (contentTotal > MAX_CTX_LINES) {
				const kept: string[] = [];
				let content = 0;
				for (const line of docBody.split("\n")) {
					if (line) {
						if (content === MAX_CTX_LINES) break;
						content++;
					}
					kept.push(line);
				}
				docBody = `${kept.join("\n").trimEnd()}\n(…doc truncated at ${MAX_CTX_LINES} content lines — ${contentTotal - MAX_CTX_LINES} lines omitted; read ${CONTEXT_FILE} for the full content.)`;
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
						`Auto-onboard instruction: after finishing the user's current request, silently generate ${CONTEXT_FILE} via the project-onboard skill procedure (skill file: ${onboardSkillFile}; write the doc with the context_write_doc tool — it stamps freshness markers automatically). Reuse knowledge already gathered this session to minimize extra exploration. Skip in read-only/print sessions. Never modify CLAUDE.md / AGENTS.md. Append a one-line note "Generated project context doc." to your final report.`,
						`Generate when: you performed code-change work this session, OR the user asked about the project itself (what it is, structure, stack, commands, architecture) — the exploration already happened, so keep the knowledge.`,
						`Skip when: the request is unrelated to the codebase, read-only, or pure code review / PR inspection.`,
					].join(" "),
				);
			}
		} else if (verdict.kind === "stale") {
			parts.push(buildFreshnessAlert(verdict.changed));
			parts.push(
				[
					`Auto-refresh instruction: after finishing the user's current request, silently refresh the affected sections of ${CONTEXT_FILE} using the context-refresh skill (rewrite the doc via the context_write_doc tool — it re-stamps the markers). Skip in read-only/print sessions. Never modify CLAUDE.md / AGENTS.md. If you refreshed, append a one-line note "Refreshed project context doc." to your final report.`,
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
							`Doc is ${since} commits behind HEAD. Structure may be the same, but conventions/patterns may have drifted. After finishing the request, silently refresh ${CONTEXT_FILE} via context-refresh. Skip in read-only/print sessions.`,
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
					`Evolve instruction: usage signal sufficient (feedback ${feedback}, metrics ${metrics}). After finishing the user's request, run the context-evolve skill to improve the doc. Skip in read-only/print sessions or when the cwd is not writable. Never modify CLAUDE.md / AGENTS.md, hooks, skills, or settings.`,
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
		const cwd = ctx.cwd;
		const tool = event.toolName;

		// Skip benchmark runs to avoid contaminating measurements
		if (process.env.CURSOR_CONTEXT_BENCH === "1") return;
		if (opts.metricsDisabled) return;
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
		} else if (tool === "read") {
			if (typeof input.path === "string") rec.path = input.path.slice(0, 200);
		} else if (tool === "grep") {
			if (typeof input.pattern === "string") rec.pattern = input.pattern.slice(0, 120);
			if (typeof input.path === "string") rec.path = input.path.slice(0, 120);
		} else if (tool === "ls" || tool === "find") {
			const p = (input.path ?? input.pattern) as string | undefined;
			if (typeof p === "string") rec.path = p.slice(0, 200);
		} else {
			return;
		}

		appendMetric(cwd, rec);
	});

	// ---------------------------------------------------------------
	// tool_result: onboard signal detection. Deliberately NOT in tool_call:
	// that event fires before execution and can be blocked by the permission
	// system, so a rejected/failed edit would falsely mark the session as
	// code-changing. Metrics stay at tool_call (they measure intent); the
	// onboard trigger needs actual outcomes, so it counts non-error results.
	// Independent of BENCH/metricsDisabled — measurement gating and onboard
	// triggering are orthogonal concerns.
	// Only edit/write count as code changes — parsing bash `sed`/`>` for
	// writes would be noisy and unreliable, so we accept the cleaner subset;
	// bash-heavy sessions are still caught by the exploration counter.
	// ---------------------------------------------------------------
	pi.on("tool_result", async (event) => {
		if (event.isError) return;
		const tool = event.toolName;
		if (tool === "edit" || tool === "write") {
			codeChangedThisSession = true;
		} else if (EXPLORATION_TOOLS.has(tool)) {
			explorationThisSession++;
		}
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
		const cwd = ctx.cwd;
		// Skip non-interactive sessions. pi's ExtensionMode is
		// "tui" | "rpc" | "json" | "print" — there is no "plan" mode; the
		// original comment referred to a mode that never existed. print/json
		// are single-shot output modes where a follow-up user message has no
		// agent to receive it, so auto-onboard/evolve must not fire there.
		if (ctx.mode === "print" || ctx.mode === "json") return;

		// Cheap in-memory gates first; hit the filesystem only when a trigger
		// could actually fire. Onboard attempts are bounded asymmetrically: a
		// code-change session gets a retry (a follow-up turn ending without a
		// doc is likely non-compliance), an exploration-only session gets a
		// single attempt — its message allows declining (review-only
		// sessions), and re-nagging after a deliberate decline is just noise.
		const maxAttempts = codeChangedThisSession ? ONBOARD_MAX_ATTEMPTS : 1;
		const substantive =
			codeChangedThisSession || explorationThisSession >= ONBOARD_EXPLORATION_THRESHOLD;
		const onboardPossible =
			!opts.onboardDisabled && substantive && onboardAttemptsThisSession < maxAttempts;
		const evolvePossible =
			!opts.evolveDisabled && !evolvedThisSession && onboardAttemptsThisSession === 0;
		if (!onboardPossible && !evolvePossible) return;

		const docPath = join(cwd, CONTEXT_FILE);
		const docExists = await fileExists(docPath);

		// ── Auto-onboard: no doc + substantive work this session → force a
		// follow-up that runs the project-onboard skill. Without this, the
		// "after finishing the current request" instruction injected in
		// before_agent_start is never acted on, because the work *is* the
		// current request — the LLM ends the turn immediately after it.
		// "Substantive" = code was changed (edit/write), or enough exploration
		// happened that the gathered knowledge is worth persisting (covers
		// question-only and bash-only sessions). Governed by
		// opts.onboardDisabled (independent of evolveDisabled below).
		if (!docExists) {
			if (!onboardPossible) return;
			if (!(await isWritable(cwd))) return;
			onboardAttemptsThisSession++;
			// Exploration-only sessions may legitimately be review-only — the
			// injected policy says to skip those, so this trigger must allow
			// the same exception instead of contradicting it with "do not
			// skip". Code-change sessions are unambiguous.
			const compliance = codeChangedThisSession
				? "This is the only task for this turn — do not skip."
				: "This is the only task for this turn. Exception: if this session was pure code review / PR inspection or otherwise unrelated to understanding this codebase, reply with a single line saying onboarding was skipped and why.";
			pi.sendUserMessage(
				`No context doc at ${CONTEXT_FILE} yet, and this session did substantive work. ${onboardProcedure} Reuse knowledge already gathered this session to minimize extra exploration. ${compliance} Append "Generated project context doc." to your report.`,
				{ deliverAs: "followUp" },
			);
			ctx.ui.setStatus(
				"cursor-context",
				`onboard triggered (attempt ${onboardAttemptsThisSession}/${maxAttempts})`,
			);
			return;
		}

		// ── Evolve gate. Gated by opts.evolveDisabled separately from
		// onboarding, and mutually exclusive with it within a session:
		// chaining two auto follow-ups (generate, then immediately evolve the
		// fresh doc) would be noisy and pointless.
		if (!evolvePossible) return;
		if (!evolveThresholdCrossed(cwd)) return;
		if (!(await isWritable(cwd))) return;

		// Trigger evolve as a follow-up. deliverAs "followUp" waits for the
		// agent to be idle, then runs — non-disruptive to the just-finished turn.
		evolvedThisSession = true;
		const { feedback, metrics } = signalCounts(cwd);
		pi.sendUserMessage(
			`Accumulated usage signals: feedback ${feedback}, metrics ${metrics}. ${evolveProcedure} Skip if the cwd is not writable or this is a read-only session.`,
			{ deliverAs: "followUp" },
		);
		ctx.ui.setStatus("cursor-context", `evolve triggered (fb ${feedback}, mt ${metrics})`);
	});

	// ---------------------------------------------------------------
	// Custom tool: context_write_doc — write the doc with markers stamped
	// deterministically. Without this, the exported writeDoc helper is
	// unreachable from skills (they are markdown for the LLM, not code), so
	// header stamping would depend on the model reproducing the marker format
	// by hand — one wrong space and the doc is permanently "unverifiable".
	// ---------------------------------------------------------------
	pi.registerTool({
		name: "context_write_doc",
		label: "Write Context Doc",
		description:
			"Write .cursor-context/project-context.md. Pass ONLY the markdown body — the freshness markers (generated-at-commit + fingerprint block) are computed and prepended automatically, and .cursor-context/ is added to .gitignore (skipped when the doc is committed for team sharing). Always use this instead of writing the doc file by hand, for both generation and refresh. Validate afterwards with context_benchmark.",
		parameters: Type.Object({
			body: Type.String({ description: "Full markdown body of the doc, without any marker header" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			// Strip any marker/header lines the model accidentally included in
			// the body (e.g. passing the previous doc verbatim): a second
			// fingerprint block would shadow the fresh one in
			// parseStoredFingerprint and flag the doc stale forever. Injection
			// strips these lines anyway, so nothing of value is lost.
			const body = stripMarkers(params.body).trim();
			try {
				const [head, fingerprint, repo] = await Promise.all([
					headSha(cwd),
					computeFingerprint(cwd),
					isGitRepo(cwd),
				]);
				const sha = head ?? "unknown";
				writeDoc(cwd, body, sha, fingerprint);
				// A .gitignore hiccup must not read as a doc-write failure —
				// the doc IS on disk; report the hiccup as a note instead.
				let gitignoreNote = "";
				if (repo) {
					try {
						await ensureGitignored(cwd);
					} catch {
						gitignoreNote = " Note: could not update .gitignore (the doc itself was written).";
					}
				}
				const bodyLines = bodyLineCount(body);
				return {
					content: [
						{
							type: "text",
							text: `Wrote ${CONTEXT_FILE} (${bodyLines} body lines; markers stamped at HEAD=${sha}, ${fingerprint.length} fingerprint entries). Run context_benchmark to validate.${gitignoreNote}`,
						},
					],
					details: { head: sha, fingerprintEntries: fingerprint.length, bodyLines },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Failed to write ${CONTEXT_FILE}: ${msg}` }],
					details: { error: msg },
				};
			}
		},
	});

	// ---------------------------------------------------------------
	// Custom tool: context_refresh — let the LLM trigger an incremental
	// refresh deterministically (the skill still contains the procedure).
	// ---------------------------------------------------------------
	pi.registerTool({
		name: "context_refresh",
		label: "Refresh Context Doc",
		description:
			"Analyze .cursor-context/project-context.md staleness: compute the current fingerprint, diff it against the stored one, and report which structural items changed. Use when the doc is stale or disagrees with actual code. After rewriting the affected sections, write the result with the context_write_doc tool (which re-stamps the markers) — never rebuild the header by hand.",
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
					content: [
						{
							type: "text",
							text: `No doc at ${CONTEXT_FILE}. Read ${onboardSkillFile} and follow its procedure to generate one (write it with the context_write_doc tool).`,
						},
					],
					details: {},
				};
			}
			const stored = parseStoredFingerprint(doc);
			const [current, head] = await Promise.all([computeFingerprint(cwd), headSha(cwd)]);
			const changed = stored.length === 0 ? ["(no markers)"] : diffFingerprints(stored, current);
			const sha = head ?? "unknown";
			return {
				content: [
					{
						type: "text",
						text: [
							`Refresh context: ${params.scope ? `scope=${params.scope}` : "full"}.`,
							`Changed structural items: ${changed.length ? changed.join(", ") : "none"}.`,
							`Current HEAD: ${sha}.`,
							`After rewriting the affected sections, write the full updated body via the context_write_doc tool — it re-stamps the markers; do not rebuild the header by hand.`,
							`Current doc body is ${bodyLineCount(doc)} lines (same measure as the context_benchmark gate).`,
						].join("\n"),
					},
				],
				details: { changed, head: sha },
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
	// Custom tool: context_evolve_checkpoint — backup, restore, and (later)
	// consume the signal logs for the evolve loop. Like context_write_doc,
	// this exists because backupDoc/restoreDoc/consumeSignals/appendEvolveLog
	// are plain TS exports unreachable from a markdown skill; without this
	// tool the model's only option was hand-rolled bash mkdir/cp/mv, which
	// can drift from the helpers' actual `evolve-<epoch-ms>` directory naming
	// (the skill's own example used `date +%Y%m%d%H%M%S`, a different,
	// incompatible scheme) — and the skill had no way at all to invoke
	// restoreDoc on a gate FAIL.
	// One call backs up (step="backup"); on a benchmark FAIL, a call with the
	// returned backupPath restores it (step="restore"); a call with the
	// SAME ts consumes the signal files into that backup dir and logs the
	// outcome (step="finalize"), keeping every part of one evolve pass paired
	// under one timestamp.
	// ---------------------------------------------------------------
	pi.registerTool({
		name: "context_evolve_checkpoint",
		label: "Evolve Backup/Checkpoint",
		description:
			"Manage the evolve loop's backup/restore/signal-consumption lifecycle. step='backup': snapshot the current doc to .cursor-context/backup/evolve-<ts>/ before rewriting; returns ts and backupPath — keep both for later calls. step='restore': if context_benchmark FAILs the new doc, restore the pre-rewrite doc from backupPath. step='finalize': move this harness's signal logs (feedback + metrics) into the same evolve-<ts>/ backup dir and append one line to evolve-log.jsonl. Call backup before rewriting the doc, restore only on a FAIL gate, and finalize once after the adoption decision (adopted or rejected) — do this even on rejection, so signals aren't reprocessed every session.",
		parameters: Type.Object({
			step: Type.Union([Type.Literal("backup"), Type.Literal("restore"), Type.Literal("finalize")]),
			ts: Type.Optional(
				Type.Number({ description: "Required for step='finalize': the ts returned by the prior 'backup' call" }),
			),
			backupPath: Type.Optional(
				Type.String({ description: "Required for step='restore': the backupPath returned by the prior 'backup' call" }),
			),
			accepted: Type.Optional(Type.Boolean({ description: "finalize only: was the new doc adopted?" })),
			beforePass: Type.Optional(Type.Number({ description: "finalize only: baseline context_benchmark PASS count" })),
			afterPass: Type.Optional(Type.Number({ description: "finalize only: new doc's context_benchmark PASS count" })),
			changes: Type.Optional(Type.String({ description: "finalize only: one-line summary of what changed" })),
			rejectReason: Type.Optional(Type.String({ description: "finalize only: why the doc was rejected, if it was" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			if (params.step === "backup") {
				const ts = Date.now();
				const backupPath = backupDoc(cwd, ts);
				return {
					content: [
						{
							type: "text",
							text: backupPath
								? `Backed up doc to ${backupPath}. Keep ts=${ts} and this backupPath for the restore/finalize calls.`
								: `No existing doc to back up (ts=${ts} — pass it to finalize anyway).`,
						},
					],
					details: { ts, backupPath },
				};
			}
			if (params.step === "restore") {
				if (!params.backupPath) {
					return {
						content: [{ type: "text", text: "step='restore' requires backupPath from the prior 'backup' call." }],
						details: { error: "missing backupPath" },
					};
				}
				const ok = restoreDoc(cwd, params.backupPath);
				return {
					content: [
						{
							type: "text",
							text: ok
								? `Restored ${CONTEXT_FILE} from ${params.backupPath}.`
								: `Failed to restore from ${params.backupPath}.`,
						},
					],
					details: { ok },
				};
			}
			if (params.step !== "finalize") {
				return {
					content: [{ type: "text", text: `Unknown step '${params.step}'.` }],
					details: { error: "unknown step" },
				};
			}
			if (params.ts === undefined) {
				return {
					content: [{ type: "text", text: "step='finalize' requires ts from the prior 'backup' call." }],
					details: { error: "missing ts" },
				};
			}
			consumeSignals(cwd, params.ts);
			appendEvolveLog(cwd, {
				accepted: params.accepted ?? false,
				before_pass: params.beforePass ?? null,
				after_pass: params.afterPass ?? null,
				changes: params.changes ?? null,
				reject_reason: params.rejectReason ?? null,
			});
			return {
				content: [{ type: "text", text: `Consumed signal logs into evolve-${params.ts}/ and logged the outcome.` }],
				details: { ts: params.ts },
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
			// sendUserMessage does not expand /skill: commands — point the
			// model at the skill file explicitly. deliverAs "followUp" queues
			// safely if the agent happens to be streaming.
			pi.sendUserMessage(
				`User invoked /context-onboard. ${onboardProcedure} This is the only task for this turn — do not skip.`,
				{ deliverAs: "followUp" },
			);
		},
	});

	// ---------------------------------------------------------------
	// Command: /context-evolve — force a doc evolution pass.
	// ---------------------------------------------------------------
	pi.registerCommand("context-evolve", {
		description: "Force a context-evolve pass: analyze usage signals and improve the doc",
		handler: async (_args, ctx) => {
			pi.sendUserMessage(`User invoked /context-evolve. ${evolveProcedure}`, {
				deliverAs: "followUp",
			});
		},
	});
}
