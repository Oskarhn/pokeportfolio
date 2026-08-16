# Decision Log

Decisions that are expensive or irreversible to change. Not routine implementation choices.

Format: context → decision → alternatives → consequences.

---

## D-001 — Lot-based cost basis, not averaged holdings

**2026-08-16 · Accepted**

**Context.** A user owns three copies of one card bought on different dates at different prices,
possibly including one pulled from a pack. Selling one copy requires knowing which copy left.

**Decision.** Three-level model: `card_variant` (catalog) → `holding` (a distinct owned state)
→ `acquisition_lot` (a quantity acquired at one time with one cost basis). Sales reference
specific lots. FIFO is suggested in the UI; the user may override, and the chosen lot is stored
permanently.

**Alternatives.** Averaging all copies into one weighted cost — simpler but destroys provenance
and makes realized results arbitrary. One row per physical card — accurate but unusable for a
500-card bulk lot.

**Consequences.** More tables and more join complexity. Realized and unrealized results are
correct and explainable. Partial disposal works. Backdating works. This is the foundation the
rest of the financial model rests on.

---

## D-002 — Opening pulls have `NULL` cost basis, never zero

**2026-08-16 · Accepted; supersedes an earlier suggestion to use literal zero**

**Context.** An ETB costing 799 NOK produces cards. Those cards need to appear in the collection
and its value without corrupting the accounting.

**Decision.** The opening owns the cost. Pull lots store `unit_cost_basis_minor = NULL`, meaning
*not allocated*. The UI shows "from opening — no individual purchase cost" and offers no
per-card ROI. Return is computed at opening scope:
`retained pull value + net proceeds from sold pulls + bulk estimate − opening cost`.

**Alternatives.** Pro-rata allocation by market value — cost basis would drift with the market,
violating the principle that a historical cost is fixed. Equal allocation per card — assigns the
same basis to a bulk common and a chase card. Literal zero — makes every pull show infinite
profit, which is the misleading outcome the product exists to avoid.

**Consequences.** `NULL` money must mean "not applicable" everywhere, never zero (invariant M1).
Every aggregate must handle the `NULL` branch explicitly. In exchange, portfolio totals stay
correct with no double counting, and opening ROI is answered where the question is well-posed.

---

## D-003 — Supabase on the free plan, `eu-north-1`

**2026-08-16 · Accepted**

**Context.** Need managed Postgres with row-level security, authentication that Postgres can
read, scheduled jobs, and near-zero cost for 1–10 users.

**Decision.** Supabase free plan, Stockholm region. Schema in versioned SQL migrations in this
repository, never applied by hand through the dashboard.

**Alternatives.** Neon plus a separate auth provider plus a separate scheduler — better raw
Postgres ergonomics, three vendors, RLS/JWT plumbing built by hand. A custom Node backend —
reimplements auth, authorization and CRUD for no gain.

**Consequences.** Accepted: no automated backups on Free (manual `pg_dump` discipline required),
project pauses after ~7 days idle, 500 MB database ceiling. The 500 MB ceiling is what forces
snapshotting only held variants. Escape path is real because the database is plain PostgreSQL.

---

## D-004 — Vite + React SPA, not a meta-framework

**2026-08-16 · Accepted**

**Context.** Choose a frontend stack for an authenticated, personalised, camera-using,
chart-heavy application with a BaaS backend.

**Decision.** Vite + React 19 + TypeScript strict + TanStack Router + TanStack Query. Static
build deployed to Cloudflare Pages.

**Alternatives.** Next.js 16 — SSR and RSC unusable here (every screen is authenticated), adds
hydration complexity, effectively couples hosting, Hobby tier is non-commercial. TanStack Start
and React Router framework mode — credible, but full-stack framings of a problem that is already
client-plus-BaaS.

**Consequences.** No server rendering, which costs nothing here. Full control over client
component lifetime, which the scanner needs (see D-006). Deployable anywhere as static assets.
Any future server-side need is served by a Supabase Edge Function, not by adopting a framework.

