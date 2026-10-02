# P188 release candidate

Authority: this file for what the local release candidate is, how it was verified, what the owner
must do before it can ship, and what it deliberately does not claim.
`docs/release/P188_INTEGRATION_MATRIX.md` for the per-branch audit,
`docs/mobile/BUILD_CONFIGURATION_PROFILES.md` for the native build profiles.

```text
RELEASED_MAIN = d8682e047b757f63673a63ac8185a4806d68cb98   (Production serves this)
LOCAL_RC      = release/p188-cross-platform-rc  code tip a048da53926d0c501508136d7fb11457fada1d86
PRODUCTION    = the current released main deployment, unchanged
```

**This candidate is not released, not pushed, not merged and not deployed.** Production and the hosted
database (104 migrations) were not touched. Nothing here may be read as "P188 is live".

## 1. Identity and history

| | |
|---|---|
| Base | P186 `3fac34ffb6834026fcda5ee01734197c46d3b445` (the branch was created from P186, not from P187) |
| P187 source | `79c447d9136093f5ee93f33db42b6aae794941ed`, tree `f56103cfe4e9fd342663ef4a92635b4eae8ae309` |
| Reconstruction | the nine P187 commits were replayed on P186; the one carrying a `Co-Authored-By` trailer (`60f2cd6`) was re-committed with the trailer removed. **Checkpoint:** `HEAD^{tree}` after the replay = `f56103cfe4e9fd342663ef4a92635b4eae8ae309` = `79c447d^{tree}`, before any P188 change |
| Integrations | merge P164 `bae0b604`, merge P163 `4f6be7be`, merge P165 `3d03eec7`; P156 deliberately not merged |
| Commits | 227 commits on top of the released base before the closeout documentation commit (219 non-merge), one author and committer identity |
| Attribution audit | 0 forbidden trailers or generated-by lines in any commit reachable from the candidate (matrix §6) |

## 2. What it contains

- **Native (P173 → P187):** the Android release build (R8, resource shrinking, ARM64 package, scanner
  prewarm, exact scanner index `f25fc05d569b7cca`, image-egress privacy, finance writes, dark UI) and the
  iOS source/config/JS-bundle readiness. `IOS_RUNTIME_VERIFIED=no`.
- **Web (P164):** P143/P145 identity isolation, P146/P149 exact money transport and failed-refresh
  recovery (closes P130-19 here), P151 scanner reliability, P153/P161 read-only Price Check, P157/P162 safe
  exact exports.
- **Release plumbing (P163):** the CI-gated Production deploy job, the public-build secret guard, the
  GitHub-configuration check, the secrets-not-variables design.
- **P165:** the fixture lease and CI-order fixes for the authenticated E2E suite.
- **P188 itself:** native build profiles (`LOCAL_DEV` / `LOCAL_RELEASE_TEST` / `PRODUCTION_RELEASE`),
  CI for `release/**`, three CI documentation checks, a gitleaks allow-list for two synthetic strings,
  comment rewording for a guard test, one native test following the money transport, and documentation.
- **Not in it:** account deletion (P156; restore resurrection and owner decisions unresolved), design-only
  branches, the toolchain-audit documents.

## 3. Build configuration

Three explicit profiles, one build-time variable. The Android AAB and the iOS configuration are **not
store-ready**: placeholder application/bundle ids, a local backend, local cleartext / ATS keys and the debug
keystore. A production build takes everything from the environment, fails closed and cannot fall back to
the debug keystore. Fields to choose before distribution:
`docs/mobile/BUILD_CONFIGURATION_PROFILES.md` §4. Final identifiers were **not** invented.

## 4. Verification (all local; Windows 11, Docker Desktop, own isolated stack and AVD)

Environment: Windows 11, Node 24.19.0, pnpm 10.15.0, Docker Desktop, JDK 21, Android SDK 36, own Supabase stacks (`pokeportfolio-p188`
for the database suite, `pokeportfolio-p188-app` for the native app; ports 581xx and 571xx), own AVD `p188_api36` (emulator-5568), own
application id `invalid.pokeportfolio.spike.p188`. The `skynet-*` containers were left untouched. Nothing hosted was contacted
except read-only `gh` and `git ls-remote` calls.

**Web**

| Gate | Result |
|---|---|
| Typecheck (`tsc -b --noEmit`) | PASS |
| Lint | PASS: 0 errors, 30 warnings (the existing react-refresh warnings) |
| Format (`prettier --check .`) | PASS |
| `pnpm check` (typecheck, lint, format, unit) | PASS: **196 files, 2859 passed, 1 skipped** (the env-gated perf audit) |
| Build (CI environment) | PASS; platform verifier 28/28; link checker 31/31; `dist/` secret scan OK (87 text files); `scanner:index:verify` OK, 19,500 cards, content id `f25fc05d569b7cca` |
| Browser E2E, placeholder backend (`pnpm test:e2e`, desktop Chromium + iPhone-profile WebKit emulation) | **390 passed, 114 skipped, 0 failed** (5.6 min); the skips are P151/P161's capability skips (Windows WebKit has no `canvas.captureStream`; Chromium-only specs on the iPhone project), the same figures P164 recorded |

