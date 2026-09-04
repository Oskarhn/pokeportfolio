# Backlog

Work not currently scheduled. Themes, not microtasks. Scheduled work lives in
[ROADMAP.md](ROADMAP.md).

---

## Next — after MVP, high confidence

| Item | Note |
|---|---|
| Scanner | M15, first post-MVP milestone. All-card tracking makes manual entry the dominant cost of using the app. |
| Openings | M16. Fully modelled in the schema from MVP, so historical openings can be backdated once the workflow ships. |
| Grading workflow and profitability | M17. `raw_value_at_submission` is captured from MVP so the analysis remains possible. |
| Trades | M18. Schema complete; the item-leg accounting rule must be decided before the workflow is built. |
| Desktop bulk operations | Multi-select, batch condition, location, tags, collections, delete. |
| Restore from JSON backup | Export ships in MVP; import of a backup is the other half. |
| CSV import | Needed if existing collection data ever arrives. Format depends on the source. |
| Profile picture upload | Owner-requested (M7.1 prompt §52). Deferred rather than shipped without the safeguards SECURITY.md §7 already specifies for user uploads: private per-user storage paths, strict size/MIME validation, server-side re-encoding, EXIF stripping (phone photos carry GPS — a real disclosure risk for an inventory of valuables), signed URLs, no public bucket. See DECISIONS.md D-046. |
| Account reset / delete UI | The cascade behind account deletion is real as of M4 (every `user_id` FK to `auth.users` is `ON DELETE CASCADE`, SECURITY.md §8) but no application UI or RPC exists yet — needs explicit confirmation, re-authentication if current Supabase guidance supports it, and verification that deletion leaves zero orphaned rows. Owner-requested, M7.1 prompt §64. |
| Portfolio share links | Owner-requested toggle generating a read-only URL (M7.1 prompt §57). Already listed below as "Read-only share links" — restated here because M7.1 explicitly declined to build even a UI stub for it: a working-looking toggle that does nothing is worse than no toggle (M7.1 prompt §57's own instruction). |
| Trade Analyzer | Owner's exact future specification recorded in UX_FLOWS.md F15 (M7.1 prompt §48): create a trade, two sides (cards + optional cash), a fairness scale from "very good for user" to "bad for user". Needs real card values (shipped M9) and the trade workflow (M18) before the fairness calculation can be anything but fabricated. Portfolio's action-shortcut row (`PortfolioActionShortcuts.tsx`) still reserves its position. |

---

## Later — wanted, not yet justified

| Item | Blocked on / note |
|---|---|
| **Account-deletion cascade inventory is stale (M4 gap, flagged by M16/P50 — NOT bundled into M16)** | M4's `do` block cascaded only the tables that existed then (retailers, storage_locations, tags, purchases, purchase_lines, holdings, acquisition_lots, invitation_redemptions). Every user-private table added SINCE has a plain `user_id → auth.users(id)` FK with default NO ACTION: `holding_tags`, `manual_valuations`, `custom_collections`, `custom_collection_members` (M6/M7), `sales`, `sale_lines`, `lot_disposals`, `lot_cost_adjustments` (M10), and the M12 snapshot/queue/run tables. Deleting via the Supabase dashboard any user who owns one of those rows will fail with an FK violation today. NOT required for reset (explicit FK-deterministic deletes), not required by any opening FK path, so it stays OUT of M16 deliberately. Fix = one new migration re-running M4's constraint-rewrite loop over the full current inventory + an authorization/CI assertion that every `user_id` FK to auth.users carries ON DELETE CASCADE. |
| Trade item-leg accounting rule | Carryover versus fair value at trade date. Both defensible; needs a real decision, not a default. Blocks M18, nothing else. Frozen `cost_basis_at_disposal` keeps both options open. |
| Wishlist with target prices | Cheap once the catalog and pricing exist. Would extend `watched_card_variants` naturally. |
| Set completion tracking | Needs variant-level completeness rules. Master-set tracking is meaningfully harder than base-set tracking. |
| Price alerts | Requires notification delivery. Push on iOS works for installed PWAs but adds a subsystem. Owner-requested watchlist form (M7.1 prompt §58): notify when a held card's price moves by a threshold — needs M9's price history plus this delivery subsystem. No UI stub shipped in M7.1 (a toggle that does nothing is worse than none). |
| Read-only share links | Signed, expiring, scoped to a subset. Must not weaken RLS — a separate read path, not a policy exception. Owner-requested as a Profile toggle (M7.1 prompt §57); explicitly not implemented even as a UI stub until a real security design exists. |
| Own-card photography | Storage cost, EXIF stripping, re-encoding. Specified in SECURITY §7. |
| Receipt attachments | Same infrastructure as above. |
| Configurable condition multipliers | Only with real data behind them. See D-009 — inventing percentages was already rejected once. |
| Cross-language card equivalence | An explicit `card_equivalences` table with a confidence field. Not in primary keys. |
| Native iOS client | Reassess after six months of real use. Backend is already reusable. |
| Native Android client | Only if Android becomes a primary platform for someone. |

---

## Low priority

| Item | Why |
|---|---|
| Receipt OCR | Marginal benefit over typing a total. |
| Push notifications | Nothing yet worth interrupting someone for. |
| Multi-currency display | The model supports it; no user needs it. |
| Social features | Explicit non-goal. |
| Other trading card games | Explicit non-goal. |

### Follow-ups from the parallel Home/Search/quantity release (Prompt 30/33 LOW/INFO findings — not release blockers)

| Item | Why |
|---|---|
| M8.1 lock ordering | `remove_holdings_from_portfolio` (and the relevant void path) iterates multi-lot work in unordered plan order. Sorting by lot id removes the LOW deadlock class exposed by reduce_holding_quantity's sibling locking: Postgres always aborts one side safely, but one line of lock-order discipline closes it. |
| AdjustQuantitySheet full-lot UX | The per-lot Remove input permits requesting a full-lot reduction the server correctly refuses (lot-floor guard). Polish: clamp max to remaining − 1, or surface an inline "Void this lot instead" affordance when input equals the lot's full remaining quantity. |
| Concurrency test precision | The per-lot floor guard provably makes reduce_holding_quantity's aggregate pre-invariant and post-image guard unreachable defense-in-depth. A short comment correction in the migration/test should say so, so the test framing does not overstate what is demonstrated. |
| Instrumented concurrency proof | Add pg_locks/pg_stat_activity-based instrumentation asserting the second racing transaction is genuinely blocked, instead of depending on a timing stagger as proof of overlap. |
| 0ms anomaly investigation | Two simultaneous RPC calls once reported success with no persisted mutation in an intermediate, unshipped implementation of reduce_holding_quantity. That code path no longer exists in the shipped SQL and the scenario was re-verified clean under forced overlap in CI. Kept as a low-priority instrumentation/research item in case the mechanism could affect another RPC under the same harness conditions. Classified UNRESOLVED_BUT_NONBLOCKING (output_33). |
| Home privacy-eye ultra-narrow wrap | Optional UI polish: on extremely narrow widths the privacy eye may wrap away from the price it masks. |

---

## Research

| Question | Trigger |
|---|---|
| Cardmarket Product Catalogue: does it cover Pokémon sealed, and on what terms? (U2) | Sealed valuation improvement, V1 |
| Whether a paid pricing source becomes worth its cost (U6) | After six months of manual valuation in practice |
| TCGdex rate limits and price cadence in practice (U3, U4) | Observe our own ingest logs |
| Whether an on-device scanner is viable on current iPhones (S2, S6) | Throwaway spike before M15 |
| Image rights for a distributed scanner index artefact | Before any public artefact hosting |
| Node release model change from October 2026 | When pinning for the next cycle |

---

## Technical debt

| Item | Why |
|---|---|
| `tests/db/m9_valuation_resolver.test.ts` cross-file `price_snapshots` collision (found P99) | Fails 3/17 with `duplicate key value violates unique constraint "price_snapshots_unique_per_day"` (and a downstream stale/missing mismatch) when run as part of the FULL `pnpm test:db` suite, but passes 17/17 in isolation on a fresh reset — confirmed via `git diff` that the file itself is byte-identical to the M15 P90 base, so this is pre-existing, not a P99 regression. Root-cause hypothesis (not confirmed against the specific colliding file, given the time cost of auditing every earlier-running DB test file): `insertSnapshot` inserts against the SHARED `seedCatalog.pikachuVariantId` at a `daysAgo(N)`-derived date; some other file running earlier in the same suite invocation plausibly inserts a `price_snapshots` row for the same `(card_variant_id, provider, price_kind, snapshot_date)` tuple first. `m91_market_movers` and the M9 pricing-fixture block in `tests/db/m16_openings.test.ts` were both already isolated onto PRIVATE synthetic variants for exactly this class of problem (see their own comments) — `m9_valuation_resolver.test.ts` was not. Likely fix, same pattern as those two: give this file its own private synthetic card/variant instead of the shared `seedCatalog` one, or scope its snapshot dates away from what other files use. Not fixed this session — out of scope (P99's assigned flake was `tests/db/m16_openings.test.ts`'s E13, fixed separately) and the exact colliding file was not identified. |

---

## Rejected

Recorded so they are not proposed again without new information.

| Item | Why |
|---|---|
| Offline mutation queue with conflict resolution | Large, bug-prone, no evidence it is needed. Reads work offline; writes fail clearly. |
| Event sourcing the ledger | Normalised tables with explicit disposal rows already provide full provenance at a fraction of the complexity. |
| Averaging duplicate cost bases | Destroys provenance and makes realized results arbitrary. See D-001. |
| Aggregating low-value cards into bulk entries | Makes the interface tidy by making the data lossy. Organisation and filtering solve the same problem without discarding information. See D-017. |
| Email OTP or magic-link login | The built-in provider allows 2 auth emails/hour project-wide; fixing it means putting a third-party SMTP service on the critical path of every login. Password auth removes the dependency instead. See D-022. |
| A generic "labels" mechanism covering location, collection, tag and value | Four different kinds of fact with different lifetimes. Merging them makes a price movement look like the user moved a card. See D-018. |
| Materialising value-based groups as membership rows | Would require rewriting membership nightly as prices move — expensive and misleading. Smart filters are evaluated at read time. |
| Backfilling price history from current prices | Fabricated data. See D-008. |
| Valuing graded cards from raw prices | A PSA 10 trades at a large multiple of raw. Not an approximation — a fabrication. Invariant F10. |
| Per-card ROI for opening pulls | The question is not well-posed at card scale. Answered at opening scope instead. See D-002. |
| A monorepo | One deployable application. Workspace tooling would be pure overhead. |
| GraphQL | One consumer, one schema, PostgREST already generates typed access. |
| Tax reporting features | Explicit non-goal. Export carries enough provenance for external analysis. |
