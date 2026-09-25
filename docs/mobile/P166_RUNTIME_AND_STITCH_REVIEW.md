# P166: Android runtime validation and Stitch design review

The P158 React Native / Expo spike (`apps/mobile-spike`) now runs as a **release build on a real
Android runtime** (Android 16 emulator, Hermes), driven end to end against the isolated local
Supabase stack with synthetic users. The Stitch half is **partial**: the connection works, but Stitch
generated no screens (see [P166_STITCH_DESIGN_BRIEF.md](P166_STITCH_DESIGN_BRIEF.md)).

Nothing here is iOS evidence. An iOS Simulator needs macOS and Xcode; this machine runs Windows.
Nothing was pushed, deployed or run against a hosted database.

## 1. Runtime environment (verified by command, 2026-09-25)

| Item | Found / used |
|---|---|
| Host | Windows 11 Pro 10.0.26200, AMD Ryzen 5 7600X, 31 GB RAM, `HypervisorPresent=True` |
| JDK | Oracle JDK 21.0.10 (`C:\Program Files\Java\jdk-21.0.10`) used via `JAVA_HOME`. The default `java` on PATH is a Temurin 8 JRE, too old for AGP 8.12 |
| Android SDK | **Installed in P166** with owner approval from Google's official repository: cmdline-tools `commandlinetools-win-15859902_latest.zip` (SHA-256 checked against developer.android.com), platform-tools 37.0.1, platforms;android-36, build-tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1, emulator 37.1.11, system image android-36 google_apis x86_64 r07. Location `%LOCALAPPDATA%\Android\Sdk`. SDK licences accepted on the owner's instruction |
| Acceleration | `emulator -accel-check`: "WHPX(10.0.26200) is installed and usable". No Windows feature was changed |
| AVD | `p166_api36`, Pixel 7 profile, 1080x2400, Android 16 (API 36), x86_64 |
| Build | Expo prebuild (CNG, `android/` stays gitignored), Gradle 9.3.1, AGP 8.12.0, `assembleRelease` for x86_64 only: Hermes bytecode bundle embedded, no Metro |
| APK | `app-release.apk`, 30.5 MB; contains `lib/x86_64/libhermesvm.so` and `assets/index.android.bundle` whose header is the Hermes bytecode magic `c61fbc03…`, version 98 |
| Physical device | none attached (`adb devices` listed only the emulator). The Touch Portal copy of adb 1.0.41 on PATH was not used |

### Windows build problems met, and the workaround

1. **MAX_PATH.** `buildCMakeRelWithDebInfo` failed with "Filename longer than 260 characters"
   (ninja object path for `react-native-safe-area-context`). Fixed without system changes by building
   from a session-only `subst Q:` drive letter for the worktree.
2. **Mixed roots.** Codegen then failed with "this and base files have different roots" (Q: vs C:):
   autolinking resolves real paths. Working sequence: run `expo prebuild` and one Gradle pass from
   the real `C:` path (codegen succeeds, CMake fails on path length), then build from `Q:` (CMake
   succeeds, codegen is up to date). Documented in `apps/mobile-spike/README.md`.
3. **Cleartext.** The first release build could not sign in: "Could not reach the server". Android
   blocks plain HTTP for targetSdk ≥ 28 and Expo re-enables it for debug builds only. Fixed with a local
   config plugin (`plugins/with-local-cleartext.js`) that writes a network security config allowing
   HTTP **only** to `10.0.2.2`, `10.0.3.2`, `127.0.0.1` and `localhost`; every other host stays
   HTTPS-only. Unit-tested (`tests/unit/local-cleartext-plugin.test.ts`). Spike only.

Emulator routing verified: the app's `127.0.0.1:55321` backend URL is rewritten to `10.0.2.2:55321`
(P158 config), `nc -z 10.0.2.2 55321` succeeds from the emulator, and sign-in works through it.

## 2. What ran on the emulator

`scripts/android-runtime-check.mjs` drives the installed APK over adb + uiautomator (React Native
`testID` appears as `resource-id`), with no test framework added. It clears app data first, never
prints credentials, and writes `report.json` and PNGs to the gitignored `.build/android-evidence/`.
Final run (APK SHA-256 `9fb4ef93…0c84`): **17 PASS, 1 FAIL** (the FAIL is a real defect, §4 F1).

Status words: **BUILT** (APK produced), **INSTALLED**, **STARTED** (first frame), **VISIBLE** (the
screen's element was in the view tree), **INTERACTIVE PASS** (the step's taps, input and assertion
succeeded on the device).

