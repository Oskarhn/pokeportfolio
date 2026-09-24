# Source reuse matrix (verified, not assumed)

Every row was checked by importing the module in the native app and running it, not by reading the
import list. "Executed" means the web app's own code ran unchanged under **Jest in Node** and under
the **`jest-expo` React Native preset**. **No row has been executed on Hermes** (no runtime available):
see [TEST_EVIDENCE](TEST_EVIDENCE.md). All were **compiled** by Metro into a Hermes bytecode bundle
(959 modules, `expo export --platform android`).

## Mechanism

| Piece | Where | What it does |
|---|---|---|
| Alias `@shared/*` → `src/*` | `metro.config.js` (`resolveRequest`), `tsconfig.json` (`paths`), `jest.config.js` (`moduleNameMapper`) | The native app imports web modules by name without moving or copying a file |
| Seam `./supabase-client` | same three places, **only for imports made from inside `src/data`** | The web data modules `import { supabase } from './supabase-client'`, a file that reads `import.meta.env` at import time. The native build substitutes `apps/mobile-spike/src/seam/supabase-client.ts`; the web file is never loaded (checked: the Hermes bundle contains no `VITE_SUPABASE`) |
| `import.meta` typing shim | `src/native-shims.d.ts` | Type-checker only: `tsc` still walks the web client file |

This is P154's "Option A" (bundler alias). P154's Option B (a `setSupabaseClient` factory in the web
code) is the right follow-up once the slice is accepted; it needs a reviewed PR to `main` and was not
done here because this spike must not touch web code.

## Modules reused unchanged

| Module | Used for | Executed (Node) | Executed (RN preset) | Notes |
|---|---|---|---|---|
| `src/domain/currency.ts` | minor-unit exponent (JPY = 0) | yes | yes | `isSupportedCurrencyCode` is `value in CURRENCIES`, so `'constructor'` and `'toString'` pass. The native wire mapper checks own properties itself (`asCurrencyCode`), tested |
| `src/domain/decimal.ts` | exact decimal helpers | yes | yes | |
| `src/domain/money.ts` | `toDecimalString`, `Money` | yes | yes | The formatter builds on `toDecimalString`; it does not reimplement it |
| `src/domain/errors.ts` | error classes | yes | yes | |
| `src/domain/fx.ts` | `convert` (exact, half-up, exponent-aware) | yes | yes | Used for the NOK reference of the synthetic Price Check fixture, and as the oracle that the **server's** conversion is compared with, at 2^58 scale |
| `src/domain/pricing-summary.ts` | imported by `data/pricing` | yes | yes | |
| `src/data/portfolio.ts` | `listPortfolio`, `getPortfolioCounts`, name/subtitle helpers | yes (real DB) | yes (scripted network) | Two hazards found, see below |
| `src/data/collection.ts` | `getHoldingSummary`, `getHoldingValueProvenance` | yes (real DB) | yes | |
| `src/data/catalog.ts` | `searchCards`, `getCard`, `getCardVariants`, `getCardVariantWithCard` | yes (real DB) | yes | Wrapped in the web `withAuthRetry` |
| `src/data/pricing.ts` | `getCardVariantPriceHistory` | yes (real DB) | yes | `searchPrices` is **not** used (Edge Function, not live locally, JSON-number `sourceValueMinor`) |
| `src/data/money.ts`, `auth-retry.ts` | transport parse, 401 retry | yes | yes | |
| `src/data/database.types.ts` | types only | n/a | n/a | |
| `src/ui/money-format.ts` | **parity oracle only**, never shipped | yes | n/a | The native formatter is compared against it for 2 000+ values per currency |

### Web tests executed unchanged

`tests/financial/{money,cost-basis,fx,market-value,worked-examples}.test.ts` and
`tests/data/{money,pricing}.test.ts`: byte-for-byte the files Vitest runs for the web app. The only
adaptation is a module mapping of `vitest` to a shim over Jest's globals (`describe`, `it`, `expect`
are all these files use). Result: 7 files, 41 tests, green in **both** the Node and the RN-preset
project. The remaining shared suites (`allocation`, `invariants`) need `fast-check` and were not
brought over; scanner and export suites are out of scope.

## Modules that could **not** be reused

| Module | Why | What the native app has instead |
|---|---|---|
| `src/auth/AuthProvider.tsx` | react-router, TanStack Query cache, browser storage | `AuthController` + `IdentityAuthority` (same behaviour; [AUTH_IDENTITY](AUTH_IDENTITY.md)) |
| `src/auth/query-cache-boundary.ts` | imports `features/openings/draft` and `features/scanner/session-store` (web feature code) | `ScopedRegistry` (`src/state/registry.ts`); P154 already named this for extraction |
| `src/data/supabase-client.ts` | reads `import.meta.env` at import | the seam |
| `src/ui/money-format.ts` | `Intl.NumberFormat(...).formatToParts`, which Hermes documents as Android-only | `src/money/format-money.ts` |
| `src/data/pricing.ts` `searchPrices` | JSON-number money; Edge Function | released-snapshot + fixture adapters |
| everything under `src/features`, `src/ui/*.tsx`, `src/router.tsx` | web UI | native screens |
| `src/domain/scanner`, `src/features/scanner` | out of scope | none |

## Hazards found in the shared code (not fixed; web code is out of scope)

| # | Where | Hazard | Native mitigation |
|---|---|---|---|
| H1 | `src/data/portfolio.ts` `listPortfolio` | `p_cursor_value_minor: Number(cursor.valueMinor)`. For a value above 2^53 the rounded number is sent and the next page **silently drops rows**. Reproduced against the real database ([BACKEND_COMPATIBILITY](BACKEND_COMPATIBILITY.md) F3) | Adapter refuses such a cursor; transport guard refuses the request body |
| H2 | `src/data/portfolio.ts` `listPortfolio` | Next page is decided by `results.length === limit`, but the server clamps `p_limit` to 100. Asking for more marks the list finished after page one | Adapter clamps to 100 |
| H3 | `src/data/money.ts` `parseMinorUnits` | `BigInt(value)`: `''` becomes `0n`, `' 12 '` and `'0x10'` are accepted | Native wire parser (`parseMinorUnitsWire`) is strict; the shared parser is still what parses `list_portfolio` text columns |
| H4 | `src/domain/currency.ts` `isSupportedCurrencyCode` | prototype members pass | own-property check in the native mapper |
| H5 | `src/data/pricing.ts` `searchPrices` | `BigInt(Math.round(sourceValueMinor))` from a JSON number | not used |
| H6 | shared wrappers | `throw new Error(error.message)` drops the HTTP status | client throws a typed status error for `/rest/v1/` so 401 and 500 stay distinguishable |
