# Data Model

Conceptual and relational model. PostgreSQL 15+ via Supabase.
Companion to [FINANCIAL_MODEL.md](FINANCIAL_MODEL.md), which owns all monetary semantics.

---

## 1. Ownership classes

Every table belongs to exactly one class. This drives the RLS policy shape ([SECURITY.md](SECURITY.md)).

| Class | Meaning | RLS |
|---|---|---|
| **Shared catalog** | Global facts about cards and products. Identical for all users. | `SELECT` for any authenticated user. Writes: service role only. |
| **Market data** | Prices and FX. Global facts. | `SELECT` for any authenticated user. Writes: service role only. |
| **User-private** | Everything the user records about their own collection and money. | Full CRUD restricted to `user_id = auth.uid()`. |
| **Derived cache** | Recomputable aggregates kept for performance/history. | Same as user-private. Never a source of truth. |
| **System** | Invitations, audit. | Narrow, purpose-specific policies. |

---

## 2. Schema overview

```
                      SHARED CATALOG                      USER-PRIVATE
  ┌──────────────┐                             ┌──────────────┐
  │ card_series  │                             │  profiles    │──┐
  └──────┬───────┘                             └──────────────┘  │
         │                                                        │ user_id on
  ┌──────▼───────┐   ┌──────────────────┐      ┌──────────────┐  │ every table
  │  card_sets   │──▶│ sealed_products  │      │  retailers   │  │ below
  └──────┬───────┘   └────────┬─────────┘      │storage_locs  │  │
         │                    │                │    tags      │  │
  ┌──────▼───────┐            │                └──────────────┘  │
  │    cards     │            │                                   │
  └──────┬───────┘            │       ┌──────────────┐            │
         │                    │       │  purchases   │            │
  ┌──────▼───────┐            │       └──────┬───────┘            │
  │card_variants │◀───────┐   │              │                    │
  └──────┬───────┘        │   │       ┌──────▼────────┐           │
         │                │   │       │purchase_lines │           │
   MARKET DATA            │   │       └──────┬────────┘           │
  ┌──────▼─────────┐      │   │              │                    │
  │price_snapshots │      │   │       ┌──────▼───────┐            │
  └────────────────┘      └───┼───────│   holdings   │            │
  ┌────────────────┐          │       └──────┬───────┘            │
  │   fx_rates     │          │              │                    │
  └────────────────┘          │       ┌──────▼──────────┐         │
                              │       │acquisition_lots │◀────────┘
                              │       └──┬───────────┬──┘
                              │          │           │
                    ┌─────────▼──────┐   │    ┌──────▼──────────────┐
                    │    openings    │◀──┘    │lot_cost_adjustments │
                    └────────────────┘        └─────────────────────┘
                              ▲                       │
                              │               ┌───────▼────────┐
                    ┌─────────┴──────┐        │ lot_disposals  │
                    │grading_submis. │        └───────┬────────┘
                    └────────────────┘                │
                                              ┌───────▼────────┐
                                              │  sale_lines    │
                                              └───────┬────────┘
                                                      │
                                              ┌───────▼────────┐
                                              │     sales      │
                                              └────────────────┘
```

---

## 3. Shared catalog

### 3.1 `card_series`, `card_sets`, `cards`, `card_variants`

The catalog is a four-level hierarchy mirroring how the TCG is actually published:
series → set → card → **variant**.

**`card_variants` is the priceable, ownable unit.** A user does not own "Charizard from Base
Set" — they own "Base Set Charizard, holo finish". Cardmarket and TCGplayer both price at
finish level, and TCGdex exposes `variants_detailed[]` with per-variant pricing, so the
variant is the natural join point.

| Table | Key columns |
|---|---|
| `card_series` | `id uuid pk`, `slug`, `name`, `language`, `tcgdex_series_id`, `is_active bool`, `last_seen_at` |
| `card_sets` | `id uuid pk`, `series_id fk`, `slug`, `name`, `language`, `card_count_official int`, `card_count_total int`, `released_on date`, `logo_url`, `symbol_url`, `is_active bool`, `last_seen_at` |
| `cards` | `id uuid pk`, `set_id fk`, `local_id text` (collector number as printed), `name`, `rarity`, `category`, `illustrator`, `image_base_url`, `language` (denormalized from the set, trigger-enforced), `is_active bool`, `last_seen_at` |
| `card_variants` | `id uuid pk`, `card_id fk`, `finish` enum, `stamp text`, `subtype text`, `size` enum, `is_active bool`, `last_seen_at` |

**`finish`, `stamp` and `subtype` are three independent dimensions (D-033), not one enum.** M3
shipped a single `variant_type` enum (`normal`, `holo`, `reverse`, `first_edition`, `promo`,
`stamped`, `other`) that treated finish and edition as mutually exclusive values of the same column.
M5's ingest found a real card that disproves that: Base Set Charizard has a variant that is holo,
shadowless *and* first-edition simultaneously. `finish` is a small enum (`normal`/`holo`/`reverse`/
`other`); `stamp` and `subtype` are free text because TCGdex's own vocabulary for them is not a
documented closed set. Uniqueness is `(card_id, finish, stamp, subtype, size)`, with `''` — not
`NULL` — meaning "provider did not report one", chosen so the constraint can be a plain column-list
unique constraint that Postgres/PostgREST upsert can target directly (an expression index over
`coalesce(..., '')` cannot be an `ON CONFLICT` target — found by running the ingest function for
real, not by inspection).

`local_id` is text, not integer: collector numbers include `SV049`, `TG12`, `H31`, `001/165`.

**Provider-id uniqueness is scoped by `language`, not global (D-034).** TCGdex reuses ids across
languages — `neo1` names both English "Neo Genesis" and Japanese "金、銀、新世界へ...", and both
series lists contain a series id `neo` — so `card_series`, `card_sets` and `cards` all carry
`language` and their provider-id uniqueness is `unique (language, tcgdex_*_id)`. `cards.language` is
denormalized from `card_sets.language` (the same technique `user_id` uses on user-owned child
tables), with a trigger asserting it never drifts from the parent.

**`is_active` and `last_seen_at` exist so an upstream deletion never destroys internal identity**
(M5 prompt §19). A card or set TCGdex stops listing is deactivated on its next sync, never deleted —
a holding referencing a deactivated variant stays valid, it just stops appearing in search.

### 3.2 Language and international identity

`language` lives on `card_sets`, not on `cards`. Rationale: Japanese products are not
translations of English sets — they are different sets with different card counts, different
numbering and different release cadence. `sv1a` (Japanese) does not map onto `sv01` (English)
row by row.

Consequences, deliberately accepted:

- A Japanese card and its English counterpart are **separate `cards` rows in separate `card_sets`**.
- No cross-language identity link is asserted in MVP. If one is added later it belongs in an
  explicit `card_equivalences` table with a confidence field, not in the primary key structure.
- A holding references one `card_variant`, so its language is implied by the set. `holdings`
  carries no redundant language column.

TCGdex confirms this shape: `/v2/en/sets` returns 218 sets, `/v2/ja/sets` returns 177, with
entirely different identifiers (`base1` vs `PMCG1`).

### 3.3a Search and sync observability (M5)

`search_cards(p_query, p_language, p_limit, p_offset)` is a `SECURITY INVOKER`, `STABLE` Postgres
function — invoker rights because `authenticated` already holds plain `SELECT` on every table it
reads, so there is no privilege gap for a `DEFINER` to bridge. It ranks over `cards` joined to
`card_sets`, splitting a trailing collector-number-shaped token off the query (`"Base Set 4"` →
text `"Base Set"` + number `"4"`) so combined name/number queries work without a natural-language
parser. Every predicate is a bound parameter; nothing concatenates caller input into SQL text.
Trigram indexes on `cards.name` (M3) and `card_sets.name` (M5) accelerate both the `%` similarity
operator and `ILIKE '%term%'`, which is what makes short and Japanese queries workable without a
second search engine.

`catalog_sync_runs` is a service-role-only log, one row per `(language, tcgdex_set_id)` ingest
attempt: status, counts, an error string, timestamps. RLS enabled with no policies (same shape as
`invitation_claims`) — unreachable through the Data API under every role a browser can hold. It
answers "when was English/Japanese last synced, did anything fail, which set" without building
anything closer to monitoring than a table.

### 3.3 `sealed_products`

| Column | Notes |
|---|---|
| `id uuid pk` | |
| `set_id fk nullable` | Null for multi-set or non-set products |
| `product_type` | enum, see below |
| `name`, `language` | |
| `pack_count int nullable` | Enables cost-per-pack analytics |
| `image_url nullable` | |

`product_type` enum: `booster_pack`, `booster_bundle`, `booster_box`, `elite_trainer_box`,
`collection_box`, `tin`, `blister`, `ultra_premium_collection`, `other`.

Stored as a Postgres enum extended by migration rather than a hardcoded application constant,
so adding a type is a schema change with a reviewable diff.

**Seeding reality:** no free provider currently exposes a sealed-product catalog for the
European market. MVP seeds this table from a curated list plus user-created entries.
`created_by_user_id nullable` distinguishes curated rows from user-added ones; user-added rows
are visible only to their creator until promoted.

**M11's actual curated seed** (`20260829120030_m11_curated_sealed_seed.sql`) is deliberately
modest and individually sourced — seven real products (English and Japanese, spanning
booster pack/box/ETB/bundle/tin, set-linked and one deliberately non-set-linked) verified against
retailer/official listings at migration time, never a generated combination of every set × every
product type. It is not, and does not claim to be, a complete catalog — the custom-product path
below is how a real gap gets filled. `image_url` stays null for every curated row seeded this way
(no artwork provenance was cleared for redistribution); the UI falls back to a generic per-type
placeholder, same as a custom product.

A user-added row never gets an `image_url` at creation (prompt §13): no field is offered for one,
deliberately — an arbitrary external image URL would expand the CSP `img-src` allowance, carries
no licensing/ownership guarantee, and risks a broken or tracking-laden remote reference. Real
per-product artwork (curated or user-supplied) is the later Images milestone's problem, not M11's.

### 3.4 Provider mapping

Provider identifiers are **nullable columns on the catalog tables**, not a polymorphic
mapping table:

| Table | Provider columns |
|---|---|
| `card_series` | `tcgdex_series_id` |
| `card_sets` | `tcgdex_set_id` |
| `cards` | `tcgdex_card_id` |
| `card_variants` | `tcgdex_variant_id`, `cardmarket_product_id`, `tcgplayer_product_id` |
| `sealed_products` | `cardmarket_product_id`, `tcgplayer_product_id` |

`card_series`/`card_sets`/`cards` have a plain (non-partial) unique constraint on
`(language, tcgdex_*_id)` — plain rather than `WHERE col IS NOT NULL` because Postgres already
treats every `NULL` as distinct from every other value in an ordinary unique constraint, so the
partial form bought nothing and, found the hard way, cannot be a PostgREST upsert `on_conflict`
target (D-034). `card_variants`' three provider columns are plain indexed columns with **no**
uniqueness at all: `tcgdex_variant_id` is sometimes the literal string `"generated"` (TCGdex's own
placeholder for "no real cross-reference", mapped to `NULL` by the adapter rather than stored), and
`cardmarket_product_id`/`tcgplayer_product_id` are marketplace listing ids that can legitimately be
shared by sibling finishes of the same card (D-034) — informational for M9's price ingest, never a
claim of one-to-one identity.

Rationale: a polymorphic `provider_refs` table cannot carry real foreign keys and would need
application-level integrity enforcement — a poor trade at this scale. Explicit columns are
constrainable, indexable and readable. Adding a fifth provider is one migration.

> **Internal `uuid` identity is canonical.** Provider ids are mapping metadata. If TCGdex
> disappears, `tcgdex_*` columns go stale but no holding, lot, purchase or price row breaks.

---

## 4. Market data

### 4.1 `price_snapshots`

**Shipped in M9** (`20260826120000_m9_price_snapshots.sql`), one deliberate correction from this
section's original pre-M9 sketch: see D-053. The ingest job resolves the FINANCIAL_MODEL.md §6
fallback chain *before* writing and stores only the winning value per provider per variant per
day, so `price_kind` is provenance metadata on the row, not part of its identity.

