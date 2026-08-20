# Roadmap

Ordered by dependency, not by time. No date estimates.

Status: **Done** · **In progress** · **Planned** · **Deferred**

Scope is frozen — see [PLANNING_FREEZE.md](PLANNING_FREEZE.md). Milestones may be resequenced on
dependency grounds; scope may not be widened without reopening the freeze.

---

## Phase 0 — Discovery · Done

Product definition, competitor review, feasibility research.

## Phase 1 — Foundation · Done

Canonical documentation, financial model, data model, architecture, security model, test
strategy, zero-cost policy, toolchain, private GitHub repository. No application code.

---

## Implementation milestones

Each milestone is a reviewable unit ending in a working, tested increment. **Not one enormous MVP
branch.** A milestone is complete only when its gate passes; the gate is behaviour, never
compilation.

### M1 — Scaffold and harness · **next**

Vite + React 19 + TypeScript strict. pnpm pinned via Corepack. ESLint, Prettier, Vitest,
fast-check, Playwright. `pnpm check` as the single gate command. GitHub Actions: install →
typecheck → lint → test → build → secret scan.

**Gate:** `pnpm check` green on an empty app; CI green on a pull request.

### M2 — Domain and money

`Money` type (integer minor units + ISO 4217), currency table with per-currency minor-unit
exponents, largest-remainder allocator, FX conversion helpers. Pure TypeScript, zero
dependencies on React or Supabase.

**Gate:** allocator property tests pass (F6); worked examples E1, E3 and E7 reproduce exactly in
memory; a deliberately broken allocation fails the suite.

### M3 — Database, RLS and migration tooling

Supabase project (`eu-north-1`, free plan). Migration tooling. Schema for catalog, profiles,
invitations, holdings, lots, purchases. RLS on every table with `WITH CHECK`. Denormalised
`user_id` with parent-match triggers. Generated TypeScript types.

**Gate:** migrations apply to an empty and a seeded database; the two-client authorization
fixture exists and a deliberately failing isolation test actually fails.

### M4 — Auth and invitations

Email + password. `redeem-invitation` Edge Function as the sole account-creation path, with the
`auth.users` trigger backstop. Admin invitation management. Password reset via low-volume
built-in email with an admin-assisted fallback.

**Gate:** direct public signup is rejected (S2); the full authorization suite passes; login
works inside an installed PWA on a phone.

### M5 — Catalog and search

TCGdex ingest for sets, cards and variants, English and Japanese. Provider id mapping. Card
search by name, set and collector number. Verify Basic Energy coverage and variant modelling
during ingest — this is a known unknown.

**Gate:** search is fast on mobile across the full catalog; energies are findable and selectable
as ordinary cards.

### M6 — Collection: holdings, lots, origin

Add cards manually. Acquisition origin and `cost_basis_state`. Quantity grouping with lot detail.
Condition, storage location, tags, favourites. Graded cards as a collection type with manual
value.

**Gate:** three copies at three prices become three lots under one holding; a gift shows no cost
field and no zero; energies and no-price cards can be added.

### M7 — Organisation and display

Custom collections (many-to-many). Smart filters: low-value threshold, missing price. Grid
density 1–4 with 2 as default, persisted per user. List and desktop table views. Keyset
pagination and virtualisation.

**Gate:** 10 000 seeded lots stay interactive on a phone; density changes persist across
sessions; deleting a collection touches no holding (C1).

### M8 — Purchases and the spending ledger

Multi-line purchases, retailers, shipping, customs, discounts, backdating. Allocation engine
wired into writes. Foreign currency with Norges Bank FX and manual override. Collectible versus
hobby split. Void semantics and guard rules.

**Gate:** E3 and E10 reproduce in the database; `GPO = CS + HS` holds on real data (F1); voiding
a referenced purchase is blocked with an error naming the blocker.

### M9 — Pricing and snapshots

`price_snapshots`, `watched_card_variants`, retention thinning. `ingest-prices` and `ingest-fx`
Edge Functions on `pg_cron`. Valuation resolver: manual → fresh → stale → missing. Freshness
indicators throughout.

**Gate:** a simulated provider outage degrades gracefully and nothing reaches zero (F9, F14);
snapshot volume matches the projection.

### M10 — Sales and History

Sales with explicit lot selection and FIFO suggestion. Frozen `cost_basis_at_sale`. Realized
versus uncosted proceeds. The History area: Sold, Traded, Other.

**Gate:** E2 and E7 reproduce; a sold gift shows proceeds and a result of **—**; sorting by
result does not rank unknown-basis rows as infinite profit.

### M11 — Sealed inventory

Sealed products in the catalog. Sealed holdings with intent. Manual valuation with provenance.
Sealed segment in collection value.

**Gate:** sealed value is visibly manual; a sealed holding with no valuation is counted, not
zeroed.

