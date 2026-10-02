# Native build configuration profiles

Authority: this file for what each kind of native build is, which values it needs and what makes it
refuse to build. `docs/mobile/IOS_BUILD_AND_DEVICE_RUNBOOK.md` for the Apple-side steps,
`docs/mobile/P186_ANDROID_PACKAGING_PERFORMANCE.md` for how the Android package is produced.
Added by P188; implementation in `apps/mobile-spike/config/build-profile.cjs`,
`apps/mobile-spike/app.config.js`, `apps/mobile-spike/plugins/with-release-signing.js` and
`apps/mobile-spike/src/config/backend-config.ts`.

## 1. The three profiles

The profile is one build-time variable, `EXPO_PUBLIC_BUILD_PROFILE`. Expo inlines `EXPO_PUBLIC_*`
into the JS bundle, so the native configuration (`app.config.js`) and the runtime backend guard
(`backend-config.ts`) read the same value and cannot disagree. Unset or empty means `LOCAL_DEV`; any
other unknown value is an error, never a fallback.

| | `LOCAL_DEV` | `LOCAL_RELEASE_TEST` | `PRODUCTION_RELEASE` |
|---|---|---|---|
| Purpose | developer and proof builds (proof panel, `EXPO_PUBLIC_RUNTIME_PROOF`) | release-shaped build against a local backend: R8, resource shrinking, ABI split. What the emulator journeys and the P186 package are | a build for distribution |
| Backend | loopback / private network only | loopback / private network only | `https://<20-character project ref>.supabase.co` only |
| Key | publishable or anon JWT | publishable or anon JWT | `sb_publishable_…` only (a legacy JWT is refused) |
| Android application id / iOS bundle id | placeholder `invalid.pokeportfolio.spike` | placeholder (the P186 scripts set an instance suffix) | from the environment; placeholders refused |
| Cleartext HTTP (Android) / local-network keys (iOS) | allowed to local hosts only | allowed to local hosts only | **not generated** |
| Android signing | the committed debug keystore | the committed debug keystore | keystore from the environment, read inside Gradle; the build refuses to configure without it |
| Store-ready | no | **no** | only when the owner decisions in §4 are made and §3 is satisfied |

`PRODUCTION_RELEASE` is not produced by any script in the repository. `scripts/p186/build.mjs`
writes `LOCAL_DEV` (proof variant) or `LOCAL_RELEASE_TEST` (release variant) into `.env.local`.

## 2. What `PRODUCTION_RELEASE` requires

All values come from the build environment. **Nothing is committed**: no application id, bundle id,
team id, URL, key or keystore is in the repository.

Public, non-secret values (all required):

| Variable | Rule |
|---|---|
| `EXPO_PUBLIC_BUILD_PROFILE` | `PRODUCTION_RELEASE` |
| `EXPO_PUBLIC_SUPABASE_URL` | exactly `https://<20 lowercase alphanumerics>.supabase.co`: no port, path, credentials or local/placeholder host |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…`; a secret-shaped value is named as such and refused |
| `POKEPORTFOLIO_ANDROID_APPLICATION_ID` | reverse-DNS, at least two segments, no placeholder segment (`invalid`, `example`, `spike`, `test`, `placeholder`, …) |
| `POKEPORTFOLIO_IOS_BUNDLE_IDENTIFIER` | as above, hyphens allowed |
| `POKEPORTFOLIO_APPLE_TEAM_ID` | 10 uppercase alphanumerics |
| `POKEPORTFOLIO_APP_VERSION` | `x.y.z`, not `0.0.0` |
| `POKEPORTFOLIO_ANDROID_VERSION_CODE` | positive integer |
| `POKEPORTFOLIO_IOS_BUILD_NUMBER` | positive build number |
| `POKEPORTFOLIO_APP_NAME` | optional display name, default `PokePortfolio` |

Secret signing values (Android), read by Gradle from the environment and **never** copied into the
Expo config (which is embedded in the app manifest) or the generated project:
`POKEPORTFOLIO_ANDROID_KEYSTORE_PATH`, `POKEPORTFOLIO_ANDROID_KEYSTORE_PASSWORD`,
`POKEPORTFOLIO_ANDROID_KEY_ALIAS`, `POKEPORTFOLIO_ANDROID_KEY_PASSWORD`.

Refused outright in a production build: `EXPO_PUBLIC_RUNTIME_PROOF`,
`EXPO_PUBLIC_ANDROID_EMULATOR_HOST`, `EXPO_PUBLIC_ANDROID_LOOPBACK`, `SPIKE_PACKAGE`.

**Fail closed.** A missing, blank, malformed, placeholder, local or secret-shaped value stops the
build, and the message names the variable and the category, never the value. Three independent
layers: `app.config.js` (every Expo command, so `expo prebuild`, `expo export` and `expo config`
all refuse), the Gradle configuration (absent signing variables or a keystore path that is not a
file), and the runtime guard (a bundle built with the wrong URL shows a refusal instead of
connecting).

## 3. What stays the owner's

- Creating and keeping the upload/release keystore (Android) and the Apple signing identity and
  provisioning (iOS). iOS signing is an Xcode or EAS step: `appleTeamId` is only the identity hint.
- Play Console / App Store Connect records, data-safety and privacy answers
  (`docs/PUBLICATION_CHECKLIST.md`).
- The hosted backend values. Until the owner decides, do not point any build at the hosted project.
- Nothing in this repository changes visibility, billing or a hosted setting.

## 4. Fields to decide before any store distribution

Placeholders are kept for local builds on purpose; the owner chooses these:

1. **Application id and bundle id** (permanent once published; Android and iOS may differ).
2. **Display name** and, optionally, the deep-link **scheme** (`pokeportfolio-spike` today, used only
   for local deep links).
3. **Version and build numbers** and the policy that increments them.
4. **Signing**: Android upload key (and Play App Signing enrolment), Apple team and certificates.
5. **Backend**: which hosted Supabase project, and the corresponding publishable key.
6. **App icon** and the N1/N2 navigation decision (`docs/CURRENT_STATE/NATIVE_MOBILE.md`).
7. **Account deletion** (Apple and Google both require an in-app path and, for Google, a web link):
   blocked on the P156 owner decisions, see `docs/release/P188_INTEGRATION_MATRIX.md` §4.

## 5. Evidence (P188, nothing hosted touched)

Run on Windows with synthetic values; the throwaway keystore was deleted afterwards.

- The real Expo pipeline (`expo config`) resolves each profile; `PRODUCTION_RELEASE` without its
  variables does not resolve at all and names `POKEPORTFOLIO_ANDROID_APPLICATION_ID`.
- A `PRODUCTION_RELEASE` Android prebuild generated the supplied application id, namespace and
  version, no `network_security_config.xml` and no cleartext attribute.
- Gradle refused to configure the project without the four signing variables
  (`Production release signing is not configured; missing: …`), and `signingReport` showed the
  `release` variant on the supplied keystore, not the debug keystore.
- `apps/mobile-spike/tests/unit/p188-build-profile.test.ts` pins all of the above (including that
  no signing value reaches the Expo config) and the runtime rules of `backend-config.ts`.
