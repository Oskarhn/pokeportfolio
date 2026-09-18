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

## 11. Production deploy gate (Cloudflare) — P130-08, status OPEN (workflow implemented, P142)

**GitHub CI passing is not the same thing as Production serving CI-approved code, and nothing in
this repository can make it the same thing by itself.** This section states the current mechanism
precisely, what P142 actually implemented, and the exact owner action still required to make it
the live deploy path.

**Current mechanism, verified (re-verified P142; unchanged since P139).** Cloudflare Pages' GitHub
App is connected directly to this repository (DEVELOPMENT.md §9). It listens to the same `push`
webhook GitHub sends to trigger `.github/workflows/ci.yml`, independently of it: Cloudflare starts
`pnpm build` and deploys the result the moment the webhook fires, and GitHub Actions starts the
`CI` workflow (typecheck, lint, tests, a full ephemeral-database suite — several minutes) from that
same event. There is no `workflow_run`, required-status-check, or any other ordering primitive
between them — they are two independent consumers of one webhook. P129 measured Production's
`/build-meta.json` updating 30-45 seconds after a merge; `db-tests` alone takes several minutes.
**A push to `main` that fails CI has already been live on Production for minutes by the time CI
reports red.** P142 re-confirmed this is still exactly true today: immediately before this session,
`/build-meta.json` already reported the SHA of the P141 docs-only closeout commit — Cloudflare's
automatic deploy had already fired for it, exactly as this section predicts.

**What P142 implemented.** `.github/workflows/ci.yml` now has a `deploy-production` job:
`needs: [build-and-test, db-tests]`, `if: github.event_name == 'push' && github.ref ==
'refs/heads/main'` — structurally impossible to run on a pull request, a feature branch, or after
either required job fails (proven in `tests/config/workflow-deploy-gate.test.ts`, with mutation
tests for each of those properties). Before deploying it re-checks `origin/main` is still exactly
the SHA it was triggered for (`scripts/release-guard.mjs remote-main-current`, refuses safely
rather than deploying a stale SHA if `main` advanced during CI — `tests/config/deploy-guards.test.ts`
covers the pure logic) and, after its own Production build, that the built artifact declares
exactly that SHA (`scripts/release-guard.mjs build-identity`, rejects a `+dirty` build the same way
`scripts/lib/build-identity.mjs` already does for the bundle text). It then runs
`pnpm exec wrangler pages deploy dist --project-name=pokeportfolio-dev --branch=main
--commit-hash="$GITHUB_SHA" --commit-dirty=false` (wrangler is now a pinned exact-version
devDependency, `4.134.0` — not fetched ad hoc via `npx` on every run) and, on success, re-verifies
the LIVE result with the existing `scripts/preview-verify.mjs --sha` and
`scripts/deployment-check.mjs` (bounded retry for CDN propagation, the same idiom `db-tests` already
uses for "wait for a real service to come up"). The job has its own `production-deploy` concurrency
group with `cancel-in-progress: false` so a later push never cancels an in-flight Cloudflare
upload — "latest eligible `main` wins" is enforced by the exact-SHA re-check, not by cancellation.
Cloudflare credentials are referenced only inside this one job (asserted in the same test file) and
scoped to a `production` GitHub Environment.

**Why this alone does not close P130-08 yet.** Landing this workflow is safe with Cloudflare's
automatic deploy still enabled — it fails closed on the first missing secret/variable, never
produces a silent or racing second deploy — but it also does not yet DO anything: it cannot
succeed without credentials that do not exist in this repository. `gh secret list` and
`gh variable list` both returned empty during P142 (re-checked, not assumed from an earlier
session). **P130-08 remains OPEN, and the workflow above is not yet the live deploy path**, until
the owner does the following, still in order — none of it can be done from a branch:

1. **GitHub repository settings:** add the three ordinary (non-secret) build variables as
   repository or `production`-environment **variables** — Settings → Secrets and variables →
   Actions → Variables: `VITE_SUPABASE_URL` (the current Production value, already public in the
   live CSP — `https://nopmkroeygmlvndzjjqs.supabase.co`), `VITE_SUPABASE_PUBLISHABLE_KEY` (the
   current anon/publishable key — copy it from the Cloudflare dashboard's own build environment,
   Settings → Environment variables; it is not a secret, DEVELOPMENT.md §9, but this document does
   not restate its value). This step alone is harmless to do at any time — the deploy job cannot
   run on a PR regardless, and even on a `main` push it will still fail closed at the next step
   without the Cloudflare credentials.
2. **Cloudflare dashboard:** create an API token scoped to `Cloudflare Pages:Edit` for this one
   project only (Account → API Tokens → Create Token → the Pages-editing template, narrowed to
   this project if the UI offers it). Free on every plan; no billing surface. Note the account id
   too (Account Home → right sidebar).
3. **GitHub repository settings:** add that token as secret `CLOUDFLARE_API_TOKEN` and the account
   id as secret `CLOUDFLARE_ACCOUNT_ID`, scoped to the `production` environment — Settings →
   Environments → `production` → Environment secrets (this environment was created automatically
   the first time the workflow referenced it; if it does not yet exist, an ordinary repository
   secret under Settings → Secrets and variables → Actions works too, just without the extra
   environment-scoping). **Never commit either value, never put it in `.env.example`, never paste
   it into a session transcript or this document.**
4. **Cloudflare dashboard, only after 1-3 are done and a push has proven `deploy-production` green
   end to end:** Pages project → Settings → Builds & deployments → turn OFF automatic deployments
   for the Production branch (`main`). This is the step that actually removes the race — doing it
   before 1-3 are working would leave Production with no deploy path at all until they are.

**Status:** `P130_08_REPO_PREPARED=yes` (the workflow, its guard scripts and their regression tests
now exist and pass CI on their own PR — see the P142 session record). `P130_08_STATUS=OPEN` —
closes only once step 4 has actually happened, verified by a `main` push whose `deploy-production`
job is the one that updates `/build-meta.json`, at a timestamp strictly after both `build-and-test`
and `db-tests` succeeded, not within seconds of the push the way Cloudflare's current automatic
deploy does.

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

**P142 re-check:** the same URL was re-verified live (`HTTP 200`, same Production-connected CSP)
during P142, not merely inherited from P139. No Cloudflare credential existed anywhere in that
session's environment (no `wrangler login`, no API token, no GitHub secret) to attempt a delete
even with the owner's go-ahead, so this remains untouched — read-only GET only, not authenticated
into. Deleting it (or disabling automatic preview deployments) needs the same owner action §11
already lists (a scoped Cloudflare API token), so it is a natural companion step to §11's cutover
rather than a separate credential ask.

**Status:** `PREVIEW_PRODUCTION_DB_STATUS=CONFIRMED_LIVE_TODAY` (re-verified this session, not
inherited from P130). `PREVIEW_MUTATION_RISK=LOW_BUT_UNMITIGATED` (RLS holds; the gap is process,
not a demonstrated exploit). `PREVIEW_SAFETY_DESIGN` = the two options above, owner to choose.
