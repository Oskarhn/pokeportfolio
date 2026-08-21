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

| Column | Notes |
|---|---|
| `id bigint pk` | |
| `card_variant_id fk` | |
| `provider` | enum `tcgdex_cardmarket`, `tcgdex_tcgplayer`, `manual` |
| `price_kind` | enum `cm_trend`, `cm_avg30`, `cm_avg7`, `cm_avg`, `cm_low`, `tp_market`, `tp_low` |
| `source_currency` | ISO 4217 |
| `value_minor bigint` | In `source_currency` |
| `snapshot_date date` | The business date the price represents |
| `provider_updated_at timestamptz` | Provider's own freshness claim |
| `retrieved_at timestamptz` | When we fetched it |

Unique on `(card_variant_id, provider, price_kind, snapshot_date)`.
Index on `(card_variant_id, snapshot_date DESC)`.

Storing multiple `price_kind` rows per variant per day costs little and makes the fallback
chain in FINANCIAL_MODEL §6 auditable after the fact.

**`sealed_price_snapshots`** mirrors this shape keyed on `sealed_product_id`.

### 4.2 What gets snapshotted

Snapshotting all ~23 400 English variants daily would consume the Supabase free tier's 500 MB
in roughly a year for data nobody looks at.

Instead the daily job reads a view:

```sql
CREATE VIEW watched_card_variants AS
SELECT DISTINCT h.card_variant_id
FROM holdings h
JOIN acquisition_lots l ON l.holding_id = h.id
WHERE h.card_variant_id IS NOT NULL
  AND l.voided_at IS NULL
  AND l.quantity_remaining > 0;
```