**Database and authenticated flows** (fresh stack; `supabase db reset` from an empty database applied all 107 migrations)

| Gate | Result |
|---|---|
| `pnpm test:db` | **984 passed, 1 skipped** (65 files + 1 env-gated file), 290 s |
| Independent adversarial suites | M12 44 passed / 2 skipped, M13 62 passed, M16 53 passed; both package typechecks PASS |
| `scripts/grant-audit.sql` | PASS; hostile-grants convergence PASS (the audit rejected the hostile state, the latest `*_privilege_baseline.sql` restored it) |
| `scripts/finance-integrity-diagnostics.sql` (read-only) | every counter 0 (including all unsafe-integer, D1, voided-with-live, out-of-range-date and negative-attributable counters) |
| `redeem-invitation` function served | HTTP 400 on a nonsense token, as CI asserts |
| Authenticated E2E, whole project (2 workers) | 165 tests: **156 passed, 3 failed, 6 not run** (details below) |
| The 3 failing specs and the 6 not-run, re-run (1 worker, `P153_DB_URL` set) | **25/25 passed** |

The three first-run failures, classified: (1) `price-check-ledger.spec.ts` refused to run, `P153_DB_URL must be a loopback local
database` — a **real CI defect** (the workflow never exported that variable; fixed and pinned by `tests/config/e2e-ci-env.test.ts`),
which also explains the 6 unrun tests; (2) `auth-identity-real` cross-tab sign-out: sign-in did not leave `/login` within 15 s;
(3) `p149-refresh-failure` refresh-outage spec waited 90 s for its alert. (2) and (3) are the load-sensitive timing flakes P165 already
recorded on this desktop; both passed when re-run alone. A green re-run is not proof the cause is gone.

**Native** (`apps/mobile-spike`)

| Gate | Result |
|---|---|
| Typecheck, lint | PASS |
| `pnpm test` (Jest: unit, shared-node, shared-rn) | **89 suites, 1202 tests, 0 failed**: 906 native unit tests (including `p188-build-profile.test.ts`, which resolves each profile through the real Expo CLI) and the web's own financial/data files run under Node and under the React Native preset. **A merge regression was found and fixed here:** P146 made `tests/data/money.test.ts` import fast-check, and Jest could not resolve its `pure-rand` subpath through pnpm's symlink, so both shared projects failed to run that file until `tests/support/node-fallback-resolver.js` was added; the exact-money property tests over the whole signed `bigint` range now also run under the React Native preset |
| Hermes money proof (`pnpm hermes:proof`) | Node run 31/31, bytecode compiles (the device run is the journey below) |
| Backend (real isolated stack, serial) | **7 suites, 60 tests, 0 failed** (43 in the six core suites + 17 in the P169 Price Check suite, which needs `P169_LOCAL_BACKEND=1`; a `P169_STACK_DIR` override was added so another instance needs no source edit — the 17/17 run preceded one lint-only rewrite of that line, behaviour unchanged) |
| Build | proof APK (profile `LOCAL_DEV`) and release APK (profile `LOCAL_RELEASE_TEST`), x86_64, single Gradle pass from the real path (282 s clean, 57 s incremental) |
| **Release smoke** (`scripts/p186/smoke.mjs`, release APK, R8, no proof panel) | **9/9 PASS**: dark cold launch, sign in, Collection, scanner entry, a real synthetic image recognised on-device, candidate `P169 Charizard, P169 Base Set, 004`, Price Check (raw EUR price + NOK reference, ledger unchanged), Add to Collection form (0 rows written), cancel (ledger unchanged). Logcat: fatal 0, ANR 0, OOM 0, native crash 0, NoClassDef 0, ONNX/ML Kit 0. The **first** run exited 1 because the log pattern matched one line from Gboard (`com.google.android.inputmethod.latin`, pid not the app): "MlKitModuleManager … Modules download failed. Error code: 8" on a fresh AVD without Play connectivity. The re-run is clean; the app's own recognition succeeded in both |
| **Release journey with writes** (`scripts/p185/journey-check.mjs`, 20 steps, release-type APK with the proof panel) | **20/20 PASS**, logcat clean, 0 ADB recoveries, **image egress 0** (capture proxy: 67 requests, `imageMarkers` 0). Database-verified writes: acquisition (1 holding, 1 lot of 3, 1 purchase, 1 line), manual valuation 100.00 / explicit 0 / clear, NOK sale (net 3700, realized 1200), **EUR purchase and EUR sale with FX** (`norges_bank`, rate 11.5), sign-out, cold restart |
| iOS JS bundle (`expo export --platform ios`) | PASS, 1169 modules; `graph:ios`: **0 violations, 0 missing** (1121 modules); the scanner model (24 MB ONNX) and index (15 MB) are in the bundle; no Android-only import |
| Scanner content | the staged native index is byte-identical to the committed generation `f25fc05d569b7cca` (SHA-256 of `embeddings.bin` equal in the asset, the generation and its manifest) |

