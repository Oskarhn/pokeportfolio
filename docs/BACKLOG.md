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

---

## Later — wanted, not yet justified

| Item | Blocked on / note |
|---|---|
| Trade item-leg accounting rule | Carryover versus fair value at trade date. Both defensible; needs a real decision, not a default. Blocks M18, nothing else. Frozen `cost_basis_at_disposal` keeps both options open. |
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
| Whether an on-device scanner is viable on current iPhones (S2, S6) | Throwaway spike before M15 |
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
