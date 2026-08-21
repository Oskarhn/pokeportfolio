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
| Bulk "Remove from Portfolio" | M7.1 shipped select-mode bulk add/remove-to-collection and bulk favourite (all purely organisational, C1), but not bulk removal — that needs a real `bulk_void_lots(uuid[])`-style RPC: transaction-safe, guarding a purchase with a live downstream reference the same way `void_acquisition_lot` already does, never a hard `DELETE`. See DECISIONS.md D-045. |
| Profile picture upload | Owner-requested (M7.1 prompt §52). Deferred rather than shipped without the safeguards SECURITY.md §7 already specifies for user uploads: private per-user storage paths, strict size/MIME validation, server-side re-encoding, EXIF stripping (phone photos carry GPS — a real disclosure risk for an inventory of valuables), signed URLs, no public bucket. See DECISIONS.md D-046. |
| Account reset / delete UI | The cascade behind account deletion is real as of M4 (every `user_id` FK to `auth.users` is `ON DELETE CASCADE`, SECURITY.md §8) but no application UI or RPC exists yet — needs explicit confirmation, re-authentication if current Supabase guidance supports it, and verification that deletion leaves zero orphaned rows. Owner-requested, M7.1 prompt §64. |
| Portfolio share links | Owner-requested toggle generating a read-only URL (M7.1 prompt §57). Already listed below as "Read-only share links" — restated here because M7.1 explicitly declined to build even a UI stub for it: a working-looking toggle that does nothing is worse than no toggle (M7.1 prompt §57's own instruction). |
| Trade Analyzer | Owner's exact future specification recorded in UX_FLOWS.md F15 (M7.1 prompt §48): create a trade, two sides (cards + optional cash), a fairness scale from "very good for user" to "bad for user". Needs real card values (M9) and the trade workflow (M18) before the fairness calculation can be anything but fabricated. Portfolio's action-shortcut row (`PortfolioActionShortcuts.tsx`) already reserves its position. |
| Market Movers | Owner's future requirement (M7.1 prompt §49, UX_FLOWS.md F16): rank owned cards by price movement (highest increase, largest decrease, absolute, low movement). Needs M9's price history. Portfolio's action-shortcut row already reserves its position. |

---

## Later — wanted, not yet justified

| Item | Blocked on / note |
|---|---|
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
