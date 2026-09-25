# P169 — Native catalog search and read-only Price Check

Branch `feat/p169-native-catalog-price-check`, based on the P166 native spike (`41dea0e`). Local
only: not pushed, no PR, nothing hosted touched. Status: **working vertical slice on a real Android
16 emulator (Hermes release build) against a real local backend**, with the limits listed in §10.

Reference points: released `main` `d8682e0` (DB 104), P165 web candidate `3d03eec` (DB 106, read
only — nothing from it was merged or cherry-picked).

## 1. What exists now

| Capability | State |
|---|---|
| Manual catalog search (name, set name, collector number, language filter) | **Built**, real backend + device |
| Same-name disambiguation (set, number, language, rarity, active printings; "same name" flag) | **Built**, device |
| Explicit printing choice (no default, mismatch never falls back) | **Built**, device |
| Raw provider prices via `search-prices` (P165 `observations[]` and released headline) | **Built**, real served function code + synthetic provider mock |
| Released snapshot RPC (`get_card_variant_price_history`) as a labelled second source | **Built**, device |
| Exact money (bigint, strings on the wire, >2^53 on device) | **Verified** on Hermes |
| NOK reference from cached Norges Bank rate; missing rate = original currency only | **Built** |
| Graded prices | **Structural model only**: always "No verified graded market data available" |
| Photo → identification | **Not implemented natively.** Photo entry states that and routes to manual search |
| Add to Collection | **Navigation intent only**; no request of any kind |

## 2. Contract compatibility matrix

Every cell marked *verified* ran against a real local stack (GoTrue, PostgREST, edge runtime),
through the native client's read-only policy and exact-transport guard. Function code was taken
from **git objects** (`d8682e0` released, `3d03eec` candidate), byte-identical except the TCGdex base
URL (redirected to the synthetic mock) and, for the released copy, its `_shared` import path; the
hashes and substitutions are in [p169-evidence/functions-manifest.json](p169-evidence/functions-manifest.json).

| Native client with … | on DB 104 (released) | on DB 106 (P165 candidate) | What the client shows |
|---|---|---|---|
| Snapshot RPC `get_card_variant_price_history` | verified | verified | ONE provider per printing, chosen by the caller's EU/US preference; NOK only (server-converted); source currency/amount/metric "not reported by this source" |
| **Released** `search-prices` (`d8682e0`) | verified | verified | ONE headline value per printing, labelled **Partial**; an unsafe JSON number is refused whole (`malformed_response`) |
| **Candidate** `search-prices` (`3d03eec`, `observations[]`) | verified | verified | Every provider value of the printing with source currency, metric, provider timestamp, freshness, NOK reference |
| Hosted Supabase (any) | not called | not called | — (see §10) |

DB 104 vs 106: the reads this feature makes (`search_cards`, `cards`, `card_variants`, `fx_rates`,
the snapshot RPC) are unchanged by P149's two extra migrations; the same 17 backend tests pass on
both stacks. The candidate function needs no migration (P153 was Edge-only).

## 3. Identity rules

