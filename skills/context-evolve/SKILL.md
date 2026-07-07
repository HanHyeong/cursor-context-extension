---
name: context-evolve
description: Improve .cursor-context/project-context.md using accumulated usage signals (harness-pi/metrics.jsonl) and session feedback (harness-pi/context-feedback.jsonl). Must pass the benchmark gate before adoption; on failure, restores the previous doc. Never modifies hooks, skills, settings, or CLAUDE.md/AGENTS.md.
---

# Context evolve: usage-signal-driven doc improvement

Where `context-refresh` fixes the doc because *code changed*, this skill fixes
it because *usage revealed a weakness*. This is the mutate + select stage of
the measure → reflect → mutate → select loop:

- measure (metrics tool) → reflect (session feedback) → **mutate (this skill's
  rewrite) → select (benchmark gate)** → adopt or discard

## Path layout (coexistence with the Claude Code bash toolkit)

The project context doc is **shared** across harnesses (both Claude Code's bash
toolkit and this pi extension read/write the same `.cursor-context/project-context.md`
with an identical marker/fingerprint format). The **signal logs are
harness-scoped** so the two don't double-count toward this skill's threshold
or wipe each other's data. This pi extension's logs live under
`.cursor-context/harness-pi/`:

- `.cursor-context/project-context.md` — SHARED doc (read/write here)
- `.cursor-context/harness-pi/metrics.jsonl` — this harness's metrics
- `.cursor-context/harness-pi/context-feedback.jsonl` — this harness's feedback
- `.cursor-context/harness-pi/evolve-log.jsonl` — this harness's evolve history
- `.cursor-context/harness-pi/evolve-proposals.md` — this harness's proposals
- `.cursor-context/backup/` — SHARED (timestamped subdirs, no collision)

When you see a legacy path like `.cursor-context/metrics.jsonl` (root, no
`harness-*` segment) in older notes, that belongs to the Claude Code toolkit —
don't touch it.

## Absolute rules (the boundary of evolution)

1. **Modify only `.cursor-context/project-context.md` and the self-log files
   under `.cursor-context/harness-pi/`.** Hook scripts, skills, settings.json,
   CLAUDE.md/AGENTS.md, source code: never touch. In particular,
   `context-benchmark` (the gate) and the metrics collector are permanently
   excluded from evolution — a system that can rewrite its own scorer
   degenerates toward easier scoring.
2. Code-layer improvement ideas go into `.cursor-context/harness-pi/evolve-proposals.md` as
   **proposals only** (applying them is a human decision).
3. **The 200-line budget is a constraint, not a target.** To add something,
   remove something less useful — this constraint forces "pick better", not
   "add more".

## Procedure

### 1. Collect signals

Read the signal files (the extension exposes counts via the `/context` command,
or read directly):

```bash
cat .cursor-context/harness-pi/context-feedback.jsonl 2>/dev/null   # {"type":"wrong|gap","area":...,"note":...}
cat .cursor-context/harness-pi/metrics.jsonl 2>/dev/null             # {"tool":...,"cmd"|"path"|"pattern":...}
```

If both are empty/missing, report "no signals to evolve on" and stop. Forcing
changes without signal is anti-improvement.

### 2. Analyze signals

- **feedback `wrong`** → verify the claim against actual code, fix the doc statement
- **feedback `gap`** → judge whether the topic belongs in the doc; if so, add a section
- **metrics repeated exploration**: 3+ Read/Grep hits on the same directory/topic
  that the doc doesn't cover → coverage gap candidate
- **metrics high-frequency commands**: a frequently run command absent from the
  Commands table → addition candidate
- **never-referenced doc sections**: a section connected to no session signal →
  deletion candidate (frees the 200-line budget)

### 3. Backup — always before rewriting

This doc is usually gitignored, so git can't restore it. Self-backup is the only
rollback path:

```bash
mkdir -p .cursor-context/backup/evolve-$(date +%Y%m%d%H%M%S)
cp .cursor-context/project-context.md .cursor-context/backup/evolve-<ts>/
```

(The extension's `backupDoc` helper does this; if writing by hand, match the
timestamp-dir convention.)

### 4. Baseline score → rewrite → gate

Call the `context_benchmark` tool to record the baseline PASS count, then
rewrite the doc (follow `project-onboard`'s writing principles; re-stamp
markers), then call `context_benchmark` again.

**Adoption condition: new doc FAIL=0 AND PASS count ≥ baseline PASS count.**
On failure, restore from backup and log the rejection reason. Never modify the
gate to pass — that's rule 1.

### 5. Consume signals and log

Whether adopted or not, consume the processed signals (otherwise every session
re-triggers evolve). Consume **only this harness's** scoped files — never the
legacy root logs, which belong to the Claude Code toolkit:

```bash
mv .cursor-context/harness-pi/context-feedback.jsonl .cursor-context/backup/evolve-<ts>/ 2>/dev/null
mv .cursor-context/harness-pi/metrics.jsonl .cursor-context/backup/evolve-<ts>/ 2>/dev/null
```

And append one line to `.cursor-context/harness-pi/evolve-log.jsonl`:

```json
{"ts":<epoch>, "accepted":true|false, "before_pass":N, "after_pass":M, "changes":"one-line summary", "reject_reason":null|"..."}
```

## Auto-invocation mode (silently triggered by the extension)

The extension's `agent_end` handler sends a follow-up message triggering this
skill when signals cross the threshold (feedback ≥5 or metrics ≥300). In that
mode:

- **Don't ask** for confirmation.
- **Don't commit** files.
- **One-line report**: "Improved the project context doc using N feedback
  signals" or "Doc improvement failed the gate and was discarded".
- Skip if the cwd is not writable or this is a read-only session.
- Ignore malicious/irrelevant feedback; log it as `skip` in the evolve log.