| Column | Notes |
|---|---|
| `id bigint pk` | `generated always as identity` |
| `card_variant_id fk` | references `card_variants(id)` |
| `provider` | enum `price_provider`: `tcgdex_cardmarket`, `tcgdex_tcgplayer` |
| `price_kind` | enum `price_kind`: `cm_trend`, `cm_avg30`, `cm_avg7`, `cm_avg`, `tp_market` — whichever candidate won the §6 fallback for this row |
| `source_currency` | ISO 4217 — always `EUR` for `tcgdex_cardmarket`, `USD` for `tcgdex_tcgplayer` |
| `value_minor bigint` | In `source_currency`. A genuine `0` is a real observation (F14), never collapsed with "no row". |
| `snapshot_date date` | The provider's own business date for this observation (`providerUpdatedAt`'s date), not the day we happened to fetch it — see §4.2's idempotency note. |
| `provider_updated_at timestamptz` | Provider's own freshness claim, when given |
| `retrieved_at timestamptz` | When we fetched it |

Unique on `(card_variant_id, provider, snapshot_date)` — **not** `..., price_kind, ...` as
originally sketched (D-053). Index on `(card_variant_id, snapshot_date DESC)` for latest-price
resolution, and a plain index on `(snapshot_date)` for retention thinning.

Manual valuation is a separate table (§5.12) — `price_snapshots` never has a `provider = 'manual'`
row; the resolver treats "an active manual valuation exists" and "a provider snapshot exists" as
two entirely different lookups (`resolve_variant_market_values`, §14 M9 implementation notes).

RLS: `SELECT` for any `authenticated` user (market data, DATA_MODEL.md §1); no insert/update/delete
policy exists for that role at all — only `service_role` (the `ingest-prices` Edge Function) writes.

Sealed price snapshots are not implemented in M9 — sealed valuation remains manual (§6.3, M11).

### 4.2 What gets snapshotted

Snapshotting all ~47 000 English+Japanese variants daily would consume a meaningful slice of the
Supabase free tier's 500 MB for data nobody looks at.

Instead the daily job reads a view, shipped in M9 exactly this shape
(`20260826120000_m9_price_snapshots.sql`):

```sql
create view public.watched_card_variants as
select distinct h.card_variant_id
from public.holdings h
join public.acquisition_lots l on l.holding_id = h.id
where h.card_variant_id is not null;
```

