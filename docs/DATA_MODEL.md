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
| `card_series` | `id uuid pk`, `slug`, `name` |
| `card_sets` | `id uuid pk`, `series_id fk`, `slug`, `name`, `language`, `card_count_official int`, `card_count_total int`, `released_on date`, `logo_url`, `symbol_url` |
| `cards` | `id uuid pk`, `set_id fk`, `local_id text` (collector number as printed), `name`, `rarity`, `category`, `illustrator`, `image_base_url` |
| `card_variants` | `id uuid pk`, `card_id fk`, `variant_type` enum, `size` enum, `is_active bool` |

`variant_type` enum: `normal`, `holo`, `reverse`, `first_edition`, `promo`, `stamped`, `other`.
Extensible via migration; the provider's own variant vocabulary is mapped into it at ingest.

`local_id` is text, not integer: collector numbers include `SV049`, `TG12`, `H31`, `001/165`.

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
| `card_sets` | `tcgdex_set_id` |
| `cards` | `tcgdex_card_id` |
| `card_variants` | `tcgdex_variant_id`, `cardmarket_product_id`, `tcgplayer_product_id` |
| `sealed_products` | `cardmarket_product_id`, `tcgplayer_product_id` |

Each has a partial unique index (`WHERE col IS NOT NULL`).

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
variants on any wishlist once that exists. At 3 000 watched variants × 2 price kinds × 365 days
× ~48 bytes ≈ **105 MB/year**, with a retention policy that thins rows older than 12 months to
weekly.

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

`id uuid pk` references `auth.users(id)` on delete cascade. Columns: `display_name`, `locale`
(default `nb-NO`), `display_currency` (default `NOK`), `theme` (`system`/`light`/`dark`),
`is_admin bool default false`, `created_at`.

`is_admin` grants invitation management only. It grants **no** read access to another user's
collection or financial data — see [SECURITY.md](SECURITY.md) §4.

### 5.2 `retailers`, `storage_locations`, `tags`

All user-scoped (`user_id fk`), all with `name` unique per user. Retailers are user-scoped
rather than global so that "how much have I spent at Outland" is a private fact and so two
users' naming habits never collide.

`storage_locations` has `kind` enum (`binder`, `box`, `toploader_box`, `graded_case`, `shelf`,
`other`) and a `sort_order`. Bulk reassignment is a UI feature over a single FK update, so the
Later item costs nothing today.

### 5.3 `purchases` and `purchase_lines`

A purchase is one receipt. It always has at least one line.

**`purchases`**

| Column | Notes |
|---|---|
| `id uuid pk`, `user_id fk` | |
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
| `card_variant_id fk nullable`, `sealed_product_id fk nullable` | Exactly one non-null, enforced by check constraint |
| `condition` | Null for sealed and for graded |
| `grading_state` | enum `raw`, `pending`, `graded`. `raw` for sealed holdings. |
| `grader` | enum `psa`, `cgc`, `bgs`, `ace`, `sgc`, `tag`, `other`; null unless graded/pending |
| `grade numeric(3,1) nullable`, `cert_number text nullable` | |
| `storage_location_id fk nullable`, `is_favorite bool` | |
| `notes`, `created_at`, `updated_at` | |

Partial unique index so the same physical state does not fragment into duplicate holdings:

```sql
CREATE UNIQUE INDEX holdings_identity ON holdings (
  user_id, holding_kind,
  coalesce(card_variant_id, sealed_product_id),
  coalesce(condition, 'n/a'), grading_state,
  coalesce(grader, 'n/a'), coalesce(grade, -1)
) WHERE deleted_at IS NULL;
```

A graded card is a **separate holding** from the raw copies of the same variant, because it has
a different market and a different valuation path. Grading moves a lot from the raw holding to
a new graded holding via `lot_transfers` (§5.9).

`holding_kind = 'sealed'` covers all sealed inventory. There is no separate sealed table: the
lot mechanics (quantity, cost basis, partial disposal) are identical, and unifying them means
one code path for valuation, sales and export.

### 5.5 `acquisition_lots`

The financial heart of the model.

