# Price Check adapter contract

Read-only. Price Check **never** creates a holding, purchase, sale or manual-card definition, and the
client refuses to send a request that could. There is **one** price identity model: the spike adopts
the names and statuses of P153's `src/domain/price-check/types.ts` (branch `feat/p153-card-price-check`,
unreleased at `9e6bb46`); it does **not** copy P153's ~6 500-line implementation.

## Port

```ts
interface PriceCheckPort {
  readonly sourceKind: 'released_snapshots' | 'p153_fixture'
  searchCards(query: string): Promise<readonly CardSearchHit[]>
  loadCard(cardId: string): Promise<{ card: CardIdentity; variants: readonly VariantIdentity[] } | null>
  resolveVariant(variantId: string): Promise<{ cardId: string; variantId: string } | null>
  lookup(cardId: string, variantId: string): Promise<PriceLookup>
}
```

| Type | Fields | P153 equivalent |
|---|---|---|
| `CardIdentity` | `cardId, name, setId, setName, collectorNumber, language, imageBaseUrl, rarity, illustrator` | identical |
| `VariantIdentity` | `variantId, finish, stamp, subtype, size, isActive` | identical |
| `VariantResolution` | `confirmed(only_variant \| chosen)`, `choice_required`, `mismatch`, `no_variants` | `resolveVariant` in `identity.ts` (same rules) |
| `PriceObservationView` | provider, providerLabel, metric \| null, metricLabel, basisNote, `kind` (`index`/`sold`/`listing`/`unknown`), `source` (exact source-currency `Money` \| null), `nok` (exact NOK reference \| null), `observedAt`, `condition`, `synthetic` | subset of `PriceObservation` |
| `PriceLookup` | `available{observations, graded}` or `unavailable{reason, graded}` | `RawPriceSection` (reduced) |
| unavailable reasons | `no_variant_price, provider_error, rate_limited, not_found, graded_source_not_configured` | subset of `UnavailableReason` |

## Rules the tests enforce

- A card with several active variants shows **no price** until the person chooses one; nothing is
  pre-selected, "not the first, not the priced one, not the most expensive".
- A requested variant that is not a variant of **this** card is a `mismatch`; it never falls back.
- Switching variant leaves nothing of the previous price; a lookup that answers after the person moved
  to another variant is dropped (key `cardId:variantId`).
- Money is exact: source amount from a decimal **string**, `nok` from the shared `convert` (JPY
  exponent 0). Zero is shown only when the provider reported zero; a malformed, negative, fractional,
  exponent or over-long amount is **dropped and counted**, never shown. `constructor`, `toString`,
  `__proto__` are never a provider, metric or currency.
- **Graded is always `unavailable` / `graded_source_not_configured`.** No authorized graded price
  source exists (P153 §9, `docs/API_SOURCES.md`); nothing is derived from a raw price. The UI states
  it in every result.
- Condition is `null` ("not specified by the source") for every observation.

## Two adapters

### 1. Released interface (real data, DB 104): `released-adapter.ts`

`search_cards`, the `cards`/`card_variants` tables and `get_card_variant_price_history` (real
`price_snapshots`, converted to NOK **server-side**). Verified against the real local stack:

| Check | Result |
|---|---|
| Two finishes of one card have different prices, each equal to the shared-domain `convert` of the seeded EUR amount | pass |
| A 2^58-scale EUR snapshot: the **server's** NOK equals the domain's exact NOK | pass |
| A variant with no snapshot is `no_variant_price`, not zero | pass |
| A holding's variant id resolves back to its card (Card detail → Price Check) | pass |
| Request log of a full journey: only `GET cards/card_variants`, `POST search_cards`, `POST get_card_variant_price_history`, `POST /auth/v1/token`; **no** write RPC | pass |
| Ledger tables (`holdings`, `acquisition_lots`, `manual_valuations`, `manual_card_definitions`, `purchases`, `purchase_lines`, `sales`, `sale_lines`, `lot_disposals`, `lot_cost_adjustments`, `sealed_products`, `openings`, `price_snapshots`, `fx_rates`) have identical count **and content hash** before and after | pass |

What this interface **cannot** say, and the data says so instead of hiding it: no source currency
(`source: null`), no metric (`metric: null`, `kind: 'unknown'`), no provider timestamp (only the
snapshot date), and **one** provider per variant (finding F2).

### 2. P153 fixture (synthetic): `fixture-adapter.ts`

Shaped like P153's `search-prices` `observations[]`:

```ts
{ provider, priceKind, sourceCurrency, valueMinor: "<integer string>", providerUpdatedAt: string | null }
```

The fixture runs that wire through the **same mapper** a live adapter will use
(`observation-wire.ts`), computes the NOK reference with the shared `convert`, and marks every
observation `synthetic`. The UI shows a `SYNTHETIC FIXTURE — not market data` badge. It covers: two
finishes with different prices, a 2^58 EUR amount, a **JPY** amount above 2^53 (zero decimals), a
provider error, and no price. Nothing in it is market data.

## Adopting P153 later

1. Delete `fixture-adapter.ts` and `observation-wire.ts`.
2. Replace `released-adapter.ts` with a port over P153's `src/data/price-check.ts` (`fetchCardPriceResponse`
   → `RawPriceSection`), keeping the `PriceCheckPort` shape. P153 adds freshness classification, the FX
   presentation ("converted at the … rate"), dropped-observation reporting and the scan session; each
   becomes a **field mapping**, not a reimplementation.
3. Replace the local identity types with a type-only re-export of P153's, and `resolve-variant.ts` with
   its function.
4. Keep the tests in `tests/unit/price-check.test.ts`; point them at the released implementation.
5. The read-only request policy stays. Add `search-prices` (POST `/functions/v1/search-prices`) to its
   allow-list only when P153 is live; it is a provider call and must be reviewed for the mobile client's
   rate behaviour (P153 documents no hard TCGdex limit).
