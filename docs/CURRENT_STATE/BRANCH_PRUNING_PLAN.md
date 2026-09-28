# Branch pruning plan

Authority: this file for the branch-by-branch keep/archive classification.
`docs/CURRENT_STATE/GIT_PUBLICATION_PLAN.md` for what's safe to push and the proposed native-RC
path. **This is a classification PLAN only — nothing here deletes a branch or closes a PR.**

Method: every local branch was checked with `git merge-base --is-ancestor <branch> main`
(2026-09-28) — a branch that IS an ancestor of `main` has had its content already delivered to
`main` (usually via a squash-merged PR under a different branch name) and is safe to archive with
high confidence. A branch that is NOT an ancestor still may be superseded in spirit by later work
under a different name; that requires judgment, not just ancestry, and is marked accordingly below.

## KEEP_ACTIVE

Unmerged, not superseded, and either currently relevant or actively worked (do not touch these):

| Branch | Why active |
|---|---|
| `feat/p182-native-card-recognition` | **May be an in-progress parallel session right now — do not read, modify, or make claims about its content.** Its existence (found via `git branch`) is the only fact this plan states; no `output_182.txt` exists yet. |
| `feat/p181-native-device-accessibility-performance-gate` | Current native lineage tip — see `docs/CURRENT_STATE/NATIVE_MOBILE.md` |
| `feat/p180-native-financial-reliability`, `test/p179-dark-ui-finish-gate`, `feat/p178-dark-native-ui`, `test/p177-native-financial-runtime`, `feat/p175-native-financial-write-flows`, `feat/p173-native-integration-recovered` | Rest of the native lineage — each is P181's ancestor chain |
| `fix/p163-integrated-ci-secret-gate` | Deployment-gate candidate, blocked on an owner Cloudflare action, still the plan for closing P130-08 |
| `audit/p156-account-deletion-security-recovery` | Account-deletion candidate, most current (builds on P152) |
| `fix/p149-auth-refresh-failure-recovery` | Closes P130-19 in the released base once merged |
| `fix/p151-scanner-reliability-performance` | Scanner hardening candidate, no known successor |
| `fix/p157-safe-exact-export-pipeline` | Export hardening candidate, no known successor |
| `design/p174-stitch-owner-decision-pack` | The design record behind P178's implemented direction; keep as reference even though implemented |
| `docs/p176-project-state-refactor` | Base of the current documentation structure |
| `docs/p183-current-state-sync` | This session's own branch |

## SUPERSEDED_KEEP_UNTIL_RC

Replaced by newer work in the same lineage. Not safe to archive yet — keep until the branch that
superseded each one reaches an actual release candidate, in case something in the older branch
needs re-checking during integration.

| Branch | Superseded by | Note |
|---|---|---|
| `fix/p142-ci-gated-production-deploy` | `fix/p163-integrated-ci-secret-gate` | **PR #112 is open on this exact branch** — keep until the PR is closed/re-pointed, not just until P163 merges |
| `fix/p160-predeploy-secret-guard` | `fix/p163-integrated-ci-secret-gate` | Integrated into P163 |
| `spike/p158-native-collection-pricecheck` | `spike/p166-native-runtime-stitch` | Source-built only; superseded by first runtime spike |
| `spike/p166-native-runtime-stitch` | `fix/p167-native-android-runtime-hardening` | Superseded by the runtime-hardening pass |
| `fix/p167-native-android-runtime-hardening` | `feat/p173-native-integration-recovered` | Hardening folded into the current native lineage |
| `feat/p169-native-catalog-price-check` | `feat/p173-native-integration-recovered` | Folded into P173's integration |
| `feat/p170-integrated-native-android` | `feat/p173-native-integration-recovered` | **P170's own completion status is unknown** (no `output_170.txt` — see `docs/handover/STATE_RECONCILIATION.md`); P173 exists specifically to recover from this gap |
| `design/p168-stitch-native-ui` | `design/p171-stitch-owner-review` | Earlier Stitch generation round |
| `design/p171-stitch-owner-review` | `design/p174-stitch-owner-decision-pack` | Earlier owner-review round |
| `feat/p152-privacy-account-deletion` | `audit/p156-account-deletion-security-recovery` | P156 builds on P152 with an independent security audit |
| `feat/p153-card-price-check` | `feat/p161-scanner-price-check-integrated` | Earlier Price Check iteration |
| `feat/p161-scanner-price-check-integrated` | `feat/p164-integrated-auth-export-scanner-price` | Earlier integration round |
| `feat/p164-integrated-auth-export-scanner-price` | `test/p165-p164-independent-release-verification` (verification of it) | Kept as the thing P165 verifies |
| `test/p165-p164-independent-release-verification` | — | Independent verification branch; keep until the P164 lineage's integration decision is finalized |
| `docs/p159-toolchain-audit` | — | Has a capability-matrix doc (`TOOL_CAPABILITY_MATRIX.md`) not yet promoted to a canonical doc — keep until that's done |
| `audit/p148-independent-release-review` | (pre-M15-hosted-release review) | Superseded by the released M15 state; kept for its audit findings until confirmed all resolved |
| `design/p154-native-mobile-redesign-blueprint` | `design/p168-stitch-native-ui` (later design chain) | Earlier design blueprint round |
| `docs/p141-handover-closeout`, `docs/p34-parallel-release-closeout`, `docs/m13-p42-p43-release-closeout`, `docs/m12-release-closeout` | `docs/p176-project-state-refactor` (current HANDOVER structure) | Historical closeout docs; their content should already be in `docs/handover/archive/` per P176 — verify before archiving these branches specifically |

