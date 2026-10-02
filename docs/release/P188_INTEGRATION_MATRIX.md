# P188 integration matrix

Authority: this file for what the P188 release candidate does and does not contain relative to
every still-relevant local branch, and why. `docs/release/P188_RELEASE_CANDIDATE.md` for the
candidate itself. Method and evidence below were produced on 2026-10-02 and are re-runnable
(§7). **Nothing here is released, pushed or merged.**

## 1. Headline finding

The native lineage (P173 → P186 → P187) **did not contain the web lineage.** A patch-id comparison
of every commit on P149, P151, P157, P163, P164, P165 and P156 against everything between the
released base and P187 found **0 equivalent commits**, and `apps/mobile-spike` was the only
product directory P187 changed relative to `d8682e0` (plus two P144 migrations and one P173
migration). A newer prompt number did not imply an older fix was present. The audit therefore
integrated the web candidates instead of assuming them:

| Step | Merge | Result |
|---|---|---|
| 1 | **P164** `bae0b604` (carries P143/P145/P146/P147/P148/P149, P151, P153, P161, P162 and the P164 seams) | 2 conflicts, both resolved to the native line (§3) |
| 2 | **P163** `4f6be7be` (P142 deploy gate + P160 secret guard + hardening) | documentation and package-script conflicts only |
| 3 | **P165** `3d03eec7` (verification of P164: test and tooling fixes) | documentation conflicts only |

Everything else is either already present, superseded, or deliberately kept separate. The one
integration decision that was **not** taken is P156 (§4).

## 2. Identity of the candidate

- Base: P186 `3fac34ffb6834026fcda5ee01734197c46d3b445`.
- P187 history was reconstructed on that base without its forbidden attribution trailer (§6). The
  rebuilt tree equalled P187's tree **byte for byte** before any P188 change:
  `git rev-parse 79c447d^{tree}` = `HEAD^{tree}` at that checkpoint = `f56103cfe4e9fd342663ef4a92635b4eae8ae309`.
- Migrations: **107** (released 104 + two P144 + one P173). Zero duplicate timestamps. The P144
  files are byte-identical in P149, P164 and P188 (`git rev-parse <sha>:<path>` equal), so the merge
  added no migration. P156's three migrations are **not** included.

## 3. Conflicts and semantic overlaps found while integrating

| Where | What | Resolution |
|---|---|---|
| `tests/ui/opening-draft.test.ts` | P147 (web) and P187 (native) had independently fixed the same UTC-vs-local-date test defect, with different clock fixtures | P187's version kept (pinned clock and time zone, DST cases); no production change |
| `tests/config/public-env-guard.test.ts` vs `src/data/leased-db.ts`, `src/data/supabase-factory.ts` | **Semantic**, no textual conflict: the P163 guard forbids the literal Vite env object anywhere under `src/`; two P149/P164 comments spelled it | comments reworded, no code change |
| `apps/mobile-spike/tests/unit/shared-data-reuse.test.ts` | **Semantic**: the native app imports the web `src/` through `@shared`. After the merge the shared data layer sends every money argument as a decimal string (D-137), and a native test pinned the released JSON-number cursor | test updated to the string form; the RPC accepts it (proven by `p146_exact_money_roundtrip`) |
| `apps/mobile-spike` Jest projects `shared-node` / `shared-rn` | **Semantic**: they run the web's `tests/data/money.test.ts` unchanged, and P146 made it import fast-check; Jest could not resolve fast-check's `pure-rand` subpath through pnpm, so native `pnpm test` was red on the merged line (two projects failed to run one file) | a fallback to Node resolution in `tests/support/node-fallback-resolver.js`; native `pnpm test` is 89 suites / 1202 tests green |
| `.github/workflows/ci.yml` vs the P161/P164 authenticated specs | **Semantic**: the ledger spec reads `P153_DB_URL`, the workflow exported only `DB_URL`; the first CI run would have failed the spec and left six tests unrun | the job exports it; `tests/config/e2e-ci-env.test.ts` pins every variable the specs read |
| `.gitleaks.toml` vs P176/P169 test files | the CI secret-scan step scans the whole history; two synthetic strings (the jwt.io sample token, a fixture key) would have failed it | exact-value allow-list |
| `HANDOVER.md`, `CHANGELOG.md`, `docs/DECISIONS.md`, `package.json` | append-append | both sides kept; HANDOVER rewritten in the closeout; no duplicate `D-` ids |