Deliberately **not** filtered by `l.voided_at is null` or `l.quantity_remaining > 0` — any lot
ever created for a variant keeps it watched forever, whether the lot is currently open, fully
disposed, or voided as a correction (D-055). The model cannot safely distinguish "voided because
this was a same-day mistake" from "voided because the card was genuinely later removed
(M8.1's Remove from Portfolio)" — both look identical in the schema — so it errs toward keeping
too much history rather than silently destroying a real one. Service/infrastructure-only: no
grant to `anon`/`authenticated` at all (this view spans every user's holdings, and a browser has
no legitimate reason to learn in aggregate which cards anyone owns) — `service_role` bypasses RLS
and is the only role that ever queries it, via the bounded work-queue helper
`select_price_sync_batch(p_batch_size)`.

**Price history is per `card_variant`, never per physical copy.** This is what makes tracking
every energy card affordable. Owning eighty Basic Grass Energy of the same printing produces
exactly one snapshot row per day, not eighty; quantity is applied at aggregation time, from
`acquisition_lots`. The snapshot table scales with *distinct printings owned*, which plateaus
quickly, not with *cards owned*, which does not.

Concretely: a 10 000-card collection realistically spans perhaps 3 000–4 000 distinct variants,
because duplicates, energies and playsets collapse. At ~3 500 watched variants × up to 2 provider
rows × 365 days **unthinned**, this would be ~609 MB — over the entire free-tier budget on
`price_snapshots` alone. **M9.1 measured the real footprint** (245.30 bytes/row, table + its two
indexes — `scripts/price-snapshots-storage-benchmark.sql` against a representative 365,000-row
synthetic dataset in CI's ephemeral Postgres, not the earlier ~200-300 byte/row estimate) and
shortened retention to **60 days of daily history, thinned to weekly beyond that**
(`thin_price_snapshots()`, D-058) — projecting to ~271 MB at 3,500 watched variants/2 providers/2
years, ~180 MB at 1 year. Full projection table: COST_POLICY.md §6 (Supabase row).
The holdings and lots themselves are small — roughly 200 bytes per lot, so even 10 000 lots is
~2 MB.

> The binding constraint on the free tier is price history, and price history is decoupled from
> collection size. This was the key finding that made all-card tracking viable at zero cost.

> A variant enters the watch set the moment it is first acquired. Its price history therefore
> begins at acquisition, not before. This is a real limitation, documented in
> [RESEARCH.md](RESEARCH.md), and is preferable to fabricating pre-ownership history.

**Idempotency (prompt §21).** `snapshot_date` is the provider's own `updated` timestamp for that
observation, truncated to a date — not "today". A cron tick that receives the same unchanged
provider observation upserts onto the same `(card_variant_id, provider, snapshot_date)` row rather
than fabricating a new day's fact; a provider's price genuinely changing on a later real business
date is what produces the next distinct row.

### 4.3 `fx_rates`

| Column | Notes |
|---|---|
| `base_currency`, `quote_currency` | ISO 4217 |
| `rate_date date` | |
| `rate numeric(18,8)` | |
| `source` | enum `norges_bank`, `manual` |

Unique on `(base_currency, quote_currency, rate_date, source)`.
Norges Bank publishes business days only; the resolver falls back to the most recent prior
date and records which date was used.

---

## 5. User-private core

### 5.1 `profiles`

`id uuid pk` references `auth.users(id)` on delete cascade.

| Group | Columns |
|---|---|
| Identity | `display_name`, `is_admin bool default false`, `created_at`, `disabled_at nullable` |
| Locale | `locale` (default `nb-NO`), `display_currency` (default `NOK`) |
| Display | `theme` (`system`/`light`/`dark`, now actually applied — DESIGN_SYSTEM.md §3), `collection_grid_density smallint default 2` (1–4), `collection_default_view` (`grid`/`list`/`table`), `collection_default_sort` (M7), `hide_values bool default false` (M7.1 value-privacy eye) |
| Filtering | `low_value_threshold_minor bigint default 1000` (10 NOK), `hide_low_value_by_default bool default false` |
| Pricing preference | `use_eu_pricing bool default true` (M7.1) — stored ahead of M9's resolver; genuinely inert until it exists (D-044) |
| Pricing | `preferred_price_kind` (default `cm_trend`) |
| Capture | `default_condition`, `default_language`, `default_storage_location_id` — prefills for fast entry and, later, scanner session defaults |

Settings live as columns on `profiles` rather than in a separate key-value settings table. At this
scale a settings table buys nothing but an extra join and untyped values; columns are typed,
constrainable and queryable. If the set grows past roughly twenty, revisit.

`collection_grid_density` defaults to 2 but is a per-user preference, never a hardcoded constant.
Layout code reads it from the profile.

`is_admin` grants invitation management only. It grants **no** read access to another user's
collection or financial data — see [SECURITY.md](SECURITY.md) §4.

### 5.2 Four different ways of grouping cards

These are separate concepts and are deliberately not merged. Conflating them produces a model
where "move this card to the Trade Binder" and "this card is currently cheap" are the same
operation, which is wrong.

| Concept | Answers | Cardinality | Changes when |
|---|---|---|---|
| **Storage location** | *Where is this card physically?* | One per lot (§5.5; was one per holding until M6's D-036 correction) | The user physically moves that batch |
| **Custom collection** | *What conceptual group did I put it in?* | Many per holding | The user decides |
| **Tag** | *Free-form label* | Many per holding | The user decides |
| **Smart filter** | *What matches this rule right now?* | Computed, stored nowhere | The underlying data changes |

**`retailers`, `storage_locations`, `tags`** — all user-scoped (`user_id fk`), `name` unique per
user. Retailers are user-scoped rather than global so that "how much have I spent at Outland" is
a private fact and two users' naming habits never collide. `storage_locations` has a `kind` enum
(`binder`, `box`, `toploader_box`, `graded_case`, `shelf`, `other`) and a `sort_order`.

**`holding_tags`** (M6): many-to-many join, `(holding_id, tag_id)` composite PK plus a denormalized
`user_id` (S1). Membership only — adding or removing a tag changes nothing financial, same
reasoning as `custom_collection_members`' invariant C1 below, which `custom_collections` itself
(the grouping concept, not the join table) still ships with in M7.

### 5.2.1 `custom_collections` and `custom_collection_members` — shipped in M7

User-defined groups: *Trade Binder*, *Favourites*, *151 Master Set*, *Childhood Cards*, *Sell*.

| `custom_collections` | `id uuid pk`, `user_id fk`, `name`, `description nullable`, `sort_order int`, `color nullable`, `created_at` |
|---|---|
| `custom_collection_members` | `collection_id fk`, `holding_id fk`, `user_id fk`, `sort_order int`, `added_at` — composite PK `(collection_id, holding_id)` |

Membership is many-to-many at **holding** level, not lot level: the user thinks "this card is in
my trade binder", not "the copy I bought in March is in my trade binder". If they need to
distinguish two copies, the copies differ in condition or state and are already separate holdings.

Membership is purely organisational. Adding a holding to a collection does not change ownership,
value, cost basis or anything financial. Removing it deletes the membership row and nothing else.

> **Invariant C1:** deleting a `custom_collection` cascades only to membership rows. No holding,
> lot or transaction is ever affected. Asserted by test
> (`tests/db/m7_constraints.test.ts`).

No RPC layer wraps CRUD here — create/rename/delete a collection and add/remove a holding are
plain owner-scoped table writes under RLS, the same shape as `storage_locations`/`tags`
(SECURITY.md §3.2.1). `list_portfolio`/`portfolio_counts` (§10.1) are the read side: a
`custom_collection_id` filter parameter joins membership the same way any other Portfolio filter
does, so quick chips and the full filter panel share one query shape.

### 5.2.2 Smart filters

Not stored as membership. A smart filter is a query over resolved market value and price state,
evaluated at read time:

```
Low value      : resolved_value_nok < profiles.low_value_threshold_minor
                 AND price_state <> 'missing'
No price       : price_state = 'missing'
```

Value-based grouping must not be materialised, because a card's value changes daily and
rewriting membership rows every night would be both expensive and misleading — a card would
appear to have been "moved" by a price tick.

The *low value* and *no price* filters are deliberately distinct. A card with no price is not a
cheap card; treating them as one would be the same category error as valuing missing data at zero.

Neither filter removes anything from the collection: matched cards keep their quantity in the
physical card count, and their market value (where one exists) still contributes to `CMV`. The
user may choose to collapse them out of the default browsing view; that is a display preference,
not a deletion, and the count of hidden cards stays visible.

### 5.3 `purchases` and `purchase_lines`

A purchase is one receipt. It always has at least one line.

**`purchases`**

| Column | Notes |
|---|---|
| `id uuid pk`, `user_id fk` | |
| `origin` | enum `manual`, `provisional_opening`. See §5.8.1 |
| `purchased_on date` | Business event date. Backdating fully supported. |
| `retailer_id fk nullable` | |
| `currency` | ISO 4217 |
| `subtotal_minor`, `shipping_minor`, `customs_minor`, `discount_minor`, `total_minor` | In `currency` |
| `fx_rate_to_nok numeric(18,8)`, `fx_rate_date date`, `fx_source` | `1.0`/`manual` when currency is NOK |
| `total_nok_minor` | Frozen at write time (F11) |
| `notes`, `created_at`, `updated_at`, `voided_at nullable` | |

Check constraint: `total_minor = subtotal_minor + shipping_minor + customs_minor − discount_minor`.

**`purchase_lines`**

| Column | Notes |
|---|---|
| `id uuid pk`, `purchase_id fk`, `user_id fk` | `user_id` denormalized for a single-table RLS predicate |
| `line_type` | enum `card`, `sealed`, `grading_fee`, `grading_shipping`, `bulk_lot`, `accessory`, `shipping_standalone`, `customs_standalone`, `other` |
| `spend_class` | enum `collectible`, `hobby`. Defaulted from `line_type`, user-overridable. |
| `description` | Free text; required for lines with no catalog reference |
| `card_variant_id fk nullable`, `sealed_product_id fk nullable` | Mutually exclusive |
| `condition` | enum `MT`,`NM`,`EX`,`GD`,`LP`,`PL`,`PO`; null for non-card lines |
| `quantity int`, `unit_price_minor`, `line_total_minor` | |
| `allocated_shipping_minor`, `allocated_customs_minor`, `allocated_discount_minor` | Written by the allocator (FINANCIAL_MODEL §4.1) |
| `attributable_cost_minor`, `attributable_cost_nok_minor` | Materialized; recomputed only when the purchase itself is edited |
| `target_lot_id fk nullable` | For `grading_fee`/`grading_shipping`: which lot this cost attaches to |

Allocated amounts are stored rather than computed on read because the allocator's
largest-remainder output must be stable and auditable. A recompute happens only on purchase
edit, inside the same transaction.

### 5.4 `holdings`

A holding is "a distinct thing I own, in a distinct state". It carries no quantity and no
money — those belong to lots.

| Column | Notes |
|---|---|
| `id uuid pk`, `user_id fk` | |
| `holding_kind` | enum `raw_card`, `graded_card`, `sealed` |
| `card_variant_id fk nullable`, `sealed_product_id fk nullable`, `manual_card_id fk nullable` | Exactly one non-null, enforced by check constraint (M6, D-037 — see §5.4.1) |
| `condition` | Null for sealed and for graded |
| `grading_state` | enum `raw`, `pending`, `graded`. `raw` for sealed holdings. |
| `grader` | enum `psa`, `cgc`, `bgs`, `ace`, `sgc`, `tag`, `other`; null unless graded/pending |
| `grade numeric(3,1) nullable`, `cert_number text nullable` | |
| `is_favorite bool` | |
| `notes`, `created_at`, `updated_at`, `deleted_at nullable` | |

**`sealed_intent` lives on `acquisition_lots`, not here — moved there in M11 (D-061).** It was
originally sketched as a holding-level column, matching `storage_location_id`'s pre-M6 mistake
exactly (§5.4's own note below): `holdings_identity` merges every lot for the same product/
condition/grading-state combination into one holding row, so a single holding-level intent column
cannot represent a user who owns three identical booster boxes and wants two "keep sealed" and one
"planned to open" — there is only one slot for the whole position, not one per physical unit. M11's
audit (prompt §17) tested this scenario against the pre-M11 shape before any UI was built on top of
it and found it could not be represented truthfully. See §5.5 for where it actually lives and why.

**`storage_location_id` lives on `acquisition_lots`, not here** — moved there in M6 (D-036) after a
concrete scenario proved the original "one per holding" cardinality wrong: two identical NM copies
in Binder 1 and a third in Binder 2 are correctly one holding (`holdings_identity` below merges
them) but cannot share one location column. See §5.5.

Partial unique index so the same physical state does not fragment into duplicate holdings:

```sql
CREATE UNIQUE INDEX holdings_identity ON holdings (
  user_id,
  holding_kind,
  coalesce(card_variant_id, sealed_product_id, manual_card_id),
  coalesce(condition::text, ''),
  grading_state,
  coalesce(grader::text, ''),
  coalesce(grade, -1)
) WHERE deleted_at IS NULL;
```

Enum columns are cast to `text` before coalescing because there is no enum member meaning
"absent"; the empty string is unambiguous since no enum renders as one.

A graded card is a **separate holding** from the raw copies of the same variant, because it has
a different market and a different valuation path. Grading moves a lot from the raw holding to
a new graded holding via `lot_transfers` (§5.9).

`holding_kind = 'sealed'` covers all sealed inventory. There is no separate sealed table: the
lot mechanics (quantity, cost basis, partial disposal) are identical, and unifying them means
one code path for valuation, sales and export.

#### 5.4.1 `manual_card_definitions` — the catalog-missing fallback (M6, D-017/D-037)

A user-private identity source alongside the shared catalog, for a physical card the ingest has
not (yet) covered. M5's real ingest found permanent provider gaps — dozens of sets with a
non-zero card count and an empty `cards[]` array, ~9,300 cards with no image, six sets that never
ingested at all — so "the shared catalog has this card" cannot be a precondition for ownership
without silently breaking D-017.

| Column | Notes |
|---|---|
| `id uuid pk`, `user_id fk` | |
| `name text not null` | |
| `set_name`, `collector_number`, `language`, `finish`, `stamp`, `subtype text nullable` | Free text — deliberately not the catalog's typed enums/foreign keys, since nothing here is verified provider data |
| `size card_size nullable` | Reuses the catalog's enum; a genuinely closed vocabulary, unlike the fields above |
| `notes text nullable`, `created_at`, `updated_at` | |

No provider id, no rarity, no price, no image requirement — see M6 prompt §18. Ownership class
"User-private" (§1): full CRUD restricted to `user_id = auth.uid()`, never visible to another user,
never written into `cards`/`card_variants`.

**Future reconciliation**, not built in M6: when the shared catalog later gains the missing card,
repointing a holding's `card_variant_id` at the canonical variant and clearing `manual_card_id` is
the existing "correct a card's identity" lifecycle operation (§9), applied to this column. No lot,
cost or disposal history is disturbed.

### 5.5 `acquisition_lots`

The financial heart of the model.

| Column | Notes |
|---|---|
| `id uuid pk`, `holding_id fk`, `user_id fk` | |
| `origin` | enum `purchase`, `opening`, `trade_in`, `gift`, `found`, `pre_tracking`, `other`. UI labels: opening → "Pulled", pre_tracking → "Existing collection". |
| `cost_basis_state` | enum `known`, `unallocated_opening`, `not_paid`, `unknown`, `trade_in` |
| `purchase_line_id fk nullable` | Set when `origin = 'purchase'`, or when `origin = 'other'` with a known cost |
| `acquired_on date` | |
| `quantity int`, `quantity_remaining int` | `0 <= quantity_remaining <= quantity` |
| `unit_cost_basis_minor bigint **nullable**` | Present only when `cost_basis_state = 'known'`. **Never 0 to mean "free".** |
| `cost_basis_currency`, `unit_cost_basis_nok_minor nullable` | |
| `residual_minor int default 0` | Largest-remainder residual so `quantity × unit + residual` = line cost exactly, in the lot's original currency |
| `residual_nok_minor bigint default 0` | **Shipped in M10** (D-060) — the NOK-side counterpart. `create_purchase`/`update_purchase` originally floor-divided `unit_cost_basis_nok_minor` and silently dropped this remainder; invisible for NOK-currency purchases (`attributable = attributable_nok` exactly) but a real leak for foreign-currency multi-unit lots. Backfilled from `attributable_cost_nok_minor` for existing rows. |
| `storage_location_id fk nullable` | Relocated here from `holdings` in M6 (D-036) — where a specific batch of copies physically sits, not a property of the holding as a whole |
| `sealed_intent` | enum `keep_sealed`, `planned_to_open`, `undecided`. **Relocated here from `holdings` in M11 (D-061)** — same reasoning as `storage_location_id`'s M6 move directly above: a batch-level property, not a holding-level one. Not null iff the parent holding's `holding_kind = 'sealed'`, enforced by `acquisition_lots_check_owner` (no `holding_kind` column exists on this table to write a plain CHECK against, so the trigger that already looks the parent up does the enforcement). |
| `notes`, `created_at`, `voided_at nullable` | |

`sealed_intent` is organisational only. Changing it never alters purchase history, cost basis or
any financial figure — it exists so "what is my sealed investment worth" can be separated from
"what is queued to be opened", which are different questions about the same shelf. Because it lives
per-lot rather than per-holding, a holding with mixed intent across its lots (two boxes kept sealed,
one planned to open) reads correctly: Holding Detail lists each lot with its own intent, and
Portfolio/`list_portfolio` aggregate the remaining quantity per intent bucket
(`qty_keep_sealed`/`qty_planned_to_open`/`qty_undecided`) for the tile summary. Changing intent for
part of a lot's remaining quantity (`set_sealed_lot_intent`, M11) splits the lot into two — a new
sibling lot at the new intent and the original shrunk by the same amount, both keeping the original
lot's `unit_cost_basis_minor`/`unit_cost_basis_nok_minor` unchanged so nothing about cost basis is
invented, lost or double-counted; the original's `residual_minor`/`residual_nok_minor` stays
entirely on the shrunk lot rather than being divided, since both are already an integer-rounding
leftover independent of how the remaining quantity is later subdivided. This is the smallest model
that can represent differing intent among otherwise-identical physical units, chosen over the
alternative of folding intent into `holdings_identity` (which would have turned a intent change into
a second, separate Portfolio row for the same product — rejected per prompt §19's "remains
understandable as one product tile" requirement).

**`opening_id`/`trade_line_id` do not exist yet.** `origin` gained the `opening` and `trade_in`
enum values in M6 (D-038, pulled forward from their originally-planned M16/M18 arrival) so a pulled
or traded-in card is recordable now, but the columns that will eventually link a lot back to its
`openings`/`trades` row arrive with those tables, per §12's "enum vocabulary tracks table
availability" pattern. A `origin = 'opening'` lot in M6 simply has no opening reference yet — this
is the "later opening reconciliation/linking must remain possible" case that pattern already
anticipated. `cost_basis_state`'s consistency mapping to `origin` (below) is what stops a pull ever
being priced as if it were a purchase in the meantime.

An `origin = 'purchase'` lot with a known cost is created together with a real, ordinary
`purchases`/`purchase_lines` row by M6's `add_card_acquisition` RPC (a single line, no shipping, no
discount) — not a "provisional" purchase. M8 adds the ability to build a richer multi-line purchase
over the same tables; it does not introduce a different *kind* of purchase.

`cost_basis_state` is a separate column rather than something inferred from `origin`, because the
mapping is not one-to-one: a `purchase`-origin lot from a pre-tracking receipt the user no longer
has is `unknown`, not `known`. Making the user state the reason explicitly is what allows the UI
to say "cost unknown" rather than showing a blank field that reads as zero.

Check constraint enforcing M1/M2:

```sql
CHECK (
  (cost_basis_state = 'known'
     AND unit_cost_basis_minor IS NOT NULL
     AND purchase_line_id IS NOT NULL)
  OR
  (cost_basis_state <> 'known' AND unit_cost_basis_minor IS NULL)
)
```

Plus a consistency constraint tying origin to the permitted states, shipped in M6
(`acquisition_lots_origin_cost_state_consistency`):

| `origin` | Permitted `cost_basis_state` |
|---|---|
| `purchase` | `known`, `unknown` |
| `opening` | `unallocated_opening` only |
| `gift` | `not_paid` only |
| `trade_in` | `trade_in` only |
| `pre_tracking` | `unknown` only |
| `found` | `not_paid`, `unknown` |
| `other` | `known`, `not_paid`, `unknown` |

### 5.6 `lot_cost_adjustments`

**Shipped in M10** (`20260828115000_m10_lot_cost_adjustments.sql`, D-060) — this table was
documented since M3 but never actually created; M10's `create_sale` is the first real reader
(freezing EUCB into `sale_lines.cost_basis_at_sale_nok_minor`), which is what finally required it
to exist.

| Column | Notes |
|---|---|
| `id uuid pk`, `lot_id fk`, `user_id fk` | |
| `kind` | enum `grading_fee`, `grading_shipping`, `restoration`, `other` |
| `purchase_line_id fk **not null**` | Enforces F7 — no cost basis increase without a real purchase |
| `amount_minor`, `currency`, `amount_nok_minor` | |
| `occurred_on date`, `note` | |

Keeping adjustments separate from `unit_cost_basis_minor` means the original acquisition price
is always visible, and grading costs can be attributed, reversed or analysed independently.

`authenticated` holds **SELECT only** — no INSERT yet. M17 owns the real "record a grading
submission" write RPC, which will validate the fee against a `grading_submissions` row before
writing here; a bare INSERT grant with no such validation would let a user inflate their own cost
basis by citing any unrelated purchase line of theirs (D-060).

**The residual-consumption rule (D-060).** When a lot's adjustments must be divided per unit for a
*partial* disposal, the division uses the same exact, deterministic rule
`acquisition_lots.residual_minor` already established, not a floating average:

```
adjustments_total_nok = Σ amount_nok_minor for the lot
adj_per_unit           = adjustments_total_nok / lot.quantity          (floor)
adj_residual            = adjustments_total_nok - adj_per_unit * lot.quantity
```

`adj_residual` is added to whichever disposal reduces the lot's `quantity_remaining` to exactly
zero — see §5.7's residual rule, which this mirrors. Summed over every disposal a lot will ever
have, the total reproduces `adjustments_total_nok` exactly.

### 5.7 `lot_disposals`

Every reduction of `quantity_remaining` writes a row here. This is what makes
`quantity_remaining_as_of(lot, D)` computable and therefore makes portfolio history
reconstructable from canonical data.

**Shipped in M10** (`20260828120000_m10_sales_schema.sql`). `opening_id`/`trade_line_id` do **not**
exist yet — same "enum vocabulary ships ahead of the table that will produce the other values"
pattern D-038 already established for `acquisition_lots.origin`; M10 only ever writes `kind='sale'`.

| Column | Notes |
|---|---|
| `id uuid pk`, `lot_id fk`, `user_id fk` | |
| `kind` | enum `sale`, `opened`, `traded_away`, `write_off`, `correction` |
| `quantity int` | |
| `disposed_on date` | |
| `sale_line_id fk nullable` | Required (and unique) exactly when `kind = 'sale'`. `opening_id`/`trade_line_id` arrive with M16/M18. |
| `cost_basis_at_disposal_nok_minor nullable` | Frozen copy for non-sale disposals — a sale disposal's frozen basis lives on `sale_lines.cost_basis_at_sale_nok_minor` instead (which `sale_line_id` already points at), so this stays `NULL` for `kind='sale'` rows |
| `created_at`, `voided_at nullable` | |

> **Invariant D1:** `lot.quantity_remaining = lot.quantity − Σ non-voided disposals`.
> Enforced by an `AFTER INSERT OR UPDATE OF voided_at` trigger (`recompute_lot_quantity_remaining`,
> SECURITY DEFINER — D-060) and asserted by a consistency test.

**The residual-consumption rule (D-060).** A partial disposal of a lot with
`cost_basis_state = 'known'` freezes its share of the lot's exact basis as:

```
exhausts = (lot.quantity_remaining_before_this_disposal − quantity) = 0
basis     = (lot.unit_cost_basis_nok_minor + adj_per_unit) × quantity
            + (lot.residual_nok_minor + adj_residual)      -- only if exhausts
```

(`adj_per_unit`/`adj_residual` are §5.6's adjustment-division terms — both zero when the lot has no
adjustments.) A lot's `quantity_remaining` decreases monotonically and reaches zero at most once per
"lifetime" — voiding the exhausting disposal restores it above zero, making a second zero-crossing a
distinct later event, never a double credit — so summing `basis` over every disposal a lot will
ever have reproduces its exact original cost basis: no minor unit lost, none duplicated,
deterministic regardless of sale order. Full derivation:
`supabase/migrations/20260828120010_m10_sales_rpc.sql`.

### 5.8 `openings` — implemented shape (M16, 20260902120000/10)

The implemented schema deliberately deviates from the pre-implementation sketch below in four
recorded ways (single source lot; `quantity_opened`; row-field reconciliation provenance instead
of audit_events; RPC-only writers with named refusals). THIS table is canonical:

| Column | Notes |
|---|---|
| `id uuid pk`, `user_id uuid not null fk ON DELETE CASCADE` | |
| `opened_on date not null` | business date; backdating supported |
| `source_lot_id uuid NOT NULL fk acquisition_lots` | **ONE** source sealed acquisition lot per opening (D-087). Multi-lot consumption = two openings today; widening later drops one unique index without touching stored rows. |
| `sealed_product_id uuid NOT NULL fk` | denormalized identity from the lot's holding; trigger-reasserted |
| `quantity_opened int not null > 0` | replaces the sketch's informational `pack_count`: the consumed unit count is the load-bearing fact (disposal, cost share, History) |
| `cost_source opening_cost_source` | enum `from_lot`, `unknown` |
| `cost_nok_minor bigint NULL` | NULL iff `unknown`; a known cost of exactly ZERO is legitimate data — unknown must never become fake zero (CHECK `openings_cost_shape`) |
| `tracking_completeness opening_tracking` | enum `all_cards` (default), `selected_pulls`, `unknown` — drives the incompleteness marker (F8); never inferred from pull count |
| `bulk_remainder_estimate_nok_minor bigint NULL ≥ 0`, `bulk_remainder_count int NULL > 0` | both-or-neither (CHECK) |
| `provisional_purchase_id uuid NULL fk purchases` | the auto-created buy-and-open purchase; retained after reconciliation as the historical pointer |
| `reconciled_at timestamptz NULL`, `reconciled_to_purchase_id uuid NULL fk` | reconciliation provenance ON THE ROW — set together, once (CHECK `openings_reconciliation_shape`). **No audit_events exists and none was created.** |
| `idempotency_key uuid NOT NULL default gen_random_uuid()` | server-enforced submission identity (D-089); unique per `(user_id, idempotency_key)` |
| `notes`, `created_at`, `voided_at nullable` | |

Linkage columns elsewhere:

- `lot_disposals.opening_id` + CHECK `(kind='opened') = (opening_id IS NOT NULL)` +
  unique live-per-opening partial index (`lot_disposals_one_live_per_opening`) — the consumption
  record; reconcile retires and rewrites it inside one transaction.
- `acquisition_lots.opening_id` + forward CHECK (`opening_id ⇒ origin='opening'`) — pulled-card
  attribution; a sold pull keeps its opening forever.

RLS: owner-SELECT only; every write goes through SECURITY DEFINER RPCs
(`create_opening`, `create_opening_from_provisional`, `void_opening`,
`reconcile_opening_cost`) whose bodies verify ownership of EVERY caller-supplied id explicitly.
Reads: `get_opening(p_opening_id)` (INVOKER, bounded §5.3 result components, money as text) and
`list_opening_sources(p_holding_id?)` (INVOKER, openable lots with ALREADY-DERIVED preview
components — effective unit basis and exhaustion residual matching the writer's freezing rule
exactly, so no client re-implements the arithmetic).

**Lock order / concurrency (§24 review).** Writers lock exactly ONE acquisition lot
(`SELECT … FOR UPDATE`) before re-checking `quantity_remaining` against the live row:
`create_opening` (source lot), `reconcile_opening_cost` (real target lot, after the opening row's
own FOR UPDATE lock), `void_opening`/`void_acquisition_lot`/`create_sale`/
`reduce_holding_quantity`/`remove_holdings_from_portfolio` all follow the established
ascending-lot discipline. Single-lot locking cannot participate in a cycle with an ascending
multi-lot order (a cycle needs each party to hold what the other wants next; a single lock is
acquired once and never interleaved), so no new deadlock class is introduced; genuine overlap
serializes on the row lock and the loser fails its live re-check. Behavioural burst oracles
cover this in tests; no pg_locks transcript is claimed.

Pulls are not a separate table. A pull **is** an `acquisition_lot` with `origin = 'opening'`
and `opening_id` set. This is why a sold pull remains attributable to its opening forever.
Manual-card pulls are ordinary pulls over `manual_card_definitions` rows; the wizard resolves
identities at submission time (cached per identity so retries never duplicate definitions), and
an abandoned definition is safe reusable metadata containing NO fabricated financial fact —
the opening/pulls transaction itself stays fully atomic (D-090 companion note).

#### 5.8.1 Provisional purchase for an unlinked opening

Money spent on a product the user never entered as a purchase must still reach the ledger, or
lifetime spending systematically understates reality. Rather than inventing an opening-local
cost concept that no other query knows about, the opening creates a **real purchase**:

```
purchase(origin='provisional_opening')
  └── purchase_line(line_type='sealed', spend_class='collectible',
                    line_total = EXACT entered total; unit_price = floor(total/qty))
        └── acquisition_lot(unit_cost_basis_nok=floor(total/qty),
                            residual_nok=total − floor×qty)   ← immediately consumed
              └── lot_disposal(kind='opened') ──> opening
```

It behaves as an ordinary purchase everywhere: `GPO`, `CS`, monthly spend, retailer statistics.
The opening gets a normal `cost_source = 'from_lot'`. No aggregate needs a special case. The
line-level largest-remainder tolerance is enforced by the REPLACED
`purchase_lines_line_total_matches_unit_price` CHECK (excess < quantity, D-090); the lot residual
carries the difference so consumption reproduces the entered total to the øre.

**Reconciliation.** When the real receipt is entered, the user links it. In one transaction the
provisional consumption is retired (restoring the provisional lot via D1), a new consumption
freezes the real lot's exact share, the opening repoints at the real lot, provenance is stamped
on the opening row itself (`reconciled_at`, `reconciled_to_purchase_id` — there is NO
audit_events table), and the provisional purchase is voided. F12 holds at every instant inside
the single commit; a second reconcile is refused by name.

Reconciliation is explicit, never automatic. Fuzzy-matching an opening against a similar-looking
purchase would silently corrupt the ledger in exactly the cases where the user cannot easily
check; asking costs one tap.

### 5.8.2 `trades` and `trade_lines`

Schema now, workflow in V1. Present so that a traded-away card is a first-class disposal rather
than an unrepresentable state.

| `trades` | `id uuid pk`, `user_id fk`, `traded_on date`, `counterparty text nullable`, `cash_paid_minor`, `cash_received_minor`, `currency`, `fx_rate_to_nok`, `*_nok_minor`, `notes`, `created_at`, `voided_at nullable` |
|---|---|
| `trade_lines` | `id uuid pk`, `trade_id fk`, `user_id fk`, `direction` enum `out`/`in`, `lot_id fk nullable` (outgoing), `holding_id fk nullable` (incoming target), `quantity`, `market_value_at_trade_nok_minor nullable`, `notes` |

Outgoing lines write a `lot_disposal(kind='traded_away', trade_line_id=…)` carrying
`cost_basis_at_disposal_nok_minor`. Incoming lines create lots with `origin = 'trade_in'` and
`cost_basis_state = 'trade_in'`.

Cash legs are ordinary money: `cash_paid` is collectible spend, `cash_received` is proceeds. The
item legs produce no realized result while the item-leg rule is undecided (F13). Market values at
trade date are captured on the line because they are unrecoverable afterwards.

### 5.9 `lot_transfers`

Records a lot moving between holdings without a purchase or sale — the grading path
(raw holding → graded holding) and identity corrections.

| Column | Notes |
|---|---|
| `id uuid pk`, `user_id fk`, `lot_id fk` | |
| `from_holding_id fk`, `to_holding_id fk` | |
| `reason` | enum `graded`, `identity_correction`, `condition_correction`, `other` |
| `occurred_on date`, `note`, `created_at` | |

Cost basis travels with the lot untouched. This is how a graded card keeps the 500 NOK it
originally cost while gaining 550 NOK of adjustments.

### 5.10 `grading_submissions`, `grading_submission_lines`

| `grading_submissions` | `id`, `user_id`, `grader`, `submitted_on`, `returned_on nullable`, `service_level`, `notes` |
|---|---|
| `grading_submission_lines` | `id`, `submission_id`, `lot_id`, `raw_value_at_submission_nok_minor nullable`, `resulting_grade nullable`, `cert_number nullable` |

`raw_value_at_submission_nok_minor` is captured at submission time even though grading
profitability analysis ships in V1 — the number is unrecoverable afterwards.

### 5.11 `sales`, `sale_lines`

**Shipped in M10** (`20260828120000_m10_sales_schema.sql`). One row per real sale/order/
transaction, never one per physical card sold together — `sale_lines` is what carries per-lot
granularity (§9 in the M10 prompt; a physically identical pair of cards sold together from two
different lots is two lines).

**`sales`**: `id`, `user_id`, `sold_on date`, `marketplace text nullable`, `currency`,
`gross_minor`, `fees_minor`, `shipping_cost_minor`, `shipping_charged_minor`,
`net_proceeds_minor`, `fx_rate_to_nok`, `fx_rate_date`, `fx_source`, `net_proceeds_nok_minor`,
`realized_result_nok_minor nullable`, `proceeds_from_uncosted_nok_minor`, `notes`,
`idempotency_key uuid`, `created_at`, `updated_at`, `voided_at`.

`realized_result_nok_minor`/`proceeds_from_uncosted_nok_minor` are materialized sums over the
sale's own lines (written by `create_sale`/`update_sale`/`void_sale`, never independently
computed by a reader) — they exist so History's list view and the result-sort gate (never ranking
an unknown-basis sale as +/-infinity) never need to fetch every `sale_lines` row per row shown.
`realized_result_nok_minor` is `NULL` exactly when *no* line in the sale has a known cost basis.
`idempotency_key` (unique per user) makes a retried `create_sale` call return the original sale
rather than creating a duplicate.

**`sale_lines`**: `id`, `sale_id`, `user_id`, `lot_id fk`, `quantity`, `unit_gross_minor`,
`line_gross_minor`, `allocated_fees_minor`, `allocated_shipping_minor`,
**`allocated_shipping_charged_minor`**, `net_proceeds_minor`, `net_proceeds_nok_minor`,
**`cost_basis_at_sale_nok_minor nullable`**, `realized_result_nok_minor nullable`.

`allocated_shipping_charged_minor` is a real correction to this table's original sketch (D-060) —
buyer-paid shipping needs its own auditable per-line allocation, distinct from outbound shipping
cost, exactly as FINANCIAL_MODEL.md §4.5 requires; folding it into `allocated_shipping_minor` would
make the two indistinguishable on an audited line.

`cost_basis_at_sale_nok_minor` is a deliberate frozen copy: realized history must not change
when a lot is later edited. `NULL` propagates from a `NULL` lot cost basis and makes
`realized_result` `NULL` too — the sale then contributes to `PUD`, not `RRC`. See §5.7 for the
exact residual-consumption rule this freeze uses for a partial disposal (D-060).

**Write surface.** `create_sale`/`update_sale`/`void_sale` are **SECURITY DEFINER** (D-060) —
`authenticated` holds `SELECT` only on all three M10 tables, no `INSERT`/`UPDATE` grant at all.
Every write happens inside those three functions, which derive the caller from `auth.uid()` and
filter every statement by `user_id` explicitly, the same discipline every SECURITY INVOKER RPC in
this project already has. This is what makes the frozen/derived columns genuinely unforgeable by a
direct write, not merely policed by a CHECK constraint — see D-060 for the full reasoning and why
this is a deliberate, documented exception to the SECURITY INVOKER default (SECURITY.md §5.9).

### 5.12 `manual_valuations`

**Shipped in M6** (D-038), pulled forward from its originally-planned M11 arrival because the M6
gate requires a directly-owned graded card to carry a manual value in MVP. Only this entry table
ships now — the valuation *resolver* (manual → fresh → stale → missing, FINANCIAL_MODEL.md §6) and
every provider-price table remain M9's/M11's, exactly as originally sequenced, because M6 has no
other price source for a resolver to fall back to.

| Column | Notes |
|---|---|
| `id uuid pk`, `user_id fk`, `holding_id fk` | |
| `value_minor`, `currency`, `value_nok_minor` | Currency fixed to `'NOK'` by check constraint in M6 — no FX ingestion exists before M9, so a non-NOK value would have no honest NOK conversion to freeze. Lifted by a future migration once FX exists, not an application-layer decision. |
| `effective_from date`, `superseded_at timestamptz nullable` | History preserved; never updated in place |
| `note`, `created_at` | M6 omits a separate `created_by` column — every row's creator is already its `user_id`, and RLS already scopes it; nothing in M6 distinguishes an admin- or system-set valuation from the owner's own. |

Set/superseded through `set_manual_valuation(p_holding_id, p_value_minor, p_note, p_effective_from)`
— a small SECURITY INVOKER RPC that supersedes the current active row and inserts the new one in
one call, keeping the append-only history real without asking the client to do it in two requests.
A partial unique index (`holding_id WHERE superseded_at IS NULL`) enforces at most one active row.

Manual valuations never overwrite `price_snapshots`. The resolver simply prefers them
(FINANCIAL_MODEL §6). Both values remain inspectable in the holding detail view.

---

## 6. Derived cache

### `portfolio_snapshots` — shipped in M12 (20260830120000, D-063)

| Column | Notes |
|---|---|
| `user_id`, `snapshot_date` | Composite PK. One end-of-business-day state per user per date. |
| `market_value_nok_minor` | CMV on that date: Σ over open-as-of-date lots of `quantity_remaining_as_of × resolved as-of unit value`. Missing values excluded and counted, never zeroed (F14). |
| `attributed_value_nok_minor` | ACMV — CMV restricted to `cost_basis_state = 'known'` lots. |
| `cost_basis_nok_minor` | Historical DCB (§2.5 of FINANCIAL_MODEL.md); adjustments enter from their own `occurred_on`, floor-allocated per unit (D-068). |
| `collectible_spend_to_date_nok_minor` | Frozen-ledger CS through the date; voided purchases excluded. |
| `sales_proceeds_to_date_nok_minor` | Frozen NSP through the date; voided sales excluded. |
| `open_lot_count`, `unvalued_lot_count` | The ownership-timeline lot count and its unresolvable subset (`UHC`). Equal counts ⇒ a zero-coverage day the UI renders as a gap, never "worth nothing". |
| `computed_at` | Operational only — deliberately excluded from the full-vs-incremental equality comparison. |

This is a **cache, not a ledger**. Canonical truth is always the transaction tables.
`rebuild_portfolio_snapshots(user, from, through)` derives every field from canonical rows alone
— replaying the disposal timeline per date (never projecting current `quantity_remaining`
backward), resolving provider values as step functions with freshness measured from D, applying
the manual-interval model (D-062), and accumulating frozen-ledger cumulatives by business date.
The full-rebuild == incremental-recompute equality over every semantic column is a permanent
test gate (`tests/db/m12_dashboard_snapshots.test.ts`, TESTING.md §3).

**Rebuildability is relative to CURRENTLY RETAINED canonical facts (D-070).** M9.1 retention
(D-058) compacts `price_snapshots` older than 60 days to one observation per ISO week. When
that happens, the retained set underlying old history genuinely changes, the invalidation
trigger dirties affected owners from the oldest deleted date, and the next drain recomputes —
so an older historical CMV point may adjust ONCE to derive from the weekly facts that remain.
This is accepted cache semantics, not drift: no value is fabricated, every frozen ledger column
is untouched by compaction, and deleting the whole cache and rebuilding from scratch reproduces
exactly the post-compaction series (`tests/db/m12_retention_rebuild.test.ts`). The dashboard
discloses the resolution change in one sentence ("Older market-value history uses weekly
retained market observations").

RLS: owner-SELECT only (`portfolio_snapshots_select_own`). No INSERT/UPDATE/DELETE policy exists
and no browser write grant exists — the service-role engine is the sole writer.

**`portfolio_recompute_queue`** `(user_id PK, dirty_from, updated_at)`: written only by the M12
invalidation triggers via `enqueue_portfolio_recompute` (LEAST-coalesced). Service/internal-only:
RLS enabled, no policies, no grants to any browser role — a session can neither read another
user's dirty state nor enqueue arbitrary users. The drain is ONE PL/pgSQL transaction: each
user's failure rolls back to its own savepoint and keeps its queue row while siblings continue,
and everything successful commits together when the outer transaction ends (D-064).

**`portfolio_recompute_runs`**: one row per drain invocation (started/finished, users processed,
snapshots written, error text). Service-only observability, the shape of `price_sync_runs`; no
portfolio values, no per-user rows exposed.

Invalidation boundary matrix lives in the trigger migration's header
(`20260830120020_m12_invalidation_triggers.sql`): acquisitions/purchases/sales/disposals dirty
from their own or least(old,new) business dates; manual valuations dirty from interval
boundaries (D-062); price-snapshot writes and retention thinning dirty affected variant owners;
FX writes dirty raw-card owners from the rate date. Sealed intent, storage location, tags,
favourites and collection membership deliberately dirty NOTHING (D-061/C1, prompt §23/§44).

Scheduled maintenance (D-064, cadence revised by D-082): `m12-recompute-snapshots` cron every
minute, plus the daily `m12-daily-snapshot-sweep` and the nightly `m12-run-log-prune` (30-day
recompute run-log retention). See HANDOVER.md's deployment state for what is live.

---

## 7. System tables

### `invitations`

| Column | Notes |
|---|---|
| `id uuid pk`, `token_hash text unique` | Only `sha256(token)` is stored. The plaintext is returned once, at creation, and is not recoverable afterwards — not even by an admin, because `token_hash` has no column-level SELECT grant. |
| `email text not null` | The single address this invitation authorizes an account for. Normalized `lower(btrim(...))`, matching what GoTrue does to every address it stores. Knowing the address is not authorization; the token is. Binding them means a stolen token cannot be redirected. |
| `created_by uuid fk nullable` | The admin who issued it. `NULL` means a bootstrap invitation issued through privileged database access (DEVELOPMENT.md §7). `ON DELETE SET NULL` — the record outlives its issuer. |
| `label text nullable` | The admin's own bookkeeping. Never shown to the recipient. |
| `expires_at timestamptz`, `max_uses int default 1`, `use_count int default 0` | Default expiry 7 days, settable 1 hour to 30 days. `use_count` counts *successful* redemptions; availability is computed from `invitation_claims`, not from this column. |
| `revoked_at`, `created_at` | Revoking also drops any in-flight claim. |

Reachable from a browser only as `invitation_overview`, a `security_invoker` view that carries a
derived `active` / `expired` / `revoked` / `redeemed` status and structurally has no
`token_hash` column to ask for. Direct INSERT/UPDATE/DELETE on `invitations` are not granted to
`authenticated` at all — a hand-rolled client insert could otherwise store an attacker-chosen hash.

### `invitation_redemptions`

`invitation_id`, `user_id` (unique, `ON DELETE CASCADE`), `redeemed_at`. Written only by
`finalize_invitation_redemption` under the service role. Admin-readable, because it is the record
of which invitation produced which account; that is the whole of what admin sees about another
person, and it opens nothing else.

### `invitation_claims`

The short-lived server-side authorization that makes invariant S2 enforceable without trusting
anything a client sends.

| Column | Notes |
|---|---|
| `id`, `invitation_id fk`, `email` | |
| `expires_at` | Two minutes. Long enough for one account creation, short enough that an abandoned attempt frees the invitation on its own. |
| `consumed_at`, `consumed_user_id fk` | Stamped by the `auth.users` BEFORE INSERT trigger, in the same transaction as the insert it authorizes. The FK is `DEFERRABLE INITIALLY DEFERRED` because the referenced row does not exist yet at that moment. |

A partial unique index on `(email) WHERE consumed_at IS NULL` allows at most one live claim per
address, which together with a `FOR UPDATE` lock on the invitation row is what makes double
redemption impossible rather than merely unlikely.

**RLS enabled with no policies and no grants to `anon` or `authenticated`.** Unreachable through
the Data API under every role a browser can hold. Only `service_role` and the SECURITY DEFINER
functions touch it.

### `audit_events` — PLANNED, DOES NOT EXIST YET

> **Status correction (M13 integration, 2026-08-24):** this table is *planned/future* design.
> No migration creates it — verified by enumeration across every file in `supabase/migrations/`
> during M13. The prose below is retained as the standing design intent for whichever milestone
> introduces it; it must not be read as describing a live relation. The M13 independent
> adversarial package carries a forward-compatibility tripwire
> (`FORWARD_COMPAT_TABLES`, including `audit_events`) that forces an explicit inventory
> decision if the table ever appears.

Deliberately narrow. Written only for consequential actions, not every `UPDATE`.

| Column | Notes |
|---|---|
| `id bigint pk`, `user_id`, `occurred_at` | |
| `entity_type`, `entity_id` | |
| `action` | enum `void`, `hard_delete`, `identity_correction`, `manual_valuation_set`, `lot_selection_override`, `invitation_created`, `invitation_revoked`, `user_disabled` |
| `detail jsonb` | Before/after for the changed fields only |

Standard `created_at` / `updated_at` on the main tables cover ordinary provenance. This is not
event sourcing and must not grow into it.

---

## 8. Lifecycle guarantees

The chain `purchase → sealed → opening → pulls → grading → sale` never loses provenance:

| Transition | Mechanism | What survives |
|---|---|---|
| Purchase → sealed holding | `purchase_line` → `acquisition_lot` | Purchase row is immutable history; `CS` fixed |
| Sealed → opened | `lot_disposal(kind='opened')` + `openings.source_lot_id` | Sealed lot retained with `quantity_remaining = 0`; purchase untouched |
| Opening → pulls | `acquisition_lot(origin='opening', opening_id=…)` | Every pull points at its opening forever |
| Raw → graded | `lot_transfer(reason='graded')` + `lot_cost_adjustments` | Original cost basis intact; grading costs attributed separately |
| Opening → provisional purchase | `purchase(origin='provisional_opening')` → lot → immediate `opened` disposal | Money reaches the ledger once; reconciling voids the provisional rather than deleting it |
| Anything → sold | `sale_line` + `lot_disposal(kind='sale')` | `cost_basis_at_sale` frozen; `opening_id` still readable on the lot |
| Anything → traded away | `trade_line(direction='out')` + `lot_disposal(kind='traded_away')` | `cost_basis_at_disposal` and market value at trade date both frozen |

**Prohibited implementation:** opening a product by deleting the sealed row and inserting
unrelated card rows. That destroys `CS`, breaks opening ROI and orphans the purchase.

---

## 9. Deletion and correction semantics

Three distinct operations, chosen per entity rather than improvised per page:

| Operation | Meaning | Availability |
|---|---|---|
| **Void** | Row retained, excluded from every calculation, `voided_at` set, `audit_event` written | Default for purchases, sales, openings, lots |
| **Hard delete** | Row removed | Only when no non-voided downstream reference exists |
| **Correct** | Row edited in place, `audit_event` records before/after | Identity, condition, storage, notes, non-financial metadata |
| **Reduce** | A lot's `quantity` and `quantity_remaining` shrink together; no disposal row, no financial row (D-072) | Non-purchase, non-partially-disposed live lots of a holding with more than one unit left (`reduce_holding_quantity`, P28); purchased lots route to purchase correction instead |

Guard rules:

- `reduce_holding_quantity` validates every requested lot under sibling-lot row locks before the
  first write and refuses: foreign or unknown lot ids (indistinguishably — no existence oracle),
  purchased lots, partially-disposed lots, removals exceeding a lot's remaining quantity, and any
  request that would leave a lot or the holding at zero copies (D-072).

- A purchase cannot be voided while any lot from it has a non-voided disposal. The user must
  void the sale or opening first. The error names the blocking record.
- Voiding an opening restores the source lot's `quantity_remaining` and voids the pull lots.
  Blocked if any pull has been sold.
- Voiding a sale restores `quantity_remaining` on each referenced lot.
- Correcting a card's identity re-points `holdings.card_variant_id`. Lots, costs and disposals
  are untouched; only the catalog reference and therefore the valuation source change.
- Voiding a trade restores outgoing lot quantities and voids incoming lots. Blocked if an
  incoming lot has since been sold.
- Reconciling an opening voids its provisional purchase. This is the one case where a purchase is
  voided automatically, and it is audited.
- Deleting a `custom_collection` removes membership rows only. No holding is affected (C1).
- Deleting a user's account cascades all user-private data and leaves catalog and market data
  intact.
- **Full reset** (`reset_my_portfolio_data()`, P43, D-084) is the one deliberate, owner-invoked
  hard deletion of a user's entire tracking dataset: holdings, acquisition lots,
  purchases/purchase_lines, sales/sale_lines, lot_disposals, lot_cost_adjustments,
  manual_valuations, custom_collection_members and holding_tags (membership only — collection
  and tag definitions survive), portfolio_snapshots and the recompute queue. One SECURITY
  DEFINER call = one transaction; FK-deterministic child-first order with the queue row locked
  first so no concurrent drain can resurrect stale derived state. Preserves the account,
  profile/settings and reusable setup metadata (retailers, storage locations, tags, collection
  definitions, manual card definitions, the user's own sealed products). Nothing is re-created
  afterward: an empty account is genuinely empty — no fabricated zero-valued rows. Future
  user-owned tables (grading submissions M17, openings M16, trade lines M18) extend the same
  function in the same position of the deletion order.

---

## 10. Indexing

Beyond primary and foreign keys:

| Index | Purpose |
|---|---|
| `holdings (user_id, holding_kind) WHERE deleted_at IS NULL` | Collection list |
| `acquisition_lots (user_id, acquired_on)` | Timeline reconstruction |
| `acquisition_lots (holding_id) WHERE quantity_remaining > 0` | Open-lot rollups |
| `acquisition_lots (opening_id) WHERE opening_id IS NOT NULL` | Opening return |
| `purchase_lines (user_id, spend_class)` | `CS` / `HS` aggregates |
| `purchases (user_id, purchased_on DESC)` | Ledger and monthly spend |
| `price_snapshots (card_variant_id, snapshot_date DESC)` | Latest-price resolution |
| `price_snapshots (snapshot_date)` | Retention thinning |
| `cards` trigram on `name`, plus `(set_id, local_id)`, `local_id`, `language` | Card search |
| `card_sets` trigram on `name` | Set-name search |
| `portfolio_snapshots (user_id, snapshot_date)` | Chart range queries |
| `custom_collection_members (collection_id, sort_order)` | Collection browsing |
| `custom_collection_members (holding_id)` | "Which collections is this card in" |
| `holdings (user_id, storage_location_id)` | Location filter |
| `lot_disposals (user_id, disposed_on DESC)` | History view |

### 10.1 Scale target

The requirement that every physical card is individually trackable — energies, commons,
duplicates — moves the working assumption from thousands of holdings to potentially **10 000+
lots per user**. Consequences already designed for:

| Concern | Response |
|---|---|
| Price history | Per variant, not per copy (§4.2). Decoupled from collection size. |
| Collection list | Server-side pagination with keyset cursors, plus client virtualisation. Never a full fetch. **Shipped in M7**: `list_portfolio(...)` (SECURITY.md §3.2.1) is the one query the Portfolio grid/list/table views call, keyset-paginated (never `OFFSET`) and virtualised client-side with TanStack Virtual. |
| Card images | Lazy-loaded, sized to the grid density, from the provider CDN. A 4-per-row grid must not issue thousands of image requests on mount. |
| Portfolio aggregation | Read from `portfolio_snapshots`, not recomputed per page load — once that table exists (M12). Until then, `portfolio_counts()` is one cheap aggregate query, not a per-row client sum. |
| Counts | `physical_card_count` = Σ `quantity_remaining`; `unique_holding_count` = distinct open holdings. Both are single aggregate queries (`portfolio_counts()`, M7) and both are displayed. |
| Export | **Shipped in M13** (D-074): every section is fetched in bounded `.order(pk).range()` pages of 500 under stable ordering, with one exact COUNT per section up front, cross-page duplicate detection over each section's primary key and exact received-vs-expected reconciliation — offset-with-reconciliation (never labelled keyset), failing loudly rather than writing an incomplete backup. Implementation: `src/domain/export/` (pure) + `src/data/export/` (fetch). `lot_cost_adjustments` reaches exports via plain SELECT despite having no write RPC yet (its read authority is the point; the write path is M17's). |
| Grouped display | The default list groups by holding, so 80 identical energies are one row with quantity 80 — a display concern, not a storage one. |

---

## 11. Open modelling questions

Recorded rather than guessed. None block MVP.

| Question | Current stance |
|---|---|
| Cross-language card equivalence | Deferred. Separate `card_equivalences` table if needed. |
| Trade item-leg cost basis | Schema complete; the accounting rule (carryover vs. fair value) is deliberately undecided — see [FINANCIAL_MODEL.md](FINANCIAL_MODEL.md) §11. Frozen `cost_basis_at_disposal` keeps both options open. |
| Basic Energy in the catalog | Energies are ordinary catalog cards and ordinary holdings, with no special-casing. Whether TCGdex's coverage and variant modelling of energies is adequate needs verification at catalog-ingest time. |
| Bulk remainder | An optional per-opening estimate (count + value), not a holding. It is a convenience for untracked leftovers, never a substitute for individual tracking. |
| Sealed catalog curation | How curated sealed rows get promoted from user-created ones needs a process, not just a column. |
| Grouped-row identity | The collection list groups by holding. Whether it should optionally group across conditions ("all my Pikachu #25") is a display question, not a schema one. |

---

## 12. M3 implementation notes

Recorded here because they are scoping/sequencing facts about *this* document's schema, not
product decisions — nothing here changes a term, formula or invariant, so none of it needed a
DECISIONS entry.

**Tables deferred past M3.** ROADMAP.md's M3 entry lists catalog, profiles, invitations,
holdings, lots and purchases only. Everything else arrives with the milestone that first needs
it: `lot_disposals` and `lot_cost_adjustments` (first disposal-producing milestone — M10 sales,
ahead of M16 openings in current ROADMAP order), `openings` (M16), `trades` and `lot_transfers`
(M18), `grading_submissions` (M17),
`sales`/`sale_lines` (M10),
`price_snapshots`/`sealed_price_snapshots`/`fx_rates`/`watched_card_variants` (M9),
`portfolio_snapshots` (M12), `custom_collections`/`custom_collection_members` (**shipped M7**),
`audit_events` (still deferred — see §7's status correction: no milestone has needed it yet).
`manual_card_definitions`, `holding_tags` and `manual_valuations` were **not** on this deferred
list — see the M6 notes below for the two (`lot_origin`/`cost_basis_state` values, and
`manual_valuations`) that shipped ahead of their originally-planned milestone.

**Enum vocabulary tracks table availability, with two M6 exceptions (D-038).** `lot_origin` shipped
in M3 with `purchase`, `gift`, `found`, `pre_tracking`, `other` only; M6 added `opening` and
`trade_in` by `ALTER TYPE ... ADD VALUE` *without* the `opening_id`/`trade_line_id` columns those
origins will eventually need on `acquisition_lots` — those still arrive with `openings` (M16) and
`trades` (M18). Likewise `cost_basis_state` shipped with `known`, `not_paid`, `unknown`; M6 added
`unallocated_opening` and `trade_in`. D-017 (every physical card trackable) required a pulled or
traded-in card to be recordable in M6 itself, not after M16/M18 — see DECISIONS.md D-038 for the
reasoning and DATA_MODEL.md §5.5 for what a lot with no linking column yet looks like. Elsewhere in
this document, "an enum value with no supporting column to attach it to is a trap, not a
convenience" remains the default rule; D-038 is the one deliberate, documented exception to it.

## 13. M6 implementation notes

**Storage location relocated from `holdings` to `acquisition_lots` (D-036).** §5.2/§5.4/§5.5 above
reflect the corrected location; this note exists so a reader who remembers the earlier "one per
holding" text knows it changed and why (a shared holding cannot represent copies split across two
physical locations).

**Manual card fallback (§5.4.1, D-037)** and **`opening`/`trade_in` origins plus
`manual_valuations` pulled forward (D-038)** are both described in place above; listed here only so
this section's index of "what M6 changed relative to the original plan" is complete in one place.

**`add_card_acquisition`, `set_manual_valuation`, `void_acquisition_lot`** are the three new
SECURITY INVOKER RPCs (`supabase/migrations/20260821120050_m6_add_card_acquisition.sql`).
`add_card_acquisition` is the one non-trivial one: it finds-or-creates the identity-matching
holding (racing INSERTs resolved by catching `unique_violation` against `holdings_identity` and
re-reading, rather than an application-level lock) and writes one acquisition lot — and, when the
cost is known, the ordinary single-line purchase it traces to — inside one function call, which is
already one transaction. See SECURITY.md §5.9 for the privilege reasoning and TESTING.md for the
cross-tenant attack cases this RPC's argument surface (storage location, manual card) is tested
against.

**`holding_summaries`** (`supabase/migrations/20260821120060_m6_holding_summaries_view.sql`) is a
`security_invoker = true` view aggregating open quantity per holding and joining the display facts
the Collection list needs — one query, not one query per row (§10.1's scale concern, now real).

**`acquisition_lots` has no `opening_id`, `trade_line_id`, `sale_line_id` or `lot_disposals` link
in M3**, for the same reason. `quantity_remaining` is constrained to
`0 <= quantity_remaining <= quantity` only; the D1 invariant trigger
(`quantity_remaining = quantity − Σ non-voided disposals`) arrives with `lot_disposals`, since
there is no disposal path yet that could violate it.

**`purchase_lines.target_lot_id` (grading fee attribution) is deferred to M17**, alongside
`lot_cost_adjustments` — it has no purpose until a grading workflow can write to it.

**`profiles.preferred_price_kind` is deferred to M9**, alongside the `price_kind` enum it is
typed against.

**`card_variants.size`** — this document names the column but not its members. Implemented as
`card_size` enum: `standard`, `oversized` (covers jumbo/oversized promos; extend by migration if
a TCGdex-observed size doesn't fit either).

**S2 shipped in M4 and the boundary this note described is closed.** The public
`/auth/v1/signup` endpoint is now answered by the Before User Created hook, and `auth.users`
carries a BEFORE INSERT trigger demanding a live invitation claim. `[auth] enable_signup` remains
at the platform default and is still not part of the enforcement chain, for the reason M3 found
empirically: disabling it disables the email/password *login* grant for every existing user, not
only new self-registration. See SECURITY.md §5.

The M3 concern that the trigger would block the authorization suite's synthetic users turned out to
be right, and is handled rather than avoided: the fixture now takes the same privileged route the
redemption function takes — issue, claim, create, finalize. That is a better fixture than the old
one, because it exercises the real path instead of stepping around it.

**`holdings_identity`'s enum-to-text casts need IMMUTABLE wrapper functions.** Postgres marks an
enum type's built-in `::text` cast `STABLE`, not `IMMUTABLE` (labels can in principle be renamed),
so the literal `condition::text` / `grader::text` shown in §5.4 cannot appear directly in an index
expression — confirmed by CI actually failing to apply the migration on first attempt, not
predicted in advance. `card_condition_to_text()` and `grader_to_text()` in the same migration are
thin `IMMUTABLE`-marked wrappers that exist solely to make the index possible; this project does
not rename these enums' labels, only adds new ones by migration, so the promise they make is safe.

**M4 corrections to this schema.** Two, both found by an adversarial review rather than by a test
failure. Every `user_id` foreign key to `auth.users` had no `ON DELETE` action, so account
deletion — which SECURITY.md §8 describes as a cascade — was impossible for any user owning a single
row; all eight now cascade. And `invitations` allowed an admin to read `token_hash` through the
Data API, which the column-level grant now prevents.

## 14. M7 implementation notes

**`custom_collections`/`custom_collection_members` shipped exactly as §5.2.1 originally specified**
— the column *shape* needed no correction, unlike M5/M6's catalog/holdings fixes. One real bug
did surface, caught by CI rather than by inspection: `custom_collection_members.user_id` was
missing `default auth.uid()` (present on `custom_collections`/`manual_card_definitions`), which
made a real authenticated-client insert fail RLS rather than succeed. Fixed before merge —
PROJECT_JOURNAL.md 2026-08-22.

**`list_portfolio(...)` and `portfolio_counts()`** (`supabase/migrations/20260822120010_m7_portfolio_query.sql`,
performance-corrected by `20260822120030`/`20260822120040`) are the Portfolio's entire server-side
query surface: sort (an enum, `portfolio_sort_order`), every quick/full filter, and keyset
pagination in one `SECURITY INVOKER` function each. Neither reads from a view — both query
`holdings`/`acquisition_lots`/`card_variants`/`cards`/`card_sets`/`manual_card_definitions`/
`manual_valuations` directly, because the filter joins and keyset cursor this milestone needs do
not fit `holding_summaries` (M6) cleanly. `holding_summaries` itself is unchanged and still backs
the holding detail page's single-row read. Both aggregate a holding's lot data via a
`MATERIALIZED` CTE doing a plain `LEFT JOIN ... GROUP BY` — the same shape `holding_summaries`
itself uses — rather than a per-holding `LATERAL` subquery, which real 10,000-lot measurement
against `pokeportfolio-dev` found to be 10-40× slower (DECISIONS.md's performance-correction note,
PROJECT_JOURNAL.md 2026-08-22). Any future query over `holdings`/`acquisition_lots` needing a
per-row aggregate should follow this GROUP BY shape from the start, not rediscover the difference.

**Value before M9 (D-041).** `list_portfolio`'s notion of "value" is exactly one real, honest
number: a graded holding's active `manual_valuations` row. Every raw-card holding is genuinely
`NULL` and falls into a second, deterministically-ordered (by name) bucket — never a fabricated
figure, never the acquisition cost standing in for market value. The keyset cursor for
`value_desc`/`value_asc` carries `(value, has_value, name, holding_id)` and the SQL branches
explicitly on which bucket the cursor's row was in.

**`profiles.collection_default_sort`** (new enum `portfolio_sort_order`, default `value_desc`)
joins `collection_grid_density`/`collection_default_view` as the third Portfolio display
preference. All three are read by the client and can be overridden per-request via URL search
params (`src/router.tsx`'s `PortfolioSearch`) without changing the stored default.

**Money serialization boundary.** `bigint` minor-unit columns are exact in Postgres, but
PostgREST serializes `bigint` as a plain JSON number by default, and JSON/JS numbers only carry
exact integer precision up to `Number.MAX_SAFE_INTEGER` (2^53 − 1). Every query that selects a
money column must cast it to text in the select list (e.g. `total_minor::text`) and parse the
result with `BigInt()` — see `src/data/money.ts` and the proof in
`tests/db/money-boundary.test.ts`, which inserts a value one above that threshold and shows the
cast path stays exact while the uncast path does not. Not a practical risk at this app's actual
scale (collection values are nowhere near 2^53 øre), but the boundary is real and now tested
rather than assumed.

## 15. M7.1 implementation notes

**`portfolio_sort_order` gained `number_asc`/`number_desc`** (owner request — card-number sort
was the one obviously-missing mode, M7.1 prompt §41/§72). Backed by `natural_sort_key(text)`, a
new `IMMUTABLE SQL` function that splits a collector-number string into alternating digit/non-digit
runs and zero-pads the digit runs, giving "4" < "9" < "10" < "H31" ordering instead of a plain
string sort's "10" < "4" < "9" < "H31". Applies to `coalesce(card.local_id, manual_card.collector_number, '')`
— real data already on the row, never a fabricated ranking key. `list_portfolio`'s signature grew
one trailing cursor parameter (`p_cursor_number_key text`) and its return type grew one column
(`number_sort_key text`) for exactly this sort's keyset cursor — the function was dropped and
recreated rather than `CREATE OR REPLACE`d, because adding a parameter changes a function's
identity in Postgres (name + argument types), and `CREATE OR REPLACE` with a different signature
creates a second overload instead of replacing the first.

**Two new `profiles` columns**, both described in §5.1 above: `hide_values` (display-only
value-privacy preference) and `use_eu_pricing` (stored ahead of M9, D-044).

**`custom_collection_members` gained bulk read/write helpers at the client layer only** — no new
RPC or schema change. Portfolio's select-mode bulk actions (`src/data/customCollections.ts`'s
`addHoldingsToCollection`/`removeHoldingsFromCollection`, `src/data/collection.ts`'s
`bulkSetFavorite`) are plain multi-row `INSERT .. ON CONFLICT DO NOTHING`/`DELETE .. IN (...)`/
`UPDATE .. IN (...)` statements under the same RLS policies §5.2.1 already specifies — invariant
C1 (nothing financial changes) applies exactly as it does to the single-holding versions.

## 16. M8 implementation notes

**No new tables for `purchases`/`purchase_lines`/`acquisition_lots`/`holdings`** — M8 extends the
existing M3/M6 schema with a real multi-line write path over the same tables, exactly as §5.3
already anticipated ("M8 adds the ability to build a richer multi-line purchase over the same
tables; it does not introduce a different *kind* of purchase"). Two new CHECK constraints state
invariants the RPC layer already had to keep: `purchases_total_nok_matches_rate`
(`total_nok_minor = round(total_minor * fx_rate_to_nok)`) and
`purchase_lines_attributable_cost_matches_allocation` (`attributable_cost_minor = line_total_minor +
allocated_shipping_minor + allocated_customs_minor - allocated_discount_minor`) — both validated
cleanly against every row M6's `add_card_acquisition` had ever written, including real purchases on
the deployed project, since that RPC's shipping/customs/discount are always zero.

**`fx_rates`** (new table, §4.3 already specified its shape): market-data class, `SELECT` for
`authenticated`, writes only from the `fetch-fx-rate` Edge Function under the service role. A user's
manual FX override is never written here — it lives entirely on their own `purchases` row
(`fx_source = 'manual'`) — so no session can poison another user's automatic resolution or the
shared cache (SECURITY.md §5.9's "no browser-reachable write" pattern, applied to market data).

**The write surface**: `create_purchase`, `update_purchase` (D-047's scope: cannot add/remove
lines), `void_purchase` (whole-receipt void with downstream-blocker detection), and
`purchase_spending_summary()` (`GPO`/`CS`/`HS`/purchase count in one query). All `SECURITY INVOKER`,
same reasoning as `add_card_acquisition`: `authenticated` already holds the underlying table
grants, ownership derives entirely from `auth.uid()`, and RLS applies to every statement exactly as
if the caller had issued it directly. `allocate_largest_remainder(bigint, bigint[])` is a SQL port
of the M2 TypeScript allocator (`src/domain/allocation.ts`) that both RPCs call — proven
byte-identical to the TypeScript reference across a shared corpus of cases
(`tests/db/m8_purchase_ledger.test.ts`), including for the frozen NOK total itself: rather than
rounding each line's NOK amount independently (which can drift a few øre from a single rounding of
the purchase total), the total is allocated across lines the same largest-remainder way, weighted by
each line's original-currency attributable cost. This is what keeps invariant F1 (`GPO = CS + HS`)
exact for a foreign-currency purchase, not merely a NOK one.

**`void_acquisition_lot` corrected** (M8 prompt §62): its auto-void-parent-purchase check now looks
for another live lot anywhere in the whole parent purchase, not only lots citing the same
`purchase_line`. The old check was correct only because every M6-created purchase has exactly one
line; a multi-line M8 purchase would otherwise have its entire receipt voided the moment the last
lot from any *one* of its several lines was individually voided. A strict generalization — the two
checks agree exactly for a single-line purchase — so this is a correction for every purchase that
already exists, not a behaviour change.

**Two pre-existing gaps found and fixed, both previously unexercised** (same defect class as M4/M6/
M7's `user_id`-default and PUBLIC-EXECUTE findings — see PROJECT_JOURNAL.md 2026-08-24):
`retailers.user_id` had no `default auth.uid()` since M3 (unlike `storage_locations`/`tags`, fixed
for the same reason in M6) — nothing created a retailer directly from the client before M8.
`purchases.retailer_id` had no ownership-check trigger at all — nothing set a non-null `retailer_id`
from client-supplied input before M8's `create_purchase`/`update_purchase`. Both fixed with a
dedicated migration each, following the established `*_check_owner()` trigger pattern.

**Card/sealed lines always produce a holding and lot (D-048)** — no optional "skip inventory"
checkbox; `bulk_lot` is the existing line type for money spent on a group before individual entry.
**An edit cannot add or remove lines (D-047)** — voiding and re-entering is the correction path for
a wrong line set, as it already was for a bigger mistake (UX_FLOWS.md). **Grading-fee/shipping lines
record spend only in M8 (D-050)** — `target_lot_id`/`lot_cost_adjustments` remain M17's, per §12's
existing deferred-table list, unchanged by anything found while building M8.

**Known precision limitation, disclosed rather than silently accepted:** a foreign-currency `card`
line's *lot-level* per-unit NOK cost basis (`acquisition_lots.unit_cost_basis_nok_minor`, used only
for `DCB`/per-item display) is computed by floor division of the line's already-exact
`attributable_cost_nok_minor` by quantity, with no separate NOK residual column — `residual_minor`
exists only in the lot's original currency. For a multi-quantity foreign-currency card line this can
leave the lot's own NOK unit-cost total up to one øre short of the line's exact NOK amount, which
remains authoritative for `GPO`/`CS`/`HS` (computed from `purchase_lines`, not from lots) and is
therefore never visible in any invariant this milestone's tests assert. Narrow enough (multi-quantity
+ non-NOK + card line, simultaneously) that adding a second residual column was not judged worth the
schema churn; revisit if a real receipt exercises it.

## 17. M9 implementation notes

**`resolve_variant_market_values(p_card_variant_ids uuid[])`** is the one reusable, set-oriented
resolver (`20260826120020_m9_valuation_resolver.sql`) implementing FINANCIAL_MODEL.md §6: fresh →
stale → missing over the provider data, honouring `profiles.use_eu_pricing` (D-052). It does *not*
apply the manual-valuation override itself — that is per-holding, not per-variant, and every caller
(`list_portfolio`, `portfolio_counts`, `get_holding_value_provenance`, `get_market_movers`) applies
"an active `manual_valuations` row always wins" on top of this function's output. Called exactly
once per query with the full array of `card_variant_id`s that query needs — never in a per-row
`LATERAL` (D-054 records the M7.1 regression this milestone also fixed while rewriting
`list_portfolio`'s body regardless).

**F10 (raw prices never value graded cards)** is enforced by every caller explicitly checking
`holding_kind = 'raw_card'` before using the resolver's output for a given holding — a graded
holding's `card_variant_id` still points at the same real printing (grading does not change
identity), so the resolver itself will happily return a value for it; the exclusion is the caller's
job, not something baked into the resolver.

**`get_holding_value_provenance(p_holding_id uuid)`** — Holding Detail's single-row read: manual
override if active, else the resolver, with quantity and the holding-total figure (D-052) alongside
full provenance (provider, price kind, source currency/value, FX rate, snapshot date).

**`get_card_variant_price_history(p_card_variant_id uuid, p_since date)`** — real snapshots only,
one resolved (already-converted, already-preference-applied) point per day a snapshot exists. Never
interpolates, never treats `avg7`/`avg30` as historical points (D-008).

**`get_market_movers(p_period_days int, p_limit int)`** — ranks the caller's own currently-owned,
currently-priced raw-card holdings by real period-over-period price movement, using the same
provider-preference rule. A holding with no historical observation at or before the window start is
excluded, never shown as 0% movement (prompt §54). No cross-user data — scoped to `auth.uid()`
throughout, same as every other M9 RPC.

**Money-column serialization.** Every M9 function returning a money-shaped `bigint` casts it to
`text` in its final `SELECT`, per §14's existing PostgREST boundary rule — `resolve_variant_market_
values`, `get_holding_value_provenance`, `get_card_variant_price_history` and `get_market_movers`
all do this; only internal CTEs within a function body use the native `bigint`/`numeric` types for
arithmetic.

**Scheduling.** `ingest-prices`/`ingest-fx` (Edge Functions, bearer-secret-gated like `sync-catalog`)
are invoked by `pg_cron` via `pg_net`, with the bearer secret read from Supabase Vault at call time
(`20260826120050_m9_cron_schedule.sql`) — never a literal in migration SQL. `thin_price_snapshots()`
is scheduled directly as a SQL command (no HTTP round trip needed for a same-database function).
Full architecture, batch sizing and cadence reasoning: ARCHITECTURE.md and
`ai_outputs/Claude_outputs/output_15.txt`.

## 18. M9.1 implementation notes

**`get_market_movers` gained a third parameter** (`p_sort public.market_mover_sort`), which changes
its identity — `20260827120000_m91_market_movers_sort.sql` `DROP`s and re`CREATE`s it, following
the TESTING.md §6a checklist this migration's header also adds: the materialized-CTE body is a
direct extension of the M9 version, not a rewrite, specifically to avoid D-054's regression class.
Adds `quantity` and `holding_impact_nok_minor` (unit change × quantity, informational only — D-056)
to the return shape.

**`search-prices` now resolves an exact NOK reference server-side**, alongside the untouched
source-currency provenance — the same `fx_rates` lookup-by-observation-date pattern
`resolve_variant_market_values`/`get_market_movers` already use, one bounded query per distinct
(currency, date) pair actually needed in the batch, never per card. `valueNokMinor` is `null` only
when no cached rate exists yet for that pair (shown as "—" client-side, never a fabricated number).

**Retention policy** (`thin_price_snapshots`): see COST_POLICY.md for the measured bytes/row and the
resulting decision on whether the 12-month daily-retention window needed to change. If it did, the
new window is documented there and in the migration that changed it, with DECISIONS.md recording
the reasoning per PLANNING_FREEZE's rule that a semantic retention change needs a decision entry.

**Display currency** (D-057): `MoneyDisplay` converts a resolved NOK amount for display only, using
a plain `select` against `fx_rates` (already `authenticated`-readable market data) and the exact
bigint reciprocal-rate helpers in `src/domain/fx.ts`. No schema change — this is a client-side
presentation concern layered on data that already existed.

## 19. M10 implementation notes

**Migration order matters here**, more than most milestones: `20260828110000` (the
`residual_nok_minor` fix) must run before `20260828115000` (`lot_cost_adjustments`) and
`20260828120000`/`20260828120010` (the sale schema/RPC) — `create_sale` reads both new columns in
its cost-basis freeze. `lot_cost_adjustments` is created before `sales`/`sale_lines` for a simpler
reason: no ordering dependency, just alphabetising the file timestamps sensibly.

**`sales`/`sale_lines`/`lot_disposals` creation order is itself constrained**: `sales` first,
`sale_lines` second (references `sales`), `lot_disposals` third (references `sale_lines`) — the
reverse of this document's own §5 reading order, not a reversal of its meaning.

**Every write to the three new tables goes through SECURITY DEFINER RPCs** (D-060) —
`authenticated` holds `SELECT` only. This is the one real architectural departure from every prior
milestone's SECURITY INVOKER default, and `scripts/grant-audit.sql` reflects it exactly: no
`expected_column_update` entries exist for `sales`/`sale_lines`/`lot_disposals` at all, because
there is nothing to grant.

**`recompute_lot_quantity_remaining`** (also SECURITY DEFINER, on `lot_disposals`) is the sole
writer of `acquisition_lots.quantity_remaining` for the disposal path — it recomputes and
overwrites the column from the live ledger every time a disposal is inserted or voided, which is
what makes invariant D1 an enforced fact rather than an RPC-discipline convention. It does not
replace `update_purchase`'s existing direct write to the same column for an *undisposed* lot's
quantity correction (unchanged since M8) — the two paths never conflict because `update_purchase`
is blocked from running once any disposal exists.

**`lot_cost_adjustments` finally exists** (D-060) — documented since M3, never created. `create_sale`
is its first real reader. No write RPC ships in M10; `authenticated` gets `SELECT` only.

**Idempotency** (`sales.idempotency_key`, unique per user): the client generates one UUID per
sale-builder session (`crypto.randomUUID()`, kept in component state so a retry reuses it) and
`create_sale` returns the original sale unchanged on replay, checked before any other validation.

**Result sorting never treats an unknown result as infinity** (prompt §100-101): achieved with
`nullsFirst: false` set explicitly in both directions of the client's `.order('realized_result_
nok_minor', ...)` call — Postgres's own default (`NULLS LAST` ascending, `NULLS FIRST` descending)
would otherwise put an unknown-basis sale first when sorting high-to-low, exactly the failure mode
the gate exists to prevent.

## 20. M12 implementation notes

**The engine, in one paragraph.** `rebuild_portfolio_snapshots(user, from, through)` deletes the
range and reinserts it from one set-oriented statement chain: a `dates × lots` grid bounded by
each lot's `acquired_on`; per-date cumulative disposal quantities (single-stream join + GROUP BY,
the D-054 shape — never correlated laterals) giving `open_lot_count` with exact acquire/sell day
boundaries; provider observations materialised as step functions `[obs_date, min(next_obs,
obs_date + 31))` so freshness age is measured from each snapshot date; FX facts resolved once
per distinct `(currency, obs_date)`; the manual-interval table (D-062); frozen-ledger CS/NSP
cumulatives as opening balance + window running sum over the date spine. Rows are only produced
from the user's first tracked date onward — no fabricated pre-history.

**Dashboard reads.** Four SECURITY INVOKER RPCs replace any burst of Home requests:
`get_dashboard_summary()` (latest-snapshot headline + current data-quality/breakdown counts +
lifetime GPO/CS/HS/NSP/RRC/PUD/NCCO/THCO/THP + an honest `pending_recompute`, one request;
TTEP and THP are NULL until a snapshot exists — §6.5 of FINANCIAL_MODEL.md — never 0-based),
`get_portfolio_history(display_currency, from, to)` (stored snapshots, coverage flags,
D-067 display conversion), `get_monthly_spend(months)` (calendar months from purchase lines;
GPO = CS + HS per row by construction), `get_recent_activity(limit)` (bounded union over
canonical purchases/sales/valuations/non-purchase acquisitions). All money leaves as text.

**Custom-collection scope is deliberately absent from history APIs** (D-065): the chart follows
Main Portfolio only; scoped CURRENT figures keep using `portfolio_counts(p_custom_collection_id)`.

**Frontend boundary.** Exact bigint minor units persist through `src/data/dashboard.ts`; the
only Number conversion happens in `src/domain/dashboard.ts#toChartSeries` via `safeMajorUnits`,
which throws rather than silently losing øre above `Number.MAX_SAFE_INTEGER`. Uncovered days
become whitespace items so the chart library breaks the line instead of interpolating across
missing coverage.

## 21. P28 implementation notes — holding-level quantity correction and removal

**`reduce_holding_quantity(p_holding_id uuid, p_lot_reductions jsonb) returns table (owned_quantity integer)`**
(`20260831120000_p28_reduce_holding_quantity.sql`) — SECURITY INVOKER, `search_path = ''`,
ownership from `auth.uid()` alone; no `user_id` parameter to forge. The payload is an array of
`{lot_id, remove_quantity}`; malformed shapes, duplicate lot ids and non-integer counts are
refused before any table access. Execution order: parse/validate → collect every live sibling
lot of `(p_holding_id, auth.uid())` ascending → take explicit per-row `FOR UPDATE` locks
(create_sale's exact convention) → validate per-lot guards on held locks → aggregate
pre-invariant → updates only after all validation → recompute the post-image total and refuse a
zero result → return. Any failure aborts with zero mutations.

**Guard chain, in order:** every requested lot must belong to the caller AND the named holding
(a forged holding id yields an empty sibling set, not another user's rows); purchased lots are
refused (`purchase_line_id IS NOT NULL`) and route to purchase correction in the UI;
partially-disposed lots are refused (`quantity_remaining <> quantity`); a removal may not exceed
a lot's remaining quantity; the per-lot floor guard refuses any request that would leave a lot at
zero copies (the pre-existing unconditional CHECK `acquisition_lots_quantity_positive` is the
backstop). Given the floor guard, the aggregate pre-invariant and post-image guard are provably
unreachable defense-in-depth — kept deliberately as a loud refusal if locking were ever to
regress silently (D-072).

**M12 interaction.** No manual queue writes: the existing `portfolio_recompute_lot_updated`
trigger covers `UPDATE OF quantity, quantity_remaining`, so an applied correction enqueues
recompute naturally with `dirty_from = acquired_on`; a refused correction enqueues nothing,
because nothing changed.

**Frontend data layer.** `src/data/collection.ts#reduceHoldingQuantity` passes the mapped array
directly (PostgREST receives jsonb, not a JSON string scalar — pinned by
`tests/data/collection-reduce-wire.test.ts`); `getHoldingLots` exposes each lot's purchase
lineage so the sheet can route purchased lots to their receipt editor.

## 22. P43 implementation notes — full reset and the unified History read surface

**`reset_my_portfolio_data() returns table (..._deleted integer)`** — SECURITY DEFINER,
`search_path = ''`, caller derived from `auth.uid()` alone, no `p_user_id` parameter to forge.
Deletion order is FK-deterministic and locks the M12 queue row FIRST: queue → lot_disposals →
sale_lines → sales → lot_cost_adjustments → manual_valuations → custom_collection_members →
holding_tags → acquisition_lots → purchase_lines → purchases → holdings → portfolio_snapshots.
The M12 invalidation triggers are INSERT/UPDATE-only, so these DELETEs enqueue nothing. Counts
of deleted rows are returned per table for the UI's honest success feedback.

**`list_history_events(p_kind text, p_include_voided boolean, p_limit int, p_before_at
timestamptz, p_before_id uuid)`** — SECURITY INVOKER, one bounded keyset-paginated UNION over
purchases, sales, non-purchase acquisitions (purchase-origin lots excluded — their receipt row is
already the event) and active manual valuations (superseded rows excluded — supersede IS their
correction lifecycle). Each event carries kind, primary id, holding id where applicable,
business date (`occurred_on`) plus recording timestamp (`recorded_at`, also the pagination key),
display title resolved through plain joins inside the same statement, an optional NOK minor-unit
amount as text, an `active`/`voided` status and a navigation target. Voided entries are excluded
unless `p_include_voided`; a kind filter narrows the feed without breaking cursor stability. No
event-sourcing table exists; Openings (M16)/Grading (M17)/Trades (M18) extend the union when
their canonical tables land.