---

## D-005 — Email OTP for authentication; passkeys deferred

**2026-08-16 · Accepted**

**Context.** Invite-only auth for an installed iOS PWA. Passkeys were the earlier leaning.

**Decision.** Six-digit email OTP. Passkeys revisited when Supabase's implementation leaves
experimental status.

**Alternatives.** Magic link — rejected because a link opened from Mail on iOS launches Safari
rather than the installed PWA, moving the user out of the app mid-login. Passkeys — Supabase's
support requires an experimental opt-in flag and may change without notice; too fragile for a
critical path. Google sign-in — a third-party dependency and an account requirement for invited
users, for no benefit at this scale.

**Consequences.** The login flow stays entirely inside the installed app. Depends on email
deliverability. Auth surface is small enough that adding passkeys later is contained.

---

## D-006 — Scanner owns one route and one media stream

**2026-08-16 · Accepted (architectural constraint; scanner not yet built)**

**Context.** WebKit re-prompts for camera permission on URL changes inside a standalone iOS PWA
(bug 215884, open). A bulk scanning session that navigates per card would prompt on every card.

**Decision.** The scanner is a single route that acquires one `MediaStream` on entry and releases
it on exit. Per-card confirmation is an overlay inside that route. No navigation, no hash change,
no URL mutation during a session. Session state is component state, not URL state.

**Alternatives.** A route per scanned card — natural for a router-driven app, unusable on iOS.
Requiring blanket Safari camera permission — pushes a security decision onto the user to work
around a browser bug.

**Consequences.** One route diverges from the app-wide convention that filter state lives in the
URL. The divergence is deliberate and documented. Fixing this after building the scanner would
mean rewriting its routing; fixing it now costs nothing.

---

## D-007 — Money as integer minor units

**2026-08-16 · Accepted**

**Decision.** All monetary values stored as `bigint` minor units with an ISO 4217 currency code.
Minor-unit exponent read from a currency table, not assumed to be 2. Never float. FX rates as
`numeric(18,8)` — rates are not money.

**Consequences.** Every read and write crosses a formatting boundary. Allocation needs
largest-remainder rounding so parts sum exactly to the whole (invariant F6). In exchange, no
accumulated floating-point drift in a ledger meant to be permanent.

---

## D-008 — Own the price history; never fabricate it

**2026-08-16 · Accepted**

**Context.** No free source provides historical EUR card prices (R4).

**Decision.** Build history from our own daily snapshots. Charts begin when tracking begins and
show an explicit origin. Snapshot only variants the user holds or has held, not the full catalog.

**Alternatives.** Apply today's price backwards — fabricated data, and precisely the failure mode
this product exists to avoid. Pay for a source with history — US-market, in USD, and a recurring
cost against a stated zero-cost target.

**Consequences.** The portfolio chart is thin for the first months and there is nothing to do
about that. A variant's history starts at acquisition. Our snapshot table survives the provider
disappearing, which turns the largest external risk into a bounded one.

---

## D-009 — No condition multipliers in MVP

**2026-08-16 · Accepted; supersedes an earlier suggestion of specific percentages**

**Context.** An earlier draft proposed valuing EX at 85%, GD at 70% and so on. Those numbers were
invented, not derived.

**Decision.** Condition is recorded as a real property used for filtering, sorting and export. It
does not adjust market value. Cardmarket's price points are not condition-specific and the UI
says so. Manual valuation is the honest route for a played copy.

**Consequences.** A heavily played card shows the same reference value as a near-mint one unless
manually valued. That is less convenient and more truthful. Configurable multipliers remain a
Later item, and if added must be user-set, opt-in and visibly marked as an estimate.

---

## D-010 — Manual valuation for sealed and graded

**2026-08-16 · Accepted**

**Context.** No free EUR source exists for sealed products (R5) or graded cards (R7).

