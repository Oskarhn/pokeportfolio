# P132-C independent finance regression package (P130-01 / P130-03)

Implementation-agnostic tests that a correct remediation of **P130-01** (sealed lot split followed
by a receipt edit fabricates units and basis) and **P130-03** (correction RPCs race `create_sale`)
must satisfy. Written against the released tree (`cb588c4`) without reading any remediation branch.
Test and harness code only: no migration, no product SQL, no `src/` change.

## Run

Needs Docker. Boots its own disposable Postgres (`public.ecr.aws/supabase/postgres:17.6.1.158`,
`--network none`) from **this checkout's** `supabase/migrations/` and the synthetic catalog seed,
then removes it.

```bash
pnpm exec vitest run --config test/p132c-finance-regressions/vitest.config.ts
```

| Variable | Effect |
|---|---|
| `P132C_PG_CONTAINER=<name>` | Attach to an existing container that already has every migration applied (e.g. a local stack's `supabase_db_*`). Only the hosted-ingest cron isolation is enforced there. |
| `P132C_KEEP_CONTAINER=1` | Do not remove the disposable container afterwards. |
| `P132C_SM_COUNT` / `P132C_SM_BASE` / `P132C_SM_SEED=a,b` / `P132C_SM_STEPS` | State-machine sequences (default 30 × 28 steps, seeds from 1320001). |
| `P132C_SM_STRICT=1` | Make the extended invariant codes (below) fatal in the state machine. |
| `P132C_DL_ITERATIONS` / `P132C_DL_BASE` / `P132C_DL_SEED=n` | Deadlock search (default 80 iterations from seed 4242). Use 500+ for a stress run. |
| `P132C_DL_STRICT=1` | Make extended codes fatal in the deadlock search. |

`harness/boot-keep.ts` boots a database and leaves it running for manual experiments.

## Isolation (P130-12)

Any database holding every migration schedules cron jobs that POST to the hosted ingest functions.
The disposable container has no network at all, and `startDb` deactivates the two
`/functions/v1/ingest-(prices|fx)` jobs immediately after the migration that schedules them and
asserts none is active before a test runs. In a container it owns it also deactivates the two M12
recompute cron jobs: they take the same per-user queue-row lock every ledger write takes and would
add a random third lock holder to the concurrency tests.

## Acceptance rule (every test)

An operation either **succeeds and leaves every invariant intact**, or is **refused with a stable
domain error** (SQLSTATE class `P0`, `22023`, `55000`, or an explicit `40001`) **and changes
nothing**. No fix policy is assumed for ambiguous edits (for example a quantity change on a split
line): refusing and redistributing are both accepted. A raw constraint violation (class `23`), a
deadlock (`40P01`) or any other error is a failure. Violations already present before an operation
are not attributed to it.

## Invariants (`harness/invariants.ts`)

Derived from the schema and FINANCIAL_MODEL, not from any function body.

| Code | Rule |
|---|---|
| `LOT_D1` | live lot: `quantity_remaining == quantity − Σ non-voided disposal quantity` |
| `LOT_OVERSOLD`, `LOT_RANGE` | live disposals never exceed the lot; `0 ≤ remaining ≤ quantity` |
| `VOIDED_LOT_LIVE_DISPOSAL` | a voided lot has no live disposal (sold/opened inventory is never voided) |
| `LINE_LOT_QUANTITY` | live purchase, card/sealed line with a live lot: `Σ live lot quantity == line quantity − units the owner removed` |
| `LINE_BASIS_NOK`, `LINE_BASIS_TXN` | known basis, nothing removed: `Σ(unit basis × qty + residual) == line attributable cost`, in NOK and in the receipt currency |
| `LOT_BASIS_CURRENCY`, `LOT_UNIT_BASIS_STALE` | lot basis currency is the receipt's; unit basis within one minor unit of `attributable / line quantity` |
| `KNOWN_BASIS_MISSING`, `NULL_BASIS_FABRICATED` | known basis stays complete; unknown / not-paid / unallocated basis stays `NULL` |
| `VOIDED_PURCHASE_LIVE_LOT` | a voided purchase has no live lot |
| `LINE_QUANTITY_WITHOUT_LIVE_LOTS` | a line whose lots were all removed keeps `line quantity == removed units` |
| `SALE_*` | sale ⇔ disposal state and shape agree; NULL basis ⇒ NULL frozen basis and NULL realized; realized is NULL iff no line was costed |
| `OPENING_*` | opening ⇔ its opened disposal agree; a voided opening has no live pull lot; unknown source cost ⇒ NULL opening cost |

"Units the owner removed" is the only model state: the pre-operation quantity of purchase-line lots
that a successful operation voided while the purchase stayed live.

## Files

| File | What it covers |
|---|---|
| `p130-01-split-edit.test.ts` | exact P130-01 reproduction; metadata / price / shipping / FX / quantity (up, down, below sibling) edits after a split; repeated splits; allocations across lines; EUR; removed sibling (no resurrection); sold and voided-sale siblings; controls a fix must not break (ordinary single-lot edit must succeed) |
| `null-basis.test.ts` | unknown and not-paid sealed lots split and sold; shared holding with a known split line (edit never touches the unknown lot); mixed-basis sale; opening from unknown cost; held race with NULL basis |
| `state-machine.test.ts` | seeded sequences of purchase, split, metadata/cost/quantity edit, sale, void sale, void lot, remove holding, void purchase, opening, void opening, unknown/known acquisition — acceptance rule after every step |
| `p130-03-concurrency-matrix.test.ts` | 32 held-lock rows, both start orders (table below) |
| `deadlock-search.test.ts` | seeded 2- and 3-session permutations, gated and free (see file header) |
| `harness/` | disposable DB, psql sessions, snapshots, RPC builders, invariants, lock observer, PRNG |

## Concurrency method

The first operation runs inside `BEGIN` and finishes its statement holding its locks. The second is
issued; a superuser observer polls `pg_stat_activity` / `pg_blocking_pids` until the second is
lock-blocked or finished; then the first commits and the second is awaited. Interleavings are fixed
by lock state, not sleeps, so each row is deterministic on a given implementation.

The deadlock search additionally holds the user's `portfolio_recompute_queue` row from a third
session. Every ledger write upserts that row part-way through its RPC, so each RPC parks at its first
write holding whatever row locks it already took; releasing the row lets them continue in FIFO order.
An RPC that writes before locking the lots a concurrent sale needs deadlocks deterministically.

## Matrix (released base `cb588c4`)

`first held → second`; "base" is the committed result on the audited tree.

| Row | Operation A (held) → B | Lots | Base |
|---|---|---|---|
| M01 | sale → update_purchase (price) | one | **LOT_D1** (sold unit sellable again) |
| M02 | update_purchase → sale | one | ok |
| M03 | sale → void_purchase | one | **VOIDED_LOT_LIVE_DISPOSAL** |
| M04 | void_purchase → sale | one | sale refused, ok |
| M05 | sale → void_acquisition_lot | one | **VOIDED_LOT_LIVE_DISPOSAL** |
| M06 | void_acquisition_lot → sale | one | sale refused, ok |
| M07 | sale → remove_holdings_from_portfolio | one | **VOIDED_LOT_LIVE_DISPOSAL** |
| M08 | remove_holdings → sale | one | sale refused, ok |
| M09 | sale of pull lot → void_opening | pull | **VOIDED_LOT_LIVE_DISPOSAL** |
| M10 | void_opening → sale of pull lot | pull | sale refused, ok |
| M11 | sale sibling K → update_purchase | split | **P130-01 sums** |
| M12 | sale sibling O → update_purchase | split | **P130-01 sums** |
| M13 | update_purchase → sale sibling K | split | **P130-01 sums** |
| M14 | sale K → void_purchase | split | **VOIDED_LOT_LIVE_DISPOSAL** |
| M15 | sale K → remove_holdings (both siblings) | split | **VOIDED_LOT_LIVE_DISPOSAL** |
| M16 | remove_holdings → sale K | split | sale refused, ok |
| M17 | sale K → void_acquisition_lot O | split | **VOIDED_PURCHASE_LIVE_LOT** (sequential defect, see below) |
| M18 | void_acquisition_lot O → sale K | split | **VOIDED_PURCHASE_LIVE_LOT** |
| M19 | sale 1 of O → split 2 of O | split | ok *(extended)* |
| M20 | sale all of O → split 2 of O | split | **raw 23514** *(extended)* |
| M21 | split 2 of O → sale all of O | split | sale refused, ok *(extended)* |
| M22 | update_purchase → void_acquisition_lot | one | ok |
| M23 | void_acquisition_lot → update_purchase | one | ok |
| M24 | update_purchase → update_purchase | split | **P130-01 sums** |
| M25 | void_purchase → update_purchase | one | ok |
| M26 | remove_holdings → void_purchase | split | ok |
| M27 | sale → void_sale (same lot) | one | ok *(extended; serialised only incidentally by the M12 queue row)* |
| M28 | void_sale → sale (same lot) | one | ok *(extended)* |
| M29 | sale on opened source lot → void_opening | source | **LOT_D1** *(extended)* |
| M30 | void_opening → sale on source lot | source | ok *(extended)* |
| M31 | sale 2 → sale 2 of a 3-unit lot | one | second refused, ok (control) |
| M32 | sale sibling O → sale sibling K | split | ok (control) |

Every second session waited for the first on base as well: the per-user recompute queue row
serialises the writes, but not the stale reads each correction RPC made before its first write.

## Extended findings (outside P130-01/03 text, found by this package on the released base)

1. `void_acquisition_lot` on one sibling of a split single-line purchase voids the whole purchase
   while the other sibling is still live inventory (auto-void counts other *lines*, not other lots of
   the same line). `VOIDED_PURCHASE_LIVE_LOT`; M17/M18; `p130-01-split-edit.test.ts` extended block.
2. `void_opening` racing a sale on the opened **source** lot: the D1 recompute trigger sums disposals
   before its UPDATE waits on the sale's lock, then writes the stale sum. `LOT_D1`; M29.
3. `set_sealed_lot_intent` racing a sale validates a stale `quantity_remaining`; the CHECK constraint
   stops the write with a raw `23514` instead of a domain refusal. M20.
4. `update_purchase` changes the quantity of a line whose every lot was removed, leaving units that
   are neither inventory nor removed. `LINE_QUANTITY_WITHOUT_LIVE_LOTS` (state machine).
5. Deadlocks (`40P01`) between correction RPCs and `create_sale` on base, deterministic with the
   gate: e.g. `void_purchase ‖ sale`, `update_purchase ‖ remove_holdings`.

Codes 1 and 4 are tolerated (counted, printed) by default in the state machine and deadlock search so
they cannot hide a P130-01/03 violation; set `*_STRICT=1` to make them fatal. Matrix rows marked
*extended* run in their own `describe` block.
