# Testing Strategy

Written before implementation so that autonomous work has a target rather than a retrofit.

Two suites are **mandatory gates**: the financial suite and the authorization suite. A milestone
that touches money or ownership is not complete until both pass.

---

## 1. Layers

| Layer | Tool | Needs | Runs |
|---|---|---|---|
| Domain unit | Vitest | Nothing | Every commit, every push |
| Property | Vitest + fast-check | Nothing | Every commit |
| Database | Vitest + Supabase | Local Supabase (Docker) or a dev project | Before merge, before migration |
| Authorization | Vitest, two authenticated clients | Same | Before merge |
| Component | Vitest + Testing Library | jsdom | Every commit |
| E2E | Playwright | Running app + seeded dev database | Before milestone completion |

**Compilation is not evidence.** A feature is complete when its behaviour has been exercised,
not when TypeScript accepts it.

---

## 2. Financial suite — mandatory

Lives in `tests/financial/`. Pure functions from `src/domain/`. No database, no mocks, no
network. This is the suite that must be trustworthy above all others.

### 2.1 Worked examples as fixtures

Every example in [FINANCIAL_MODEL.md](FINANCIAL_MODEL.md) §8 becomes a test with the same
identifier, asserting every metric in its table:

| Test | Covers |
|---|---|
| `E1` | Single purchase, unrealized result |
| `E2` | Three lots, one sold, specific-lot selection, `TTEP = URC + RRC` when all lots are costed |
| `E3` | Mixed receipt, pro-rata shipping allocation, `GPO = CS + HS` |
| `E4` | Opening a sealed product; collectible spend unchanged; pulls with `NULL` basis |
| `E5` | Selling a pull; proceeds not counted as profit; opening return |
| `E6` | Grading costs as lot adjustments; manual valuation; grading delta |
| `E7` | Partial sale from a multi-unit lot; frozen `cost_basis_at_sale` |
| `E8` | Manual valuation replacing a missing provider price |
| `E9` | Stale price retained and flagged; never zeroed |
| `E10` | Foreign-currency purchase with frozen NOK conversion |

If a formula changes, the document and these tests change together. A test that no longer matches
the document is a documentation bug, not a test to be adjusted quietly.

### 2.2 Invariants

One test per entry in the FINANCIAL_MODEL invariant register:

| ID | Assertion |
|---|---|
| M1 | No code path writes `0` where `NULL` is meant. Lots with `origin != 'purchase'` always have `NULL` basis. |
| F1 | `GPO = CS + HS` over randomised purchase sets |
| F2 | Buyer-paid shipping only offsets seller cost |
| F3 | `CMV = ACMV + UMV` |
| F4 | **A price update never mutates a cost-basis column.** Apply a full price refresh over a seeded portfolio; assert every cost basis byte-identical. |
| F5 | `RRC + PUD = NSP − Σ cost_basis_at_sale` |
| F6 | Allocations sum exactly to the total (property test, §2.3) |
| F7 | Every lot cost adjustment references a purchase line |
| F8 | No aggregate sums opening return with `TTEP` (static check plus review) |
| F9 | Simulated provider outage: values retained, states age, nothing reaches zero |
| F10 | A graded holding with no manual valuation resolves to `missing`, never to a raw price |
| F11 | Recomputing after an FX change leaves historical NOK amounts unchanged |

### 2.3 Property tests

The allocator is the highest-risk pure function in the system — it runs on every purchase and
every sale, and an off-by-one øre compounds silently.

```
∀ total ≥ 0, ∀ weights (non-empty, non-negative):
  Σ allocate(total, weights) === total          // exact, no drift
  allocate is deterministic for identical input
  every allocated part ≥ 0
  weights of 0 receive 0 unless total must be distributed to them
  a single weight receives the entire total
```

Also property-tested: minor-unit conversion round-trips; `quantity_remaining` never goes
negative under arbitrary disposal sequences.

---

## 3. Ownership timeline tests

Portfolio history is reconstructable from transactions (FINANCIAL_MODEL §3). That claim needs
proving, not asserting.

| Scenario | Expected |
|---|---|
| Card acquired day 30, priced from day 1 | Contributes 0 on days 1–29 |
| Card sold day 100 | Contributes 0 from day 100 onward; days 30–99 unchanged |
| Purchase backdated today to day 20 | History from day 20 changes — correctly |
| Price for day 40 corrected | Day 40 value changes; no other day moves |
| Full rebuild vs incremental recompute | **Byte-identical output.** The snapshot cache can never diverge from canonical transactions. |

The last row is the one that catches cache drift, which is the failure mode that makes a
dashboard quietly lie.

---

## 4. Authorization suite — mandatory

Lives in `tests/authorization/`. Two real users created through the real signup path, two
authenticated Supabase clients, every assertion against the live API — not against application
code that could be bypassed.

For every user-private table:

