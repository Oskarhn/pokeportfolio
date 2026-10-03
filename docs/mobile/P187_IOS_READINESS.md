# P187 — iOS build readiness and cross-platform hygiene

Branch `feat/p187-ios-readiness`, based on the P186 SHA `3fac34ffb6834026fcda5ee01734197c46d3b445`.
Status: `SUCCESS_P187_IOS_BUILD_READINESS` — **source, configuration and JS-bundle readiness for the first Mac build.
Nothing here was built with Xcode, run in a simulator, run on an iPhone or checked with VoiceOver.** The work ran on
Windows 11; the only non-Windows environment used was Ubuntu in WSL, to let Expo generate (not build) the iOS project.

| Label | Value | Meaning |
|---|---|---|
| `IOS_SOURCE_READY` | **yes** | no Android-only API or URI assumption reaches iOS; one shared scanner path; platform-specific behaviour (keyboard, image output, OCR URI) isolated and pinned by tests |
| `IOS_CONFIG_READY` | **yes** | resolved Info.plist reviewed (§5); iOS-only plugins registered for iOS only |
| `IOS_JS_BUNDLE_READY` | **yes** | `expo export --platform ios` bundles 1,168 modules into a 3.4 MB Hermes bytecode file; the module graph holds the whole scanner chain and no Android/web implementation (§8) |
| `IOS_PREBUILD_READY` | **partial** | Expo's CLI **refuses** `prebuild --platform ios` on Windows ("Skipping generating the iOS native project files"). It was run on Linux (WSL), which the CLI supports, and generated a project that was statically reviewed. `pod install` and Xcode were not run (§9) |
| `IOS_MAC_BUILD_REQUIRED` | **yes** | `pod install`, compilation, signing, simulator and device need macOS + Xcode |
| `IOS_RUNTIME_VERIFIED` | **no** | no iOS runtime evidence of any kind exists |

Runbook for the Mac session: [IOS_BUILD_AND_DEVICE_RUNBOOK.md](IOS_BUILD_AND_DEVICE_RUNBOOK.md).

## 1. The opening-draft clock defect (fixed)

`tests/ui/opening-draft.test.ts` ("defaults to today", "a future date is refused") failed between local midnight and
the UTC offset. **A test defect:** the product's `initialDraft()` and `dateIsValidAndNotFuture()` use
`localTodayIso()` (`src/platform/local-date.ts`, the local-calendar-date contract of P175/P180/P185); the tests
compared against `new Date().toISOString().slice(0, 10)`, a UTC date. Production was not touched.

The suite now pins the clock and the zone (`vi.useFakeTimers` + `process.env.TZ`) for Oslo 00:30 / 01:30 / 02:30 /
23:59, a winter 00:30, month end (31 days and 30 days), year end, a leap day, the 2026 spring-forward and fall-back
(including the repeated hour), and America/Los_Angeles (local date *behind* UTC). A further case reproduces the old
comparison at Oslo 00:30 and shows it wrong. **Mutant:** `localTodayIso()` changed to UTC getters → 11 of the new
cases fail; restored. Web unit suite: 1,722 passed, 1 skipped, 0 failed.

## 2. Corrections to the P186 documentation

| P186 statement | Correction |
|---|---|
| "Baseline AAB = P185 code + CMake fix" | An experimental comparison build, not a Git commit and not independently addressable. The measured numbers stay; the label is fixed in P186 §1/§2 |
| bundletool 1.18.1 "hash matches pin" | A locally pinned downloaded artifact. The upstream release lists the jar (32,505,571 B) with **no published digest** (checked 2026-10-02), so the SHA-256 is a reproducibility pin, not an upstream attestation |
| "Reproducible build" | Omitted a real prerequisite: the build needs the public backend URL and publishable key. Now explicit (§4) |
| Unnecessary-permissions list | Reclassified and acted on (§3). `CAMERA` and `INTERNET` were never unnecessary |

## 3. Android manifest permissions and backup

Merged manifest of a release build of this branch (`processReleaseMainManifest`, verified after the change):

