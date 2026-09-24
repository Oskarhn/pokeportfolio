# Native mobile spike: decision record

> **PROVISIONAL. OWNER APPROVAL REQUIRED.**
> Nothing in this document, and nothing in `apps/mobile-spike/`, is an approved product decision.
> The owner has **not** selected the final navigation, the visual direction or the app icon. The
> proposals in [`docs/design/p154/`](../design/p154/README.md) are untouched and remain proposals.

## What this spike is

A small, real, native feasibility build that exercises the boundaries a future iOS/Android app would
have to cross, with a **provisional** technical stack:

- React Native 0.86 + Expo SDK 57 (development-build path), TypeScript, Hermes.
- React Navigation 7 (native stack + bottom tabs) with neutral text-only tabs.
- The **existing** Supabase backend, unchanged. `src/domain` and `src/data` of the web app reused
  unchanged.

It is not a WebView. It renders native views (`react-native-screens` native stack, RN `FlatList`,
`TextInput`, `Pressable`). The web app, its build, Cloudflare and the hosted database are untouched.

## Decisions taken inside the spike (all reversible, all local)

| # | Decision | Why | Reversal cost |
|---|---|---|---|
| S1 | Isolated package `apps/mobile-spike` with its own `package.json` and lockfile; no workspace | A pnpm workspace would touch the root lockfile and every open worktree | Delete the directory |
| S2 | One path alias `@shared/*` → `src/*` and one seam (`./supabase-client` inside `src/data`) | Reuse `src/domain` and `src/data` with **zero** file moves ([SOURCE_REUSE_MATRIX](SOURCE_REUSE_MATRIX.md)) | Replace the seam with P154 Option B when the shared-package PR lands |
| S3 | Session storage: chunked `expo-secure-store` ([AUTH_IDENTITY](AUTH_IDENTITY.md)) | Measured session is 2 039 bytes against a documented ~2 048-byte figure | Swap the `KeyValueStore` adapter |
| S4 | Money formatting: own bigint/string formatter, not `Intl` | Hermes `Intl` support for BigInt/`formatToParts` is documented as partial | Delete the file if Hermes is proven to match `Intl` exactly |
| S5 | Data access behind ports (`CollectionPort`, `PriceCheckPort`, `PhotoPort`) | The one place P149 / P153 change later | n/a |
| S6 | Read-only request policy in the client | The spike has no financial write feature, so it refuses to send one | Remove when a write feature is approved |
| S7 | Local-only backend guard (`loadBackendConfig`) | "Never direct a writable mobile build at Production" | Replace with a reviewed release-build path |

## What the spike does **not** decide

- Final navigation (P154's N2 or anything else), visual identity, typeface, icon, app name.
- Whether to publish to a store (Apple 99 USD/yr, Google 25 USD one-time; the standing spending
  authorisation is 0 USD, D-027).
- The scanner runtime (no model, no OCR, no recognition was built).
- Whether React Native is the final framework. It is the recommendation of P154 and the cheapest
  way to keep one implementation of `FINANCIAL_MODEL.md`; this spike shows it is *feasible*, with the
  gaps listed in [TEST_EVIDENCE](TEST_EVIDENCE.md).

## Framework verification (retrieved 2026-09-20)

| Item | Finding | Source |
|---|---|---|
| Expo SDK | **57.0.24** is `latest` on npm (dist-tag `latest`; `next` = 58.0.0-preview.3) | `npm view expo dist-tags` |
| Expo SDK 57 pins | react **19.2.3**, react-native **0.86.3**, `react-native-screens` ~4.26, `react-native-safe-area-context` ~5.7, `expo-secure-store` ~57.0.4, `expo-image-picker` ~57.0.19, `expo-file-system` ~57.0.7, `jest-expo` ~57.0.5 | `expo/bundledNativeModules.json` in the installed package |
| Platform floor | Android 7+, iOS 16.4+ for SDK 57.0.0 | docs.expo.dev/versions/latest |
| npm `react-native` latest | 0.87.1, i.e. **newer than SDK 57's 0.86.3**; the spike follows Expo's pin, not npm `latest` | `npm view react-native version` |
| Hermes | `hermes-compiler` 250829098.0.19 reports "Hermes release version 1.0.0", bytecode version 98 | `hermesc -version` |
| `hermesc` | **compiler only**: it has no `-exec`; there is no Hermes VM on this machine | `hermesc -exec` output |
| supabase-js | Pinned to **2.112.3** (the version the web app and P149's auth tests use). npm latest is 2.116.0 | `npm view @supabase/supabase-js version` |
| Supabase RN guide | AsyncStorage as `auth.storage`, `detectSessionInUrl: false`, `AppState` → `startAutoRefresh`/`stopAutoRefresh`, `react-native-url-polyfill`; a "LargeSecureStore" pattern (AES key in SecureStore, ciphertext in AsyncStorage) for values above the SecureStore limit | supabase.com/docs (via Context7, 2026-09-20) |
| SecureStore size | "Historically, some iOS releases refused values above roughly 2048 bytes. Expo does not enforce a limit"; Android stores in Keystore-encrypted SharedPreferences, iOS in the Keychain | docs.expo.dev/versions/latest/sdk/securestore |
| Expo Go | Not used. Whether Expo Go SDK 57 can run this exact bundle was **not** tested. The spike has no custom native code, so it may; a development build is the safe assumption | not verified |
| Windows | Metro/JS bundling works on Windows (done). An Android build needs the Android SDK and JDK 17: **not installed here** (only a Java 8 JRE and an unrelated `adb`). iOS cannot be built or simulated on Windows | `Get-Command`, environment probe |