| Attack | Expected |
|---|---|
| A reads B's row by id | Empty result, not an error leak |
| A updates B's row by id | 0 rows affected |
| A deletes B's row by id | 0 rows affected |
| A inserts a row with `user_id = B` | Rejected by `WITH CHECK` |
| A updates their own row, setting `user_id = B` | Rejected by `WITH CHECK` |
| A inserts a child row pointing at B's parent | Rejected by trigger (S1) |
| A reads B's data through an embedded resource (`/purchases?select=*,purchase_lines(*)`) | No B rows |
| A reads B's data through an RPC with B's id as an argument | Rejected |
| A enumerates `profiles` | Only own row |
| A reads B's Storage objects | Denied (once storage exists) |

Plus invite-only enforcement:

| Attack | Expected |
|---|---|
| Direct `signUp` against the public API with no invitation | Rejected (S2) |
| Redeem an expired invitation | Rejected |
| Redeem a revoked invitation | Rejected |
| Redeem a single-use invitation twice | Second attempt rejected |
| Guess a token | Infeasible; only the hash is stored |
| Admin reads another user's purchases through the app API | Denied — `is_admin` grants no data access |

The suite is written table-driven so adding a table means adding a row, not a file. A new
user-private table without an entry fails a meta-test that compares the table list against the
covered list.

---

## 5. Database tests

Constraints and triggers, exercised directly:

- `holdings` check: exactly one of `card_variant_id` / `sealed_product_id`
- `holdings_identity` partial unique index prevents duplicate state rows
- `acquisition_lots` check: `origin = 'purchase'` ⟺ cost basis present (M1)
- `purchases` check: `total = subtotal + shipping + customs − discount`
- Invariant D1: `quantity_remaining = quantity − Σ non-voided disposals`, enforced by trigger
- Void guards: voiding a purchase whose lot has been sold is rejected, and the error names the
  blocking sale
- Voiding an opening restores the source lot and voids pull lots; blocked if a pull was sold
- Cascade on account deletion removes all user-private rows and no catalog rows
- Every migration applies to an empty database and to a seeded one

---

## 6. E2E

Playwright, against a seeded synthetic dataset. Both desktop (1440×900) and mobile
(iPhone viewport, 390×844) for every flow.

| Flow | Assertions |
|---|---|
| Redeem invitation → account exists → sign in with OTP | Session persists across reload |
| Sign out → protected route | Redirect to login, no data flash |
| Add a card manually | Appears in collection; correct lot; dashboard totals move by the right amount |
| Multi-line purchase with shipping | Allocation matches E3 exactly, visible in the UI |
| Foreign-currency purchase | Original and NOK both shown; rate prefilled |
| Sell part of a multi-lot holding | Lot selector works; remaining quantity correct; realized result matches E7 |
| Void a purchase with a downstream sale | Blocked with a message naming the sale |
| Stale price | Marker rendered; value retained |
| Collection with 2 000 seeded rows | List interactive; no unbounded query |
| CSV export | Downloads; row count matches; amounts parse |
| Install as PWA | Manifest valid, icons present, standalone mode, safe areas correct |

Console errors and failed network requests fail the test. A flow that renders correctly while
throwing in the console is not passing.

---

## 7. Performance

Not micro-benchmarks. Two checks that map to real failure:

- Dashboard first meaningful paint with 5 000 holdings and 12 months of snapshots: under 2 s on a
  throttled connection.
- Collection list with 5 000 rows: virtualised, no layout thrash, no N+1 query pattern. Asserted
  by counting network requests, not by timing.

---

## 8. Real-device checks

Emulation is not Safari. A manual checklist, recorded with dates in
[PROJECT_JOURNAL.md](PROJECT_JOURNAL.md):

- [ ] Install to iPhone home screen; correct icon and name
- [ ] Standalone launch, no browser chrome
- [ ] Safe areas correct with the home indicator, in both orientations
- [ ] Keyboard does not obscure form fields; numeric keypad for amount inputs
- [ ] Session survives an app switch and a cold start
- [ ] OTP email arrives and the code can be entered without leaving the app
- [ ] Camera permission persists through a scanner session (the R9 risk, when the scanner exists)
- [ ] Charts respond to touch; pinch and pan behave
- [ ] Android: install, launch, core flows

---

## 9. Test data

All fixtures committed to Git are synthetic. Real collection data never enters the repository.

Seeds live in `supabase/seed/` and produce: two users (for isolation tests), a small catalog
subset referencing real TCGdex ids (public facts, safe to reference), invented purchases with
round numbers chosen so allocation edge cases appear, one opening with tracked pulls, one
grading submission, one partial sale, one holding with a missing price and one with a stale
price.

Amounts are deliberately chosen to produce inexact division — a shipping charge of 100 over
three lines is worth more as a test than one of 90.

---

## 10. CI

Added when the application scaffold exists, not before — an empty pipeline in a docs-only
repository is noise.

```
install (frozen lockfile) → typecheck → lint → domain + property tests → build → secret scan
```

Database and authorization suites run on a schedule and before merges that touch migrations or
policies, since they need a live Postgres. E2E runs before milestone completion.

Migrations are applied deliberately through the Supabase CLI, never automatically from CI.
