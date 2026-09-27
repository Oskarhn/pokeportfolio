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

## Repository visibility — CONTRADICTS CLAUDE.md

`gh repo view` on 2026-09-27 reports `Oskarhn/pokeportfolio` as **PUBLIC**. `CLAUDE.md`'s hard
rule states the repository is private and must never be made public without the owner's explicit
approval plus a completed `docs/PUBLICATION_CHECKLIST.md` pass. Nothing found in this
documentation session changed it, and no session in the reviewed output files claims to have
changed it either — when/why it became public is unknown. Consequences while public:
- All GitHub Actions run logs are publicly readable (once any workflow actually runs).
- All 66 remote branches and 27 draft PRs are publicly readable, including their diffs and commit
  history.
- The repository's public JS bundle already carries the Supabase project ref and a
  `sb_publishable_` key by design (that's expected for a Supabase frontend) — the *added* exposure
  from being public is source history and CI logs, not the deployed bundle itself.

**This needs an explicit owner decision** — see `HANDOVER.md` §14 item 1.

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
  2. GitHub Actions capacity — the last observed CI run (PR #112, 2026-09-18) failed at job start
     with "recent account payments have failed or your spending limit needs to be increased".
     Current state of this block is unverified; re-check before relying on CI.

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