| Permission | Class | Source | Used? | Decision |
|---|---|---|---|---|
| `CAMERA` | `EXPECTED_PERMISSION` | `expo-image-picker` | yes — `launchCameraAsync` (photo screen) | keep |
| `INTERNET` | `EXPECTED_PERMISSION` | RN / `expo-file-system` | yes — the backend | keep |
| `READ/WRITE_EXTERNAL_STORAGE` (`maxSdkVersion=32`) | `DEPENDENCY_DERIVED` | `expo-image-picker`, `expo-file-system` | no effect on API 33+; the app uses the system picker | keep (library-owned; cannot be dropped without breaking API ≤ 32) |
| `ACCESS_NETWORK_STATE` | `DEPENDENCY_DERIVED` / `REVIEW_REQUIRED` | a transitive AAR (not traced further) | no | normal permission, no prompt, no data access; review before a store build |
| `<package>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | `DEPENDENCY_DERIVED` | AndroidX | yes (internal) | keep |
| `RECORD_AUDIO` | `UNNECESSARY_PERMISSION` | `expo-image-picker` plugin default | no | **blocked** (`microphonePermission: false`) |
| `SYSTEM_ALERT_WINDOW`, `VIBRATE` | `UNNECESSARY_PERMISSION` | Expo template main manifest | no | **blocked** (`android.blockedPermissions`) |
| `USE_BIOMETRIC`, `USE_FINGERPRINT` | `UNNECESSARY_PERMISSION` | `androidx.biometric` (dependency of `expo-secure-store`) | no — no `requireAuthentication` anywhere | **blocked** |

Store/privacy effect: five permissions fewer in the Play listing (the overlay and microphone permissions draw review
questions); no feature change. A test pins the blocked list and the plugin options.

**`allowBackup="true"` is safe here and left on.** The merged manifest carries `fullBackupContent` and
`dataExtractionRules` from `expo-secure-store`'s plugin; both exclude the `SecureStore` preference file from cloud
backup and from device-to-device transfer. The session and the P180 pending-write journal live only there. The app
persists nothing else (a source scan finds no AsyncStorage, MMKV, SQLite or document-directory use; scanner and picker
files are in the OS cache, which is never backed up), and Keystore keys do not migrate, so even a copied ciphertext
could not be decrypted. Pinned by `p187-storage-and-asset-contract.test.ts`.

## 4. Tooling: reproducibility and configurable drivers

- **Build environment.** `scripts/p186/build-env.cjs`: `--supabase-url`/`--publishable-key`, else
  `EXPO_PUBLIC_SUPABASE_URL`/`_PUBLISHABLE_KEY`, else the local stack's `public-env.json`; a missing prerequisite now
  names what to do. Only local development URLs and publishable keys are accepted; secret and service-role keys are
  refused. Nothing secret is read or baked.
- **Drivers.** `scripts/p186/instance.cjs` resolves stack, AVD, serial, application id, ports and evidence directory
  from `P186_INSTANCE` / `P186_PORT_SHIFT` / `P186_EMULATOR_PORT` or the existing `ANDROID_SERIAL`, `P185_*` variables
  (precedence: CLI > explicit variable > instance values > the P186 defaults, which reproduce P186 exactly).
  `stackOf` accepts an unregistered stack name when a port shift is given; `run-db-suite.mjs` honours
  `P186_DB_STACK` / `P186_DB_PORT_SHIFT`. The independent verifier's edits (own stack, serial, AVD, ports) are now
  `P186_INSTANCE=p186sha P186_PORT_SHIFT=1600 P186_EMULATOR_PORT=5562`. The verifier's uncommitted edits were **not**
  merged.

## 5. iOS target and resolved configuration

**Minimum iOS: 16.4** (the Podfile default; every Expo SDK 57 module declares 16.4; React Native 0.86 15.1, ONNX
Runtime 15.1, ML Kit 15.5, Skia 14). Minimum Xcode 16.1 (React Native 0.86's own `min_xcode_version_supported`). React
Native 0.86 runs the New Architecture only (`RCT_NEW_ARCH_ENABLED=1`, legacy architecture removed by default).

Resolved with `expo config --type introspect` (and a generated project, §9):

| Item | Value |
|---|---|
| bundle identifier | `invalid.pokeportfolio.spike` (placeholder; no App Store registration) |
| user interface style | `Dark`, forced; `RCTRootViewBackgroundColor` `#0F0F11` (needs `expo-system-ui`, added) |
| orientation / devices | portrait, iPhone only (`supportsTablet: false`) |
| camera / photo usage text | "…recognised on this device and the photo is never uploaded." |
| microphone, Face ID, location, contacts | **absent** |
| App Transport Security | `NSAllowsLocalNetworking` only (the template's `NSAllowsArbitraryLoads` is replaced); `NSLocalNetworkUsageDescription` for the LAN backend — **local candidate only, remove for a store build** |
| launch screen | `SplashScreen.storyboard` background `#0F0F11`, no image view (§6) |
| entitlements | none |

## 6. iOS-specific config plugins (iOS mods only)

- `plugins/with-ios-dark-splash.js` — the template's launch screen paints `systemBackgroundColor` (pure black under a
  forced dark style, not `#0F0F11`) and references an image asset that is not shipped. The plugin writes the app
  colour and removes the dangling image view. It throws if the storyboard shape changes. Verified on the Linux-generated
  project (well-formed, colour present). Android's splash plugin is untouched.
