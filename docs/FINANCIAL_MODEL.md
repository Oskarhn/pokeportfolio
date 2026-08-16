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
"not applicable / not known", never "0". This distinction is load-bearing for opening pulls (§5).

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
| **Attributed-cost market value** | `ACMV` | `CMV` restricted to lots where `unit_cost_basis_minor IS NOT NULL`. |
| **Unattributed market value** | `UMV` | `CMV` restricted to lots where `unit_cost_basis_minor IS NULL` (opening pulls, gifts). |
| **Unvalued holdings count** | `UHC` | Count of open lots with no resolvable value. Surfaced in the UI; never silently dropped. |

> **Invariant F3:** `CMV = ACMV + UMV`.

### 2.5 Cost basis

| Term | Symbol | Definition |
|---|---|---|
| **Direct unit cost basis** | — | `acquisition_lots.unit_cost_basis_nok_minor`. Set only when the lot traces to a purchase line. `NULL` otherwise. |
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
| **Proceeds from unattributed disposals** | `PUD` | Σ over sale lines where `cost_basis_at_sale IS NULL` of `allocated_net_proceeds`. A pure inflow. **Not** a gain — there is no cost to subtract at item level. |
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
basis of `333` with a `+1` residual on the lot so `Σ = 1000`.

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

For an opening with no recorded purchase, `cost_source = 'manual'` and the user supplies a cost.
That manual cost does **not** enter `CS` — it never left a bank account within this system —
and opening ROI is flagged as based on an unverified cost.

---

## 6. Market value resolution

For each open lot, exactly one value is resolved, in priority order:

| Priority | Source | `price_state` |
|---|---|---|
| 1 | Active manual valuation for the holding | `manual` |
| 2 | Provider snapshot ≤ 3 days old | `fresh` |
| 3 | Provider snapshot 4–30 days old | `stale` — value used, flagged in UI |
| 4 | Provider snapshot > 30 days old, or none | `missing` — **excluded from `CMV`**, counted in `UHC` |

Provider price selection for raw cards (Cardmarket, EUR):

1. `trend`
2. `avg30` if `trend` is absent
3. `avg7`, then `avg` — each fallback recorded in `price_kind` so provenance is inspectable

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
| `PUD` | Proceeds, opening pulls |
| `TTEP` | Overall position |
| `UHC` | Holdings without valuation |

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
- graded market value derived from raw prices.

Export carries enough provenance (transaction dates, original currency, FX rate and source,
cost basis, disposal records) that external tax analysis is possible later.

---

## 11. Invariant register

Every invariant below has a corresponding automated test. See [TESTING.md](TESTING.md).

| ID | Invariant |
|---|---|
| M1 | `NULL` money never means zero |
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
