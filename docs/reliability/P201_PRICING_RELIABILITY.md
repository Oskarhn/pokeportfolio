# Pricing, catalog and FX reliability — audit record (P201)

Engineering record of an audit of the path from a provider observation to a number on screen. Decisions:
D-201 to D-204 in [DECISIONS.md](../DECISIONS.md). Operational checks:
[P201_PRICING_HEALTH_CHECKLIST.md](P201_PRICING_HEALTH_CHECKLIST.md).

## 1. The pipeline and its trust boundaries

```
TCGdex (community API, no SLA)           Norges Bank (data.norges-bank.no)
   │ HTTPS JSON — untrusted                 │ HTTPS SDMX-JSON — untrusted
   ▼                                        ▼
_shared/provider-http.ts  ── timeout · bounded retry · 429/5xx · failure classes
   │                                        │
_shared/tcgdex.ts (the only file that      _shared/norges-bank.ts (only file that
 knows TCGdex's shape: identity + price     knows SDMX; UNIT_MULT → per-unit rate)
 mapping, variant-exact, ambiguity-averse)  │
   │                                        │
sync-catalog ─► cards, card_variants    ingest-fx / fetch-fx-rate ─► fx_rates
ingest-prices ─► ingest_price_observations ─► price_snapshots  (+ price_sync_attempts, price_sync_runs)
search-prices ─► (no write) ─► client
   │
resolve_variant_market_values / list_portfolio / get_market_movers  ── fresh ≤ 3 d · stale ≤ 30 d · missing
   │
src/data/pricing.ts · price-check.ts  ── exact-money transport guard, typed failure reasons
   │
Card Detail · Search tiles · Price Check · Portfolio
```

Trust boundaries: (1) provider → Edge Function (everything is validated; the mapper returns `null` rather
than guess); (2) Edge Function → database (service role only; `ingest_price_observations` validates per
row); (3) database → browser (RLS, `authenticated` read of market data, no write); (4) Edge Function →
client (`search-prices` is JWT-verified; money crosses as decimal strings, a rewritten integer is refused).

Data transformations that matter for correctness: variant identity `(finish, stamp, subtype, size)` from
`variants_detailed`; Cardmarket fallback chain `trend → avg30 → avg7 → avg` and TCGplayer `marketPrice` only
(FINANCIAL_MODEL §6); provider date → `snapshot_date`; EUR/USD → NOK at the latest rate on or before the
snapshot date; Norges Bank `UNIT_MULT` → NOK per one unit.

## 2. Findings and fixes

| #   | Finding                                                                                                                                                                            | Impact                                                                                               | Fix                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | `sync-catalog` deactivated every listed card whose **detail request failed** (it deactivated "not in the set of successfully fetched cards")                                       | A 5xx/429 burst removed healthy cards from search until a manual re-sync                              | Deactivate from the listing; empty/shrunk listing deactivates nothing (D-201) |
| 2   | `fetch-fx-rate` accepted **any cached rate in the ten days before the date** as the rate for that date                                                                             | A purchase was frozen (F11) at an older day's rate whenever the cache had a gap                      | Exact-date hit only; cache the fetched window; fail closed (D-202)        |
| 3   | `select_price_sync_batch` ordered by the **provider's** snapshot date, nulls first                                                                                                 | Unpriced or old-data variants pinned the queue head; owned variants stopped being refreshed          | Order by our attempts; back off unpriced variants (D-203)                 |
| 4   | One refused row (non-existent date, negative value) failed the whole 500-row upsert chunk, repeatedly                                                                              | Valid prices never written while a poison card stayed in the queue                                   | Mapper rejects the cause; row-by-row write (D-201, D-203)                 |
| 5   | A far-future provider date won `ORDER BY snapshot_date DESC`                                                                                                                       | A variant pinned "fresh" for good                                                                    | Mapper drops it; trigger refuses it (D-201, D-203)                        |
| 6   | TCGplayer `1st-edition-*` buckets were matched as plain "holo"; an embedded record with two holo buckets took whichever came first                                                 | A first-edition price attributed to a variant without the stamp                                      | Match finish **and** edition; second match = ambiguous = no price (D-201) |
| 7   | A record naming another currency (`unit`) was relabelled EUR/USD                                                                                                                   | Wrong-currency number stored as a price                                                              | Reject on unit mismatch (D-201)                                           |
| 8   | TCGdex calls had no timeout, retry or 429 handling although API_SOURCES promised "retry with backoff"                                                                              | A stuck provider held the function; a throttled one was hammered per card                            | `provider-http.ts` policy; stop rule in `ingest-prices` (D-201)           |
| 9   | An out-of-order or duplicate delivery overwrote the stored observation                                                                                                              | An older figure replaced a newer one of the same day                                                 | Order-aware write; identical = unchanged (D-203)                          |
| 10  | `ingest-prices` recorded a run in which every request failed as `succeeded`                                                                                                        | Outages invisible in `price_sync_runs`                                                               | `failed`/`partial`/`succeeded` by outcome (D-201)                         |
| 11  | `ingest-fx` stored only the newest rate and treated a week-old newest rate as success                                                                                              | Gaps never healed; a silent provider looked healthy                                                  | Window backfill; `stale_rate` failure (D-202)                             |
| 12  | `search_cards`: "Charizard 004" found nothing for a set storing "4"; the `/102` of "58/102" was discarded                                                                           | Searches by printed number missed the card; reprints ordered arbitrarily                             | Number equality modulo leading zeros; denominator ranks the set (D-204)   |
| 13  | Search/Card Detail showed the same "—" for "no price", "lookup failed" and a 90-day-old price; Price Check could wait indefinitely on a stuck call                                  | A failure read as "worthless card"; stale read as current                                            | Four states + freshness badge; 20 s lookup timeout (this change)         |