| Column | Notes |
|---|---|
| `id uuid pk`, `holding_id fk`, `user_id fk` | |
| `origin` | enum `purchase`, `opening`, `trade`, `gift`, `found`, `unknown` |
| `purchase_line_id fk nullable` | Set when `origin = 'purchase'` |
| `opening_id fk nullable` | Set when `origin = 'opening'`; **retained permanently, including after sale** |
| `acquired_on date` | |
| `quantity int`, `quantity_remaining int` | `0 <= quantity_remaining <= quantity` |
| `unit_cost_basis_minor bigint **nullable**` | `NULL` = no attributable direct cost. **Never 0 to mean "free".** |
| `cost_basis_currency`, `unit_cost_basis_nok_minor nullable` | |
| `residual_minor int default 0` | Largest-remainder residual so `quantity × unit + residual` = line cost exactly |
| `notes`, `created_at`, `voided_at nullable` | |

Check constraint enforcing M1:

```sql
CHECK (
  (origin = 'purchase' AND purchase_line_id IS NOT NULL AND unit_cost_basis_minor IS NOT NULL)
  OR
  (origin <> 'purchase' AND unit_cost_basis_minor IS NULL)
)
```

Trades will relax this when implemented; the relaxation is a migration, not a redesign.

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
| `sale_line_id fk nullable`, `opening_id fk nullable` | |
| `created_at`, `voided_at nullable` | |

> **Invariant D1:** `lot.quantity_remaining = lot.quantity − Σ non-voided disposals`.
> Enforced by trigger and asserted by a consistency test.

### 5.8 `openings`

| Column | Notes |
|---|---|
| `id uuid pk`, `user_id fk` | |
| `opened_on date` | |
| `sealed_product_id fk nullable`, `source_lot_id fk nullable` | Null for an unlinked opening |
| `pack_count int nullable` | |
| `cost_minor nullable`, `cost_currency`, `cost_nok_minor nullable` | |
| `cost_source` | enum `from_lot`, `manual`, `unknown` |
| `tracking_completeness` | enum `all_cards`, `selected_pulls`, `unknown` — drives the incompleteness marker (F8 area) |
| `bulk_remainder_estimate_minor nullable`, `bulk_remainder_count int nullable` | |
| `notes`, `created_at`, `voided_at nullable` | |

Pulls are not a separate table. A pull **is** an `acquisition_lot` with `origin = 'opening'`
and `opening_id` set. This is why a sold pull remains attributable to its opening forever.

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

| Column | Notes |
|---|---|
| `id uuid pk`, `user_id fk`, `holding_id fk` | |
| `value_minor`, `currency`, `value_nok_minor` | |
| `effective_from date`, `superseded_at timestamptz nullable` | History preserved; never updated in place |
| `note`, `created_by`, `created_at` | |

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
| `id uuid pk`, `token_hash text` | Only the hash is stored. The plaintext token is shown once, at creation. |
| `created_by uuid fk`, `note text nullable` | |
| `expires_at timestamptz`, `max_uses int default 1`, `use_count int default 0` | |
| `revoked_at`, `created_at` | |
| `redemptions` child table | `invitation_id`, `user_id`, `redeemed_at` |

No email column is required — the admin shares the link out of band. An optional `label` field
exists for the admin's own bookkeeping.

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
| Anything → sold | `sale_line` + `lot_disposal(kind='sale')` | `cost_basis_at_sale` frozen; `opening_id` still readable on the lot |

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
| `cards` trigram on `name`, plus `(set_id, local_id)` | Card search |
| `portfolio_snapshots (user_id, snapshot_date)` | Chart range queries |

Target: a 5 000-card collection renders its dashboard from `portfolio_snapshots` plus one
aggregate over open lots — no per-card network round trips.

---

## 11. Open modelling questions

Recorded rather than guessed. None block MVP.

| Question | Current stance |
|---|---|
| Cross-language card equivalence | Deferred. Separate `card_equivalences` table if needed. |
| Trades | Schema-ready (`origin = 'trade'`), constraint relaxation pending. Cost-basis rule undecided; carryover vs. fair-value both defensible. |
| Bulk lots as holdings | A "500 bulk commons" purchase currently becomes a `bulk_lot` purchase line with no holding. Revisit if bulk becomes a tracked asset. |
| Sealed catalog curation | How curated sealed rows get promoted from user-created ones needs a process, not just a column. |
