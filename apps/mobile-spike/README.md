# PokePortfolio native spike (P158)

**Provisional technical spike. Not a product, not an approved design.** Read
[`docs/mobile/DECISION_RECORD.md`](../../docs/mobile/DECISION_RECORD.md) first. React Native 0.86 /
Expo SDK 57, native views and native navigation (not a WebView), the existing Supabase backend, and
the web app's `src/domain` + `src/data` reused unchanged. Local only; read-only; no store, EAS or
hosted-backend use.

What exists: sign-in, session restore/refresh/sign-out, collection list (10 k-safe), card detail,
Price Check (read-only), an identity boundary (A → B), exact-money rendering, a bounded photo
ownership spike. What does **not** exist: a scanner, writes, offline, accessibility testing, and any
run on an emulator or device ([TEST_EVIDENCE](../../docs/mobile/TEST_EVIDENCE.md)).

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

Nothing has been run on an emulator or device yet. A development build needs the Android toolchain
(`npx expo prebuild --platform android`, then `npx expo run:android`); iOS needs a Mac or a cloud
build and, for a physical device, Apple signing, which is **not free** and not requested.

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
