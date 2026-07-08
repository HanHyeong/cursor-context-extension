# cursor-context for pi

**Cursor-grade automatic project context awareness for [pi](https://pi.dev).** Zero-touch, real-time, and honest about what it knows.

A pi extension + 3 skills that recreate Cursor IDE's automatic project-context experience using pi's event system. The agent already knows your stack, structure, commands, and what your branch is working on *before* you type your first prompt — and the generated context doc stays fresh via content fingerprints compared against the live working tree.

This is a port and redesign of the [cursor-context](https://github.com/HanHyeong/cursor-context) toolkit (originally built for Claude Code with bash hooks) to pi's extension model.

| Cursor feature | This extension's counterpart |
|---|---|
| Background codebase index | `.cursor-context/project-context.md` — auto-generated doc, injected every session via `before_agent_start` |
| Merkle-tree change detection | Content fingerprints (sha256) compared against the **live working tree** |
| Index refresh on save | 3-tier auto-refresh: on noticed discrepancy / on structural fingerprint change / 20-commit backstop |
| `.cursorrules` | `CLAUDE.md` / `AGENTS.md` — **user-owned, never touched** |
| Per-query semantic code search | Delegated to pi's native agentic search (Grep/Glob/bash) |

---

## How it works

The extension is a single TypeScript module (`src/index.ts`) loaded via [jiti](https://github.com/unjs/jiti), plus 3 markdown-driven skills in `skills/`. Logic is split across focused modules:

| Module | Role |
|---|---|
| `src/index.ts` | Extension entry: event handlers (`session_start`, `before_agent_start`, `tool_call`, `tool_result`, `agent_end`), custom tools, commands |
| `src/config.ts` | Constants, paths, env-flag options, legacy-log migration |
| `src/git.ts` | Single source of truth for fingerprinting, git/fs helpers, freshness verdict |
| `src/snapshot.ts` | Project-context snapshot builder (stack/tree/git/branch-intent) |
| `src/metrics.ts` | Metrics collector, feedback log, evolve gate threshold |
| `src/doc.ts` | Doc write/markers, gitignore enforcement, command verification |
| `src/benchmark.ts` | Deterministic quality gate (length/markers/commands/paths) |
| `skills/project-onboard/SKILL.md` | Full doc generation procedure |
| `skills/context-refresh/SKILL.md` | Incremental doc update procedure |
| `skills/context-evolve/SKILL.md` | Usage-signal-driven doc improvement procedure |

### Lifecycle mapping (Claude Code bash hooks → pi events)

| Claude Code hook | pi event | What it does |
|---|---|---|
| SessionStart | `session_start` | Compute freshness, set footer status, ensure `.gitignore`, migrate legacy logs |
| UserPromptSubmit | `before_agent_start` | Inject snapshot + freshness verdict + standing rules (per prompt) |
| PostToolUse | `tool_call` | Append tool-usage metric (in-process, sub-ms) |
| PostToolUse | `tool_result` | Track code-change/exploration signals for auto-onboard (non-error results only, so blocked/failed edits don't count) |
| Stop (evolve gate) | `agent_end` | No doc + substantive session → follow-up triggering onboard; signals over threshold → follow-up triggering evolve |

### Freshness verdict (single source of truth)

`freshnessVerdict()` in `src/git.ts` returns a discriminated union instead of exit codes:

```typescript
type FreshnessVerdict =
  | { kind: "fresh" }
  | { kind: "stale"; changed: readonly string[] }
  | { kind: "unverifiable"; reason: string }
  | { kind: "no-doc" };
```

Both the `session_start` cache and the per-prompt `before_agent_start` recompute call this. No drift risk — the bash version re-implemented the comparison in 3 scripts.

## Platform support

Developed and runtime-verified on macOS (real `pi` sessions, both `-p` and
`--mode rpc`, driving the actual onboard/freshness flow end to end). Linux is
expected to work identically — same `git` CLI, same Node `crypto` module,
same POSIX paths — but has not been separately verified.

**Windows is untested.** The code is written to avoid the classic
`path.sep`-based bug: directory-structure hashing and the directory-tree
snapshot split paths on `"/"` rather than `path.sep`, because `git ls-files`
always emits forward slashes regardless of OS (see `src/git.ts`). So it is
*expected* to behave correctly, but nobody has actually run this extension on
Windows. Treat freshness detection as unverified there until someone confirms
it — please file an issue with what you find either way.

## Install

### From a local checkout

```bash
git clone <this-repo> cursor-context-extension
cd cursor-context-extension
npm install        # installs type-only devDeps (no build step; loaded via jiti)
```

There is no build step — pi loads `src/index.ts` directly via [jiti](https://github.com/unjs/jiti). `npm run check` runs `tsc --noEmit` for type checking only.

Then either:

**Project-local** (per-project): add to `.pi/settings.json`:
```json
{
  "extensions": ["/absolute/path/to/cursor-context-extension"]
}
```

**Global** (all projects): add to `~/.pi/agent/settings.json`:
```json
{
  "extensions": ["/absolute/path/to/cursor-context-extension"]
}
```

**Or via `pi -e` for a quick test:**
```bash
pi -e /path/to/cursor-context-extension
```

### As a pi package (future)

Once published to npm or a git tag:
```bash
pi install npm:pi-cursor-context
# or
pi install git:github.com/<user>/cursor-context-extension@v0.1.0
```

## What happens after install

1. **Every session start** — the extension's `session_start` handler computes a freshness verdict and sets a footer status. On the first prompt, `before_agent_start` injects a compact snapshot:
   - Detected stack (Node/Python/Go/Rust/Java/…), package manager, frameworks, npm scripts
   - Directory tree (depth 2, tracked files)
   - Git state: branch, recent commits, uncommitted changes
   - **Branch intent**: `diff --stat` of your branch vs the default branch
   - The generated project doc (markers stripped, ≤250 lines) plus a freshness verdict
2. **On every prompt** — `before_agent_start` re-runs the (cheap) fingerprint comparison. If nothing changed, the doc section simply says "verified fresh" (minimal token cost). If something changed — even uncommitted edits, rollbacks, rebases, or branch switches — the agent is told exactly what differs, told not to trust the affected doc sections, and told to silently refresh after finishing.
3. **No doc yet** — on the first substantive task (or when you ask about the project itself), the agent silently generates the doc via the `project-onboard` skill. A deterministic backstop fires at turn end: if no doc exists and the session changed code (edit/write), a follow-up message forces the generation, retried once more if the first attempt doesn't produce a doc (max 2 attempts). If the session instead only did enough exploration (5+ read/grep/find/ls/bash calls, no edits — e.g. a question-only session), one follow-up fires but may be legitimately declined (e.g. pure code review), so it is not retried. Interactive TUI/RPC sessions only — `print`/`json` one-shot modes never auto-generate. Disable with `CURSOR_CONTEXT_NO_ONBOARD=1`.

## Manual commands

| Command | Description |
|---|---|
| `/context` | Show freshness status and signal counts |
| `/context-onboard` | Force full doc regeneration (runs `project-onboard` skill) |
| `/context-evolve` | Force an evolution pass (runs `context-evolve` skill) |
| `/skill:project-onboard` | Run the onboarding skill directly |
| `/skill:context-refresh` | Run an incremental refresh directly |
| `/skill:context-evolve` | Run an evolution pass directly |

## Custom tools (callable by the LLM)

These tools are registered by the extension so the agent can drive doc maintenance deterministically:

| Tool | Purpose |
|---|---|
| `context_write_doc` | Write the doc from a markdown body — markers (HEAD sha + fingerprint block) are stamped deterministically and `.cursor-context/` is gitignored; the model never hand-writes the header |
| `context_refresh` | Compute current fingerprint, diff vs stored, return changed items + HEAD sha (stamping itself is `context_write_doc`'s job) |
| `context_benchmark` | Run the deterministic doc-quality gate (length, markers, command/path existence) |
| `context_evolve_checkpoint` | Backup the doc before an evolve rewrite, restore it on a gate FAIL, and consume signal logs once the outcome is decided |
| `context_feedback` | Append a `wrong`/`gap` feedback signal for the evolve loop |

The `context_feedback` tool's `type` param accepts `wrong` (doc stated something incorrect) or `gap` (doc omitted something that required real exploration).

## Environment flags (power users)

| Flag | Effect |
|---|---|
| `CURSOR_CONTEXT_NO_METRICS=1` | Disable the metrics collector (`tool_call` logging) |
| `CURSOR_CONTEXT_NO_EVOLVE=1` | Disable the evolve gate (no auto-trigger) |
| `CURSOR_CONTEXT_NO_ONBOARD=1` | Disable auto-onboarding (no silent doc generation) |
| `CURSOR_CONTEXT_BENCH=1` | Internal: marks a benchmark run so metrics aren't contaminated (does not affect onboard/evolve triggering) |

The `NO_*` flags are read once when the extension loads — changing them
mid-session has no effect; restart pi.

## Freshness model (why you can trust what's injected)

Staleness is judged by **content, not commit counts**. The doc stores sha256 fingerprints of structural files plus a directory-layout hash; the extension recomputes them against the working tree at session start and on every prompt.

- Uncommitted manifest edits are caught immediately
- Rebases, squash merges, hard resets, branch switches — all detected; rolling back to the documented state makes the fingerprint match again, so no wasted refresh
- Scratch files inside existing directories do **not** trigger false "structure changed" alarms (only structural files and top-level directories are fingerprinted)
- Untracked files under `.cursor-context/` are excluded from the fingerprint, so generating the doc (or gitignoring the directory afterwards) can never mark the doc stale on its own; tracked files there (team-share mode) still count, keeping the hash comparable with the coexisting bash toolkit
- If verification is impossible (no structural files, no markers), the extension says so — it never claims "verified" when it isn't

Priority rules are injected alongside everything: **live code beats the doc, and your `CLAUDE.md`/`AGENTS.md` beats both.**

## Self-evaluation and evolution

The extension learns from how it gets used (measure → reflect → mutate → select):

- **Measure (deterministic, zero tokens)** — `tool_call` logs tool usage to `.cursor-context/harness-pi/metrics.jsonl` (fields truncated, auto-rotated at 2,000 lines). Pure code: the LLM cannot bias its own measurements. Captured at `tool_call` time (not `tool_execution_end`) because tool input is available only at call time, so intent is recorded even if a call is later blocked.
- **Reflect (near-zero cost)** — a standing rule injected every turn: if the doc was wrong or missing something that required real exploration, the LLM logs one JSON line to `.cursor-context/harness-pi/context-feedback.jsonl` after finishing.
- **Evolve (gated)** — once enough signal accumulates (5 feedback entries or 300 metric lines), `agent_end` sends a follow-up message that runs the `context-evolve` skill. The gate only triggers in TUI/RPC modes when the cwd is writable.
- **Select (deterministic gate)** — before a new doc is adopted, `context-benchmark` lints it: line budget, marker/fingerprint validity, every mentioned `npm run`/`make` command must actually exist, mentioned paths should exist. **FAIL = the old doc is restored from backup.**

Code-layer improvement ideas are only ever *proposed* (`.cursor-context/harness-pi/evolve-proposals.md`) — applying them is a human decision. Evolution history lives in `.cursor-context/harness-pi/evolve-log.jsonl`.

## Improvements over the original bash toolkit

This port fixes several issues identified during review of the original `cursor-context`:

1. **Single fingerprint source** — the bash version re-implemented fingerprint comparison in `session-context.sh`, `prompt-freshness.sh`, and `context-benchmark.sh`. This port centralizes all fingerprint logic in `src/git.ts` (`computeFingerprint` / `diffFingerprints` / `freshnessVerdict`); hooks and skills call it. No drift risk.
2. **No per-tool python3 spawn** — the bash `metrics-collector.sh` started a python3 interpreter on every PostToolUse call (~15–30 ms each, hundreds of times per long session). This port writes a single JSON line via `fs.appendFileSync` in-process (sub-millisecond).
3. **Honest evolve gate** — the bash `evolve-gate.sh` used `exit 2` to block turn end, claimed as "deterministic enforcement". In practice it relied on the model complying with "skip in plan mode" instructions. This port checks `ctx.mode` and cwd writeability directly, and uses a follow-up message (honest about being non-blocking) rather than pretending to block. The bash version's `0\n0` counting bug (worked around with awk) is also eliminated by a wc-free line counter.
4. **Accurate framework detection** — the bash version used `grep -q "\"$fw\"" package.json`, so `next` matched `next-auth`. This port matches manifest keys (`"${fw}"\s*:`), fixing the false positive.
5. **Typed freshness state** — the bash version used exit code 3 to mean "unverifiable", conflating "no hash tool" with "no markers". This port uses a discriminated union (`fresh` / `stale` / `unverifiable` / `no-doc`), making "can't verify" an honest first-class state.
6. **Cross-platform hashing** — no `sha256sum` vs `shasum` fallback needed; Node's `crypto` module provides sha256 everywhere pi runs. This covers hashing only, not the whole extension — see [Platform support](#platform-support) for the untested-on-Windows caveat.

## Overhead

| Metric | Small project | Large project |
|---|---|---|
| session_start handler | <100 ms | <200 ms |
| Per-prompt (before_agent_start) | ~30–50 ms (recompute fingerprint) | ~40–80 ms |
| Per-tool (tool_call) | <1 ms (in-process) | <1 ms |
| Token cost when nothing changed | minimal ("verified fresh" line) | same |
| Token cost when changed | alert + affected items list | same |

Scaling is dominated by `git ls-files`, so even 50k-file monorepos stay well under a second.

## Coexistence with the Claude Code bash toolkit

Both this extension and the original [cursor-context](https://github.com/HanHyeong/cursor-context)
bash toolkit (built for Claude Code) write inside the same `.cursor-context/`
directory. That is intentional and safe by design:

| Path | Shared? | Why |
|---|---|---|
| `project-context.md` | **shared** | Describes the project, not the harness; marker/fingerprint format is identical so either side can refresh and the other reads it as fresh |
| `backup/` | **shared** | Timestamped subdirs (`evolve-<ts>/`) never collide |
| `harness-pi/metrics.jsonl` | pi only | Usage is measured per-harness to avoid double-counting toward the evolve threshold |
| `harness-pi/context-feedback.jsonl` | pi only | Same reason — one harness's `consumeSignals` must not wipe the other's data |
| `harness-pi/evolve-log.jsonl` | pi only | Per-harness evolution history |
| `harness-pi/evolve-proposals.md` | pi only | Per-harness proposals |
| `metrics.jsonl` (root), `context-feedback.jsonl` (root), … | Claude Code only | The bash toolkit keeps its legacy root paths untouched |

On the first pi session in a project that previously only used the bash toolkit,
`session_start` idempotently migrates any legacy root-level `metrics.jsonl` /
`context-feedback.jsonl` into `harness-pi/` so prior signal isn't lost. The bash
toolkit is never modified.

## Safety guarantees

- `CLAUDE.md` / `AGENTS.md` are strictly user-owned: read, never written
- Auto-generated/refreshed files are left **uncommitted** for review (auto-added to `.gitignore`; skipped when the doc is deliberately committed — team-share mode)
- All hooks degrade gracefully: missing files, missing git, unwritable dirs → the extension says so honestly and continues
- Extension config via env flags is purely additive — disabling a feature never breaks the rest
- Coexistence with the bash toolkit is non-destructive: pi never touches the bash toolkit's root log paths, and migration is a one-time idempotent move with a fallback to copy+truncate if the root file is held open

## Uninstall

Remove the entry from `settings.json` `extensions`, or:

```bash
rm -rf .cursor-context    # project-local data
# remove the extension directory or settings entry
```

To disable a subsystem without uninstalling (e.g. in CI), set the relevant env flag instead:

```bash
export CURSOR_CONTEXT_NO_ONBOARD=1   # no silent doc generation
export CURSOR_CONTEXT_NO_EVOLVE=1    # no auto evolve trigger
export CURSOR_CONTEXT_NO_METRICS=1   # no usage logging
```

## License

MIT