## 4. P156 — account deletion: `UNSAFE_OR_UNRESOLVED`, kept separate

`audit/p156-account-deletion-security-recovery` `6b3ac903`, 13 commits on `d8682e0`, three
migrations (`20260920120000` / `…140000` / `…150000`), the `delete-account` Edge Function, the
profile UI and 18 test files. It merges into P188 with **no source conflict** (documentation only),
so the reason it is not integrated is not technical convenience.

Classification of its material changes:

| Change | Class | Why |
|---|---|---|
| Hard-delete purge (`purge_account_data`, FK cascade backstop), password-reauthenticated function | `STILL_MISSING_AND_REQUIRED` for a store release (Apple and Google both require in-app deletion) | not in P188; releasing it is a separate owner-gated step |
| Pending-deletion write barrier (pending identity could UPDATE/DELETE and call correcting RPCs: 31/38 probed operations before the fix) | `STILL_MISSING_AND_REQUIRED` — part of the same feature | only meaningful with the deletion machinery |
| Purge completion verifier (a ctid-skipped row reported `complete`) | `STILL_MISSING_AND_REQUIRED` — same | same |
| OAuth/MFA accounts refused (`reauthentication_unsupported`) | `STILL_MISSING_AND_REQUIRED` — same | same |
| `.gitleaks.toml` allowlist for the local default JWT secret | `OBSOLETE` outside the feature | only the deletion attack tests need it |
| **Restore resurrection** | `UNSAFE_OR_UNRESOLVED` | see below |
| Public off-app deletion web link (Google Play) | `UNSAFE_OR_UNRESOLVED` | owner decision; prototype unpublished |
| Hosted audit-log, backup and provider-log retention | `UNSAFE_OR_UNRESOLVED` | unverified; no retention period may be invented |

**The restore question, audited.** *Can data deleted under the account-deletion workflow reappear
through backup or restore?* Yes, and P156 reproduced it: a real `pg_dump` taken while the account
existed, the account deleted through the deployed function, the dump restored into a second
database — the login, profile and ledger came back (`tests/db/p156_restore_resurrection.test.ts`,
RESTORE_RUNBOOK §12 on that branch). Nothing inside a backup can know about a later deletion, so it
cannot be fixed from inside the backup. P156's mitigation is an **owner-maintained erasure
registry** kept outside every git checkout and every backup directory (one `<sha256> <date>` line
per erased account) plus a promotion gate (`scripts/restore-gate/check-restore-erasures.ts`) that
refuses to promote a restored database containing a registered account. Its completeness is the
owner's process, not code: a deletion nobody recorded is invisible to the gate, and a restore that
skips the gate is unprotected.

**P188's tree has neither the registry nor the gate** (`docs/RESTORE_RUNBOOK.md` stops before §12;
P131's validated backup tooling is present). Integrating the deletion code without them would put a
function in the product that cannot honour its own promise after the next restore, which would
weaken, not preserve, deletion security.

**Exact blocker (all owner-side):** (1) accept and operate the off-backup erasure registry, or
choose another mechanism; (2) decide the public deletion URL and retention statements; (3) verify
the hosted backup/log retention facts listed in P156's `docs/PRIVACY.md` §8. Until then:
`P156_STATUS=UNSAFE_OR_UNRESOLVED_KEPT_SEPARATE`. `feat/p152-privacy-account-deletion` follows P156.
The native app therefore has **no** in-app account deletion, which is a store-distribution blocker
(`docs/mobile/BUILD_CONFIGURATION_PROFILES.md` §4).

## 5. KEEP_ACTIVE audit (every branch the P183 plan classed `KEEP_ACTIVE`)

Actions: `NONE_ALREADY_PRESENT` · `NONE_SUPERSEDED` · `INTEGRATE` (done in P188) ·
`KEEP_SEPARATE_UNRESOLVED` · `OWNER_DECISION_REQUIRED`. "Patch-eq" = commits whose `git patch-id
--stable` equals one in the candidate; a non-ancestor with full patch-equivalence is present even
though ancestry says otherwise.

