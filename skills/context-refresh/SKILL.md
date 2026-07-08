---
name: context-refresh
description: Incrementally update .cursor-context/project-context.md to match recent code changes. Use when the doc is stale or disagrees with actual code. For a full regeneration, use project-onboard instead. Never modifies CLAUDE.md/AGENTS.md.
---

# Context refresh: incremental doc update

Update `.cursor-context/project-context.md` in place — don't regenerate from
scratch. Only the parts that actually changed since the last generation get
rewritten. Like Cursor's incremental indexing: small, frequent refreshes beat
big batched ones.

## Three refresh modes (the extension tells you which via injected instructions)

1. **Micro-refresh**: you noticed a doc/code discrepancy during work. Fix just
   that part and rewrite via `context_write_doc` (it re-stamps the markers).
   Cost ≈ 0 (the knowledge is already in context).
2. **Structural refresh (fingerprint mismatch)**: the extension's
   `before_agent_start` reported specific changed items (manifest/CI/build
   config names, or `directory-structure`). Validate and rewrite only sections
   related to those items. The fingerprint is working-tree based, so uncommitted
   edits and rollbacks are included — don't dismiss a change just because it
   isn't in git history.
3. **Full incremental refresh (20-commit backstop)**: run the whole procedure.

## Re-stamping markers (all modes — skip and the extension keeps nagging)

Write the updated doc with the **`context_write_doc` tool**, passing the full
updated body (no header). It recomputes and prepends the current markers
(generated-at-commit sha + fingerprint block) automatically — never rebuild
the header by hand. The `context_refresh` tool tells you *what* changed
(`details.changed`) so you can scope the rewrite; `context_write_doc` does the
stamping.

Only if these tools are unavailable (e.g. a different harness sharing this
doc), use the manual header format documented in `project-onboard/SKILL.md`.

## Ownership rules (most important)

- **Modify only `.cursor-context/project-context.md`.**
- **Never modify CLAUDE.md / AGENTS.md unless the user explicitly asks.**

## Procedure

1. **Determine change scope**: read the generation commit from the doc header
   marker, see what changed since:

   ```bash
   LAST=$(sed -n 's/.*generated-at-commit: *\([0-9a-f]*\).*/\1/p' .cursor-context/project-context.md | head -1)
   git diff --stat "$LAST"..HEAD
   git log --oneline "$LAST"..HEAD
   ```

   **If the marker commit is absent from history** (post-rebase/squash —
   `git cat-file -e "$LAST"` fails), diff-based analysis is impossible. Switch
   to direct verification: compare each doc claim (command, structure,
   convention) against current code, then rewrite via `context_write_doc` so
   the marker is re-stamped and future refreshes are diff-based again.

2. **Impact analysis**: map changes to doc sections.
   - Manifest/CI changed → verify **Commands** (run changed commands to confirm)
   - Directories added/removed/moved → update **Architecture**
   - New pattern introduced (commit msg: refactor, migrate) → review **Conventions**
   - New env var/config file → update **Gotchas**

3. **Minimal edit**: fix only affected sections, then write the result via
   `context_write_doc` (re-stamps markers). Even if nothing changed, rewrite
   once so the extension doesn't re-flag it.

4. **Verify with the gate**: call the `context_benchmark` tool. If it reports
   FAIL, fix the reported issues (missing commands/paths, marker mismatch)
   before finishing.

5. **Report**: summarize what and why.

## Auto-invocation mode (silently triggered by the extension)

- **Don't ask** for confirmation.
- **Reuse this session's knowledge**: don't re-read files already read.
- **Don't commit** the file.
- **One-line report**: append "Refreshed project context doc." If only markers
  changed and the body is identical, say nothing.

## Decision criteria

- If changes are very large (100+ commits) or structure fundamentally shifted,
  do a full regeneration instead: read `../project-onboard/SKILL.md` (the
  project-onboard skill) and follow its procedure.
- If `.cursor-context/project-context.md` doesn't exist, this skill is wrong —
  follow `../project-onboard/SKILL.md` instead.
