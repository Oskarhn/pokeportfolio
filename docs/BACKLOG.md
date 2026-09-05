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
| `tests/db/m9_valuation_resolver.test.ts` cross-file `price_snapshots` collision (found P99) | **FIXED (P104).** Root cause confirmed by isolating exactly two files: `tests/db/m91_value_pagination.test.ts`'s `beforeAll` seeds `price_snapshots` for the shared `seedCatalog.pikachuVariantId`/`charizardVariantId`/`japaneseVariantId`/`grassEnergyVariantId`/`charizardShadowlessFirstEditionVariantId` at overlapping dates; Vitest's file-glob collection order is not stable across runs (both orderings reproduced locally with identical repo state, no code changes — the same full `pnpm test:db` invocation passed clean twice, then a targeted two-file run reproduced 3/17 failures deterministically), so `m9_valuation_resolver.test.ts`'s plain `.insert()` calls sometimes collided with `price_snapshots_unique_per_day`, and even where the exact tuple didn't collide, resolver reads could silently pick up the OTHER file's snapshot for the same shared variant (the third, non-error failure: a 45-day-old snapshot expected to resolve `missing` read back as `stale` because of a fresher 6-day-old row left by the other file). Fix: `m9_valuation_resolver.test.ts` now owns a PRIVATE card + 5 variants, the same pattern `m91_market_movers.test.ts` and `m16_openings.test.ts`'s own pricing fixture already used. Verified: the previously-failing two-file combination now passes in both file orders; 10 consecutive isolated re-runs against the same live database with no reset between them all pass 17/17 (this required a second fix — see next row). |
| `m9`/`m91_market_movers` private-fixture `afterAll` cleanup order (found P104) | **FIXED.** Both files' `afterAll` deleted the private `card_variants` rows BEFORE `deleteSyntheticUser` — but `holdings.card_variant_id` is `ON DELETE NO ACTION` (confirmed against `pg_constraint`), and the synthetic user's own holdings still reference those variants at that point, so the delete failed with a foreign-key violation that was silently swallowed (unchecked `.error` on a Supabase client call). The stray card/variant rows survived, and the NEXT run against the same database (any repeated invocation without a fresh `db:reset` in between — exactly what a flake-repro or CI-retry session does) collided on `cards_set_id_local_id_key`. Fixed by reordering both files' `afterAll` to call `deleteSyntheticUser` first (cascades the holdings), then delete the private catalog rows. Verified: 10/10 consecutive `m9_valuation_resolver.test.ts` re-runs and 3/3 consecutive `m91_market_movers.test.ts` re-runs against the same live database, no reset between runs. |
| `tests/db/m16_openings.test.ts` shares `seedCatalog.charizardVariantId`/`grassEnergyVariantId` (and others) for pull definitions across ~2000 lines (found P104, NOT fixed) | Same "M10 shared-catalog collision class" as the two rows above, but only reproduces under **file-order shuffling** (`vitest --sequence.shuffle.files`), not under the actual `pnpm test:db` gate — 3/3 consecutive natural-order full-suite runs this session were clean (604/604 every time). Under a shuffled file order, two tests in the "E4/E5 — pull tracking" and "P56 §8 — get_opening coverage counts" describes failed because another file's ambient `price_snapshots` row for the same shared variant made a pull that the test expects to stay unpriced resolve as priced instead (`priced_pull_lot_count` off by one/two). Not fixed this session: `m16_openings.test.ts` uses these shared variants dozens of times across many describe blocks (E1–E16, P53/P56/P59 layers) — moving it onto a private catalog is comparable in size and risk to a substantial rewrite of the file, disproportionate to a defect class that the actual CI/local gate never exercises (Vitest's default file order is not literally random each run, but it is not contractually alphabetical either — this should still be fixed properly before relying on file-order stability as a guarantee). Recommended fix, same pattern as the two rows above: give `m16_openings.test.ts` its own private card + variant set for pull definitions, or at minimum have its `beforeAll` clear `price_snapshots` for every shared variant it uses (the `m91_value_pagination.test.ts` "start from a clean slate" pattern) before each affected test. |
| `get_dashboard_summary()` exceeds the 1.5s Home-read budget at M12 snapshot-benchmark scale (found P104, ROOT-CAUSED P105, fix drafted but UNVERIFIED — blocked on a Docker Desktop outage) | P105 re-ran the benchmark (993.7-1337.6 ms across two fresh seeds — real run-to-run variance, both under budget but close to it) and captured a real `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` by extracting `get_dashboard_summary`'s single `return query` statement and substituting the session variables directly (plpgsql normally hides this behind an opaque Function Scan node). Confirmed: 733 of 838 ms (87.5%) is ONE `Function Scan` on `resolve_variant_market_values(...)`, 100% shared-buffer hits (no disk I/O — CPU-bound, not an N+1: it's called exactly once, per M9's own invariant). Extracting the resolver's own body and re-EXPLAINing isolated it further: the `latest_snapshot` CTE's `distinct on (card_variant_id, provider) ... order by card_variant_id, provider, snapshot_date desc` has no supporting index for that exact grouping — the existing `price_snapshots_variant_date_idx (card_variant_id, snapshot_date desc)` omits `provider`, so Postgres re-sorts nearly the whole table (~292k of ~294k rows at this benchmark's coverage) instead of streaming in DISTINCT ON order. Drafted fix: a covering index `price_snapshots_variant_provider_date_idx (card_variant_id, provider, snapshot_date desc) include (price_kind, source_currency, value_minor, provider_updated_at)`, dropping the now-redundant two-column index (its only other caller, `get_card_variant_price_history`'s `raw` CTE, filters on `card_variant_id` alone with no ordering of its own, so the new index's leading column serves it identically). NOT applied or tested — Docker Desktop crashed mid-session (a corrupted `sailor-ingest.sock` under `%LOCALAPPDATA%\Docker\run\`, Windows error 1920, survives killing every Docker process and needs a machine restart to clear) before this could be re-verified with a live `EXPLAIN`/benchmark re-run. A future session must apply the draft migration, re-run `EXPLAIN (ANALYZE, BUFFERS)` to confirm the plan actually changes (index-only scan, no sort node), and re-run the M12 benchmark for a real before/after number before treating this as closed. |
| `--pp-accent-soft`/`--pp-accent-wash` fail WCAG AA as foreground text on an accent-tinted wash — **FIXED (P105)** | Root-caused beyond the single Home-pill instance P104 found: `--pp-accent-soft` (sky-200/300/400) is IDENTICAL to `--pp-accent` in light mode (`#8f5f35` both — the P104-reported 3.78:1 case), and `--pp-accent-wash` (sky-100) as text on a `bg-sky-9xx/NN` wash computed to ~1.2-1.3:1 in BOTH themes (worse, and never axe-caught since it only renders after an interaction — LineEditor's "card selected" chip, ExportPage's "backup ready" panel). Fixed ~20 files by swapping the TEXT color to `text-slate-200`/`text-slate-300` (this app's own already-proven neutral tokens) while leaving the accent border/background as the visual cue — a LOCAL class-usage fix, not a change to `--pp-accent`/`--pp-accent-soft`/`--pp-accent-wash` themselves (P103 owns global accent-token work). Permanent regression guard: `tests/ui/accent-wash-contrast.test.ts`. |
| `amber-*` Tailwind classes are off-vocabulary (not part of the themed slate/sky/rose/emerald remap) — **FIXED (P105)** | All 9 files P104 flagged as "not confirmed broken, not confirmed fine" computed by hand (WCAG relative-luminance formula, OKLCH values read directly from the installed `tailwindcss@4.3.3` package). Real failures in all 9 (1.4-2.1:1 in light mode — amber's vivid stops are light accents meant for dark backgrounds, and this app never remapped amber for light mode at all): `MoneyDisplay`'s stale-price badge, `OpeningsWizardPage`'s gate-error banner (fixed to the already-dual-themed rose/`--pp-negative-*` error-box pattern instead, since it's a genuine `role="alert"`), the Portfolio/Catalog favourites toggle, three `OpeningDetailPage` markers, three favourite-star glyphs, and `GridTile`'s stale-price dot (non-text, 2.13:1 against the 3:1 threshold). No new `--pp-notice-*` token was added (the recommendation this row previously made): `amber-950` would need to mean both "subtle badge wash" (light tint) AND `StaleDeploymentBanner`'s deliberately dark, near-opaque banner background in the same app — one token can't serve both without breaking one of them — so each fix used whichever EXISTING themed vocabulary actually fit the semantic instead. `StaleDeploymentBanner` (11.8-13.6:1, genuinely fine) and `ScannerPage`'s `?scannerDebug=1`-gated debug overlay (never shown by default) are left alone, individually verified/scoped rather than swept up. Permanent allowlist guard: `tests/ui/amber-vocabulary-guard.test.ts`. |

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