| Branch | Tip | Purpose | Ancestor of P188 | Patch-equivalent | Still relevant | Action |
|---|---|---|---|---|---|---|
| `feat/p182-native-card-recognition` | `61547520` | on-device card recognition | yes | n/a | no (in lineage) | `NONE_ALREADY_PRESENT` |
| `feat/p181-native-device-accessibility-performance-gate` | `45ebfefa` | native baseline | yes | n/a | no | `NONE_ALREADY_PRESENT` |
| `feat/p180-native-financial-reliability` | `ecdb1208` | FX write gap, pending-write journal | yes | n/a | no | `NONE_ALREADY_PRESENT` |
| `test/p179-dark-ui-finish-gate` | `486bb86b` | dark UI finish gate | yes | n/a | no | `NONE_ALREADY_PRESENT` |
| `feat/p178-dark-native-ui` | `084c7478` | dark native UI | yes | n/a | no | `NONE_ALREADY_PRESENT` |
| `test/p177-native-financial-runtime` | `0d1d9388` | device-verified write seam | yes | n/a | no | `NONE_ALREADY_PRESENT` |
| `feat/p175-native-financial-write-flows` | `a193a8ba` | native financial writes | yes | n/a | no | `NONE_ALREADY_PRESENT` |
| `feat/p173-native-integration-recovered` | `0600361f` | recovered native integration | yes | n/a | no | `NONE_ALREADY_PRESENT` |
| `fix/p163-integrated-ci-secret-gate` | `4f6be7be` | CI-gated deploy + secret guard | **yes (merged in P188)** | 0/6 before the merge | yes | `INTEGRATE` (done) |
| `audit/p156-account-deletion-security-recovery` | `6b3ac903` | account deletion | no | 0/13 | yes | `KEEP_SEPARATE_UNRESOLVED` (§4) |
| `fix/p149-auth-refresh-failure-recovery` | `7fb83c27` | auth refresh + exact money (P130-19) | **yes (via P164)** | 0/29 before the merge | yes | `INTEGRATE` (done, via P164) |
| `fix/p151-scanner-reliability-performance` | `4bd34bfd` | scanner reliability (P130-10) | **yes (via P164)** | 0/15 before | yes | `INTEGRATE` (done, via P164) |
| `fix/p157-safe-exact-export-pipeline` | `b0bc4da1` | safe exports | no | 1/5 (the rest were rebased with conflict resolution) | superseded | `NONE_SUPERSEDED` — P162 re-applied all five on P149; the four export source files are **identical to P162's** in P188 |
| `design/p174-stitch-owner-decision-pack` | `aacd218d` | design record | no | 0/6 (228 design files) | reference only; the direction is implemented by P178 | `NONE_SUPERSEDED` (keep as design record) |
| `docs/p176-project-state-refactor` | `49c4fc69` | documentation structure | no | **3/3** | no | `NONE_ALREADY_PRESENT` |
| `docs/p183-current-state-sync` | `6592cc69` | documentation sync | no | **4/4** | no | `NONE_ALREADY_PRESENT` |

Other branches the plan names, for completeness:

