# Financial Model

Authoritative definition of every monetary term, formula and allocation rule in PokePortfolio.

**Status:** locked for MVP. Changes here require a corresponding entry in [DECISIONS.md](DECISIONS.md) and updated tests.

> This is hobby/portfolio accounting, not tax accounting. No figure in this document is
> represented as a taxable gain, a formal investment return, or a valuation suitable for
> financial reporting. See [§10 Explicit non-claims](#10-explicit-non-claims).

---

## 1. Representation rules

| Rule | Detail |
|---|---|
| Storage type | Integer **minor units** (`bigint`). Never float, never `numeric` for money. |
| Currency | Always accompanied by an ISO 4217 code. Minor-unit exponent read from a currency table, not assumed to be 2. |
| Example | `699.00 NOK` → `total_minor = 69900`, `currency = 'NOK'` |
| FX rates | `numeric(18,8)`. Rates are not money and are not stored as minor units. |
| Percentages | Computed at read time from minor-unit integers. Never stored. |
| Rounding | Half-up to the minor unit at every persistence boundary. Allocation uses largest-remainder (§4.2) so parts always sum exactly to the whole. |
| Display currency | NOK. Every stored non-NOK amount carries a frozen NOK conversion (§7). |

**Invariant M1 —** no monetary column may be nullable *to mean zero*. `NULL` always means
"not applicable / not known", never "0". This distinction is load-bearing for opening pulls (§5),
gifts, and cards acquired before tracking began.

### 1.1 Cost basis is a state, not just a nullable number

A bare `NULL` cost basis conflates situations that are economically different and that the user
needs told apart. Every acquisition lot therefore carries an explicit `cost_basis_state`:

| State | Meaning | `unit_cost_basis_minor` |
|---|---|---|
| `known` | Traced to a purchase line with a real amount | **NOT NULL** |
| `unallocated_opening` | Came from opening a product. The cost is owned by the opening and is deliberately not divided among pulls (§5). | `NULL` |
| `not_paid` | Gift, prize, promotional. No money changed hands. | `NULL` |
| `unknown` | Money was probably paid, but the amount is not recoverable — typically a pre-tracking collection | `NULL` |
| `trade_in` | Received in a trade. Basis depends on the trade rule (§6). | `NULL` until trades ship |

> **Invariant M2:** `unit_cost_basis_minor IS NOT NULL` **iff** `cost_basis_state = 'known'`.
> Enforced by check constraint.

Only `known` lots contribute to `DCB`, `URC` and `RRC`. The other four are aggregated and
surfaced, never silently treated as zero and never silently dropped. The user sees, for example,
*"1 284 of 4 723 cards have no recorded cost"* rather than a portfolio that quietly implies every
gift was free profit.

---

## 2. Term definitions

Internal names are canonical. UI labels may differ; the mapping is in §9.

### 2.1 Outflow

| Term | Symbol | Definition |
|---|---|---|
| **Gross purchase outflow** | `GPO` | Σ `purchases.total_nok_minor` over all non-voided purchases. Every krone that left the user's account for a Pokémon purchase. |
| **Collectible spend** | `CS` | Σ attributable cost of non-voided `purchase_lines` where `spend_class = 'collectible'`, including their allocated shipping, customs and discount (§4). |
| **Hobby spend** | `HS` | Same, for `spend_class = 'hobby'`. |

> **Invariant F1:** `GPO = CS + HS` for every user, at all times. Tested.

`spend_class` is derived from `line_type` by default and may be overridden per line:

| `line_type` | Default `spend_class` |
|---|---|
| `card`, `sealed`, `grading_fee`, `bulk_lot` | `collectible` |
| `accessory` | `hobby` |
| `shipping_standalone`, `customs_standalone`, `other` | inherits from the purchase's dominant class; user-overridable |

### 2.2 Inflow

| Term | Symbol | Definition |
|---|---|---|
| **Sales gross proceeds** | `SGP` | Σ `sales.gross_nok_minor` — what buyers paid for the items. |
| **Sales fees** | `SF` | Σ marketplace/payment fees. |
| **Outbound shipping cost** | `OSC` | Shipping the seller actually paid. |
| **Shipping charged to buyer** | `SCB` | Shipping the buyer paid on top of the item price. |
| **Net sales proceeds** | `NSP` | `SGP − SF − OSC + SCB` |

> **Invariant F2:** shipping charged to the buyer is never revenue on its own. It only ever
> offsets `OSC`. If `SCB > OSC` the surplus is retained in `NSP`; this is intentional and rare.

### 2.3 Net position

| Term | Symbol | Definition |
|---|---|---|
| **Net collectible cash outflow** | `NCCO` | `CS − NSP` — money currently tied up in collectibles. |
| **Total hobby cash outflow** | `THCO` | `GPO − NSP` — what the hobby has cost net of everything recovered. `THCO = NCCO + HS`. |

### 2.4 Inventory value

| Term | Symbol | Definition |
|---|---|---|
| **Current market value** | `CMV` | Σ over open lots of `quantity_remaining × resolved_unit_value_nok` (§6). Lots with no resolvable value are **excluded and counted separately**, never treated as zero. |
| **Attributed-cost market value** | `ACMV` | `CMV` restricted to lots with `cost_basis_state = 'known'`. |
| **Unattributed market value** | `UMV` | `CMV` restricted to every other `cost_basis_state`. |
| **Unvalued holdings count** | `UHC` | Count of open lots with no resolvable value. Surfaced in the UI; never silently dropped. |
| **Uncosted lot count** | `ULC` | Count of open lots where `cost_basis_state <> 'known'`, broken down by state. Surfaced alongside `CMV`. |

> **Invariant F3:** `CMV = ACMV + UMV`.

### 2.5 Cost basis

| Term | Symbol | Definition |
|---|---|---|
| **Direct unit cost basis** | — | `acquisition_lots.unit_cost_basis_nok_minor`. Present only when `cost_basis_state = 'known'` (§1.1). |
| **Lot cost adjustments** | — | Later costs attributable to a specific lot (grading fee, grading shipping). Stored separately in `lot_cost_adjustments` so the original acquisition cost is never mutated. |
| **Effective unit cost basis** | `EUCB` | `unit_cost_basis + (Σ adjustments for the lot ÷ original lot quantity)`. `NULL` if `unit_cost_basis` is `NULL`. |
| **Direct cost basis of inventory** | `DCB` | Σ over open lots of `quantity_remaining × EUCB`, skipping `NULL`. |

> **Invariant F4:** cost basis is immutable with respect to market movement. No market price
> update may ever write to a cost-basis column. Tested by a dedicated regression test.

### 2.6 Result figures

| Term | Symbol | Definition |
|---|---|---|
| **Unrealized result on costed inventory** | `URC` | `ACMV − DCB`. The only figure in the app entitled to be called an unrealized gain/loss. |
| **Realized result on costed disposals** | `RRC` | Σ over sale lines where `cost_basis_at_sale IS NOT NULL` of `(allocated_net_proceeds − cost_basis_at_sale)`. |
| **Proceeds from uncosted disposals** | `PUD` | Σ over sale lines where `cost_basis_at_sale IS NULL` of `allocated_net_proceeds`. A pure inflow. **Not** a gain — there is no item-level cost to subtract. |
| **Total tracked economic position** | `TTEP` | `CMV + NSP − CS` |
| **Total hobby position** | `THP` | `CMV + NSP − GPO` = `TTEP − HS` |

> **Invariant F5:** `RRC + PUD = NSP − Σ cost_basis_at_sale`. Consistency check between
> the two disposal paths.

**Why `TTEP` and not `URC + RRC`:** `URC + RRC` silently omits every krone spent on product
whose contents have no individual cost basis — exactly the pack-opening case this app exists
to model. `TTEP` is a portfolio-level identity that counts each krone of collectible spend
exactly once, each sale exactly once, and each held item exactly once. It is the honest headline.

`URC` and `RRC` remain available as sub-figures for the portion of the collection where a
per-item cost basis genuinely exists.

---

## 3. Ownership timeline

A lot is **open** on date `D` when:

```
lot.acquired_on <= D
AND NOT lot.voided
AND quantity_remaining_as_of(lot, D) > 0
```

`quantity_remaining_as_of(lot, D)` = `lot.quantity − Σ disposals of that lot with disposed_on <= D`,
where a disposal is a `sale_line`, an `opening` consuming a sealed lot, or an explicit write-off.

This makes historical portfolio value reconstructable from canonical transactions alone.
Consequences, all intentional:

- A card bought on day 30 contributes nothing to the chart on day 29.
- A card sold on day 100 contributes nothing from day 100 onward, and its earlier contribution is unchanged.
- Backdating a purchase **does** change history — correctly, because the user did own it then.
- A market price revision for day 40 changes day 40 forever after. Market history is a fact table, not an estimate.

---

## 4. Allocation rules

### 4.1 Purchase-level charges

Shipping, customs and discounts belong to a *purchase*, not to a line. They are allocated
across **all** lines pro rata by `line_total_minor`, including hobby lines.

Rationale: if a receipt contains sleeves and a card, part of the shipping genuinely paid for
the sleeves. Allocating only to collectible lines would inflate collectible spend and break
invariant F1. This rule is deterministic and keeps `GPO = CS + HS` exact.

```
weight_i        = line_total_i / Σ line_total
allocated_ship_i = round_largest_remainder(shipping_total, weights)
```

Discounts are allocated identically and subtract. A line's **attributable cost** is:

```
attributable_cost_i = line_total_i
                    + allocated_shipping_i
                    + allocated_customs_i
                    − allocated_discount_i
```

Edge case: if `Σ line_total = 0` (a purchase consisting only of shipping), the charge is
allocated equally across lines; if there are no lines, the purchase is rejected at validation.

### 4.2 Largest-remainder rounding

Naive per-line rounding loses or invents øre. The allocator:

1. Computes each exact share as a rational.
2. Floors each to a whole minor unit.
3. Distributes the remaining `total − Σ floors` units one at a time to the lines with the
   largest fractional remainders, ties broken by lowest line id (deterministic).

> **Invariant F6:** `Σ allocated_i = total` exactly, for any input. Property-tested.

### 4.3 Lot cost basis from a purchase line

```
unit_cost_basis = attributable_cost_line / quantity_line
```
rounded by the same largest-remainder method across the lot's units when `quantity > 1` and
the division is inexact. A lot with `quantity = 3` and attributable cost `1000` stores a per-unit
basis of `333` with a `+1` residual on the lot so `Σ = 1000`. `residual_nok_minor` is the NOK-side
counterpart of this same rule, corrected in M10 (DECISIONS.md D-060) after a real, silent leak was
found in the original NOK-side division for foreign-currency multi-unit lots.

**Which disposal gets the residual, when the lot is sold across more than one sale?** (D-060.)
Whichever disposal reduces `quantity_remaining` to exactly zero — a lot's `quantity_remaining`
decreases monotonically and reaches zero at most once per "lifetime" (voiding the exhausting
disposal restores it above zero, making a second zero-crossing a distinct later event, never a
double credit), so summing every disposal's frozen basis reproduces the lot's exact original cost
exactly. The identical rule applies to a lot's `lot_cost_adjustments` division (§4.4) when a
partial disposal must freeze its per-unit share. Full derivation: DATA_MODEL.md §5.7, D-060.

### 4.4 Grading costs

A grading fee purchased later attaches to a specific lot as a `lot_cost_adjustment`:

- `kind = 'grading_fee'` and `kind = 'grading_shipping'`
- The originating `purchase_line_id` is retained, so the krone appears in `CS` exactly once
  and in `EUCB` exactly once — these are the same krone viewed at portfolio and item scope,
  never summed together.

> **Invariant F7:** every `lot_cost_adjustment` references a `purchase_line`. There is no path
> to increase an item's cost basis without a corresponding real purchase.

### 4.5 Sale-level charges

Fees and outbound shipping are allocated across sale lines pro rata by `unit_gross × quantity`,
using the same largest-remainder method. Shipping charged to the buyer is allocated identically
and adds back.

---

## 5. Openings — cost attribution

**The rule:** an opening owns the monetary cost. Cards obtained from it have **no direct cost
basis** — `unit_cost_basis_minor IS NULL`, which the system reads as *not allocated*, never as
*zero kroner*.

### 5.1 Why not allocate

| Alternative | Why rejected |
|---|---|
| Allocate pro rata by current market value | Cost basis would drift every time the market moved, violating F4. A historical cost that changes is not a cost. |
| Allocate equally per card | Assigns the same basis to a 0.02 € bulk common and a 400 € chase card. Produces per-card ROI figures that are pure noise. |
| Assign literal 0 | Makes every pull show infinite ROI. Actively misleading — this is the failure mode being avoided. |

### 5.2 UI consequences

- A pulled card's detail view shows **"From opening — no individual purchase cost"**, with a link
  to the opening. It does **not** show a cost basis field, an ROI figure, or "0 NOK".
- Per-card ROI is unavailable for opening-origin lots, by design.
- ROI for opened product is answered at **opening scope**, where the question is well-posed.

### 5.3 Opening return

```
opening_return = retained_tracked_value
               + net_proceeds_from_sold_pulls
               + bulk_remainder_estimate        (0 if not supplied)
               − opening_cost

opening_roi    = opening_return / opening_cost     (undefined when cost is NULL)
```

Where:

- `retained_tracked_value` — current NOK market value of pulls from this opening still held.
- `net_proceeds_from_sold_pulls` — sale-line net proceeds for lots with `opening_id = this`.
  Traceability survives the sale because the lot keeps its `opening_id` permanently.
- `bulk_remainder_estimate` — optional user estimate for cards not individually recorded.

**Completeness flag.** `openings.tracking_completeness ∈ {all_cards, selected_pulls, unknown}`.
When it is not `all_cards`, every surface displaying opening return must render an
incompleteness marker. Copy: *"Tracked pulls only — actual return is higher."* A bare ROI
percentage for a partially tracked opening is a bug, not a rendering choice.

> **Invariant F8:** opening returns are **not additive** with `TTEP`. They are a different scope
> over the same krone. Nothing in the app may sum them.

### 5.4 Opening a sealed lot

Opening is a state transition, never a delete-and-recreate:

1. The sealed lot's `quantity_remaining` decreases by the number opened.
2. A `lot_disposal` row of kind `opened` is written, referencing the new `opening`.
3. `openings.cost_nok_minor` is copied from the consumed lot's `EUCB × quantity_opened`,
   with `cost_source = 'from_lot'`.
4. Pull lots are created with `origin = 'opening'`, `opening_id` set, `unit_cost_basis = NULL`.

`CS` is untouched by all of this. The purchase remains in history permanently.

### 5.5 Opening with no recorded purchase — provisional cost

A user who opens something they never entered as a purchase still spent that money, and lifetime
spending would be wrong to omit it. Recording it only as an opening-local number would make the
most important metric in the product systematically understate reality.

**Mechanism.** Entering an opening with a manual cost and no linked lot creates a real
`purchase` row marked `origin = 'provisional_opening'`, with one `sealed` line, linked back to
the opening. It is an ordinary ledger entry: it counts in `GPO` and `CS` like any other, and the
consumed lot gives the opening a normal `cost_source = 'from_lot'`.

**Reconciliation.** When the real purchase is entered later, the user links it to the opening.
In one transaction:

1. The opening's `source_lot_id` is repointed at the real purchase's lot.
2. The provisional purchase is **voided** — retained, excluded from every calculation.
3. An `audit_event` of action `opening_cost_reconciled` records both purchase ids.

Nothing is deleted, and the money is counted exactly once at every point in time.

> **Invariant F12:** an opening has at most one non-voided cost source. A provisional purchase
> and a linked real purchase can never both be active for the same opening.

The UI marks a provisionally costed opening as *"Cost entered manually — not linked to a
purchase"* and offers the link action. Reconciliation is a user action, not an automatic match:
guessing which of three similar purchases corresponds to an opening would silently corrupt the
ledger, and the user knows the answer in a single tap.

---

## 6. Market value resolution

For each open lot, exactly one value is resolved, in priority order:

| Priority | Source | `price_state` |
|---|---|---|
| 1 | Active manual valuation for the holding | `manual` |
| 2 | Provider snapshot ≤ 3 days old | `fresh` |
| 3 | Provider snapshot 4–30 days old | `stale` — value used, flagged in UI |
| 4 | Provider snapshot > 30 days old, or none | `missing` — **excluded from `CMV`**, counted in `UHC` |

A provider snapshot whose value is genuinely `0` is a real observation and is stored and used as
zero — some bulk commons really do trade at nothing. That is categorically different from having
no observation, and the two must never collapse into the same state. `price_state` distinguishes
them; `value_minor = 0` with `price_state = 'fresh'` is valid data.

Provider price selection for raw cards (Cardmarket, EUR):

1. `trend`
2. `avg30` if `trend` is absent
3. `avg7`, then `avg` — each fallback recorded in `price_kind` so provenance is inspectable

Provider price selection for raw cards (TCGplayer, USD): `marketPrice` only. `low`/`mid`/`high`
are not a fallback chain — a low price is not automatically a fair market value, and no financial
model decision has been made to treat it as one (M9 prompt §18). If `marketPrice` is absent,
TCGplayer has no candidate for that variant on that day.

**Provider preference (M9, D-052).** `profiles.use_eu_pricing` decides which provider is tried
first when both could resolve a price for the same variant:

- `use_eu_pricing = true` (the product default, D-044): Cardmarket is used whenever it resolves to
  a non-missing (fresh or stale) price. TCGplayer is used only when Cardmarket has none.
- `use_eu_pricing = false`: the exact mirror — TCGplayer first, Cardmarket only as a fallback.

Freshness is never compared *across* providers to override this preference — a stale Cardmarket
price still wins over a fresher TCGplayer one when EU pricing is selected. This is the simplest
reading of the owner's stated preference ("use European pricing when available") and the one
`resolve_variant_market_values` implements; every M9 surface calls that one function rather than
re-deriving the rule (DATA_MODEL.md §17).

> **Invariant F9:** a provider failure may never reduce a value to zero. On failure the last
> known snapshot is retained and its age drives `price_state`. Tested with a simulated outage.

### 6.1 Condition

Cardmarket's published price points are **not condition-specific**. The app therefore:

- stores `condition` on the holding as a real property, used for filtering, sorting and export;
- does **not** apply any condition multiplier to derive value in MVP;
- labels every provider-derived value as a market reference for the printing, not for the copy;
- offers manual valuation as the honest route for a heavily played copy.

Configurable multipliers are a Later item and must be opt-in, user-set, and visibly marked as
an estimate. Inventing percentages that no data source supports is fake precision.

### 6.2 Graded cards

No free source provides reliable graded market prices in EUR (see [API_SOURCES.md](API_SOURCES.md)).
Therefore:

> **Invariant F10:** a raw-card market price may never be displayed as, or used as, the value
> of a graded card. A graded holding with no manual valuation resolves to `missing`.

### 6.3 Sealed products

Same rule as graded: manual valuation until a legitimate EUR source is confirmed. A sealed
holding may optionally display a secondary USD reference from a US source, clearly labelled
as a different market, and never used in `CMV`.

### 6.4 Historical resolution as of date D (M12, D-062/D-066-era snapshot semantics)

Every rule above applies **as of the snapshot date**, not as of today:

- Manual override: the active value on D is the economic-interval model of D-062 — rows ordered
  by `(effective_from, created_at, id)`, each owning `[effective_from, next effective_from)`,
  the terminal row ending at its clear's wall-clock date when cleared, an active row extending
  indefinitely. One resolved refinement (D-062's reviewed corner): a row ended by an INDEPENDENT
  clear stays cleared even when a later, separate valuation arrives with a higher
  `effective_from` — the gap resolves through the automatic path below, never the resurrected
  old value. Only an ATOMIC replacement (supersede + insert in one transaction, recognizable by
  the old row's `superseded_at` equalling some row's `created_at`) keeps the plain
  next-effective-from boundary.
- Provider freshness: a price's age on D is `D − snapshot_date`, never
  `today − snapshot_date`. An observation that is stale or even expired *today* was fresh fact
  on the day it resolved, and historical snapshots must say what was true then (tested at the
  exact 30/31-day boundary).
- FX: converted with the observation on or before the provider snapshot's own date — never
  today's rate and never the frozen transaction rate (§7).
- Missing stays missing; a genuine zero stays zero (F14). No pre-tracking history is ever
  backfilled: before a variant's first real observation, it contributes nothing but an
  unvalued count.

Display-currency conversion of stored NOK history follows D-067: each point converts with the
FX observed on or before its own date, so EUR/USD charts legitimately include FX movement;
storage remains NOK and frozen transactional conversions are untouched (F11).

**Compaction and historical market value (D-070).** M9.1's retention policy (D-058: 60 days
daily, weekly beyond) means the observation set underlying OLD history is itself
maintained over time. When dense observations cross the boundary and are compacted to weekly
survivors, an older historical CMV point may adjust ONCE to derive from the retained weekly
facts. This is accepted explicitly (D-070): snapshots stay a rebuildable cache relative to
CURRENTLY RETAINED canonical facts; no price or value is fabricated; frozen ledger amounts
(purchases, sales, FX, cost basis — §2/§4/§7) are structurally untouched by compaction.

### 6.5 TTEP and THP when no snapshot exists yet

Until a user's first `portfolio_snapshots` row exists — every brand-new account between its
first mutation and its first drain, and every pre-existing account during initial deployment's
backfill window — CMV is unavailable, so:

- `TTEP = CMV + NSP − CS` is **NULL**, rendered "—", never "0 kr".
- `THP = CMV + NSP − GPO` is likewise **NULL**: with CMV unavailable the whole expression is
  unavailable. Coalescing the missing CMV to 0 would fabricate a position out of nothing.
- The lifetime ledger figures underneath (`GPO`, `CS`, `HS`, `NS`, `RRC`, `PUD`) remain fully
  real during this window; only the snapshot-derived composite is honestly absent.

---

## 7. Foreign currency

A purchase in a non-NOK currency stores:

| Field | Meaning |
|---|---|
| `currency`, `*_minor` | Original amounts, never recomputed |
| `fx_rate_to_nok` | Rate applied, `numeric(18,8)` |
| `fx_rate_date` | The date the rate applies to |
| `fx_source` | `norges_bank` \| `manual` |
| `*_nok_minor` | Frozen NOK conversion, computed once at write time |

> **Invariant F11:** `*_nok_minor` on a transaction is written once and never recomputed.
> A purchase made at 11.54 NOK/EUR stays at 11.54 forever.

Manual FX override exists because a card statement's effective rate differs from the reference
rate. Overriding sets `fx_source = 'manual'`.

**Historical market value** uses the FX rate for the snapshot date, not today's rate:

```
value_nok(variant, D) = price_snapshot(variant, D).value
                      × fx_rate(snapshot.currency → NOK, D)
```

If no rate exists for `D` (weekend, holiday — Norges Bank publishes business days only), the
most recent prior business-day rate is used and recorded as such.

---

## 8. Worked examples

All amounts in NOK. Minor units shown where rounding matters. Each example lists the delta to
every top-level metric. These become the fixtures in `tests/financial/*.test.ts`.

### E1 — Direct single purchase

Buy one card for 500. Current market value 700.

| Metric | Value |
|---|---|
| `GPO` | 500 |
| `CS` | 500 |
| `HS` | 0 |
| `CMV` | 700 (`ACMV` 700, `UMV` 0) |
| `DCB` | 500 |
| `URC` | +200 |
| `NSP` | 0 |
| `TTEP` | 700 + 0 − 500 = **+200** |

Here `TTEP = URC`, as expected when every item has a cost basis and nothing has been sold.

### E2 — Multiple copies, one sold

Buy the same card three times: 100, 150, 200. One holding, three lots. Market value 180 each.
Sell one copy for 220 gross, 20 fee, no shipping → `NSP` 200. User selects lot L1 (100).

| Metric | Before sale | After sale |
|---|---|---|
| `CS` | 450 | 450 |
| Open lots | L1 100, L2 150, L3 200 | L2 150, L3 200 |
| `CMV` | 540 | 360 |
| `DCB` | 450 | 350 |
| `URC` | +90 | +10 |
| `NSP` | 0 | 200 |
| `RRC` | 0 | 200 − 100 = **+100** |
| `TTEP` | +90 | 360 + 200 − 450 = **+110** |

Check: `TTEP = URC + RRC` = 10 + 100 = 110 ✓ (holds because all lots are costed).

If the app had averaged the three lots to 150, selling L1 would have shown `RRC = +50` and
destroyed the provenance of which physical copy left. Lot-level tracking is why F2/E2 differ.

### E3 — Mixed receipt with shipping

One purchase: ETB 700, single card 500, sleeves 100, shipping 100. Total 1400.

Line totals sum to 1300. Shipping allocated pro rata (§4.1), largest-remainder:

| Line | Class | Line total | Exact share | Allocated | Attributable cost |
|---|---|---|---|---|---|
| ETB | collectible | 700 | 53.846 | **53.85** (5385 øre) | 753.85 |
| Card | collectible | 500 | 38.461 | **38.46** (3846 øre) | 538.46 |
| Sleeves | hobby | 100 | 7.692 | **7.69** (769 øre) | 107.69 |
| | | 1300 | 100.00 | 10000 øre ✓ | 1400.00 |

| Metric | Value |
|---|---|
| `GPO` | 1400.00 |
| `CS` | 753.85 + 538.46 = **1292.31** |
| `HS` | **107.69** |
| F1 check | 1292.31 + 107.69 = 1400.00 ✓ |

The ETB lot's cost basis is 753.85, not 700. The card lot's is 538.46.

### E4 — Open a sealed product

Continuing E3. The ETB (cost basis 753.85) is opened. Nine packs. User records three pulls
worth 500 total today, marks tracking as `selected_pulls`, no bulk estimate.

| Metric | Before opening | After opening |
|---|---|---|
| `CS` | 1292.31 | **1292.31** (unchanged — this is the point) |
| Sealed lots open | ETB ×1 | none |
| `CMV` | 753.85-ish ETB value + 500 card | 500 (pulls) + 538.46-ish card |
| `ACMV` | includes ETB | card only |
| `UMV` | 0 | 500 (the pulls) |
| `DCB` | 1292.31 | 538.46 (card only) |
| `URC` | (ETB mv − 753.85) + (card mv − 538.46) | card mv − 538.46 |
| `TTEP` | unchanged by opening | unchanged by opening |

`opening.cost_nok_minor` = 75385. Pull lots have `unit_cost_basis = NULL`.

```
opening_return = 500 + 0 + 0 − 753.85 = −253.85
opening_roi    = −33.7%   [flagged: tracked pulls only]
```

No pull shows a per-card ROI. No pull shows "0 NOK cost".

### E5 — Sell a pull from an opening

Continuing E4, but with the user's original figures for clarity: opening cost **799**, retained
pulls worth **500**, one pull sold for **450 net**.

| Metric | Effect |
|---|---|
| `NSP` | +450 |
| `PUD` | +450 (unattributed — the sold lot had no cost basis) |
| `RRC` | unchanged — no cost basis to subtract |
| `CMV` | 500 (retained pulls) |
| `TTEP` | 500 + 450 − 799 = **+151** |

```
opening_return = 500 + 450 + 0 − 799 = +151
opening_roi    = +18.9%   [flagged: tracked pulls only]
```

The sale is reported as **"450 NOK proceeds from an opening pull"**, not as a 450 NOK profit
and not as a sale of a zero-cost item. The lot retains `opening_id`, so the opening's return
includes it permanently.

Note `TTEP` and `opening_return` coincide here only because this opening is the user's entire
activity. They are different scopes and must never be summed (F8).

### E6 — Grading

Buy a raw card for 500 (attributable cost 500, no shipping). Later, a second purchase:
grading fee 400, shipping to grader 150. Card returns as PSA 10. User sets a manual valuation
of 2500.

| Metric | Value |
|---|---|
| `GPO` | 1050 |
| `CS` | 1050 (all three lines are collectible) |
| Lot `unit_cost_basis` | 500 (unchanged) |
| `lot_cost_adjustments` | grading_fee 400, grading_shipping 150 |
| `EUCB` | 1050 |
| `CMV` | 2500 (`price_state = manual`) |
| `DCB` | 1050 |
| `URC` | +1450 |
| `TTEP` | 2500 + 0 − 1050 = **+1450** |

Grading profitability (V1 feature) needs the raw value at submission time, captured on the
submission line:

```
grading_delta = graded_value − raw_value_at_submission − (grading_fee + grading_shipping)
              = 2500 − 900 − 550 = +1050
```

Without `raw_value_at_submission_minor` this question is unanswerable after the fact, so it is
captured at submission even though the analysis ships in V1.

### E7 — Partial sale from a multi-unit lot

Holding with lots: L1 qty 1 @ 100, L2 qty 1 @ 150, L3 qty 1 @ 200, L4 qty 2 @ 180 each.
Total 5 units, `DCB` = 100 + 150 + 200 + 360 = 810. Sell 2 units for 500 gross, 50 fees →
`NSP` 450. User selects L1 (1 unit) and L4 (1 unit).

Fee allocation across the two sale lines pro rata by gross; assume 250 gross each → 225 net each.

| Lot | Units sold | `cost_basis_at_sale` | Realized |
|---|---|---|---|
| L1 | 1 | 100 | +125 |
| L4 | 1 | 180 | +45 |

| Metric | After |
|---|---|
| Open units | L2 1, L3 1, L4 1 |
| `DCB` | 150 + 200 + 180 = 530 |
| `RRC` | +170 |
| `NSP` | 450 |

`cost_basis_at_sale_minor` is frozen on the sale line. Later edits to the lot cannot rewrite
realized history.

### E8 — Manual valuation replacing a missing provider price

A Japanese promo has no Cardmarket mapping. Provider resolution returns nothing.

| Without manual value | With manual value 1200 |
|---|---|
| `price_state = missing` | `price_state = manual` |
| Excluded from `CMV` | Contributes 1200 to `CMV` |
| `UHC` += 1 | `UHC` unchanged |
| Dashboard shows "1 holding without valuation" | — |

The automatic value (absent here) is never overwritten; manual valuations live in their own
table with `created_by` and `created_at`, and the resolver simply prefers them.

### E9 — Stale provider price

The daily job fails for six days. A card's last snapshot is 6 days old at 340.

- `price_state = stale`; 340 is still used in `CMV`.
- The card row and the dashboard both show a staleness marker with the snapshot date.
- At day 31 the state becomes `missing`, the card leaves `CMV`, and `UHC` increments.
- At no point does the value become 0. (F9)

### E10 — Foreign-currency purchase

Buy a card from a German seller for **45.00 EUR**, shipping **4.50 EUR**. Norges Bank
EUR/NOK for the purchase date: **11.5400**.

| Field | Stored |
|---|---|
| `currency` | `EUR` |
| `subtotal_minor` | 4500 |
| `shipping_minor` | 450 |
| `total_minor` | 4950 |
| `fx_rate_to_nok` | 11.54000000 |
| `fx_rate_date` | purchase date |
| `fx_source` | `norges_bank` |
| `total_nok_minor` | round(4950 × 11.54) = **57123** (571.23 NOK) |

Line attributable cost in NOK: 45.00 × 11.54 + 4.50 × 11.54 = 571.23. Cost basis 571.23,
frozen. If EUR/NOK moves to 12.00 tomorrow, this purchase still reads 571.23. (F11)

### E11 — Purchased long ago, cost not recoverable

A card from a pre-tracking collection. The user knows they bought it; the amount is gone.
Recorded with `cost_basis_state = 'unknown'`. Market value 340.

| Metric | Effect |
|---|---|
| `GPO`, `CS` | **0** — no purchase row exists, and inventing one would corrupt the ledger |
| `CMV` | +340, contributing to `UMV` |
| `DCB`, `URC` | unchanged — the lot is not `known` |
| `ULC` | +1 in the `unknown` bucket |
| `TTEP` | +340 |

`TTEP` overstates the true position here, because real money was spent that the system cannot
see. This is unavoidable and is disclosed rather than hidden: the dashboard shows the uncosted
lot count next to the position figure.

**Sold later for 300 net:** `NSP` +300, `PUD` +300, `RRC` unchanged. The sale row displays
*"Proceeds 300 kr · Cost basis unknown"* and its result column reads **—**, not `+300`.

### E12 — Gift

A friend gives the user a card worth 900. `cost_basis_state = 'not_paid'`.

| Metric | Effect |
|---|---|
| `GPO`, `CS` | 0 — correctly, no money moved |
| `CMV` | +900 (`UMV`) |
| `TTEP` | +900 |

Unlike E11 this is economically accurate: the position genuinely improved by 900 at no cost.
The distinction between `not_paid` and `unknown` exists precisely so the app can tell these
apart, even though both store a `NULL` amount.

**Sold later for 850 net:** `NSP` +850, `PUD` +850. Result column **—**. It is tempting to call
this an 850 profit, and at portfolio level `TTEP` already reflects it correctly; asserting an
850 item-level *gain* would imply a cost basis of zero, which is the failure mode M1 exists to
prevent.

### E13 — Opening with a provisional cost, later reconciled

The user opens an ETB they never entered as a purchase and states they paid 799.

**Step 1 — provisional.** A `purchase` with `origin = 'provisional_opening'` is created: one
sealed line, 799, collectible.

| Metric | Value |
|---|---|
| `GPO`, `CS` | 799 |
| Opening cost | 799, `cost_source = 'from_lot'` |
| Sealed lot | created, then immediately consumed by the opening |

**Step 2 — the real purchase arrives.** Two weeks later the user enters the actual receipt: ETB
799 plus 79 shipping, total 878. Naively, `CS` is now 1 677 — the money counted twice.

The user links the opening to the real purchase. In one transaction the opening repoints at the
real lot and the provisional purchase is voided.

| Metric | After reconciliation |
|---|---|
| `GPO`, `CS` | **878** — counted once, and now more accurate than the manual figure |
| Opening cost | 878 (the real attributable cost including shipping) |
| Provisional purchase | retained, `voided_at` set, excluded everywhere |
| Audit | `opening_cost_reconciled` with both purchase ids |

Opening return recomputes against 878. (F12)

### E14 — Trade

Outgoing: card A (`known` basis 400) and card B (`unknown` basis), market values at trade date
600 and 250. Incoming: card C, market value 700. The user also receives 150 cash.

| Metric | Effect |
|---|---|
| `NSP` | +150 — the cash leg is unambiguous |
| Card A, B | disposed `traded_away`; A's basis 400 frozen as `cost_basis_at_disposal` |
| `DCB` | −400 |
| Card C | new lot, `cost_basis_state = 'trade_in'`, contributes 700 to `UMV` |
| `RRC` | **unchanged** — no realized result is asserted for the item legs (F13) |

The trade detail view shows: outgoing market value 850, incoming market value 700, difference
−150, cash received +150. Labelled as market values, never summed into realized P/L. When the
item-leg rule is decided, A's frozen basis makes a retrospective computation possible; B's will
remain unknown, correctly.

### E15 — A collection where most cards have no price

4 723 physical cards including energies and commons. 4 649 resolve to a price; 74 do not —
obscure promos, a Japanese jumbo, some very old cards.

| Figure | Value |
|---|---|
| `CMV` | 13 540 (from the 4 649 priced cards) |
| `UHC` | 74 |
| Physical cards | 4 723 |
| Unique variants | 1 846 |

The dashboard shows collection value with *"4 649 priced · 74 without a price"* directly beneath
it, and the 74 are reachable through a filter. They are **not** valued at zero and **not**
removed from the card count. (F14)

Note also that a provider price of genuinely 0.00 is a different thing from a missing price, and
the two are stored distinctly: the former is a real observation, the latter is absence of one.

---

## 9. Internal term → UI label

| Internal | UI label |
|---|---|
| `CMV` | Collection value |
| `GPO` | Total spent |
| `CS` | Spent on collectibles |
| `HS` | Spent on accessories |
| `THCO` | Net cost of the hobby |
| `NCCO` | Net invested in collectibles |
| `NSP` | Sales proceeds |
| `URC` | Unrealized, costed items |
| `RRC` | Realized result |
| `PUD` | Proceeds, uncosted items |
| `TTEP` | Overall position |
| `UHC` | Cards without a price |
| `ULC` | Cards without a recorded cost |

UI labels must not use "profit", "return" or "P/L" for `TTEP` without the qualifier that it
compares market value against collectible spend. `TTEP` is a position, not a return.

---

## 10. Explicit non-claims

The app does not compute, and must not label anything as:

- taxable gain or loss under Norwegian or any other tax law;
- formal investment return, IRR, time-weighted return, or money-weighted return;
- appraised, insured, or liquidation value;
- per-card ROI for opening-origin items;
- condition-adjusted market value, while provider data is not condition-specific;
- graded market value derived from raw prices;
- a realized result for any disposal whose lot had no recorded cost — sold gifts, sold pulls,
  sold pre-tracking cards and traded-away items show proceeds and a result of **—**;
- a realized result for the item legs of a trade (§11).

Export carries enough provenance (transaction dates, original currency, FX rate and source,
cost basis, disposal records) that external tax analysis is possible later.

---

## 11. Trades

The full trade workflow ships in V1, but the semantics are settled now so the schema and the
disposal path do not have to change later.

A trade is one transaction with outgoing items, incoming items, and optionally cash in either
direction. Outgoing lots are disposed with `kind = 'traded_away'`; incoming items become lots
with `cost_basis_state = 'trade_in'`.

**Cash legs are real money and behave normally.** Cash paid is collectible spend; cash received
is proceeds. These are unambiguous and are counted in `CS` and `NSP` respectively.

**The item legs are not assigned a monetary result.** Two rules are defensible — carrying the
outgoing basis onto the incoming item, or treating the trade as a disposal at fair value followed
by an acquisition at fair value — and they produce materially different realized results from
identical facts. Choosing one silently would fabricate precision. So, until the rule is decided:

- Outgoing lots with `cost_basis_state = 'known'` record `cost_basis_at_disposal`, frozen, so the
  information survives for whichever rule is later adopted.
- Incoming lots are `trade_in` and contribute to `UMV`, not `ACMV`.
- No realized P/L is reported for the item legs. The trade detail view shows, separately:
  outgoing market value at trade date, incoming market value at trade date, the difference, and
  the cash legs. These are described as market values, not as profit.

> **Invariant F13:** a trade never produces a realized P/L figure while the item-leg rule is
> undecided. Market-value comparison is displayed as such and is never summed into `RRC`.

Market values at trade date are captured when the trade is recorded, because they are not
recoverable afterwards — the same reasoning as `raw_value_at_submission` for grading.

---

## 12. Invariant register

Every invariant below has a corresponding automated test. See [TESTING.md](TESTING.md).

| ID | Invariant |
|---|---|
| M1 | `NULL` money never means zero |
| M2 | `unit_cost_basis_minor IS NOT NULL` iff `cost_basis_state = 'known'` |
| F1 | `GPO = CS + HS` |
| F2 | Buyer-paid shipping only offsets seller shipping cost |
| F3 | `CMV = ACMV + UMV` |
| F4 | Market updates never write cost-basis columns |
| F5 | `RRC + PUD = NSP − Σ cost_basis_at_sale` |
| F6 | Allocations sum exactly to the allocated total |
| F7 | Every lot cost adjustment traces to a purchase line |
| F8 | Opening returns are never summed with `TTEP` |
| F9 | Provider failure never yields a zero value |
| F10 | Raw prices never value graded cards |
| F11 | Frozen NOK conversions are never recomputed |
| F12 | An opening has at most one non-voided cost source |
| F13 | Trades produce no realized P/L while the item-leg rule is undecided |
| F14 | A holding with no resolvable market value is excluded from `CMV` and counted in `UHC` — never valued at zero |
