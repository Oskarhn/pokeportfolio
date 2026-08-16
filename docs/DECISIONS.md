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

## D-017 — Every physical card is individually trackable

**2026-08-16 · Accepted; supersedes a proposal to aggregate low-value cards**

**Context.** An earlier proposal was to record cards above a value threshold individually and
collapse the rest into bulk entries, on the grounds that tracking 340 commons worth two øre each
is not worth the effort.

**Decision.** Every physical card is first-class inventory: Basic Energy, commons, duplicates,
cards with no market price. No card is forced into an aggregate. A user may register ten thousand
individual cards. The only bulk concept is an optional per-opening remainder estimate for cards
the user chose not to enter — a convenience, never a substitute.

**Why the earlier proposal was wrong.** It optimised for the wrong thing. Bulk aggregation makes
the *interface* tidy at the cost of making the *data* lossy — a collection is not "the valuable
cards plus a number", and set completion, physical card counts and simply finding a card all
break under aggregation. The tidiness problem is real but it is a presentation problem, and the
right fix is organisation (D-018) and filtering, not discarding information.

**Consequences.** Working scale moves from thousands of holdings to 10 000+. Addressed by:
price history keyed per variant rather than per copy, which decouples the binding storage
constraint from collection size (D-019); keyset pagination and virtualisation; grouped display
with quantity; lazy image loading. It also makes the scanner the dominant usability lever, which
is why it moves ahead of openings (D-024).

---

## D-018 — Four distinct grouping concepts, deliberately not merged

**2026-08-16 · Accepted**

**Context.** With nothing aggregated away, organisation carries the weight. There was an obvious
temptation to build one flexible "labels" mechanism covering everything.

**Decision.** Four separate concepts: **storage location** (physical, one per holding),
**custom collection** (conceptual group, many per holding), **tag** (free-form label, many), and
**smart filter** (a rule evaluated at read time, stored nowhere).

**Alternatives.** A single tag system for all four — simpler schema, but "this card is in Binder
A", "this card is in my Trade Binder project" and "this card is currently worth under 10 kr" are
different kinds of fact with different lifetimes, and merging them means a price movement looks
like the user moved a card.

**Consequences.** One extra join table and one extra column. In exchange, value-based grouping is
never materialised — which matters, because rewriting membership rows nightly as prices move
would be both expensive and actively misleading.

---

## D-019 — Price history is keyed per card variant, never per physical copy

**2026-08-16 · Accepted**

**Decision.** One `price_snapshots` row per variant per day per price kind, regardless of how
many copies the user owns. Quantity is applied at aggregation time from `acquisition_lots`.

**Why it matters.** This is what makes D-017 affordable. Snapshot volume scales with *distinct
printings owned*, which plateaus, not with *cards owned*, which does not. Eighty identical
energies produce one row per day, not eighty. A 10 000-card collection realistically spans
3 000–4 000 variants, giving roughly 105 MB/year against a 500 MB free-tier ceiling.

**Consequences.** Portfolio aggregation must always join lots to snapshots rather than reading a
per-holding stored value. Slightly more query work; the alternative would have made all-card
tracking impossible on the free tier.

---

## D-020 — Cost basis is a state, not a nullable number

**2026-08-16 · Accepted; refines D-002**

**Context.** D-002 established that opening pulls store `NULL` rather than zero. Extending
tracking to gifts, trades and pre-tracking collections produced four more `NULL` situations that
mean genuinely different things.

**Decision.** Every lot carries `cost_basis_state ∈ {known, unallocated_opening, not_paid,
unknown, trade_in}`, with `unit_cost_basis_minor` present if and only if the state is `known`.

**Why.** A gift with no cost and a card bought in 2014 for a forgotten amount are both `NULL`,
but they are not the same fact: the gift genuinely cost nothing, while the old card cost real
money the system cannot see. The app can only tell the user the truth about its own limitations
if it records which situation applies. It also drives the UI copy — "gift" versus "cost unknown"
versus "from opening" — instead of a blank field that reads as zero.

**Consequences.** An enum and a check constraint. Every aggregate branches on state. Uncosted
lots are counted and surfaced (`ULC`) rather than silently excluded.

---

## D-021 — Manually costed openings create a real provisional purchase

**2026-08-16 · Accepted; supersedes the earlier rule that such costs stay out of the ledger**

