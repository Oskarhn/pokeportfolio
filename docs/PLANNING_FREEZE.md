# Planning Freeze

## FROZEN FOR INITIAL IMPLEMENTATION — 2026-08-16

Planning is complete. Implementation has an authoritative target.

"Frozen" does not mean immutable. It means implementation work should not reopen settled product
decisions as a side effect of coding. Reopening requires meeting the criteria in §9.

---

## 1. What is being built

A private, invite-only application for tracking a Pokémon TCG collection as both a collection and
a set of financial records. Permanent spending ledger, lot-level cost basis, market valuation,
portfolio history. Primary platform is an installed PWA on iPhone; desktop is first-class for
bulk work. 1–10 users.

Authoritative definition: [PRODUCT_SPEC.md](PRODUCT_SPEC.md).

## 2. Hard constraints

| Constraint | Detail |
|---|---|
| **Budget** | **Target $0/month**, with an owner-approved **$50 USD lifetime discretionary ceiling** (2026-08-17, D-027) that is not pre-authorized spending — see [COST_POLICY.md](COST_POLICY.md) §1. No paid service, no billing, no card, no domain, no subscription, without the owner's explicit approval per purchase. No spending before the free functional baseline (COST_POLICY §1b) exists. When a feature cannot be built well for free, postpone it. |
| **Privacy** | Repository private. Never made public without owner approval and a completed [PUBLICATION_CHECKLIST](PUBLICATION_CHECKLIST.md) pass. |
| **Isolation** | RLS on every table. No user can reach another's data. Admin included. |
| **Honesty** | Absent data is displayed as absent. No fabricated history, no invented precision, no metric labelled as something it is not. |

## 3. Approved MVP

The first genuinely usable version.

- Invite-only accounts, **email + password**, enforced server-side
- RLS isolation, verified by automated tests
- Card catalog and search, English and Japanese
- **Every physical card individually trackable** — energies, commons, duplicates, unpriced cards
- Holdings with acquisition lots; duplicates grouped by quantity with lot detail
- Explicit acquisition origin and cost-basis state; **missing cost is never zero**
- Custom collections (many-to-many), smart value filters, configurable low-value threshold,
  separate "no price" filter
- Mobile gallery, **2 columns default**, user-settable 1–4, persisted per user; list and desktop
  table views
- Graded cards as a collection type with manual value
- Sealed inventory with keep/open intent and manual valuation
- Multi-line purchases with retailer, shipping, customs, discount, foreign currency, backdating
- Permanent spending ledger, collectible versus hobby split
- Daily raw-card pricing via TCGdex; FX via Norges Bank; freshness states
- Sales with explicit lot selection; realized result only where a cost basis exists
- **History** area for items no longer owned: sold, traded, other
- Dashboard: collection value primary, overall position adjacent, data quality visible
- CSV exports **and** versioned JSON backup
- Installable PWA, dark/light/system, responsive, desktop support

**Excluded from MVP:** openings, scanner, full grading workflow, trade workflow, images and
receipts, bulk desktop editing, CSV import.

## 4. Approved post-MVP order

| # | Milestone | Note |
|---|---|---|
| 1 | **Scanner** | Ahead of openings. All-card tracking makes manual entry the dominant cost of using the app. |
| 2 | **Openings** | Fully modelled in the schema from MVP; historical openings can be backdated once the workflow ships. |
| 3 | Grading workflow | `raw_value_at_submission` captured from MVP so profitability stays computable. |
| 4 | Trades | Schema complete; the item-leg accounting rule is decided first. |
| 5 | Desktop bulk tooling, statistics, images, import, PWA polish | |

## 5. Core financial semantics

Full definitions and worked examples: [FINANCIAL_MODEL.md](FINANCIAL_MODEL.md).

- Money as integer minor units with an ISO 4217 code. Never float.
- **Cost basis is a state**, not a nullable number: `known`, `unallocated_opening`, `not_paid`,
  `unknown`, `trade_in`. An amount exists if and only if the state is `known`. **Never zero to
  mean absent.**
- Purchase-level shipping, customs and discounts allocate pro rata across **all** lines including
  hobby accessories, using largest-remainder rounding so parts sum exactly to the whole. This
  keeps `total spend = collectible + hobby` exact.
- Opening pulls have no individual cost basis and no per-card ROI. Return is computed at opening
  scope, in kroner first.
- An opening entered with a manual cost **creates a real provisional purchase** so the money
  reaches lifetime spending. Linking the real receipt later voids the provisional entry in the
  same transaction. Money is never counted twice.
