# PokePortfolio native spike (P158)

**Provisional technical spike. Not a product, not an approved design.** Read
[`docs/mobile/DECISION_RECORD.md`](../../docs/mobile/DECISION_RECORD.md) first. React Native 0.86 /
Expo SDK 57, native views and native navigation (not a WebView), the existing Supabase backend, and
the web app's `src/domain` + `src/data` reused unchanged. Local only; read-only; no store, EAS or
hosted-backend use.

What exists: sign-in, session restore/refresh/sign-out, collection list (10 k-safe), card detail,
Price Check (read-only), an identity boundary (A → B), exact-money rendering, a bounded photo
ownership spike. What does **not** exist: a scanner, writes, offline, screen-reader testing, and any
iOS run. A release build has run on an Android 16 emulator
([P166 review](../../docs/mobile/P166_RUNTIME_AND_STITCH_REVIEW.md)).

## Setup on Windows 11 (PowerShell, from the repository root)

Prerequisites: Node ≥ 24.19, pnpm 10, Docker Desktop. For an Android run additionally: Android SDK,
JDK 17 and an emulator (**not needed** for any test below).

```powershell
pnpm install                                   # repo root: the web toolchain and the Supabase CLI
cd apps\mobile-spike
pnpm install                                   # this package (own lockfile, hoisted node_modules)
```

### Isolated local backend (own project id `pokeportfolio-p158-mobile`, ports 553xx, synthetic data)

```powershell
pnpm backend:start                             # generates .local-backend\ and starts db, auth, rest, kong
pnpm backend:seed                              # 2 synthetic users, 10 006 + 40 holdings, price fixtures
node scripts/local-backend.mjs write-env       # public URL + publishable key for the backend tests
```

`.local-backend\fixture.json` holds the **generated throw-away credentials** of the two synthetic
users. It is gitignored. Never commit it, and never seed real data.

### Point the app at it (values are public; never put a secret or service-role key here)