Plus variants held at any point historically (so a sold card's history stays intact) and
variants on any wishlist once that exists.

**Price history is per `card_variant`, never per physical copy.** This is what makes tracking
every energy card affordable. Owning eighty Basic Grass Energy of the same printing produces
exactly one snapshot row per day, not eighty; quantity is applied at aggregation time, from
`acquisition_lots`. The snapshot table scales with *distinct printings owned*, which plateaus
quickly, not with *cards owned*, which does not.

Concretely: a 10 000-card collection realistically spans perhaps 3 000–4 000 distinct variants,
because duplicates, energies and playsets collapse. At 3 000 watched variants × 2 price kinds ×
365 days × ~48 bytes ≈ **105 MB/year**, with rows older than 12 months thinned to weekly. The
holdings and lots themselves are small — roughly 200 bytes per lot, so even 10 000 lots is ~2 MB.

> The binding constraint on the free tier is price history, and price history is decoupled from
> collection size. This was the key finding that made all-card tracking viable at zero cost.

> A variant enters the watch set the moment it is first acquired. Its price history therefore
> begins at acquisition, not before. This is a real limitation, documented in
> [RESEARCH.md](RESEARCH.md), and is preferable to fabricating pre-ownership history.

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
| Display | `theme` (`system`/`light`/`dark`), `collection_grid_density smallint default 2` (1–4), `collection_default_view` (`grid`/`list`/`table`) |
| Filtering | `low_value_threshold_minor bigint default 1000` (10 NOK), `hide_low_value_by_default bool default false` |
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
| `sealed_intent` | enum `keep_sealed`, `planned_to_open`, `undecided`; null unless `holding_kind = 'sealed'` |
| `is_favorite bool` | |
| `notes`, `created_at`, `updated_at`, `deleted_at nullable` | |

`sealed_intent` is organisational only. Changing it never alters purchase history, cost basis or
any financial figure — it exists so "what is my sealed investment worth" can be separated from
"what is queued to be opened", which are different questions about the same shelf.

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
| `residual_minor int default 0` | Largest-remainder residual so `quantity × unit + residual` = line cost exactly |
| `storage_location_id fk nullable` | Relocated here from `holdings` in M6 (D-036) — where a specific batch of copies physically sits, not a property of the holding as a whole |
| `notes`, `created_at`, `voided_at nullable` | |

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

| Column | Notes |
|---|---|
| `id uuid pk`, `lot_id fk`, `user_id fk` | |
| `kind` | enum `grading_fee`, `grading_shipping`, `restoration`, `other` |
| `purchase_line_id fk **not null**` | Enforces F7 — no cost basis increase without a real purchase |
| `amount_minor`, `currency`, `amount_nok_minor` | |
| `occurred_on date`, `note` | |

Keeping adjustments separate from `unit_cost_basis_minor` means the original acquisition price
is always visible, and grading costs can be attributed, reversed or analysed independently.

### 5.7 `lot_disposals`

Every reduction of `quantity_remaining` writes a row here. This is what makes
`quantity_remaining_as_of(lot, D)` computable and therefore makes portfolio history
reconstructable from canonical data.

| Column | Notes |
|---|---|
| `id uuid pk`, `lot_id fk`, `user_id fk` | |
| `kind` | enum `sale`, `opened`, `traded_away`, `write_off`, `correction` |
| `quantity int` | |
| `disposed_on date` | |
| `sale_line_id fk nullable`, `opening_id fk nullable`, `trade_line_id fk nullable` | |
| `cost_basis_at_disposal_nok_minor nullable` | Frozen copy for non-sale disposals, so a trade's basis survives for whichever item-leg rule is later adopted |
| `created_at`, `voided_at nullable` | |

> **Invariant D1:** `lot.quantity_remaining = lot.quantity − Σ non-voided disposals`.
> Enforced by trigger and asserted by a consistency test.

### 5.8 `openings`

| Column | Notes |
|---|---|
| `id uuid pk`, `user_id fk` | |
| `opened_on date` | |
| `sealed_product_id fk nullable`, `source_lot_id fk nullable` | Null for an unlinked opening |
| `provisional_purchase_id fk nullable` | The auto-created ledger entry, if the cost was entered manually |
| `pack_count int nullable` | |
| `cost_minor nullable`, `cost_currency`, `cost_nok_minor nullable` | |
| `cost_source` | enum `from_lot`, `unknown` |
| `tracking_completeness` | enum `all_cards`, `selected_pulls`, `unknown` — defaults to `all_cards`; drives the incompleteness marker (F8 area) |
| `bulk_remainder_estimate_minor nullable`, `bulk_remainder_count int nullable` | |
| `notes`, `created_at`, `voided_at nullable` | |

Pulls are not a separate table. A pull **is** an `acquisition_lot` with `origin = 'opening'`
and `opening_id` set. This is why a sold pull remains attributable to its opening forever.

#### 5.8.1 Provisional purchase for an unlinked opening

Money spent on a product the user never entered as a purchase must still reach the ledger, or
lifetime spending systematically understates reality. Rather than inventing an opening-local
cost concept that no other query knows about, the opening creates a **real purchase**:

```
purchase(origin='provisional_opening')
  └── purchase_line(line_type='sealed', spend_class='collectible')
        └── acquisition_lot          ← immediately consumed
              └── lot_disposal(kind='opened') ──> opening
```

It behaves as an ordinary purchase everywhere: `GPO`, `CS`, monthly spend, retailer statistics.
The opening gets a normal `cost_source = 'from_lot'`. No aggregate needs a special case.

**Reconciliation.** When the real receipt is entered, the user links it. In one transaction the
opening's `source_lot_id` repoints at the real lot, the provisional purchase is voided, and an
`audit_event` of action `opening_cost_reconciled` records both purchase ids.

```sql
-- F12: at most one non-voided cost source per opening
CREATE UNIQUE INDEX openings_one_live_cost
  ON openings (id)
  WHERE provisional_purchase_id IS NOT NULL AND source_lot_id IS NOT NULL;
```

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

**`sales`**: `id`, `user_id`, `sold_on date`, `marketplace text`, `currency`,
`gross_minor`, `fees_minor`, `shipping_cost_minor`, `shipping_charged_minor`,
`net_proceeds_minor`, `fx_rate_to_nok`, `fx_rate_date`, `fx_source`, `net_proceeds_nok_minor`,
`notes`, `created_at`, `voided_at`.

**`sale_lines`**: `id`, `sale_id`, `user_id`, `lot_id fk`, `quantity`, `unit_gross_minor`,
`allocated_fees_minor`, `allocated_shipping_minor`, `net_proceeds_minor`,
`net_proceeds_nok_minor`, **`cost_basis_at_sale_nok_minor nullable`**, `realized_result_nok_minor nullable`.

`cost_basis_at_sale_nok_minor` is a deliberate frozen copy: realized history must not change
when a lot is later edited. `NULL` propagates from a `NULL` lot cost basis and makes
`realized_result` `NULL` too — the sale then contributes to `PUD`, not `RRC`.

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

### `portfolio_snapshots`

| Column | Notes |
|---|---|
| `user_id`, `snapshot_date` | Composite PK |
| `market_value_nok_minor` | `CMV` on that date |
| `attributed_value_nok_minor`, `cost_basis_nok_minor` | For `URC` over time |
| `collectible_spend_to_date_nok_minor`, `sales_proceeds_to_date_nok_minor` | For `TTEP` over time |
| `open_lot_count`, `unvalued_lot_count` | |
| `computed_at` | |

This is a **cache, not a ledger**. Canonical truth is always the transaction tables. A
`portfolio_recompute_queue(user_id, dirty_from date)` row is written whenever a backdated
transaction is inserted, edited or voided; the daily job recomputes forward from the earliest
dirty date. A full rebuild from transactions must always produce identical output — that
equality is a test.

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

### `audit_events`

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

Guard rules:

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
| Export | Streamed/chunked, not assembled in memory. |
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
`audit_events` (first milestone with a void/hard-delete path to audit).
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
