# Roadmap

Ordered by dependency, not by time. No date estimates.

Status: **Done** · **In progress** · **Planned** · **Deferred**

---

## Phase 0 — Discovery · Done

Product definition, competitor review, feasibility research, decision consolidation.

---

## Phase 1 — Foundation · Done

Canonical documentation, financial model, data model, architecture, security model, test
strategy, toolchain, Git and GitHub foundation. No application code.

---

## Phase 2 — Scaffold · Planned · **next**

The first code. Ends with an empty but deployable application and a green pipeline.

| # | Milestone | Done when |
|---|---|---|
| 2.1 | Vite + React + TS project, strict config, pnpm, lint, format | `pnpm check` passes on an empty app |
| 2.2 | Supabase project, `eu-north-1`, first migration, generated types | Migration applies from scratch; types compile |
| 2.3 | Domain layer skeleton: `Money`, allocator, currency table | Allocator property tests pass (F6) |
| 2.4 | Test harness: Vitest, fast-check, Playwright, two-client authorization fixture | A deliberately failing isolation test actually fails |
| 2.5 | CI: install, typecheck, lint, test, build, secret scan | Green on a pull request |
| 2.6 | PWA shell: manifest, icons, service worker, safe areas, theme | Installs on iPhone; standalone launch correct |

Gate: `pnpm check` green, CI green, app deploys, PWA installs.

---

## Phase 3 — Identity · Planned

| # | Milestone | Done when |
|---|---|---|
| 3.1 | Schema: `profiles`, `invitations`, redemptions, RLS | Policies applied, `WITH CHECK` on every write |
| 3.2 | `redeem-invitation` Edge Function + `auth.users` trigger backstop | Direct public signup is rejected (S2) |
| 3.3 | Email OTP login, session persistence, sign-out | Full flow works inside an installed PWA |
| 3.4 | Admin invitation management | Create, label, revoke, expire |
| 3.5 | Authorization suite v1 | Every attack in TESTING §4 covered and passing |

Gate: the authorization suite is green and a fresh attempt at unauthorised signup fails.

---

## Phase 4 — Catalog and collection · Planned

| # | Milestone | Done when |
|---|---|---|
| 4.1 | Catalog schema + TCGdex ingest for sets, cards, variants (EN + JA) | Catalog populated; provider ids mapped |
| 4.2 | Card search: name, set, collector number, variant selection | Fast on mobile; usable with 23k cards |
| 4.3 | `holdings` + `acquisition_lots` schema, RLS, triggers | D1 and S1 enforced and tested |
| 4.4 | Add to collection manually; condition, language, quantity, origin | Three copies at three prices become three lots |
| 4.5 | Collection list and detail: filters, sort, lot breakdown | 2 000 seeded rows stay interactive |
| 4.6 | Storage locations, tags, favourites | |

Gate: a real card can be added, found, filtered and inspected with its lots visible.

---

## Phase 5 — Money in · Planned

The permanent ledger. The highest-priority product area.

| # | Milestone | Done when |
|---|---|---|
| 5.1 | `purchases` + `purchase_lines` schema, retailers | Check constraints enforced |
| 5.2 | Allocation engine wired into purchase writes | E3 reproduced exactly, in the database |
| 5.3 | Purchase entry: multi-line, backdating, shipping, customs, discount | Allocation visible and explained in the UI |
| 5.4 | Foreign currency + Norges Bank FX ingest, manual override | E10 reproduced; frozen conversion verified (F11) |
| 5.5 | Purchase creates holdings and lots in one step | |
| 5.6 | Spending ledger view: monthly, per retailer, collectible vs hobby | F1 holds on real data |
| 5.7 | Void semantics and guard rules | Voiding a referenced purchase is blocked with a naming error |

Gate: financial suite green against database-backed data, not just in-memory fixtures.

---

## Phase 6 — Valuation · Planned

| # | Milestone | Done when |
|---|---|---|
| 6.1 | `price_snapshots`, `watched_card_variants`, retention | Storage projection matches R13 |
| 6.2 | `ingest-prices` Edge Function + pg_cron | Idempotent; per-variant failure isolation |
| 6.3 | Valuation resolver: manual → fresh → stale → missing | F9, F10 verified with a simulated outage |
| 6.4 | Manual valuation with provenance | Both automatic and manual values inspectable |
| 6.5 | Freshness indicators throughout the UI | Stale and missing are visible, not silent |

