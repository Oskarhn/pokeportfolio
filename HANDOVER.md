# PokePortfolio — Current Handover

This file contains **CURRENT authoritative project state only**. Historical implementation
detail belongs in [`docs/handover/archive/`](docs/handover/README.md). Archived statements are
historical context and **do not override this file or canonical domain documentation**
([docs/DECISIONS.md](docs/DECISIONS.md), [docs/FINANCIAL_MODEL.md](docs/FINANCIAL_MODEL.md),
[docs/SECURITY.md](docs/SECURITY.md), etc. — see §16).

Machine-readable pointers for the facts below live in
[docs/PROJECT_STATE.json](docs/PROJECT_STATE.json). The two files must agree; if they don't,
`PROJECT_STATE.json` is stale and needs regenerating from this file, not the reverse.

**Do not infer current state from archived handover files.** They record what a past session
believed at the time and are known to contain claims later superseded — see
[docs/handover/STATE_RECONCILIATION.md](docs/handover/STATE_RECONCILIATION.md).

---

## 0. Authority and reading order

1. Read this file in full (target: under 40 KB, readable in one pass).
2. Read `docs/PROJECT_STATE.json` for machine-checkable pointers (SHAs, migration counts).
3. Read only the canonical doc relevant to your task (§16 table) — do not load all of `docs/`.
4. Search `docs/handover/archive/` only if you need historical narrative or "why" context.
5. Never treat a local candidate branch's own `ai_outputs/Claude_outputs/output_N.txt` as
   released truth — those are honest session reports of **local, unmerged** work unless the file
   itself says `MERGED`/`RELEASED` and this file agrees.

---

## 1. Released Production state — **RELEASED**

- **`main` HEAD / Production frontend:** `d8682e047b757f63673a63ac8185a4806d68cb98`
  ("docs(handover): close out P141 as released, hosted and live in Production (#111)").
  Confirmed twice independently (P159, P160): `git ls-remote origin refs/heads/main` and
  Production's own `/build-meta.json` (`builtAt 2026-09-18T08:22:20Z`) both report this SHA.