- Realized result is reported only where a cost basis exists. Sold gifts, sold pulls and
  pre-tracking cards show proceeds and a result of **—**.
- Trades: cash legs are ordinary money; item legs produce no realized P/L while the accounting
  rule is undecided.
- Historical cost never changes because the market moved. Historical FX is never recomputed.
- A missing market price excludes an item from collection value and is counted and displayed —
  it is never zero. A provider price of genuinely 0.00 is a different thing and is stored as such.
- Condition is recorded but does not adjust value; the price source is not condition-specific.
- Graded cards are never valued from raw prices.

## 6. Core architecture

Rationale: [ARCHITECTURE.md](ARCHITECTURE.md) · [DECISIONS.md](DECISIONS.md).

| Layer | Choice |
|---|---|
| Frontend | Vite · React 19 · TypeScript strict · TanStack Router + Query |
| UI | Tailwind v4 · shadcn/ui on Base UI, copied in and owned |
| Charts | `lightweight-charts` (Apache 2.0), validated by a spike before the dashboard |
| Backend | Supabase — PostgreSQL with RLS, Auth, Edge Functions, `pg_cron`, `eu-north-1` |
| Auth | Email + password, invite-only, server-enforced |
| Catalog and raw prices | TCGdex — Cardmarket EUR, TCGplayer USD |
| FX | Norges Bank |
| Sealed and graded value | Manual valuation. No free EUR source exists. |
| Hosting | Cloudflare Pages, static |
| Scale | **Price history keyed per card variant, never per copy.** This is what makes all-card tracking affordable on the free tier. |

## 7. Privacy model

- Invite-only, enforced by an Edge Function plus a database trigger. Not by hiding a button.
- Users are fully isolated. Nobody browses anyone else's collection.
- Admin manages invitations and can disable accounts. Admin has **no** application-level access
  to another user's collection or financial data.
- Whoever operates the deployment has infrastructure-level database access. Disclosed in the
  README, not engineered around.
- Future opt-in read-only sharing must be an additional read path, never a weakened policy.

## 8. Deliberately deferred

Recorded so they are not rediscovered as gaps.

| Item | Why deferred |
|---|---|
| Trade item-leg accounting rule | Two defensible rules; needs a real decision. Blocks the trade workflow only. Frozen `cost_basis_at_disposal` keeps both open. |
| Cardmarket Product Catalogue for sealed pricing | Requires an authenticated inspection. Sealed valuation is manual by design until then. |
| Paid pricing sources | Zero-cost constraint. Reassess only after real use shows manual valuation is intolerable. |
| Passkeys | Platform implementation still experimental. |
| Condition multipliers | No data supports any specific numbers. |
| Cross-language card equivalence | Not needed; would be a separate table with a confidence field. |
| Offline mutation queue | Large, bug-prone, no evidence it is needed. |
| Basic Energy catalog modelling | Verified at ingest time in M5, not guessed now. |

## 9. Reopening a frozen decision

Permitted when **all** of these hold:

1. New evidence, not a new preference — a provider changed, a measurement failed, a constraint
   turned out to be false.
2. The affected canonical documents are updated in the same change.
3. A [DECISIONS.md](DECISIONS.md) entry records the context, the alternatives and the consequences.
4. Affected tests are updated, and the worked examples still reconcile.
5. If the decision is one the owner made personally — scope, financial semantics, login, privacy,
   visual direction, cost — the owner approves it first.

Discovering that something is harder than expected is not grounds for reopening scope. It is
grounds for a milestone taking longer.

## 10. Verification at freeze

| Check | Result |
|---|---|
| Every MVP feature achievable at zero cost | Yes — verified 2026-08-16 against official documentation |
| Any service able to bill automatically | None. GitHub stops at a $0 limit, Supabase restricts, Cloudflare Pages bandwidth is unlimited. |
| Payment card required anywhere | No |
| Financial model free of double counting | Reviewed across 15 worked examples, including the provisional-purchase reconciliation path |
| Missing cost distinguishable from zero | Yes — `cost_basis_state`, enforced by constraint |
| Missing price distinguishable from zero | Yes — `price_state`, with a genuine 0.00 stored as an observation |
| All-card tracking viable on the free tier | Yes — price history decoupled from collection size |
| Documentation self-consistent | Reviewed; no known contradictions |
| Repository private, no secrets, no personal data | Verified |
