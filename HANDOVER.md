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
  `gh repo view` on 2026-09-27, **re-confirmed again 2026-09-28 (P183)**: `visibility: PUBLIC`, no
  branch protection on `main`, no repository rulesets. Nobody in scope changed it; when it went
  public and whether it was intended is unknown (check the GitHub Settings → Security log). **Until
  the owner decides**, treat all Actions run logs, the 66 remote branches and the 27 draft PRs as
  public — do not push unreleased local candidates while it stays public (`GIT_WORKFLOW.md` §13).
  Remediation plan: [docs/CURRENT_STATE/GIT_PUBLICATION_PLAN.md](docs/CURRENT_STATE/GIT_PUBLICATION_PLAN.md).
  See §14.
- **PR #112** (`fix/p142-ci-gated-production-deploy` → `main`, "add CI-gated Production deploy job
  (P130-08)") is still OPEN — the branch it's built from is superseded by P163 (§2), but nobody has
  closed the PR or re-pointed it. Its last CI run (2026-09-18): `build-and-test` SUCCESS,
  `db-tests` FAILURE. No CI has run at all since P159's 2026-09-24 "Actions billing/capacity"
  observation, so that specific block is genuinely unverified, not resolved — re-check with a real
  push before relying on it.
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
| Native, integrated (P173) | `feat/p173-native-integration-recovered` | `0600361f…` | 105 | **LOCAL ONLY — DEVICE-VERIFIED** (35/35 + 19/19 driver runs, real APK; P176 mislabelled this NOT-device-verified — corrected here, see §9) |
| Native financial writes (P175, on P173) | `feat/p175-native-financial-write-flows` | `a193a8ba…` | 107 | **LOCAL ONLY** — not device-verified by P175 itself; device-verified one phase later by P177 below |
| Native financial runtime (P177, on P175) | `test/p177-native-financial-runtime` | `0d1d9388…` | 107 | **LOCAL ONLY — DEVICE-VERIFIED.** First real device pass of the P175 write seam: 28/28 driver steps, 2 real defects found+fixed |
| Native dark UI (P178, on P177) | `feat/p178-dark-native-ui` | `084c7478…` | 107 | **LOCAL ONLY.** Dark-first "Utility structure + Foil identity" redesign; found the FX-rate write gap (fixed by P180) |
| Native UI finish gate (P179, on P178) | `test/p179-dark-ui-finish-gate` | `486bb86b…` | 107 | **LOCAL ONLY.** Fixed a white-flash-on-launch defect + a Price Check token drift |
| Native financial reliability (P180, on P179) | `feat/p180-native-financial-reliability` | `ecdb1208…` | 107 | **LOCAL ONLY — DEVICE-VERIFIED.** Closed the FX-rate write gap (real EUR sale, DB-confirmed); built a pending-write journal |
| Native product baseline (P181, on P180) | `feat/p181-native-device-accessibility-performance-gate` | `45ebfefa…` | 107 | **LOCAL ONLY — scoped device-accessibility/performance pass, not fully certified** (see §9). Fixed a real tab-label defect |
| Native on-device card recognition (P182, on P181) | `feat/p182-native-card-recognition` | `61547520…` | 107 | **LOCAL ONLY — core recognition device-proven** (release APK: ML Kit OCR + ONNX/DINO + shared index → real candidate); its hardening scope was not run |
| **Native release candidate (P184, on P182) — latest native candidate** | `release/p184-native-rc` | `953aa017…` | 107 | **LOCAL ONLY — `PARTIAL_P184_NATIVE_RC_HARDENING`.** Scanner hardened and device-verified (24/24 adversarial, 0 false HIGH, 0 image egress, lifecycle/identity/background, perf + memory plateau, clean build); RC journey and 360dp accessibility text checks not fully green. See [docs/mobile/P184_NATIVE_RELEASE_CANDIDATE.md](docs/mobile/P184_NATIVE_RELEASE_CANDIDATE.md) |
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
  `C:\Users\Oskar\Documents\Pokemonapp-worktrees\pNNN`. P176 built this documentation structure in
  `…\Pokemonapp-worktrees\p176` (`docs/p176-project-state-refactor`, based on `origin/main`
  `d8682e0`). This current-state sync happened in `…\Pokemonapp-worktrees\p183`, branch
  `docs/p183-current-state-sync`, based on the **P176 branch** (not `origin/main` directly) so it
  carries P176's compact structure forward rather than re-deriving it.

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