Gate: a provider outage degrades gracefully and nothing reaches zero.

---

## Phase 7 — Sealed and sales · Planned

| # | Milestone | Done when |
|---|---|---|
| 7.1 | Sealed products in the catalog; sealed holdings and lots | Sealed valued manually, marked as such |
| 7.2 | `sales` + `sale_lines`, explicit lot selection with FIFO suggestion | E7 reproduced; `cost_basis_at_sale` frozen |
| 7.3 | Realized vs unattributed proceeds, correctly separated | F5 holds |
| 7.4 | Sales history and per-sale detail | |

Gate: selling part of a multi-lot holding produces correct figures and correct history.

---

## Phase 8 — Dashboard · Planned

| # | Milestone | Done when |
|---|---|---|
| 8.1 | `portfolio_snapshots` + recompute queue | Full rebuild equals incremental, byte-identical |
| 8.2 | `lightweight-charts` spike | Validated or replaced with visx before building on it |
| 8.3 | Value over time, monthly spend | Ownership timeline correct (TESTING §3) |
| 8.4 | Headline figures, breakdowns, recent activity | Terminology matches FINANCIAL_MODEL §9 |
| 8.5 | Empty, loading and error states | An empty account looks intentional, not broken |

Gate: figures reconcile against the ledger; no metric is mislabelled.

---

## Phase 9 — MVP completion · Planned

| # | Milestone |
|---|---|
| 9.1 | CSV export with full provenance |
| 9.2 | Settings: theme, locale, account deletion with export offer |
| 9.3 | E2E suite across desktop and mobile viewports |
| 9.4 | Real-device iPhone pass |
| 9.5 | Performance pass at 5 000 holdings |
| 9.6 | Documentation reconciled with what was actually built |

**MVP is complete here.** Usable daily: record everything bought and owned, see its value, sell,
export.

---

## Phase 10 — Openings · Planned (V1)

| # | Milestone |
|---|---|
| 10.1 | `openings` schema, sealed lot consumption, provenance preserved |
| 10.2 | Opening entry: linked or manual cost, pack count, tracked pulls |
| 10.3 | Bulk remainder estimate; completeness flag |
| 10.4 | Opening return, with incompleteness markers everywhere it appears |
| 10.5 | Sold pulls remain attributable to their opening |
| 10.6 | Opening history and per-set analysis |

Gate: E4 and E5 reproduced end to end. No pull shows a zero cost basis or a per-card ROI.

---

## Phase 11 — Grading · Planned (V1)

Submissions, state transitions, `lot_transfers` from raw to graded holdings, cost attribution
via `lot_cost_adjustments`, `raw_value_at_submission` captured, profitability analysis.

Gate: E6 reproduced. A graded card is never valued from a raw price.

---

## Phase 12 — Scanner · Planned (V1)

| # | Milestone |
|---|---|
| 12.1 | Re-research the recognition stack — do not inherit 2026-08 model choices |
| 12.2 | Offline pipeline: embeddings for the catalog, index artefact, hosting strategy |
| 12.3 | Single-route camera session, one `MediaStream`, in-route overlay (D-006) |
| 12.4 | Recognition with candidate list and confidence threshold |
| 12.5 | Bulk session: session defaults, per-card override, fast rescan |
| 12.6 | Manual search fallback |
| 12.7 | Real-device iOS validation of camera permission persistence (R9) |

Gate: bulk entry is measurably faster than manual search, verified against a real stack of cards.

---

## Phase 13 — V1 completion · Planned

Desktop bulk operations, richer statistics, JSON backup and restore, CSV import, images and
receipts, PWA polish, Android verification, accessibility pass.

---

## Deferred

Trades · wishlist and target prices · set completion · price alerts · read-only share links ·
push notifications · receipt OCR · native iOS and Android clients · configurable condition
multipliers · cross-language card equivalence · paid pricing sources.

None are being built. The data model preserves the cheap ones. See [BACKLOG.md](BACKLOG.md).

---

## Ordering rationale

Money before value: the ledger is the product's distinguishing feature and the least dependent
on unreliable external data. Value before dashboard: charts need something honest to plot.
Sealed and sales before openings: openings consume sealed lots and produce sellable pulls, so
both mechanisms must be solid first. Scanner late: it is the highest-risk, most research-dependent
piece, and it needs a working collection to write into. Scanner late is a sequencing decision,
not a downgrade — bulk entry speed is a core product goal.
