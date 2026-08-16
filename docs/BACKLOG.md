# Backlog

Work not currently scheduled. Themes, not microtasks. Scheduled work lives in
[ROADMAP.md](ROADMAP.md).

---

## Next — after MVP, high confidence

| Item | Note |
|---|---|
| Openings | Phase 10. The second-most distinctive feature after the ledger. |
| Grading workflow and profitability | Phase 11. `raw_value_at_submission` is already captured in MVP so the analysis is possible later. |
| Scanner | Phase 12. Core product goal; late only because it depends on everything else working. |
| Desktop bulk operations | Multi-select, batch condition, location, tags, delete. Cheap once the collection view exists. |
| JSON backup and restore | The real escape hatch. CSV export in MVP is the interim answer. |
| CSV import | Needed if existing collection data ever arrives. Format depends on the source. |

---

## Later — wanted, not yet justified

| Item | Blocked on / note |
|---|---|
| Trades | Cost-basis rule undecided: carryover versus fair value at trade date. Both defensible; needs a real decision, not a default. Schema is ready (`origin = 'trade'`). |
| Wishlist with target prices | Cheap once the catalog and pricing exist. Would extend `watched_card_variants` naturally. |
| Set completion tracking | Needs variant-level completeness rules. Master-set tracking is meaningfully harder than base-set tracking. |
| Price alerts | Requires notification delivery. Push on iOS works for installed PWAs but adds a subsystem. |
| Read-only share links | Signed, expiring, scoped to a subset. Must not weaken RLS — a separate read path, not a policy exception. |
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

---

## Research

| Question | Trigger |
|---|---|
| Cardmarket Product Catalogue: does it cover Pokémon sealed, and on what terms? (U2) | Sealed valuation improvement, V1 |
| Whether a paid pricing source becomes worth its cost (U6) | After six months of manual valuation in practice |
| TCGdex rate limits and price cadence in practice (U3, U4) | Observe our own ingest logs |
| Whether an on-device scanner is viable on current iPhones (S2, S6) | Throwaway spike before Phase 12 |
| Image rights for a distributed scanner index artefact | Before any public artefact hosting |
| Node release model change from October 2026 | When pinning for the next cycle |

---

## Technical debt

Nothing yet — there is no code. Entries are added as they are incurred, with the reason they
were accepted at the time.

---

## Rejected

Recorded so they are not proposed again without new information.

| Item | Why |
|---|---|
| Offline mutation queue with conflict resolution | Large, bug-prone, no evidence it is needed. Reads work offline; writes fail clearly. |
| Event sourcing the ledger | Normalised tables with explicit disposal rows already provide full provenance at a fraction of the complexity. |
| Averaging duplicate cost bases | Destroys provenance and makes realized results arbitrary. See D-001. |
| Backfilling price history from current prices | Fabricated data. See D-008. |
| Valuing graded cards from raw prices | A PSA 10 trades at a large multiple of raw. Not an approximation — a fabrication. Invariant F10. |
| Per-card ROI for opening pulls | The question is not well-posed at card scale. Answered at opening scope instead. See D-002. |
| A monorepo | One deployable application. Workspace tooling would be pure overhead. |
| GraphQL | One consumer, one schema, PostgREST already generates typed access. |
| Tax reporting features | Explicit non-goal. Export carries enough provenance for external analysis. |