**Decision.** Manual valuation, with provenance and a visible marker. A raw-card price is never
displayed as a graded value (invariant F10). A US reference may appear later, explicitly labelled
as a different market and never used in collection value.

**Alternatives.** PriceCharting at ~$59/year would close both gaps — genuinely cheap, but US
market, and against the stated zero-cost target. Revisit if manual valuation proves tedious in
practice (uncertainty U6).

**Consequences.** Manual upkeep for the sealed and graded portion of the collection. Honest
figures with visible provenance. Adoption of a paid source later is a contained change behind
the provider abstraction.

---

## D-011 — Denormalize `user_id` onto child tables

**2026-08-16 · Accepted**

**Context.** RLS policies for child rows can reach the owner through a join to the parent, or
read a local column.

**Decision.** Every user-private child table carries `user_id` directly. A trigger asserts it
matches the parent (invariant S1).

**Alternatives.** `EXISTS`-subquery policies against the parent — correct, but push a subquery
into every row check and create a failure mode where a mismatched child row becomes silently
invisible rather than rejected.

**Consequences.** One redundant column per child table and a trigger to keep it honest. Policies
become one-line predicates that can be read and verified at a glance, which matters more than
the redundancy for the security surface.

---

## D-012 — Provider identifiers as columns, not a polymorphic mapping table

**2026-08-16 · Accepted**

**Decision.** `tcgdex_*`, `cardmarket_product_id`, `tcgplayer_product_id` as nullable columns
with partial unique indexes on the catalog tables. Internal `uuid` remains canonical identity.

**Alternatives.** A generic `provider_refs(entity_type, entity_id, provider, ref)` table — more
extensible, but cannot carry real foreign keys and would need application-level integrity
enforcement.

**Consequences.** Adding a fifth provider is one migration. Provider identity never leaks into
primary keys, so a provider disappearing leaves stale mapping columns and nothing else broken.

---

## D-013 — Void semantics for financial records

**2026-08-16 · Accepted**

**Decision.** Three distinct operations, chosen per entity rather than improvised per page:
**void** (retained, excluded from calculations, audited), **hard delete** (only with no live
downstream reference), **correct** (edit in place, audited). Guard rules and their error messages
are specified in DATA_MODEL §9.

**Consequences.** No orphaned financial history. Users occasionally have to void a sale before
voiding the purchase that produced it; the error message names the blocking record rather than
failing generically.

---

## D-014 — Cloudflare Pages over Vercel

**2026-08-16 · Accepted**

**Decision.** Static SPA deployed to Cloudflare Pages.

**Rationale.** Vercel's Hobby tier is restricted to non-commercial use, which is an awkward
constraint for a repository intended as a portfolio piece and a latent problem if anything ever
changes. Cloudflare Pages permits commercial use, has unlimited bandwidth on the free plan, and
charges no egress. With a static build there is no framework-specific hosting advantage to give up.

---

## D-015 — `lightweight-charts` for time series

**2026-08-16 · Accepted, pending a validation spike**

**Decision.** TradingView `lightweight-charts` (Apache 2.0) for portfolio value and monthly
spend. Plain SVG/CSS for breakdowns and sparklines. No second chart library.

**Alternatives.** Recharts — SVG-per-point performance on multi-year daily series, and the exact
generic dashboard look the brief rejects. ECharts — best touch handling among general-purpose
libraries, disproportionate bundle for two chart types. visx — full control at significant
implementation cost; retained as the fallback.

**Consequences.** Constrained to what a financial charting library renders well, which is what
this product needs. Validated by a spike before the dashboard milestone; if it fails, visx.

---

## D-016 — Working name `PokePortfolio`

**2026-08-16 · Accepted, temporary**

Internal working name and repository slug `pokeportfolio`. Not branding. "Poke" is close enough
to a trademark that it must be reconsidered before any public release; the name appears in the
repository slug and documentation only, never baked into a database schema, package namespace or
domain. Renaming later is a find-and-replace, by design.