```powershell
$v = node scripts/local-backend.mjs env | ConvertFrom-StringData
"EXPO_PUBLIC_SUPABASE_URL=$($v.API_URL)`nEXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$($v.PUBLISHABLE_KEY)" | Set-Content .env.local
```

| Variable | Required | Meaning |
|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | yes | must be loopback, private-network or `.local`; anything else (and any `*.supabase.co` / `pages.dev`) is **refused at startup** |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | `sb_publishable_…` or an anon-role JWT; a secret or `service_role` key is refused |
| `EXPO_PUBLIC_ANDROID_EMULATOR_HOST` | no | host alias for the developer machine from an emulator (default `10.0.2.2`) |
| `EXPO_PUBLIC_ANDROID_LOOPBACK` | no | `adb-reverse` keeps `127.0.0.1` when the device uses `adb reverse tcp:55321 tcp:55321` |
| `P158_LOCAL_BACKEND` | tests only | set to `1` by `pnpm test:backend` |

### Run

```powershell
pnpm start                                     # Metro; open with a development build or an emulator
```

iOS needs a Mac or a cloud build and, for a physical device, Apple signing, which is **not free**
and not requested.

### Android runtime (P166, Git Bash on Windows)

Needs JDK 17+ (`JAVA_HOME`), the Android SDK (`ANDROID_HOME`; platform 36, build-tools 36.0.0, NDK
27.1.12297006, CMake 3.22.1, emulator + an x86_64 system image) and a running emulator or a device.
The release build embeds the Hermes bundle, so Metro is not needed.

```bash
echo "EXPO_PUBLIC_RUNTIME_PROOF=1" >> .env.local            # after the two values above; opt-in Hermes proof
CI=1 npx expo prebuild --platform android --no-install      # generates android/ (gitignored)
```

Windows path limits need two passes. Pass 1 from the real path runs codegen and then fails in CMake
with "Filename longer than 260 characters"; pass 2 from a short `subst` drive compiles the C++.
Running codegen from the `subst` drive instead fails with "different roots".

```bash
(cd android && NODE_ENV=production ./gradlew.bat assembleRelease -PreactNativeArchitectures=x86_64)
```

```powershell
subst Q: "C:\path\to\worktree"                               # session-only drive letter; subst Q: /d removes it
```

```bash
(cd /q/apps/mobile-spike/android && NODE_ENV=production ./gradlew.bat assembleRelease -PreactNativeArchitectures=x86_64)
adb install -r android/app/build/outputs/apk/release/app-release.apk
node scripts/android-runtime-check.mjs                      # P166_STEPS=<regex> runs a subset
```

Plain HTTP to the local stack is allowed only for `10.0.2.2`, `10.0.3.2`, `127.0.0.1` and `localhost`
(`plugins/with-local-cleartext.js`); a release build would otherwise refuse it.

### P167 additions ([P167 report](../../docs/mobile/P167_ANDROID_HARDENING.md))

- **Own stack per worktree.** `SPIKE_BACKEND_PROJECT_ID=pokeportfolio-<name>` and
  `SPIKE_BACKEND_PORT_OFFSET=<100..9000>` on `node scripts/local-backend.mjs start`; the choice is
  recorded in `.local-backend/stack.json` and every later command follows it. Check
  `netsh interface ipv4 show excludedportrange protocol=tcp` first: Windows reserves port ranges that
  change on reboot.
- **One device.** With more than one device attached the drivers refuse to run unless `ANDROID_SERIAL`
  names the one you own.
- **expo-modules-core patch.** `patches/expo-modules-core@57.0.18.patch` (upstream expo/expo#49634) keeps
  the photo picker working after an Activity recreation; `pnpm install` applies it. Drop it once an Expo
  release contains the fix.
- **Drivers.** `node scripts/android-p167-check.mjs` (`P167_STEPS=<regex>`: recreation, photo lifecycle,
  keyboard, tabs, touch targets, dark mode incl. 3-button navigation, font scale 2.0);
  `node scripts/android-collection-perf.mjs <label> [runs]` (same fling pattern for any installed build).
  Both need `adb root` for the cache-file and process-kill steps and switch the emulator's autofill off
  for the run.

### P170: the integrated app ([P170 report](../../docs/mobile/P170_INTEGRATED_NATIVE_ANDROID.md))

One app: the P167 runtime hardening plus the P169 catalog search / read-only Price Check, on one
identity system (the tabs are Collection, Search, Price Check, Profile). One stack serves both
tracks' fixtures; the drivers need `ANDROID_SERIAL` and refuse any AVD but `p170_api36`.

```bash
node scripts/p170/backend.mjs start          # own project id pokeportfolio-p170, API 55471
node scripts/p169/mock-tcgdex.mjs --stack=p170   # synthetic provider for the edge functions (own process)
node scripts/p170/backend.mjs seed && node scripts/p170/backend.mjs write-env
node scripts/p170/build-apk.mjs              # prebuild --clean + two-pass Gradle (own subst drive O:)
adb -s emulator-5570 install -r android/app/build/outputs/apk/release/app-release.apk
ANDROID_SERIAL=emulator-5570 node scripts/p170/android-check.mjs      # search / price / identity / session
ANDROID_SERIAL=emulator-5570 node scripts/android-p167-check.mjs      # recreation, photo lifecycle, dark, 200 %
node scripts/p170/mutations.mjs              # cross-track mutants (needs a clean tree)
node scripts/p170/backend.mjs stop           # then quit Docker Desktop if no other session needs it
```

Backend suites against that stack: `P158_LOCAL_BACKEND=1 P169_LOCAL_BACKEND=1 P169_STACK=p170
P169_MOCK_PORT=55461 npx jest --selectProjects backend --runInBand tests/backend/<file>` (run the files
one at a time; one combined run stalled with an idle database).

## Checks

```powershell
pnpm typecheck
pnpm lint
pnpm test                # unit + web tests run unchanged (Node and the RN preset)
pnpm test:backend        # real local backend, serial
pnpm mutation            # mutation proofs (needs a clean tree)
pnpm hermes:proof        # exact-money proof bundle: Node run + hermesc compile
pnpm bundle:android      # Metro -> Hermes bytecode (also: bundle:ios)
pnpm backend:stop        # stops THIS stack only
```

## Layout

```
App.tsx, index.ts          entry; refuses a bad backend configuration
src/config                 local-only backend guard, Android emulator host
src/net                    read-only policy, exact-money transport guard, failure classification
src/auth                   chunked SecureStore session storage, identity authority, auth controller
src/state                  user-scoped stores, the identity boundary registry, lease-run
src/collection, src/price-check, src/photo   ports + adapters (the SPIKE_ONLY parts)
src/money                  exact bigint/string formatter and wire parser
src/seam                   the one Supabase client the shared web data modules use
src/ui                     native screens and navigation (neutral, provisional)
tests/unit, tests/backend  see docs/mobile/TEST_EVIDENCE.md
scripts                    local backend, seed, mutation proofs, Hermes proof
```
