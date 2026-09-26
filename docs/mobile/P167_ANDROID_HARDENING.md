# P167: Android runtime hardening, photo picker and accessibility

The P158/P166 native spike (`apps/mobile-spike`, React Native 0.86.3 / Expo SDK 57, Hermes) was taken
from "runs on an emulator" to "survives what an Android phone does to an app": configuration changes,
process death, light/dark switches, large text, the keyboard and a second account. Every defect below
was reproduced on the emulator first, fixed, and re-run on a release build from a clean prebuild.

**Scope of the evidence.** One Android 16 (API 36) x86_64 emulator with a host GPU on a Windows 11
desktop. Nothing here is physical-handset or iOS evidence. Local isolated backend only; no hosted
database or Production was touched. Visual design was not changed beyond what platform correctness
required (P168 owns design).

## 1. Environment

| Item | Value |
|---|---|
| Base | P166 `41dea0e` (descends from P158 `4bf128f`; merge base with `origin/main` = `d8682e0`, the released main) |
| Branch / worktree | `fix/p167-native-android-runtime-hardening`, `Pokemonapp-worktrees\p167` |
| Toolchain | Node 24.19.0, pnpm 10.15.0, JDK 21.0.10 (`JAVA_HOME`), Android SDK platform 36, build-tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1, emulator 37.1.11 |
| Packages | expo 57.0.24, expo-modules-core 57.0.18 (**patched**, §3), expo-image-picker 57.0.19, expo-file-system 57.0.7, react-native 0.86.3, @react-navigation/bottom-tabs 7.19.2 |
| Device | AVD `p166_api36` (Pixel 7 profile, 1080x2400, 420 dpi = 2.625 px/dp), `emulator-5554`; a parallel session ran its own AVD, so every command is scoped with `ANDROID_SERIAL` |
| Backend | own stack `pokeportfolio-p167`, ports 55020-55029 (offset +700; offset +1200 was dropped after a reboot moved Windows' reserved port range 55518-55617 over it), synthetic users A (10 006 holdings) and B (40). P137 cron isolation re-verified by `tests/backend/isolation.test.ts` |
| Build | `expo prebuild --clean`, Gradle two-pass (C: for codegen, then `subst Q:` for CMake's 260-character limit), `assembleRelease -PreactNativeArchitectures=x86_64`, Hermes bytecode bundle (magic `c61fbc03`) |
| Final APK | 30 480 533 bytes, SHA-256 `6686a124f7fa5bdeda49196a23cc3200ee9946310f8d05689ec749040db54ef6` (gitignored; built from `expo prebuild --clean` at the final commit's app code) |

## 2. Baseline (unchanged P166 build on this emulator)

The unchanged P166 driver on the unchanged P166 app: **17 PASS / 1 FAIL**, the FAIL being F1 with
`IllegalStateException: Attempting to launch an unregistered ActivityResultLauncher with contract
expo.modules.imagepicker.contracts.ImageLibraryContract`. The new P167 driver on the same build failed
F7, F3, F6, F5 and every photo step after a recreation (report kept in the gitignored
`.build/p167-evidence-baseline/`), for example:

- F7: Sign in button bottom 1575 px, keyboard top 1517 px (covered).
- F3: accessible name `"⏷, Collection"`.
- F6: `check-price`, `pc-query`, `pc-search`, `pc-toggle-source`, `pc-photo`, `photo-library`,
  `photo-camera`, `sign-out` at 44-45 dp.
- F5 dark: status-bar band luminance 1.0 (white) with light icons.
- Camera "only this time": the system camera never opened (the camera launcher is dropped the same way).

## 3. F1: photo picker dead after an Activity recreation

**Reproduction.** Photo screen, then `settings put system font_scale 1.3` (or `wm density 480`, or
`cmd locale set-app-locales <pkg> --locales nb-NO`). The system event log proves a real recreation:
`wm_relaunch_resume_activity … 40000000` (0x40000000 = CONFIG_FONT_SCALE; density `1400`, locale
`2104`), then `wm_on_destroy_called` and `wm_on_create_called` for MainActivity, and the live Activity
object (`Local Activity <hash>` in `dumpsys activity top`) changes. The next "Choose photo" fails.

**Root cause** (installed source, not the hypothesis alone). expo-modules-core registers each module's
Activity-result launchers against the current Activity's lifecycle
(`AppContextActivityResultRegistry.register`), and that registration is removed on the Activity's
`ON_DESTROY`. The launchers themselves live on inside the module. They are registered again only when
`AppContext.onHostResume` sees `hostWasDestroyed`, which `AppContext.onHostDestroy` sets. On a
configuration change, `expo.modules.ReactActivityDelegateWrapper.onDestroy` runs the old Activity's
`delegate.onDestroy()` **asynchronously** (a coroutine on the main dispatcher behind a mutex), so the
new Activity can resume first; `ReactHostImpl.onHostDestroy(oldActivity)` then finds
`currentActivity !== activity` and does nothing. `hostWasDestroyed` is never set, nothing re-registers,
and every launch throws until the process dies. The ordering inside ReactHost is inferred from source:
its `BridgelessReact` state log is suppressed in release builds. The upstream issue
[expo/expo#50386](https://github.com/expo/expo/issues/50386) reports the same failure and cause.
`uiMode` is in `configChanges`, which is why dark mode never triggered it.

**Options considered.**
- Newer patch release: expo-image-picker 57.0.18-57.0.20 have no user-facing changes; the sdk-57 branch
  and the published expo-modules-core 57.0.19 do not contain a fix (read 2026-09-25).
- `configChanges += fontScale|density|locale`: hides the recreation instead of surviving it, does not
  cover memory-pressure recreation, and moves text-size/density/language handling into a running
  Activity. Rejected.
- **Chosen:** backport the upstream fix [expo/expo#49634](https://github.com/expo/expo/pull/49634)
  (merged 2026-09-24, unreleased) as a pnpm patch, `apps/mobile-spike/patches/expo-modules-core@57.0.18.patch`,
  registered in `apps/mobile-spike/pnpm-workspace.yaml`. `launch()` re-registers a dropped launcher
  against the live Activity (on the main thread) instead of throwing. The lockfile changes only by the
  patch hash; `pnpm install --frozen-lockfile` from an LF checkout reproduces it. The release APK's dex
  contains the patched method. `configChanges` stay as Expo generates them, so every config change is
  still a real recreation in every test.
- App-side safety net: should the launcher still be missing (patch absent), the adapter reports
  `restart_required` and the screen says "Close and reopen the app", instead of a vague retry.

**After.** On the final build, all three triggers: picker opens, the synthetic image is picked, exactly
one app-owned copy exists under `cache/ImagePicker/` while shown, and it is deleted on leaving the
screen (checked as root). The unchanged P166 step "photo picker after a configuration change" passes.

### Recreation also reset the app (found while testing F1)

After any recreation React Native mounts a new root in the same JS runtime. The spike built its runtime
in a hook, so a **second runtime** replaced it (empty stores, a second auth subscription left running)
and navigation restarted at the collection list. The runtime is now one per JS runtime, and navigation
state is restored from a user-scoped in-memory store that the identity boundary resets (a B session can
never be restored into A's screens). Device check: card detail stays open across a font-scale
recreation; the photo screen stays open across all three triggers.

## 4. Photo lifecycle (final build)

| Case | Result |
|---|---|
| Pick after recreation (font scale, density, locale), owned copy, cleanup on exit | PASS ×3 |
| Library cancel → "No photo chosen", reopen works | PASS |
| Rapid double tap → one picker, no error state | PASS |
| Camera permission denied → denied card | PASS |
| Camera "only this time" → system camera → back = cancelled | PASS |
| Process killed (kill -9) with the picker open | PASS: no crash, no orphan copy. Android returned to the launcher after the pick (the dead caller's result is not redelivered); reopening restores the session on the collection |
| Process killed while a photo is shown | PASS: the copy survives the kill and is purged at the next start (new `purgeOrphans`) |
| A picks a photo → sign out → B signs in | PASS: no A photo, file or row under B; B total `—` |
| Identity change while the picker is pending | NOT_RUN on the device (no UI path signs out while the system picker is in front); unit-tested (`photo-store.test.ts`) |
| Broad photo-library permission, upload | none requested; no network import in the photo modules (existing static test) |

## 5. Platform usability

| # | Before | Fix | Device evidence (final) |
|---|---|---|---|
| F3 tabs | missing-glyph box; TalkBack name `"⏷, Collection"` | text-only tabs (`tabBarIcon: () => null` plus a hidden icon slot), explicit accessible names; no icon chosen (owner/P168) | names `Collection`, `Search`, `Price Check`, `Profile`; labels visible; no glyph |
| F4 200 % text | total split inside a digit group; titles `P1…`; tab labels cut | wrapping amounts break only between digit groups (display text only: `formatMoney` and the announced label are unchanged); list-row amounts stay on one line and shrink instead of cutting digits (max 60 % of the row); tab labels up to two lines at ≤1.5× and a taller bar | `8 917 127 262 195` / `456,87 kr`; row amounts complete; `Price` / `Check` on two lines; tab height 67 dp at 2.0 |
| F5 dark mode | light header/tab bar, white status band with light icons | navigation theme bound to the system scheme; config plugin `with-navigation-bar-follows-theme` re-applies the navigation-bar icon style on a live switch (React Native sets it once at creation) | foreground and background switch: status band 0.118, header 0.115, tab bar 0.122 (luminance), status icons light; light mode 0.99 with dark icons; 3-button navigation bar 0.139 with light icons |
| F6 targets | eight controls at 44-45 dp | `MIN_TOUCH` 48 dp | no app control under 48 dp on Collection, Card detail, Price Check, Photo, Profile (126 px at 2.625 px/dp; rows cut by the list edge excluded) |
| F7 keyboard | Sign in under the keyboard (edge-to-edge no longer resizes the window for SDK 35+) | `KeyboardAvoidingView` `padding` on Android too; IME `next` → password, `go` → submit; `submit()` refuses empty fields (found in a final run: the Enter that moved focus also submitted an empty password, and the answer cleared the password typed meanwhile) | keyboard top 1517 px, Sign in bottom 1179 px; tapping the **button** signs in |

Orientation is locked to portrait in `app.json`, so rotation is not applicable. Screenshots contain
synthetic data only; the password field is masked and no screenshot with an e-mail address was kept.

**Accessibility limits.** TalkBack is not installed on this `google_apis` image: names come from the
view tree (`content-desc`), a proxy, **not** a TalkBack pass. Reading order, focus movement, reduced
motion and contrast ratios were not measured. `prebuild` still warns that `userInterfaceStyle` wants
`expo-system-ui`; the DayNight theme already follows the system, so it was not added.

## 6. Collection performance

**Measured bottleneck.** Almost every janky frame carries "slow issue draw commands" (render thread /
host GPU translation), about 60 % also "slow UI thread"; bitmap uploads are ~0 (no images). On the app
side: every store update re-rendered every mounted row (new `renderItem` and `onPress` closures), and
`getItemLayout` offsets ignored the header height the virtualized list requires.

**Changes.** Memoised rows with a stable callback; stable `renderItem`; header height measured into
`getItemLayout`. Keyset paging, dedupe by `holdingId`, latest-load-wins, unknown totals and account-scoped
cancellation are untouched (existing store tests pass). A page of 5 now renders 5 rows instead of 20
(`collection-render.test.tsx`, mutation-checked).

**Harness.** `scripts/android-collection-perf.mjs`: sign in A, cold start with the stored session,
30 flings down (pages load while scrolling), 30 up, 30 down again warm; no uiautomator dump during a
fling; `gfxinfo` percentiles, PSS and the PostgREST requests Kong logged.

**Result** (interleaved baseline / final APK 1 / baseline / final APK 1 after a cold emulator boot; 2 runs
each; medians of 4 sequences per build and mode; APK 2 differs only in the sign-in guard):

| | p50 | p90 | p99 | janky | PSS | requests |
|---|---|---|---|---|---|---|
| baseline cold | 28 ms | 47.5 ms | 208 ms | 13.4 % | 165 MB | 7.5 |
| final cold | 28.5 ms | 45 ms | 75 ms | 12.2 % | 188 MB | 8 |
| baseline warm | 26.5 ms | 49.5 ms | 118 ms | 24.9 % | 154 MB | 4 |
| final warm | 26.5 ms | 44 ms | 57 ms | 14.2 % | 168 MB | 5 |

Median frame time is unchanged; the tail (p99) and warm jank are lower; **PSS is 14-23 MB higher** in the
final build (not investigated further; candidates: the retained runtime/navigation memory and the extra
view per row). Confounders dominate: the same harness gave p50 57-150 ms for *both* builds before the
cold boot (emulator swap, a second emulator on the host). Treat the improvement as suggestive; it says
nothing about a phone.

## 7. Security and money gates (final build, real local backend)

- Hermes: `P166_PROOF RESULT pass=36 fail=0 engine=hermes 250829098.0.17` (formatter vectors incl. JPY
  exponent 0 and JPY 2^53+1, NULL `—` vs `0,00 kr`, BigInt exactness, wire parser refusing unsafe numbers).
- Real backend > 2^53 round trip on screen: `8 646 911 284 551 352,35 kr` (3 × (2^58+1)) and
  `270 215 977 642 229,79 kr` (3 × (2^53+1)); manual `0,00 kr`; no price `—`; B total `—`.
- SecureStore: process restart restores the session without the login screen; sign-out + restart shows login.
- A → B: B sees only B rows; A photo and copy gone. Same-user token refresh: covered by the existing unit
  tests (`auth-identity.test.ts`, identity key), NOT_RUN on the device.
- Backend suite against `pokeportfolio-p167`: 5 files, 28 tests pass (RLS refusal, request-log
  allow-list, content-hash before/after, cron isolation).

## 8. Runs

| Run | Build | Result |
|---|---|---|
| P166 driver, baseline | P166 APK | 17 PASS / 1 FAIL (F1) |
| P167 driver (earlier 17-step version), baseline | P166 APK | 3 PASS / 14 FAIL (F7, F3, F6, F5, all photo steps after a recreation) |
| P166 driver | final APK 1 | 15/3: the driver tapped an empty uiautomator dump (cascade); driver now waits for the node; re-run **18/18**, second run **18/18** |
| P167 driver | final APK 1 | 14/5: user B's sign-in got user A's address from the emulator's autofill service; driver now disables autofill and verifies the field; re-run **19/19**. Second run 18/1: F7 found the empty IME submit (an app bug, fixed in §5), which required final APK 2 |
| P166 driver, run 1 and 2 | **final APK 2** | **18/18, 18/18** (Hermes `pass=36 fail=0` both times) |
| P167 driver, run 1 and 2 | **final APK 2** | **19/19, 19/19** |

Driver failures are listed, not hidden: each one was diagnosed from its screenshot before the driver was
changed, and no app assertion was weakened.

## 9. Tests and gates

- Native: typecheck clean, lint clean, Prettier clean, `pnpm test` 19 suites / 249 tests.
- Mutation proofs: 23/23 killed by assertion failures, tree clean afterwards (22 in the full run, M11b in
  its own run). P167 adds M9-M18 and M11b: patch dropped (F1), unregistered launcher reported as
  retryable, keyboard behaviour removed (F7), empty IME submit (F7), navigation
  theme removed (F5), tab icon fallback (F3; the first version removing only one of two mechanisms
  survived as an equivalent mutant and was strengthened), orphan purge removed on identity change,
  navigation memory not identity-scoped, rows not memoised, unbreakable amounts (F4), navigation-bar
  plugin dropped. Existing M2/M4 (unsafe number display) and M7a (stale collection response) still pass.
- Web: `pnpm check` (typecheck, lint, format, 133 files / 1636 tests, 1 skipped) passes. `pnpm build`:
  prebuild (scanner assets) and `tsc -b` pass; `vite build` needs `VITE_SUPABASE_URL` for the CSP and
  passes with the local stack's public values (no Production value used); `pnpm check:links` 29/29. `git diff 41dea0e..HEAD` touches nothing outside `apps/mobile-spike` and `docs/mobile`.

## 10. Residual issues

- Emulator only; no physical Android device, no iOS.
- TalkBack, reduced motion, contrast ratios: not tested (see §5).
- PSS +14-23 MB in the final build on the harness (§6), unexplained.
- The expo-modules-core patch must be dropped when an Expo release contains expo/expo#49634;
  `p167-platform.test.tsx` pins the version so an upgrade forces that decision.
- Titles in list rows truncate with an ellipsis at 200 % text (the full name is on the detail screen).
- Process death with the picker open loses that pick (Android returns to the launcher). Honest, not
  silent: nothing is shown and nothing is left on disk.

## 11. Merge notes

**P169 (search / Price Check features).** Use `MoneyText` with `fit="wrap"` for amounts that may wrap
and `fit="shrink"` in fixed-height rows; never format money in a new component. New screens get the
48 dp `MIN_TOUCH`, `usePalette()` colours (the navigation theme follows the system) and inherit the
recreation memory for free if they live in the existing navigators. New user-scoped stores must register
with the identity registry (the navigation memory shows the pattern). Any new native module that uses
Activity results is covered by the patch; add it to the recreation step of `android-p167-check.mjs`.

**P168 (design).** Tabs are text-only on purpose: when an icon set is chosen, pass `tabBarIcon` and drop
`tabBarIconStyle: { display: 'none' }` together (mutant M13 guards the pair). Colours live in
`src/ui/theme.ts` (`LIGHT`/`DARK` palettes and `navigationTheme`); the navigation-bar plugin must stay
while `uiMode` remains in `configChanges`. Large-text constraints to keep: amounts never cut digits,
wrap only between groups, tab bar height follows text size.

## 12. Reproduce

`apps/mobile-spike/README.md` → "Android runtime (P166)" and "P167 additions".
