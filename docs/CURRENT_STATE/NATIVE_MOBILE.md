# Native mobile — current state

Authority: this file for current status; `HANDOVER.md` §9 for the one-paragraph summary;
`docs/PROJECT_STATE.json` → `local_candidates.native_integrated` /
`local_candidates.native_financial_writes` for machine-readable pointers.

## What exists

A React Native/Expo native app track, built up across a long, mostly-linear chain of local
prompts. **Nothing in this track has ever been merged, pushed, or released.** It lives entirely
in local worktrees under `C:\Users\Oskar\Documents\Pokemonapp-worktrees\`.

| Branch (worktree) | Prompt | What it added |
|---|---|---|
| `spike/p158-native-collection-pricecheck` | P158 | Initial native spike — source-built, Hermes-compiled. No Hermes/Android execution performed (per P158's own report). |
| `spike/p166-native-runtime-stitch` | P166 | First runtime spike reported running on an Android 16 emulator/Hermes; SDK installed this session. |
| `fix/p167-native-android-runtime-hardening` | P167 | Android runtime hardening; per-worktree stack/`ANDROID_SERIAL` isolation; F1 patch backport. Mobile-only diff (verified `git diff` touches nothing outside `apps/mobile-spike` and `docs/mobile`). |
| `feat/p169-native-catalog-price-check` | P169 | Native catalog + Price Check. Graded pricing is `PARTIAL_NO_AUTHORIZED_PROVIDER` — no paid grading source is authorized. |
| `feat/p170-integrated-native-android` | P170 | Attempted integration. **No `output_170.txt` exists anywhere** — a later session (P172) explicitly found no evidence this prompt completed successfully, and did not guess its SHA. |
| `feat/p173-native-integration-recovered` | P173 | Recovers the missing P170 handoff; the base of the current native lineage. SHA `0600361f71ee2dd5591fbbbfb2fe260ab68ba7a2`, 105 local migrations (104 released + 1: `20260926120000_p173_search_cards_stable_paging.sql`). **Corrected 2026-09-28 (P183): P173 WAS device-verified** — its own report (`output_173.txt`) shows a release APK (Hermes, embedded bundle) driven on a real Android 16 x86_64 emulator with 35/35 and 19/19 passing driver runs. P176's `LOCAL_ONLY_NOT_DEVICE_VERIFIED` label conflated "unmerged" with "never run on a device" (P177 found and documented this error; see `docs/handover/STATE_RECONCILIATION.md`). "Local-only" (never merged/pushed) remains correct. |
| `feat/p175-native-financial-write-flows` | P175 | Native financial write layer built **on top of P173** (confirmed ancestor). SHA `a193a8bab2d742edd504ec578253f99c18f6d9d1`, 107 local migrations (105 + 2 copied verbatim from the P144 worktree). Its own report states the native build was NOT run that session — correctly labelled `LOCAL_ONLY_NOT_DEVICE_VERIFIED` as of P175. Device-verified one phase later by P177 (below). |
| `test/p177-native-financial-runtime` | P177 | **Device-verified the P175 write seam for the first time.** Release APK on a fresh AVD, all 6 write flows (add-acquisition, purchase, sale, opening, manual valuation) driven through the real app navigation, 28/28 driver steps passing, every write independently checked against the live database. Found and fixed 2 real defects (missing `condition` on purchase, `CardDetailScreen` not reloading after a write). Full DB suite green for the first time on this track with Edge Runtime enabled (745/1/0). SHA `0d1d93887ce900fb71778e635d89f0c159b7a62d`, 107 local migrations (unchanged from P175). |
| `feat/p178-dark-native-ui` | P178 | Dark-first "Utility structure + Foil identity" visual redesign (the owner's explicit hybrid choice from the P174 decision pack) — 22-token theme system, 45-component UI kit, real on-device JPY currency selector. Found the FX-rate gap: `create_purchase`/`create_sale` reject any non-NOK currency because the screens never supplied `p_fx_rate_to_nok`/`p_fx_rate_date`/`p_fx_source` (disclosed as a BLOCKER, fixed in P180). SHA `084c7478baa45b8c8c85d2001e0825e66cd81f20`, 107 migrations. |
| `test/p179-dark-ui-finish-gate` | P179 | UI finish-gate review of P178. Found and fixed a real white-flash-on-cold-launch defect (missing `expo-splash-screen` config plugin) and a Price Check typography/corner-radius drift from the shared design tokens. Device-verified big-money rendering (2^53+1 and ~2.88×10^17 minor units, no truncation) and the null/zero distinction. SHA `486bb86bdebc0e8aba566267bc8218117ed44a29`, 107 migrations. |
| `feat/p180-native-financial-reliability` | P180 | **Closed the P178/P179 FX-rate blocker.** New `fx-for-write.ts` resolves a rate via the same `fx-source.ts` Price Check already uses, fails closed with no usable rate, never silently substitutes 1. Device-verified end-to-end: a real EUR sale, real FX notice, real NOK reference, independently confirmed against the database. Also built a pending-write journal (SecureStore-backed, addresses the process-death-after-commit gap disclosed since P177) and fixed the raw-UUID-in-purchase-form display. SHA `ecdb120863f0d8478ed69216cb64272b734de2a7`, 107 migrations (no schema change — client/tooling fix only). |
| `feat/p181-native-device-accessibility-performance-gate` | P181 | **Previous native tip (2026-09-27).** Representative (not exhaustive) device-matrix pass: 360/390/430dp widths, font scale up to 200%, Activity recreation, one performance/memory snapshot, full-session ANR/crash sweep (zero). Found and fixed a real tab-label mid-word-break defect at 200% font scale. SHA `45ebfefa9a5038e20dd1999644eb96c1ae6352ef`, 107 migrations. **Scoped success, not full certification** — see "What is NOT verified" below; its own STATUS is `SUCCESS_P181_NATIVE_PRODUCT_BASELINE_GATE` with explicitly disclosed gaps, not `FULLY_CERTIFIED`. |

| `feat/p182-native-card-recognition` | P182 | **Native on-device card recognition proven on a release APK** (ML Kit OCR + ONNX/DINO + shared index `f25fc05d569b7cca` → a real candidate); reliability scope not run. SHA `615475209a3342c0c627ceddc00fa37606c59fad`, 107 migrations. |
| `feat/p187-ios-readiness` | P187 | **Latest native branch (iOS build readiness; no product feature).** Source, configuration and JS-bundle readiness for the first Mac build: the iOS JS bundle resolves (1,168 modules, whole scanner chain, no Android implementation), resolved Info.plist reviewed (dark, camera/photo text, ATS local-networking only), iOS-only splash and `onnxruntime-c` pin plugins, iOS keyboard offset, OCR URI guard, picker kept below quality 1, five unused Android permissions blocked, `allowBackup` audited, drivers configurable by environment, build env explicit, opening-draft clock test fixed. **Not built with Xcode, not run on any Apple device** — `IOS_RUNTIME_VERIFIED=no`; Expo refuses iOS prebuild on Windows (generated once on Linux/WSL). `SUCCESS_P187_IOS_BUILD_READINESS` — [readiness](../mobile/P187_IOS_READINESS.md), [Mac runbook](../mobile/IOS_BUILD_AND_DEVICE_RUNBOOK.md). |
| `perf/p186-native-packaging-scanner` | P186 | **Previous native candidate (packaging and performance, no behaviour change).** Real Android App Bundle (arm64-v8a + x86_64): **63.9 MB delivered to an arm64 phone** (was 72.3; the 129.8 MB emulator APK is not a download size), R8 + resource shrinking on, four unused ML Kit script packages dropped, a scanner **prewarm** on entering the photo screen (cold photo → result 3.6 s → 2.3 s median; model-session wait 0.7 s → 0 s), memory attributed per component, the date-dependent `m12` DB test fixed (full DB suite 771 passed / 0 failed), arm64 library build fixed on Windows. Adversarial suite 24/24, 0 false HIGH, image egress 0. `SUCCESS_P186_ANDROID_RELEASE_OPTIMIZED` — [details](../mobile/P186_ANDROID_PACKAGING_PERFORMANCE.md). arm64 is proven **statically** only. |
| `release/p185-native-rc-closure` | P185 | Previous native candidate. Closes P184's six open items on an emulator: 20/20 release-APK journey, scanner usable at 360 dp/200 % (found and fixed a truncated card identity, a missing HIGH confidence text, a 46×27 dp switch), manual valuation 100/0/clear and NOK + EUR sales database-verified, adb-loss recovery, 14 new mutants killed, radio/switch touch-target sweep. Code tip `b4100bcb4522d77fbf3e569f433e3307dea9c55e`, 107 migrations. `SUCCESS_P185_NATIVE_RC_VERIFIED` — [details](../mobile/P185_NATIVE_RC_CLOSURE.md). |
| `release/p184-native-rc` | P184 | Hardened predecessor. Hardens and device-verifies the scanner (24/24 adversarial, 0 false HIGH, 0 image egress, warm median 1.04 s, memory plateau, clean-install build in one pass). SHA `953aa017d2f950e77d1319dd238dcd35d83b5ded`, 107 migrations. `PARTIAL_P184_NATIVE_RC_HARDENING` — [details and gaps](../mobile/P184_NATIVE_RELEASE_CANDIDATE.md). |

Lineage: `P173 → P175 → P177 → P178 → P179 → P180 → P181 → P182 → P184 → P185 → P186 → P187` (each branch built directly on the
previous one's tip; ancestry confirmed via `git merge-base --is-ancestor` in each phase's own
report). None of these branches is merged or pushed.

## P188 (current tip): the native line now sits on the integrated web line

`release/p188-cross-platform-rc` carries P186 + P187 (history rebuilt without an attribution trailer,
tree-identical) and the web candidates the native line never had (P164, P163, P165; matrix
`docs/release/P188_INTEGRATION_MATRIX.md`). The native app imports the web `src/` data layer through
`@shared`, so it now runs the exact decimal-string money transport (D-137): one native test that pinned the
old JSON-number cursor was updated, nothing else in `apps/mobile-spike/src` changed except the build
profile work below. Re-verified on the merged tree: native typecheck, lint, 906 unit tests, backend tests
against a fresh isolated stack, and the Android release smoke (`docs/release/P188_RELEASE_CANDIDATE.md` §4).

**Build profiles.** `LOCAL_DEV`, `LOCAL_RELEASE_TEST`, `PRODUCTION_RELEASE` (`EXPO_PUBLIC_BUILD_PROFILE`;
`apps/mobile-spike/config/build-profile.cjs`, `app.config.js`, `plugins/with-release-signing.js`,
`src/config/backend-config.ts`). Only `PRODUCTION_RELEASE` accepts a hosted backend; it takes identity and
signing from the build environment and fails closed. Nothing real is committed; the placeholders
(`invalid.pokeportfolio.spike`) stay until the owner chooses. [docs/mobile/BUILD_CONFIGURATION_PROFILES.md](../mobile/BUILD_CONFIGURATION_PROFILES.md).

**Still true:** the Android AAB and the iOS configuration are **not store-ready**; `IOS_RUNTIME_VERIFIED=no`
(risks R1–R7 in `docs/mobile/P187_IOS_READINESS.md`); in-app account deletion exists on the P189 branch
(Profile → Delete account, the same backend contract as the web app; `docs/release/P189_ACCOUNT_DELETION.md`) and is
not in the P188 line.

## What is NOT verified (as of P187, the current tip; P181-era gaps still apply unless noted)

- **P187 / iOS:** nothing has been compiled or run on Apple platforms. Open, in this order: ONNX Runtime `install()` under the New Architecture (R1), ML Kit pulls five script pods (binary size, R2), Keychain survives uninstall (R3), ATS for a LAN backend (R7). Status labels: `IOS_SOURCE_READY` / `IOS_CONFIG_READY` / `IOS_JS_BUNDLE_READY` yes; `IOS_PREBUILD_READY` partial (Linux-generated, Windows blocked); `IOS_MAC_BUILD_REQUIRED` yes; `IOS_RUNTIME_VERIFIED` **no** ([risks](../mobile/P187_IOS_READINESS.md#10-risks-the-first-mac-build-must-answer)).

- **P186:** arm64-v8a is packaged (`ARM64_PACKAGE_PRESENT`) but has never run — no arm64 runtime exists on the build machine. The AAB is a local candidate only (placeholder application id, loopback cleartext config, local backend URL, debug keystore) and (until P187 blocked them) its merged manifest asked for `RECORD_AUDIO`, `SYSTEM_ALERT_WINDOW`, `VIBRATE` and biometric permissions a scanner does not need. The prewarm costs a person who opens the scanner and leaves ~110 MB more resident memory until the app closes (an idle unload was measured: 19 of 277 MB, not shipped).

- **P185:** TalkBack was enabled and responded on the emulator but a scripted traversal of the scanner path could not be made reliable — a human TalkBack pass on a real device is still wanted; no arm64 / physical device. (P184's journey, 360dp text and manual-valuation/sale gaps are closed by P185.)

- **TalkBack itself was never run** (P181 used the `uiautomator` accessibility-tree proxy, not a
  real screen-reader pass).
- **The full device matrix is not exhaustive**: of the mission's ~16 screens × 6+ width/scale/theme
  combinations, P181 drove a representative subset (6 screens, 3 widths, up to 200% font, dark only
  — the app has no reachable light theme by design). Font scale 130%, the 390/430dp combinations at
  full font scale, and several screens (Search, Price Check, Photo, Record purchase, Record
  opening, Profile) were not individually device-driven in P181.
- **Performance and memory are one representative snapshot each**, not the full
  cold/warm/30-fling/7-checkpoint battery the mission specified.
- **JPY has never been driven as an on-device purchase journey** — its exact-money/FX math is
  proven at the unit/Hermes/RPC level (P177, P180) but the currency selector's JPY path was only
  UI-verified (P178), not submitted end-to-end on a device.
- **No iOS simulator capability** — the host is Windows 11; iOS work needs a macOS host with Xcode, which no session here has had. P187 prepared everything that can be prepared without one.
- **P170's actual completion status is still unknown** — P173 exists specifically to route around
  that gap; nothing retroactively proves P170 itself succeeded. Not relevant to current work, kept
  for historical accuracy.
- **Graded-card pricing is intentionally incomplete** (no authorized provider, `docs/COST_POLICY.md`).
- **No final app icon selected; no N1/N2 navigation decision made** — both deliberately deferred
  through every phase P178–P181.

## Before doing more native work

1. Verify the Android toolchain (SDK, emulator or device, `ANDROID_SERIAL`) is actually present in
   your session — P159 found it entirely absent in a clean session; P166/P167 had to install it.
2. Start from P185's tip (`b4100bcb4522d77fbf3e569f433e3307dea9c55e`) — it is the most
   device-verified point in the lineage, but re-verify rather than assume if picking this up much
   later; do not build further on an unverified re-read of the tip.
3. Check `docs/handover/STATE_RECONCILIATION.md` for the divergent local migration counts before
   assuming any one branch's count is authoritative for "the" local database state.
4. Close the disclosed gaps above (TalkBack, the full device matrix, JPY-on-device) before treating
   this lineage as release-ready, not just "device-verified enough for now."
