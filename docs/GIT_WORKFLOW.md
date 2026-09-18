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

**This describes GitHub's own gate on `main`'s content — a separate, unrelated question is whether
Production actually only ever serves a SHA that passed that gate. It currently does not: see §11.**

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

## 11. Production deploy gate (Cloudflare) — P130-08, status OPEN

**GitHub CI passing is not the same thing as Production serving CI-approved code, and nothing in
this repository can make it the same thing.** This section states the current mechanism precisely,
why a repo-only fix cannot close it, and the exact owner action that would.

**Current mechanism, verified.** Cloudflare Pages' GitHub App is connected directly to this
repository (DEVELOPMENT.md §9). It listens to the same `push` webhook GitHub sends to trigger
`.github/workflows/ci.yml`, independently of it: Cloudflare starts `pnpm build` and deploys the
result the moment the webhook fires, and GitHub Actions starts the `CI` workflow (typecheck, lint,
tests, a full ephemeral-database suite — several minutes) from that same event. There is no
`workflow_run`, required-status-check, or any other ordering primitive between them — they are two
independent consumers of one webhook. P129 measured Production's `/build-meta.json` updating
30-45 seconds after a merge; `db-tests` alone takes several minutes. **A push to `main` that fails
CI has already been live on Production for minutes by the time CI reports red.** `main` being
"stable" by §1 of this document describes intent and review discipline, not an enforced technical
guarantee — see P130-08's own severity note (MEDIUM: the mechanism is certain, the exact current
dashboard toggle state is not independently re-verifiable from this session, and no live exploit
was found — the risk is operator error or a compromised GitHub account shipping untested code to
the real ledger, not an external attacker).

**Why this branch cannot fix it.** Every lever that would actually change this behaviour —
disconnecting automatic Production deploys, changing which branch Cloudflare treats as Production,
issuing a scoped API token, adding a GitHub Actions secret — lives in the Cloudflare dashboard or
GitHub repository settings, never in a file this session can commit. A workflow file alone cannot
make Cloudflare wait for it. This is stated here rather than silently worked around, per this
project's honesty bar: a "gate" implemented only in `.github/workflows/*.yml` while Cloudflare's
Git integration remains untouched is not a gate, it is a workflow that runs in parallel with an
unrelated deploy and would give a false sense of safety.

**Target architecture ($0, matches §11's preferred shape):**

```
PR → required CI → merge main → main CI (exact SHA) → explicit gated Production deploy of that
SHA (only after CI succeeded) → post-deploy verifier (scripts/deployment-check.mjs)
```

**Owner action required, in order — none of this can be done from this branch:**

1. **Cloudflare dashboard:** Pages project → Settings → Builds & deployments → turn OFF automatic
   deployments for the Production branch (`main`). This is the one step that actually closes the
   race; every step after it is what replaces the convenience that step removes.
2. **Cloudflare dashboard:** create an API token scoped to `Cloudflare Pages:Edit` for this one
   project only (Account → API Tokens → Create Token → "Edit Cloudflare Workers" template narrowed
   to Pages, or the dedicated Pages template if offered). Free on every plan; no billing surface.
3. **GitHub repository settings:** add that token as a repository secret
   (`CLOUDFLARE_API_TOKEN`) — Settings → Secrets and variables → Actions. **Never commit it, never
   put it in `.env.example`, never paste it into a session transcript or this document.**
4. **A new gated workflow**, added in a future session once step 1-3 are done (deliberately not
   added in this one — see below): triggered by `workflow_run` on the `CI` workflow's completion
   for `main`, `if: github.event.workflow_run.conclusion == 'success'`, running
   `pnpm build` against the exact SHA CI just validated and `npx wrangler pages deploy dist
   --project-name=pokeportfolio-dev --branch=main --commit-hash=<that SHA>`, then
   `scripts/deployment-check.mjs` against the live result as the last step — a deploy CI did not
   gate, or a deploy nothing re-verified afterward, is not what this section asks for.

**Why no such workflow file is added in this PR.** A workflow that references
`secrets.CLOUDFLARE_API_TOKEN` before step 2-3 exist is inert (the deploy step fails closed with a
missing-secret error, never a silent no-op deploy) — safe to add. But a workflow that *is* wired up
correctly, sitting on a branch alongside Cloudflare's automatic deploy still enabled (step 1 not
yet done), would create a NEW risk this repository does not have today: two independent deploy
paths racing each other instead of one. Landing the workflow is only safe as the immediate next
action after step 1, in the same short window, not as a standalone PR that then waits. This is
recorded here as the concrete design and exact next step, not implemented speculatively.

**Status:** `P130_08_REPO_PREPARED=yes` (this document + the target design exist; CI itself is
already a real, if unconnected, gate). `P130_08_EXTERNAL_CLOUDFLARE_ACTION_REQUIRED=yes`.
`P130_08_STATUS=OPEN` — it can only close once step 1 above has actually happened, verified by the
absence of a new Production build-meta SHA within seconds of a push (rather than only after the
gated workflow completes).

## 12. Preview deployments and the Production Supabase project — P130-08/P130-47, status OPEN

DEVELOPMENT.md §9 states "preview deployments off." That is not what a live, read-only check found
in this same P139 session: `https://preview-m15-8a470db.pokeportfolio-dev.pages.dev` (a Cloudflare
Pages preview from the M15 release cycle) is still reachable today (`HTTP 200`), and its served
Content-Security-Policy names `connect-src ... https://nopmkroeygmlvndzjjqs.supabase.co` — byte-
identical to Production's own live CSP, fetched the same way in the same session. Whatever the
dashboard's current toggle for *new* preview builds is, at least one *old* preview build is live,
publicly reachable, and configured to read and write the real Supabase project through ordinary
RLS-scoped authenticated calls exactly like Production. Cloudflare Pages does not expire preview
deployments on its own; an old preview stays live until someone deletes it.

**Risk, scoped honestly.** RLS still applies — a preview build cannot read or write another user's
rows, and no cross-tenant defect is claimed here. The risk is: (a) an old preview may be serving
stale, less-hardened client code indefinitely against the live database, and (b) if preview builds
for new branches are still being created (not independently re-verified without pushing a branch,
which this session did not do), an unreviewed work-in-progress branch's authenticated writes would
land in the real ledger, not a sandbox — the same category of concern as §11, one layer down.

**$0-compatible remedies, owner decision required (do not spend, do not create new infrastructure
without approval per COST_POLICY.md):**
- **Preferred:** Cloudflare dashboard → Settings → Builds & deployments → Preview deployments →
  disable entirely (or restrict to no branches). Matches what the docs already claim is true; makes
  it actually true.
- **Alternative if previews are wanted for review:** point preview builds' `VITE_SUPABASE_URL` at a
  second, free-tier Supabase project used only as a read-mostly/placeholder target — a genuinely
  new piece of infrastructure, so it needs the owner's explicit sign-off against COST_POLICY.md §1a
  before any session sets it up, not a default this document authorizes on its own.
- Either way: delete the specific stale preview named above once the owner has seen this finding —
  a delete is a one-click Cloudflare dashboard action, not a `git push`, and is not performed here
  without that explicit go-ahead.

**Status:** `PREVIEW_PRODUCTION_DB_STATUS=CONFIRMED_LIVE_TODAY` (re-verified this session, not
inherited from P130). `PREVIEW_MUTATION_RISK=LOW_BUT_UNMITIGATED` (RLS holds; the gap is process,
not a demonstrated exploit). `PREVIEW_SAFETY_DESIGN` = the two options above, owner to choose.