## 3. Measurements

Deterministic synthetic data on a local stack (`scripts/p201/pricing-benchmark.ts`; 60,000 cards, 3,500
watched variants, ~700,000 snapshots; EXPLAIN ANALYZE execution time, median of 15 after 3 warm-ups).

| Measure                                                                | Before              | After               |
| ---------------------------------------------------------------------- | ------------------- | ------------------- |
| Distinct priced variants refreshed in 12 ticks (3,100 priced, 400 unpriced, batch 200) | 1,217               | 2,117 (of 2,400 slots) |
| Unpriced variants in the 12th batch of 200                             | 161                 | 28                  |
| `select_price_sync_batch(200)`, 700k snapshots                         | 56.7 ms             | 22.1 ms             |
| `search_cards('Pikachu 25')` / `('Charizard 058/200')`, 60k cards      | 78 / 84 ms          | 97 / 99 ms          |
| `search_cards('Pikachu')`, 60k cards                                   | 198 ms              | 184 ms              |

The old queue converges on spending all its capacity on variants that can never be priced. The search
cost is a measured 15–20 ms on number queries at 60,000 cards (the catalog is ~47,000); an attempt to
evaluate the normalised number once per row per query changed nothing and was dropped. Name-only
searches (~190 ms at 60k) are dominated by `ilike '%…%'` and trigram similarity, untouched here.

## 4. Deployment order

Two migrations, **neither applied to Production**:
`20261009140000_p201_price_ingest_reliability.sql` (D-203) and `20261009150000_p201_search_cards_number_matching.sql` (D-204).
Both additive / `CREATE OR REPLACE` with unchanged signatures. Order: green CI → `pnpm db:backup`
(`BACKUP_COMPLETE`) → `supabase db push` → deploy `ingest-prices`, `ingest-fx`, `fetch-fx-rate`,
`search-prices`, `sync-catalog` → web release. `ingest-prices` runs without the first migration (falls back
to the previous upsert); the web client runs against an old `search-prices` (the new response fields are
additive and optional). Rollback: redeploy the previous function sources; the migrations need no data repair.

## 5. Remaining risks

- `resolve_variant_market_values` converts a snapshot at the latest FX rate on or before its date with **no
  age bound**; only monitoring (checklist) guards it. Changing it is a financial-semantics decision.
- Variant identity joins multiple stamps in provider order; a provider that reorders them would create a
  second variant. Canonicalising would orphan existing rows.
- TCGdex is a community service with no SLA; every price still depends on it. Prices relayed as
  `index` are not sales.
- The fixtures for the edition-bucket cases are constructed, not captured live; they should be replaced by
  captured payloads when the next live probe is done (RESEARCH.md).
- The health script cannot see a wrong-but-well-formed price.
