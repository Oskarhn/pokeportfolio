# Test evidence and runtime limits

Status vocabulary, used consistently below:

| Status | Meaning |
|---|---|
| `SOURCE_BUILT` | Metro bundled the code into a Hermes bytecode bundle |
| `UNIT_TESTED` | Jest (Node or `jest-expo` RN preset), I/O faked |
| `LOCAL_BACKEND_TESTED` | Jest against the real isolated local Supabase (GoTrue + PostgREST + RLS), synthetic data |
| `HERMES_COMPILED` | `hermesc` (Hermes 1.0.0) compiled the code; **nothing was executed on Hermes** |
| `ANDROID_RUNTIME_UNVERIFIED` | no emulator or device; no APK built |
| `IOS_RUNTIME_UNVERIFIED` | iOS cannot be built or simulated on Windows; not tested |

**Jest mocks alone are not native-runtime proof, and this document does not claim they are.**

## What ran, and the numbers

| Check | Result | Status |
|---|---|---|
| Metro bundle, Android | 959 modules → Hermes bytecode 2.8 MB | `SOURCE_BUILT` |
| Metro bundle, iOS | 964 modules → Hermes bytecode 2.8 MB | `SOURCE_BUILT` |
| `tsc --noEmit` (native package, includes the shared modules it imports) | 0 errors | |
| ESLint (native config; `Number()`/`parseFloat` forbidden in money code) | 0 errors | |
| Web app's own tests, shared files **unchanged**, Node | 7 files, 44 tests | `UNIT_TESTED` |
| Same files, `jest-expo` RN preset | 7 files, 44 tests | `UNIT_TESTED` |
| Native unit + component/navigation | 11 files, 219 tests | `UNIT_TESTED` |
| Native against the real local backend | 5 files, 28 tests | `LOCAL_BACKEND_TESTED` |
| Mutation proofs | 12 of 12 mutants killed; working tree clean afterwards | |
| Exact-money proof bundle compiled by `hermesc` 1.0.0 | 19/19 vectors pass under **Node**; compiles to bytecode | `HERMES_COMPILED` |
| Web `tsc -b`, `eslint` (0 errors, 27 pre-existing `react-refresh` warnings), `prettier --check`, `vitest` (133 files, 1 636 passed, 1 skipped) | green | web regression |
| Web `vite build` | green **with** `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY` set (the build refuses to run without them; that is pre-existing) | web regression |
| Android emulator smoke, Android APK | **run in P166**: release APK on an Android 16 emulator, 17 of 18 device steps pass, the failure is a real picker defect ([P166 review](P166_RUNTIME_AND_STITCH_REVIEW.md)) | Android runtime |
| iOS anything | **not run** (impossible on Windows) | `IOS_RUNTIME_UNVERIFIED` |

## Exact money

### Formatter vectors (`tests/support/money-vectors.ts`, hand-written expectations)

| Case | Input (minor units, currency) | Output |
|---|---|---|
| zero | `0` NOK | `0,00 kr` |
| NULL | `null` | `—` (never a zero) |
| minus one øre | `-1` NOK | `−0,01 kr` |
| negative above 2^53 | `-(2^53+1)` NOK | `−90 071 992 547 409,93 kr` |
| above 2^53 | `2^53+1` NOK | `90 071 992 547 409,93 kr` |
| 2^58 scale | `2^58+1` NOK | `2 882 303 761 517 117,45 kr` |
| EUR / USD, 2 decimals | `123456` EUR, `5` USD | `€1,234.56`, `$0.05` |
| JPY, 0 decimals | `12345`, `1`, `2^53+1`, `0` JPY | `12,345 JPY`, `1 JPY`, `9,007,199,254,740,993 JPY`, `0 JPY` |