- `plugins/with-ios-onnxruntime-pin.js` — `onnxruntime-react-native`'s podspec depends on `onnxruntime-c` **without a
  version**, so `pod install` takes whatever is newest. The plugin adds `pod 'onnxruntime-c', '1.24.3'` (the version of the
  JS package; verified present on CocoaPods trunk, iOS 15.1, static xcframework). Verified in the generated Podfile.

Every Android-specific plugin registers `android` mods only and the two new ones `ios` only (pinned by tests).

## 7. Native dependency matrix

| Package | Version | Android | iOS | Min iOS / pod | New Arch | Privacy manifest | Workaround |
|---|---|---|---|---|---|---|---|
| react-native | 0.86.3 | yes | yes | 15.1 (Xcode ≥ 16.1) | only mode | aggregated from pods (`privacy_file_aggregation_enabled`) | — |
| expo | 57.0.24 | yes | yes | 16.4 (`Expo`, `ExpoModulesCore`) | yes | — | — |
| expo-asset / -crypto / -image-manipulator / -secure-store / -image-picker / -keep-awake / -font | ~57.x | yes | yes | 16.4 | yes | not shipped by these pods | — |
| expo-file-system / -constants / -system-ui | ~57.x | yes | yes | 16.4 | yes | **shipped** by each pod | — |
| @shopify/react-native-skia | 2.6.2 | yes | yes | 14.0; prebuilt `libs/ios/*.xcframework` (device arm64+arm64e; simulator arm64+arm64e+x86_64), downloaded by its postinstall | yes | not shipped | the postinstall needs network on the Mac (`onlyBuiltDependencies` allows it); deep imports verified for iOS (§8) |
| onnxruntime-react-native | 1.24.3 | yes | yes | 15.1; `onnxruntime-c` 1.24.3 static xcframework (now pinned) | JSI + `RCTBridgeProxy` — see risk R1 | not shipped | the pnpm patch touches `android/build.gradle` only, so nothing Android runs in an iOS build |
| @react-native-ml-kit/text-recognition | 2.0.0 | yes | yes | 15.5; `GoogleMLKit/TextRecognition` 8.0.0 | legacy module through the interop layer — risk R1 | not verified | see risk R2 |
| @supabase/supabase-js, react-native-url-polyfill | 2.112.3 / 4.0.0 | JS | JS | — | — | — | — |
| @react-navigation/*, expo-status-bar | 7.x / ~57 | JS | JS | — | — | — | `@react-navigation/elements` added as an explicit dependency (header height for the iOS keyboard offset) |
| react-native-screens / safe-area-context | 4.26.2 / 5.7.0 | yes | yes | RN minimum | yes | not shipped | — |

## 8. What was checked, per area

- **JS bundle:** `expo export --platform ios` (and `android`) bundle with zero violations; `scripts/p187/ios-graph-check.cjs`
  reads the source map and fails on any Android/web-specific module, build-time code in the runtime, or a missing link of
  the scanner chain. Skia's deep imports (used to avoid Reanimated, P182) resolve on iOS — they are platform-neutral, so no
  `.android.ts`/`.ios.ts` adapter was needed; Reanimated is not required.
- **Image URIs:** no `content://`, `MediaStore`, `PermissionsAndroid` or other Android-only API in the shipped source
  (classified and pinned). expo-image-picker returns `file:///` URIs on both platforms. iOS's ML Kit binding calls
  `[NSURL URLWithString:]` and feeds the result to `UIImage` **without a nil check**, so `recognizeCardText` now refuses
  anything but a correctly encoded local `file:///` URI before the native call (a malformed string would otherwise reach
  native code as nil).
- **Picker quality:** pinned at 0.8 (< 1). On iOS the picker only re-encodes when quality < 1; at 1 it returns the
  original, usually HEIC, which the header check refuses and Skia may not decode. The re-encode also bakes orientation in.
- **Camera / library:** camera capture **is** implemented (`launchCameraAsync`) and library selection uses the system
  picker (`PHPicker`, no library-permission prompt to pick). The simulator has no camera: that path reports unavailable
  (existing handling); test the library path there and the camera on a device.
- **OCR on iOS:** ML Kit text recognition is statically linked (models in the binary, **no model download**), runs
  on-device, works offline after install, takes a local file URI. Captured pixels are not uploaded: the egress guard and
  image-egress tests are platform-independent, and no new network path exists.
- **Keyboard:** `padding` on both platforms; on iOS a `keyboardVerticalOffset` equal to the native-stack header height
  (a `KeyboardAvoidingView` measures against the screen); Android keeps 0. Unit-tested with the platform mocked.
- **Safe areas / widths:** layout primitives (TaskScreen footer, bottom sheets, tab bar) take insets from the safe-area
  context; no hard-coded navigation-bar number; no fixed UI width above 320 pt; controls use `minHeight`. Source/layout
  tests for 320 / 375 / 390 / 430 pt at font scale 1.0 / 1.3 / 2.0 with iPhone insets (home indicator 34, Dynamic
  Island 59). **These are not iPhone runtime tests.**
- **Dark first:** forced dark style, `#0F0F11` root view and launch screen, `StatusBar` from `expo-status-bar`; the
  Android navigation-bar plugin does nothing on iOS.
- **SecureStore on iOS (Keychain):** `WHEN_UNLOCKED_THIS_DEVICE_ONLY` — not in backups, not migrated to another device.
  Journal entries hold identifiers only (no amounts, card data or credentials) and are bound to the user id. **Keychain
  items survive an app uninstall on iOS**, so a reinstall can find the previous session and journal; the session expires
  normally and journal entries of another user are never returned, but the app does not purge them on a fresh install.
  A first-run purge (a marker in the app's document directory, which *is* deleted with the app) is a recommended
  follow-up, not done here. Verify: gate G9 in the runbook.
- **Scanner assets:** the same model (`3afdc8bc…d917`, DINOv2 small int8, revision `c2bb04a5…c701`), the same index
  (`eaec748d…5540e`, 19,500 cards) and the same generation `f25fc05d569b7cca` on every platform; no scanner source
  branches on the platform; hashes are verified at load. No iOS-specific embeddings exist.
- **Privacy manifest:** no app-level `PrivacyInfo.xcprivacy` is generated. Pods that ship one: `expo-file-system`,
  `expo-constants`, `expo-system-ui`; React Native aggregates its own. Not verified: ML Kit, ONNX Runtime and Skia.
  After `pod install` produce Xcode's Privacy Report and compare. **No declaration was invented.** What the app
  collects (account e-mail, the user's own purchase/sale records, sent to the owner's backend; no analytics, no
  tracking SDK) is the input to App Store privacy labels and is a store-submission decision.

## 9. iOS prebuild boundary

`npx expo prebuild --platform ios` on Windows: **`BLOCKED_WINDOWS`** — Expo skips the iOS files and fails with "At least
one platform must be enabled". Not worked around. The same command on Ubuntu (WSL) generated `ios/` with
`Podfile`, `Info.plist`, `SplashScreen.storyboard`, an empty entitlements file, `AppDelegate.swift`, the Xcode project
and no privacy manifest; `Podfile.properties.json` has no `ios.deploymentTarget` (default 16.4). `ios/` and `android/`
are gitignored (generated) and were not committed. `pod install` was **not** run (CocoaPods needs macOS).

## 10. Risks the first Mac build must answer

| # | Risk | Evidence | What to do |
|---|---|---|---|
| R1 | **ONNX `install()` under the New Architecture.** `OnnxruntimeModule.mm` is a legacy `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD` module that casts `_bridge` to `RCTCxxBridge` and reads `.runtime`; under bridgeless it is an `RCTBridgeProxy`, which does expose `runtime` and `jsCallInvoker`, so it can work, but **no one has run it**. `RCTCxxBridge` is still declared in 0.86 headers, so it should compile | source reading | gate G4: `InferenceSession.create` succeeds; if `install()` returns false, the scanner cannot load the model — stop and report |
| R2 | **Binary size.** The ML Kit RN podspec depends on all five script pods (Latin, Chinese, Devanagari, Japanese, Korean) and its `.m` imports and instantiates all of them; Google documents about 38 MB per script SDK. Android drops four (P186); iOS cannot without patching the wrapper | podspec, `TextRecognition.m`, ML Kit docs | measure the `.ipa`/app size; if too large, patch podspec + `.m` to Latin only (pnpm patch) **and re-verify on a Mac** |
| R3 | Keychain survives uninstall (§8) | iOS behaviour | gate G9; consider a first-run purge |
| R4 | ML Kit on the Apple-silicon simulator | not verified (historically pods excluded arm64 simulators) | if `pod install`/link fails, use a physical iPhone |
| R5 | Skia's postinstall downloads xcframeworks | `react-native-skia.podspec` raises if `libs/ios` is missing | `pnpm install --frozen-lockfile` on the Mac with network access |
| R6 | Xcode 27 / iOS 27 SDK requires UIKit scene-based lifecycle (Expo SDK 57 changelog) | changelog | if the Mac builds with it, evaluate `ios.enableSceneSupport` (`expo-build-properties`, not installed) |
| R7 | ATS now only exempts local networking; a LAN IP over HTTP should be exempt, not proven | Apple ATS rules | gate G2; if blocked, a development-only `NSAllowsArbitraryLoads` |

## 11. Verification run on this branch

| Gate | Result |
|---|---|
| native typecheck / lint / format | clean (root `prettier --check .`, ESLint with the native config, `tsc --noEmit`) |
| native unit (`unit`, `shared-node`, `shared-rn`) | **892 tests, 88 suites** (P186: 776 / 80) |
| native unit, Android haste platform (`pnpm test:android-resolver`) | 804 tests, 74 suites (the `unit` project resolved as Android) |
| web: typecheck, ESLint, `pnpm test`, build | typecheck clean, 0 errors (27 pre-existing warnings), **1,722 passed, 1 skipped, 0 failed**, build green (placeholder `VITE_SUPABASE_URL`) |
| P187 mutants (`scripts/p187/mutations.mjs`, 28 + the date mutant of §1) | **28 / 28 killed, 0 survived, 0 invalid** after two fixes (I10 survived because the test iterated the mutated list; I15's anchor predated Prettier); date mutant: 11 failing cases |
| Android release smoke (the OCR URI guard is shared scanner code) | **9 / 9 PASS** on a clean release APK (R8, 121,098,809 B, x86_64, built with the explicit `--supabase-url`/`--publishable-key` path from a clean prebuild with the five permissions blocked) on a fresh emulator/stack/app id of **instance p187** (`P186_INSTANCE=p187 P186_PORT_SHIFT=1800 P186_EMULATOR_PORT=5562`, no source edit): real picker → on-device OCR + ONNX + Skia → candidate → Price Check → Add (0 rows) → cancel → Collection. Logcat: fatal 0, ANR 0, OOM 0, native crash 0, NoClassDef 0, crash buffer empty; image egress 0 (10 requests, largest body 148 B). The smoke's `ortOrMlKit` counter reported 1: the line belongs to pid 1568, Gboard (`com.google.android.inputmethod.latin`), "Modules download failed" in its own ML Kit manager, not to the app; the counter does not filter by pid |
| database | not rerun: no database, migration or shared-date code changed (P186: 771 passed, 1 skipped, 0 failed) |

New suites: `p187-ios-config`, `p187-ios-graph`, `p187-ios-image-pipeline`, `p187-ios-layout-readiness`,
`p187-keyboard-platform`, `p187-platform-portability`, `p187-driver-config`, `p187-storage-and-asset-contract`.
No Android runtime source changed except the shared OCR URI guard and the picker-quality constant, both exercised by the
smoke above. A full 100-scan Android benchmark was not repeated (no performance-relevant change).

## 12. Environment hygiene

The incomplete P186 independent-verification environment was removed: stack `p186sha` stopped (zero containers, zero
volumes), worktrees `p186-sha` and `p186-sha-base` removed (`git worktree remove`/prune; `node_modules` needed a
long-path delete), the verifier's never-started AVD `p186sha_api36` deleted. Its uncommitted edits to
`scripts/p169/local-backend.mjs` and `scripts/p186/env.mjs` were saved outside the repository and **not merged**; the
branches `verify/p186-sha-*` were left in place. This phase's own stack, emulator, proxy, mock provider and Gradle
daemon were stopped (zero `p187` containers; the `skynet-*` containers were not touched).
