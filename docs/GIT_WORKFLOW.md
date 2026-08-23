# Git and GitHub Workflow

GitHub is both the project's history and its actual version-control workflow, not just a place
the finished project gets uploaded. This document is the operational reference; the corresponding
standing rules for Claude sessions live in [CLAUDE.md](../CLAUDE.md).

---

## 1. `main` is stable

`main` represents tested, working project state at all times. Every push to `main` triggers CI
(`.github/workflows/ci.yml`); `main` should never be red for longer than it takes to notice and
fix.

## 2. Normal workflow: branch → PR → CI → merge

```
main
  ↓
feature/milestone branch
  ↓
coherent commits
  ↓
push
  ↓
Pull Request
  ↓
CI (typecheck, lint, format, domain tests, build, secret scan, database + authorization tests)
  ↓
review
  ↓
merge
  ↓
main stable again
```

Routine implementation and milestone work happens on a branch, never as direct commits to `main`.
Branch names are short and descriptive of the milestone or fix:
`feat/m3-database-rls`, `fix/allocation-rounding`, `docs/testing-strategy`.

## 3. Commits

- Conventional prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`.
- Coherent units of work — not one giant commit for a whole milestone, not dozens of trivial
  ones. A commit should be reviewable on its own: "add the schema", "add the tests", "add the
  docs" rather than "wip", "fix typo", "actually fix it".
- `pnpm check` passes before any commit that touches source.
- Review the staged diff for secrets, personal data and machine-specific paths before every
  commit.
- No AI, Claude, Anthropic or co-author attribution in commit messages or PR descriptions — see
  CLAUDE.md "Repository contents".

## 4. Pull requests

Each meaningful unit of work — typically a milestone — gets one PR. The description summarizes
what changed and why in plain engineering terms: what was built, what it depends on, what was
tested, what remains manual/outstanding. It never frames the work as AI-generated or references a
prompt cycle; the repository documents the project, not the conversation that produced it (see
CLAUDE.md "Repository contents").

CI must be green before merge. If CI fails, fix the underlying issue — do not disable the check,
skip the job, or merge with `--admin`/force overrides to route around a red gate.

## 5. Merge strategy

**Squash merge.** One PR becomes one commit on `main`, carrying the PR's title and a summary of
its description. This keeps `main`'s history readable as a sequence of milestones rather than a
sequence of every intermediate commit made while developing one. The source branch is deleted
after merge. This matches how M1/M2 landed (PR #1, squash-merged, branch deleted) and is the
default going forward unless a specific PR has a concrete reason to preserve its individual
commits (rare; state the reason in the PR if so).

## 6. Branch protection

The repository is private, and GitHub Pro (needed for private-repo branch protection rules) is
not purchased for this reason alone — see [COST_POLICY.md](COST_POLICY.md). Branch protection is
therefore enforced by *process*, not by GitHub configuration: every session follows this document,
CI is the gate, and direct pushes to `main` are the documented exception (§7), not the norm. If
free GitHub capabilities change later, revisit; no payment is authorized for this.

## 7. Emergency exception: direct push to `main`

Rare, and each instance should be justified in the commit message or immediately after in
HANDOVER.md. Legitimate cases: a one-line documentation typo fix, an urgent secret-rotation
follow-up, or a CI configuration fix needed to unblock every other PR. Not legitimate: routine
implementation work, "it was faster than opening a PR", or finishing a milestone's remaining
documentation after its feature PR already merged (this repeated the previous milestone's mistake
once already — see HANDOVER.md history — and should not recur).

## 8. Releases and tags

No release is cut per milestone. Git commits and PRs are the development history; a release
represents an actual user-testable build. Once a genuinely usable application exists (working
auth, add/track a card, see collection value), semantic-style tags become appropriate —
`v0.1.0-alpha` for the first such checkpoint, then incrementing meaningfully. GitHub Releases
attach notes to those tags. Until then: no tags, no releases.

## 9. What never gets committed

- `ai_outputs/` — the per-model mentor-handoff channel (`ai_outputs/Claude_outputs/`,
  `ai_outputs/Ox_Alpha_outputs/`). Gitignored; verify with `git check-ignore` on any commit that
  touches `.gitignore`.
- `ai_outputs/sequence_state.txt` — global cross-model session-sequencing state, gitignored
  alongside the archive.
- Any chat transcript, prompt text, or reference to the prompt cycle that produced a piece of
  work. The repository documents the project, not the conversation.
- Secrets of any kind — see [SECURITY.md](SECURITY.md) §6 and [COST_POLICY.md](COST_POLICY.md).

## 10. Database migrations specifically

Migrations are part of the same branch → PR → CI workflow, with one addition: CI applies every
migration to a fresh ephemeral database and runs the authorization suite against it
(`.github/workflows/ci.yml`, `db-tests` job) before the PR can merge — see
[DEVELOPMENT.md](DEVELOPMENT.md) §4 for the local/CI split. A migration is never applied by hand
to a database holding real data outside this workflow; see DEVELOPMENT.md's migration rules for
the full discipline.
