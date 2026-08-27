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

## D-027 — A $50 USD lifetime discretionary ceiling replaces the absolute-zero rule

**2026-08-17 · Accepted**

**Context.** The budget constraint had been an absolute 0 NOK/month with no exception. Prompt 5
(start of implementation) relaxed this: the owner is willing to consider, individually, a small
total amount of spending across the whole project's lifetime — never a monthly figure.

**Decision.** Target operating cost stays $0/month — nothing about the day-to-day engineering
default changes. A separate, **lifetime, project-total, discretionary ceiling of $50 USD** now
exists. It is not pre-authorized: every paid item still needs its own explicit owner approval
against the checklist in [COST_POLICY.md](COST_POLICY.md) §1a, and none of it may be spent before
a free functional baseline exists (§1b) — invite-gated auth, adding cards, recording
purchases/sales, basic dashboard, persistence, real-device use. Ordinary recurring subscriptions
remain prohibited by default; a narrow exception exists only for something both very cheap and
effectively one-time (roughly "~$10 for several years"), still subject to the same approval
checklist and counted against the $50.

**Alternatives.** Keep the absolute-zero rule — simpler, but would categorically reject a
genuinely excellent one-time option (e.g. a small perpetual license) purely on principle rather
than on merit. Grant a standing budget Claude can draw from autonomously — rejected: the owner
wants each purchase decided individually, not a pool to be spent down.

**Consequences.** [COST_POLICY.md](COST_POLICY.md) carries the full mechanism and a running cost
ledger (currently: $0 spent, $50 remaining). [PLANNING_FREEZE.md](PLANNING_FREEZE.md) §2 and
[CLAUDE.md](../CLAUDE.md) reflect the same figures. The practical architecture is unchanged — it
was already fully achievable at zero cost, and this decision does not obligate spending any of the
ceiling.

---

## D-026 — Working name `PokePortfolio`

**2026-08-16 · Accepted, temporary**

Internal working name and repository slug `pokeportfolio`. Not branding. "Poke" is close enough
to a trademark that it must be reconsidered before any public release; the name appears in the
repository slug and documentation only, never baked into a database schema, package namespace or
domain. Renaming later is a find-and-replace, by design.

---

## D-028 — Invite-only is two server-side gates, and the auth hook denies unconditionally

**2026-08-20 · Accepted; supersedes the M3 plan of an `auth.users` trigger alone**

**Context.** M3 shipped the invitation schema but nothing that closed `/auth/v1/signup`, and
documented that honestly. The planned fix was a single `auth.users` backstop trigger. Since then
Supabase's **Before User Created** auth hook became generally available on the free plan, which
changed what the best answer is.

**Decision.** Both, with distinct jobs.

Gate 1 is the Before User Created hook, implemented as `public.before_user_created`, which
**rejects every invocation unconditionally**. Reading `supabase/auth` at master establishes that
GoTrue calls this hook from every self-service account-creation path and from none of the Auth Admin
API (RESEARCH.md R21). Since the only path this product uses is the Admin API — from a server-side function that has
already proven token possession — the hook has nothing to evaluate.

Gate 2 is a `BEFORE INSERT` trigger on `auth.users` requiring a live `invitation_claims` row.

**Alternatives.**

*A hook that allows signup when the address has a valid invitation.* Rejected, and this is the
important one: it would let anyone who knew an invited address call `/auth/v1/signup` and set the
password before the invited person opened their link. Knowing an address is not possessing a token.

*A hook that trusts `user_metadata`.* Rejected. Anything a public signup client can send is
attacker-controlled by definition.

*Trigger only.* Would work, but leaves public signup failing with a database-level error rather than
a clear 403, and puts the entire property on one mechanism.

*Hook only.* Rejected because the hook is configuration. A project that received `db push` but not
`config push` would be running with the door open. The trigger travels with the migrations.

**Consequences.** `auth.admin.createUser` no longer works on its own for anyone, including test
fixtures and the Supabase dashboard — a claim must exist first. That is a feature, and the
authorization fixture now takes the real privileged route. Deploying to a new environment requires
`supabase config push`, which DEVELOPMENT.md §3 calls out explicitly. If a future GoTrue release
began invoking the hook from the Admin API, redemption would break loudly rather than the gate
opening quietly.

---

## D-029 — Invitations bind to an address, and redeemed accounts are created already confirmed

**2026-08-20 · Accepted**

**Decision.** `invitations.email` is `NOT NULL`; the redemption function creates the account for
that address and ignores any address in the request body. The account is created with
`email_confirm: true`.

**Rationale.** Binding the token to an address means a stolen token cannot be redirected to an
attacker's own account. Auto-confirmation is not a weakening: an administrator chose the address and
delivered a 256-bit secret to it out of band, so possession of that secret is *stronger* evidence of
control over the address than clicking a confirmation link would be. It also keeps account creation
entirely off the built-in mail provider's two-emails-per-hour budget, which is reserved for password
recovery — the reason D-022 chose passwords over OTP in the first place.

**The trust assumption, stated plainly:** the owner is responsible for sending an invitation link
only to the person they intend, over a channel they trust. The link is the credential. This applies
to invitation redemption only, and never to public signup, which has no success path at all.

---

## D-030 — Invitation tokens are hashed with SHA-256, not a password hash

**2026-08-20 · Accepted**

**Decision.** `encode(sha256(token), 'hex')`. Not bcrypt, not argon2.

**Rationale.** Slow hashing exists because a human-chosen password has perhaps 40 bits of entropy
and must survive an offline dictionary attack. An invitation token here is 32 bytes from
`gen_random_bytes` — 256 bits, with no dictionary and no feasible offline search for a slow hash to
slow down. The property that matters is that the database never holds anything replayable as a
token, even to someone with a full dump, and a fast cryptographic hash delivers exactly that while
keeping lookup a single indexed equality.

**Consequences.** Lookup is by unique index on the hash, so comparison is of hashes and never of the
secret — no hand-written byte comparison enters the codebase. Revisit only if tokens ever become
low-entropy, which would be a different and worse decision to make first.

---

## D-031 — Invitation management is a Postgres RPC; only redemption is an Edge Function

**2026-08-20 · Accepted**

**Decision.** `create_invitation` and `revoke_invitation` are `SECURITY DEFINER` Postgres
functions callable by an authenticated admin. `redeem-invitation` is the only Edge Function in the
system.

**Rationale.** The only privileged thing invitation creation does is generate random bytes and store
a hash, both native to Postgres, and the admin already has an authenticated session for
`is_admin()` to check. Wrapping that in an Edge Function would add a deployment surface, a CORS
surface and a service-role credential to protect, for no security gain. Redemption is genuinely
different: it must create an `auth.users` row, which requires the Auth Admin API, which requires
the secret key, which must never reach a browser.

**Consequences.** One function to deploy and one credential boundary to reason about instead of
three. The admin screen talks to PostgREST like every other screen.

---

## D-032 — Password policy is length-only: minimum 12, no composition rules

**2026-08-20 · Accepted**

**Decision.** `minimum_password_length = 12`, `password_requirements = ""`, plus a short
obvious-password list and a 72-byte ceiling in the redemption function.

**Rationale.** Composition rules ("one uppercase, one symbol") reliably produce `Passw0rd!` and
fight password managers; NIST SP 800-63B advises against them. Length is the property that actually
resists guessing, and every account here is created through a flow that already offers to generate
and save a password. 72 bytes is bcrypt's silent truncation point — rejecting is honest, truncating
is not.

**Alternatives.** Supabase's leaked-password check against HaveIBeenPwned is a paid-plan feature and
therefore out (COST_POLICY §1). Shipping a breach corpus of our own would cost more in bundle and
maintenance than it buys for ten invited users choosing a 12-character password.

**Consequences.** Enforced by GoTrue server-side, so it holds for any caller regardless of the
client. Re-checked before the invitation is claimed, so a too-short password never burns one.

---

## D-033 — `card_variants` identity is finish + stamp + subtype, three columns, not one enum

**2026-08-20 · Accepted**

**Decision.** The M3 `variant_type` enum (`normal`, `holo`, `reverse`, `first_edition`, `promo`,
`stamped`, `other`) is replaced by three columns: `finish` (enum: `normal`/`holo`/`reverse`/`other`),
`stamp` (free text, e.g. `1st-edition`), and `subtype` (free text print-run marker, e.g.
`shadowless`, `unlimited`, `1999-2000-copyright`). Uniqueness moves from `(card_id, variant_type,
size)` to `(card_id, finish, stamp, subtype, size)`.

**Rationale.** Evidence, not preference (PLANNING_FREEZE.md §9's bar for reopening a schema
decision). A real TCGdex response for `base1-4` (Charizard, Base Set) carries a `variants_detailed`
entry with `type: "holo"`, `subtype: "shadowless"`, `stamp: ["1st-edition"]` simultaneously — holo,
shadowless *and* first-edition on one physical card. The old enum treats `holo` and
`first_edition` as mutually exclusive values of the same column, so it cannot represent that card at
all without lying at ingest time. `stamp` and `subtype` are free text rather than enums because
TCGdex's own vocabulary for them is not documented as closed (`wPromo`'s boolean flag implies at
least one stamp value never observed in the samples this decision was made from), and a provider
adding a new subtype should not be able to fail an ingest.

**Alternatives considered.** Keeping `variant_type` and adding a boolean `is_first_edition` column
was rejected: it only solves the one collision actually observed and leaves the same category error
for the next one (a future stamped promo, say). Three columns matching TCGdex's own dimensions is
the smallest change that stops guessing at the shape of future data.