**Docker policy** (full detail: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §4): stop this
session's own containers, attempt one graceful Docker Desktop quit, verify it worked. Docker
should not sit running for days unneeded — but **do not repeatedly force-kill Docker/WSL after a
failed graceful quit if doing so risks stale socket state.** A real incident (P181) shows why: a
prior forced kill left a stale `.sock`/`.sock.stale` pair that blocked Docker Desktop from
launching at all on the next session until the owner intervened manually. One force-kill attempt
after a failed graceful quit is normal; if you see signs of a prior forced-shutdown artifact,
leave Docker idle instead of retrying the kill loop.

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
P175's native financial-write layer (§2), now device-verified by P177 and extended with a real
non-NOK FX-rate write path by P180 (real EUR sale, DB-confirmed), is an implementation of the
**existing** web semantics and FX contract (§7 of FINANCIAL_MODEL.md) for the native app — it does
not introduce new money rules. It is still **local, unmerged, and not reviewed for release**.

---

## 7. Scanner / recognition

- Released scanner content id: `f25fc05d569b7cca` (§1), unchanged by any local candidate.
- P151 (scanner reliability hardening) fixes an OCR-worker resource leak (P130-10) — **local
  only**, zero index/model/threshold changes, zero new migrations.
- Native (Android) card recognition: on-device OCR + visual embedding over this same index, device-verified and hardened in P182/P184 (local only; see §9). Detail:
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
Headline: React Native/Expo native app is a **local-only track**, never released, never pushed, but
now extensively device-verified through a linear chain: **P173 → P175 → P177 → P178 → P179 → P180
→ P181** (each phase builds directly on the previous tip). P181 (`45ebfefa9a5038e20dd1999644eb96c1ae6352ef`, 2026-09-27) was the tip before P182/P184: a dark-first Foil UI (P178/P179), a
device-verified financial write seam with a real non-NOK FX contract and a pending-write journal
(P177/P180), and a representative (not exhaustive) device-accessibility/performance pass (P181).
**Correction (P183, 2026-09-28):** P176 had labelled P173 `LOCAL_ONLY_NOT_DEVICE_VERIFIED` — this
was wrong. P173's own report shows a real release-APK run (35/35 + 19/19 driver steps); the error
conflated "unmerged" with "never run on a device" (found and documented by P177). "Local-only" was
and remains correct.

**Still open, do not overstate:** TalkBack itself has never been run (only an accessibility-tree
proxy); the full device matrix (16 screens × 6+ width/font/theme combinations) is not exhaustively
covered — P181 drove a representative subset; performance/memory are each one snapshot, not the
full battery; JPY has never been driven as an on-device purchase journey (proven at unit/Hermes/RPC
level only); no final app icon is selected; no N1/N2 navigation decision has been made. No native
runtime environment (Android SDK, emulator, physical device) is guaranteed present in any given
session — verify before claiming a run happened. **Native card recognition (P182 → P184):** P182 proved the core on a release APK (real image → real
catalog candidate); P184 hardened it (header-first image safety, checkpoint / identity / background
cancellation, severe-blur gate, banded collector-number extraction, loop and cache fixes) and
verified it on device: 24/24 adversarial scenarios with 0 false HIGH, 0 image egress, warm median
1.04 s, stable memory plateau, 36 scanner mutants killed. Latest native tip is **P184**
(`953aa017d2f950e77d1319dd238dcd35d83b5ded`), local only, status `PARTIAL_P184_NATIVE_RC_HARDENING`: the full RC journey and the
360dp/200 % accessibility text checks are not fully green and TalkBack was not driven.

---

## 10. Web application

No behavioural change since P141's release. Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Product scope/non-goals: [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) (frozen — see
[docs/PLANNING_FREEZE.md](docs/PLANNING_FREEZE.md)).

---

## 11. UI / design