## SAFE_TO_ARCHIVE_LATER

### Confirmed merged into `main` (git ancestry-verified 2026-09-28 — highest confidence)

`feat/p112-m15-hosted-release-candidate`, `feat/p115-m15-final-hardened`,
`fix/ci-flake-signin-race-and-export-cleanup`, `pr92-audit`, `preview/m15-8a470db`,
`release/p125-m15-integrated-candidate`, `release/p34-integration`.

These branches' entire commit history is already an ancestor of `main` — their work is fully
delivered. Safe to delete once the owner confirms nothing else references them (e.g. a PR still
open against one of them, which was not checked branch-by-branch beyond PR #112 above).

### Likely already superseded, NOT individually ancestry-verified (lower confidence — review before deleting)

The pre-`d8682e0` milestone/hardening chain — every `feat/m*`, `fix/m*`, `test/m*`, `research/m*`,
`security/m15-*`, `docs/m12-*`/`docs/m13-*` branch, the `p26`–`p52` early-feature branches, and the
`p84`–`p149` (non-candidate) hardening/chaos/adversarial series — is **not** individually an
ancestor of `main` by direct `git merge-base` (checked for every local branch, 2026-09-28), yet
`main`'s own commit history shows equivalent-topic work already merged under *different* branch/PR
names (example: `main` carries `fix(db): finance integrity for split purchase lines and correction
races (P132) (#107)` and `fix(db,fx): JPY FX currency-exponent and Norges Bank UNIT_MULT semantics
(P130-02) (#108)`, even though the identically-topic-named worktree branches
`fix/p132-integrated-finance-integrity`, `fix/p133-currency-exponent-semantics`, and
`fix/p134-norges-bank-fx-normalization` themselves show as NOT an ancestor — the delivered fix
likely came from a differently-named or cherry-picked branch, not these exact tips). This is a real
finding worth recording, not resolved by this plan: **do not assume every branch in this cluster is
superseded just because its topic sounds released — spot-check a sample against `main`'s actual
diff before bulk-archiving.** A rigorous per-branch check (diff each branch against `main` at its
own base, not just ancestry) is future work, not done here.

Representative branches in this cluster (not exhaustive — see `git branch -a` for the full list):
`feat/m12a-home-owner-feedback-p26`, `fix/search-owner-feedback-p27`,
`feat/holding-detail-quantity-removal-p28`, `p29/feat-holding-detail-ci-repair`,
`p31/fix-search-auth-retry`, `p32/feat-holding-detail-concurrency-repair`,
`feat/m13-export-core-p35`, `feat/m13-export-ui-p36`, `test/m13-independent-adversarial-p37`,
`feat/m13-export-backup`, `fix/owner-recompute-refresh-p42`, `feat/reset-history-p43`,
`fix/home-live-current-value-p48`, `feat/m16-opening-core-p50`, `feat/m16-opening-ui-p51`,
`test/m16-independent-adversarial-p52`, every `feat/m15-*`/`fix/m15-*`/`research/m15-*` scanner-era
branch, `security/m15-scanner-wasm-csp-p69`, `fix/p104-…` through `fix/p149-auth-refresh-…`'s
*predecessor* branches (`fix/p105` through `fix/p147`, excluding the still-active `fix/p149` above),
`test/p132c-independent-finance-regressions`, `test/p135-independent-fx-audit`,
`test/p140-client-idempotency-regressions`, `fix/p162-export-p149-integrated`,
`fix/p132a-multilot-integrity`, `fix/p132b-correction-locking`.

## UNKNOWN_REVIEW_FIRST

| Branch | Why unknown |
|---|---|
| `chore/m41-security-deployment` | No session output file reviewed for P176/P183 references this branch; its scope is unclear from the name alone. Read its own commits/docs before classifying. |
| `fix/p136-integrated-jpy-fx-semantics` | **Remote-only** — exists on `origin` but has no local worktree in this environment, so its content was not reviewed at all this session. Not an ancestor of `main`. Possibly related to (or superseded by) `fix/p133-currency-exponent-semantics`/`fix/p134-norges-bank-fx-normalization`, but that is a guess from the name, not verified. |

## Remotes vs local

66 remote branches were reported by P176; this session did not recount them individually (the
`comm` diff run this session found exactly one remote branch — `fix/p136-integrated-jpy-fx-
semantics` — with no local counterpart; every other remote branch matches a local one above). A
remote branch with a merged/superseded local counterpart should be pruned on GitHub only after the
local classification above is acted on, not independently.