Also: 2 000+ random values per currency compared with the **web app's `Intl`-based formatter**
(`src/ui/money-format.ts`), including signs and grouping glyphs; no rounding is performed anywhere
(the domain's half-up division is used only by `convert`, and is exercised there).

### Transport

- `JSON.parse('{"a":9007199254740993}').a === 9007199254740992` is asserted, i.e. the failure is real.
- The fetch-level guard scans the raw body (string-aware) and **refuses** an unquoted integer above
  2^53−1 in a response (fail closed → "unavailable", never a rounded amount) and in a request.
  Decimal **strings** of any length pass byte-for-byte. Vectors cover negatives, nesting, escaped
  quotes, fractions/exponents (out of scope), a 5 000-object body.
- Against the real database: `list_portfolio` and `portfolio_counts` money is text, so a 3 × (2^58+1)
  holding (864 691 128 455 135 235) and a portfolio total of 891 712 726 219 545 687 arrive exact.
- Against the real database: a NULL value is NULL, a deliberate manual valuation of 0 is 0, and the
  portfolio total equals the exact sum of the values shown.
- DB 104's own conversion of a 2^58-scale EUR snapshot to NOK equals the shared domain's `convert`.
- **P149-level correctness is not claimed.** The spike refuses unsafe numbers; P149 quotes them and
  keeps the digits, which is strictly better and is the replacement ([INTEGRATION_PLAN](INTEGRATION_PLAN.md)).

### Hermes

| Question | Answer |
|---|---|
| Does the formatter (BigInt literals, `**` on BigInt, `BigInt()`, string handling) **compile** for Hermes? | Yes: `hermesc` 1.0.0 (bytecode v98). The whole app also compiles (959/964 modules) |
| Does it **run** correctly on Hermes? | **Yes, since P166**: the in-app proof (`src/diagnostics/runtime-proof.ts`, 36 checks incl. these vectors) passed on Hermes on an Android 16 emulator ([P166 review](P166_RUNTIME_AND_STITCH_REVIEW.md) §2). Original P158 note: **UNVERIFIED.** The npm `hermes-compiler` package is compiler-only (no `-exec`), there is no Hermes VM here, and no emulator/device. A standalone Hermes CLI would have to be downloaded from a release page; that was not done without approval |
| How to close it | Run `.build/hermes-money-proof.js` (regenerate with `pnpm hermes:proof`) on any Hermes with `print`/`console.log` and expect `RESULT pass=19 fail=0`; or evaluate it inside the app on an emulator/device |
| `Intl.NumberFormat` with BigInt on Hermes | not used, not tested; the docs describe partial support |

## Mutation proofs (each fails at least one **assertion**; a suite that crashes is not counted)

| # | Mutation (one mechanism broken) | Killed by |
|---|---|---|
| M1 | remove the identity-bound reset | 8 failing tests (isolation + navigation) |
| M2 | format money through `Number()` | 6 (formatter vectors, parity) |
| M3a | NULL formatted as zero | 2 (formatter, app) |
| M3b | NULL holding value read as zero in the collection adapter | 1 |
| M4a | accept an unsafe JSON integer in a response | 2 |
| M4b | accept an unsafe JSON number as money | 1 |
| M5 | price the wrong catalog variant | 3 (store, app) |
| M6a | Price Check imports an acquisition module | 2 (static read-only guard) |
| M6b | disable the read-only request policy (a financial write RPC would be sent) | 1 |
| M7a | a stale **response** for A is committed after B signed in | 2 |
| M7b | a stale **failure** for A is committed after B signed in | 1 |
| M8 | a Production / non-local backend URL is accepted | 8 |

Reproduce with `pnpm mutation` (needs a clean `apps/mobile-spike` tree; it restores every file and
asserts the tree is identical afterwards). A first version of the runner reported two survivors; both
were the runner, not the tests: Jest cannot serialise a **BigInt** in a failure report ("Do not know
how to serialize a BigInt", jest#11617) and shows "Test suite failed to run". The test setup now
installs a test-only `BigInt.prototype.toJSON`, and the runner reads the verbose output.

## Feature-by-feature

| Feature | How it was proven | Status |
|---|---|---|
| Native startup, navigation shell (Collection / Search / Price Check / Profile) | RN preset renders the real `react-native-screens` native stack + bottom tabs; `navigationRef` asserts the route state | `UNIT_TESTED`, `SOURCE_BUILT` |
| Sign-in / restore / refresh / rejected refresh / sign-out | real GoTrue, chunk adapter over a store that rejects values > 2 048 bytes | `LOCAL_BACKEND_TESTED` |
| Identity A → B, A → B → A, in-flight discard, same-user refresh | unit (real composition root) **and** real backend (held request) | both |
| Collection: 10 006 holdings, keyset paging, unique keys, bounded memory | 101 pages × 100, ~8 s, 2–23 MB Node heap growth (GC-dependent; **Node, not Hermes**); list uses `FlatList` with `getItemLayout`, `windowSize 7`, `removeClippedSubviews` | `LOCAL_BACKEND_TESTED`; list rendering `UNIT_TESTED` |
| Card detail | real backend: provenance, manual vs market value, missing | `LOCAL_BACKEND_TESTED` |
| Price Check (released interface) | real backend; read-only invariant with content hashes | `LOCAL_BACKEND_TESTED` |
| Price Check (P153-shaped fixture) | unit; labelled synthetic in the UI | `UNIT_TESTED` |
| Loading / offline / 401 / 500 / forbidden / not-found / unsafe-number states | scripted network (all) and real backend (401 with a garbage token, offline, a real 4xx); the store, the classifier and the screens | `UNIT_TESTED` + `LOCAL_BACKEND_TESTED` (a real 500 could not be provoked) |
| Photo ownership | fakes for the picker and file system | `UNIT_TESTED` |
| No financial write anywhere | request-policy tests, request logs of full flows, ledger-table content hashes before/after | `LOCAL_BACKEND_TESTED` |
| No Production-directed call | config guard tests; stack has 0 ingest-config rows, 26 no-op cron runs, empty `net` queue and response tables | `LOCAL_BACKEND_TESTED` |

## Limits and warnings (read these)

1. **No native runtime was executed.** No Android SDK/emulator, no JDK 17, no APK; iOS impossible on
   Windows. Everything a phone does that Jest cannot fake (Keychain/Keystore behaviour, permission
   dialogs, the camera, gestures, keyboard avoidance, safe areas, text scaling, startup time, memory,
   thermal, back-button behaviour) is **unverified**.
2. **Hermes runtime unverified** (see above). Node numbers are V8 numbers.
3. **Accessibility:** touch targets (≥ 44 pt), roles and labels are asserted at source level. No
   VoiceOver/TalkBack test, no 200 % text test, no Reduce-Motion test was run; **no accessibility
   claim is made.**
4. **Two unexplained transient failures** of one backend test each (the first parallel run of the
   identity suite; one run right after heavy CPU activity) were not reproduced in more than 10 later runs, serial
   and under load. The failure detail was not captured either time (a page load ended in an error
   state). Likely first-query latency on a cold 10 000-row user against the API's statement timeout,
   but that is **an inference, not a finding**. The suite is run serially and the assertion now prints
   the failure kind.
5. **`value_desc` paging past an above-2^53 value fails closed** (finding F3); a user whose most
   valuable holding exceeds 2^53 minor units (≈ 90 trillion kr) cannot page past it by value on DB 104.
   Newest-first paging is unaffected.
6. **A real 500** could not be provoked against PostgREST; it is covered with a scripted network.
7. **Long auth-js refresh retry window** (25 s of exponential backoff when the network is down at
   token expiry) was not exercised here.
8. The session-storage chunk write costs one Keychain call per chunk; **not measured on a device**.
9. Search tab is a labelled placeholder; collection-wide search is out of scope.
10. `expo-file-system` `File.delete()` and `expo-image-picker` cache-copy behaviour are taken from the
    installed type definitions, not observed.