| Branch | Tip | Finding | Action |
|---|---|---|---|
| `fix/p142-ci-gated-production-deploy` | `7430f66` | ancestor (P163 contains it) | `NONE_SUPERSEDED` |
| `fix/p160-predeploy-secret-guard` | `5f4db93` | integrated into P163 once, with hardening (not patch-identical) | `NONE_SUPERSEDED` |
| `test/p165-p164-independent-release-verification` | `3d03eec7` | test and tooling only; fixes a fixture collision and a CI-order defect CI would hit | `INTEGRATE` (done) |
| `feat/p164-integrated-auth-export-scanner-price` | `bae0b604` | the integrated web candidate | `INTEGRATE` (done) |
| `feat/p169-native-catalog-price-check` | `e2e382e` | 2/2 commits patch-equivalent; absent files were removed by P173's recovery | `NONE_ALREADY_PRESENT` |
| `feat/p170`, `spike/p158`, `spike/p166`, `fix/p167` | — | ancestors | `NONE_ALREADY_PRESENT` |
| `audit/p148-independent-release-review` | `a72ed27` | ancestor (via P164) | `NONE_ALREADY_PRESENT` |
| `design/p154`, `design/p168`, `design/p171` | — | design documents only, no product code | `NONE_SUPERSEDED` |
| `docs/p159-toolchain-audit` | `d540822` | 10 toolchain documents not promoted (e.g. `TOOL_CAPABILITY_MATRIX.md`) | `KEEP_SEPARATE_UNRESOLVED` |
| `feat/p152-privacy-account-deletion` | `850ebec` | precursor of P156 | follows P156 (§4) |
| `chore/m41-security-deployment` | `0863e6c` | squash-merged as `fcf56e9` "M4.1 … (#5)" long ago | `NONE_SUPERSEDED` |
| `origin/fix/p136-integrated-jpy-fx-semantics` (remote only) | `aa0092c` | the same P130-02 FX work that reached released history as `72e4660` (#108); the FX files are identical to P188's | `NONE_SUPERSEDED` |
| `docs/p141…`, `docs/p34…`, `docs/m13…`, `docs/m12…` closeouts | — | historical HANDOVER/CHANGELOG records of released milestones, replaced by the P176 structure | `NONE_SUPERSEDED` |

Branches in the plan's "likely superseded" cluster (P26–P149 hardening and chaos branches) were
**not** audited one by one; ancestry shows they predate `d8682e0` and the released tree contains
the delivered work. That remains the plan's lower-confidence class.

## 6. Attribution audit

Searched every commit message reachable from the candidate for `Co-Authored-By`, `Generated
with/by` Claude/AI/Codex/ChatGPT, `noreply@anthropic.com`/`noreply@openai.com`, "Claude Code" and
the robot-emoji marker:

| Class | Scope | Result |
|---|---|---|
| A. already on released `main` (`d8682e0` and its ancestors) | not rewritten | **0** matches (`git log --format=%B d8682e0 \| grep -ic '^co-authored-by'` = 0) |
| B. local unpushed candidate commits (`d8682e0..P188`) | cleaned before publication | **0** matches. The only hit in the P187 line was `60f2cd6`; its content was re-committed without the trailer (the other three message hits are the filename `CLAUDE.md`, not an attribution) |
| C. unrelated or superseded branches | recorded only | 29 commits carry the trailer (`git log --all --grep='^Co-Authored-By:' -i`); 52 branch refs contain at least one, none of them an ancestor of P188. **24 of those refs are remote branches already on the public GitHub repository** (the M15/P84–P111 scanner-era branches, `fix/p123-finance-accounting-phase3`, …). They are outside P188's ancestry and cannot be cleaned from here: rewriting pushed branches is an owner decision |

Every commit in `d8682e0..P188` (229 at the code tip, plus the closeout documentation commits) has the same single author and
committer identity (the repository owner's). No identity setting was modified.

## 7. How to re-run

```bash
git log --no-merges --format=%H d8682e0..HEAD | while read h; do git show $h --format= -p | git patch-id --stable | cut -d' ' -f1; done | sort -u > p188.pids
# per candidate: patch-ids of base..tip against p188.pids; then the files the branch changed, blob-compared with HEAD
git merge-tree --write-tree --name-only HEAD <branch>      # what a merge would still conflict on
```

## 8. P130 findings relevant to the release (state in the P188 tree)

Of ~49 findings, those the owner named plus the ones this integration changes. `CLOSED` means the
fix is in the P188 tree and was exercised there.

| Finding | State | Evidence / what remains |
|---|---|---|
| P130-19 `Number(bigint)` on money writes | **CLOSED** (was OPEN in released) | P146/P149 via P164; `tests/db/p146_*`, `tests/data/money*.test.ts` run in the P188 gate |
| P130-21 Quick CSV float money / formula injection | **CLOSED** | P157/P162 via P164 (D-141) |
| P130-22, P130-23 sign-out error ignored; A→B identity switch | **CLOSED** | P143/P145 (D-134, D-136) via P164 |
| P130-10 OCR worker leak on scanner exit | **CLOSED** | P151 (D-151) via P164; native scanner is separate code |
| P130-24 visual-only evidence reaches HIGH | **PARTIALLY_CLOSED** | P151 rule "visual-only evidence never HIGH"; calibration still synthetic-only (K-6) |
| P130-16/17 discount allocation, uncosted negative proceeds; P130-18 date bounds | **CLOSED** at the DB (D-135, P144 migrations, in P188); the hosted DB is still 104 migrations | applying them is an owner-gated release step. The currency-`XXX` half of P130-18 was not re-audited here |
| P130-02 JPY FX | **CLOSED** (released) | #108 |
| P130-08 no enforced deploy gate | **PARTIALLY_CLOSED** | the gated job is now in the tree; it only takes effect after the owner's Cloudflare action and secrets (`docs/security/RELEASE_PREFLIGHT_P163.md` Part A) |
| P130-29 CI hygiene | **PARTIALLY_CLOSED** | `permissions: contents: read` and secrets-not-vars added by P163; actions are still pinned by mutable tag (`@v4`/`@v5`) and the gitleaks image is `:latest` |
| P130-30 build supply chain | **PARTIALLY_CLOSED** | the model is SHA-256 pinned and verified before staging; the download has **no timeout**, and `onnxruntime-node`'s install-time NuGet download is unverified; ORT for React Native is pinned in the lockfile and by `with-ios-onnxruntime-pin` |
| P130-36 dependency advisories | **OPEN** | not re-run in P188 (`pnpm audit` needs the network); build-time packages only per P130 |
| P130-13 direct-edit grants on ledger columns | **OPEN** | `quantity_remaining`, `unit_cost_basis_minor`, residual and purchase totals are still `UPDATE`-granted to `authenticated` (`20260918120010_p144_privilege_baseline.sql`, `scripts/grant-audit.sql`). The functions that write them are `SECURITY INVOKER`, so revoking the grant breaks them: a design change, not a narrow fix. Self-only (an owner damaging their own ledger), not cross-user |
| P130-14 private `sealed_products` id oracle / deletion pin | **OPEN** | no migration after the released base touches it; cross-user (B can pin A's private row by a known UUID). Needs a trigger on `holdings`/`purchase_lines`; not a narrow, safe change here |
| P130-20 `secure_password_change = false` | **PARTIALLY_CLOSED** | P148/P149 refuse a password change unless the browser session belongs to the form's user (D-139). The Auth setting itself (`supabase/config.toml`, and the hosted project's) is unchanged; enabling it needs a re-authentication flow |
| P130-26 raw technical errors in financial forms | **OPEN** | D-135 and D-137 state it remains open |
| P130-09 stale-deployment reload discards typed input | **PARTIALLY_CLOSED** | purchase, sale and their edit forms, the scanner batch and bulk selection are registered with the unsaved-work registry; **Add card, Add sealed and the Openings wizard are not** |
| P130-34 privacy page said TCGdex receives nothing | **CLOSED** | `PrivacyPage.tsx` now states card images load directly from TCGdex's CDN |
| P130-41 scanner image privacy | **PARTIALLY_CLOSED** | native: 0 image egress measured in P184/P186. Web: no path from pixels/OCR text to the network was found, but `?scannerDebug=1` still works in production and its diagnostics include OCR text (unchanged) |
| Deletion semantics | **OPEN** | §4 |
| P130-12 cron URL hard-coded to Production | **CLOSED** (released, D-133) | |
| P130-06/P130-07 backup / restore | **PARTIALLY_CLOSED** | backup validated (P131); restore only through the runbook; resurrection after deletion is §4 |
| P130-35, P130-37 doc drift, commit-message wording | **OUT_OF_SCOPE** for a code candidate | documentation was brought up to date in this closeout |

No P130 fix was newly written in P188: the five security items an owner might expect to be closed
here (P130-13, -14, -20, -26, -09's remaining forms) are each either a schema or flow change with a
design decision, which the prompt's "narrow, high-confidence" bar does not allow. They are listed
here as release-relevant OPEN items rather than left implicit.
