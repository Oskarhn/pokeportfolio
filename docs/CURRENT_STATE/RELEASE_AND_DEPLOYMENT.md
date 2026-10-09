# Release and deployment — current state

Authority: this file for current status; `HANDOVER.md` §1/§13/§14 for the summary;
`docs/GIT_WORKFLOW.md` for the durable branch/PR/CI conventions (unchanged).

## Released state

- **P197B (2026-10-09):** real Production deletion + registry + restore-replay proof passed (drill 20/21, only the documented cron limitation); frontend unchanged (`d8682e0…`), nothing deployed; P198 eligible, not started — [../release/P197B_PRODUCTION_DELETION_PROOF.md](../release/P197B_PRODUCTION_DELETION_PROOF.md).
- **P197 (2026-10-04):** Production backend rolled out, frontend unchanged — web `d8682e0…`, hosted DB **114**, current-main Edge Functions (`delete-account` v1 new; `search-prices` v10, `ingest-prices` v9, `sync-catalog` v13 updated). The authenticated Production proofs and the live-registry checks that were owner-pending were completed by P197B. Record: [../release/P197_PRODUCTION_BACKEND_ROLLOUT.md](../release/P197_PRODUCTION_BACKEND_ROLLOUT.md).
- **P194 (2026-10-03):** `main` = `b26fcf249e2254570672daee3756779339664e04` is the integrated development line (PR #113 merged with a normal merge commit; main CI green, run 37116493073). Production is the older, explicitly released `d8682e0…` below and was verified unchanged after the merge. Manual `deploy-production.yml` dry run on the `main` SHA: PASS (run 37117692463, `verify` only, `deploy` skipped). Hosted DB stays at 104 migrations; `main` has 114 source migrations. `PRODUCTION_RELEASE_READY=no`.
- (Pre-P194 statement, `main` was then also Production:) the live Production frontend serves `d8682e047b757f63673a63ac8185a4806d68cb98`
  ("docs(handover): close out P141 as released, hosted and live in Production (#111)"), confirmed
  via `git ls-remote origin refs/heads/main` and Production's own `/build-meta.json`
  (`builtAt 2026-09-18T08:22:20Z`) independently by both P159 and P160.
- Hosted Supabase project `pokeportfolio-dev` (eu-west-3): **114** migrations applied, 0 pending (104 until P197, 2026-10-04).
- **P193:** a merge to `main` no longer deploys. `ci.yml` validates only; Production is released by the
  manual `deploy-production.yml` (explicit SHA, CI evidence, dry run default) and Cloudflare Pages' automatic
  production deployments are disabled (read back 2026-10-03). Policy:
  [../release/P193_MAIN_AND_PRODUCTION_POLICY.md](../release/P193_MAIN_AND_PRODUCTION_POLICY.md); gates:
  [../release/PRODUCTION_RELEASE_CHECKLIST.md](../release/PRODUCTION_RELEASE_CHECKLIST.md). The text below
  that mentions a `deploy-production` job in `ci.yml` is the pre-P193 history.
- `main` is protected since P193 (2026-10-03, read back): PR required (0 approvals), checks
  `build-and-test`, `db-tests`, `native-checks`, force push and deletion blocked, admins not enforced
  (owner recovery path). Before P193 there was no rule.

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

`PRODUCTION_SHA` = `d8682e047b757f63673a63ac8185a4806d68cb98` (Production; no longer equal to `main` after P194). The local release
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
  the same validation jobs and can never deploy: `ci.yml` has no deploy job and reads no Production
  secret (`tests/config/release-control-plane.test.ts`).
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

## P195 backend readiness (2026-10-03)

Production unchanged (web `d8682e0`, DB 104, functions v7/6/3/2/3/3). Erasure registry deployed on Cloudflare Workers Free (production empty, `-test` exercised) — [P195_ERASURE_REGISTRY.md](../security/P195_ERASURE_REGISTRY.md). Hosted Auth: *Secure password change* and *Require current password when updating* ON. Backend rehearsal (LOCAL_ONLY): [P195_BACKEND_RELEASE_REHEARSAL.md](../release/P195_BACKEND_RELEASE_REHEARSAL.md). Sequence steps 2–6 of [P192_PRODUCTION_RELEASE_SEQUENCE.md](../release/P192_PRODUCTION_RELEASE_SEQUENCE.md) are done except the owner items listed there (key rotation, `PRODUCTION_SUPABASE_*` secrets, function secrets, Production backup login).