- A search hit is identified by **card id**; set, collector number and language are always shown
  because names repeat (fixtures include two "P169 Pikachu" #025 in different sets plus a promo).
- Nothing is auto-selected: not a single search hit, not the first printing, not the priced one.
- One ACTIVE printing → confirmed as `only_variant`; several → `choice_required`, and **no price
  request is made** until the person chooses; a printing id from another card → `mismatch`.
- A visual match cannot establish finish; the recognition seam never chooses a printing (P165 `interpretScan`).
- Price caches are keyed by card id (`search_prices:<cardId>`, one response covers all printings of
  a card) or printing id (`snapshot_rpc:<variantId>`), never by name.

## 4. Reuse, not a fork

`apps/mobile-spike/src/features/price-check/p165-domain/price-check/*.ts` are the nine P165 web files
`src/domain/price-check/*.ts`, **byte-identical** (git blob ids pinned in `PROVENANCE.json` and
checked by `tests/unit/p169-contracts.test.ts`, which also compares against the P165 commit when it
is present). Three shims (`money.ts`, `currency.ts`, `fx.ts`) only re-export the ONE shared domain
(`@shared/domain/*`), which is byte-identical on `d8682e0` and `3d03eec`. Proven to run unchanged on
Hermes (`Object.hasOwn`, `toLocaleLowerCase('en')`, bigint conversion) by the in-app proof, 25/25.

What could **not** be reused: P165 `src/data/price-check.ts` imports the web Supabase client and
P149's unreleased `exact-json-guard`. Its transport part is re-expressed natively in
`search-prices-source.ts` (same request, same result shape, same D-164 refusal of rewritten
numbers). When P165 is released: delete `p165-domain/`, import `@shared/domain/price-check/*`.

## 5. Integration contract (for the P167 shell)

```ts
// once, next to createRuntime (App.tsx):
const feature = createP169Feature({
  authority: runtime.authority, registry: runtime.registry,   // same identity boundary
  invoke: (name, o) => supabase.functions.invoke(name, o),     // same client
  readFx: fxRateReaderFor(supabase), photo: runtime.photo,
})
// inside the identity-keyed subtree, in one native stack:
<P169FeatureProvider feature={feature} host={{ onAddToCollection: (intent) => navigate(...) }}>
  {P169_SCREENS.map((s) => <Stack.Screen key={s.name} name={s.name} component={s.component} options={{ title: s.title }} />)}
</P169FeatureProvider>
```

| Route | Params | Leaves the feature by |
|---|---|---|
| `P169Search` | none | `P169Card` push; `P169PhotoEntry` push |
| `P169Card` | `{ cardId, variantId? }` (variant honoured only if it belongs to the card) | `host.onAddToCollection({ kind, cardId, variantId, requiresConfirmation: true })`; pop to top |
| `P169PhotoEntry` | none | navigate to `P169Search` |

Everything is in `src/features/{screens.ts,navigation.tsx,feature.ts}`. The feature registers three
resettable stores in the runtime's registry; there is no second auth store or Supabase client.

## 6. States and errors (all distinct, none shown as zero)

Search: idle (hint), pending/loading, ready (`N of M`), **empty** ("No cards match"), error (fixed
text + retry), load-more failure, result limit (200). Price: `choice_required`, loading, observations
(with contract label, fetched time, "from this session's cache"), snapshot, unavailable
(`no_variant_price`, `variant_not_in_response`, `provider_error`, `malformed_response`, …), lookup error
(`network`, `unauthorized`, `rate_limited`, `provider_error`, `malformed_response`, `write_refused`)
with retry and a user-chosen, labelled "stored snapshot" fallback for the same printing. Freshness
from the provider timestamp: fresh ≤3 days, stale ≤30, **outdated** beyond, unknown when absent. FX:
converted (rate + date, flagged if >7 days), missing, malformed, read failed.

## 7. Read-only and isolation

- Wire policy (`src/net/spike-fetch.ts`, the only existing file changed): POST
  `/functions/v1/search-prices` added to the read-only allow-list; every other function and every
  write RPC is refused before sending.
- Backend journey test: allowed request set only; **identical count + content hash** of 17 tables
  (holdings, lots, purchases, sales, snapshots, fx, profiles, catalog, …) before and after a journey
  that included successful lookups and explicit printing choices.
- A → B (in flight), A → B → A, same-user refresh: unit tests + real GoTrue backend test + device.
  The snapshot RPC is account-specific: on the device A saw Cardmarket 17,25 kr, B saw TCGplayer
  22,05 kr for the same printing, and B started with an empty search.
- The P169 stack is its own project (`pokeportfolio-p169`, API 55921; DB-106 stack
  `pokeportfolio-p169-db106`, 56021), both ingest cron jobs deactivated in that project only,
  `net.http_request_queue` empty. No external provider was called: TCGdex is a local synthetic mock.

## 8. Runtime evidence (Android)

Own AVD `p169_api36` (Android 16, x86_64, installed P166 SDK image), serial `emulator-5560`, own
application id `invalid.pokeportfolio.spike.p169`, running **next to** the P167/P168 emulators, which
were not touched. Release APK, Hermes bytecode (`c61fbc03` magic), 30.5 MB, SHA-256
`a222b25e14109ed1c0dba5f2409197cf7f9e3ce9af994febb857c843125013fa`.
Driver: `scripts/p169/android-check.mjs`. Final run **17/17 PASS**
([android-report.json](p169-evidence/android-report.json), screenshots in `p169-evidence/`):

cold start → Hermes proofs (P166 36/36, P169 25/25) → sign-in A → search "P169 Pikachu" (same-name
flag, nothing selected) → two printings: choice required, no price → Reverse holo: €4.20 / $5.00,
48,30 kr → Add to collection = intent screen, nothing saved → Charizard holo: **113 580 246 926 357,98 kr**
(> 2^53) exact → provider failure vs explicit €0.00 → warm search → photo → "recognition not available"
→ manual → slow lookup left: aborted, no late publication → 200 % font: amounts complete on one line →
dark mode → 360/390/430 dp: no overflow → A → B (own provider, empty search) → restart restores
session; offline gives a retryable error and recovers.

Earlier runs of the same build failed three steps for **driver** reasons (amount below the fold;
uiautomator reporting an empty field's placeholder as text; injected text dropped right after a
density change). The driver now scrolls, uses the store's idle status, and verifies input.

The mock ran on port 55999 during the device run; it was moved to 55979 afterwards (§9 F5) and the
backend suites were re-run green. The APK does not depend on the mock port.

### Timings (emulator on a shared host — three emulators + Docker; not device numbers)

| Measure | Value |
|---|---|
| Cold start to first frame (`am start` TotalTime) | 647–1835 ms (first boot of a fresh AVD 3271 ms) |
| `search_cards` requests on device | median 76 ms, max 1069 ms, n = 38; 22 cache hits; 3 superseded answers dropped |
| `search-prices` requests on device | median 99 ms, max 436 ms (cold edge worker), n = 7; one aborted at 2.9 s by leaving |
| FX reads / snapshot RPC | median 43 ms / 35–126 ms |
| Variant switch on the same card | 1–4 ms (Node): no second provider call |
| Scanner/model initialisation for text lookup | none: the native app has no scanner model, and search/price modules import no scanner, picker or model (static test) |

## 9. Findings

| # | Finding | Consequence |
|---|---|---|
| F1 | `search_cards` orders by (exact number, similarity, name, local_id) — no unique tiebreaker; same name **and** number in two sets can repeat or be skipped across OFFSET pages | Client de-duplicates by card id; a skipped tie is undetectable client-side. Backend fix later (add `c.id` to ORDER BY); no migration in P169 |
| F2 | `search_cards` also admits trigram-similar names (> 0.15): "P169 Bulk" returned 133 cards, not 120 | Totals shown are the server's; the UI says "N of M" and caps at 200 |
| F3 | The **released** `search-prices` sends `sourceValueMinor` as a JSON number without a safe-integer check; a provider value ≥ 2^53 minor units becomes an unsafe literal | The native guard refuses the whole response (`malformed_response`, verified). The candidate's `tcgdex.ts` fixes this |
| F4 | The candidate relays a provider value only if its minor units ≤ 2^53 − 1; larger values become "no price" | Honest; >2^53 reaches the client only as a NOK conversion or a stored snapshot |
| F5 | After a host reboot Windows reserved TCP 55518–55830 (Hyper-V/WinNAT); and P166 backend tests use 127.0.0.1:55999 as a *dead* URL | P169 moved to 559xx/560xx and the mock to 55979; P166 backend suite 28/28 afterwards |
| F6 | Two NOK figures can legitimately differ: the released function's headline converts at the rate on/before the observation date; the P165 client (and P169) use the latest cached rate and print its date | Only the client reference is shown, always with its rate and date |
| F7 | The harness bundle contains the shared `collection.ts` (via P166's runtime), which references `add_card_acquisition` | P169 never calls it; the wire policy refuses it; the static test covers P169 code |
| F8 | One P166 backend run hit a 500 during the 10 006-row keyset walk right after seeding; it did not reproduce | Recorded as a possible load flake (same family as P151/P165 notes) |
| F9 | `pnpm test` (`jest --selectProjects unit shared`) runs only `unit`: no project is named `shared` (they are `shared-node`/`shared-rn`), so the unchanged web-domain tests are silently skipped | Ran them explicitly: 14 suites / 88 tests pass. Fix belongs to package metadata (not changed here) |

## 10. Limits and what is NOT claimed

- **No native recognition.** `NATIVE_RECOGNITION_UNAVAILABLE` is the only implementation.
- **Photo picker not asserted.** The picker is P167 scope; its known fontScale defect (P166 F1) is not
  fixed here, and the device run did not exercise the picker.
- **No hosted smoke.** Not justified: the candidate function and DB 106 are unreleased, and hosted
  released `search-prices` would call the real TCGdex. No hosted DB, function or Production touched.
- **No authorized graded source**; the graded section is structural only.
- **No physical device, no iOS.** Emulator timings are indicative only.
- **JPY** cannot come from the TCGdex relay (EUR/USD only); JPY exponent-0 is proven by unit tests and
  the on-device proof (NOK reference of a JPY amount), not by a provider response.

## 11. Parallel-session boundaries

- Touched existing file: `apps/mobile-spike/src/net/spike-fetch.ts` (+9 lines, additive). Possible
  merge point with P167 if it edits the same allow-list.
- Not touched: shell, `MainNavigator`, `AppRoot`, `LoginScreen`, `PhotoSpikeScreen`, collection
  screens, theme, `app.json`, package metadata, web app, Edge Functions, migrations, HANDOVER.
- The harness is a separate entry (`src/features/harness/index.ts`) wired only in the GENERATED,
  gitignored `android/` project by `scripts/p169/build-harness.mjs`. Subst drive `P:` (P167/P168 use
  `Q:`/`R:`), removed after the build.
- **P168 handoff:** the P169 screens are neutral (`src/features/ui/kit.tsx`: 48 dp targets, one-line
  money, polite live region). States to design: search idle/pending/ready/empty/error/load-more/limit,
  same-name flag, language filter; card identity, printing choice/confirmed/mismatch/no-printing,
  source switch, observation card (source money, NOK reference + rate note, provider time + freshness,
  condition, basis), snapshot card, unavailable/error + fallback, graded "not available", Add to
  collection; photo entry. testIDs are the contract for the device driver.

## 12. Reproduce (Windows 11; Git Bash)

```bash
cd apps/mobile-spike
node scripts/p169/local-backend.mjs start          # own project, 104 migrations, both functions
node scripts/p169/local-backend.mjs write-env
pnpm --dir ../.. exec tsx apps/mobile-spike/scripts/p169/seed.mts
node scripts/p169/mock-tcgdex.mjs &                 # synthetic provider on :55979
pnpm test                                           # native unit + shared web-domain tests
P169_LOCAL_BACKEND=1 pnpm exec jest --selectProjects backend --runInBand tests/backend/p169
node scripts/p169/mutations.mjs
node scripts/p169/build-harness.mjs                 # needs JDK 21 (P169_JAVA_HOME) and the P166 SDK
adb -s emulator-5560 install -r android/app/build/outputs/apk/release/app-release.apk
ANDROID_SERIAL=emulator-5560 node scripts/p169/android-check.mjs
```

`--db106` on `local-backend.mjs`/`seed.mts` and `P169_STACK=db106` for the tests use the DB-106 stack.