### M12 — Dashboard

`portfolio_snapshots` with a recompute queue. `lightweight-charts` spike — validate or fall back
to visx before building on it. Value over time, monthly spend, headline figures, data-quality
counts.

**Gate:** full rebuild equals incremental recompute, byte-identical; ownership timeline correct
(TESTING §3); every figure reconciles against the ledger.

### M12a — Visual design refinement

Not scheduled by date — it happens once M6, M7, M8 and M12 give the owner enough real surface
(collection, organisation, purchases, dashboard) to react to actual screens rather than
descriptions. Until this milestone, the UI stays deliberately basic and neutral per
[docs/DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) §0 — building final visual polish earlier would mean
redoing it against references that do not exist yet.

1. Owner supplies reference screenshots/images and, separately, a logo.
2. Analyse the references for layout density, spacing, typography, navigation, component
   appearance, chart treatment, card presentation and colour direction — direction, not
   pixel-for-pixel reproduction of anyone else's proprietary design.
3. Update [docs/DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) with the resulting concrete tokens.
4. Apply the redesign through the existing token system (§0's centralization requirement is what
   makes this step bounded rather than a rewrite).
5. Integrate the owner's logo through the single swap point established in M3/early milestones.
6. Browser-test the result on mobile and desktop viewports.

**Gate:** the app visually matches the agreed direction from the references; no proprietary
design is reproduced pixel-for-pixel; the placeholder PWA icon set is fully replaced.

### M13 — Export and backup

CSV exports. Versioned JSON backup with schema version and export timestamp. In-app export
reminder. Local dump script.

**Gate:** a JSON backup round-trips; amounts parse; the version envelope is present.

### M14 — MVP hardening

E2E suite across desktop and mobile viewports. Real-device iPhone pass. Performance pass at
10 000 lots. Accessibility pass. Documentation reconciled with what was actually built.

**MVP complete.**

---

## Post-MVP

### M15 — Scanner  · V1 priority 1

Ahead of openings, deliberately: all-card tracking makes manual entry the primary usability
bottleneck, and the scanner is what removes it.

1. Re-research the recognition stack. Do not inherit the August 2026 model choices.
2. Validate on real hardware that camera permission survives an in-route session (R9/S6) —
   with a throwaway page, **before** building anything.
3. Offline pipeline: catalog embeddings, index artefact, hosting strategy.
4. Single-route camera session, one `MediaStream`, in-route overlay (D-006).
5. Recognition with candidate list and confidence threshold.
6. Session defaults: origin, opening, condition, language, storage location, custom collection,
   cost handling.
7. Batch review before save; manual search fallback.

**Gate:** measurably faster than manual search against a real stack of cards, verified with a
timed comparison.

### M16 — Openings · V1 priority 2

Full lifecycle. All-cards tracking by default, hits-only option, bulk remainder estimate.
Opening return in kroner first. Provisional-cost reconciliation UI.

**Gate:** E4, E5 and E13 reproduce end to end. No pull shows a zero cost basis or a per-card ROI.
Reconciliation cannot double-count (F12).

### M17 — Grading workflow

Submissions, state transitions, `lot_transfers`, cost attribution, `raw_value_at_submission`
captured, profitability analysis.

**Gate:** E6 reproduces. A graded card is never valued from a raw price (F10).

### M18 — Trades

Item-leg accounting rule decided and documented **first**. Then the workflow over the existing
schema.

**Gate:** E14 reproduces. No fabricated P/L (F13).

### M19 — V1 completion

Desktop bulk operations, richer statistics, images and receipts, CSV import, restore from
backup, PWA polish, Android verification.

---

## Deferred

Wishlist and target prices · set completion · price alerts · opt-in read-only share links · push
notifications · receipt OCR · native iOS and Android clients · configurable condition
multipliers · cross-language card equivalence · paid pricing sources.

Not being built. The data model preserves the cheap ones. See [BACKLOG.md](BACKLOG.md).

---

## Ordering rationale

**Domain before database.** The financial engine is pure functions with no infrastructure
dependency, so it can be correct and tested before any schema exists. Getting it right first
means the schema serves a proven model rather than the reverse.

**Auth and RLS early.** Isolation is not a feature that can be added later to a system that grew
without it. The two-client fixture exists from M3 so every subsequent table inherits the test.

**Collection before purchases.** Purchases create holdings, so the target has to exist first.

**Money before value.** The ledger is the product's distinguishing feature and the least
dependent on unreliable external data.

**Value before dashboard.** Charts need something honest to plot.

**Scanner before openings.** Reversed from the earlier plan. Tracking every physical card makes
manual entry the dominant cost of using the app, so the scanner delivers more value per unit of
work than openings do — even though openings are conceptually closer to the product's core.
Openings remain fully modelled in the schema throughout, and historical openings can be
backdated once M16 lands.