| Step | Result | Level |
|---|---|---|
| Cold start, clean data | first frame 501–2 254 ms over 9 launches (`am start -W` TotalTime, `COLD`) | STARTED |
| Hermes exact-money proof in the app | `P166_PROOF RESULT pass=36 fail=0 engine=hermes 250829098.0.17` | INTERACTIVE PASS |
| Sign in, synthetic user A, via 10.0.2.2 → local GoTrue | first collection page visible 3.2–4.9 s after submit (one outlier 11.3 s) | INTERACTIVE PASS |
| Exact money on screen | `8 646 911 284 551 352,35 kr` (3 × (2^58+1)), `270 215 977 642 229,79 kr` (3 × (2^53+1)), manual `0,00 kr`, no price `—`, total `8 917 127 262 195 456,87 kr` | INTERACTIVE PASS |
| Card detail from the list | value + "Manual valuation" + per-card `90 071 992 547 409,93 kr` | INTERACTIVE PASS |
| Pagination + scrolling, 10 006 holdings | 45 flings, 460–502 distinct rows rendered (so at least keyset pages 2–5 were fetched), 0 empty-list samples | INTERACTIVE PASS |
| Return from background (HOME, 8 s, resume) | `HOT` 128–319 ms; still signed in; rows visible | INTERACTIVE PASS |
| Process restart (force-stop, start) | session restored from SecureStore, no login screen; rows visible 3.1–5.2 s after start | INTERACTIVE PASS |
| Accessibility tree | every clickable node has a name on Collection, Price Check, Profile (see F3, F6 for what that proxy misses) | INTERACTIVE PASS (proxy) |
| Price Check, read-only | search → card → **variant choice required, no price before choice** → Holo → `11 357,98 kr` Cardmarket via TCGdex; graded: "Not available. No authorized graded price source…" | INTERACTIVE PASS |
| Photo: library picker, cancel | real Android Photo Picker opened; BACK → "No photo chosen." | INTERACTIVE PASS |
| Photo: camera permission denied | real runtime permission dialog (While using / Only this time / Don't allow) → denied card | INTERACTIVE PASS |
| Photo: pick + owned cache cleanup | synthetic PNG pushed to the emulator gallery, picked; `cache/ImagePicker/<uuid>.png` existed while shown and was **deleted** on leaving the screen (checked as root: `adb root` works on this google_apis image) | INTERACTIVE PASS |
| Photo: allow once → system camera → back | `com.android.camera2` opened; BACK → "No photo chosen." (manual run, same build family) | INTERACTIVE PASS (manual) |
| Font scale 2.0 | collection and detail render, exact values intact (see F4) | VISIBLE |
| Photo picker after a font-scale change | **FAIL**: see F1 | — |
| Sign out | login screen; after force-stop + start still the login screen (stored session removed) | INTERACTIVE PASS |
| Identity switch A → B | B sees only B's 40 rows, none of A's named rows; B total `—` (see F2) | INTERACTIVE PASS |
| Dark mode | renders (see F5) | VISIBLE |

**Read-only and isolation on the device path.** The on-device journey only uses the app's read
paths; the stronger proof stays the backend suite (P158, re-run in P166: 5 files, 28 tests, including
the request-log allow-list and the 14-table content-hash before/after check, and RLS refusing B an A
holding by id). On-device isolation evidence is the A → B switch above.

### Hermes exact money

`src/diagnostics/runtime-proof.ts` runs inside the app when the bundle is built with
`EXPO_PUBLIC_RUNTIME_PROOF=1` and logs `P166_PROOF …` lines. On the emulator it ran on
`HermesInternal` (reported release `250829098.0.17`) and passed all 36 checks: the 14 formatter
vectors (NOK/EUR/USD 2 decimals, JPY exponent 0, negatives, ±(2^53+1), 2^58+1), NULL → `—` vs `0,00 kr`,
BigInt exactness (3 × (2^58+1) = 864691128455135235), the wire parser (`"9007199254740993"`,
`"288230376151711745"`, `"-9007199254740993"` exact; `""` and an unsafe JSON number refused; null stays
null, `"0"` stays zero), the raw-body transport scan (unquoted ±unsafe integers found, quoted 2^58+1
passes JSON.parse byte-for-byte) and JPY 2^53+1 via wire + formatter. The same function passes under
Jest (Node) and reports `engine=not-hermes` there, so the Jest run cannot be mistaken for Hermes evidence.
The real backend round trip on Hermes is the on-screen values in the table above.

## 3. Performance (emulator, not a phone)

Measured on an x86_64 emulator with host GPU on a desktop CPU. These numbers say nothing about a
mid-range phone. Every "visible after" figure is sampled with `uiautomator dump`, which takes about
**2.1 s** per sample here, so those figures are upper bounds with ~2 s resolution.

| Metric | Value |
|---|---|
| Cold start to first frame, clean data | 501–2 254 ms (9 launches; the last three 568, 646, 501) |
| Warm/hot resume | 128–319 ms |
| Restart with stored session to first rows | 3.1–5.2 s (includes session restore, first keyset page, and dump latency) |
| Scroll: 45 flings over the 10 006-holding list | 0 blank samples; 2 555–3 937 frames rendered; janky 689–1 197 (≈ 27–40 %); frame time p50 24–32 ms, p90 48–73 ms, p99 73–150 ms (`dumpsys gfxinfo`) |
| Memory (PSS) | ≈ 104–107 MB after the first page → 161–166 MB after ~490 rows scrolled (`dumpsys meminfo`); not measured further, no leak test |

The jank share is high for a list this simple. Emulator rendering is a plausible part of it, but that
is an inference; it needs a physical-device measurement before any conclusion.

## 4. Findings (real, from the runtime)

| # | Finding | Evidence | Status in P166 |
|---|---|---|---|
| F1 | **expo-image-picker 57.0.19 breaks after a configuration change.** Changing the system font size (also display size or language: `fontScale`, `density`, `locale` are not in MainActivity's `configChanges`) recreates the Activity; the next picker launch throws `IllegalStateException: Attempting to launch an unregistered ActivityResultLauncher … ImageLibraryContract`. The photo flow is dead until the app restarts. Dark mode (`uiMode`) is in `configChanges` and does not trigger it | reproduced 3×; `18-picker-after-config-change.png`; logcat cause chain | **Not fixed.** Options: add `fontScale\|density\|locale` to `configChanges` via a config plugin (then RN must handle those changes in-process: to be verified), or an upstream fix; check newer expo-image-picker releases first (not checked) |
| F2 | Collection total showed `0,00 kr` for a user whose 40 holdings all lack a value (F14: missing is not zero; the web app shows it as missing) | user B on the emulator | **Fixed**: total is `—` when `pricedHoldingCount === 0`; unit test; re-verified on the emulator |
| F3 | Tab bar shows a missing-glyph box instead of icons, and screen readers get the label `"⏷, Collection"` (React Navigation's fallback glyph) | uiautomator content-desc; every screenshot | Not fixed (visual design is owner-pending; the spike has no icon set) |
| F4 | At 200 % text: large amounts break inside a digit group (`8 917 127 26` / `2 195 456,87`), card titles collapse to `P1…`, tab labels truncate (`Collect…`) and collide with the gesture bar | `06-font-2.0-collection.png`, `07-font-2.0-detail.png` | Not fixed; input for the design system (P154 asks for wrapping at group separators or `adjustsFontSizeToFit`) |
| F5 | Dark mode: content turns dark but the navigation header and tab bar stay light, and the status bar icons become white on white | `17-dark-collection.png` | Not fixed (navigation theme not bound to the system scheme) |
| F6 | Touch targets: the uiautomator bounds of list rows, tabs, Price Check buttons and Sign out are below 48 dp in at least one dimension (Android guidance; P154 asks for hit-slop) | `under48dp` in `report.json` | Not fixed; recorded |
| F7 | With the keyboard open the Sign in button is covered (`KeyboardAvoidingView` does not lift it on Android 16 edge-to-edge); submitting via the keyboard's action key works | `02-login-after-submit` (not committed: shows the synthetic e-mail) | Not fixed |
| F8 | A library-picker failure was labelled "The camera is not available here": the adapter classified any error whose message contains "camera" as `no_camera`, and the store dropped the reason | device run 3 | **Fixed**: only the camera path can be `no_camera`; the reason is kept and the library copy says "The photo could not be opened"; mutation-checked unit test; a `console.warn` now logs the picker's own message (no personal data) |

## 5. Accessibility: what was and was not tested

Tested: font scale 2.0 renders (with F4), dark mode renders (with F5), every clickable node has an
accessible name, the permission dialog is the system's. **Not tested:** TalkBack itself (no TalkBack
on this image), reading order, focus movement, Reduce Motion, contrast measurement on device, and
anything on iOS/VoiceOver. `ACCESSIBILITY_RUNTIME` is therefore partial.

## 6. Not done, and why

- **iOS**: impossible on Windows; no claim.
- **Physical Android device**: none attached.
- **Stitch screens**: generation timed out 7 times with nothing stored; brief and exact steps in
  [P166_STITCH_DESIGN_BRIEF.md](P166_STITCH_DESIGN_BRIEF.md).
- **Scanner/OCR**: none exists in the spike; the photo flow is a picker + ownership prototype only.
- **P149/P153/P164 integration**: out of scope and not merged; the spike's adapters are unchanged
  apart from the fixes above (INTEGRATION_PLAN.md still applies).
- **Mutation proofs (`pnpm mutation`)**: not re-run in P166 (P158's 12/12 stand for the unchanged
  modules); the two new tests were mutation-checked by hand (§4 F2, F8).

## 7. Reproduce (Windows 11, Git Bash or PowerShell)

See `apps/mobile-spike/README.md` → "Android runtime (P166)". In short: backend start + seed, write
`.env.local` with the local URL/publishable key and `EXPO_PUBLIC_RUNTIME_PROOF=1`, `expo prebuild`,
two-pass Gradle build (C: then `subst` drive), `adb install -r`, `node scripts/android-runtime-check.mjs`
(`P166_STEPS=<regex>` runs a subset).