**Consequences.** `supabase/migrations/20260820150000_m5_catalog_language_and_variant_corrections.sql`
and `20260820153000_m5_card_variants_identity_constraint_fix.sql`. Made now, before M6 attaches
holdings to `card_variants`, per PLANNING_FREEZE.md §9's "new evidence" test and M5's own mandate
(this document's prompt §11-§12) to correct the model while the catalog is still empty. No holding
or lot semantics change — this is catalog shape only.

---

## D-034 — Provider identifiers are scoped by language; marketplace product ids are not unique per variant

**2026-08-20 · Accepted**

**Decision.** Every TCGdex-provider-id uniqueness constraint in the catalog (`card_series`,
`card_sets`, `cards`) is now `unique (language, tcgdex_*_id)`, not a bare `unique (tcgdex_*_id)`.
`card_variants.cardmarket_product_id` and `.tcgplayer_product_id` are plain indexed columns, not
unique ones.

**Rationale.** Both are measured facts, not assumptions. TCGdex's English and Japanese set lists
both contain a set id `neo1` (English "Neo Genesis", Japanese "金、銀、新世界へ..."), and both series
lists contain a series id `neo` — a global unique index on either column would have rejected the
second language's row outright. Separately, `swsh1-2` (Roselia, Sword & Shield) has both a `normal`
and a `reverse` variant, and TCGdex's own pricing payload gives both finishes the identical
TCGplayer `productId` — one marketplace listing covers two priced finishes, so treating that id as
a per-variant identity was already wrong, not merely inconvenient.

**Consequences.** Internal `uuid` identity remains canonical throughout (DATA_MODEL.md §3.4) —
these are mapping columns, and none of this changes what a future holding points at. The product-id
columns are kept, indexed, because M9's price ingest will still want to look up "which rows share
this listing"; they simply stop claiming to be identity.

---

## D-035 — Catalog ingest is triggered by an operator-held bearer secret, not a user session

**2026-08-20 · Accepted**

**Decision.** `sync-catalog` (the ingest Edge Function) checks `Authorization: Bearer
<CATALOG_SYNC_SECRET>` against a Supabase Function secret, the same mechanical shape as
`redeem-invitation`'s `verify_jwt = false` but a different actual gate: a secret the operator
generated and holds, not a token bound to an invited email address.

**Rationale.** There is no signed-in user on the other end of a catalog sync — it is run by whoever
operates the deployment, from a script, not from the product's UI. Requiring a Supabase user JWT
would mean either inventing a fake "sync admin" account or reusing the owner's real admin session
from a script, both worse than a narrow, single-purpose secret that grants exactly one capability
and nothing else. This is the same class of credential as a CI deploy key, not a step up from it.

**Consequences.** `sync-catalog` is unreachable from the browser bundle (no code path calls it with
this secret, and the secret is never shipped to a client). The secret is rotatable independently of
every other credential in the system by re-running `supabase secrets set CATALOG_SYNC_SECRET=...`
and updating the operator's own environment; no user-facing behaviour depends on it.

---

## D-036 — Storage location lives on the acquisition lot, not the holding

**2026-08-21 · Accepted; corrects DATA_MODEL.md §5.2's original "one per holding" cardinality**

**Context.** M6 built the real add-to-collection flow and checked a concrete scenario before
writing user data against the schema: two identical NM copies of a card in Binder 1 and a third,
equally identical, in Binder 2. `holdings_identity` correctly merges all three into one holding
(same variant, same condition, same grading state — DATA_MODEL.md §5.4), but `holdings` carried a
single `storage_location_id` column, so a shared holding could name only one location. The three
copies could not be represented as physically split.

**Decision.** `storage_location_id` moves from `holdings` to `acquisition_lots`. A batch of copies
acquired together and stored together is exactly what a lot already models; location becomes an
ordinary lot-level fact, the same way condition or grading state would if they varied (they can't,
by construction of the identity index — but location legitimately does).

**Alternatives.** Keep location on the holding and make it part of `holdings_identity`, so a
location difference creates a new holding — rejected because M6 prompt §21 and DATA_MODEL.md §5.4
are explicit that ordinary lot differences, not new holdings, are the right place for variation
that isn't a different physical *state* of the card. A holding answers "what do I own"; a lot
answers "which batch, from when, at what cost, and where" — location is a "where", not a "what".

**Consequences.** Same shape as M5's D-033/D-034: a real scenario found and fixed before any real
user data existed, not migrated out from under it later. `profiles.default_storage_location_id`
keeps its original meaning as a prefill default for new lots rather than new holdings — a small
reinterpretation, not a schema change. DATA_MODEL.md §5.2/§5.4/§5.5 updated in the same commit.

---

## D-037 — Manual card definitions: a user-private identity source alongside the shared catalog

**2026-08-21 · Accepted**

**Context.** D-017 requires every physical card to be trackable. M5's real ingest found permanent
provider gaps — dozens of sets with a non-zero card count and an empty `cards[]` array, ~9,300
cards with no image, six sets that never ingested at all (HANDOVER.md, "M5 — Catalog"). Making
"the shared catalog has this card" a precondition for ownership would silently violate D-017 for
every gap, present and future.

**Decision.** A third nullable identity source on `holdings`: `manual_card_id`, referencing a new
user-private `manual_card_definitions` table (name, set name, collector number, language, finish,
stamp, subtype, size, notes — no provider id, no rarity, no price, no image requirement). The
three-way check constraint on `holdings` enforces exactly one of `card_variant_id` /
`sealed_product_id` / `manual_card_id` — never zero, never two.

**Alternatives.** Block adding an unlisted card until the catalog is manually extended by an
operator — rejected: it makes the user's own collection depend on someone else's ingest schedule,
and it would require a write path into the shared catalog from unverified user input, which
DATA_MODEL.md §3 explicitly reserves for the service role. Store a "provisional" row directly in
`cards`/`card_variants` — rejected: it pollutes the shared catalog with unverified per-user facts
and every other user would see it once it existed.

**Consequences.** A manual card is ordinary Collection inventory: it carries lots, condition,
storage, cost, tags, and counts toward the physical card total, exactly like a catalog card. It is
never visible to another user (plain user-private RLS) and never merges into the shared catalog by
itself. A future reconciliation operation — repoint a holding's `card_variant_id` at a
newly-ingested canonical variant and clear `manual_card_id` — is the existing "correct a card's
identity" lifecycle operation (DATA_MODEL.md §9) applied to this column; no new mechanism is
required, and no lot, cost or disposal history is disturbed by it. Not built in M6: the
reconciliation *UI* is deferred, since nothing about the data model blocks adding it later.

---

## D-038 — `opening`/`trade_in` origins and manual valuations pulled forward from M16/M18/M9

**2026-08-21 · Accepted; deliberate deviation from the M3 sequencing note in DATA_MODEL.md §12**

**Context.** DATA_MODEL.md §12 originally planned `lot_origin` values `opening` and `trade_in`,
and the `manual_valuations` table, to ship alongside the milestones that give them a full
workflow — M16 (openings), M18 (trades), M9 (pricing). But the M6 gate itself requires a user to
record a pulled card and a directly-owned graded card with a manual value *today*, and D-017 makes
"come back once M16/M18/M9 exist" an unacceptable answer for a card physically pulled from a pack
this week.

**Decision.** Ship the enum values and the `manual_valuations` table now, without their eventual
supporting infrastructure: `acquisition_lots.origin` gains `opening` (UI label "Pulled") and
`trade_in` with no `opening_id`/`trade_line_id` column yet — a lot just has no opening/trade
reference until M16/M18 add one and link it. `manual_valuations` ships as a plain entry table; the
provider-price resolver (manual → fresh → stale → missing, FINANCIAL_MODEL.md §6) stays M9's
entirely, because M6 has no other price source for it to resolve against.

**Alternatives.** Wait for M16/M18/M9 — rejected, violates D-017 for the exact case (openings) the
product's cost model was built to handle honestly. Model "pulled" as `origin = 'other'` with a
note — rejected, loses the ability to distinguish a pull from an unusual purchase later, and the
cost-basis-state consistency constraint (`unallocated_opening` only pairs with `opening`) exists
specifically so a pull can never be silently priced as if it were paid for.

**Consequences.** When M16 ships, `acquisition_lots.opening_id` is added as a nullable column and
existing `opening`-origin lots become linking candidates, not a migration hazard — DATA_MODEL.md
§5.5 already anticipated exactly this ("later opening reconciliation/linking must remain
possible"). Same reasoning applies to `trade_in` and M18. ROADMAP.md's M6 entry and DATA_MODEL.md
§12 are corrected in the same commit rather than left contradicting the shipped schema.

---

## D-039 — Migrate to Supabase publishable/secret API keys; retire the legacy pair by deactivation

**2026-08-21 · Accepted**

**Context.** An M5-session command (`supabase projects api-keys`, run to fetch the anon key for
local dev) returned `pokeportfolio-dev`'s full key set, including the legacy `service_role` secret,
into the session transcript — not requested, not used, not stored, not committed, but present and
therefore treated as potentially exposed (HANDOVER.md, PROJECT_JOURNAL.md). Supabase's current,
official migration path (verified 2026-08-21) replaces the legacy `anon`/`service_role` JWT pair
with named `sb_publishable_…`/`sb_secret_…` keys, both created alongside the legacy pair without
disturbing it, with Edge Functions receiving the new secret automatically via
`SUPABASE_SECRET_KEYS` (a JSON map, one entry per named key) with no redeploy required for the
injection itself.

**Decision.** Create the new publishable/secret key pair through the dashboard (an action only the
project owner can take without re-triggering the exact command that caused the exposure). Migrate
the frontend's build-time env var from `VITE_SUPABASE_ANON_KEY` to
`VITE_SUPABASE_PUBLISHABLE_KEY`, and both Edge Functions (`redeem-invitation`, `sync-catalog`) to
prefer `SUPABASE_SECRET_KEYS` over the legacy `SUPABASE_SERVICE_ROLE_KEY`, falling back to the
legacy variable only because the *local* Supabase stack still emits it (`supabase/functions/_shared/
service-key.ts`). Once verified working end to end, deactivate — not delete — the legacy
`anon`/`service_role` keys in the dashboard.

**Alternatives.** Rotate the JWT signing secret, the historical way to invalidate a leaked
`service_role` value — rejected. It invalidates every existing user's session (the signing secret
underlies every issued JWT, not just the service-role one), which is a large, user-visible action
disproportionate to an exposure that was never used or persisted anywhere, and current Supabase
guidance offers a narrower path that does not carry that cost. Do nothing, on the reasoning that
the value was never actually used — rejected: "potentially exposed" is the standing conclusion in
HANDOVER.md/PROJECT_JOURNAL.md, and a real, low-cost, reversible mitigation exists.

**Consequences.** No forced re-login: deactivating legacy keys does not invalidate issued user
JWTs, only the API-key-level authentication Supabase layers on top. Reversible: current Supabase
tooling allows re-activating a deactivated legacy key if a missed client turns up depending on it.
`docs/SECURITY.md` §6 and `HANDOVER.md` restate the terminology (current hosted keys vs. the local
stack's legacy fixture variables vs. the browser-safe key vs. the privileged backend key) so a
future session does not read the old anon/service_role framing as still describing production.

---

## D-040 — User-facing route renamed `/collection` → `/portfolio`; legacy paths redirect

**2026-08-22 · Accepted**

**Context.** M7's owner UI requirements pass renamed the user-facing surface from "Collection" to
"Portfolio" throughout — navigation labels, headings, copy. The route itself named the same thing
(`/collection`), and a URL a user might have bookmarked or an existing E2E test asserted against
is a real, if small, compatibility surface.

**Decision.** The canonical route becomes `/portfolio` (`/portfolio/$holdingId`,
`/portfolio/manual/new`). `/collection`, `/collection/$holdingId` and `/collection/manual/new`
remain as thin `beforeLoad` redirects to their new equivalents, preserving the holding id across
the redirect. Internal domain/table/RPC naming is unchanged — `holdings`, `holding_summaries`,
`add_card_acquisition` and the `src/features/collection/` folder for pages that did not
structurally change (`HoldingDetailPage`, `AddToCollectionPage`, `ManualCardPage`) all keep their
existing names, per the "internal naming does not need to chase user-facing wording" principle
this project already applies to `PokePortfolio`/`pokeportfolio` (D-026).

**Alternatives.** Keep `/collection` as the URL and only change visible copy — the more
minimal-churn option, and genuinely defensible; rejected because a user-facing name that
disagrees with its own URL is a small, permanent seam, and TanStack Router route renames plus a
redirect route cost little. Renaming the internal `collection` feature folder and every table to
match — rejected as pure churn with no behavioural benefit, and directly against
`docs/PRODUCT_SPEC.md`'s standing instruction not to let UI wording drive schema/domain naming.

**Consequences.** Three new redirect route definitions in `src/router.tsx`, each a single
`beforeLoad: () => redirect(...)`. Playwright coverage (`tests/e2e/auth.spec.ts`) asserts the
redirect lands where intended. No stored links, bookmarks or external references break.

---

## D-041 — Portfolio's default sort resolves to a real (not fabricated) value pre-M9, via a
two-bucket keyset

**2026-08-22 · Accepted**

**Context.** The owner's permanent default sort is "Value: high to low" (M7 prompt §29), but no
raw-card market price exists before M9. Two paths were available: fabricate a stand-in ordering
key (e.g. acquisition cost) so `value_desc` "works" today, or genuinely sort by value where a value
exists and fall back to a deterministic secondary order where it does not.

**Decision.** `list_portfolio`'s `value_desc`/`value_asc` sort a holding's value as the active
manual valuation on a graded card (`manual_valuations`, shipped in M6) — real, known money, never
the acquisition cost standing in for market value. Every raw-card holding has a genuinely `NULL`
value and falls into a second, deterministic bucket ordered by name. Pagination is real keyset
across both buckets: the cursor carries `(value, has_value, name, holding_id)` and the WHERE clause
branches explicitly on which bucket the cursor's row was in, never an `OFFSET`.

**Alternatives.** Sort by acquisition cost as a value proxy — rejected outright: this is exactly
the "acquisition cost standing in for market value" the prompt explicitly forbids (M7 prompt §30),
and it would silently misrepresent a bargain purchase of a valuable card as worthless. Disable
`value_desc` entirely until M9 — rejected: it is the permanent default, so the toolbar would have
to special-case "value sort doesn't work yet" everywhere it appears, and it discards the real
partial data (graded manual valuations) already available.

**Consequences.** When M9 adds a real resolved value for raw cards, only the single SQL expression
computing "value" inside `list_portfolio` needs to change (from "active manual valuation only" to
"resolver: manual → fresh → stale → missing") — the two-bucket keyset shape, the cursor contract
and every caller of the RPC stay exactly as they are. Documented in the migration
(`20260822120010_m7_portfolio_query.sql`) so this is not rediscovered as a TODO.

**Performance correction, found by the real 10,000-lot benchmark, not by CI (2026-08-22).** The
original `list_portfolio`/`portfolio_counts` bodies computed each holding's aggregate quantity via
a `LEFT JOIN LATERAL` correlated subquery per row — correct, but structurally a nested-loop plan:
one subquery evaluation per holding. Against a real 7,500-holding/10,109-lot synthetic account on
`pokeportfolio-dev`, this measured 5.5-8 seconds per call, and two of nine sort modes
(`value_desc` — the permanent default — and `added_newest`) timed out outright
(`57014 canceling statement due to statement timeout`). Rewritten as a `MATERIALIZED` CTE doing a
plain `LEFT JOIN ... GROUP BY` — the same shape `holding_summaries` (M6) already uses — which lets
the planner pick a single hash-join-plus-hash-aggregate pass instead of one subquery per row.
Re-measured against the identical seeded data: 130-570 ms across every sort mode, filter and
keyset page. See `20260822120030_m7_portfolio_query_perf_fix.sql`,
`20260822120040_m7_portfolio_counts_perf_fix.sql`, and PROJECT_JOURNAL.md 2026-08-22 for the full
account. No caller-visible contract changed — same parameters, same return shape, same semantics.

---

## D-042 — Closing the PUBLIC-EXECUTE privilege blind spot

**2026-08-22 · Accepted**

**Context.** SECURITY.md §5.9 already documented, as a known fact from M6, that PostgreSQL grants
`EXECUTE` on a new function to `PUBLIC` by default — a separate ACL entry from anything granted or
revoked from a *named* role — and that `scripts/grant-audit.sql` had never checked for it, only for
`anon`/`authenticated` grants by name. That was recorded as a known limitation, not yet closed.

**Decision.** Close it in three parts, mirroring the shape SECURITY.md §5.9 already uses for the
named-role surface: (1) a one-time sweep, `revoke execute on all routines in schema public from
public`, in the M7 privilege baseline; (2) `alter default privileges ... revoke execute on
functions from public`, so a future function that forgets the per-migration `revoke ... from
public` step no longer arrives PUBLIC-executable either; (3) a new PUBLIC-grant check in
`scripts/grant-audit.sql`, asserting the PUBLIC-EXECUTE surface on every routine in `public` is
empty. `tests/db/sql/hostile_grants.sql` now also grants `PUBLIC` blanket execute as part of its
hostile state, so CI's convergence test proves the new check can actually fail before proving the
baseline fixes it (TESTING.md §7a's "an audit that cannot fail is not a check").

**Alternatives.** Wait for a real incident (an actual PUBLIC-callable function found in
production) before building the check — rejected: M4 and M6 both already found *named-role*
grant gaps of this same general shape by luck (a real deployment check, not by design), and a
third instance of the same defect class is exactly what a systematic fix is for.

**Consequences.** One real behavioural change, found immediately: `search_cards` predates the M4
"revoke from public at creation" convention and had never been explicitly revoked from `PUBLIC`,
so `service_role` had been calling it via that implicit default rather than a named grant — CI's
first run against this migration failed 16 tests in `tests/db/search_cards.test.ts` with
`permission denied for function search_cards` the moment the sweep removed it. Fixed with an
explicit `grant ... to authenticated, service_role`, the correct and now-deliberate version of an
access pattern that had been accidental. Every other function was unaffected, confirmed by the
same CI run rather than by inspection alone (PROJECT_JOURNAL.md, 2026-08-22, "Closing the PUBLIC
gap immediately exposed the dependency it had been masking"). `docs/SECURITY.md` §5.9 updated to
describe the closed state rather than the known gap.

---

## D-043 — Primary navigation drops to four destinations plus a central action; More is removed

**2026-08-23 · Accepted; supersedes M7's five-tab bar**

**Context.** The owner reviewed the deployed M7 UI and found the five-destination bottom bar
(Home, Search, Portfolio, More, Profile) visually unbalanced, and More itself carried no content
that couldn't live somewhere more specific — admin invitations (visible to admins only) and a
link into Profile's own display settings.

**Decision.** Mobile navigation becomes Home | Search | **+** | Portfolio | Profile: two
destinations either side of the central quick-add, an intentionally symmetrical four-tab shape
replacing M7's six-equal-flex-slot-plus-spacer geometry (DESIGN_SYSTEM.md §4.2, rewritten in the
same commit). `/more` remains a route — a thin `beforeLoad` redirect to `/profile`, matching the
existing `/collection*` → `/portfolio*` pattern (D-040) — so no bookmarked or shared link breaks.
Admin invitations moved into Profile, gated the same way (`is_admin`), with no change to the
underlying route or its `RequireAdmin` guard.

**Alternatives.** Keep five tabs and only restyle — rejected: the owner's specific complaint was
the geometry itself (an odd destination count forcing a spacer trick), not the visual treatment
layered on top of it. Fold More's content into a global settings icon instead of Profile —
rejected: Profile was already becoming the account/settings hub (§50 below), and a second
settings entry point would be the "two systems that can disagree" pattern this project avoids
elsewhere (DATA_MODEL.md §5.2's grouping-concepts reasoning is the same shape of argument).

**Consequences.** `src/features/nav/BottomNav.tsx`/`DesktopNav.tsx` rewritten; `src/features/more/`
deleted (no remaining reference). The global "PokePortfolio" wordmark that appeared top-left on
every authenticated screen is also removed in the same pass (owner feedback: it read as
mechanical branding) — it now appears only on Home's mobile view and the authentication screens.
Final logo integration is still M12a's.

---

## D-044 — Value-privacy and European-pricing preferences stored ahead of the data they govern

**2026-08-23 · Accepted**

**Context.** The owner asked for a Home/Portfolio value-privacy "eye" control and a "use European
pricing" setting. Neither raw-card market value nor a pricing-region resolver exists before M9
(D-041's same constraint), but both are genuine user preferences the owner wants captured now
rather than re-litigated when M9 ships.

**Decision.** Two new `profiles` columns, following the same "ship the preference ahead of its
consumer" shape D-038 already established for `opening`/`trade_in`/`manual_valuations`:
`hide_values boolean default false` (display-only — masks an already-computed figure as "••••",
changes nothing about what is computed) and `use_eu_pricing boolean default true` (genuinely inert
until M9's resolver reads it; the Profile UI says so explicitly rather than implying it already
works). Both join the standard column-restricted `UPDATE` grant
(`20260823120030_m71_privilege_baseline.sql`).

**Alternatives.** Wait for M9 to add both columns alongside the resolver — rejected for the same
reason D-038 rejected waiting: the owner's preference is a real fact today, and "come back later"
is a worse answer than storing it now and having M9 consume it unchanged.

**Consequences.** `default true` for `use_eu_pricing` follows the product's existing Europe/Norway
orientation (Cardmarket EUR via TCGdex, Norges Bank FX) rather than an arbitrary default. When M9
ships, only the resolver needs to read this column — no UI or schema change.

---

## D-045 — Bulk "Remove from Portfolio" deferred; only safe bulk actions ship in M7.1

**2026-08-23 · Accepted**

**Context.** The owner asked for a Portfolio multi-select mode with bulk actions including removal.
Multi-select and bulk add/remove-to-collection and bulk favourite are purely organisational
(DATA_MODEL.md §5.2.1's C1 reasoning: no financial consequence). Bulk *removal* is not — it means
voiding acquisition lots, potentially many at once, and must never be a hard `DELETE` (DATA_MODEL.md
§9's void-semantics table) or leave a purchase referencing a partially-voided set of lots.

**Decision.** Ship select mode with bulk add-to-collection, remove-from-current-collection and
bulk favourite/unfavourite now — all reversible, all organisational, all a single bounded
PostgREST statement under existing RLS. Bulk "Remove from Portfolio" is not built in M7.1: it
needs a real batch-void RPC (transaction-safe, correctly guarding a purchase with a live downstream
reference, auditable) that does not yet exist, and building one under this milestone's time budget
risked exactly the unsafe/partial operation DATA_MODEL.md §9 exists to prevent.

**Alternatives.** Ship a bulk delete that loops individual void calls client-side — rejected: not
transaction-safe (a failure partway through leaves some lots voided and others not, with no clear
recovery), and the prompt's own guidance is explicit that shipping something unsafe here is worse
than deferring it.

**Consequences.** Recorded in BACKLOG.md as a real, scoped future item: a `bulk_void_lots(uuid[])`
RPC (or equivalent), atomic, guarded the same way `void_acquisition_lot` already is. Portfolio's
select-mode UI (`BulkActionsBar.tsx`) is built to add a "Remove from Portfolio" action later without
a redesign — the sheet/action-list shape already accepts more buttons.

---

## D-046 — Profile picture upload deferred rather than attempted under this milestone's scope

**2026-08-23 · Accepted**

**Context.** The owner asked for the ability to change a profile picture. SECURITY.md §7 already
specifies the shape a correct implementation needs: private per-user storage paths, strict
size/MIME validation, re-encoding, EXIF stripping (a real disclosure risk — phone photos carry GPS
coordinates, and this app already treats "storage location" as sensitive, SECURITY.md §1), and
signed URLs rather than a public bucket. None of that infrastructure exists yet.

**Decision.** Defer, rather than ship a version that skips validation, re-encoding or EXIF
stripping to fit inside this milestone. The prompt's own instruction for M7.1 is explicit that a
"serious attempt" does not mean shipping something materially security-sensitive without the
safeguards SECURITY.md already requires for exactly this feature.

**Alternatives.** Ship upload without EXIF stripping "for now" — rejected outright: an inventory of
valuable physical property is precisely the case SECURITY.md §7 was written for, and shipping the
gap knowingly is worse than not shipping the feature.

---

## D-047 — Editing a purchase cannot add or remove lines

**2026-08-24 · Accepted**

**Context.** M8's `update_purchase` needs to recompute allocations and cost basis atomically when a
user corrects amounts, dates, charges or FX on an existing purchase. `acquisition_lots.purchase_line_id`
is a real foreign key with no `ON DELETE` cascade or `SET NULL` — deleting a `purchase_lines` row
that still has a lot referencing it either orphans real inventory history or requires the edit path
to silently void/reassign lots as a side effect of an amount correction, which is exactly the kind
of implicit destructive behaviour DATA_MODEL.md §9 exists to rule out.

**Decision.** `update_purchase` accepts exactly the existing set of line ids — same count, same ids
— and edits only their quantity, unit price, spend class and description, plus every purchase-level
field (date, retailer, currency, FX, shipping/customs/discount, notes). Supplying a different set of
line ids is rejected outright, naming the reason. Adding or removing a line from a purchase already
saved means voiding it and recording a new one — the same correction UX_FLOWS.md's "Purchase entered
twice" case already describes for a bigger mistake.

**Alternatives.** A general line-level diff (add new lines, soft-delete removed ones, migrate their
lots) was considered and rejected as disproportionate: it multiplies the ways an edit can interact
with future disposal-producing milestones (sales, openings, grading, trades) for a correction class
(wrong line set) that is materially rarer than a wrong amount, and that the existing void-and-re-enter
path already handles safely.

**Consequences.** The purchase editor UI reflects this directly — a fixed list of existing lines,
no add/remove control — rather than offering an action the RPC would just reject.

---

## D-048 — A card or sealed purchase line always creates inventory; no optional "skip holding" toggle

**2026-08-24 · Accepted**

**Context.** UX_FLOWS.md F3 describes an "offered: create holdings for the 4 card and sealed lines?
checkbox per line, on by default" step. Implementing a genuine opt-out means a `card`/`sealed` line
that counts as collectible spend with no corresponding lot — a state nothing else in the schema
represents, and one invariant M2/F7-style reasoning already treats as suspicious (spend with no
traceable item).

**Decision.** A `card` line always requires a catalog variant or a manual card, a `sealed` line
always requires a catalog product, and both always produce exactly one holding and one lot. A user
who genuinely doesn't want individual per-card entry yet uses the existing `bulk_lot` line type
(DATA_MODEL.md §5.3, M8 prompt §24) — "money spent on a group before all cards are individually
recorded" is precisely that state, already modelled, already excluded from fabricating individual
holdings.

**Alternatives.** Build the literal checkbox, storing a `card`/`sealed` line with no lot when
unchecked — rejected: it produces a class of purchase line that looks identical to every other
collectible line but is silently unlinked from any owned item, which is a worse UX than steering the
user to the line type that already exists for this exact situation.

**Consequences.** A minor deviation from UX_FLOWS.md's literal wording, functionally equivalent via
`bulk_lot`. Documented here rather than silently diverging from the spec.

---

## D-049 — fetch-fx-rate always answers HTTP 200 with an `{ ok, ... }` body

**2026-08-24 · Accepted**

**Context.** `src/features/auth/InvitePage.tsx`'s existing integration with `redeem-invitation`
already carries a hedge: "supabase-js reports a non-2xx as a FunctionsHttpError without parsing the
body, so the server's own message is not always reachable here." Building `fetch-fx-rate`'s client
(`src/data/fx.ts`) the same way — real HTTP status codes for `no_rate_found`/`norges_bank_unreachable`
/validation failures — would inherit that same unreliability for a function whose whole point is
telling the UI *which* failure occurred (§80's "offer retry vs. manual entry" distinction depends on
knowing why it failed).

**Decision.** Every business outcome (success, no rate found, upstream unreachable, invalid input) is
HTTP 200 with a discriminated `{ ok: boolean, ... }` body — 2xx responses are always reliably parsed
by `supabase-js`, sidestepping the ambiguity entirely. Real HTTP status codes (401, 405) stay reserved
for genuine transport/gateway failures the ordinary signed-in UI path can never trigger.

**Alternatives.** Match `redeem-invitation`'s existing real-status-code convention for consistency —
rejected: that function's caller already works around the same unreliability with a generic fallback
message, which is acceptable there (one message covers every failure) but not here (the UI needs to
distinguish "try again" from "enter a rate manually").

**Consequences.** `fetch-fx-rate` and `redeem-invitation` now follow two different HTTP-status
conventions for the same underlying supabase-js limitation. Not reconciled in this milestone —
retrofitting `redeem-invitation` is out of M8's scope and its existing behaviour is already handled
correctly by its one caller.

---

## D-050 — Grading-fee/shipping lines record spend only; lot linkage stays with M17

**2026-08-24 · Accepted**

**Context.** M8's prompt describes attaching a `grading_fee`/`grading_shipping` line to a specific
lot via `target_lot_id` and a `lot_cost_adjustments` row. Neither exists in the schema yet:
`purchase_lines.target_lot_id` and `lot_cost_adjustments` are both explicitly deferred to M17 in
DATA_MODEL.md §12 ("has no purpose until a grading workflow can write to it"), which predates this
milestone and was not contradicted by anything found while building M8.

**Decision.** `grading_fee`/`grading_shipping` are ordinary collectible-spend line types in M8 —
they count correctly in `GPO`/`CS`, they can be recorded against a purchase — but they do not attach
to a lot's effective cost basis. That wiring, and the grading-submission workflow it belongs to,
remains M17's, unchanged from the original sequencing.

**Alternatives.** Add `target_lot_id` and a minimal `lot_cost_adjustments` table now, ahead of M17 —
rejected: DATA_MODEL.md §12's deferred-table list is a deliberate sequencing decision from before
this milestone, and nothing discovered while building M8 constitutes the "concrete contradiction"
PLANNING_FREEZE.md §9 requires to reopen it. Pulling grading cost-basis forward would also start
building real grading-submission surface area (raw-value-at-submission, grading delta) this
milestone was explicitly told not to.

**Consequences.** A grading fee purchase is honestly recorded as spend today; its effect on a
specific card's effective cost basis (`EUCB`, FINANCIAL_MODEL.md §2.5) waits for M17 as originally
planned. No user-visible regression, since M6/M7 never wired this either.

---

## D-051 — void_acquisition_lot's parent-purchase rule corrected to count lines, not lots; bulk removal reuses it unchanged

**2026-08-25 · Accepted**

**Context.** M8.1 was asked to audit `void_acquisition_lot` before building a bulk "Remove from
Portfolio" action on top of it (BACKLOG.md's `bulk_void_lots(uuid[])` item, D-045). The audit found
a real bug: the M8-era auto-void-parent-purchase check (`20260824120010_m8_purchase_ledger.sql`)
counted only *other live lots* on the same purchase. That is correct exactly when every line on the
purchase produces a lot — true for the two-card case the existing test already covered — and wrong
the moment a purchase has a line that never produces one at all (`accessory`, `shipping_standalone`,
`customs_standalone`, `grading_fee`, `grading_shipping`, `bulk_lot`, `other`). Voiding the sole
`card`/`sealed` lot on such a purchase made the check see zero other live lots and auto-void the
whole receipt, silently erasing the accessory's real, unrelated spend from `CS`/`HS`/`GPO`.

A second, related gap: `void_acquisition_lot` never checked `quantity_remaining` before voiding, so
a lot already partially disposed elsewhere (once a disposal-producing milestone ships: sales M10,
openings M16, grading M17, trades M18) could have its cost basis silently erased by a later,
unrelated correction. `update_purchase`/`void_purchase` already guard the equivalent whole-purchase
case (D-047's neighbour); this had no equivalent for a single lot.

**Decision.** Auto-void the parent purchase only when every *other* line on it is already accounted
for — a `card`/`sealed` line whose own lot is also voided, or no other line exists. A line that can
never have a lot always counts as "not accounted for", permanently blocking auto-void while it
exists. This is a strict correction: it agrees with the old check on every purchase that exists
today (every existing purchase's lines all produce lots, or it is the M6 single-line shape), and
differs only on the case that was wrong. Separately, `void_acquisition_lot` now refuses to void a
lot whose `quantity_remaining <> quantity`, naming the blocker — the same guard shape
`update_purchase`/`void_purchase` already use, currently unreachable through any real product flow
(same caveat HANDOVER.md already records for those two) but implemented now so a later
disposal-producing milestone does not have to touch this function.

Bulk removal (`remove_holdings_from_portfolio(uuid[])`) does **not** duplicate any of this logic —
it calls `void_acquisition_lot` once per live lot of every selected holding, inside one transaction,
and is blocked only by the same `quantity_remaining` guard. A holding tied to a multi-line purchase
is never blocked from bulk removal: the corrected parent-purchase rule already keeps the purchase
and its unrelated spend intact without needing the user to visit the purchase page first.

**Alternatives.** Block "Remove from Portfolio" outright whenever a holding's lot traces to any
multi-line purchase, pointing the user at the purchase page to correct it there instead — this was
the initial reading of the prompt's own §8 guidance, but the *existing, already-shipped* two-card
test (`tests/db/m8_purchase_ledger.test.ts`) already establishes that voiding one card's lot from a
multi-card purchase while the purchase stays alive is intended, correct behaviour, not something
needing a block. Rejected once the real, tested product behaviour was read: the money for a voided
card's own line stays counted in `CS` until the whole purchase is voided (individually, from
`/purchases/$id`) — that is accepted, existing design, not a gap this milestone introduces or needs
to close.

**Consequences.** The pre-existing per-lot "Void" button on Holding Detail (M6/M7) inherits both
fixes for free, since it calls the same RPC — a real, if previously unexercised, correctness
improvement to a feature already in production. `remove_holdings_from_portfolio` needed no blocker
logic of its own beyond the ownership check and a thin per-holding read of the same guard, kept
deliberately simple.

**Consequences.** `ProfilePage.tsx` shows no picture-upload control at all — never a button that
looks functional and silently does nothing. Recorded in BACKLOG.md as a concretely scoped future
item with SECURITY.md §7's requirements restated as its acceptance bar.

---

## D-052 — M9 provider preference policy, and Portfolio value sorts by holding total, not unit price

**2026-08-26 · Accepted**

**Context.** M9 activates `use_eu_pricing` (D-044) but the owner's stated preference ("use European
pricing when available") does not by itself say what happens when only one provider has a price, or
when both do but one is stale and the other fresh. Separately, D-041's provisional value sort needs
a real answer now: does "Value: high to low" compare a holding's *unit* price or its *quantity ×
unit* total.

**Decision — provider preference.** `use_eu_pricing = true` prefers Cardmarket whenever it resolves
to a non-missing (fresh or stale) price; TCGplayer is used only when Cardmarket has none.
`use_eu_pricing = false` is the exact mirror. Freshness is never compared *across* providers to
override this preference — a stale Cardmarket price still wins over a fresher TCGplayer one when EU
pricing is selected. `resolve_variant_market_values` (`20260826120020_m9_valuation_resolver.sql`) is
the single implementation; every other M9 surface (list_portfolio, portfolio_counts, Holding Detail
provenance, Card Detail history, Market Movers) calls it rather than re-deriving the rule.

**Decision — sort key is the holding's total value.** `unit_value_nok_minor` (resolved value ×
quantity 1) drives the low-value/missing-value *filters* — "is this specific printing cheap" is a
per-item question (DATA_MODEL.md §5.2.2). `holding_value_nok_minor` (`unit_value_nok_minor ×
quantity_remaining`) drives the `value_desc`/`value_asc` *sort* and its keyset cursor — a portfolio
view answering "what's my biggest position" should not rank ×20 owned Basic Energy below a single
low-value rare merely because only unit prices were compared. Both figures are returned by
`list_portfolio`; the Portfolio grid tile shows the total (prompt §46's own worked example, "×3 ·
450 kr", is a total).

**Alternatives.** Rank providers by freshness first, preference second — rejected: it silently
overrides the very setting the owner asked for, on a per-card basis they cannot see or predict.
Sort by unit price, matching a plain price-comparison shop — rejected: this is an inventory app,
not a price list, and the existing D-041 note about the eventual real resolver already anticipated
"what's my biggest position" as the more useful question. Add a whole second sort mode ("Total
value" vs "Unit value") instead of picking one for `value_desc`/`value_asc` — rejected as scope the
owner never asked for; revisit only if real usage shows a need for both.

**Consequences.** Both rules are covered by `tests/db/m9_valuation_resolver.test.ts` (provider
preference and fallback, quantity multiplication) and documented in FINANCIAL_MODEL.md §6.

---

## D-053 — `price_snapshots` stores one already-chosen value per provider per day, not every raw field

**2026-08-26 · Accepted; corrects the DATA_MODEL.md §4.1 sketch written before M9 shipped**

**Context.** The original sketch (written at M6, before a real ingest existed) had `price_snapshots`
unique on `(card_variant_id, provider, price_kind, snapshot_date)`, implying every Cardmarket
price_kind (`trend`/`avg30`/`avg7`/`avg`) and every TCGplayer field would be persisted for every
watched variant every day. Multiplied across the ~3,000-4,000 watched-variant scale target, that is
a 4-6× storage cost over the ~105 MB/year projection COST_POLICY.md already commits to, for data the
FINANCIAL_MODEL.md §6 fallback chain would immediately collapse to one winning value anyway.

**Decision.** The ingest function (`ingest-prices`) resolves the §6 fallback chain *before*
writing — walks `trend → avg30 → avg7 → avg` for Cardmarket, takes `marketPrice` for TCGplayer — and
persists exactly one row per `(card_variant_id, provider, snapshot_date)`, with `price_kind`
recording which candidate won. Provenance stays fully auditable (a stored row always says whether it
was `cm_trend` or a fallback), without the multi-row-per-day cost. The unique index is
`(card_variant_id, provider, snapshot_date)` — `price_kind` is an attribute of the row, not part of
its identity.

**Alternatives.** Store the full sketch (every price_kind, every day) — rejected on the storage math
above. Store only the winning value with no `price_kind` column — rejected: it would silence
provenance ("was this really the trend, or did we fall back to a 30-day average") for no storage
saving, since `price_kind` is a single small enum column, not the expensive part.

**Consequences.** DATA_MODEL.md §4.1 is updated in the same commit as this decision. The measured
per-provider-per-day row cost and the resulting free-tier projection are recorded in
COST_POLICY.md/output_15.txt.

---

## D-054 — M7.1's `list_portfolio` rewrite silently reintroduced the M7 LATERAL performance defect; fixed as part of the M9 resolver rewrite

**2026-08-26 · Accepted**

**Context.** `20260822120030_m7_portfolio_query_perf_fix.sql` replaced `list_portfolio`'s per-holding
`LEFT JOIN LATERAL` lot aggregate with a `with lot_agg as materialized (...) left join
acquisition_lots ... group by h.id` shape, after the real 10,000-lot benchmark measured the LATERAL
form at 5.5-8 seconds per call with two sort modes timing out outright. `20260823120010_m71_number_
sort.sql` (M7.1) had to `DROP FUNCTION` and `CREATE FUNCTION` again — adding a parameter changes a
function's identity, so `CREATE OR REPLACE` was not available — and in rewriting the body from
scratch, reverted to the original `join lateral (select sum(...) ... where l.holding_id = h.id) q on
true` shape. Nothing caught it: CI's ephemeral fixtures are far too small to expose the nested-loop
plan, and no session between M7.1 and M9 re-ran the real benchmark.

**Decision.** M9 needed to rewrite `list_portfolio`'s body anyway (to add the resolver join), so the
materialized-CTE `lot_agg` shape is restored in the same migration
(`20260826120030_m9_list_portfolio_resolver.sql`) rather than filed as a separate follow-up. The
resolver join (`resolve_variant_market_values`) follows the identical rule from the start: called
ONCE per query with the full array of the user's distinct `card_variant_id`s, never once per
holding.

**Alternatives.** File it as a separate bug-fix migration — rejected: the function's body is being
rewritten regardless, and shipping a rewrite that reintroduces a known-bad shape while fixing an
unrelated one would be worse than fixing both together. Leave it for a future session to find via
another real benchmark — rejected: the M9 prompt explicitly requires re-running the large-Portfolio
benchmark (§73), which would have caught this anyway; fixing it now means that benchmark measures
the actually-shipped shape instead of a still-broken one.

**Consequences.** `portfolio_counts()` was not affected — its own `20260822120040_m7_portfolio_
counts_perf_fix.sql` was never touched by a later signature change, so it kept the materialized-CTE
shape throughout. The lesson generalizes: **a migration that must `DROP`+`CREATE` a function for an
unrelated reason (a new parameter, a new return column) is exactly the moment a previous
performance fix can silently regress**, because the whole body is being retyped by hand rather than
edited surgically. A future session doing this again should diff the aggregate-computation shape
against the previous version explicitly, not just against a mental model of "what changed."

---

## D-055 — `watched_card_variants` keeps a variant watched for any lot ever created, voided or not

**2026-08-26 · Accepted**

**Context.** DATA_MODEL.md §4.2's original sketch said the daily job should watch "currently owned
canonical card variants... plus variants held at any point historically." The M9 prompt (§11) asks
to additionally exclude "corrected/voided accidental entries with no legitimate ownership history,
if the model can distinguish them safely" from history-preserving variants — but a voided
`acquisition_lot` looks structurally identical whether it was a same-day fat-finger correction or a
genuine later disposal (M8.1's Remove from Portfolio, a real product-level "I no longer own this"
event that predates any actual sale/trade milestone).

**Decision.** `watched_card_variants` includes a `card_variant_id` the moment any `acquisition_lot`
row exists for it, regardless of `voided_at` — i.e. it does not attempt the correction-vs-disposal
distinction the prompt flagged as possibly-unsafe. This errs toward preserving too much price
history rather than silently destroying a real one; the cost of watching one extra variant born from
a same-day correction is negligible (one more row set in a table already budgeted for thousands),
while wrongly un-watching a variant that was genuinely, legitimately owned and later removed would
be a real, hard-to-notice loss of history.

**Alternatives.** Exclude a lot whose `voided_at` is within some short window of its `created_at` (a
heuristic "probably a same-day correction") — rejected: an arbitrary threshold is exactly the kind
of invented precision the project avoids elsewhere (D-009's rejection of condition multipliers is
the same shape of argument), and a legitimately-disposed-of card removed the same day it was noticed
to be a mistake would be wrongly excluded by it too.

**Consequences.** DATA_MODEL.md §4.2 is updated to state this explicitly. Revisit only if the actual
watched-variant count in production materially exceeds the ~3,000-4,000 projection because of this
choice — measured in output_15.txt/COST_POLICY.md.

---

## D-056 — Market Movers ranks by per-unit percentage change, never holding-total kroner

**2026-08-27 · Accepted**

**Context.** M9.1 gave Market Movers a real dedicated screen with sort modes (prompt §18-23). The
owner's original request was about cards whose *price* moved most — but a holding's economic
impact (unit change × quantity) is also a real, useful number, and the two can disagree sharply: a
single rare card up 40% is a smaller kroner move than eighty commons each up 2%.

**Decision.** Every sort mode (`highest_increase`/`largest_decrease`/`most_movement`/
`least_movement`) ranks by the resolved per-unit `change_pct`. `holding_impact_nok_minor` (unit
change × quantity) rides along as a secondary, purely informational figure — it never enters the
`ORDER BY`. This matches the owner's stated framing exactly and keeps the ranking meaning stable
regardless of how many copies a user happens to hold of any one printing.

**Alternatives.** Rank by holding-total kroner impact — rejected: quantity would then dominate the
list, and a user who bulk-owns cheap bulk energy would see it outrank a genuinely fast-moving rare,
which is not "market movers" in any recognizable sense. Offer both as separate sort families —
rejected as unnecessary scope for a first real screen; revisit only if the owner asks for it.

**Consequences.** `get_market_movers` returns both figures; the UI shows `change_pct` as the
headline and the kroner change as a secondary line. `tests/db/m91_market_movers.test.ts` proves
quantity does not distort the ranking directly (two holdings of the same variant at 1x and 50x
quantity tie exactly on `change_pct`).

---

## D-057 — Display-currency conversion is presentation-only, computed client-side from cached `fx_rates`

**2026-08-27 · Accepted**

**Context.** M7.1 stored a `display_currency` preference before any real conversion existed;
`MoneyDisplay` showed a "shown once conversion exists" placeholder note. M9 shipped real FX
ingest (`fx_rates`, EUR/NOK and USD/NOK, daily) but never wired display-currency conversion to it
— M9.1 prompt §9-10/§42 asks for the preference to actually do something, coherently, everywhere a
resolved NOK value is shown (Home, Portfolio, Search, Card Detail, Holding Detail, Market Movers).

**Decision.** Canonical valuation stays NOK everywhere it is stored (`price_snapshots`, purchase
FX, cost basis, manual valuations) — nothing about this decision touches persistence. `MoneyDisplay`
reads the latest cached `fx_rates` row for the user's chosen display currency (a plain `select`,
market data readable by any authenticated user) and converts the already-resolved NOK amount for
*display only*, using the exact bigint reciprocal-rate machinery in `src/domain/fx.ts`
(`invertRate`/`convertNokToDisplayCurrency`) — never a JS float. If no cached rate exists yet for
that currency (e.g. before the first `ingest-fx` run), the amount shows in NOK with a plain "rate
not available yet" note rather than fabricating a number. Search/Card Detail's on-demand
`search-prices` path does its own equivalent NOK conversion server-side, at the observation's own
date, using the same `fx_rates` table (D-052's FX-lookup pattern, reused rather than re-derived).

**Alternatives.** Store a converted amount — rejected outright: it would violate F11 (frozen NOK
conversions are never recomputed) if ever confused with a real transaction amount, and a
presentation figure that goes stale the moment `fx_rates` updates is a correctness bug waiting to
happen. Fetch a live rate from Norges Bank per render — rejected: unnecessary external calls for a
value already cached daily; `fetch-fx-rate` (M8) stays reserved for freezing a real purchase's
rate at entry time, a different question with different freshness requirements.

**Consequences.** Every M9.1 pricing surface list in prompt §9 is coherent by construction, since
they all route through either `MoneyDisplay` or the same `fx_rates`-lookup pattern. No stored
column changes as a result of a currency-preference change — verified by the M8/M8.1 financial
regression suite staying green with this change present.

---

## D-058 — `price_snapshots` retention shortened from 12 months daily to 60 days daily, measured not estimated

**2026-08-27 · Accepted**

**Context.** M9's `thin_price_snapshots` kept 12 months of daily history before thinning to weekly
— a placeholder pending real measurement (D-053's own note, and output_15.txt's disclosed gap).
M9.1 measured it for real: a representative 365,000-row synthetic dataset (500 variants × 2
providers × 365 days, `scripts/price-snapshots-storage-benchmark.sql`, run against CI's ephemeral
Postgres — never against a database holding real data) found **245.30 bytes/row**, table plus its
two indexes (`price_snapshots_unique_per_day` alone is the single largest index, larger than the
table itself). At the documented realistic scale (~3,500 watched variants, DATA_MODEL.md §4.2), 2
providers, 12 months of *unthinned* daily history — which is what actually accumulates before the
weekly policy ever has anything to act on — projects to **~609 MB**, exceeding the entire Supabase
Free 500 MB budget on `price_snapshots` alone, before the catalog, holdings, purchases, sales, or
any other table's indexes.

**Decision.** Shorten the daily-retention window to **60 days**, thinned to one observation per ISO
week per (variant, provider) beyond that, with the single latest observation per (variant,
provider) always retained regardless of age (unchanged from M9). Projected at 3,500 variants/2
providers: ~180 MB at 1 year (36% of budget), ~271 MB at 2 years (54%), ~362 MB at 3 years (72% —
close to COST_POLICY.md's pre-existing "reconsider at ~350 MB" trigger, which already anticipates a
review checkpoint rather than a hard forever-bound). 60 days keeps full daily granularity for a "1
month" chart entirely and mostly for "3 month" (the oldest ~30 days of a 90-day view shows weekly
points instead — informative, not fabricated, D-008's same principle). "6 month/1 year/max" legitimately
use weekly older observations, per the owner's own framing of what those windows need.

**This is a disclosed trade-off, not a claim of a bounded-forever solution.** The weekly tail is not
asymptotically bounded — it grows by one row per (variant, provider) per week, forever, just at
1/7th daily's rate. COST_POLICY.md's existing revisit trigger is the honest answer to "what happens
after several more years," not a new problem introduced here.

**Alternatives.** Keep 12 months and accept the overage risk — rejected: a zero-cost-constrained
project cannot ship a policy already projected to exceed its own budget at documented realistic
scale. A single flat retention period with no weekly tier — rejected: throws away "6M/1Y/MAX chart"
usefulness entirely once the flat cutoff passes, which the owner's period selector requires
(prompt §27). A monthly (rather than weekly) tier for very old data — considered, rejected for this
pass as unnecessary added complexity; the weekly tier alone already gets multi-year runway under the
measured figures, and a third tier can be added later if the revisit trigger is ever actually hit.

**Consequences.** `20260827130000_m91_retention_window.sql` changes `thin_price_snapshots`'s body
only (`create or replace function`, no signature change, no privilege-baseline update needed).
`tests/db/m91_retention.test.ts` proves the new threshold against an 18-month synthetic dataset.
COST_POLICY.md §6 (Supabase row) and DATA_MODEL.md §4.2 restate the measured figures. Revisit if a
future session's real measurement against `pokeportfolio-dev` diverges materially from this
synthetic projection, or when the database approaches the existing ~350 MB trigger.

---

## D-059 — `list_portfolio`'s 10k-lot regression was stale planner statistics from the benchmark's own bulk seed, not an application defect; `list_portfolio`/`portfolio_counts` are unchanged

**2026-08-22 · Accepted**

**Context.** M9.1 (D-054's carry-forward) left `list_portfolio`'s unfiltered first-page query an
open, real risk: 4-7.6s across three CI runs, one genuine Postgres statement timeout (57014) on the
first post-merge run against `main`. `portfolio_counts()` — calling the identical
`resolve_variant_market_values` resolver with the identical variant array — stayed fast (26-90ms),
pointing at `list_portfolio`'s own ~12-branch CASE-based `ORDER BY`/cursor predicate as the likely
differentiator. `force_generic_plan` (PR #28) was tried against that theory and disproved it: the
already-slow unfiltered path stayed just as slow, and previously-fast filtered queries got
substantially worse (~450ms → ~2.6s). Root cause was left genuinely unknown, carried into M9.2.

**Investigation.** `scripts/portfolio-perf-explain.sql` (new) captures real
`EXPLAIN (ANALYZE, BUFFERS, SETTINGS)` against the benchmark's seeded 10,000-lot/~3,500-variant
account, impersonating the synthetic user via the same JWT-claim technique Supabase's own stack uses
(`set role authenticated; select set_config('request.jwt.claims', ..., false)`). Run twice by
`portfolio-perf-benchmark.mjs`: immediately after the bulk seed, and again after an explicit
`ANALYZE` of the tables `list_portfolio`'s plan depends on (`holdings`, `acquisition_lots`,
`card_variants`, `cards`, `card_sets`, `manual_valuations`, `price_snapshots`).

**Finding, from a real CI run (PR #30/#31):** immediately after the ~2.2s bulk seed, every one of
those seven tables' `pg_class.reltuples` was **`-1`** — Postgres's "never analyzed" sentinel. A
fresh ephemeral CI Postgres instance has no autovacuum worker cycle in that short a window (default
`autovacuum_naptime` is 60s; this benchmark's entire seed-to-query sequence completes in low single
digit seconds), so the planner had genuinely zero statistics for any of these tables and fell back
to its no-information defaults. **Critically, `portfolio_counts()` was equally catastrophic in this
state — 7754ms, not the 26-90ms M9.1 measured** — proving the earlier "portfolio_counts stays fast,
so the differentiator must be list_portfolio's own ORDER BY/cursor shape" reasoning was itself an
artifact of *when* in the benchmark run each function happened to be called, not a real
architectural difference. `Buffers: shared hit` corroborates the mechanism: ~1.40 million shared
buffer hits (both functions, cold) collapsing to 649-3,367 after `ANALYZE` — a ~400-2000x reduction,
consistent with the planner switching away from whatever plan a no-statistics fallback produces
(most likely nested-loop-shaped, matching the buffer count's rough proportionality to
holdings-count × per-row lookup cost) to one an accurate row-count estimate actually supports. After
`ANALYZE`: all 12 sorts × 3 repeated runs landed at 62-202ms (first/median/max), `portfolio_counts()`
at 32ms, every filtered/scoped/keyset-cursor path 30-70ms — matching or beating M7's original
130-570ms baseline, comfortably inside TESTING.md §31's <1s target with real headroom. This also
explains the earlier "same query measured 7,472ms once and 64.7ms later in the same run" observation
plainly: autovacuum's autoanalyze had simply caught up in the interim, not any plan-cache or
custom/generic-plan effect (which is also why `force_generic_plan` never could have fixed this —
missing `pg_statistic` rows produce a bad estimate for *any* plan, custom or generic alike).

**Decision.** No change to `list_portfolio`'s or `portfolio_counts`'s SQL — TESTING.md §45's
"ANALYZE alone explains it" branch. The real, permanent fix is to the benchmark's own methodology
(`portfolio-perf-benchmark.mjs` now runs `ANALYZE` on the seeded tables before timing anything),
because that is the actual defect: measuring "milliseconds after a 10,000-row synthetic bulk insert,
before any autoanalyze has ever run" is not representative of production, where holdings accumulate
incrementally (one search-and-add or one purchase-import line at a time) and autovacuum's
autoanalyze keeps statistics continuously current — the all-tables-`reltuples=-1` state this
investigation found essentially cannot occur under that access pattern. TESTING.md §7's benchmark
description and this repository's mental model of "list_portfolio is architecturally fragile" both
needed correcting, not the function.

**A real, separate policy change, made because the evidence now supports it:** the benchmark
previously never asserted a pass/fail threshold at all (TESTING.md §7's original "no microbenchmark
theatre" reasoning). With representative statistics now guaranteed before every timed call, a
genuine multi-second result or timeout is no longer measurement noise — it is real, and this defect
class has now recurred three times (M7's LATERAL regression, M9.1's timeout, and the false lead this
decision closes) without CI ever failing on its own benchmark. `portfolio-perf-benchmark.mjs` now
sets a non-zero exit code — failing the `db-tests` job — if any call exceeds one generous,
catastrophic-only threshold (1.5s) or errors outright. This is not the tight per-sort millisecond
budget §7 already rejected; it is a single backstop wide enough that ordinary CI-runner variance
cannot trip it, narrow enough that a real regression (this milestone's own history shows what one
looks like) cannot slip through silently again.

**Alternatives.** Rewrite `list_portfolio` into explicit per-sort branches / pre-limit-before-value /
whitelisted dynamic `EXECUTE` (the M9.2 prompt's own suggested candidates) — rejected: the evidence
does not support any of them; `portfolio_counts()`'s identical cold-state collapse proves the
`ORDER BY`/cursor shape was never the actual cause, so rewriting it would have been a correct-looking
fix for the wrong diagnosis, adding real complexity and (per D-054's own standing checklist) real
regression risk for zero measured benefit. Leave the benchmark's pass/fail policy unchanged
(report-only forever) — rejected given the recurrence count; TESTING.md §41 explicitly invited this
re-evaluation once benchmark validity was fixed.

**Consequences.** `scripts/portfolio-perf-explain.sql` (new, `--explain`-gated, not run by default)
stays available for a future investigation if a migration ever changes the shape of one of these
tables again. No migration, no privilege-baseline change, no deployment to `pokeportfolio-dev` —
application SQL is byte-for-byte unchanged from M9.1. `docs/TESTING.md` §7/§41 restate the
ANALYZE-before-timing methodology and the new threshold policy. HANDOVER.md's M9 Portfolio-
performance gate is closed. If a future session's real benchmark result exceeds 1.5s after this
fix, treat it as a genuine regression from that session's own change, not a repeat of this root
cause — verify with `--explain` before assuming otherwise.
## D-060 — M10 sale ledger: the residual-consumption rule, `lot_cost_adjustments` finally created, and `create_sale`/`update_sale`/`void_sale` are SECURITY DEFINER

**2026-08-28 · Accepted**

**Context.** M10 (Sales and History) needed to freeze an exact `cost_basis_at_sale_nok_minor` for a
partial disposal of a lot, and found three real, previously-undecided or unshipped things blocking
that.

**1. The residual-consumption rule.** `acquisition_lots.residual_minor` (M6) already keeps
`quantity × unit_cost_basis + residual = attributable_cost` exact in the lot's original currency,
but nothing stored the NOK-side counterpart — `create_purchase`/`update_purchase` computed
`unit_cost_basis_nok_minor` with a plain floor division and silently dropped the remainder. Invisible
before M10 (a NOK-currency purchase has `attributable = attributable_nok` exactly, so the
existing `residual_minor` already covered it by coincidence), but a real, silent leak of up to
`quantity - 1` øre per lot for any foreign-currency purchase of a `quantity > 1` lot. Fixed by adding
`acquisition_lots.residual_nok_minor` (`20260828110000`), computed the same way, and backfilled from
each lot's own `purchase_lines.attributable_cost_nok_minor`.

That still leaves the question DATA_MODEL.md never answered: when a lot is disposed of across
*multiple* sales over time, which disposal gets the residual? **Decision: whichever disposal reduces
`quantity_remaining` to exactly zero** — i.e., the sale that empties the lot. A lot's
`quantity_remaining` decreases monotonically and can reach zero at most once per "lifetime" (voiding
the exhausting disposal restores it above zero; a second zero-crossing is therefore a distinct later
event, not a double credit), so summing the frozen basis over every disposal a lot will ever have
reproduces `quantity × unit_cost_basis_nok_minor + residual_nok_minor` exactly — no minor unit lost,
none duplicated, deterministic regardless of sale order or how many partial sales happen. The same
rule extends to `lot_cost_adjustments` (below): its own per-unit division residual attaches to the
same exhausting disposal. Full derivation and the exact formula:
`supabase/migrations/20260828120010_m10_sales_rpc.sql`'s header. Proven directly against a lot sold
across three separate sales in `tests/db/m10_sales.test.ts`.

**2. `lot_cost_adjustments` never actually shipped.** DATA_MODEL.md §5.6 has documented its shape
since M3, and M3's own scope note explicitly deferred it alongside `lot_disposals`/`openings`/
`trades`/`lot_transfers` — but unlike those, no milestone since (M6, M8, M9) revisited it, even
though M6 wired grading fields onto `holdings` and FINANCIAL_MODEL.md's E6 has described the
grading-fee-as-adjustment flow since M2. This was invisible because nothing computed EUCB from real
stored rows before M10 (M9's `effectiveUnitCostBasis` domain function takes adjustments as a plain
argument; it never reads the table). Created now (`20260828115000`), to the documented shape,
**SELECT-only for `authenticated`** — no INSERT grant, because no validated write path exists yet
(M17 owns the real "record a grading submission" RPC that will check the fee against a real
`grading_submissions` row before writing here; granting a bare INSERT now would let a user inflate
their own cost basis by citing any unrelated purchase line of theirs).

**3. `create_sale`/`update_sale`/`void_sale` are SECURITY DEFINER, not SECURITY INVOKER.** GIT_WORKFLOW
house style since M4.1 defaults every RPC to SECURITY INVOKER (prompt/CLAUDE.md precedent, restated
explicitly for M10 in its own prompt §105) — but that same prompt (§107) named a stronger requirement
for this specific ledger: `cost_basis_at_sale_nok_minor`, `realized_result_nok_minor`,
`proceeds_from_uncosted_nok_minor` and every `allocated_*`/`net_proceeds_*` column must be
**unreachable** by a direct write, not merely policed by a CHECK constraint after the fact — a
materially stronger bar than what M8 accepted for `purchases.total_nok_minor` (still directly
UPDATE-grantable there, because `update_purchase`'s SECURITY INVOKER body needs the grant to write
it, and the only exposure is a user corrupting their own private ledger — not a cross-tenant issue).
Reconciled by making the three write RPCs SECURITY DEFINER: `authenticated` holds no INSERT/UPDATE
grant at all on `sales`/`sale_lines`/`lot_disposals` (verified directly in
`tests/authorization/m10_sales.test.ts` — a same-owner direct INSERT/UPDATE attempt is rejected
identically to a cross-tenant one), and the functions enforce ownership themselves via explicit
`user_id = auth.uid()` filtering on every statement, exactly the discipline every INVOKER RPC in this
project already had to have. "No `p_user_id` argument" and "derive the caller from `auth.uid()`" —
the parts of the house rule that actually guard against impersonation — are unchanged; only the
INVOKER/DEFINER choice moves, and only for the reason §105 itself names as sufficient. The
pre-existing `recompute_lot_quantity_remaining` D1 trigger (also SECURITY DEFINER, for the same
reason applied to `acquisition_lots.quantity_remaining`) is the precedent this follows.

**4. `sale_lines.allocated_shipping_charged_minor`.** DATA_MODEL.md §5.11's original sketch listed
only `allocated_shipping_minor`, with no separate column for the buyer-paid-shipping allocation
FINANCIAL_MODEL.md §4.5 requires ("shipping charged to the buyer is allocated identically and adds
back"). Folding it into the existing column would make outbound cost and buyer credit
indistinguishable on an audited line — a straightforward schema correction, not a design change,
following the same "fix the schema rather than hide the value" instruction this milestone's prompt
gave explicitly (§39).

**Consequence.** DATA_MODEL.md §5.6/§5.7/§5.11 and FINANCIAL_MODEL.md §4.3 are updated to match the
shipped schema exactly — this decision is what they now cite for the residual/adjustment rule and
the SECURITY DEFINER exception, rather than leaving either implicit in migration comments alone.

## D-061 — M11 sealed inventory: `sealed_intent` moves to `acquisition_lots`; sealed reuses the card acquisition/valuation machinery unchanged

M11 (Sealed Inventory) audited the pre-existing sealed schema (`sealed_products`, `holdings.
sealed_intent`, `holdings.sealed_product_id`, `purchase_lines.sealed_product_id`) before building
any UI on top of it, per the milestone prompt's explicit instruction not to assume a schema sketched
years earlier in DATA_MODEL.md was still correct just because nothing had exercised it yet. Two real
findings, one requiring a schema change and one confirming the existing design was already right.

**1. The real defect: `sealed_intent` on `holdings` cannot represent mixed intent among identical
physical units.** `holdings_identity` (the unique index preventing the same physical state from
fragmenting into duplicate holdings, DATA_MODEL.md §5.4) does not — and should not — include
`sealed_intent`: intent is explicitly organisational, like `storage_location_id`, not a distinguishing
property of "what is this." But that means every acquisition lot for the same sealed product/
condition/grading-state combination collapses into one holding row, and a holding-level
`sealed_intent` column has exactly one value for the whole position. Tested directly against the
concrete scenario the prompt named: a user owns three identical booster boxes and wants two "keep
sealed" and one "planned to open." The pre-M11 shape cannot express this — `create_purchase`
(M8) already defaulted every new sealed holding's intent to `'undecided'` at creation and never
touched it again on a repeat acquisition matching the same identity, so a second or third purchase
of the same product silently inherited whatever intent the first one happened to get.

**Decision: relocate `sealed_intent` to `acquisition_lots`.** `acquisition_lots` already tracks
quantity as discrete batches (one row per acquisition event) and already has a real precedent for
"an organisational correction that must be explicit and auditable, not a silent edit" — voiding, and
`storage_location_id`'s own M6 relocation off `holdings` for the identical reason (D-036). Moving
`sealed_intent` there is the direct continuation of that same precedent, not a new pattern.
`holdings` keeps its role as pure identity ("N units of Product X, in total"); a Portfolio tile
aggregates its constituent lots' intents for display (`list_portfolio`/`holding_summaries` gained
`qty_keep_sealed`/`qty_planned_to_open`/`qty_undecided`, one `FILTER`ed `SUM` each inside the
existing materialized lot-aggregation CTE — no new join, no per-row correlated subquery, so the real
10,000-lot Portfolio benchmark result (D-054/D-059) is unaffected by construction, re-run to
confirm rather than assumed).

Changing a lot's intent for less than its full remaining quantity requires splitting it — a new RPC,
`set_sealed_lot_intent(p_lot_id, p_intent, p_quantity default null)`, SECURITY INVOKER (RLS already
lets the owner write their own rows; the only reason this needs an RPC at all, rather than a plain
column-level UPDATE grant, is that a partial split must insert a sibling lot and shrink the original
atomically). Both resulting lots keep the original lot's `unit_cost_basis_minor`/
`unit_cost_basis_nok_minor` unchanged, and the original's `residual_minor`/`residual_nok_minor` stays
entirely on the shrunk lot rather than being divided — conserving total cost basis exactly, and
never treating an organisational split as a valuation or cost-basis event (prompt §20/§80). The
alternative considered and rejected: folding `sealed_intent` into `holdings_identity` so differing
intent produces a genuinely separate holding. Rejected because it would turn "I want to open one of
my three boxes" into a second, duplicate-looking Portfolio row for the same product — the prompt's
own stated preference (§19) is that a mixed-intent product remains one understandable tile with a
breakdown, which only the per-lot model supports without also duplicating Portfolio rows.

A related, narrower correction found in the same pass: `create_purchase`'s acquisition-lot INSERT
never set `sealed_intent` at all (it was written when the column still lived on `holdings`, defaulted
there instead) — left unfixed, the very first sealed purchase line after this migration would have
failed the new not-null-when-sealed trigger check outright. Fixed in the same migration set,
alongside adding an optional per-line `sealed_intent` field to `create_purchase`'s own JSON contract
(defaulting to `'undecided'`, the same default `add_card_acquisition`'s direct-add path uses) so a
purchase can capture real intent at acquisition time instead of every sealed purchase landing on
"undecided" until a separate action changes it.

**2. Confirmed correct, unchanged: everything else pre-existing sealed schema already had right.**
`sealed_products`' curated-vs-private RLS split (`created_by_user_id null` = curated, readable by
all; non-null = owner-only), `manual_valuations`' generic `holding_id` keying (already usable for a
sealed holding with zero schema change — it was pulled forward into M6 for graded cards, D-038, and
turns out to have been built sealed-agnostic from the start), and `create_purchase`'s existing
'sealed' line-type branch (already created a real holding + lot, not a financial-only record) all
needed no correction. `add_card_acquisition` (M6) gained a genuinely new capability — a direct,
outside-a-purchase sealed acquisition path (`p_sealed_product_id`/`p_sealed_intent`, appended
parameters, DROP+CREATE per the added-parameter rule TESTING.md §6a already documents) — but this is
an addition, not a fix to anything that was wrong.

**Consequence.** DATA_MODEL.md §5.4/§5.5 are updated to show `sealed_intent` on `acquisition_lots`,
with the cardinality reasoning above; §3.3 gains a short note on M11's actual (deliberately modest,
individually-sourced) curated seed and the no-image-upload policy for a user-added product. No
FINANCIAL_MODEL.md change was needed — §6.3's manual-only sealed valuation rule already anticipated
this exactly, unaffected by which table `sealed_intent` lives on.

---

## D-062 — M12 manual valuation history: the economic-interval reconstruction model

**2026-08-30 · Accepted (implementation candidate, awaiting review)**

**Context.** `manual_valuations` has been append-only since M6: `effective_from`, `created_at`,
`superseded_at`. M12's historical snapshots need "which manual value was active on date D"
answerable for *any* D from canonical rows alone — and the prompt flagged this schema as a
high-risk audit item, warning not to assume `superseded_at` is the economic end date.

**Audit result: the existing schema is sufficient; no migration needed.** The reconstructable
model is:

- Sort a holding's valuation rows by `(effective_from, created_at, id)` — a total, deterministic
  order.
- Each row economically owns `[effective_from, next row's effective_from)`.
- The last row by that ordering owns `[effective_from, date(superseded_at))` when it has been
  superseded **by a clear** (`clear_manual_valuation` supersedes without inserting a
  replacement) — here `superseded_at`'s wall-clock date IS the economic end, because clearing is
  exactly the user saying "stop valuing this manually as of now". A still-active row owns
  `[effective_from, ∞)`.
- Consequences: a backdated set rewrites history from its own `effective_from` forward
  (corrections rewrite history — the same semantics voided sales have); two rows sharing an
  `effective_from` collapse deterministically, the later-created winning from that date; and a
  backdated correction landing before a later-effective row truncates that row's interval rather
  than fighting it.

**Alternatives rejected:** treating `superseded_at` as every row's end date (breaks under any
backdating — the corrected value would never apply retroactively, defeating `effective_from`);
a wall-clock event replay (cannot answer "what does the corrected timeline say", which is what
full-rebuild-equals-incremental demands). Both fail the byte-equality gate or fabricate.

**Consequences.** Implemented once, in `rebuild_portfolio_snapshots`
(20260830120010_m12_rebuild_engine.sql); tested across set/update/clear/backdated/
multi-correction sequences in tests/db/m12_dashboard_snapshots.test.ts. FINANCIAL_MODEL.md §6
gains the matching historical-resolution wording.

**Resolved after independent review — the clear-then-later-insertion corner.** The original
statement above left one sequence undefined: a row cleared on day X, then — as a genuinely
separate later transaction — a NEW valuation inserted with a higher `effective_from`. Reading
"each row owns up to the next row's effective_from" there resurrects the explicitly cleared
value across the gap days, silently undoing the user's clear. The schema already distinguishes
the two ways a row can end, because `now()` is the transaction timestamp:

- ATOMIC REPLACEMENT (`set_manual_valuation` supersedes and inserts in one transaction): the old
  row's `superseded_at` equals some row's `created_at`. The replacement's `effective_from`
  defines the economic boundary, exactly as originally documented.
- INDEPENDENT CLEAR (`clear_manual_valuation`, or any supersession whose timestamp no created_at
  shares): the row ends at its OWN clear date; the gap before the later insertion resolves
  through the normal automatic/missing path.

The engine implements this via a pairing test ("does ANY row share this supersession timestamp")
rather than comparing against the sort-next row — a still-later backdated correction can sort
between a row and its true successor, and misreading that as a clear would create overlapping
(double-counted) intervals. Regression tests cover both readings' distinguishing sequences in
tests/db/m12_dashboard_snapshots.test.ts, the independent oracle
(test/m12-independent-adversarial), and scenario S/S2 of the adversarial semantics suite.

## D-063 — M12 snapshot cache shape: the sketch survives audit; coverage flags added

**2026-08-30 · Accepted (implementation candidate, awaiting review)**

DATA_MODEL.md §6's original column sketch survived M8–M11 essentially intact — audited per the
prompt's instruction to distrust old sketches, unlike M10/M11's finds. The sketch's columns are
all present unchanged. The one deliberate semantic addition: readers get coverage honesty via
`unvalued_lot_count` vs `open_lot_count` (exposed as `has_coverage` by `get_portfolio_history`).
A day whose open lots are entirely unresolvable stores CMV = 0 — the true sum over an empty
valued set — with both counts equal, and the UI renders that as a gap / "No price history yet",
never as a chart point implying worthlessness (prompt §33). Absence of ROWS entirely (before the
user's first tracked date) remains how "no history" is expressed. `NOT NULL DEFAULT 0` on these
aggregate columns does not violate M1: they are sums over well-defined sets, not facts about
single items; M1's NULL-means-unknown rule governs facts, and no fact column is involved.

## D-064 — M12 recompute architecture: database-side engine, trigger invalidation with LEAST coalescing, SKIP LOCKED drain on a 15-minute cron offset from price ingest

**2026-08-30 · Accepted (implementation candidate, awaiting review)**

The engine lives in Postgres (`rebuild_portfolio_snapshots`, `drain_portfolio_recompute_queue`)
because an external worker adds a moving part, a secret surface and a cost vector for zero
benefit at ≤10 users. Invalidation is trigger-driven with explicit boundaries per business event
(acquisitions/purchases/sales/disposals/manual valuations from their own or least(old,new)
dates; shared price/FX/thinning facts fan out to affected owners statement-level via transition
tables), coalescing through LEAST so repeated edits can never move a dirty boundary later and
silently skip older history (prompt §15/§35). The worker is one pg_cron entry every 15 minutes
at :07/:22/:37/:52 — deliberately offset from M9's */15 ingest ticks so fresh observations are
consumed on the next tick rather than racing them — plus a daily sweep guaranteeing current-date
snapshots even with zero activity and promoting stranded future-dated work once due. Per-user
failure isolation uses PL/pgSQL subtransactions (savepoints inside ONE outer transaction, not
per-user commits): a failing user's partial writes roll back to its savepoint, its queue row
survives, siblings continue — while everything successful in the batch remains part of the outer
transaction until the function returns (an outer failure rolls the whole batch back together;
only recompute work is repeated next tick, no corruption either way). SECURITY DEFINER on the
engine functions is the minimal departure from the INVOKER default that shared-market-data
invalidation and the cron worker require; browsers hold zero EXECUTE on any of them (grant-audit
+ the authorization suite enforce both).

## D-065 — M12 custom collections have no historical chart; scope shows current truth only

**2026-08-30 · Accepted (implementation candidate, awaiting review)**

`custom_collection_members` records current membership, never membership events. Projecting
today's membership backwards under a "Portfolio history" label would fabricate data. Of the
prompt's three options, A is chosen: Main Portfolio gets the canonical historical chart; a
custom-collection scope shows correct CURRENT value/counts plus the explicit sentence
"Historical collection membership is not tracked yet — this chart follows your Main Portfolio
only." Option B (historical value of the current member set, labelled) was rejected because a
label never survives contact with a screenshot; Option C (a membership event table) was rejected
as unjustified scope ahead of any real product need. `get_portfolio_history` is deliberately
unscoped-by-collection; revisiting C requires a product decision, not an implementation one.

## D-066 — M12 chart library: TradingView Lightweight Charts v5.2.1 adopted; attribution implemented in full

**2026-08-30 · Accepted (implementation candidate, awaiting review)**

Reverified against current official sources before installing (npm registry, the v5.2 docs, the
repository LICENSE/NOTICE): current release 5.2.1 (published 2026-08-12), Apache-2.0 (plus BSD-0
tslib portions), client-side only, ES2020 target, TypeScript types included — and, contrary to
the pre-prompt mentor note, the package declares NO `engines` constraint at this version, so the
reported "Node >=22.3" requirement does not exist in what we ship against. Bundle measured from
our real build: 194 KB raw / 62.3 KB gzip in its own lazy chunk, loaded only when the dashboard
actually has ≥2 covered points to draw; the entry chunk grows only ~15 KB gzip for the dashboard
code itself (~320→373 KB raw / ~98→113 KB gzip). The spike validated responsive resize,
touch/crosshair behaviour, whitespace gap items (the honest-gap mechanism), theme switching
without reload (applyOptions driven by a MutationObserver on `data-theme`), unmount cleanup, and
route-level splitting via dynamic import().

Attribution compliance per the license's own terms: the NOTICE text ("TradingView Lightweight
Charts, Copyright (c) 2022 TradingView, Inc.") lives at the top of PortfolioValueChart.tsx; the
required user-visible link to https://www.tradingview.com/ renders beneath the chart as muted
10px text; and the library's built-in attribution logo (`layout.attributionLogo`, default-on)
stays enabled — the official docs name it as independently satisfying the link requirement, so
the requirement is met twice rather than hidden either way. Fallback visx was not needed and was
not installed (never two chart solutions).

**Re-verified against live official sources (2026-08-30, review follow-up):** the npm registry
manifest for lightweight-charts@5.2.1 declares `license: "Apache-2.0"` and carries NO `engines`
field (confirming again that no Node-version constraint ships at this version); the LICENSE file
at the v5.2.1 tag is the Apache License 2.0 text ("Copyright 2023 TradingView, Inc." in its
boilerplate appendix); the NOTICE file at the same tag now reads "TradingView Lightweight
Charts™ Copyright (c) 2025 TradingView, Inc. https://www.tradingview.com/" — the year moved from
2022 to 2025 upstream, and PortfolioValueChart.tsx's quoted attribution was updated to match the
current published text. No licensing incompatibility exists; the library stays.

## D-067 — M12 display-currency history converts each point with its own date's FX

**2026-08-30 · Accepted (implementation candidate, awaiting review)**

A NOK snapshot on date D shown in EUR/USD converts with the Norges Bank observation on or before
D — the finance-consistent reading, which legitimately includes FX movement in display-currency
history. Storage stays NOK-only (no snapshot duplication); frozen purchase/sale FX is untouched
(F11); a missing rate renders NOK-with-a-note rather than a fabricated conversion.
`get_portfolio_history` performs the exact numeric division server-side and returns display
minor units alongside the unchanged NOK figure.

## D-068 — M12 historical DCB: adjustments enter cost basis from their occurred_on, floor-allocated per unit

**2026-08-30 · Accepted (implementation candidate, awaiting review)**

Snapshot DCB(D) sums over open-at-D known lots:
`qty_open(D) × unit_cost_basis_nok_minor + floor(adj_total(occurred_on ≤ D) × qty_open(D) /
lot.quantity)`. Exact integers, monotone, and a grading adjustment can never inflate a past
snapshot (prompt §58). The flooring may understate one lot's adjustment share by up to
(quantity − 1) øre mid-life; the D-060 frozen-disposal machinery remains the exactness authority
for realized results, which snapshots do not recompute. `lot_cost_adjustments` currently holds
zero production rows (SELECT-only until M17), so the rule is test-covered rather than
data-proven today.

## D-069 — Reversed rebuild ranges are rejected, not silently reordered

**2026-08-30 · Accepted (ratified by independent review)**

`rebuild_portfolio_snapshots(user, p_from, p_through)` raises when `p_through < p_from` or either
date is NULL, rather than normalizing (swapping or clamping) the arguments. Every legitimate
caller passes a non-reversed range: the drain always passes `dirty_from <= current_date`, the
daily sweep passes `current_date` for both bounds, and manual operational invocations are
explicit acts. The only way to produce a reversed range is a genuine swapped-argument mistake at
an operational console — and launching an unrequested, potentially expensive multi-year rebuild
with no error signal is strictly worse than failing loudly. Pure input-validation tightening on
a service-role-only surface; no working path can break. Covered directly in
tests/db/m12_dashboard_snapshots.test.ts ("M12 input validation") and scenario P of the
independent adversarial queue suite.

## D-070 — portfolio_snapshots stays a derived, rebuildable cache; historical market value may adjust once where M9.1 compaction removes dense observations

**2026-08-30 · Accepted**

M9.1's retention policy (D-058) keeps daily provider observations for 60 days and thins older
history to one observation per ISO week per (variant, provider). When those dense observations
age past the boundary and are compacted, a historical day's market value may legitimately derive
from a DIFFERENT retained observation than the one that was available when its snapshot row was
first computed and shown — so an older historical CMV point MAY change once, permanently, as
compaction reaches it. Accepted deliberately:

1. `portfolio_snapshots` remains disposable and reconstructable from CURRENTLY RETAINED canonical
   facts. "Rebuildable" therefore never means byte-equality against facts that have since been
   compacted away — semantic equality after a rebuild is relative to the canonical source set
   available at that time.
2. Retained provider observations remain real market facts; nothing is fabricated, interpolated,
   or invented. Older history simply uses the weekly-resolution observations D-058 already keeps.
3. Financial ledger history remains FROZEN: purchases, sales, frozen FX, frozen cost basis,
   spend and proceeds never change through compaction. Compaction touches only market-value
   derivation from price observations.
4. Older historical market valuation is an estimate derived from retained market observations —
   not an accounting ledger — and is disclosed as such in the dashboard UI ("Older market-value
   history uses weekly retained market observations").
5. Freezing previously materialized snapshots would silently convert a declared cache into
   irreplaceable canonical data, change backup semantics for M13, and contradict the cache-not-
   ledger architecture (D-063/D-064). The alternative — exempting dates with existing snapshot
   rows from thinning-triggered invalidation — was rejected for exactly that reason.

The full loop is proven in the database by tests/db/m12_retention_rebuild.test.ts: dense history
→ snapshot built → real `thin_price_snapshots()` runs → invalidation fires from the oldest
deleted observation → drain recomputes → the adjusted value derives from the retained weekly
facts with no fabricated zero/missing transition → every frozen ledger column is byte-identical
before/after → deleting the cache and rebuilding from scratch reproduces the post-compaction
series exactly.

## D-071 — MAX means up to four years of tracked history

**2026-08-30 · Accepted**

The MAX chart range resolves to the last 1460 days (4 years) of stored snapshots, not
mathematically unlimited lifetime (`resolveRangeWindow`, src/domain/dashboard.ts). For any user
whose tracked history is shorter than 4 years — every real user for years to come — MAX shows
ALL available history, so nothing visible changes until someone crosses the cap. Recorded as a
decision because it currently lives only as an inline constant: "MAX" must not silently promise
unbounded lifetime history, and revisiting the constant (e.g. raising it once snapshots' storage
cost is re-measured) should be conscious, not accidental.

## D-072 � Holding-level quantity correction: correction is not a sale; purchased lots route to their receipt; a lot can never shrink to zero

**2026-08-24 � Accepted** (parallel session P28, released via PR #42)

Holding Detail gains direct quantity correction (`Adjust quantity`) and removal
(`Remove from Portfolio` / `Remove all`). Semantics, each mirroring an existing lifecycle rule:

1. **A correction here is not a sale.** No proceeds row, no sale line, no realized result, no
   fabricated zero-price disposition. Removal reuses M8.1's `remove_holdings_from_portfolio` ?
   `void_acquisition_lot` void lifecycle exactly; reduction shrinks real lots.
2. **Purchased lots never shrink through this path.** Their quantity belongs to their receipt;
   silently rewriting it would desync inventory from CS/GPO and break the D-060 reconciliation.
   The RPC refuses (`purchase_line_id IS NOT NULL`) and the UI routes to the established
   purchase-correction lifecycle (`update_purchase`) instead.
3. **Shrink-not-disposal for non-purchase lots.** `reduce_holding_quantity(uuid, jsonb)` moves
   `quantity` and `quantity_remaining` down together (D1 holds by construction), touches no
   provenance column, refuses partially-disposed lots (frozen sale basis is untouchable), and
   validates everything under sibling lot locks before the first write � all-or-nothing,
   SECURITY INVOKER, ownership from `auth.uid()` alone.
4. **The last unit is not adjustable.** An adjustment can never empty a holding � that is the
   Remove flow. Enforced in layers: per-lot floor guard (a live lot can never be driven to zero
   copies � the pre-existing unconditional schema CHECK says so), locked aggregate pre-invariant,
   post-image refusal, with the CHECK itself as backstop. A single unwanted lot among siblings is
   retired through the existing per-lot Void control instead.

Alternatives rejected: routing every correction through sale rows with zero proceeds (fabricates
financial history); allowing aggregate-counter mutation (destroys lot provenance); server-side
automatic lot selection (no deterministic rule exists; the owner picks lots explicitly).

## D-073 � Search's set showcase is pinned to English and browses vertically

**2026-08-24 � Accepted** (parallel session P27, owner feedback after M12; released via PR #41)

The Sets-mode showcase lists English sets only, newest first, in a vertical grid � replacing
M7.1's horizontal carousel, which mixed languages and made deep browsing awkward. The language
chips continue to govern text search results only; they do not filter the showcase. Set imagery
normalizes extension-less TCGdex set identifiers by appending `.webp` on the path segment only.

Cheap to reverse (a display-layer choice), recorded because it is product semantics an owner
explicitly chose, so a future session does not "fix" it back to provider-default behaviour.

## D-074 - Export pagination is offset-with-reconciliation, honestly named, and fails loudly on incompleteness

**2026-08-24 - Accepted** (M13 integration)

The export reads each section as PostgREST `.order(pk).range(from, to)` pages: OFFSET pagination
under a stable deterministic ordering. It is NOT keyset pagination and must never be documented as
such (the parallel export-core draft had mislabeled it). True keyset was considered and deferred:
several sections have composite primary keys (`custom_collection_members`, `holding_tags`) where a
universal keyset cursor adds real complexity for no benefit at MVP scale.

What offset pagination does get is completeness enforcement: one exact COUNT per section before
paging starts; cross-page duplicate detection over each section's full primary key (both columns for
join tables), naming the offending row; exact received-vs-expected reconciliation after the walk; and
the existing hard max-page ceiling. A violation raises ExportIntegrityError and FAILS the export - an
incomplete backup is never written quietly. Implemented pure in src/domain/export/pagination-integrity.ts.

## D-075 - No combined "everything" export; client-zip removed from the candidate

**2026-08-24 - Accepted** (M13 integration)

PRODUCT_SPEC 4.12 and ROADMAP M13 define the MVP surface as the CSV suite plus the versioned JSON
backup. The parallel export-core draft additionally shipped exportEverything() (one fetch to JSON +
CSVs + MANIFEST ZIP via client-zip), but no exposed product flow uses it: the export screen offers
exactly two actions, and the integration brief forbids inventing a third button to justify an
already-added dependency.

Decision: the smaller product. exportEverything, the ZIP artifact type and the client-zip dependency
are removed; M13 adds zero new runtime dependencies. If a real one-artifact delivery flow is ever
wanted, reintroducing a store-only ZIP writer is a small isolated change behind an actual user-facing
need. No shipped chunk ever referenced client-zip (it was lazy-loaded); removal guarantees that stays.

## D-076 - Backup format v1 is strict: canonical section naming plus refuse-unknown-keys

**2026-08-24 - Accepted** (M13 integration; resolves the P35/P37 divergence)

Two contradictions between the parallel sources are resolved into ONE coherent v1 rule:

1. Section names equal canonical table names. data.profiles (an array of 0/1 rows, not a singular
   nullable object) and data.sealed_products (carrying ONLY the owner-created subset; curated rows
   travel exclusively via the identity manifest) replace the draft's profile /
   sealed_products_user_created keys. Uniform naming lets a restore iterate tables mechanically and
   lets the independent inventory oracle bind to the artifact without per-section special cases.
2. A v1 reader refuses unknown versions AND unknown data keys. Within-v1 forward tolerance ("old
   reader ignores what a new writer added") was explicitly rejected: a v1 validator cannot distinguish
   a newer writer's section from corruption of a known one, and schema_version exists precisely so
   evolution goes through a bump. A future v2 writer emits v2 files; a future v2 reader owns reading
   them. v1 claims no forward compatibility and its documentation now says so. Optional non-semantic
   metadata has no separate channel in v1 - add it with a version bump or not at all.

Distinguishing test: tests/data/export-backup-envelope.test.ts asserts a same-version file carrying a
new section is refused. The independent oracle's validator was aligned deliberately (unknown sections
are violations there too), not weakened. Integration bindings recorded in
test/m13-independent-adversarial/helpers/contract.ts: the version constant binds as
BACKUP_SCHEMA_VERSION; the CSV-writer probe adapts to buildCsvText(header, rows)'s two-argument
signature by treating a single matrix's first row as the header; the generated-backup contract runs
through a bound runner that creates one synthetic account via the real invitation flow, seeds the
complete relational fixture, signs in with a real JWT and drives the real fetch/build/serialize
pipeline. No oracle expectation was loosened.

## D-077 - Multi-query exports are honest about concurrency: detection, not snapshot isolation

**2026-08-24 - Accepted**

A client-side export spans ~20 separate RLS-scoped reads; it is NOT one PostgreSQL transaction and
must never be described as a transactionally atomic point-in-time snapshot. The meaningful concurrent
mutation source is the owner's own writes (a second device mid-export). Rather than add SECURITY
DEFINER/service-role/Edge infrastructure for this theoretical race: the format contract states plainly
that serialization is lossless for what it read while multi-query export is not globally
snapshot-isolated; cheap detection (D-074's count reconciliation + duplicate guard) makes most real
mutations fail the export loudly instead of producing a silently incomplete backup; on a mismatch,
re-run the export. No RPC, migration or service-role surface was added. Revisit only if a real
corruption report ever shows detection missing in practice.

## D-078 - Share/save is a two-step flow: generate fully, then deliver under fresh activation

**2026-08-24 - Accepted**

navigator.share() requires transient user activation at call time. A single "create then share" tap
loses that activation across the many awaited database round trips of client-side generation - which
is how installed iOS PWAs threw NotAllowedError after long prepares, and why the parallel UI draft's
fallback silently degraded the share path to downloads.

The export screen therefore splits explicitly. STEP 1 ("Create backup" / "Prepare CSV export")
generates artifacts completely and renders a READY state listing filenames and count. STEP 2 is a
fresh tap ("Save / Share ...") whose handler calls the delivery path immediately with the
already-built files - navigator.share always executes under a fresh activation. Artifacts live in
component state only (never localStorage or IndexedDB), are replaced on regeneration and dropped on
discard/unmount. Retry-generation and retry-delivery are distinct paths; a failed delivery retains
artifacts so neither retry nor download-instead regenerates. State machine:
idle -> preparing -> ready -> delivering -> success | cancelled | delivery-failed.

## D-079 - NotAllowedError is surfaced, with an explicit "Download instead" choice

**2026-08-24 - Accepted** (supersedes the parallel UI draft's silent fallthrough)

After D-078 there is no long generation left to blame for a share refusal, so NotAllowedError means
Permissions Policy, an engine security refusal or a genuine activation problem - none of which should
be hidden. The delivery layer throws a descriptive error; the screen keeps the artifacts ready and
offers two explicit buttons: "Try sharing again" and "Download instead". Cancellation (AbortError)
remains quiet and is not styled as an error.

## D-080 - The periodic export reminder ships with a 30-day local-only cadence

**2026-08-24 - Accepted**

PRODUCT_SPEC 4.12 makes a periodic in-app reminder an MVP requirement but fixes no interval. Rather
than defer a required behaviour for a missing parameter, the reminder implements with one named
constant - EXPORT_REMINDER_INTERVAL_DAYS = 30 - chosen as the MVP default: long enough not to nag,
short enough that a lost device costs at most a month of ledger entries, trivially tunable.
Semantics: Profile shows a muted banner when due; the mark is satisfied by a completed export; the
stored value is a bare ISO timestamp in localStorage - no collection or financial data ever touches
storage. Pure logic in src/domain/export/export-reminder.ts, unit-tested including corrupted-store
fallback (a corrupt value degrades to reminding, never to silently skipping).

## D-081 - The M7.1 quick Portfolio CSV stays, as a distinct filtered-view report

**2026-08-24 - Accepted**

Portfolio's Export shortcut and the M13 Export & backup screen are different artifacts, and both
stay. The quick CSV exports the CURRENT FILTERED Portfolio view including derived current values - a
report for getting what is on screen into a spreadsheet immediately. The M13 suite exports canonical
data (unfiltered, ten analysis files) plus the lossless JSON backup - the archival surface. Retiring
the shortcut would delete a genuinely distinct capability without equivalent replacement; keeping it
unlabeled would invite "which export is real?" confusion. It is relabelled "Quick CSV" with tooltip
copy pointing full exports to Profile > Export & backup.

## D-082 - Dashboard refresh settles automatically: every-minute recompute drain plus pending-only summary polling

**2026-08-24 · Accepted** (owner-reported production bug after the parallel release; P42)

Owner repro on the deployed app: quick-add a known-cost test card, remove it from Portfolio —
Home then sat on "Updating…" for many minutes and spend still showed the removed acquisition's
amount. Hosted read-only diagnosis proved the ledger itself correct (every removed test lot's
single-line parent purchase was already auto-voided; zero purchases with all lots voided; queue
empty), so the defect was REFRESH latency, compounding two independent gaps:

1. **Backend cadence.** D-064's :07/:22/:37/:52 schedule left up to 15 minutes of honest
   staleness between a mutation and its snapshot recompute. Revised to an EVERY-MINUTE drain:
   measured no-op ticks complete in ~0.0 s against the hosted project; the drain is bounded
   (batch 20) and SKIP LOCKED, so overlapping ticks cannot process each other's rows; ≤10-user
   scale makes per-tick cost negligible. A nightly `m12-run-log-prune` job bounds the resulting
   run-log growth (~1 440 tiny rows/day) at 30 days of history. No new RPC, no grant change,
   no browser-reachable drain path.
2. **Frontend silence.** Home fetched `dashboard-summary` but polled nothing while
   `pending_recompute` was true, so badge and figures froze at the last fetch until some
   unrelated refetch happened. Home now polls ONLY while pending (3 s interval, inside the
   reviewed 2-5 s band; false while idle — no permanent polling), and the queued→drained
   transition invalidates the one other snapshot-derived query (portfolio history). Monthly
   spend and recent activity read canonical purchase/sale rows directly and are deliberately
   NOT invalidated by a recompute settling. Correction mutations that were missing the
   dashboard-summary invalidation (Holding Detail's per-lot Void, Portfolio select-mode Remove)
   gained it.

A user-scoped self-recompute RPC was considered and rejected: with a ~1-minute worker and
pending-only polling, worst-case settle time is already about a minute, and any such function
would add a new browser-callable surface needing its own abuse analysis for zero UX gain.

## D-083 - Ghost-spend classification: removal never leaves spend behind in the ledger; stale displays are a UI concern

**2026-08-24 · Accepted** (P42 diagnosis record)

The owner-visible "spend still showed the removed test acquisition" was classified
STALE_UI_ONLY, not an accounting defect: `get_dashboard_summary`'s GPO/CS/HS figures are LIVE
sums over canonical non-voided purchases computed inside the same request that reports
`pending_recompute`, and `void_acquisition_lot` voids a quick-add lot's single-line parent
purchase synchronously in the same transaction as the lot. Only CMV/TTEP derive from the
snapshot cache and legitimately wait for the drain. The synthetic contract is pinned in
`tests/db/p42_owner_refresh.test.ts`: quick-add known-cost → remove → GPO/CS return to baseline
EXACTLY; multi-line purchases preserve unrelated lines (accessory spend survives card removal);
partially-disposed inventory stays blocked. If a future report shows spend wrong after a
settle+reload, the defect class to suspect is a live multi-line receipt (correct it through
Purchases), not this correction path.

## D-084 — Correction, void, display filter and full reset are four different things; full reset is the one place hard deletion is intentional

**2026-08-24 — Accepted** (P43)

The owner asked for a portfolio "reset" and, separately, to be able to "ignore/delete" wrong
test entries from History. These are four distinct mechanisms and conflating any two of them
would either lie to the accounting or destroy data by accident:

1. **CORRECTION** — an in-place fix through a lifecycle that recomputes what it affects
   (`update_purchase` for amounts/fees/lines that have no lot; `reduce_holding_quantity` for
   shape changes). Money stays true before and after.
2. **VOID** — the canonical mistake correction (`void_purchase`, `void_sale`,
   `void_acquisition_lot`, superseded manual valuations). Rows are never deleted; they are
   marked voided, excluded from every live total, and remain visible under History's
   show-corrections toggle. This is how an accidental quick-add is undone: spend reverts,
   inventory reverts, nothing is fabricated.
3. **DISPLAY FILTER** — presentation only. History hides voided/corrected entries by default
   behind "Show corrections / voided". Hiding never alters GPO, CS, NSP, CMV, cost basis or
   snapshots. There are no per-event hidden flags to accidentally make load-bearing.
4. **FULL RESET** — `reset_my_portfolio_data()`, the deliberate exception. One atomic
   server-side operation that permanently deletes the caller's owned tracking dataset:
   holdings, acquisition lots, purchases/purchase_lines, sales/sale_lines, lot_disposals,
   lot_cost_adjustments, manual_valuations, collection/tag *memberships*, portfolio_snapshots
   and the recompute queue. It exists because the owner explicitly asked for a blank slate, it
   requires its own confirmation ("Are you sure?" → "Yes, reset portfolio"), and it is the ONLY
   path in the product where a financial row is hard-deleted.

Reset preserves the account, profile/settings and reusable setup metadata: retailers, storage
locations, tags, custom-collection definitions (emptied of members), manual card definitions and
the user's own private sealed-product definitions. Rationale: those describe *how* the user
models their collecting, not *what* they own or spent; re-entering twenty retailers after a test
period would punish exactly the person reset exists to help. The confirmation copy states both
lists plainly.

Implementation constraints that carry the decision's weight: the reset is ONE function call =
ONE PostgREST request = ONE transaction, so a partial reset is structurally impossible; there is
no user_id parameter to forge; deletion order is FK-deterministic with the M12 queue row locked
first so a concurrent snapshot drain cannot resurrect a stale value. SECURITY DEFINER is
necessary, not expedient: browsers hold no DELETE grants on the ledger at all (void semantics,
SECURITY.md §8), and widening those grants to let an INVOKER reset work would undo D-060's core
guarantee. Every statement inside filters by auth.uid(); the full adversarial review lives in
SECURITY.md §3.2.5.

Alternatives rejected: client-side loops of DELETE requests (partial failure = half-destroyed
ledger); voiding every row instead of deleting (an "empty" account would still hold thousands of
voided rows and every total would be honest but the slate would not be blank); per-event hidden
flags in History (a display state that silently becomes an accounting input).

## D-085 — History is one bounded union over canonical event sources; corrections surface through status, not a second table

**2026-08-24 — Accepted** (P43)

History replaces M10's Sold/Traded/Other tabs with a single feed over the event sources that
exist TODAY: purchases, sales, non-purchase acquisitions ("Added") and active manual valuations.
No event-sourcing table is invented for a screen (the same rule get_recent_activity already
follows); Openings (M16), Grading (M17) and Trades (M18) become additional event kinds when
their tables exist, and until then no chip pretends otherwise.

Ordering is keyset on (recorded_at DESC, primary_id DESC) — the recording timestamp orders
deterministically while each row still displays its own business date — paginated in one RPC,
`list_history_events`, with no N+1 and money cast to text. Voided/corrected entries are excluded
by default and revealed by an explicit toggle; a superseded manual valuation never appears at
all because a supersede IS that fact's correction lifecycle (D-062).

Purchase events link to the purchase lifecycle (edit/void), sale events to theirs, acquisitions
and valuations to Holding Detail — History navigates to the existing correction surfaces rather
than becoming a generic delete console (D-084 item 2).

## D-086 — Home's CURRENT figures are live resolved state; snapshots are history only

**2026-08-25 — Accepted** (P48, owner-reported after the P42 signed-in smoke test)

After an ordinary add, Home's value breakdown and spending figures were already current (they
read live state from `get_dashboard_summary`), but the primary "Current Portfolio Value" stayed
on the previous snapshot — labelled "Updating…" as if it were the thing still being computed —
until the background snapshot worker drained. The owner verdict: the headline must feel
immediate.

The adopted rule separates two regimes that had been conflated:

- **CURRENT state is live canonical/resolved state.** Current Portfolio Value = raw + graded +
  sealed as `get_dashboard_summary()` already resolves for open holdings; current TTEP = that
  live CMV + live NSP − CS (formula unchanged). No second RPC, no per-card client computation,
  no N+1: the values were already in the same bounded response.
- **HISTORICAL state is `portfolio_snapshots`.** Chart points, period change and historical
  accessibility summaries stay snapshot-backed. P42's every-minute worker remains exactly what
  it now honestly is: a HISTORY freshness mechanism, not a prerequisite for a correct headline.

Missing-vs-zero carries over unchanged in live terms: holdings with no resolvable pricing make
the current figure "—", never 0; mixed coverage shows the partial sum with the unpriced count
still surfaced; an account that sold everything has a real 0; a never-used account keeps its
empty-state contract. The pending badge moved from beside the headline into the chart area and
was reworded to "Updating history…", because the current value beside it is already current.

Snapshot fields (`market_value_nok_minor`, `ttep_nok_minor`, …) remain in the summary response —
they are the raw material of history and are untouched. Alternatives rejected: computing the
headline from a new live-CMV RPC (duplicate work per load), waiting for the drain with better
copy only (leaves the owner-visible latency), and deriving coverage from snapshot counts
(wrong regime — coverage must describe current state).

---

## D-087 — One source sealed acquisition lot per opening (Option A)

**2026-08-26 — Accepted** (P50, confirmed at P53 integration)

An opening consumes 1..N units of exactly ONE `acquisition_lots` row: `openings.source_lot_id` is
NOT NULL and the consumption is one `lot_disposals(kind='opened')` row per opening (unique
live-per-opening index). Opening units across two different acquisitions is two openings.

Rationale: real usage opens from one purchase at a time; the per-lot residual rule
(FINANCIAL_MODEL §4.3) is exact per lot regardless of how a lot's units are split; and the model
stays widenable — multi-lot consumption later drops the single unique index without touching any
stored row or financial figure. Rejected: disposal-level multi-lot linkage now (more state, no
user story behind it).

## D-088 — Opening current financial semantics; pulled cards carry NO individual basis

**2026-08-26 — Accepted** (P50, confirmed at P53 integration)

Opening creates NO spend anywhere (CS/GPO are byte-identical across an opening); the opening OWNS
the frozen cost it consumed (`openings.cost_nok_minor`, `cost_source='from_lot'|'unknown'`);
every pull lot is structurally uncosted (`origin='opening'`,
`cost_basis_state='unallocated_opening'`, NULL basis columns) so per-card ROI for pulled cards is
UNREPRESENTABLE, not merely hidden. Opening return (§5.3) is analytical scope over kroner the
purchase ledger already counted once and is never additive with TTEP (F8). A known cost of
exactly ZERO is legitimate data when the basis genuinely was zero; UNKNOWN stays NULL — never a
fake zero (M1 at opening scope). Tracking completeness is owner-declared, never inferred;
incomplete tracking suppresses any bare percentage.

## D-089 — Server-side idempotency on opening creation; provisional replay checked BEFORE the purchase

**2026-08-26 — Accepted** (P53; material-comparison scope stated exactly 2026-08-25, P59; replay
provenance corrected 2026-08-26, P62/F-61-1)

Every opening write carries a client-generated UUID idempotency key, stored NOT NULL on
`openings.idempotency_key` and unique per `(user_id, idempotency_key)`. Same key + same material
request ⇒ the SAME committed opening is returned; same key + materially different arguments ⇒
named `idempotency-key-reuse` error (mismatched reuse is rejected because material fields make it
cheaply verifiable — full request hashing would be disproportionate). **What is compared,
exactly:** `create_opening` compares `source_lot_id`, `quantity_opened` and `opened_on`;
`create_opening_from_provisional` compares those (product id, quantity, coalesced opened_on) PLUS
the ORIGINAL provisional receipt's `line_total_minor` (the entered total paid) and its purchase's
`purchased_on`. P62 correction (F-61-1): those two facts are recovered through the committed
opening's retained `provisional_purchase_id` → purchases → that purchase's own line — NOT through
the current `source_lot_id`, which reconciliation repoints at the real replacement lot. The
original provisional rows survive reconciliation (the purchase is voided there, never deleted), so
a LATE retry of the original request matches its own receipt even after linking; walking the
replacement's facts instead would refuse the user's own original operation as key reuse. A key
whose committed opening has no provisional receipt (`provisional_purchase_id IS NULL`) is still
refused via `IS DISTINCT FROM` (cross-path reuse). Money and the canonical business date are
material; a different amount or date under an existing key can never silently replay the old
financial fact. NOT compared (deliberate, non-material auxiliary input): pull list, notes,
tracking completeness, bulk estimate. On the provisional path the key is resolved BEFORE the
purchase insert: a retry after "purchase created + opening committed + response lost" can never
create a second purchase or double-count spend. Client double-click guards are UX only; this
invariant lives in the writer. The client keeps the key inside its in-memory draft so one logical
opening carries ONE key across remounts and retries (memory-only — no localStorage).

## D-090 — Buy-and-open ships with total-paid exactness; line-total CHECK gains largest-remainder tolerance

**2026-08-26 — Accepted** (P53)

The owner-requested "I bought these packs and opened them now" flow enters the RECEIPT TOTAL,
never a per-unit price. The provisional backend contract takes `p_total_paid_minor` and splits it
by integer largest remainder: unit = floor(total/qty) on the line/lot as display/storage value,
residual = total − unit×qty on the acquisition lot's existing residual columns, so Σ attributable
basis equals the entered total exactly through any opening split. To represent this honestly on
the canonical line, M3's equality CHECK `line_total_minor = unit_price_minor × quantity` was
REPLACED by `unit×qty ≤ line_total ≤ unit×qty + qty − 1` (widening only: all pre-existing rows
and every other writer produce excess 0). Rejected alternatives: booking the remainder as fake
shipping/discount allocations (fabricates a fact), two lines (creates a second lot, breaking the
single-source-lot model), and header-total-only exactness (GPO reads line attributable cost and
would undercount by the residual).

Voiding an opening deliberately does NOT void its purchase — including a provisional_opening one.
"VOID OPENING = the opening did not happen"; the purchase is a separate economic fact corrected
through the ordinary purchase-correction surface. This replaces P50's symmetric provisional-void,
which could restore live sealed inventory whose purchase no longer counted (a free sealed lot).

Manual-card pull identities resolve to reusable `manual_card_definitions` rows at submission time,
cached per identity so retries never duplicate definitions; an abandoned definition is safe
reusable metadata containing no fabricated financial fact, while the opening/pulls transaction
itself remains fully atomic.

## D-091 — Backup schema_version 2: Openings-capable export

**2026-08-26 — Accepted** (P53)

M16 introduces canonical user data (`openings` plus the `opening_id` relationships), so the M13
backup format cannot stay lossless at v1: writers emit v2 ONLY, adding the canonical
`data.openings` section (all columns incl. `idempotency_key` and reconciliation provenance, money
as exact text) and extending `acquisition_lots` / `lot_disposals` rows with `opening_id`. v1 files
are NOT retroactively wrong — they were valid pre-Openings exports; restore remains M19 and no
import exists yet. A generated post-M16 backup claiming v1, missing openings, or missing the
linkage fields is a release blocker, policed by the M13 adversarial suite and the independent
M16 backup oracle.

## D-092 — Reconciliation annihilates the provisional world; coverage counts are retained-only; drafts are user-scoped

**2026-08-25 — Accepted** (P56 repair, closing P54 H1/L1 and P55 F55-6/F55-9/F55-10/F55-12)

1. **Reconciliation replaces the provisional purchase — so the provisional world annihilates as
   a unit.** `reconcile_opening_cost` now voids the provisional source acquisition lot in the same
   transaction as the provisional purchase (P54 finding H1: retiring only the consumption would
   let D1 restore a live known-basis sealed lot citing money that just left the ledger — phantom
   inventory). Rows are retained, never deleted. The void-opening policy of D-090 is UNCHANGED:
   "the opening did not happen" keeps the source purchase active; it is reconciliation, not
   voiding, that replaces the provisional purchase.
2. **The reconciliation target must cite a LIVE non-provisional purchase**
   (`p.voided_at IS NULL AND p.origin <> 'provisional_opening'`, joined explicitly in the target
   lookup). Provisional → provisional chains and voided-receipt targets are refused
   indistinguishably from foreign/missing lots.
3. **`get_opening`'s priced/unpriced pull counts and retained value are CURRENT-RETAINED
   semantics** (`quantity_remaining > 0`): a fully-sold pull is sold provenance, reported by
   `sold_pull_lot_count`/proceeds, never as pricing coverage for cards still retained.
4. **Opening drafts are scoped by authenticated user id** in session memory, cleared when
   authentication ends; no account inherits another's draft and an anonymous visitor sees none.
5. **Created manual-card definition ids persist into the user-scoped draft**, so retries after a
   failed opening RPC reuse the same definition row across remounts without heuristic identity
   merging.
6. **Integer-division wording:** plpgsql bigint division truncates toward zero ("floor" prose
   corrected wherever adjustments can be negative); executable arithmetic unchanged.

The widened `purchase_lines_line_total_matches_unit_price` envelope stands UNCHANGED and is now
documented as a GLOBAL purchase-line invariant (every writer excess-0 except the provisional
path's legal 0..qty−1 residual), with direct constraint tests added.

## D-093 — The client clears its whole query and mutation cache on every authenticated identity transition

**2026-08-26 — Accepted** (P63, closing F-61-2)

TanStack Query's module-lifetime client is user-blind: no query key anywhere in `src/` carries a
user id, so on a same-tab account switch (A signs out, B signs in, no reload) B rendered A's
cached Home/Portfolio/History/recent-activity/opening values until refetches resolved. RLS blocked
all continued server access; the stale in-memory render was the leak.

The boundary lives in the auth layer (`src/auth/query-cache-boundary.ts`): AuthProvider tracks the
last OBSERVED authenticated user id and, whenever one observed identity is replaced by a different
one, synchronously — before the new session becomes renderable state — cancels queries,
`queryClient.clear()`s BOTH the query and mutation caches, and clears opening drafts. Rules:

1. **Any identity change clears** (A→signed-out, signed-out→B, direct A→B). In-flight queries are
   cancelled first; late responses for destroyed queries are dropped by query-core and cannot
   repopulate B's cache.
2. **Same-user events retain everything** (TOKEN_REFRESHED / USER_UPDATED / duplicate SIGNED_IN
   compare equal) — refresh churn never blanks app state.
3. **Public/catalog cache is also cleared deliberately.** Blanket clear over userId-scoped keys:
   keys are distributed across many features and unkeyed today, scale is tiny, and structural "no
   A-data renders under B" beats a maintained keying convention. Cost: catalog refetches once per
   sign-in. For a ≤10-user product privacy is preferred over cache preservation.
4. **No localStorage enters the picture**; the boundary is memory-only and idempotent.
5. Residual, disclosed: TanStack v5 mutations cannot be aborted; an in-flight A mutation completes
   under A's own JWT (server-side owner-scoped write), and no `setQueryData` exists in `src/`, so
   nothing of A's lands in B's cache.

Regression coverage: `tests/ui/auth-query-cache.test.ts` (8 cases against real QueryClient
instances, including the in-flight race and pending-mutation cases).

---

## D-094 - Scanner V1: local Tesseract.js OCR over the existing catalog; images never leave the device

**Status:** Accepted (M15, P68 integration). **Date:** 2026-08-26.

M15's scanner identifies physical cards by reading two printed text strips on-device and
resolving them against the app's OWN catalog. This decision records the engine choice and the
boundaries that came with it.

1. **Engine:** Tesseract.js, pinned exact (	esseract.js 7.0.0 / 	esseract.js-core 7.0.0 /
   @tesseract.js-data/eng 1.0.0), LSTM-only OEM, English only in V1. The researched core pin
   (6.1.2) was superseded by npm reality: tesseract.js 7.0.0 declares its own core dependency as
   ^7.0.0 (relaxed-SIMD core selection), so 7.0.0 is the compatible exact version. All three are
   Apache-2.0/MIT respectively; no new external runtime service exists (API_SOURCES unchanged).
2. **Assets are same-origin and build-generated.** scripts/prepare-scanner-assets.mjs copies the
   worker, the three LSTM cores (relaxedsimd/simd/plain) and eng.traineddata.gz from the pinned
   npm packages into public/scanner-assets/v7/ during every build (prebuild). No CDN is ever
   contacted at runtime; nothing binary is committed.
3. **Images never leave the device.** OCR runs locally in a per-session Web Worker created from
   a same-origin script URL; captured blobs exist only in component memory (CaptureStore) and
   are disposed after analysis. Only TEXTUAL catalog queries (existing search_cards via
   src/data/scanner/scanner-catalog.ts), printing-variant reads and ordinary thumbnail GETs
   cross the network. A static audit test pins that no scanner module imports Supabase/fetch/
   TCGdex or logs anything (tests/ui/scanner-network-audit.test.ts).
4. **Identity vs financial variant.** Recognition resolves cards.id only; the committed identity
   is always a card_variants.id chosen by the user from getCardVariants' ACTIVE variants with
   real finish/stamp/subtype/size labels. Nothing visual is ever inferred about holo/reverse/
   stamps/condition.
5. **Batch before write, existing money semantics.** Nothing writes until the review step's
   explicit save; every write is the existing add_card_acquisition with origin-derived cost
   basis through the SHARED fixedCostBasisState helper extracted to
   src/features/collection/origin-basis.ts. Standalone origin set excludes 'opening'
   structurally; default pre_tracking ("Existing collection"); no amounts collected means no
   zero fabricated.
6. **Ambiguous transport failures are surfaced, not retried (updated by D-096).** Each scanner
   batch item now carries a stable client-request-key (D-096), so a connection break after a
   possible commit is safely retried — the server replays the original result for an already-
   committed key. The UI message was updated accordingly ("retry safely — the card will not be
   added twice"). Definite server refusals (evidence of a PostgREST answer: code/details/hint)
   remain non-retryable without editing the item.
7. **CSP and WASM security boundary (D-095):** P69 is now integrated. `script-src` adds ONLY
   `'wasm-unsafe-eval'` — NOT `'unsafe-eval'` or `'unsafe-inline'`. `worker-src` is `'self'`.
   `connect-src` is unchanged. OCR assets are same-origin only; scanner-assets are excluded from
   install-time precache and served via narrow same-origin `CacheFirst` at `/scanner-assets/v7/`.
   Captured user images never reach Cache Storage.

## D-095 — Scanner WASM/CSP and static-asset security boundary

**Status:** Accepted (M15, P69 integrated, P74). **Date:** 2026-08-26.

This decision documents the Content Security Policy and service-worker boundaries that enable
on-device WASM OCR without weakening the application's security posture. P69's architecture
is now integrated into PR #63.

1. **`script-src` adds ONLY `'wasm-unsafe-eval'`.** This is CSP3's distinct grant for
   `WebAssembly.compile`/`WebAssembly.instantiate`. It does NOT grant JavaScript `eval()`.
   `'unsafe-eval'` and `'unsafe-inline'` remain absent.
2. **`worker-src` is `'self'`.** Tesseract's worker is created from a same-origin URL
   (`/scanner-assets/v7/worker.min.js`) with `workerBlobURL: false`, so no `blob:` source
   is needed.
3. **`connect-src` is unchanged.** All OCR asset fetches are same-origin, already covered by
   `'self'`. No new external endpoint is introduced.
4. **OCR assets are same-origin only.** `workerPath`, `corePath`, and `langPath` all point to
   `/scanner-assets/v7/`. The Tesseract CDN defaults are overwritten and never reached.
5. **Scanner assets excluded from install-time precache.** `scannerAssetGlobIgnores:
   ['scanner-assets/**']` keeps multi-MB WASM/binary assets out of the workbox precache
   manifest. They are served through the runtime `CacheFirst` rule instead.
6. **Runtime cache is narrow and versioned.** `CacheFirst` handler matches exactly
   `/scanner-assets/v7/` with `.js|.wasm|.gz` extensions, 90-day expiry, dedicated cache name
   `scanner-assets-v7`. The pattern starts with `/` so it structurally cannot match
   cross-origin URLs.
7. **Captured user images never reach Cache Storage.** Blobs live only in component memory
   (CaptureStore object URLs) and are disposed after OCR analysis. No `localStorage`,
   `sessionStorage`, or `IndexedDB` is used.

## D-096 — Scanner per-item idempotency: client-request-key on add_card_acquisition

**Status:** Accepted (M15, P71, P74 repair, P75 repair). **Date:** 2026-08-26.

Scanner batch items now carry a stable, client-generated UUID (`client_request_key`) that travels
through to `add_card_acquisition`. The server stores it on `acquisition_lots` with a partial
unique index, so:

1. **Same key on retry returns the original result.** A transport-interrupted commit can be
   safely retried — no duplicate holdings. The UI message was updated from "check Portfolio
   before retrying" to "retry safely — the card will not be added twice."
2. **Concurrency race is caught atomically.** All mutations (purchase, purchase_line, holding
   attempt, lot insert, manual valuation) run inside one outer `BEGIN/EXCEPTION` block. When the
   lot INSERT fires `unique_violation` (a concurrent call committed first with the same key),
   the implicit savepoint rolls back ALL changes from the losing transaction — including any
   purchase/purchase_line rows it inserted. The handler re-reads the winner's committed lot and
   returns it. Zero orphan financial rows.
3. **Existing callers are unaffected.** The parameter defaults to NULL; callers that omit it
   (all non-scanner acquisition paths) behave exactly as before. The partial unique index ignores
   NULL values.
4. **Key lifecycle.** Generated once per logical card at `CARD_CONFIRMED` time in the state
   reducer. Survives editing condition/quantity, partial save retry, and transport retry. Changes
   only if the user removes the item and scans a new one.
5. **Design follows D-089.** The pattern mirrors openings' idempotency: replay check before
   holding creation, unique_violation catch on lot insert, same AtomicPostgres isolation semantics.
6. **Material mismatch rejection.** Before replaying an existing live lot, the function verifies
   that all material facts (identity, grading, quantity, origin, cost, date, storage) still
   match the request using `IS DISTINCT FROM` / null-safe comparisons. If material facts differ
   (e.g. a key was reused with a different card), the function raises `idempotency-key-reuse`.
   Display metadata (`is_favorite`, `holding_notes`, `lot_notes`, `manual_value_minor`,
   `sealed_intent`) is deliberately NOT compared — they are mutable under the current model.
7. **Voided lot rejection.** If the keyed acquisition exists but `voided_at IS NOT NULL`, the
   early replay check rejects the stale retry with `idempotency-key-reuse`. A stale network
   retry must never resurrect or falsely report removed inventory. A new logical acquisition
   requires a new request key.
8. **Constraint source safety.** The outer `unique_violation` handler only treats the error as
   idempotent replay when `p_client_request_key IS NOT NULL` AND a row for
   `(user_id, client_request_key)` actually exists after rollback. Unrelated uniqueness failures
   are re-raised.
9. **Backup exclusion.** `client_request_key` is operational retry metadata, not user financial
   data. It is excluded from M13 backup/export (the `fetch-snapshot.ts` SELECT does not include
   it). No backup schema version bump required.
10. **Reset naturally clears keys.** `reset_my_portfolio_data()` deletes `acquisition_lots` at
    step 7. The key dies with the lot. A fresh acquisition with the same UUID key succeeds
    normally (early check finds nothing).
11. **P75 repair — the early replay check never fired against real Postgres.** The first
    end-to-end run of the 21 idempotency DB tests (this milestone's first real-Postgres
    execution) exposed that `if v_replay is not null then ...` was silently skipped on every
    non-voided replay, because `v_replay` is a `record` with a MIXED-null shape (`voided_at` is
    NULL while `holding_id`/`lot_id` are not) — SQL's row-wise NULL test evaluates BOTH
    `IS NULL` and `IS NOT NULL` false for a composite value with some-but-not-all-null fields.
    Execution fell through to the mutation block every time, relying entirely on the coarser
    outer `unique_violation` handler (item 8 above) to return the original lot — which has no
    material-mismatch or voided-lot check at all. Point 7's voided-lot rejection only appeared to
    work because a voided row happens to have every selected field non-null (a uniform record,
    not a mixed one) — masking the defect in that one path. Fixed by testing the NOT NULL
    `lot_id` column instead of the whole record (`if v_replay.lot_id is not null then`, in both
    the early check and the outer handler). Point 6's material-mismatch predicate itself also had
    two inverted null-safe comparisons (`IS DISTINCT FROM` used where `IS NOT DISTINCT FROM` was
    needed, on `unit_cost_basis_minor` and `storage_location_id`), which would have rejected
    every legitimate replay had the surrounding block ever executed. Both fixed in the same pass.
    All 21 DB tests (I1–I21) pass against real Postgres after the fix, including the concurrent
    known/unknown-cost races (I2/I3) and every material-mismatch case (I7–I13). General lesson
    for any future `record`-typed "was a row found" check in this codebase: never test the whole
    record for NULL when its columns can be independently null — test one column declared
    NOT NULL in the schema.

---

## D-097 — Scanner visual recognition: DINOv2-small hybrid, local INT8 index

**Motivated by:** the P75 preview's real device-gate result — physical-card scanning returned
"Couldn't identify this card" on ordinary English cards. A synthetic OCR smoke test (P74/P75)
was not sufficient release evidence; the OCR-first architecture itself needed a second, visual
evidence channel (SCANNER_RESEARCH.md §3.2's "hybrid: embedding match, OCR to disambiguate" was
the anticipated direction, never built before P76).

### Model selection: MobileCLIP is licensing-disqualified; DINOv2-small chosen

MobileCLIP (S0/S2, the SCANNER_RESEARCH.md §3.1 existence proof) was the leading candidate
entering P76. Its pretrained weights are **not usable here**: `apple/ml-mobileclip`'s
`LICENSE_MODELS` file (read directly, not inferred from a tag) is the "Apple Machine Learning
Research Model License Agreement," which grants use "exclusively for Research Purposes" and
explicitly states "Research Purposes does not include any commercial exploitation, product
development or use in any commercial product or service." A portfolio/showcase application —
even a private one, even non-commercial — is product development; committing converted MobileCLIP
ONNX weights into this repository would violate that license outright. (The repo's separate code
`LICENSE`, MIT, and a third, more permissive-looking `LICENSE_weights_data` file exist alongside
it, but `LICENSE_MODELS` is the one that actually governs the pretrained checkpoint per the
project's own `LICENSE` file, which says "The ML-MobileCLIP model weights and data copyright and
license terms can be found in LICENSE_MODELS and LICENSE_DATA.")

**Chosen instead: `Xenova/dinov2-small`** (an ONNX conversion, for Transformers.js, of
`facebook/dinov2-small`), pinned to revision `c2bb04a51fab207c420665f1946016107bffc701`.

- **License: Apache-2.0**, unambiguous, confirmed directly from `facebook/dinov2-small`'s Hugging
  Face model card (`"license":"apache-2.0"`) — permits commercial use, modification and
  redistribution, no ambiguity to disclose.
- **Vision-only.** DINOv2 has no paired text encoder at all (unlike CLIP-family models), so there
  is no dead-weight text tower to strip or accidentally ship.
- **Embedding dimension 384** (ViT-S/14, `hidden_size: 384` per the model's `config.json`) — small
  relative to a 512/768-dim CLIP embedding, which matters directly for index size (§below).
  DINOv2 features are also architecturally suited to **instance-level** visual retrieval (the
  self-supervised training objective and the model's established use in copy-detection/landmark
  retrieval literature), which is a better match for "is this the exact printing" than a
  CLIP-style embedding tuned for semantic/category zero-shot classification.
- **Quantized (`q8`/dynamic INT8) ONNX file**, `onnx/model_quantized.onnx`, verified 24,451,943
  bytes (23.3 MB), SHA-256 `3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917`.
- **Smoke-tested against real images** before any benchmark: same-card-different-resolution
  cosine similarity 0.94, different-card similarity 0.57–0.68 (base1 Charizard vs. Pikachu vs.
  Blastoise, real TCGdex CDN images) — embedding dimension, normalization and same>different
  separation all verified directly, not assumed (prompt §45).

### Benchmark evidence (see docs/SCANNER_RESEARCH.md §7b for the full report)

A real benchmark — 240 reference cards across 6 real TCGdex sets (base1, base2, neo1, swsh1,
swsh7, sv01), 6 deterministic synthetic camera-distortion profiles each, 1,440 augmented queries
— compared four methods using the REAL production domain matcher
(`src/domain/scanner/engine.ts`), not a reimplementation:

| Method | TOP1 | TOP3 | TOP5 |
|---|---|---|---|
| OCR-first (current production path) | 30.5% | 39.7% | 42.1% |
| Perceptual hash (dHash) alone | 86.7% | 93.0% | 95.0% |
| Visual embedding (DINOv2) alone | 99.7% | 100% | 100% |
| **Hybrid (visual shortlist + domain matcher rerank)** | **95.8%** | **99.9%** | **100%** |

The OCR-first number (30.5% TOP1) is close corroborating evidence for the actual device failure
this milestone was created to fix — this benchmark's synthetic distortions independently
reproduce the same order-of-magnitude weakness the owner saw on a real phone. The hybrid method
clears both product-quality targets (§15 of the prompt: TOP5 ≥ 90%, TOP3 ≥ 85%) with wide margin.
Perceptual hashing alone was evaluated and is **not** wired into production scoring: at this
corpus scale it is measurably weaker than the embedding channel and adds no benefit once DINOv2
is present (the pure functions remain in `src/domain/scanner/perceptual-hash.ts` for a future
re-evaluation, per prompt §29, but nothing calls them from the scanner runtime).

**Hybrid scoring calibration (`src/domain/scanner/visual-evidence.ts`):** visual similarity
contributes a **continuous** point value (0 below a similarity floor of 0.55, scaling to a
ceiling of 62 points at similarity 1.0), not a flat per-tier bonus. A flat-bonus first attempt
(+35/+18/+6 for strong/moderate/weak) measurably regressed hybrid TOP1 to 84.4% (below
visual-alone's 99.7%) because a single OCR misread that coincidentally produced an exact
collector-number match on the WRONG card (worth 45 points alone) could outscore the
visually-correct card's flat strong-tier bonus. Continuous scaling — so a near-perfect visual
match earns close to the ceiling while a barely-strong one earns much less — recovered TOP1 to
95.8% without weakening the ambiguity/disagreement behavior prompt §33/§35 require.

### Architecture: LOCAL versioned index (Option A), not pgvector

Decided quantitatively, not by preference (prompt §17):

- 384-dim embeddings, INT8-quantized (each embedding is L2-normalized before storage, so every
  component already lies in `[-1, 1]`, and INT8 uses a fixed symmetric scale — no per-vector
  scale factor needed). Cost per card: 384 bytes.
- At the FULL canonical catalog's ~23,400 English cards, the complete index would be
  **~8.6 MB** — comfortably inside the ≤20–25 MB product budget with headroom for catalog growth.
  This session's demonstration index (240 cards) is **89.6 KB**.
- INT8 vs FP32 TOP1 agreement measured at **100%** across all 1,440 benchmark queries — the
  quantization step costs nothing measurable at this embedding size.
- A local index needs no new RPC surface, no new migration, no backfill mechanism, no additional
  user-facing DB privilege — it is a static asset, exactly like the OCR engine files already
  are. pgvector would have added all of that for a problem an 8.6 MB static file already solves.

**Result: hosted migration count is unchanged at 90.** No `supabase/migrations/` file was added
by this milestone.

### Index coverage: a real, structural gap this session could not close

The generation pipeline (`scripts/scanner-visual-index/build-index.ts`) is real and complete: it
queries a Supabase project's `cards` table directly (via `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
env vars, exactly the credential posture `scripts/portfolio-perf-benchmark.mjs` already
established — never `.env.local`, never committed), downloads each card's TCGdex image, embeds it
with the pinned DINOv2 model, and writes the quantized index.

This session has **no legitimate way to run it against the hosted `pokeportfolio-dev` project**:
the hosted project's `anon` role has no grant on `cards` or `search_cards` (verified live —
both return `permission denied`), and obtaining an `authenticated` session requires either the
owner's real credentials or creating an account, both of which are outside this session's
authority (CLAUDE.md prohibits creating accounts or signing in on the user's behalf). The
committed index (`scripts/scanner-visual-index/generated/visual-v1/`) was therefore generated
against the **LOCAL dev stack** after locally syncing the same 6 real TCGdex sets used for the
benchmark (240 cards, real metadata, real embeddings) — proving the entire pipeline, format,
staging, service-worker caching and browser search path end-to-end, but with **LOCAL
`gen_random_uuid()` card ids that do not exist in the hosted catalog**.

**Consequence, stated plainly:** in the current preview build (pointed at hosted Supabase), the
visual worker's shortlisted card ids will not resolve via `getCardsByIds` against the hosted
catalog, so the hybrid pipeline degrades gracefully to OCR-only behavior for the owner's real
physical cards (safe — no wrong match, no crash — but not yet the improvement this milestone set
out to prove on-device). **One remaining manual step** unblocks this permanently: the owner runs

```
SUPABASE_URL=https://nopmkroeygmlvndzjjqs.supabase.co SUPABASE_SERVICE_ROLE_KEY=<hosted service role key, own shell only> pnpm scanner:index:build
```

once, from their own machine (the key is never pasted to an assistant), commits the regenerated
`scripts/scanner-visual-index/generated/visual-v1/{manifest.json,card-ids.json,embeddings.bin}`,
and pushes — which then ships a hosted-valid index in the next preview build.

### Privacy, supply chain, runtime policy

- The captured card photo never leaves the device. Only the derived 384-float embedding (already
  local-only, browser-to-worker via a transferred `ImageBitmap`) and, for shortlisted candidates
  the text search didn't already find, a `cards.id` lookup cross the network — never the image.
- Model weights are staged same-origin (`public/scanner-assets/visual-v1/model/`), fetched at
  build time from a PINNED Hugging Face revision and verified by SHA-256 before staging
  (`scripts/prepare-scanner-visual-assets.mjs`) — no runtime Hugging Face dependency.
- `onnxruntime-web`'s WASM binaries are ALSO staged same-origin. Reading the installed package's
  actual bundled source (`node_modules/@huggingface/transformers/dist/transformers.js`) showed it
  defaults to `cdn.jsdelivr.net` for these files unless `env.backends.onnx.wasm.wasmPaths` is set
  before the first model load — the visual worker sets this explicitly, first, to same-origin
  paths. A dead (never-executed, override-shadowed) copy of that CDN-fallback string is still
  present in the built JS bundle, exactly like `tesseract.js`'s own bundled CDN-fallback string
  already was before this milestone (`ocr-engine.ts`'s `workerPath`/`corePath`/`langPath`
  similarly shadow it) — verified present-but-unreachable in both cases via a real production
  build grep, not assumed.
- Runtime backend: WASM is the required baseline; WebGPU is used only when
  `navigator.gpu.requestAdapter()` genuinely succeeds (not merely when `navigator.gpu` exists),
  and Safari/non-Safari get different pinned `onnxruntime-web` WASM variants matching the
  library's own internal Safari-detection logic (reproduced locally — this build's
  `@huggingface/transformers` version does not re-export that helper).
- No automatic add. Visual evidence is one more scored input to the SAME domain matcher; the
  existing confirm-before-write batch flow, variant selection and condition entry are unchanged.

### iPhone device gate: still owner-only

Nothing in this milestone substitutes for a real device test. IPHONE_DEVICE_GATE remains
`PENDING_OWNER_RETEST` — see output_76.txt for the 10-card protocol, and the coverage caveat
above for why this round's retest may still show OCR-only behavior on the owner's physical cards
until the hosted index is regenerated.

### P77 addendum — real-device failure repair (Shieldon / Mega Chandelure ex both unrecognized)

The owner's P76 hosted rebuild (`pnpm scanner:index:build` against `pokeportfolio-dev`) logged
`1000 active English cards, 985 have image_base_url` — an exactly-round 1000 that is the
signature of Supabase's default hosted API "Max Rows" setting silently truncating an unpaginated
PostgREST query, not the real size of the catalog. Both real-device test cards (a basic Shieldon,
a Mega Chandelure ex) failed to be recognized. Root-caused to **two independent bugs**, both
fixed this session; a third real preprocessing bug was also found and fixed while investigating:

1. **Unpaginated query truncation (primary).** `build-index.ts`'s original
   `.from('cards').select(...).eq(...).eq(...)` had no `.range()`/count reconciliation at all —
   PostgREST silently returns at most its configured row cap. Fixed by
   `src/domain/scanner/index-pagination.ts`'s `drainAllCardPages`: an exact `count:'exact'` HEAD
   query taken first, then `.order('id').range(...)` pages at 500 rows, reusing the SAME
   completeness primitive M13's export pipeline already proved out
   (`src/domain/export/pagination-integrity.ts`'s `createSectionWalk` — cross-page duplicate-id
   detection plus a final received-vs-expected-count reconciliation that throws rather than ships
   a silently truncated index). Proven against REAL local PostgREST, not just a mock: 1,203
   synthetic English-active rows were seeded into the local dev stack (no images, so no embedding
   cost) and the fixed generator correctly fetched all 1,203 across 3 pages
   (`page 1: 500 rows … page 2: 500 rows … page 3: 203 rows, running total 1203`), while a
   reproduction of the OLD unpaginated query against the SAME local data returned all 1,203 too —
   confirming the local dev stack's own PostgREST does not itself enforce a 1000-row default (that
   cap is a per-project Supabase Cloud API setting, not a PostgREST built-in), so the exact
   truncation could not be reproduced locally byte-for-byte, but the pagination mechanics
   themselves are proven correct against a real multi-page PostgREST round trip regardless of
   which cap value a given project enforces. The seeded rows and their series/set were deleted
   afterward; the owner's real cached hosted checkpoint and the committed index were backed up
   before this proof and restored byte-identical afterward (verified by SHA-256).

2. **Checkpoint contamination across project/model boundaries.** The resumable checkpoint
   (`.visual-index-cache/build-checkpoint.json`, gitignored) carried no identity of what it was
   built against — P76's own hosted regeneration already hit exactly this class of bug once
   (1224/1000 "coverage" from mixed local+hosted embeddings). `src/domain/scanner/
   checkpoint-identity.ts` binds every checkpoint to `{schemaVersion, sourceProjectIdentity
   (derived from SUPABASE_URL's host only — never a key), modelId, modelRevision, embeddingDim,
   quantization}`; a mismatched or pre-P77 checkpoint is discarded LOUDLY (logged, never silent)
   and rebuilt from scratch rather than reused. Packing is additionally constrained
   (`packCurrentCardIds`) to intersect the checkpoint's embeddings with the CURRENT run's fetched
   canonical id set, in that set's own deterministic order — defense-in-depth even if identity
   validation were ever bypassed, and what makes 1224/1000 structurally impossible to reproduce
   again regardless of checkpoint state.

3. **Coverage invariants now enforced, not just logged.** `src/domain/scanner/index-coverage.ts`'s
   `assertValidCoverage` is a single shared check — `cardsIndexed` can never exceed
   `totalCanonicalCards` or `cardsWithUsableImage`; the id-list length, `manifest.cardCount` and
   `coverage.cardsIndexed` must all agree — run by the GENERATOR before it will write any output
   file, by `verify-index.ts` after reading a committed index back, AND by the browser worker at
   runtime before trusting a fetched manifest (defense-in-depth at all three points a corrupt
   index could otherwise slip through). The previous verifier accepted 1224/1000 (122.4%)
   because it checked checksum/model/dimension agreement only — never coverage arithmetic.

4. **A real, independent crop bug in the visual pipeline.** Investigating whether the crop DINOv2
   embeds actually contains the card (prompt §16) found that `controller.ts`'s visual channel
   embedded the ENTIRE captured camera frame (`createImageBitmap(capture.blob)`), while OCR
   already correctly crops to `capture.cardRect` before reading anything
   (`analyze.ts`'s `runOcrAnalysis`). The reference index is built from tight, card-only TCGdex
   images; feeding DINOv2 an uncropped photo (background, table, hands, whatever surrounds the
   guide overlay) is a genuine preprocessing-parity mismatch from the reference distribution — a
   plausible independent contributor to a real-device miss even against a complete, correctly
   hosted index, and one the P76 benchmark could not have caught (it embeds canonical reference
   images on both sides of every comparison). Fixed: `analyzeVisualSafely` now crops via
   `createImageBitmap`'s own `(sx, sy, sw, sh)` overload to `capture.cardRect`, matching what OCR
   already does, at no extra canvas-draw cost.

5. **Manifest source identity.** `manifest.json` now carries `sourceProjectRef` (the same
   non-secret host string the checkpoint binds to) and `sourceEnglishActiveCount` — so the owner,
   or the new debug panel, can see at a glance which project an index was actually built against
   without opening a file.

6. **Diagnostic mode implemented** (`/scan?scannerDebug=1` — an explicit, preview-only,
   user-invoked query param, never shown by default): a bottom panel showing the most recent
   scan's `VISUAL_MODEL_STATE`/`VISUAL_BACKEND`/`MODEL_LOAD_MS`, the actual crop dimensions fed to
   DINOv2, whether an embedding was created and its norm, the loaded index's version/card
   count/source project/load time, top-5 raw visual candidates with similarity, the OCR text
   signals, the final reranked candidates with reason codes, and any visual-channel error — plus a
   "Copy diagnostics" button (`src/features/scanner/diagnostics-format.ts`) that copies exactly
   those fields as plain text and nothing else (no photo, no tokens, no Supabase key, no email, no
   user id). This was explicitly deferred in P76 and is the mechanism for making the NEXT
   real-device failure, if any, diagnosable from one pasted block instead of opaque.

**Not changed:** the model (still DINOv2-small, unmodified selection reasoning above), the
architecture (still LOCAL_INDEX, no pgvector), any migration (still 90, unchanged), any financial
semantic. `SHIELDON`/`MEGA_CHANDELURE_EX` were NOT special-cased anywhere — the fix is entirely
architectural (full-catalog pagination, checkpoint binding, coverage invariants, correct crop).
Whether those two specific cards exist in the hosted catalog and are covered by the (still
unregenerated, since this session has no hosted credential) committed index remains unverified —
see output_77.txt.