- **Hosted Supabase project:** `pokeportfolio-dev` (eu-west-3, Postgres 17), the only project —
  there is no separate staging project. **104 migrations applied, 0 pending** (verified via the
  Supabase MCP connector, P159; matches P141's release record).
- **Scanner content id:** `f25fc05d569b7cca` — unchanged and confirmed current across every
  session from P130 through P175 that checked it (source, generated index, and a live Production
  fetch all agree). No superseding id exists anywhere in the repo or any local worktree.
- **Repository visibility: PUBLIC.** ⚠️ This contradicts `CLAUDE.md`'s hard rule ("the repository
  is private, never make it public") and `docs/PUBLICATION_CHECKLIST.md`. Confirmed live via
  `gh repo view` on 2026-09-27: `visibility: PUBLIC`, unauthenticated `repo`/`actions/runs`/web
  requests all return 200. Nobody in scope changed it; when it went public and whether it was
  intended is unknown (check the GitHub Settings → Security log). **Until the owner decides**,
  treat all Actions run logs, the 66 remote branches and the 27 draft PRs as public. See §14.
- **P130 audit findings still OPEN in the released base** (of ~49 raised across P130/extensions):
  - **P130-08** — no enforced CI gate between `main` and the Production deploy. A repo-side fix
    exists (P142, then integrated with the secret guard as P163) but is **not merged** — closing
    it needs an external Cloudflare Pages dashboard action no session here has credentials for.
  - **P130-19** — client code still does `Number(bigint)` on some money-write paths (`purchases.ts`,
    `sales.ts`, `collection.ts`, `opening.ts`, `profile.ts`, `portfolio.ts` cursor). A fix exists
    locally (P149) but is unmerged, so this is OPEN in the actually-released product.
  - A GitHub Actions **variable** (`VITE_SUPABASE_URL`) is shaped like a Supabase **secret key**
    instead of a URL (found P159, still uncorrected as of P160's last check, 2026-09-24). It has
    never been consumed by a real deploy run, but rotation + correction is an outstanding owner
    action (S-1 in P159/P160). Treat any key that transited this variable as exposed.

---

## 2. Current unreleased candidates — **LOCAL ONLY**, do not confuse with §1

Every branch below is unmerged and unpushed unless stated otherwise. None of this is live. Full
detail and status per candidate: [docs/CURRENT_STATE/](docs/CURRENT_STATE/README.md). Machine
pointers: `docs/PROJECT_STATE.json` → `local_candidates`.

| Candidate | Branch | SHA | Local migrations | Status |
|---|---|---|---|---|
| Native, integrated (P173) | `feat/p173-native-integration-recovered` | `0600361f…` | 105 | **LOCAL ONLY — NOT DEVICE-VERIFIED THIS SESSION** |
| Native financial writes (P175, builds on P173) | `feat/p175-native-financial-write-flows` | `a193a8ba…` | 107 | **LOCAL ONLY — native build not run this session (P175's own report)** |
| Account deletion (P156) | `audit/p156-account-deletion-security-recovery` | `6b3ac903…` | 107 | **LOCAL ONLY** |
| Deployment/secret gate, integrated (P163, supersedes P142+P160) | `fix/p163-integrated-ci-secret-gate` | `4f6be7be…` | 104 | **LOCAL ONLY — BLOCKED** on owner Cloudflare action + Actions billing capacity |
| Scanner reliability hardening (P151) | `fix/p151-scanner-reliability-performance` | `4bd34bfd…` | 104 | **LOCAL ONLY** |
| Export hardening (P157) | `fix/p157-safe-exact-export-pipeline` | `b0bc4da1…` | 104 | **LOCAL ONLY** |
| Auth refresh-failure fix (P149) | `fix/p149-auth-refresh-failure-recovery` | `7fb83c27…` | 106 | **LOCAL ONLY** |
| Design decision pack (P174, on top of P171/P168) | `design/p174-stitch-owner-decision-pack` | `aacd218d…` | n/a | **DESIGN ONLY — NO PRODUCT CODE. Final UI direction not yet selected by the owner.** |

**None of these candidates share a common integration branch.** They are independent worktrees
off (mostly) the same `d8682e0` released base; merging more than one at a time requires resolving
overlap (P159's `PARALLEL_WORKER_ASSIGNMENTS.md` has the measured file-conflict map, e.g.
P149 × P151 touch 3 shared scanner files).

**Local migration counts genuinely diverge across these branches (104/105/106/107) because none
has integrated another's migrations.** This is not a bug in one branch — see
[docs/handover/STATE_RECONCILIATION.md](docs/handover/STATE_RECONCILIATION.md) for the full
list of counts and why they differ. Do not assume any one of these numbers is "the" local count.

---

## 3. Repository / branch state

- Primary checkout (`C:/Users/Oskar/Documents/Pokemonapp prosjekt`) local `main` is at `72e4660`,
  3 commits **behind** `origin/main` (not diverged — a plain fast-forward would fix it; nobody has
  done this, and P176 intentionally did not touch the primary checkout's `main`).
- 66 remote branches, 27 open draft PRs exist on GitHub — most correspond to the local-candidate
  worktrees in §2 plus older, already-superseded work. None was closed or pushed by this
  documentation pass.
- Two untracked files sit in the primary checkout and are **not part of any commit**:
  `AGENTS.md` (Codex-facing counterpart to `CLAUDE.md` — reviewed and corrected on the P176
  branch, see §16) and `worktrees/` (an older worktree location predating
  `Pokemonapp-worktrees/`, left alone).
- Every P17x-era worktree referenced in this file lives under
  `C:\Users\Oskar\Documents\Pokemonapp-worktrees\pNNN`. This documentation work happened in its
  own isolated worktree, `…\Pokemonapp-worktrees\p176`, branch `docs/p176-project-state-refactor`,
  based on `origin/main` (`d8682e0`).

---

## 4. Backend and migrations

Authoritative schema/lifecycle rules: [docs/DATA_MODEL.md](docs/DATA_MODEL.md). Migration
process rules: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Current counts: §1 (released, 104) and
§2 table (local candidates, 104–107, not integrated with each other). Full detail and per-branch
migration filenames: [docs/CURRENT_STATE/DATABASE.md](docs/CURRENT_STATE/DATABASE.md).

Before applying **any** migration to a database holding real data, run `pnpm db:backup` and
require it to print `BACKUP_COMPLETE` (hard rule, `CLAUDE.md`). Restore is validated only through
the dedicated runbook ([docs/RESTORE_RUNBOOK.md](docs/RESTORE_RUNBOOK.md)), never a plain `psql`
replay (P130-07).

---

## 5. Authentication / identity

No changes to the released auth model since P141. The one open item is **P130-19** (§1) — a
client-side write-path defect, not an auth-model defect. See
[docs/SECURITY.md](docs/SECURITY.md) for the trust-boundary model (unchanged) and
[docs/CURRENT_STATE/SECURITY_AND_PRIVACY.md](docs/CURRENT_STATE/SECURITY_AND_PRIVACY.md) for the
current blocker list.

---

## 6. Financial model

No invariant, formula or term has changed since P141/D-133. Authoritative:
[docs/FINANCIAL_MODEL.md](docs/FINANCIAL_MODEL.md) (worked examples in §8 are the test fixtures).
P175's native financial-write layer (§2) is a **local, non-device-verified** implementation of the
existing web semantics for the native app — it does not introduce new money rules and has not been
reviewed for release.

---

## 7. Scanner / recognition

- Released scanner content id: `f25fc05d569b7cca` (§1), unchanged by any local candidate.
- P151 (scanner reliability hardening) fixes an OCR-worker resource leak (P130-10) — **local
  only**, zero index/model/threshold changes, zero new migrations.
- Native (Android) scanner/recognition execution status: see
  [docs/CURRENT_STATE/NATIVE_MOBILE.md](docs/CURRENT_STATE/NATIVE_MOBILE.md) — do not assume it
  has been run on a real device or emulator without checking that file's citations.
- Re-research before touching scanner internals: [docs/SCANNER_RESEARCH.md](docs/SCANNER_RESEARCH.md).

---

## 8. Price Check

Native catalog + Price Check work exists locally (P169, `feat/p169-native-catalog-price-check`,
folded into the P173 native-integrated candidate). **Graded-card pricing remains
`PARTIAL_NO_AUTHORIZED_PROVIDER`** (P169's own report) — no paid grading-price source is
authorized (`docs/COST_POLICY.md`). Treat any graded price shown in a native build as
provisional/local, not a released feature.

---

## 9. Native mobile

Full current-state detail: [docs/CURRENT_STATE/NATIVE_MOBILE.md](docs/CURRENT_STATE/NATIVE_MOBILE.md).
Headline: React Native/Expo native app is a **local-only track**, never released, never pushed.
Latest integrated candidate is P173 (§2); P175 adds a financial write layer on top of it, not yet
built/run natively this session. No native runtime environment (Android SDK, emulator, physical
device) is guaranteed present in any given session — verify before claiming a run happened.

---

## 10. Web application

No behavioural change since P141's release. Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Product scope/non-goals: [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) (frozen — see
[docs/PLANNING_FREEZE.md](docs/PLANNING_FREEZE.md)).

---

## 11. UI / design

Stitch-generated design exploration exists (P168 → P171 owner review → **P174 owner decision
pack**, 24 audited screens) but **the owner has not selected a final direction** — this is
**DESIGN ONLY**, no product code changed as a result. Stitch MCP access has a history of
authentication failures (P159/P160) — verify it works before assuming it's usable in a new
session. Visual direction ownership and conventions once something ships:
[docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md).

---

## 12. Privacy / account deletion

Account deletion is **implemented and independently security-audited on a local branch only**
(P152 → P156, `audit/p156-account-deletion-security-recovery`, 2 new migrations: a pending-deletion
write barrier and a purge-completion verifier). **Not merged, not released.** There is no
`docs/PRIVACY.md` in this repository yet — privacy/deletion invariants currently live in the P156
branch's own docs and in [docs/SECURITY.md](docs/SECURITY.md); consider promoting a canonical
`docs/PRIVACY.md` when this candidate is integrated. Current blocker summary:
[docs/CURRENT_STATE/SECURITY_AND_PRIVACY.md](docs/CURRENT_STATE/SECURITY_AND_PRIVACY.md).

---

## 13. Deployment / CI

Full detail: [docs/CURRENT_STATE/RELEASE_AND_DEPLOYMENT.md](docs/CURRENT_STATE/RELEASE_AND_DEPLOYMENT.md).
Headline: the CI-gated Production deploy (closing P130-08) is implemented and locally tested as
P163 but **not merged** — it needs an owner action outside any session's credentials (Cloudflare
Pages dashboard configuration) plus resolution of a GitHub Actions billing/capacity block observed
in P159. Workflow/branch/CI/merge conventions (unchanged): [docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md).

---

## 14. Current blockers and known risks

Owner-only actions, most urgent first:

1. **Repository visibility** — decide whether PUBLIC was intended; if not, make it private
   (GitHub Settings → General → Danger Zone). (§1)
2. **Rotate the Supabase key** implicated by the secret-shaped `VITE_SUPABASE_URL` Actions
   variable, then correct that variable. (§1, P159/P160 S-1)
3. **P163's deployment gate** needs a Cloudflare Pages dashboard configuration check/change before
   it can be merged and closes P130-08. (§13)
4. **GitHub Actions capacity** was blocked as of the last observed run (P159: "recent account
   payments have failed or your spending limit needs to be increased") — current state unverified,
   re-check before relying on CI.
5. **Stitch MCP access** has repeatedly failed authentication (P159/P160) — needs a real API key
   registered outside chat before Stitch can be used again.
6. **No native runtime environment** (Android SDK/emulator/device) is guaranteed available in a
   fresh session — do not claim a native build/run happened without re-verifying the toolchain.
7. **Merging any two local candidates from §2 requires resolving their file/migration overlap
   first** — none has been integration-tested against another.

---

## 15. Next recommended work

In rough priority order, contingent on the owner decisions in §14 (this is a suggestion, not a
scope reopening — see [docs/PLANNING_FREEZE.md](docs/PLANNING_FREEZE.md)):

1. Resolve §14 items 1–2 (visibility, secret rotation) — these are security-sensitive and cheap.
2. Get P163 merged (closes P130-08, the long-standing no-deploy-gate finding) once the Cloudflare
   action is done.
3. Integrate P149 (auth refresh fix, also closes P130-19 in the released base) — check overlap
   with P151/P157/P156 first (P159's conflict map).
4. Pick an integration order for the remaining local candidates (§2) rather than merging
   piecemeal — P159's `NEXT_RELEASE_ORDER` has a reasoned proposal.
5. Native mobile: get an actual device/emulator run of P173+P175 before treating either as
   release-track work; do not build further native features on top of an unverified base.
6. Design: the owner needs to make the direction/icon/navigation decisions blocking P174 before
   any Stitch output becomes adoptable.

---

## 16. Canonical documentation map

One authoritative file per concept. Do not duplicate; link instead.

| Concept | Authoritative file |
|---|---|
| Current release/candidate state, machine-readable | `docs/PROJECT_STATE.json` |
| Product scope, non-goals | `docs/PRODUCT_SPEC.md` |
| Every monetary formula/invariant | `docs/FINANCIAL_MODEL.md` |
| Schema, ownership, lifecycle | `docs/DATA_MODEL.md` |
| Stack and rationale | `docs/ARCHITECTURE.md` |
| Trust boundaries, RLS, secrets posture | `docs/SECURITY.md` |
| Zero-cost policy, service matrix | `docs/COST_POLICY.md` |
| Frozen scope/semantics | `docs/PLANNING_FREEZE.md` |
| Test strategy, mandatory gates | `docs/TESTING.md` |
| Environment, commands, migration rules | `docs/DEVELOPMENT.md` |
| Branch/PR/CI/merge conventions | `docs/GIT_WORKFLOW.md` |
| Phases and gates | `docs/ROADMAP.md` |
| Decisions expensive to reverse | `docs/DECISIONS.md` |
| Findings that changed a decision | `docs/RESEARCH.md` |
| External services: status/terms/failure strategy | `docs/API_SOURCES.md` |
| Workflow behaviour, E2E source | `docs/UX_FLOWS.md` |
| Visual direction, components | `docs/DESIGN_SYSTEM.md` |
| Scanner prep research | `docs/SCANNER_RESEARCH.md` |
| Unscheduled/rejected work | `docs/BACKLOG.md` |
| Pre-public-release gate | `docs/PUBLICATION_CHECKLIST.md` |
| Engineering record (real problems + resolutions) | `docs/PROJECT_JOURNAL.md` |
| Released changes | `CHANGELOG.md` |
| Native mobile current state | `docs/CURRENT_STATE/NATIVE_MOBILE.md` |
| Release/deployment current state | `docs/CURRENT_STATE/RELEASE_AND_DEPLOYMENT.md` |
| Database current state (per-candidate migration detail) | `docs/CURRENT_STATE/DATABASE.md` |
| Security/privacy current blockers | `docs/CURRENT_STATE/SECURITY_AND_PRIVACY.md` |
| Historical narrative, contradictions between old/new claims | `docs/handover/STATE_RECONCILIATION.md` |

---

## 17. Historical archives

The pre-P176 `HANDOVER.md` (268,674 bytes, 3,433 lines) is preserved losslessly in
[`docs/handover/archive/`](docs/handover/README.md), split into three era-based files. See that
directory's `README.md` for the index and how to search it by prompt number or SHA. **Nothing in
the archive is authoritative for current state** — it exists so historical decisions, incidents
and test evidence are not lost, per [docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md)'s "repository
documents the project" principle.