No 100-scan benchmark was re-run: no scanner code changed. The smoke's `pickToResultMs` (about 18.5-19.6 s) includes the system photo
picker interaction and equals the P186 smoke's own recorded figure (18.7 s); it is not a performance claim.

**Documentation** (`node scripts/check-doc-size.mjs`, `check-project-state.mjs`, `check-doc-links.mjs`; also CI steps now): HANDOVER.md 21.6 KB (target < 30 KB, hard < 40 KB), `PROJECT_STATE.json` 7.9 KB, `docs/CURRENT_STATE/*.md` all within budget, `PROJECT_STATE.json` schema-valid, all link and secret-shape checks (244/244 at the final tip) (now also covering `docs/release/` and `docs/mobile/`).

## 5. Security and secret audit

- **Secrets:** gitleaks over the whole candidate history (all reachable commits) — no leaks after allow-listing
  two exact synthetic strings (the jwt.io sample token in a detector test, a fixture row key). A scan of every
  line the candidate adds relative to released main found no private key, cloud token, service-role or
  secret key, and no hard-coded password outside tests and the P188 sentinels; the only JWT-shaped literal is
  the jwt.io sample. Signing material is read from the environment and never written to a file or config.
- **Attribution:** matrix §6.
- **P130 findings relevant to the release:** matrix §8 (closed, partially closed, open). Not closed here:
  -13, -14, -20, -26, the remaining forms of -09, and the supply-chain items of -29/-30.
- **Deletion:** kept out; matrix §4.

## 6. Owner-gated steps before this can ship (in order)

1. Repository visibility decision, then the GitHub settings in `docs/CURRENT_STATE/GIT_PUBLICATION_PLAN.md` §5.
2. P163 Part A: rotate the implicated key, replace the stale variables with the four secrets, Cloudflare
   Pages auto-deploy/preview settings.
3. Push `release/p188-cross-platform-rc` (private repository only) and read its own CI run.
4. A fresh `pnpm db:backup` (`BACKUP COMPLETE`), then the hosted migrations 105–107 (P144 ×2, P173), verified.
5. Deploy the changed Edge Functions: `search-prices`, `ingest-prices`, `sync-catalog` (shared `tcgdex`).
6. The gated frontend deploy from `main` after a reviewed squash merge.
7. For a store build: the identity, signing, deletion and icon decisions (`BUILD_CONFIGURATION_PROFILES.md` §4),
   and the hardware gates (a Mac and iPhone for iOS R1–R7; a physical Android device and a TalkBack pass).

## 7. Publication status (checked at the end of the session)

Checked live at the start of the session and again at the end (`gh repo view`, read-only):

| | Start | End |
|---|---|---|
| Visibility | **PUBLIC** | **PUBLIC** |
| `origin/main` | `d8682e0…` | `d8682e0…` (unchanged) |
| Branch protection / rulesets on `main` | none / none | none / none |

The repository is still PUBLIC, so **the branch was not pushed**: no GitHub Actions run exists for this
candidate, no PR was created, `main` was not touched, nothing was merged or deployed, and no repository
setting was changed (recommended settings are documented, not applied:
`docs/CURRENT_STATE/GIT_PUBLICATION_PLAN.md` §5). The first push is the owner's step after making the
repository private. Status: `SUCCESS_P188_CROSS_PLATFORM_RC_LOCAL`.

## 8. Known limits

- Every Android statement is an emulator run; arm64 is packaged but never ran. No physical device.
- Nothing was built with Xcode. `IOS_RUNTIME_VERIFIED=no`.
- No GitHub Actions run exists for this candidate, so the workflow changes (the `release/**` trigger, the
  documentation step) are verified by static tests and by running the same commands locally, not by GitHub.
- The browser E2E of the merged tree was run for the authenticated project against the isolated stack
  (§4); the placeholder-backend E2E (390 tests in P164) was not re-run because nothing it exercises changed
  after P164 apart from comments and CI configuration.
- Native tests are not part of the CI workflow.