**Context.** The earlier rule was that an opening entered with a manual cost and no purchase
record would not count toward lifetime spending, on the grounds that the money never passed
through the ledger.

**Why that was wrong.** The money *was* spent. Excluding it makes lifetime spending —
the product's distinguishing metric — systematically understate reality, and does so invisibly.
Avoiding double counting is a real concern, but the answer is to make counting correct, not to
skip it.

**Decision.** The opening creates a real `purchase` with `origin = 'provisional_opening'`. It
behaves as an ordinary ledger entry everywhere. When the real receipt is entered later, the user
links it: the opening repoints at the real lot and the provisional purchase is voided in the same
transaction, audited.

**Alternatives.** An opening-local cost field outside the ledger — every spending aggregate would
need a special case, and one missed case silently understates spending. Automatic matching of
openings to purchases — would corrupt the ledger in exactly the cases the user cannot easily
verify.

**Consequences.** One enum value, one nullable FK, one reconciliation action, one invariant
(F12). Reconciliation is explicit and costs the user a single tap.

---

## D-022 — Email and password, not OTP

**2026-08-16 · Accepted; supersedes D-005**

**Context.** D-005 chose email OTP. The zero-cost audit then established that the platform's
built-in email provider allows **2 auth emails per hour, project-wide** — not per user — and its
own documentation describes it as unsuitable for production.

**Why OTP fails here.** Every login sends an email. Onboarding two people in one sitting exhausts
the quota. The fix would be a custom SMTP provider: free tiers exist that need no domain, but
that adds a third-party service, an account and a deliverability dependency to the critical path
of every single login.

**Decision.** Email plus password. No email is sent during normal login. Account creation is
already gated by an invitation Edge Function, so email confirmation is unnecessary. Password
reset uses the built-in low-volume email — resets are genuinely rare at this scale — with an
admin-assisted recovery path as the documented fallback.

**Consequences.** Passwords must be handled properly, which the platform already does. The login
flow has no external dependency and no rate limit. Passkeys remain a future improvement once the
platform's implementation leaves experimental status.

---

## D-023 — Collection value is the primary figure; position sits beside it

**2026-08-16 · Accepted; supersedes an earlier recommendation to lead with overall position**

**Decision.** Collection value is the visually primary number. Overall position is immediately
adjacent and prominent. Data quality — automatic versus manual valuation, priced versus unpriced
counts — is displayed with the value rather than hidden behind a detail view.

**Rationale.** This is a collection application first. Leading with net position would make it
read as an investment tracker that happens to contain cards, which is the wrong emphasis for
something opened daily. But spending must not be buried either, so the two figures share the
top of the screen.

---

## D-024 — Scanner ships before openings

**2026-08-16 · Accepted; reverses the earlier ordering**

**Context.** The earlier roadmap put openings first post-MVP, on the grounds that they complete
the financial story and carry less technical risk.

**Decision.** Scanner first, openings second.

**Rationale.** D-017 changes the calculus. When every physical card is tracked, manual entry
becomes the dominant cost of using the application — a booster box is 360 searches. The scanner
removes that cost; openings add analytical depth to data the user is struggling to enter in the
first place. Openings remain fully modelled in the schema throughout, so historical openings can
be backdated once they ship.

**Consequences.** The riskiest, most research-dependent milestone comes earlier. Mitigated by
validating the iOS camera-permission assumption on real hardware with a throwaway page *before*
committing to the scanner build.

---

## D-025 — JSON backup moves into MVP

**2026-08-16 · Accepted; supersedes placing it in V1**

**Decision.** A versioned full JSON export ships in MVP alongside CSV, carrying a schema version
and export timestamp in its envelope.

**Rationale.** The free plan provides no automated backups. Deferring the only complete export
format to V1 would mean months of real data with no full recovery path. The version envelope
exists so that an export taken today remains readable after future migrations — an unversioned
backup stops being a backup at the first schema change.

---

## D-026 — Working name `PokePortfolio`

**2026-08-16 · Accepted, temporary**

Internal working name and repository slug `pokeportfolio`. Not branding. "Poke" is close enough
to a trademark that it must be reconsidered before any public release; the name appears in the
repository slug and documentation only, never baked into a database schema, package namespace or
domain. Renaming later is a find-and-replace, by design.
