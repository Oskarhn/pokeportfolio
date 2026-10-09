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

## 1. Production state — **web `d8682e0` + backend DB114 (P197); `main` is newer**

- **P197B (2026-10-09): RESTORE-SAFE ACCOUNT DELETION PROVEN IN PRODUCTION; frontend still unchanged; P198 eligible, not started.** One real `delete-account` request (tooling PRs #124 `8f982ae`, #125 `6eadd33`, required checks green) for the synthetic **non-admin** account `4109f35e…` returned `200 deleted`; the old access and refresh tokens and a password sign-in were refused (403/400/400); the Production registry went seq 0 → 1 (exactly one new record, chain verified with the Production HMAC key — replaced once while the ledger was empty, so its provenance is known); the Edge Function → Worker append path is proven end to end (the Edge secret `ERASURE_REGISTRY_TOKEN` had *not* equalled the Worker's append token; the owner corrected it first). The exact pre-deletion backup `20261008T102641Z` restored with the **real** registry replays the erasure (`clean`, postcheck clean, `PROMOTABLE`, administrator data 1/3/4 unchanged): drill **20/21**, the one failure being the documented cron limitation (RESTORE_RUNBOOK §7). Independent Production read afterwards: `auth.users` 1, erasure receipts 1, pending requests 0, deleted account's rows absent. The operator token was rotated (old one refused). **Caveats:** off-machine copies of the backup and the proof folder are *owner-attested, not independently hash-verified*; graded/sealed valuation testing with an authenticated session is still outstanding. **Follow-ups:** mark the old operator-token password-manager entry REVOKED; make the tool's final prompt say "Cancelled" on Ctrl+C (today it exits silently). `READY_FOR_P198_FRONTEND_RELEASE=yes` (eligible; nothing deployed). Record: [P197B_PRODUCTION_DELETION_PROOF.md](docs/release/P197B_PRODUCTION_DELETION_PROOF.md).
- **P197 (2026-10-04): PRODUCTION BACKEND ROLLED OUT; frontend unchanged.** Production is now **old web `d8682e0` + hosted DB 114 (last migration `20261002140020_p191_privilege_baseline`) + current-main Edge Functions** (`search-prices` v10, `ingest-prices` v9, `sync-catalog` v13, new `delete-account` v1; `redeem-invitation`, `fetch-fx-rate`, `ingest-fx` unchanged). Rollout source `main` `7f2d691`. Fresh verified `pnpm db:backup` of DB104 (`20261004T203244Z`, private root outside git) restored in a disposable database (18/19 drill checks; the one failure is the documented cron limitation); diagnostics all 0; ten migrations applied cleanly; grant audit and finance diagnostics clean after; the 20:45 cron call hit new `ingest-prices` (200, 6 snapshots). The owner-run proofs this rollout left open (authenticated smoke, `delete-account` end to end, registry head/export/restore gate) were completed by P197B (above). `deploy-production.yml` was **not** run; Cloudflare auto-deploy off is *inferred* (serving SHA unchanged), not read. `READY_FOR_P198_FRONTEND_RELEASE` was `conditional` on them; it is now `yes` (P197B). Record: [P197_PRODUCTION_BACKEND_ROLLOUT.md](docs/release/P197_PRODUCTION_BACKEND_ROLLOUT.md).
- **P197D (2026-10-08): Search/Card Detail prices were blocked by CORS; fixed and deployed to Production (backend only).** `search-prices` and `fetch-fx-rate` answered the CORS preflight with 405, so a browser on the Production origin never reached them and market prices showed "—" regardless of data. PR #120 (`dc9bd0c`; PR #121 `f4cc019` fixed an unrelated calendar-dependent native test) added `_shared/cors.ts`. **Deployed 2026-10-08 12:14Z from `dc9bd0c`: `search-prices` v10 → v11 (`acfc9acc…`), `fetch-fx-rate` v9 → v10 (`d0e5f693…`)**; `verify_jwt` unchanged, no other function, no database or frontend change (web stays `d8682e0`). Verified on Production: OPTIONS 204 with the allowed origin echoed, a disallowed origin gets no `Access-Control-Allow-Origin`, and a real browser on the Production origin now reaches both functions (401 readable). **Not verified:** an authenticated POST that returns prices (needs a real session; none was used). Rollback: redeploy the previous v10/v9 sources, identical to `main` at `868688e`. The set-symbol fallback (logo → symbol → initials) ships with the next web release. A new holding's first provider price still waits for the next 15-minute `ingest-prices` tick (design).
- **P194 (2026-10-03): the P190 development RC is merged into `main`.** `main` is now the *integrated development line*, **not** Production. `MAIN_SHA=b26fcf249e2254570672daee3756779339664e04` (merge commit of PR #113, normal merge commit, head `9aa5e252…`; CI run 37116493073 green: build-and-test, db-tests, native-checks). `PRODUCTION_SHA=d8682e047b757f63673a63ac8185a4806d68cb98` is unchanged. `HOSTED_DB_MIGRATIONS=104`; `main` carries 114 source migrations (105–114 unapplied). `PRODUCTION_RELEASE_READY=no`. The manual `deploy-production.yml` dry run on the `main` SHA passed (run 37117692463; no upload, no secrets). New work branches from `main` (`git fetch origin && git switch main && git pull --ff-only && git switch -c <feature>`); `release/p190-cross-platform-development-rc` is `MERGED_TO_MAIN` and kept only for traceability.
- **P195 (2026-10-03): production backend readiness and rehearsal** (branch `release/p195-production-backend-readiness`, PR #116, merged to `main` as `7f2d691` on 2026-10-04 with a normal merge commit; main CI green; not deployed). **Production is untouched**: web `d8682e0`, hosted DB 104, Edge Functions unchanged; the only hosted change is the two authorised Auth settings (*Secure password change*, *Require current password when updating*, both now **ON**, read back). Done: the erasure registry is a Cloudflare Worker + SQLite Durable Object on Workers Free ($0) — production Worker deployed **empty**, a separate `-test` Worker exercised with the real `delete-account` ([P195_ERASURE_REGISTRY.md](docs/security/P195_ERASURE_REGISTRY.md), D-195); a LOCAL_ONLY rehearsal of DB104 → 114 with hostile legacy rows, backup, restore, erasure gate and rollback; compatibility matrix released web + DB114 **79/79**, `main` + DB114 **167/167**, `pnpm test:db` **1242 passed**. Provider facts: plan **free**, no scheduled backups, no PITR, log retention unknown → registry retention indefinite. **Open (owner):** the exposed `sb_secret_` key is **not identifiable** from dashboard metadata — rotate both secret keys per the record §2 (nothing was revoked); `PRODUCTION_SUPABASE_URL`/`_PUBLISHABLE_KEY` GitHub secrets and the Supabase function secrets `ERASURE_REGISTRY_URL`/`_TOKEN`; `supabase login` for the Production backup. `READY_FOR_P196_PRODUCTION_BACKEND_ROLLOUT=no`. Record: [P195_BACKEND_RELEASE_REHEARSAL.md](docs/release/P195_BACKEND_RELEASE_REHEARSAL.md).
- **P196C (2026-10-03): the recurring body-limit CI hang in the account-deletion trust-boundary tests is a local-gateway behaviour, not random.** Above ~16 KiB the Edge Runtime can lose the function's early `413`; tests now assert refusals at <= 8 KiB and bound larger bodies with a deadline plus a state proof. Test/harness change only; no product or Production change. [docs/TESTING.md §6h](docs/TESTING.md).
- main
- **Production frontend (the older, explicitly released SHA):** `d8682e047b757f63673a63ac8185a4806d68cb98`
  ("docs(handover): close out P141 as released, hosted and live in Production (#111)"). Confirmed
  independently by `git ls-remote origin refs/heads/main` (re-checked 2026-10-02, P188) and by
  Production's own `/build-meta.json` (`builtAt 2026-09-18T08:22:20Z`, P159/P160).
- **Hosted Supabase project:** `pokeportfolio-dev` (eu-west-3, Postgres 17), the only project.
  **114 migrations applied, 0 pending** (P197, 2026-10-04; was 104 until then).
- **Scanner content id:** `f25fc05d569b7cca` — unchanged across P130–P188 (web build verified again in
  P188: `scanner:index:verify` OK, 19,500 cards, `dist/…/current.json` = this id).
- **Repository visibility: `PUBLIC_BY_OWNER_CHOICE`** (D-190, 2026-10-02). Intentional; not a
  blocker or a warning. `main` is protected since P193 (PR + `build-and-test`/`db-tests`/`native-checks`, no force push/deletion, admins not enforced; read back in P194). **Standing push
  rule:** completed development phases SHOULD be pushed to their feature/release branch after local
  checks; GitHub Actions runs after the push; a development branch need not be feature-complete or
  Production-ready. Main merge and Production deploy keep their own stricter gates. Public does
  **not** authorize committing credentials, Production secrets, personal data, signing material or
  private backups — secret scanning stays mandatory.
  Rule and plan: [GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md) §13,
  [docs/CURRENT_STATE/GIT_PUBLICATION_PLAN.md](docs/CURRENT_STATE/GIT_PUBLICATION_PLAN.md).
- **PR #112** (`fix/p142-ci-gated-production-deploy`, draft) is **`SUPERSEDED_BY_P163`**; P163 is
  contained in the P190 line. See §2 for the P190 branch/PR and its CI status.
- **P130 findings still OPEN in Production** (P130-13/-14/-26/-09 are closed in the RC, see P191; Production has none of it): P130-08 (no enforced deploy gate: the repo-side gate is now
  in the P188 candidate; needs the owner's Cloudflare action), P130-19 (`Number(bigint)`: **fixed in
  the P188 candidate**), and a secret-shaped `VITE_SUPABASE_URL` Actions variable (S-1: rotate and
  delete; treat any key that transited it as exposed). Full release-relevant list and state:
  [docs/release/P188_INTEGRATION_MATRIX.md](docs/release/P188_INTEGRATION_MATRIX.md) §8.


---

## 2. Current unreleased candidates — **not released**, do not confuse with §1

`PRODUCTION_SHA` = `d8682e0` (Production). The P190 line (P188 + P189 + P191 + CI/publication work) was merged into `main` by P194 (PR #113). Merged is not released: nothing from it is live.
Machine pointers: `docs/PROJECT_STATE.json` → `local_candidates`.

**P193** (release control plane, 2026-10-03): `main` is the integrated development branch and a merge is **not** a release. `ci.yml` validates only; Production is deployed by the manually dispatched `.github/workflows/deploy-production.yml` (explicit full SHA, on `main`, CI evidence for that exact SHA, `dry_run` default true, `backend_ack` for a real run); Cloudflare Pages automatic production deployments were **disabled** and read back (Production unchanged at `d8682e0`); `main` is protected (PR + `build-and-test`/`db-tests`/`native-checks`, no force push/deletion, admins not enforced); the legacy `VITE_SUPABASE_*` Actions variables were deleted. **Open, owner:** whether the secret-shaped legacy `VITE_SUPABASE_URL` value is an active key could not be established without reading it, so rotation is an owner action; `PRODUCTION_SUPABASE_*` secrets still absent. Policy: [docs/release/P193_MAIN_AND_PRODUCTION_POLICY.md](docs/release/P193_MAIN_AND_PRODUCTION_POLICY.md); gates: [docs/release/PRODUCTION_RELEASE_CHECKLIST.md](docs/release/PRODUCTION_RELEASE_CHECKLIST.md).

**P191** (security boundary hardening, merged into the P190 RC branch) added three migrations (ledger write gate, sealed-product ownership, privilege baseline), closed P130-13/-14/-26/-09, left P130-20 as an owner action (hosted Auth setting) and P130-29/-30 partially closed. Record: [docs/security/P191_SECURITY_BOUNDARY_CLOSURE.md](docs/security/P191_SECURITY_BOUNDARY_CLOSURE.md). **Maintenance rule that comes with it:** a migration that re-creates one of the ten ledger writers must keep the `perform set_config('app.ledger_write', 'rpc', true)` line (the audit and tests fail loudly otherwise).

| Candidate | Branch | SHA | Migrations | Status |
|---|---|---|---|---|
| **Development RC (P190, extended by P191)** | `release/p190-cross-platform-development-rc` | branch tip (read `git ls-remote`; not recorded here) | **114** (111 + 3 P191, re-timestamped `20261002140000/10/20` in P192) | **`MERGED_TO_MAIN` (P194, PR #113, merge commit `b26fcf249e2254570672daee3756779339664e04`). Not deployed — DO NOT DEPLOY until the release checklist is complete.** Contains P188 and P189. CI (`build-and-test`, `db-tests`, `native-checks`) green on its head; no deploy job exists in `ci.yml` any more (P193). **P192** audited merge readiness: `CODE_REVIEW_READY=yes`, `MERGE_READY=no` (deploy coupling: CI never applies migrations or functions), `RELEASE_READY=no`; **P193 removed that coupling**: `CODE_REVIEW_READY=yes`, `MERGE_READY=yes`, `RELEASE_READY=no` (merge and release are now separate acts) — [P192_MERGE_READINESS.md](docs/release/P192_MERGE_READINESS.md), ordered plan [P192_PRODUCTION_RELEASE_SEQUENCE.md](docs/release/P192_PRODUCTION_RELEASE_SEQUENCE.md). Release blockers: [P189 record](docs/release/P189_ACCOUNT_DELETION.md), [P188 RC](docs/release/P188_RELEASE_CANDIDATE.md) §6. |
| **Cross-platform release candidate (P188)** | `release/p188-cross-platform-rc` | code tip `a048da53926d0c501508136d7fb11457fada1d86` | 107 | **LOCAL ONLY — `SUCCESS_P188_CROSS_PLATFORM_RC_LOCAL`.** P186 + P187 (rebuilt without its attribution trailer; tree-identical) + merges of **P164** (auth/exact money/exports/scanner hardening/Price Check), **P163** (deploy gate + secret guard) and **P165** (verification fixes). Native build profiles. [RC doc](docs/release/P188_RELEASE_CANDIDATE.md), [matrix](docs/release/P188_INTEGRATION_MATRIX.md) |
| **Restore-safe account deletion (P189)** | `security/p189-restore-safe-account-deletion` | see `docs/PROJECT_STATE.json` → `local_candidates.account_deletion` | **111** | **LOCAL ONLY — `SUCCESS_P189_RESTORE_SAFE_ACCOUNT_DELETION`**, built on the exact P188 candidate `2783c93e…` (descends from it; not merged, not pushed, not deployed). Selective integration of P152/P156 plus the erasure registry, the restore gate, the in-app web and native deletion flows and the public `/account-deletion` page. [Record](docs/release/P189_ACCOUNT_DELETION.md) |
| Account deletion (P152 → P156) | `audit/p156-account-deletion-security-recovery` | `6b3ac903…` | 107 (+3 own) | **`SUPERSEDED_BY_P189`** — kept as evidence only; never merged. |
| Design decision pack (P174) | `design/p174-stitch-owner-decision-pack` | `aacd218d…` | n/a | DESIGN ONLY; the direction is implemented by P178 |

Everything else previously listed here is **contained in or superseded by P188**: the native chain
P173 → P175 → P177 → P178 → P179 → P180 → P181 → P182 → P184 → P185 → P186 → P187, and the web
candidates P149, P151, P153, P161, P162, P163, P164, P165 (P157 superseded by P162). Per-branch
evidence and the audit method: [matrix](docs/release/P188_INTEGRATION_MATRIX.md) §5 and §7.
`docs/PROJECT_STATE.json` keeps one superseded entry per candidate.

**Why this changed:** the native line (P173–P187) turned out to contain *none* of the web
candidates (0 equivalent commits by patch-id) even though it was newer. Do not assume a later prompt
number includes an earlier fix; compare patch-ids and file blobs, not only ancestry.


---

## 3. Repository / branch state

- Primary checkout: local `main` is at `72e4660`,
  3 commits **behind** `origin/main` (a plain fast-forward; nobody has done it). Two untracked files
  are not part of any commit: `AGENTS.md` and `worktrees/` (an older worktree location).
- The P188 worktree is `Pokemonapp-worktrees/p188` (a sibling of the primary checkout), branch
  `release/p188-cross-platform-rc`, built from P186 `3fac34ff…` (not from P187). The P187 branch
  `feat/p187-ios-readiness` still carries a forbidden `Co-Authored-By` trailer in `60f2cd6`; never push it.
- 67 remote branches and 30 open PRs exist on GitHub; 24 of those remote branches carry attribution
  trailers (pre-existing, outside P188's ancestry; matrix §6). None was closed, pushed or rewritten.
- Branch classification after the P188 audit: [docs/CURRENT_STATE/BRANCH_PRUNING_PLAN.md](docs/CURRENT_STATE/BRANCH_PRUNING_PLAN.md)
  ("P188 integration update"). Nothing was deleted.


---

## 4. Backend and migrations

Authoritative schema/lifecycle rules: [docs/DATA_MODEL.md](docs/DATA_MODEL.md). Migration
process rules: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Current counts: §1 (released, 104) and
the P188 candidate (107) and the P189 branch (111: P188 + the four deletion migrations). Full detail and per-branch
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

The released auth model is unchanged since P141. The P188 candidate adds the P143/P145/P146/P147/P148/P149
hardening (identity-keyed authenticated subtree, identity leases on in-flight writes, a failed credential
refresh is not an identity change, password change bound to the form's user, exact bigint money
transport — D-134, D-136, D-137, D-139, D-140), which closes **P130-19** in that line (still open in
Production, §1). See [docs/SECURITY.md](docs/SECURITY.md) for the trust-boundary model (unchanged) and
[docs/CURRENT_STATE/SECURITY_AND_PRIVACY.md](docs/CURRENT_STATE/SECURITY_AND_PRIVACY.md) for what stays open.

---

## 6. Financial model

No invariant, formula or term has changed since P141/D-133. Authoritative:
[docs/FINANCIAL_MODEL.md](docs/FINANCIAL_MODEL.md) (worked examples in §8 are the test fixtures).
The native financial-write layer (P175–P180, device-verified, real EUR sale DB-confirmed) implements the
**existing** web semantics and FX contract (§7 of FINANCIAL_MODEL.md); it introduces no money rule. The
P188 candidate also carries the P144 financial-boundary migrations and the exact decimal-string money
transport (D-135, D-137). All of it is **local, unmerged, and not reviewed for release**.


---

## 7. Scanner / recognition

- Released scanner content id: `f25fc05d569b7cca` (§1), unchanged by any local candidate and re-verified in P188.
- P151 (scanner reliability hardening; OCR-worker leak P130-10, latest-scan-wins, visual-only never HIGH) is in
  the P188 candidate — zero index/model/threshold changes, zero migrations.
- Native (Android) card recognition: on-device OCR + visual embedding over this same index, device-verified and hardened in P182/P184 (local only; see §9). Detail:
  [docs/CURRENT_STATE/NATIVE_MOBILE.md](docs/CURRENT_STATE/NATIVE_MOBILE.md) — do not assume it
  has been run on a real device or emulator without checking that file's citations.
- Re-research before touching scanner internals: [docs/SCANNER_RESEARCH.md](docs/SCANNER_RESEARCH.md).


---

## 8. Price Check

Raw Price Check on the hardened scanner (P153/P161/P164: read-only, one confirmed variant per price, a
response the transport had to rewrite is refused — D-153, D-161, D-164) and the native catalog + Price Check
(P169) are both in the P188 candidate. **Graded-card pricing remains `PARTIAL_NO_AUTHORIZED_PROVIDER`** — no
paid grading-price source is authorized (`docs/COST_POLICY.md`); treat any graded price in a native build as
provisional.

---

## 9. Native mobile

Full detail: [docs/CURRENT_STATE/NATIVE_MOBILE.md](docs/CURRENT_STATE/NATIVE_MOBILE.md). The React Native /
Expo app is a **local-only track**, never released, never pushed. Lineage P173 → P175 → P177 → P178 →
P179 → P180 → P181 → P182 → P184 → P185 → P186 → P187, now carried by the P188 candidate.

- **Android (P186, preserved in P188):** App Bundle arm64-v8a + x86_64 (63.9 MB delivered to arm64),
  R8 and resource shrinking, unused ML Kit scripts excluded, scanner prewarm (cold photo → result
  3.6 → 2.3 s), exact scanner index `f25fc05d569b7cca`, 0 image egress, finance writes (NOK and EUR with
  FX, database-verified), dark UI. arm64 is packaged but proven only statically.
- **iOS (P187, preserved in P188):** `IOS_SOURCE_READY=yes`, `IOS_CONFIG_READY=yes`,
  `IOS_JS_BUNDLE_READY=yes`, **`IOS_RUNTIME_VERIFIED=no`** — nothing was built with Xcode or run on Apple
  hardware. Risks carried forward, none closable without a Mac: **R1** ONNX Runtime `install()` under the
  New Architecture, **R2** ML Kit iOS size (five script pods), **R3** Keychain survives uninstall,
  **R4** Apple-silicon simulator OCR, **R5** Skia postinstall, **R6** Xcode scene lifecycle, **R7** LAN
  App Transport Security behaviour. [docs/mobile/P187_IOS_READINESS.md](docs/mobile/P187_IOS_READINESS.md),
  [runbook](docs/mobile/IOS_BUILD_AND_DEVICE_RUNBOOK.md).
- **Build profiles (P188):** `LOCAL_DEV`, `LOCAL_RELEASE_TEST`, `PRODUCTION_RELEASE`. The AAB and the
  iOS config are **not store-ready**: placeholder ids (`invalid.pokeportfolio.spike…`), a local backend,
  local cleartext / ATS keys and the debug keystore. `PRODUCTION_RELEASE` takes identity, backend and
  signing from the build environment and refuses to build without them; no real value is committed.
  The fields the owner must choose first: [docs/mobile/BUILD_CONFIGURATION_PROFILES.md](docs/mobile/BUILD_CONFIGURATION_PROFILES.md) §4.
- **Shared code:** the native app imports the web `src/` data layer through `@shared`, so the P164
  merge changed what native runs (exact decimal-string money transport). P188 re-ran the native
  unit, backend and release-APK smoke on the merged tree (RC doc §4).
- **Still open, do not overstate:** a TalkBack pass on a real device; arm64 / physical device;
  JPY as an on-device purchase; in-app account deletion exists only on the P189 branch (§12); no final app icon; N1/N2 navigation
  undecided; graded-card pricing `PARTIAL_NO_AUTHORIZED_PROVIDER`.


---

## 10. Web application

No behavioural change in Production since P141. The P188 candidate adds the P164 web work (identity and money
hardening, safe exact exports, scanner hardening, Price Check; §5, §7, §8). Architecture:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Product scope/non-goals: [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md)
(frozen — see [docs/PLANNING_FREEZE.md](docs/PLANNING_FREEZE.md)).

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

Account deletion is **restore-safe** (P189; in `main` since P194; backend live in Production since P197 and **proven end to end by P197B**, 2026-10-09 — [proof record](docs/release/P197B_PRODUCTION_DELETION_PROOF.md); the in-app deletion UI ships with the next web release). Record:
[docs/release/P189_ACCOUNT_DELETION.md](docs/release/P189_ACCOUNT_DELETION.md); decision D-189; operator
procedure [docs/security/RESTORE_RUNBOOK.md](docs/security/RESTORE_RUNBOOK.md) (read it before any restore);
data scope [docs/security/P189_DELETION_DATA_MAP.md](docs/security/P189_DELETION_DATA_MAP.md).

- **Invariant:** after a deletion is confirmed no normal restore leaves that identity active in a database
  that serves. The restore resurrection P156 left open was reproduced first (24/24 account-owning relations
  came back) and is closed by: the erasure recorded in an **off-backup registry before anything is
  destroyed** (the database refuses to purge otherwise), a hash-chained/HMAC-signed registry, the
  `restore-gate` replay (`verify | apply | postcheck | promote-check`), and a restore drill that fails
  without the gate. **NEVER PROMOTE A RESTORED DATABASE BEFORE THE ERASURE GATE PASSES.**
- **Surfaces:** web Profile → Delete account (identity-lease based), native Profile → Delete account (same
  backend contract, plus journal/session/photo cleanup), public `/account-deletion` page (no retention
  period, only the contact the Privacy page already published).
- **Owner gates (not hidden):** production registry storage and credentials are **ready and proven** (`PRODUCTION_REGISTRY_STORAGE_READY=yes`, P197B; a missing or mismatched credential still fails closed with `503 deletion_unavailable`); hosted backup/PITR/log settings
  (`PROVIDER_RETENTION_VERIFIED=no`); the hosted **in-place restore** cannot be isolated (provider
  documentation) — runbook §5; completion time of an e-mailed request; legal view of a hashed id.
- `audit/p156-account-deletion-security-recovery` is `SUPERSEDED_BY_P189`. P156's privacy-policy draft and
  store worksheets were **not** imported (they assert unverified provider facts).

---

## 13. Deployment / CI

Full detail: [docs/CURRENT_STATE/RELEASE_AND_DEPLOYMENT.md](docs/CURRENT_STATE/RELEASE_AND_DEPLOYMENT.md).
The CI-gated Production deploy (P163) is **in the P188 candidate, not in Production**. It runs only for
a push to `main`, needs `build-and-test` and `db-tests`, reads public build values from repository
secrets (not variables) and refuses to build without a hosted origin and a publishable key. It becomes
the live path only after the owner's Cloudflare and secrets steps
([docs/security/RELEASE_PREFLIGHT_P163.md](docs/security/RELEASE_PREFLIGHT_P163.md) Part A), so P130-08
is partially closed. P188 also lets a push to `release/**` run the validation jobs (never the deploy).
Native test suites are not in the workflow. Conventions (unchanged): [docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md).

---

## 14. Current blockers and known risks

Owner-only actions, most urgent first:

1. **Branch protection on `main`** (not applied; the repository is public by choice, §1): require a
   PR and the `build-and-test` and `db-tests` checks, block force-push and deletion —
   `GIT_PUBLICATION_PLAN.md` §5.
2. **Rotate the Supabase key** implicated by the secret-shaped `VITE_SUPABASE_URL` Actions variable,
   delete the old `VITE_*` variables, create the four secrets (P163 Part A).
3. **Cloudflare Pages** dashboard check/change (production branch, auto-deploy off, previews) so the
   gated job is the only deploy path; then close or re-point PR #112.
4. **GitHub Actions capacity** — unverified; the first real push of `release/p188-cross-platform-rc`
   (after #1) answers it.
5. **Account deletion** (§12): registry storage and credentials are done (P197B). Open: the hosted backup/PITR/log facts and the in-place-restore plan; mark the old operator-token password-manager entry REVOKED; the off-machine copies are owner-attested only.
6. **Store identity and signing** (BUILD_CONFIGURATION_PROFILES §4): application id, bundle id, keystore,
   Apple team, version policy, hosted backend values, app icon, N1/N2.
7. **A real Mac and iPhone** for the iOS gates (§9 R1–R7); a physical Android device for arm64 and TalkBack.
8. **Open P130 items** the candidate does not close: -13, -14, -20, -26, part of -09, -29/-30 (matrix §8).
9. **Hosted rollout order** when the candidate is released: fresh `pnpm db:backup` (`BACKUP COMPLETE`),
   migrations 105–107, then the Edge Functions (`search-prices`, `ingest-prices`, `sync-catalog`), then the
   gated frontend deploy.

---

## 15. Next recommended work

Not a scope reopening ([docs/PLANNING_FREEZE.md](docs/PLANNING_FREEZE.md)):

**Next gate: P198** — release the current validated `main` frontend. Eligible, **not started, nothing deployed**; handoff in [P197B record §5](docs/release/P197B_PRODUCTION_DELETION_PROOF.md). Items below are the older plan; read them against §1.

1. Resolve §14 items 1–3, then push `release/p188-cross-platform-rc` and read its own CI run; fix real
   defects, never weaken a gate.
2. Review and, if accepted, release the P188 line in the §14 item 9 order.
3. Provider retention facts and the in-place-restore plan (§12). The P189 backend itself is live and proven (P197B).
4. Close the native gaps that need hardware (§14 item 7) and choose the store identity (item 6).
5. Close the remaining P130 items by deliberate design work, not as side effects.


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
| Release candidate: contents, verification, release order | `docs/release/P188_RELEASE_CANDIDATE.md` |
| What the candidate contains vs every local branch; P130 state; attribution audit | `docs/release/P188_INTEGRATION_MATRIX.md` |
| Native build profiles (local vs production), signing, owner-chosen fields | `docs/mobile/BUILD_CONFIGURATION_PROFILES.md` |


---

## 17. Historical archives

The pre-P176 `HANDOVER.md` (268,674 bytes, 3,433 lines) is preserved losslessly in
[`docs/handover/archive/`](docs/handover/README.md), split into three era-based files. See that
directory's `README.md` for the index and how to search it by prompt number or SHA. **Nothing in
the archive is authoritative for current state** — it exists so historical decisions, incidents
and test evidence are not lost, per [docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md)'s "repository
documents the project" principle.
