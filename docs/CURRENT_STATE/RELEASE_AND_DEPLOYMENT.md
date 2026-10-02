# Release and deployment — current state

Authority: this file for current status; `HANDOVER.md` §1/§13/§14 for the summary;
`docs/GIT_WORKFLOW.md` for the durable branch/PR/CI conventions (unchanged).

## Released state

- `main` HEAD and the live Production frontend both serve `d8682e047b757f63673a63ac8185a4806d68cb98`
  ("docs(handover): close out P141 as released, hosted and live in Production (#111)"), confirmed
  via `git ls-remote origin refs/heads/main` and Production's own `/build-meta.json`
  (`builtAt 2026-09-18T08:22:20Z`) independently by both P159 and P160.
- Hosted Supabase project `pokeportfolio-dev` (eu-west-3): 104 migrations applied, 0 pending.
- There is no CI-enforced gate between a `main` merge and the Production deploy going live
  (**P130-08, still OPEN**). A merge to `main` does not automatically or verifiably deploy;
  closing this requires the P163 candidate below plus an owner-side Cloudflare action.
- `main` has no GitHub branch-protection rule and no repository rulesets (live-verified 2026-09-28,
  `gh api`) — matches `GIT_WORKFLOW.md` §6: protection is enforced by process, not GitHub
  configuration.

## Repository visibility — PUBLIC_BY_OWNER_CHOICE

`Oskarhn/pokeportfolio` is **public by the owner's explicit choice** (D-190, 2026-10-02). It is not a
blocker or a warning, and development branches are pushed after local checks
(`docs/GIT_WORKFLOW.md` §13). Earlier notes in this documentation set that called public visibility a
contradiction of `CLAUDE.md` are superseded. What public does **not** change:
- no credentials, Production configuration secrets, personal data, signing material or private
  backups are ever committed — secret scanning stays mandatory;
- GitHub Actions run logs and every pushed branch, diff and commit are world-readable, so a value
  that reaches a log is exposed (the reason the P163 gate keeps build values in repository secrets);
- the repository's public JS bundle carries the Supabase project ref and a `sb_publishable_` key by
  design; `main` merge and Production deploy keep their own gates.

Publication state and recommended (unapplied) branch protection:
`docs/CURRENT_STATE/GIT_PUBLICATION_PLAN.md`.

## Deployment-gate candidate: P163 (supersedes P142 + P160)

- Branch `fix/p163-integrated-ci-secret-gate`, SHA `4f6be7bee4a69f6c5807c7ab58c7c61ad7bca53e`.
- Integrates P142's CI-gated-deploy workflow with P160's build-time public-env/secret guard
  (rejects a build whose `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY` is secret-shaped,
  wrong host, or otherwise unsafe to inline into a public bundle).
- Its own report: `LOCAL_INTEGRATED_CANDIDATE_COMPLETE_TESTED_NOT_PUSHED`, **P130-08 still OPEN**
  until merged.
- **Blocked on:**
  1. An owner-side Cloudflare Pages dashboard action (confirming/correcting the production branch,
     auto-deploy setting, and preview-deployment policy — no session tool here can read or change
     Cloudflare Pages settings; the Cloudflare MCP connector available in this environment has no
     Pages tools at all, only Workers/D1/KV/R2/Hyperdrive).
  2. GitHub Actions capacity — **checked live 2026-09-28 (P183), still genuinely unverified.** No
     workflow has run at all since P159's 2026-09-24 billing/capacity observation — `gh run list`
     shows the newest run is still PR #112's, dated 2026-09-18 (`build-and-test` SUCCESS, `db-tests`
     FAILURE — a real test failure, not a capacity refusal), which predates P159's block and so
     proves nothing about it either way. **Re-check by actually pushing/triggering CI before relying
     on it**, do not assume either resolved or still-blocked from stale evidence. PR #112 itself is
     **still OPEN**, on `fix/p142-ci-gated-production-deploy` — the branch P163 supersedes; it was
     not closed by any session reviewed here (closing/superseding it is part of the integration
     work, not a documentation change — see `docs/CURRENT_STATE/GIT_PUBLICATION_PLAN.md`).