Stitch-generated design exploration (P168 → P171 owner review → P174 owner decision pack, 24
audited screens) led to a real owner decision: **P178 implemented DARK_FIRST_UTILITY_STRUCTURE_
FOIL_IDENTITY** — a deliberate hybrid (Utility's native structure/lists/forms/navigation, Foil's
dark graphite-and-brass palette and card-art treatment), not a straight pick of one P174 option.
This is real product code (§9), not design-only exploration anymore — a 22-token theme system and
a 45-component UI kit, device-verified across P178–P181. **Still undecided:** the final app icon
and the N1/N2 navigation structure (§9). Stitch MCP access has a history of authentication
failures (P159/P160) — verify it works before assuming it's usable in a new session. Visual
direction ownership and conventions: [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) (native's own
token/component system is documented in `docs/CURRENT_STATE/NATIVE_MOBILE.md`, not yet promoted
into this canonical file — a good candidate for the next integration pass).

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
   (GitHub Settings → General → Danger Zone). Until decided, do not push unreleased local
   candidates (§1, `GIT_WORKFLOW.md` §13, `docs/CURRENT_STATE/GIT_PUBLICATION_PLAN.md`).
2. **Rotate the Supabase key** implicated by the secret-shaped `VITE_SUPABASE_URL` Actions
   variable, then correct that variable. (§1, P159/P160 S-1)
3. **P163's deployment gate** needs a Cloudflare Pages dashboard configuration check/change before
   it can be merged and closes P130-08. (§13) PR #112 (the superseded P142 attempt) is still open
   on GitHub and should be closed or re-pointed once P163 is ready to replace it.
4. **GitHub Actions capacity** — genuinely unverified, not confirmed either way. No workflow has
   run since P159's 2026-09-24 "billing/capacity" observation; re-check by actually pushing/
   triggering CI before relying on it for a real merge.
5. **Stitch MCP access** has repeatedly failed authentication (P159/P160) — needs a real API key
   registered outside chat before Stitch can be used again.
6. **No native runtime environment** (Android SDK/emulator/device) is guaranteed available in a
   fresh session — do not claim a native build/run happened without re-verifying the toolchain.
7. **Merging any two local candidates from §2 requires resolving their file/migration overlap
   first** — none has been integration-tested against another.
8. **Native: TalkBack was never run, the full device matrix was never exhaustively driven, and
   JPY was never submitted as an on-device purchase journey** (§9) — close these before treating
   the P181 tip as release-ready.
9. **Final app icon and N1/N2 navigation decision** are still not made — both block a genuinely
   final native UI (§9, §11).

---

## 15. Next recommended work

In rough priority order, contingent on the owner decisions in §14 (this is a suggestion, not a
scope reopening — see [docs/PLANNING_FREEZE.md](docs/PLANNING_FREEZE.md)):

1. Resolve §14 items 1–2 (visibility, secret rotation) — these are security-sensitive and cheap.
2. Get P163 merged (closes P130-08, the long-standing no-deploy-gate finding) once the Cloudflare
   action is done; close/re-point PR #112.
3. Integrate P149 (auth refresh fix, also closes P130-19 in the released base) — check overlap
   with P151/P157/P156 first (P159's conflict map).
4. Pick an integration order for the remaining local candidates (§2) rather than merging
   piecemeal — P159's `NEXT_RELEASE_ORDER` has a reasoned proposal.
5. Native mobile: the P173→P184 chain is device-verified (§9) — the remaining work is closing the
   disclosed gaps (TalkBack, the full RC journey, 360dp accessibility text checks, JPY on-device,
   arm64/physical device), not re-verifying the write seam or the scanner from scratch.
6. Design: the owner has already picked P178's dark-first "Utility structure + Foil identity"
   direction — the remaining decisions are the app icon and N1/N2 navigation (§9/§11), still open.

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
| What's safe to push given repo visibility; publication plan | `docs/CURRENT_STATE/GIT_PUBLICATION_PLAN.md` |
| Branch-by-branch keep/archive classification | `docs/CURRENT_STATE/BRANCH_PRUNING_PLAN.md` |

---

## 17. Historical archives

The pre-P176 `HANDOVER.md` (268,674 bytes, 3,433 lines) is preserved losslessly in
[`docs/handover/archive/`](docs/handover/README.md), split into three era-based files. See that
directory's `README.md` for the index and how to search it by prompt number or SHA. **Nothing in
the archive is authoritative for current state** — it exists so historical decisions, incidents
and test evidence are not lost, per [docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md)'s "repository
documents the project" principle.