## Secret/variable finding (P159 → P160), still open

The GitHub Actions **variable** `VITE_SUPABASE_URL` holds a value shaped like a Supabase **secret
key** (`sb_secret_` prefix) rather than a URL, first found P159, still uncorrected as of P160's
last check (2026-09-24, `last updated 2026-09-19T23:16Z`). It has never been consumed by an actual
deploy run (no workflow run exists since the variable was created), so no build has inlined it
into a public bundle — but the value itself should be treated as exposed and rotated regardless
(P159 printed it once via `gh variable list`; P160 read it into a local process for
classification only, never printed or stored it). Owner actions: rotate the implicated Supabase
key, then correct the Actions variable to hold an actual URL. Full runbook:
`docs/security/P160_SECRET_INCIDENT_RUNBOOK.md` in the P160 worktree (not yet merged to `main`).

## Other local candidates awaiting integration

See `HANDOVER.md` §2 for the full table and `docs/PROJECT_STATE.json` for machine-readable
pointers. None of P149/P151/P156/P157/P163/P173/P175 share an integration branch; a proposed
integration order exists in P159's own `NEXT_RELEASE_ORDER` (in the P159 worktree, not yet
promoted to a canonical doc).

## P188 update (2026-10-02): what is now in the candidate line

`RELEASED_MAIN` = `d8682e047b757f63673a63ac8185a4806d68cb98` = Production. The local release
candidate `release/p188-cross-platform-rc` is **not released, not pushed, not merged** and Production
is unchanged. Rule: **the CI-gated deploy job, the public-build guard and the P130-19 fix are in the
candidate line, not in Production.**

- **P163 is integrated** into the candidate (`docs/release/P188_INTEGRATION_MATRIX.md`). Its
  deploy job runs only for a push to `refs/heads/main`, needs `build-and-test` and `db-tests`, reads
  its public build values from repository **secrets** (`PRODUCTION_SUPABASE_URL`,
  `PRODUCTION_SUPABASE_PUBLISHABLE_KEY`) and Cloudflare credentials from secrets, runs the public
  configuration guard before installing or building, and refuses a stale run. It still needs the
  owner's Part A in `docs/security/RELEASE_PREFLIGHT_P163.md` before it can become the live path, so
  **P130-08 is PARTIALLY_CLOSED, not closed**.
- **Feature-branch CI (P188):** `ci.yml` also triggers on pushes to `release/**`. Those runs execute
  the same `build-and-test` and `db-tests` jobs and can never deploy: `deploy-production` requires a
  push to `main`, and the validation jobs read no Production secret
  (`tests/config/workflow-deploy-gate.test.ts`).
- **PR #112** (`fix/p142-ci-gated-production-deploy`, draft, OPEN, MERGEABLE) is
  **`SUPERSEDED_BY_P163`**. Do not merge it; closing it is the owner's call.
- **Native CI is not in the workflow.** The native test suites (`apps/mobile-spike`: typecheck, lint,
  Jest, backend) run locally only; adding a Linux job needs a validated recipe for the gitignored
  scanner assets and a first real run, and was not guessed here.
- **Secret scan:** gitleaks over the whole candidate history (321 commits) found two false positives
  that would have failed the CI secret-scan step on first push (the jwt.io documentation sample token
  in `tests/config/doc-link-checker.test.ts`, and the fixture key `unpriced-098`); both are
  allow-listed by exact value in `.gitleaks.toml`.
- **Live GitHub state, 2026-10-02:** repository PUBLIC; `main` unprotected; no rulesets; 30 open PRs,
  67 remote branches; newest workflow run is still 2026-09-18, so Actions capacity is unverified.
  Recommended (not applied) settings: `docs/CURRENT_STATE/GIT_PUBLICATION_PLAN.md` §5.
- The secret-shaped `VITE_SUPABASE_URL` Actions variable (above) is unchanged and still needs the
  owner's rotation and deletion; the new deploy job does not read `vars.*` at all.
