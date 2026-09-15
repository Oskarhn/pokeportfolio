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

### P78 addendum — runtime initialization repair (the model never even loaded on the real iPhone)

The owner deployed the P77-repaired code AND a real full hosted rebuild (20,946 active English
cards, 19,501 embedded, 93.1% coverage — the committed index this session preserved untouched) and
retested on a real iPhone. `?scannerDebug=1` showed `VISUAL_MODEL_STATE=failed`,
`VISUAL_EMBEDDING_CREATED=no`, every downstream field empty: the model failed BEFORE embedding,
before index load — a runtime-initialization failure, not a recognition-quality question. Two
independent, confirmed root causes, both reproduced directly (not inferred) via a real browser
smoke harness serving the actual production `dist/` build with the actual generated `_headers`:

1. **`env.allowLocalModels` was never set (primary, 100% of the failure).**
   `@huggingface/transformers` 4.2.0's own `env.ts` defaults `allowLocalModels` to
   `!(IS_BROWSER_ENV || IS_WEBWORKER_ENV || IS_DENO_WEB_RUNTIME)` — `false` inside a Web Worker
   (confirmed by reading the installed package source, not assumed). `visual-worker.ts` set
   `env.allowRemoteModels = false` (correct — no CDN, ever) but never set `env.allowLocalModels =
   true`, so with BOTH flags false, `AutoModel.from_pretrained`/`AutoProcessor.from_pretrained`
   threw "Invalid configuration detected: both local and remote models are disabled" on every
   single load attempt, on every browser — reproduced identically on desktop Chromium, with no
   COOP/COEP change, proving this was never a Safari/iOS-specific or threading/
   cross-origin-isolation issue at all. One-line fix: `env.allowLocalModels = true` alongside the
   existing `allowRemoteModels = false`.

2. **CSP `script-src` was missing `blob:` (second, independently fatal bug found investigating
   the same failure).** Once (1) was fixed, model loading still failed — `no available backend
   found. ERR: [webgpu] TypeError: Failed to fetch dynamically imported module: blob:...` and the
   identical error for `[wasm]`. onnxruntime-web 1.26.0-dev's WASM factory
   (`web/lib/wasm/wasm-utils-import.ts`, read directly) dynamically `import()`s its own glue
   module and, on its `preload()` path, re-imports it from a `blob:` object URL rather than the
   original same-origin URL — a CSP3 `script-src` grant is required for that dynamic import to
   succeed, and the existing policy (`'self' 'wasm-unsafe-eval'`) never granted `blob:`. Fixed:
   `vite.config.ts`'s `buildContentSecurityPolicy` now grants `script-src 'self' 'wasm-unsafe-eval'
   blob:'` — still no inline script, no remote script host, JavaScript `eval()` still refused.
   Verified directly: a real Chromium page serving the actual `dist/` build with the actual
   generated `_headers` (COOP `same-origin`, no COEP, `crossOriginIsolated=false` throughout)
   loaded the model, embedded a real image and searched the real 19,501-card index successfully —
   for BOTH the `wasm` and `webgpu` device paths — once `blob:` was granted and nowhere else.
   `crossOriginIsolated`/threaded-WASM-memory was investigated as a candidate root cause first (a
   `new WebAssembly.Memory({shared:true})` call does exist, unconditionally, in the shipped ORT
   glue) but is NOT the blocker here — the real repro never required COOP/COEP.

3. **A real, independent structural gap found investigating both bugs: no WebGPU→WASM fallback.**
   `visual-worker.ts` picked exactly one backend up front
   (`backend = useWebgpu ? 'webgpu' : 'wasm'`) and never retried on WASM if that one choice failed
   to initialize for ANY reason (the blob: CSP bug above manifested identically on both paths,
   proving this gap was real and not hypothetical). WASM is the required baseline (prior D-097
   text); WebGPU is optional acceleration that must never take the whole channel down with it.
   Fixed: the selection logic is now a pure, independently unit-tested module
   (`src/domain/scanner/visual-backend-selection.ts`) — `auto` tries WebGPU first when an adapter
   is genuinely available, releases any partial model reference and falls back to WASM on failure
   or absence; an explicit `force wasm` never even probes for an adapter; an explicit `force
   webgpu` failing stays a clean, attributable failure and never silently substitutes WASM. Both
   attempted backends' error reasons are retained on failure, never just whichever ran last.

4. **Diagnostics used to drop the real reason.** `controller.ts`'s `visualError` field was sourced
   only from exceptions thrown inside `analyzeVisualSafely` (`createImageBitmap`/`client.analyze`
   throwing) — a model-init failure never throws there (`VisualRecognitionClient.analyze()`
   resolves `null` gracefully, by design), so `VISUAL_ERROR` showed `—` even when the worker had
   recorded a perfectly good reason. Fixed to fall back to the diagnostics snapshot's own
   `unavailableReason`. The closure-mutated-`let`-across-an-`await` pattern this replaced also
   turned out to defeat TypeScript's own control-flow narrowing (confirmed via a minimal repro —
   `@typescript-eslint/no-unnecessary-condition` flagged the read as provably `null` even though it
   demonstrably wasn't at runtime); `analyzeVisualSafely` now returns its error through its return
   value instead of a captured variable, which is both correct and analyzable.

5. **Backend-attempt diagnostics and a debug backend override added.** The debug panel
   (`?scannerDebug=1`) now shows `VISUAL_BACKEND_REQUESTED`, per-backend `VISUAL_BACKEND_ATTEMPTS`
   (`success`/`failed`/`not-available`/`not-attempted`), `WEBGPU_ERROR`/`WASM_ERROR`, and phased
   `PROCESSOR_LOAD`/`MODEL_LOAD`/`INDEX_LOAD` status — a real-device failure is now attributable to
   one stage instead of one opaque message. A diagnostic-only `?scannerDebug=1&visualBackend=wasm`
   (or `webgpu`) query param forces that backend; absent or invalid always means `auto`; the
   override affects visual-inference backend selection ONLY — never matching, persistence, or
   authentication.

6. **The `checkpoint.failures` counter was cumulative across resumptions, not current-build-based**
   (investigated per the owner's build report: console logged "404: 6" while the shipped
   manifest's `coverage.failures` read 7). `Checkpoint.failures` was incremented every time a
   card's image fetch/decode failed and persisted across a resumed run with no deduplication by
   card id — a card that fails on every attempt (a permanently-404 image) inflated the count once
   per resumption. Fixed: the field is gone; `build-index.ts` now derives `coverage.failures` as
   `cardsWithUsableImage - cardsIndexed` at pack time — inherently current-build/current-card
   based, counts each card at most once regardless of how many times its embedding attempt has
   been retried across resumptions. Did not require re-embedding the 19,501 already-valid
   embeddings to fix — a metadata-derivation change only.

**Not changed:** the model, the architecture, any migration (still 90), any financial semantic,
the committed hosted index (still the owner's own 19,501/20,946 rebuild, untouched by this
session). No card was special-cased anywhere.

### P79 addendum — recognition quality repair (the runtime works; the crop it fed the model didn't)

The owner's next real-iPhone diagnostic (`/scan?scannerDebug=1&visualBackend=wasm`) proved the
whole pipeline runs for real: model ready, a real embedding created, the full 19,501-card index
searched, real candidates returned. Every candidate was still wrong, all tier LOW, similarities
0.73–0.77 (above `weakMin`, below `moderateMin`). This is the FIRST session where the gate is
genuinely recognition quality, not runtime. Investigated per the prompt's explicit hypothesis
list rather than guessed at:

1. **Camera resolution was never requested (the primary, highest-confidence finding).**
   `camera-session.ts`'s `getUserMedia` call carried `{ video: { facingMode: { ideal: 'environment'
   } } }` — no `width`/`height` constraint at all, ever, since M15 existed. The diagnostic's
   `CAPTURE_CROP_DIMENSIONS=252x352` is reproduced almost exactly by hand from the existing,
   UNCHANGED guide-geometry math against a plausible unconstrained-default video track resolution
   (~480×640, a well-known browser fallback when no resolution hint is given) — not a guess: the
   arithmetic (`cardRectFromVideo`'s cover-transform, the guide's 58%-height/86%-width-cap
   fractions) lands within a few pixels of 252×352 for that exact source size. Fixed:
   `{ width: { ideal: 1920 }, height: { ideal: 1920 } }` added to the SAME constraints object —
   `ideal`, never `exact`/`min`, so a webcam or a lens genuinely capped below that ceiling still
   opens exactly as before; this only raises the ceiling a capable phone camera was never being
   asked to reach. This is the single highest-leverage, lowest-risk fix in this session: it does
   not change any code path downstream, only the raw pixels every downstream stage receives.

2. **No rectification existed at all — crop quality, background and mild tilt were fully
   unaddressed (hypotheses B/C/D compounding).** `roi.ts`'s own header comment had explicitly
   deferred this ("no OpenCV, no perspective warp, no rotation heuristics in V1") — now
   superseded. New pure domain module `src/domain/scanner/rectify.ts` (platform-neutral: plain
   RGBA/greyscale typed arrays, no DOM, so the exact same code runs in the browser AND the Node
   benchmark, the same shared-implementation discipline the embedding pipeline itself already
   holds):
   - `detectCardQuadrilateral` — Sobel gradient magnitude, per-side edge-offset search within a
     bounded margin around the guide's own nominal rectangle (16 sample lines per side, outlier-
     rejected least-squares line fit, adjacent-line intersection into four corners), validated by
     convexity/angle/size/aspect sanity checks. Returns null (never a guess) when nothing
     plausible is found — a peak must beat the search band's own average score by 4x AND an
     absolute floor before it counts as a real edge (an earlier draft of this function had a real
     bug here: over a uniform image with zero contrast, "first position checked" was silently
     returned as if it were a detected edge — caught by this session's own test suite before
     landing, see TESTING.md).
   - `warpPerspective` — resamples the detected quadrilateral onto a canonical 5:7 rectangle via
     BILINEAR QUADRILATERAL INTERPOLATION, a deliberate simplification over a full 4-point DLT
     projective homography (the REJECTED alternative): a true homography needs an 8x8 linear
     system solved per capture and is meaningfully harder to get right and verify than direct
     bilinear interpolation, which needs no matrix solve at all — the destination grid's own
     normalized (u, v) position already IS the interpolation parameter. For the moderate
     hand-held tilt this project's guide-overlay capture UX actually produces (not a document
     scanner photographing a page from an arbitrary angle), the two approaches coincide closely;
     documented as a self-contained future upgrade if evidence ever shows otherwise.
   - `rectifyCard` composes both — on detection failure it warps the plain nominal rectangle
     instead, which is PIXEL-EQUIVALENT to a crop+resize (bilinear-interpolating an axis-aligned
     rectangle's own corners), so "rectification failed" and "rectification never attempted"
     produce identical output through the exact same code path, never a second special case.
   - `src/features/scanner/rectify-capture.ts` is the thin canvas glue: expands the guide's
     cardRect by 18% on every side (clamped to the captured frame's own bounds, never upscaled
     past the source resolution) so the detector has real background-adjacent pixels to search,
     then always emits a fixed 700×980 canonical card image regardless of whether detection
     succeeded. `controller.ts` now runs this ONCE per scan, before either OCR or the visual
     channel sees a frame — both consume the SAME rectified image through their existing,
     UNCHANGED code paths (the integration point is exactly one call site). Never throws: any
     failure anywhere in the chain (decode, canvas, detection) resolves to the original,
     unrectified capture — the scanner keeps working exactly as it did before this module
     existed.

3. **Debug tooling gained real image previews and a wider shortlist (prompt §4/§10), not just more
   text.** `?scannerDebug=1` now shows, memory-only, never persisted, never uploaded: the raw
   crop-to-guide-rect image BEFORE rectification, the canonical image actually fed to OCR/DINO,
   both OCR ROI strips, and (debug-only) up to 20 raw visual neighbours with real thumbnails —
   letting the owner see directly whether the correct card exists deeper in the shortlist than the
   production top-5 ever surfaces (a debug session widens the visual search itself to 50
   candidates; production stays at 30, unchanged). `CAPTURE_FRAME_DIMENSIONS` (the full captured
   frame, before any crop) and `RECTIFICATION_USED` were added to the plain-text "Copy
   diagnostics" output. `DebugImageUrlStore` mirrors `CaptureStore`'s own single-owner discipline
   exactly — one set of object URLs alive at a time, revoked on every replacement and on
   `dispose()`.

4. **A harder, more honest local benchmark (prompt §7).** The P76 benchmark's queries are
   resize/rotate/blur-in-place transforms of an ALREADY tight, card-only reference image — it
   structurally cannot exercise "a captured frame with real background around an imperfectly
   aligned, mildly tilted card," which is exactly the gap the real-device diagnostic exposed.
   `scripts/scanner-visual-benchmark/run-hard-benchmark.ts` (new; the P76 harness and its report
   are UNCHANGED, still exercised by its own `pnpm scanner:visual:benchmark`) instead COMPOSES a
   synthetic phone-photo: the clean reference card tilted (±9°), sheared and placed off-center on
   a 1.6x-larger background canvas, then compares four methods against the SAME real production
   code: simple crop (the pre-P79 behavior), a crude 10%-inset tightened crop, the REAL
   `rectify.ts` detect+warp pipeline, and rectified+OCR+rerank through the real domain matcher.
   Full results and their honest interpretation — including a genuinely useful finding (geometry-
   only distortion: rectification lifts TOP3/TOP5 meaningfully, 95.4%→98.3%/96.7%→98.8%, without
   regressing TOP1) and a sobering one (combined glare+shadow+blur on an off-center, smaller-in-
   frame card collapses EVERY method, including simple crop, to near-chance — a photometric-
   normalization problem this session's crop/rectification work cannot and does not claim to
   fix) — are in `ai_outputs/Claude_outputs/output_79.txt`, §"BENCHMARK RESULTS" and
   §"METHOD COMPARISON".

**Not changed:** the model (still DINOv2-small — nothing in this session's evidence points at
model quality as the limiting factor for the geometry-only distortion case; the catastrophic
glare/shadow result is a photometric problem no crop/rectification change could plausibly fix, not
new evidence against the embedding model itself), the architecture (still LOCAL_INDEX, no
pgvector), any migration (still 90), any financial semantic. No card was special-cased anywhere.
Neither Shieldon nor Mega Chandelure ex was referenced in any changed source file.

### P80 addendum — exact-card matching: adaptive OCR ROI, candidate rescue, photometric evaluation

The owner's follow-up real-device facts (runtime/crop/rectification all confirmed working;
Shieldon's true card sat at raw visual rank 6, never shown; Mega Chandelure ex absent from the top
20 entirely; the debug image preview showed both OCR ROIs landing on the wrong card region) moved
the gate to exact-card retrieval quality specifically. Full research: SCANNER_RESEARCH.md §7c.

1. **Adaptive OCR ROI (`roi.ts`/`analyze.ts`).** The single fixed name/number ROI fractions encode
   the VINTAGE Pokémon card layout (name top-left, number bottom-right) — correct research for that
   layout, wrong layout for a modern SM/SWSH/SV-era card like Mega Chandelure ex, which prints the
   name across most of the top edge and the number bottom-LEFT. `analyze.ts` now tries a bounded
   set of named layout candidates per field, scores each OCR result (name: confidence + letter
   ratio; number: confidence + whether the text actually PARSES as a short printed id — parseability
   dominates raw confidence deliberately), and keeps the winner, with an early-exit once a candidate
   is already confident so the common case costs the same one-call-per-field the original pipeline
   had. `nameRoiId`/`numberRoiId` surface which candidate won in the debug diagnostics. A real
   permissiveness bug in P67's own `parseCollectorNumber` (folds short OCR noise, but a long garbage
   string with a stray digit run can still structurally parse) was found and closed with a length
   guard (`looksLikeCollectorNumberText`) while building the number-field scorer — otherwise a
   number-ROI candidate that happened to land on prose could still "win" by accident.

2. **Candidate rescue — retrieval depth and display depth are now separate knobs.** The engine
   previously bounded its OWN retained candidate array to 5, the SAME number the UI displayed — so
   a correct card at raw rank 6 (Shieldon) was discarded by the engine itself before the UI had any
   chance to show it, independent of any UI logic. `SCORING_TIERS.maxReturnedCandidates` raised to
   10 (retention only; tier/margin math is unaffected, since it always reads the true top-2
   regardless of how many the array retains). The UI's own 5-candidate display limit
   (`SCANNER_UI_CANDIDATE_LIMIT`) widens to 8 (`SCANNER_UI_EXPANDED_CANDIDATE_LIMIT`) ONLY when the
   score at the normal cutoff rank is still within the engine's own ambiguity margin
   (`SCORING_TIERS.highMinMargin`) of the top score — a genuinely flat/undifferentiated ranking, not
   merely "confidence is LOW." A HIGH-tier match never expands (it already has a ≥15-point margin
   over its runner-up by construction, so the ranking is never flat at rank 5).

3. **Photometric normalization — built, tested, evaluated, NOT wired into the default pipeline.**
   `src/domain/scanner/photometric.ts` (luma-driven contrast stretch + a bounded 15% blend toward
   greyscale) was investigated because the Chandelure miss's symptom (unrelated foil/full-art
   neighbours) is consistent with the embedding weighting color/foil texture over structure for
   highly reflective printings. A real bounded experiment (`pnpm scanner:visual:benchmark:
   photometric`, new script, same cached 240-card corpus and real rectify/embed pipeline as the P79
   hard benchmark) on the geometry-only `tilted-offcenter` profile showed a wash (plain 93.3%/98.3%/
   98.8% vs. normalized 94.6%/97.5%/98.3% TOP1/3/5, n=240 — differences inside single-flip noise):
   non-regression confirmed, no meaningful uplift on THIS corpus. Critically, this corpus cannot
   test the actual hypothesis: it is keyed by TCGdex-style ids, not the real catalog's UUIDs the
   hosted 19,501-card index uses, so there is no way to ground-truth whether normalization reduces
   confusion among many visually-similar foil cards at REAL index scale — the failure class the
   Chandelure miss actually represents. Decision: ship the tested, safe utility as available
   tooling; do not enable it by default without evidence tied to the real failure mode.

4. **Auxiliary visual signal (second/inner-art embedding) — REJECTED, with a corrected reason.**
   P79 declined this based on the geometry-only benchmark (93–99% across methods) showing no
   evidence of single-embedding brittleness. That conclusion was right about robustness to capture
   noise but measures the wrong axis for Chandelure: TOP1/3/5 against a 240-card pool tests whether
   a distorted query still resembles its OWN reference more than 239 others, not whether it gets
   confused with a DIFFERENT similar-looking card among thousands — genuinely untested, not
   disproven, by either session's benchmark (same id-mapping gap as point 3). The decision to not
   build it THIS session rests on cost/risk under that uncertainty: re-embedding all 19,501 catalog
   cards against a second crop is a multi-hour, irreversible regeneration of committed index assets,
   doubles per-scan worker inference cost, and needs a new merge/rerank contract — not justified
   without evidence it fixes the actual problem. The concrete prerequisite for revisiting this is a
   real-index-scale diagnostic (map a handful of cached-corpus ids to real catalog UUIDs, search a
   real query against the actual committed 19,501-embedding index, inspect true rank as the
   candidate pool of visually-similar cards grows) — described but not built this session.

**Not changed:** the model, the architecture, any migration (still 90), any financial semantic, the
committed hosted index. No card was special-cased anywhere — every fix targets a layout FAMILY
(vintage vs. modern) or a scoring/retrieval RULE, never a specific card id or name.

---

## D-098 — Scanner visual channel: cold-start architecture and evidence-gated model rejection (P81)

**Motivated by:** real-device evidence that superseded D-097's recognition-quality focus. After
P80's exact-card-matching fixes, the owner's real-iPhone retest reported cold visual-channel
initialization taking 106–388 seconds across repeated attempts, and one scan producing no usable
result after 6–7 minutes of waiting. "The visual pipeline can work" (VISUAL_MODEL_STATE=ready was
achieved) is not the same claim as "the visual pipeline is usable" — this decision record is about
making it usable, not about further recognition-quality work (deliberately out of scope this
session per the prompt).

### Root-cause finding, from a real measurement built this session

A new real-browser benchmark (`pnpm scanner:visual:benchmark:cold-start`, Chromium + WebKit,
driving the ACTUAL built `visual-worker-*.js` production chunk — no mocks) measured cold
initialization on localhost at ~1.5–2.1 seconds total, of which ONNX-compile + WASM-instantiate +
session-create is ~0.7–1.6 seconds. That is roughly two orders of magnitude below the real-device
figures. Desktop-localhost network conditions are not iPhone-cellular conditions, so this does not
prove the exact real-device number, but it is strong evidence against "the model/runtime is
inherently slow to initialize" and strong evidence FOR "the real-device time is overwhelmingly
network transfer plus configuration gaps" — because the compile/instantiate work that *is*
architecture-dependent measures in the hundreds of milliseconds, not minutes, even cold.

Two concrete, confirmed configuration gaps compound whatever the real network conditions are:

1. **Cache-Control was wrong.** Every scanner asset — the 24.5MB ONNX model, up to 23.5MB ORT WASM,
   7.5MB embeddings index — was served `Cache-Control: public, max-age=0, must-revalidate`
   (Cloudflare Pages' own default for a non-content-hashed filename, confirmed live via `curl`),
   despite living under version-pinned paths (`v7`, `visual-v1`) that the visual worker additionally
   verifies by exact model revision before trusting anything loaded from them. There was never a
   reason for these specific paths not to carry a long-lived immutable Cache-Control.
2. **Nothing began loading the visual channel until after the user had already captured a photo.**
   `VisualRecognitionClient.ensureReady()` was only ever invoked from inside `analyze()`, itself
   only called from `analyzeCapture`. On a cold device, this means the multi-minute model/index load
   happened WHILE the user was staring at "Analyzing card…", with no warning beforehand and no way
   to know how long it would take.

A third, investigated-but-not-conclusively-implicated factor: `env.backends.onnx.wasm.numThreads`
was never set explicitly. Current official onnxruntime-web behaviour (verified via research this
session) is to auto-detect the absence of `self.crossOriginIsolated` (this app sends COOP but not
COEP) and fall back to single-threaded execution silently and correctly — so this was not a bug,
but leaving it implicit meant the fallback depended on the library's own internal detection rather
than being an explicit, disclosed, version-independent choice. Set explicitly to 1 in that
condition; no behavioural change measured locally.

### Decision: fix the architecture and the configuration, not the model

1. **Route-entry prewarm.** `VisualRecognitionClient.prewarm()` (a thin, explicitly-named alias
   over the existing idempotent `ensureReady()`) is called from `ScannerPage`'s mount effect via
   `controller.prewarm()`, the instant `/scan` opens — before the camera is even requested, before
   any photo exists. The OCR engine's own cold start is staggered ~1.5 seconds behind it
   (`OCR_PREWARM_STAGGER_MS`), because the old `Promise.all([runOcrAnalysis(...),
   analyzeVisualSafely(...)])` pattern in `analyzeCapture` started BOTH cold runtimes (visual ~45MB,
   OCR ~10MB) at the exact same instant on every scan — fine once both are warm, but exactly the
   "don't cold-start both blindly" failure mode on a genuinely cold device. The stagger amount is a
   reasoned heuristic for this session (give the larger, slower download a network/CPU head start),
   not benchmarked against a real device — the owner's retest is what validates it.
2. **Bounded visual wait.** `analyzeVisualBounded` (controller.ts) races the visual channel against
   an 8-second timeout (`VISUAL_COLD_ANALYSIS_TIMEOUT_MS`) ONLY when it was not already warm at the
   moment analysis began; a warm channel is awaited normally, unbounded, matching every prior
   session's tested behaviour exactly. A bound was chosen over either extreme in the prompt's own
   §7 options (disable the shutter entirely vs. never bound the wait): disabling the shutter would
   still leave a user stuck if prewarm itself is slow on a bad connection, and never bounding the
   wait is the exact behaviour the owner's 6–7-minute report showed is unacceptable. A bounded wait
   with an honest, labeled degradation (`VISUAL_ERROR="…still warming up…"`) is the only option that
   is both never worse than a bare multi-minute hang and never silently pretends recognition
   succeeded when it did not.
3. **Cache-Control fix**, `Cache-Control: public, max-age=31536000, immutable` for
   `/scanner-assets/*` (`vite.config.ts`) — safe specifically because these paths are both
   version-segmented AND revision-verified at load time; a stale cached copy can never silently
   masquerade as a different model/index revision.
4. **Cold-start phase instrumentation** (`src/features/scanner/visual/phase-timing.ts`, new): a
   real methodological finding surfaces here too — an initial `self.fetch` monkey-patch inside the
   worker correctly timed the worker's OWN direct fetches (the index manifest/ids/embeddings) but
   reported 0ms/null-bytes for every fetch transformers.js/onnxruntime-web issue internally for the
   processor config, model config, ONNX weights and ORT WASM/glue — evidence those bundled libraries
   hold their own reference to `fetch`, captured before the patch installs. Reading the Resource
   Timing API (`performance.getEntriesByType('resource')`) instead — which the browser populates
   from its network stack regardless of which JS reference initiated a request — fixed this cleanly
   and is now the primary timing source, with the fetch-probe log kept only as a fallback for an
   environment without Resource Timing support.
5. **Worker-owned Cache Storage layer** (`WORKER_ASSET_CACHE_NAME`) wraps the worker's own
   `self.fetch` reference with a cache-through read/write, independent of whether the page's Service
   Worker actually intercepts fetches issued from inside a dedicated Worker — not guaranteed on
   every engine (documented in the code with the specific reasoning). Given the fetch-reference
   finding in point 4, its practical coverage in the current build is the index files; the model/
   processor files already have transformers.js's own separate `env.useBrowserCache` Cache-Storage
   layer (confirmed by reading the installed package source), unaffected either way.

### Model replacement: researched, REJECTED — evidence-gated, same discipline as P80

Current model (`Xenova/dinov2-small`, D-097) is 24.5MB quantized ONNX. Researched candidates for a
smaller permissively-licensed alternative: DINOv3-ViT-S/16 is actually LARGER (~41MB in fp16, a
different generation, not a straightforward drop-in); MobileNet/EfficientNet-class feature
extractors are smaller but have materially different (generally weaker) fine-grained instance-level
retrieval characteristics than a DINOv2-family backbone, which risks REGRESSING the already-open
P80 finding (visual discriminative power at real index scale for foil/full-art cards is unresolved,
not disproven — see D-097's P80 addendum) rather than helping it, with zero benchmarked evidence
either way from this session. Given this session's own cold-start benchmark shows compile/session-
create cost is a few hundred milliseconds to ~1.6s even cold — a small fraction of the reported
real-device total — a smaller model would not address the measured bottleneck (network transfer
and configuration) in any case. Re-embedding all 19,501 catalog cards against a different model is
also a multi-hour, irreversible regeneration of committed index assets — not undertaken without
compelling, benchmarked justification, per this session's own instruction and P80's established
precedent for the identical class of decision (photometric normalization, auxiliary visual signal).

**Not changed:** the model, the architecture beyond the prewarm/bounded-wait/instrumentation/cache
additions above, any migration (still 90), any financial semantic, the committed hosted index, any
P80 recognition-quality fix.

## D-099 — Live worker-progress instrumentation; lightweight perceptual-hash retrieval evaluated and REJECTED; FAST (OCR) baseline reprioritized ahead of DINO (P82)

**Motivated by:** P81's fixes did NOT close the gap. The owner's real-iPhone retest on the P81
preview showed `VISUAL_MODEL_STATE=loading` persisting for over a minute with every
`VISUAL_PHASE_TIMINGS` field reading "—", then a Shieldon scan that OCR also failed to identify
despite the debug screenshot showing the printed name clearly legible inside the name ROI. P81's
8-second bounded degradation worked exactly as designed; the underlying visual-channel prewarm
performance did not improve enough, and the diagnostics that would explain WHY remained blind
during an in-progress stall — P81 only ever reported per-phase timings inside the TERMINAL
`ready`/`unavailable` worker message, so a genuinely stuck init left every phase field unobservable
until it either finished or the owner gave up.

### 1. Live progress instrumentation closes the P81 observability gap

The worker now posts a `progress` message at every phase boundary (worker-module-evaluated,
init-received, processor-load-started/finished, backend-selection-started, webgpu/wasm-attempt-
started/finished, model-load-finished, index-load-started, index-manifest/ids/embeddings-loaded,
index-decode-finished, ready) — see `src/features/scanner/visual/phase-timing.ts`'s
`VisualWorkerProgressPhase` and `visual-worker.ts`'s `postProgress`. The worker-boot message
(`worker-module-evaluated`) fires the INSTANT module evaluation reaches application code, before
`AutoProcessor`/`AutoModel`/onnxruntime-web are touched at all — a worker that never even reaches
this point points at script fetch/parse/module-graph-evaluation cost, not model/index loading, and
is now distinguishable from one stuck in a later phase. `VisualRecognitionClient` keeps a live
snapshot (`workerBooted`, `workerBootMs`, `currentPhase`, `currentPhaseElapsedMs`,
`lastProgressMsAgo`) updated as these arrive, surfaced through the existing `?scannerDebug=1` panel
as `WORKER_BOOTED`/`WORKER_BOOT_MS`/`VISUAL_CURRENT_PHASE`/`DINO_CURRENT_PHASE`/
`VISUAL_CURRENT_PHASE_ELAPSED_MS`/`VISUAL_LAST_PROGRESS_MS_AGO` — all populated DURING loading, not
only at a terminal message. Implemented by wrapping the two non-pure dependencies
(`detectWebgpuAvailable`/`loadModelOnBackend`) inside `visual-worker.ts`'s own `init()`, so
`domain/scanner/visual-backend-selection.ts`'s pure signature and its 14 existing tests are
untouched.

### 2. Lightweight perceptual-hash retrieval: evaluated on REALISTIC capture noise, REJECTED

The prompt's premise — that P76's dHash benchmark (86.7%/93.0%/95.0% TOP1/3/5,
docs/SCANNER_RESEARCH.md §7b) supports a hash-based fast path — was tested against the wrong
corpus. That number came from EASY, resize/rotate-in-place distortions of an already-tight,
card-only reference image, never a captured frame needing real cropping/rectification. This session
built `pnpm scanner:visual:benchmark:hash` (new), running dHash AND a newly-implemented pHash
(DCT-based, `computePHash`, `src/domain/scanner/perceptual-hash.ts`) through the SAME hard,
realistic corpus P79's rectification benchmark uses (tilt + off-center placement composed onto a
larger background, then the REAL `rectify.ts` detect+warp pipeline) — the honest stand-in for an
actual phone photo. Result:

| Method | TOP1 | TOP3 | TOP5 | (tilted-offcenter profile, n=240) |
|---|---|---|---|---|
| dHash | 5.0% | 10.0% | 12.1% | |
| pHash | 23.3% | 30.8% | 36.3% | |
| combined (average) | 18.8% | 27.9% | 32.9% | |

Collapsing to 0-2% on the two profiles combining glare/shadow/blur, identically to DINO's own
catastrophic-failure profiles (P79). Far more decisive: the SAME-card vs. DIFFERENT-card combined-
hash similarity distributions **overlap almost completely** across the full 720-query hard corpus
(same-card median 0.500, p10-p90 = 0.422-0.625; different-card median 0.492, p10-p90 =
0.422-0.563) — there is no threshold that would separate a correct match from a wrong one reliably
at this noise level. For comparison, DINO's rectified TOP1 on the identical geometry-only profile
is 93.3% (P79) — a full order of magnitude better under the SAME realistic distortion. **Decision:
do NOT wire perceptual-hash similarity into `engine.ts`'s scoring as a "fast visual" evidence
channel.** Doing so would inject near-random noise into candidate ranking under exactly the capture
conditions a real scan produces, risking false confidence rather than preventing it (a hash-based
channel that cannot discriminate same-card from different-card is worse than no visual channel at
all, not a cheaper approximation of one). `computePHash`/`packHashRow`/`unpackHashRow`/
`combinedHashSimilarity` ship as tested, available domain-layer tooling (mirroring photometric.ts's
own precedent) — not wired into any production matching path. No hash-index generator, browser
client, or hosted asset was built; building any of that would be exactly the "blindly ship a
complicated pipeline ungated by evidence" this project's discipline exists to prevent. If a future
session finds a genuinely different hash family or a much larger reference-hash pool changes this
picture, the benchmark script and evidence above are the concrete starting point — not a repeat of
this session's own measurement.

### 3. The FAST baseline is OCR + text search, reprioritized ahead of DINO

Given (2), the only real, evidence-backed signal that does not require the ~45MB DINO cold start is
OCR + P67's deterministic text matcher — already shipped since P68, unaffected by this session.
Route-entry prewarm (`controller.ts`) now starts the OCR engine IMMEDIATELY and stages the
heavyweight DINO channel `ENHANCED_VISUAL_PREWARM_STAGGER_MS` (1500ms, same value P81 used, now in
the opposite direction) behind it — a reversal of P81's own ordering, which reasoned (also
unbenchmarked) that the bigger download deserved the head start. OCR's ~10MB cold assets are a
small fraction of DINO's ~45MB, and OCR now provides real signal from the moment it is ready rather
than nothing until DINO finally loads. `ScannerOcrEngine.getState()` (new) reports the OCR engine's
own `not-loaded`/`loading`/`ready`/`failed` state; `ScannerUiController.getFastScannerState()`
(new) exposes it. The intro screen's "Preparing card recognition…" copy (`ScannerPage.tsx`) now
gates on this FAST state instead of the heavyweight DINO channel's own `getVisualPrewarmState()` —
it clears as soon as OCR is ready, not once DINO's cold ~45MB load finally finishes. Debug
diagnostics distinguish both explicitly: `FAST_SCANNER_STATE`/`OCR_RUNTIME_STATE` (the OCR/fast
baseline) vs. `ENHANCED_VISUAL_STATE` (the DINO channel, same value `VISUAL_MODEL_STATE` already
reported). Neither this reordering nor the honest-loading-copy change is benchmarked against a real
device this session (no iPhone available) — same disclosed-not-measured posture P81's own staggering
used.

### 4. OCR preprocessing: Otsu binarization added as a bounded fallback variant

The Shieldon evidence (name ROI visually legible, OCR output garbage) pointed at preprocessing, not
ROI geometry (already fixed by P80). `roi.ts` gains `otsuThreshold`/`binarizeGrayscale` — a
self-calibrating (per-image) hard threshold, oriented so the minority pixel class (assumed to be
text on a mostly-background strip) renders as dark-on-light. `analyze.ts`'s `readBestRoi` tries the
existing `contrast` (percentile-stretch) pass first, UNCHANGED call-for-call from P78-P81 — a
`binarize` retry over the same candidates only runs when `contrast` found NOTHING usable from ANY
candidate for that field, so an already-working scan pays zero extra cost; only the already-failing
case (full-frame fallback would otherwise be the only recourse) gets a second, differently-processed
attempt first. Not benchmarked against a real device this session (no representative real-photo
corpus with ground-truth OCR text available) — a bounded, evidence-motivated but real-device-
unverified addition, disclosed as such.

**Not changed:** `engine.ts`'s scoring model (no hash-evidence channel added), the committed 19,501-
card DINO index, any migration (still 90), any financial semantic, P80's adaptive-ROI candidate
selection logic itself (only a new preprocessing axis was added around it).

## D-100 — Build identity, stale-deployment detection and chunk-load-failure recovery (P83)

**Motivated by:** a real-iPhone P82 test returned an OLD diagnostics schema (missing every
`WORKER_BOOTED`/`FAST_SCANNER_STATE`/etc. field P82 added) and OLD capture dimensions
(`CAPTURE_CROP_DIMENSIONS=252x352` instead of P79's `746x1044`) — proof the phone was executing
stale cached JavaScript, not current-code regression. After the scan, pressing the scanner's X
button produced a full-page crash: `'text/html' is not a valid JavaScript MIME type`. Root cause,
reproduced directly against the live PR #63 preview and this repo's own `vite preview` server: with
no top-level `404.html`, Cloudflare Pages (and, separately, `vite preview`'s own dev-only SPA
fallback) rewrites ANY request that doesn't match a real file to `index.html` at `200 text/html` —
including a content-hashed chunk a redeploy already removed. The X button navigates to `/portfolio`
(a lazy `React.lazy` route); a tab still running an OLDER page's module graph requests that OLD
chunk hash, gets HTML back, and the browser's module loader rejects with the MIME-type error the
owner saw. `curl` against PR #63's preview confirmed this directly: `GET
/assets/PortfolioPage-<nonexistent-hash>.js` → `200 text/html`, `Content-Length` matching the
index.html shell.

### 1. Cloudflare nested `404.html`: asset directories get a real 404, navigation paths keep the SPA fallback

**Final mechanism:** `vite.config.ts`'s `cloudflareAssetNotFoundPages()` emits a real
`dist/assets/404.html` and `dist/scanner-assets/404.html` at build time — Cloudflare Pages' own
documented directory-tree 404 lookup ("Pages will attempt to find the closest 404 page... ending
in `/404.html`", developers.cloudflare.com/pages/configuration/serving-pages). A currently-deployed
chunk is served as itself regardless (a real static file is always matched before any 404 handling
is consulted); only a genuinely missing path under `/assets/` or `/scanner-assets/` now gets this
real 404 page instead of the SPA shell.

**Getting here took three attempts, each deployed and curled against the live PR #63 preview
before being rejected — recorded in full because each one directly contradicted a reasonable
starting assumption, and none of the three failures was ever reproducible locally:**

1. **A top-level `public/404.html`.** The obvious first choice. Broke EVERY real navigation route
   — `/login`, `/invite/...`, `/admin/invitations` all started returning a bare 404 instead of the
   application shell (`deployment-check.mjs`'s own pre-existing checks caught all three
   immediately). Cloudflare's own top-level-`404.html` file-presence detection is a PROJECT-WIDE
   switch that disables the automatic SPA rewrite entirely for every unmatched path, not just
   asset ones — `docs/ARCHITECTURE.md` already stated this exact fact ("Pages serves `index.html`
   for unmatched paths when the output has no top-level `404.html`"), a sentence this session
   should have re-read before ever placing a file there.
2. **A `_redirects` rule** (`/assets/*  /missing-asset.html  404`, splat at the path's end,
   confirmed via a live diagnostic to be the only splat placement Cloudflare actually matches —
   an EARLIER `/*.js`-style mid-pattern splat was also tried and silently matched nothing at all).
   Even with correct splat placement, the rule never fired: a missing asset kept returning the
   `200 text/html` SPA shell exactly as before. Root cause, confirmed directly against Cloudflare's
   own docs: `_redirects` does NOT support an arbitrary rewrite status code — "Rewrites (other
   status codes) ❌" — only `200` (proxy) and the redirect codes `301/302/303/307/308` are valid.
   A live diagnostic rule using the IDENTICAL splat pattern with a `302` destination matched
   correctly, isolating the invalid `404` status as the actual defect, not the splat syntax.
3. **The nested `404.html` above — WORKS.** Distinct from case 1 specifically because Cloudflare's
   own docs describe the two as different mechanisms: a NESTED 404 page only answers requests
   under its own directory (and further subdirectories), while the top-level one is what flips the
   SPA-detection switch. Verified directly: a genuinely missing `/assets/*`/`/scanner-assets/*`
   path 404s with real error content; an existing hashed asset is unaffected; `/login`, `/portfolio`
   and `/invite/...` all still return the app shell at 200; `deployment-check.mjs` is fully green
   again (33/33) after being red (3 failures) under attempt 1.

Pinned by two regression tests so neither prior failure mode can silently ship again:
`tests/config/asset-fallback-pages.test.ts` asserts every configured directory is a real
subdirectory (never the project root) and the generated page is never the app shell;
`scripts/verify-scanner-platform-build.mjs` asserts `dist/404.html` never exists at the root while
both nested copies do. This whole class of bug — three attempts, three real regressions, zero of
them visible to `pnpm build` or any unit test — is the concrete reason `deployment-check.mjs` and a
live preview `curl` exist as a mandatory step for any change touching deployment routing: neither
`_redirects` semantics nor Cloudflare's 404.html-presence behaviour can be observed any other way.

### 2. Immutable build identity, exposed at the very top of scanner diagnostics

`vite.config.ts` injects `__APP_BUILD_SHA__` (Cloudflare Pages' own `CF_PAGES_COMMIT_SHA` when
building on Pages, else `git rev-parse HEAD` locally) and `__APP_BUILD_TIME__`, following the exact
`__APP_VERSION__`/`define` pattern already established. `src/platform/build-info.ts` re-exports
these plus `SCANNER_SCHEMA_VERSION`; `diagnostics-format.ts` prints `APP_BUILD_SHA`/`APP_BUILD_TIME`/
`SCANNER_SCHEMA_VERSION` as the FIRST three lines of every copied scanner diagnostics dump — an
owner test must verify `APP_BUILD_SHA` against the PR head before trusting anything else in the
paste, closing exactly the gap the stale P82 diagnostics exposed.

### 3. Stale-client detection: two zero/near-zero-cost signals, no polling

`src/platform/build-freshness-runtime.ts`'s `initBuildFreshnessWatch()` (started unconditionally in
`main.tsx`, before first render) subscribes to: (a) Vite's own `vite:preloadError` event — fired by
the `__vitePreload` wrapper every real `React.lazy` chunk in `router.tsx` already goes through when
a dynamic import fails, cross-browser by construction (vite.dev/guide/build.html), independent of
native `unhandledrejection` propagation; (b) `navigator.serviceWorker`'s `controllerchange` event, a
real newer deployment taking over an already-open tab, at zero network cost. A THIRD, defense-in-
depth signal — a generic `unhandledrejection` matching `isChunkLoadFailure`'s message patterns — and
a rate-limited (`checkForNewDeployment`, ≤1/60s) fetch of a tiny generated `build-meta.json`
(`Cache-Control: no-store`, excluded from the Workbox precache glob) round out coverage for engines/
paths that bypass Vite's own instrumentation.

**Real bug caught and fixed before shipping:** the first `controllerchange` implementation reacted
to EVERY controllerchange unconditionally — including the one Workbox's `clientsClaim()` fires the
FIRST time a fresh page ever becomes controlled by a Service Worker (a transition from no controller
to a controller, not an update replacing one). This is normal on every first install, not staleness,
and reloading the page in response to it broke two unrelated E2E specs mid-test (`pnpm test:e2e`)
before being caught. Fixed by tracking whether a controller already existed when the watch started;
only a SUBSEQUENT controllerchange (a genuinely different Service Worker replacing one already
active) triggers the recovery policy. Pinned by a dedicated regression test
(`tests/ui/build-freshness-runtime.test.ts`).

### 4. Recovery policy: one controlled reload, gated on unsaved scanner work, never a loop

`src/platform/build-freshness.ts`'s `resolveStaleDeploymentAction` (pure, dependency-injected, same
discipline as `domain/scanner/visual-backend-selection.ts`) reloads immediately when
`hasUnsavedScannerWork()` (`src/features/scanner/unsaved-work.ts`, mirroring ScannerPage's
in-memory batch — the app's only real "unsaved work" state) is false AND no automatic reload was
attempted within the last 15 seconds (`RELOAD_LOOP_GUARD_MS` — no reload loops). Otherwise it
surfaces `StaleDeploymentBanner.tsx` (mounted once in `AppShell`) with an explicit "save/cancel your
scan, then reload" prompt and a manual retry button, rather than discarding a nonempty batch
silently or looping forever against a persistently broken deployment. `router.tsx`'s
`defaultErrorComponent` gives the SAME distinct message (instead of TanStack Router's generic
"Something went wrong!" default — the screen the owner actually saw) for a chunk-load failure that
reaches React as a render error rather than a window-level event, without changing the error UX for
any other kind of error.

**Not changed:** P80/P81/P82's scanner recognition logic, the committed 19,501-card DINO index, any
migration (still 90), any financial semantic. Verified end-to-end with a real browser
(`tests/e2e/stale-deployment.spec.ts`, Chromium AND WebKit): a genuinely missing chunk fails to
import in both engines, and the app recovers (reload, never a raw MIME-type crash) via the SAME
`vite:preloadError` production code path in both — chosen over a raw unhandled-rejection trigger
after finding, and disclosing, that WebKit does not surface an `unhandledrejection` DOM event for a
rejection from `page.evaluate()`-injected code the way Chromium does.

### 5. Old hashed asset survival — measured, and less durable than assumed (P83 §9)

Tested directly rather than assumed: a Cloudflare Pages deployment-specific preview URL
(`https://<hash>.pokeportfolio-dev.pages.dev`) from earlier in this SAME session (~15 minutes and
six redeploys prior) no longer served its own original hashed JS asset — a 404, the identical
response its own current deployment gives for a genuinely missing file. The mutable branch alias
(`https://feat-m15-scanner-integrated.pokeportfolio-dev.pages.dev`) obviously cannot preserve an
old generation's assets either, by definition — it always serves whichever deployment is newest.
**Do not treat a deployment-specific URL as a durable long-term reference for asset survival under
rapid iteration** (this session pushed 7 deployments in roughly 15 minutes); the exact retention
window Cloudflare Pages applies to a project's non-latest preview deployments was not independently
documented and is not something this session's evidence pins down further. This finding argues
FOR, not against, the stale-client detection this session built (§3 above): an old client cannot
assume it has any particular grace period before its own assets stop resolving.

---

## D-101 — Content-addressed visual index publishing, runtime integrity gates and cache coherence (P87)

**2026-09-02 · Accepted**

**Context.** P86's independent adversarial audit (F-01, CRITICAL/P0) found that
`/scanner-assets/visual-v1/{manifest.json,card-ids.json,embeddings.bin}` — the visual
recognition reference INDEX (data, rebuilt at least three times: P76/P77/P79) — was served
`Cache-Control: public, max-age=31536000, immutable` at a fixed literal path shared with the
pinned model/engine binaries (which genuinely are content-stable per model revision). The only
runtime check, `EXPECTED_MODEL_REVISION`, verifies the MODEL never the INDEX, so it cannot detect
staleness across a rebuild: a device that already ran the scanner could silently keep using a
stale or incomplete card index for up to a year, with every diagnostic field reporting healthy.
The same audit found the index's declared source-project identity logged but never gated
(F-22), the only committed-index verifier never wired into the actual build/staging path (F-23),
non-atomic multi-file generation writes (F-24), OFFSET pagination not safe under concurrent
catalog mutation (F-25), no proactive cleanup of obsolete Service-Worker runtime caches (F-42),
and a local dirty-worktree build silently naming a stale commit sha (F-43).

**Decision.**

1. **Content-addressed publishing.** The three generation files move under
   `.../visual-v1/index/generations/<contentId>/`, where `contentId` is the first 16 hex chars of
   a SHA-256 over the manifest's semantic fields (excluding `generatedAt`) concatenated with the
   raw `card-ids.json` and `embeddings.bin` bytes (`src/domain/scanner/index-content-id.ts`) —
   deliberately NOT `cardCount` alone, `generatedAt` alone, or `modelRevision` alone, each of
   which the prompt's own audit ruled insufficient. A new file, `.../visual-v1/index/current.json`
   (`{indexVersion, contentId, manifestPath}`), is the one thing a client fetches first, always
   with `Cache-Control: no-cache` server-side AND `cache: 'no-store'` client-side
   (belt-and-suspenders, the same pattern `build-meta.json`/D-100 already established). Every
   `generations/<id>/*` file is genuinely immutable — the URL itself changes when the content
   does, so the directive is finally true rather than merely asserted. Model/engine binaries stay
   at their existing `.../visual-v1/model/` and `.../visual-v1/ort/` paths, unaffected: they are
   content-stable per `VISUAL_MODEL_REVISION`, a materially different lifecycle from the index.
2. **Non-overlapping `_headers` rules.** Cloudflare Pages MERGES headers from every rule whose
   path matches a request (values joined by comma, never one rule overriding another) — a single
   catch-all `/scanner-assets/*` immutable rule is therefore structurally incompatible with also
   serving a revalidating pointer underneath it. `vite.config.ts`'s generated `_headers` now uses
   deliberately non-overlapping prefixes (`v7/*`, `visual-v1/model/*`, `visual-v1/ort/*`,
   `visual-v1/index/generations/*`, `visual-v1/index/current.json`) instead of one blanket rule.
3. **Split Workbox runtime caches.** `visualAssetRuntimeCache` (model/engine, cache name
   `scanner-assets-visual-v1`, unchanged) and a new `visualIndexRuntimeCache` (content-addressed
   generations only, cache name `scanner-assets-visual-v1-index`) — `current.json` matches NEITHER
   pattern, so it is never interceptable by a CacheFirst route (which would silently defeat its
   no-store contract by answering from Cache Storage before the request's own cache mode is ever
   consulted).
4. **Worker-owned cache-through respects `cache: 'no-store'`.** `visual-worker.ts`'s manual Cache
   Storage cache-through (`installFetchProbe`, independent of Service Worker fetch interception —
   not guaranteed for Worker-issued requests on every engine) previously ignored the caller's own
   `cache` mode entirely; it now bypasses both read and write for any request marked `no-store`.
5. **Runtime source-project gate (F-22).** `visual-worker.ts` derives
   `EXPECTED_SOURCE_PROJECT_REF` from `import.meta.env.VITE_SUPABASE_URL` (via the same
   `deriveProjectIdentity` the generator already used) and REJECTS an index whose
   `manifest.sourceProjectRef` disagrees — but only when THIS deployment itself has a real hosted
   project configured (`VITE_SUPABASE_URL` is not the well-known local/CI-placeholder URL). A
   local dev build or CI's own placeholder-URL build has nothing meaningful to gate against and
   stays informational, matching `build-index.ts`'s own local/hosted distinction. `verify-index.ts`
   gained the same gate as an opt-in (`SCANNER_INDEX_EXPECTED_SOURCE_REF`), never derived
   automatically from `VITE_SUPABASE_URL` at verify/build time — that variable is a placeholder in
   CI's `build-and-test` job on purpose, and hard-gating on it there would fail every ordinary CI
   run against the real, correctly-hosted committed index.
6. **`verify-index.ts` is build-load-bearing (F-23).** `stage-index-assets.mjs` now imports and
   calls `verifyCurrentGeneration` directly (via `tsx`, not plain `node` — the staging script now
   runs the same way `scanner:index:build`/`scanner:index:verify` already did) BEFORE copying
   anything into `public/`, failing `prebuild` (and therefore `pnpm build`, including CI's
   `build-and-test` job) loudly on any corruption. The CLI entry point
   (`pnpm scanner:index:verify`) is now a thin wrapper over the same exported function.
7. **Atomic publish (F-24).** `scripts/scanner-visual-index/atomic-publish.ts` extracts
   write-temp-verify-rename as reusable, independently-tested primitives.
   `publishGenerationAtomically` never creates the final `generations/<id>/` directory until the
   staged content passes the SAME checks `verify-index.ts` runs on a committed index;
   `publishPointerAtomically` updates `current.json` LAST, itself via write-temp-then-rename. A
   process killed at any point leaves `current.json` naming the previous valid generation (or
   absent, on a first-ever build) — proven by a dedicated interruption-simulation test, not just
   asserted from reading the script.
8. **Keyset pagination (F-25).** `drainAllCardPages` (`src/domain/scanner/index-pagination.ts`)
   changed from OFFSET (`.range(from, to)`) to keyset (id-cursor, `LIMIT pageSize`) — stable
   under concurrent inserts/deletes anywhere in the table, unlike an ordinal offset walk.
   `build-index.ts` additionally takes an exact count both BEFORE and AFTER the full drain and
   refuses to certify the result if they disagree (no single transaction spans an hours-long
   paginated walk, so this is detection of gross mutation, not true snapshot isolation — the same
   honest scope `pagination-integrity.ts`/D-074 already discloses for the M13 export).
9. **Explicit generator target (F-22, local-dev policy).** `build-index.ts` now requires
   `--target=local` or `--target=hosted` explicitly (or `SCANNER_INDEX_TARGET`) — no silent
   default. `--target=hosted` refuses to run without `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
   already exported (never falls back to the local demo stack for what must be a shippable index).
10. **Bounded stale-cache cleanup (F-42).** `src/platform/scanner-cache-cleanup.ts` deletes any
    Cache Storage entry matching a known scanner-cache prefix but absent from an explicit current
    allowlist, run once at app boot from the MAIN THREAD (not a Service Worker `activate`
    handler — this project's `generateSW` Workbox strategy has no seam for custom activate logic
    without switching to `injectManifest`, a materially larger change; Cache Storage is
    origin-scoped, reachable identically from `window`). Bounded and prefix-scoped: never touches
    an unrelated cache name, never wipes everything.
11. **Local dirty-worktree marker (F-43).** `vite.config.ts`'s `resolveBuildSha()` appends
    `+dirty` to the local-fallback commit sha when `git status --porcelain` is non-empty.
    `CF_PAGES_COMMIT_SHA` (the production path) is untouched — Cloudflare Pages always builds a
    clean checkout, so `git status` is never consulted there.
12. **Runtime checksum + expanded diagnostics.** `visual-worker.ts` independently re-hashes the
    fetched `embeddings.bin` via `crypto.subtle.digest` and compares it to
    `manifest.embeddingsSha256` once per newly loaded generation (never per scan); it also
    cross-checks the fetched trio's own content actually hashes to the `contentId` its URL was
    published under. `ScannerDiagnostics` gained `indexContentId`/`indexSourceProjectExpected`/
    `indexSourceProjectMatch`/`indexRuntimeChecksumVerified`/`indexRuntimeChecksumMs`/
    `indexModelRevision`/`indexGeneratedAt`/`indexEmbeddingsSha256` so a stale or wrong-project
    index is impossible to hide in a debug-panel screenshot or copied diagnostics paste.
13. **P84's debug-only rank-lookup tooling, ported.** P84 (`feat/m15-p84-visual-retrieval-
    forensics`, a sibling branch off the same base commit, not merged) built
    `getExpectedCardRank(cardId)` — re-ranks the last scan's cached query vector against the FULL
    index without re-embedding, gated to resolve `null` outside `?scannerDebug=1` WITHOUT ever
    calling the visual client — and raised the debug-only shortlist/candidate-list depth
    (`VISUAL_DEBUG_SHORTLIST_SIZE` 50->200, `DEBUG_EXTENDED_CANDIDATE_LIMIT` 20->100; production's
    own `VISUAL_SHORTLIST_SIZE` of 30 is untouched). Ported here by hand (not cherry-picked — this
    branch's index-publishing changes touch overlapping worker/client surface) since P87 and P84
    were developed in parallel from the same base and P84 was never merged into this branch's
    history.
14. **Existing 19,501-card index repackaged, not rebuilt.** A one-time migration script
    (`scripts/scanner-visual-index/migrate-to-content-addressed.ts`) repackaged the already-valid,
    already-hosted-sourced committed index under its correct content id, computed locally from the
    committed bytes — zero DINO re-embedding, zero database access, zero owner multi-hour rebuild.

**Alternatives considered.** Query-string cache-busting on the existing fixed path — rejected:
the prompt explicitly disfavors it as the primary design, and it does not stop the Service
Worker's own separate CacheFirst layer from serving a stale entry keyed by the un-versioned base
URL depending on exact Workbox cache-key normalization. Dropping `immutable` and using a short
`max-age` with revalidation instead of content-addressing — rejected as a first choice per the
prompt's own preference for genuine immutability; would still cost a round-trip revalidation on
every cold scanner load. A Service-Worker `activate`-handler cache cleanup — rejected for F-42
specifically because of the `generateSW`-strategy constraint above; main-thread cleanup reaches
the identical Cache Storage entries.

**Consequences.** A rebuilt index (owner-run `pnpm scanner:index:build --target=hosted`) now
mints a genuinely new URL automatically — no cache can ever serve mixed old/new generation data,
and a client already open when a new generation ships picks it up on its next scanner session
(pointer fetch bypasses every cache layer) without needing to wait out any TTL. `stage-index-
assets.mjs` failing loudly on a corrupt index is a deliberate new build-time failure mode; a
developer who edits a generated index file by hand (never expected in normal use) now sees an
immediate, explicit build error instead of a silently-shipped corruption. The runtime
source-project gate means a genuinely wrong-project index degrades gracefully to OCR-only
exactly like a missing/corrupt one always has — never a crash, never a silent wrong-catalog
resolution.
## D-102 — OCR engine forensics; a bounded multi-line collector-number recovery pass; name-lexicon and structured collector-number parsing tooling shipped, NOT wired into production retrieval (P85)

Full account in `docs/SCANNER_RESEARCH.md` §7g. Summary for a session that hasn't read that:

1. **Built the project's first real, ground-truthed OCR accuracy corpus** —
   `scripts/scanner-ocr-benchmark/`, reusing the existing TCGdex fetcher and BOTH existing
   augmentation modules (P76's `augment.mjs`, P79's `hard-augment.mjs`) for 9 realistic
   perturbation profiles per card. Ran actual Tesseract.js 7 PSM/preprocess forensics instead of
   reasoning from single real-device screenshots the way every prior M15 session had to.

2. **The pre-existing PSM 7 (single-line) default was already correct** for both name and number
   fields when a candidate ROI genuinely contains one line — measured directly against 4 other
   modes, not assumed. No PSM change was warranted for the existing single-line pass.

3. **Real bug found and fixed:** a correctly-cropped collector-number strip routinely contains TWO
   visual lines (the id plus an adjacent illustrator-credit or copyright line) on BOTH vintage and
   modern layouts — confirmed by direct visual inspection of the actual crop images on two real
   cards. PSM 7 cannot read a two-line image at all; it returns empty. Fixed with a bounded THIRD
   pass (`analyze.ts`'s `readBestRoi`, new `multiLineExtract` parameter) using PSM 6 (uniform
   block) ONLY for the collector-number field, ONLY when both existing single-line passes
   (contrast, then binarize) already found nothing at all — never extra cost on an already-working
   scan, at most 2 extra recognition calls in the worst case.

4. **A second real bug found and fixed WHILE building the above, before it shipped:** the naive
   version of this fix let a vintage card's copyright YEAR ("© 1995") win as a fake "collector
   number" — a bare, prefix-less 4-digit token that structurally parses via the existing
   `looksLikeCollectorNumberText` but is not a real printed id (this catalog's local ids never
   reach 4 digits without a total attached). Closed with a stricter predicate
   (`looksLikePlausibleMultiLineToken`) used ONLY by the new multi-line fallback — the existing,
   already-tested `looksLikeCollectorNumberText` used everywhere else is untouched.

5. **Full-corpus benchmark result (BASELINE P82/P83 vs. NEW P85):** see §7f's table for exact
   numbers. The fix is real and directly confirmed on individual lightly-degraded images, but its
   measured recovery rate across the full 9-profile perturbed corpus is small — most perturbation
   profiles (blur/glare/shadow/tilt) degrade the small, often-stylized printed collector number
   past what any page-segmentation mode can recover, consistent with §7c/P79's own "combined
   photometric defects collapse every method" finding for the visual channel. Disclosed as a
   genuine, still-open, hard sub-problem — not a claim that collector-number OCR is now solved.

6. **Name-lexicon fuzzy resolution (`src/domain/scanner/name-lexicon.ts`) and structured
   collector-number parsing (`src/domain/scanner/collector-parse.ts`) ship as tested, available
   domain tooling — NEITHER is wired into the production retrieval/scoring path this session.**
   The name lexicon needs a real production-scale unique-name list to be worth wiring in; no
   Supabase credentials were available this session to generate one from the real ~20,946-card
   catalog (the same standing gap every M15 session since P75 has disclosed) — the demo lexicon
   this session generated from the 988-card OCR benchmark corpus (667 unique names, 8,021 bytes)
   is a real, measured confirmation of the "far fewer unique names than printings" premise, but not
   itself production-scale evidence. Wiring either module in ungated by real evidence would be
   exactly the "blindly ship a complicated ensemble" this project's discipline exists to prevent —
   same reasoning D-097/D-099 already applied to the auxiliary visual signal and the perceptual-
   hash channel.

**Not changed:** P80/P81/P82's name-field ROI logic or scoring (name recognition is byte-for-byte
unchanged this session), the committed 19,501-card DINO index, `engine.ts`'s matching/scoring
weights, any migration (still 90), any financial semantic. No card was special-cased anywhere.

## D-103 — evidence-aware matcher redesign closes F-02; visual-dominance guard; OCR-confidence-weighted evidence reliability (P88)

Full account: `ai_outputs/Claude_outputs/output_88.txt`. Responds to the independent adversarial
audit (`ai_outputs/Claude_outputs/output_86.txt`, Opus 5/MAX effort) that BLOCKed release on two
P0 findings — F-01 (stale visual-index caching, owned by a parallel P87 session) and F-02
(visual-evidence scoring, this session).

**F-02, the core problem:** `visualEvidencePoints`' 62-point ceiling at similarity==1.0 was
structurally below a coincidental two-signal OCR text convergence on a WRONG card
(`collector-number-exact` 45 + `name-exact` 30 [+ `language-match` 5] = 75-80) — a realistic
strong visual match (similarity 0.85-0.90) scored only 41-48 points under the old linear curve,
so a single OCR misread that happened to structurally match a different card's printed id/name
could ALWAYS outrank a genuinely correct, strong visual match. This is the audit's identified
mechanism behind the project's own measured 99.7% (visual-alone) -> 95.8% (hybrid) TOP1 regression
(`docs/SCANNER_RESEARCH.md` §7b).

**Fix, two parts, deliberately not just "raise the ceiling":**

1. `visual-evidence.ts`'s point curve is now piecewise, banded to P84's own calibration
   (D-102's sibling session): near-zero in the 'weak' band, a real but capped scale in 'moderate',
   and a discrete jump into 'strong' territory (>= similarity 0.82, P84's own same-card floor)
   reaching ~55-92 points. A realistic strong match now scores ~61-71 — genuinely competitive with,
   though still not automatically dominant over, a coincidental text convergence.
2. A new **visual-dominance guard** (`engine.ts`'s `applyVisualDominanceGuard`) is the actual
   structural guarantee: when the visual channel produces a genuinely STRONG (>= 0.82) anchor for
   one specific candidate, any OTHER candidate whose own visual similarity is none/weak has its
   TEXT-only evidence discounted (halved) before ranking — unless that text evidence is itself
   total-coverage-convergent (id + name + set + language all agreeing, score >= 90, an escape
   hatch for a genuine multi-signal coincidence rather than a two-signal one). The guard never
   fires when no candidate reaches the strong band (so P84's catastrophic ~0.18 regime, where
   WRONG-card similarity is systematically higher than the true card's own, stays fully inert and
   never punishes trustworthy OCR — the opposite failure mode the audit also warned against), and
   never fires against a candidate whose own visual similarity is ALSO strong (two genuinely
   similar prints/artworks — collector number should differentiate those, not a visual veto).

**Verified against the exact pre-P88 formula, not just asserted:** the isolated pure repro (correct
card carries zero text evidence at all; a different, wrong card coincidentally converges on
id-exact + name-exact + language-match) scores, under the OLD formula, correct=48 / wrong=80 (wrong
wins — reproduces the audit's finding exactly); under the NEW formula, correct=100 (clamped) /
wrong=40 (guarded) — correct wins
(`tests/domain/scanner/engine-visual-dominance.test.ts`).

**Verified against the project's own existing benchmark methodology**, not just synthetic
adversarial unit cases: re-ran `pnpm scanner:visual:benchmark` (P76's real 240-card/6-set/1,440-
query corpus, real production matcher, real DINOv2 embeddings) with this session's NEW matcher.
Hybrid TOP1 = **99.4%** (TOP3/TOP5 = 100%/100%), vs. the documented OLD hybrid TOP1 of 95.8%
(`docs/SCANNER_RESEARCH.md` §7b) and visual-alone TOP1 of 99.7% (both figures reconfirmed by this
same re-run). The hybrid-vs-visual-alone gap shrank from -3.9 points to -0.3 points on the
project's own existing measurement — real, run, measured evidence, not merely reasoned.

**F-26** (companion finding): `visual-text-disagreement` was pure unread telemetry (three non-test
`git grep` hits, none of which changed behavior) — now caps tier below HIGH when the disagreement
is meaningful (visual-only-best reaches at least the 'moderate' band), and is explicitly excluded
for a 'weak'/catastrophic disagreement so it can never punish otherwise-trustworthy text (the
opposite-direction requirement the audit's own prompt insisted on holding simultaneously).

**F-27:** non-finite similarity (NaN/Infinity/-Infinity) now fails closed to zero evidence in both
`visualEvidenceTier` and `visualEvidencePoints`, rather than propagating a corrupted number into
diagnostics.

**F-12 (scoring-layer half):** collector-number/name text evidence is now scaled by a new
OCR-confidence reliability multiplier (`ocrTextReliability`) and, for the collector-number field,
by `collector-parse.ts`'s structural confidence (`structuralReliability` — LOW-confidence shapes
only, e.g. a stray single letter + digit or a bare 4+-digit run; the ordinary MEDIUM real-catalog
shape, a bare 1-3-digit vintage id, is NOT discounted). Both are backward-compatible: an omitted
confidence (every pre-P88 caller/test) resolves to full reliability. The ROI-selection-layer half
of F-12 (OCR confidence never gated `isNumberRoiConfident`'s early-exit) is a separate, paired fix
in `analyze.ts` — see `output_88.txt`.

**Cherry-picked from P85** (reviewed, not blindly trusted — diffs read in full before applying):
`name-lexicon.ts`, `collector-parse.ts`, the bounded multi-line collector-number OCR recovery pass,
and the OCR forensics/benchmark tooling (commits `3c86999`/`56338ca`/`56e2757`/`f2ff180`). This
session's own structural-confidence-based reliability weighting builds directly on
`collector-parse.ts`'s bands.

**Not changed:** the committed 19,501-card DINO index; the visual embedding pipeline (P84's own
scope); scanner batch/UI save-state (P89's own scope); any migration (still 90); any financial
semantic. No card was special-cased anywhere.

**Not done, disclosed rather than silently skipped:** a scale-appropriate benchmark against the
real 19,501-card hosted catalog (F-03) — blocked on hosted Supabase credentials, the same standing
gap every M15 session since P75 has disclosed; production wiring of the name-lexicon (no real
production-scale lexicon exists without those same credentials — the exact generator command is
recorded in `output_88.txt` for whichever future session has them); real-device performance
measurement.

---

## D-104 — Scanner UI state-machine concurrency, idempotency-reuse UX, and OCR-engine/worker test hardening (P89)

**2026-09-02 · Accepted**

**Context.** P86's independent adversarial audit found a cluster of real concurrency and UX gaps
in the scanner's UI layer, all independent of the two P0 findings (F-01/F-02) P87/P88 owned:
cancelling an in-flight analysis did not stop it from later clobbering a different, already-retaken
capture (F-05); `openEnvironmentCamera`'s "stops any previous session" guarantee was false under
concurrent invocation (F-06); the shutter and "Add cards" buttons had no synchronous in-flight lock
(F-07/F-10); "Done" after a partial batch commit silently discarded not-yet-saved survivor items
with no warning, unlike every other exit path in the same feature (F-09); a scanner
idempotency-key-reuse rejection was mislabeled as a generic "failed, edit or remove" error, inviting
a genuine duplicate (F-19); `ScannerOcrEngine`'s worker lifecycle/race-safety had zero dedicated
tests and an unverified disposal-during-recognition claim (F-13/F-14/F-15); the visual-embedding
crop fix (P77) and the visual worker's `init()` (where 3 of 4 confirmed real-device root causes
lived) had no regression test that could actually catch a reintroduction (F-30/F-31); and the
stale-deployment auto-reload (D-100) only ever consulted the scanner's own batch for "unsaved
work," silently discarding in-progress purchase/sale form input on every other route (F-40), while
the already-built `checkForNewDeployment()` polling path was never wired to any actual checkpoint
(F-41).

**Decision.** Fixed on its own branch/draft PR (`fix/m15-p89-ui-concurrency-release-hardening`,
PR #68), touching only scanner UI/controller/state, the OCR engine, two small new platform modules,
and the purchase/sale form pages — never `engine.ts`/`visual-evidence.ts` (P88's scope) or the
visual-index cache path (P87's scope):

1. **Cancellation is generation-ref guarded, matching the existing camera-open pattern.**
   `ScannerPage.tsx` bumps `analysisGenerationRef` on cancel/retake/route-exit/unmount/controller
   replacement; `analyzeCapture`'s `.then()`/`.catch()` no-ops when stale. A best-effort
   `AbortSignal` additionally short-circuits `analyzeCapture` between pipeline stages (after
   rectification, after the OCR/visual race, after candidate retrieval) so a cancelled analysis
   skips remaining work — but this cannot interrupt an already-in-flight OCR/visual call; the
   generation-ref no-op is what actually guarantees a stale result never reaches the UI, matching
   the audit's own accepted minimum bar ("if full cancellation is not practical: stale results MUST
   at minimum no-op").
2. **Camera-open serialization moved into the primitive itself.** `camera-session.ts`'s
   `openEnvironmentCamera` now serializes concurrent opens via its own generation counter, rather
   than relying on caller discipline alone.
3. **Synchronous locks for shutter and commit.** `capturingRef`/`committingRef`, set before any
   `await`, gate `handleShutter`/`handleCommit` against a double-tap/multi-touch race a rendered
   `disabled` attribute alone cannot close (React commits asynchronously).
4. **"Done" after a partial commit routes through the same nonempty-batch guard every other exit
   path already has** — the shared discard-confirmation sheet renders distinct copy for the
   post-commit case ("Review remaining" / "Discard remaining and exit") so it can never read as an
   ordinary acknowledgement that quietly means "discard."
5. **Idempotency-key-reuse gets an honest, specific message.** `classifyAcquisitionFailure` gained
   the same string-matching branch the sibling Openings feature already had, naming the possibility
   of a pre-existing entry rather than inviting an edit-and-resubmit that creates a real duplicate.
   A `needsVerification` batch item's quantity/condition edits are frozen (reducer no-ops the
   mutation) until removed, with an explicit confirmation naming that removal only clears the local
   session record.
6. **App-wide unsaved-work registry** (`src/platform/unsaved-work-registry.ts`) replaces the
   scanner-only flag `build-freshness.ts`/`StaleDeploymentBanner.tsx` consulted — the scanner batch,
   Add/Edit Purchase, Add/Edit Sale (dirty-by-diff snapshots) and the Portfolio bulk-action
   selection all register into one shared union, so a stale-deployment reload now prompts instead of
   silently discarding typed-but-unsaved input on any of those routes. `checkForNewDeployment()` is
   now actually invoked from two real checkpoints (`visibilitychange`-to-visible and every completed
   router navigation), both bounded by its existing ≤1/60s rate limit — no new polling loop.
7. **OCR engine gets dedicated tests and two real concurrency fixes found while writing them:**
   `dispose()` now rejects every in-flight AND already-queued `recognize()` call's own disposal
   signal (a queued-but-not-yet-running call had no signal registered before), and `recognize()`
   itself serializes `setParameters`+`recognize` as one logical operation per instance. `CanvasPool`
   (`analyze.ts`) gained the identical mutex shape, wrapping the ENTIRE per-capture OCR pipeline
   (not just one `recognize()` call) — the shared `working` canvas draw happens before any `await`
   the old code protected.
8. **A real, built-worker browser smoke test** (`tests/e2e/visual-worker-real-browser.spec.ts`)
   drives the actual `dist/assets/visual-worker-*.js` chunk through init + one embed-and-search
   call. This is what actually FOUND that Playwright's Windows-hosted WebKit build (26.5) reports
   `OffscreenCanvas` as undefined inside the worker — real Safari has shipped it in Worker scopes
   since 16.4 (March 2023), so this is most likely a testing-environment gap, not a genuine
   real-device regression, but was never confirmed against a real Mac/iPhone this session. Fixed
   regardless of root cause with a structured, attributable error instead of a raw
   `ReferenceError` (superseded by D-105's real fallback, below).

**Disclosed gap, not fixed:** F-20/F-21 (a race-path idempotency SQL check, and grader/grade
material-mismatch DB coverage) — Docker Desktop was unavailable this session, so no migration was
written and no DB test was run; both remain real, if low-probability, open items for a session with
a working local Postgres stack.

**Not changed:** matcher/visual scoring (P88's scope); the visual-index cache path (P87's scope).

---

## D-105 — M15 mega-integration: P87 + P88 + P89 combined, worker fallback, expected-card debug UI, hosted build-safety hardening (P90)

**2026-09-02/03 · Accepted**

**Context.** P87 (D-101, content-addressed visual-index publishing), P88 (D-102/D-103, OCR
forensics + matcher redesign) and P89 (D-104, UI concurrency + release hardening) were built in
parallel, isolated worktrees against the identical base commit
(`7d037e6db30296157a1d746a8844738767591d07`), each as its own draft PR against
`feat/m15-scanner-integrated-p68` (PR #63). This session combined all three onto one integration
branch (`feat/m15-p90-mega-integrated`) via real `git merge` (preserving each branch's own commit
history, not squash/cherry-pick), resolved the resulting conflicts by hand, then closed the
concrete gaps the combined branches still left open.

**Merge conflicts and how they were resolved** (semantic reconstruction, never `--ours`/`--theirs`):

1. **`docs/DECISIONS.md`/`docs/SCANNER_RESEARCH.md`** — P87 and P88 each independently used
   `D-101`/section `7f` for unrelated content (P87: index publishing; P88, carrying P85's own work:
   OCR forensics). Renumbered collision-free: D-101 (P87, index publishing) unchanged, P85's OCR
   forensics section/decision moved to §7g/D-102, P88's own matcher redesign moved from D-102 to
   D-103, with every internal cross-reference updated to match.
2. **`package.json`** — kept every real script both sides added (P88's OCR-benchmark/name-lexicon/
   ROI-fixture-smoke scripts), dropped only the one entry P89 correctly identified as dead
   (`scanner:hash-index:build`, F-32 — pointed at a directory that was never created this
   milestone).
3. **`src/features/scanner/analyze.ts`** — the highest-risk conflict: P88's full OCR pipeline
   (multi-line collector-number recovery, per-field confidence threading, the `OcrDebugTrial` trial
   log) needed to end up wrapped in P89's `pool.withLock` mutex (F-15, serializing the whole
   per-capture pipeline against concurrent callers) without losing either side's behavior. Resolved
   by reconstructing the merged function from both branches' actual git history (not just the
   conflict-marker diff, which interleaved partial statements confusingly) and verifying byte-exact
   equivalence to P88's own logic via the full existing OCR test suite, unchanged.
4. **`src/main.tsx`** — P87's `cleanupObsoleteScannerCaches()` call and P89's `router.subscribe`
   deployment-freshness checkpoint are independent, unrelated fire-and-forget calls; both kept.

**Section 9 — a real OffscreenCanvas fallback, not just a structured error.** P89's F-31 finding
(above) left the worker unable to convert a captured frame to RGBA on any engine lacking
`OffscreenCanvas` inside a Worker scope. Investigated whether a main-thread conversion could
restore full functionality rather than degrading to OCR-only, against four criteria (must preserve
privacy, never upload the image, never explode memory, never duplicate the encode/decode): the
worker now reports `offscreenCanvasAvailableInWorker` in its 'ready' message; when false,
`VisualRecognitionClient.analyze()` converts the bitmap to RGBA on the main thread itself (which
always has a real canvas, `OffscreenCanvas` or `<canvas>`, regardless of Worker support) and
transfers the raw buffer instead of the `ImageBitmap` — exactly one canvas draw happens either way,
never a duplicate. `tests/e2e/visual-worker-real-browser.spec.ts` now exercises this fallback
directly against the real built worker chunk whenever it detects the gap, proving a REAL successful
embed+search result instead of merely tolerating the old structured error.

**Section 10/12/21 — the expected-card debug UI P87 shipped plumbing for but never built.** Under
`?scannerDebug=1`, "Check expected card rank" searches the catalog (reusing the same
`searchCards`/`CardImage` pattern `PullPickerSheet.tsx` already established), and picking a card
calls `getExpectedCardRank` without touching the batch or scanner candidate choice — memory-only,
no persistence, no image involved. Extended beyond P87's visual-only rank with a real HYBRID rank:
a new `rankScannerCandidatesFull` (engine.ts) reuses the exact scoring/visual-dominance-guard
pipeline `matchScannerObservation` runs in production, minus the top-N truncation, so a named card
gets a genuine rank position even outside the visible shortlist; `controller.ts` keeps the most
recent scan's actual OCR/visual evidence (`lastMatchContext`) purely so this debug tool can score
against it, never fed back into matching. A card never retrieved by the scan itself is fetched by
id and scored as an honest what-if. The debug panel also gained a compact "at a glance" summary
line (build SHA, index content id, visual/OCR state, top1, expected rank) above the existing raw
diagnostics text, now behind a collapsible `<details>`.

**Section 14/15 — the platform build verifier and the hosted missing-index policy are now
mode-aware.** P87 disclosed `verify-scanner-platform-build.mjs` failing its own connect-src shape
check (23/24) under the local/CI placeholder Supabase origin (`http://127.0.0.1:54321`), treating a
structural impossibility (a local Supabase stack cannot present an `https://*.supabase.co` origin)
as a security failure. The verifier now detects LOCAL/CI PLACEHOLDER vs HOSTED mode from the
connect-src origin itself, reports which one it verified, and only relaxes the origin-shape
requirement in local mode — a real hosted build still enforces the full `https://*.supabase.co`
shape with no exception. Manually confirmed both branches: 24/24 in local mode, unchanged strict
behavior in hosted mode. Separately, `stage-index-assets.mjs`'s missing-index handling was a
blanket warn-and-skip regardless of build target — correct for local development (an OCR-only
fallback is honest and expected) but wrong for a build Cloudflare Pages will actually deploy. It now
hard-fails (`process.exit(1)`) when `CF_PAGES_COMMIT_SHA` is set (the same signal
`vite.config.ts`'s own `resolveBuildSha` already uses to recognize a real Pages build) and the index
is missing, while local/CI builds keep the original warn-and-skip. Verified directly by simulating
both branches against the real committed index (temporarily renamed and restored).

**Section 16 — a plain-language fallback note, not silence.** A confirmed terminal visual-channel
failure already degraded matching to OCR-only silently (visual-worker.ts never crashes) with zero
user-facing signal either way. Added one calm line to the scanner intro screen
("Visual recognition unavailable on this device — text recognition is still available"), shown only
on a genuine terminal `failed` state (never while still loading, never speculative), carrying none
of the debug panel's own integrity vocabulary (content ids, checksums, source-project refs).

**Sections 17/18/19/20/22/24 — verified already coherent by construction, no code change
required** (each investigated directly against the merged tree, not assumed):

- **Index update during an open session (§17).** A `VisualRecognitionClient`/Worker is constructed
  once per `ScannerPage` mount (`useMemo` keyed on `userId`) and loads exactly one index generation
  for its whole lifetime — so a scan mid-session never mixes generation A and B embeddings by
  construction. A newly published generation becomes visible only on the NEXT worker construction
  (route re-entry, or the existing stale-deployment reload), which always re-fetches `current.json`
  fresh (`cache: 'no-store'`, both HTTP- and Cache-Storage-layer). This is exactly the prompt's own
  preferred policy, achieved by the existing per-mount lifecycle with no dedicated
  freshness-triggered worker-disposal code needed.
- **Unsaved-work registry vs. index freshness (§18).** These are two independent, non-competing
  mechanisms: the app-wide stale-deployment reload (D-104's unsaved-work registry) governs WHOLE-APP
  reloads; the index pointer refetch (D-101) is a silent, lower-level worker-internal concern that
  never prompts or reloads anything on its own. There is exactly one reload-trigger path, not two
  racing ones.
- **Abort vs. visual-worker state, and the OCR mutex vs. cancellation (§19/§20).** P89's own
  disclosed scope decision (best-effort `AbortSignal` plus the generation-ref no-op guarantee, D-104
  above) is unchanged by this integration — P87/P88 never touched `ScannerPage.tsx`/`camera-
  session.ts`/`ocr-engine.ts` at all (confirmed: these files merged with zero conflicts), and this
  session's own `analyze.ts` merge preserves P89's `pool.withLock` wrapping the whole OCR pipeline
  exactly as designed, verified by the full existing concurrency test suite passing unchanged.
- **F-02 post-integration sanity (§22).** `tests/domain/scanner/engine-visual-dominance.test.ts`
  (P88's own adversarial suite pinning the exact pre/post-fix formula) and the full
  `tests/domain/scanner/engine.test.ts` suite both pass unchanged post-merge — this session touched
  `engine.ts` only to add `rankScannerCandidatesFull`, a pure additive wrapper reusing the exact same
  private `scoreCandidate`/`applyVisualDominanceGuard` the production path already uses.
- **Test-fixture consistency (§24).** P87's cache-coherence E2E and P89's real-worker E2E already
  independently reference the identical content-addressed `/scanner-assets/visual-v1/index/...`
  layout (one via mocked fixtures, one via the real committed data) — no flat/legacy layout
  assumption survives anywhere in either suite.

**Schema version.** `SCANNER_SCHEMA_VERSION` bumped 1 → 2 (`src/platform/build-info.ts`) — the
diagnostics shape has grown materially since v1 across P87 (content-addressed index fields),
P88 (OCR confidence/trial fields, hybrid score components), P89 (unchanged diagnostics shape) and
this session (the expected-card hybrid-rank fields) without ever being bumped; a copy-diagnostics
paste from a stale cached build is now distinguishable from the current shape by this field alone,
same discipline `APP_BUILD_SHA` already established for build identity (D-100).

**Verified this session (real, run, not assumed):** `pnpm typecheck`/`pnpm lint`/`pnpm format:check`
clean; full unit suite green (1052+ tests, up from the pre-merge branches' own totals); a full
production build succeeds and `verify-scanner-platform-build.mjs` passes 24/24 in local mode;
`stage-index-assets.mjs`'s hosted/local missing-index branches both manually exercised against the
real committed index. Full E2E/DB gates deliberately deferred to the next session per this prompt's
own instruction (overnight priority: integration, not ceremony).

**Not changed:** any financial semantic; any migration (still 90); the committed 19,501-card DINO
index's actual content. No card was special-cased anywhere.

**P94 correction (2026-09-03):** Section 9's claim above — that the main-thread RGBA-conversion
fallback restores "a REAL successful embed+search result" on an engine lacking `OffscreenCanvas`
inside a Worker — is only PARTIALLY true and was never actually run to completion before this
session; `tests/e2e/visual-worker-real-browser.spec.ts` deferred the E2E gates and the fallback's
own real-search assertion was never exercised. Running it for real (P94 §24) against Playwright's
WebKit build (which reports `OffscreenCanvas` undefined in Worker scope) showed the fallback
converts the captured frame correctly — `visual-worker.ts` itself never constructs an
`OffscreenCanvas` on this path — but `@huggingface/transformers`' OWN internal image-preprocessing
step (resizing the input to the model's expected dimensions) unconditionally constructs its own
`OffscreenCanvas`, with no fallback of its own, regardless of whether the caller supplied an
`ImageBitmap` or raw RGBA bytes. The result on such an engine is still a well-formed, attributable
failure (`Error: OffscreenCanvas not supported by this environment.`, thrown from inside the
library's own minified code — confirmed by inspecting the built `visual-worker-*.js` chunk
directly) rather than a working search. This is a real, currently open limitation: OCR-only
matching remains fully available on such a device (D-105 §16's plain-language fallback note still
applies), but visual recognition genuinely does not work there, and no session has fixed this yet —
it would need patching or replacing `@huggingface/transformers`' own `RawImage` resize step, which
is a materially larger change than this correction. Never confirmed against a real Mac/iPhone
either way. The test now asserts this exact disclosed failure shape when
`offscreenCanvasAvailableInWorker` is false, rather than a full search success it cannot actually
prove on this engine.

## D-106 — M15 matcher correctness rewrite: continuous scoring, reliability-weighted evidence, severe-blur abstention (P93)

**2026-09-03 · Accepted**

**Context.** A cross-branch adversarial audit (P92, `ai_outputs/Claude_outputs/output_92.txt`)
re-derived D-103's F-02 fix by hand against the actual shipped code and found it structurally
incomplete, not merely under-tuned: (1) the guard's escape hatch required a total-coverage text
signal (`id + name + set + language`) production can never produce — `rawSetText` is hardcoded
`null` at every call site, so the maximum reachable text score (80, with the language credit D-106
itself now removes — see below) never reaches the escape hatch's 90-point threshold; (2) the
guard's 0.82 activation threshold sat ABOVE P84's own measured MEAN genuine-match similarity
(0.812, D-101 §2), so an entirely ordinary correct scan could land on the wrong side of the guard
by sampling noise alone, reproducing F-02's exact failure mode at the threshold's own typical
operating point; (3) the same absolute-threshold design meant a defect-driven false visual spike on
a WRONG card could actively discount the TRUE card's text evidence with no escape route — strictly
worse than having no guard at all. P92 also flagged N-04 (a 17-point scoring discontinuity exactly
at 0.82), N-05 (the display-score clamp colliding with margin/tie logic, risking a UUID-decided
rank #1), and N-09 (language-match agreement scoring points despite being guaranteed, not
evidence, given the retrieval layer's own English-only filter).

**Decision.** Redesigned the mechanism rather than re-tuning the constant, per three structural
changes:

1. **Continuous visual-evidence curve** (`src/domain/scanner/visual-evidence.ts`) — the old
   three-band piecewise curve (weak/moderate/strong, meeting at hard threshold boundaries) is
   replaced by a single continuous logistic curve, `points(s) = ceilingPoints / (1 + e^{-k(s-m)})`,
   solved algebraically from two P84-calibrated anchors (`points(moderateMin=0.68) ≈ 25`,
   `points(strongMin=0.82) ≈ 60`), giving `k ≈ 11.53`, `m ≈ 0.7655`. No jump anywhere; every ±0.01
   similarity step changes points by only a few. `strongMin`/`moderateMin`/`weakMin` remain as
   CLASSIFICATION boundaries (tier labels, reason codes) but no longer gate the point curve itself.
2. **Visual-anchor reliability replaces the absolute dominance guard**
   (`computeVisualAnchorReliability`/`applyVisualAnchorReliability`, `engine.ts`) — P88's
   discount-the-competition guard is gone entirely. The new mechanism only ever ADDS a
   corroboration boost to the single candidate the visual channel most confidently supports (the
   "anchor" — highest finite similarity this scan), scaled by two continuous, non-negative signals:
   how far into calibrated same-card territory the anchor's own similarity sits (reusing
   `visualEvidencePoints`'s own curve, `strengthFactor = points/ceilingPoints` — no second
   calibration to drift out of sync), and how much clearer the anchor is than the runner-up visual
   candidate (`marginFactor`, saturating at 0.12 similarity units — P84's own geometry-regime mean
   true-vs-nearest-wrong margin). A single visual candidate with nothing to compare against gets a
   fixed neutral margin factor (0.7) rather than 0 (unprovably discriminative ≠ disproven) or 1 (an
   unverified lone reading should not get full credit). Because no candidate's score is ever
   REDUCED by this mechanism, it structurally cannot reproduce failure mode #3 above — the worst
   case is simply "no boost," identical to the mechanism not existing. Under P84's catastrophic-
   defect calibration (same-card mean 0.10-0.13, nearest-wrong mean 0.28-0.41 — wrong-card
   similarity systematically HIGHER), `strengthFactor` for whichever candidate tops that regime is
   already near zero, so the guard-equivalent mechanism stays structurally inert there without a
   second, separate abstention check.
3. **Rank score vs. display score** (`RankedScannerCandidate.rawRankScore`, N-05) —
   ordering/margin/tier logic now reads a full-resolution, UNCLAMPED raw score exclusively; the
   existing `score` field is a clamped-to-[0,100] DISPLAY value derived from it only at the very
   end, never fed back into any decision. `cardId` is reduced to the final exact-identity-stability
   tie-break, reached only when raw score AND own visual similarity are BOTH exactly equal — never
   a meaningful signal. (P93 deliberately did NOT add "original retrieval-array position" as an
   intermediate tie-break step, despite reading naturally as one: this module has always guaranteed
   permutation-invariance of its input array, pinned by an existing property test, and plain array
   position is not the same thing as a genuine retrieval rank a future data-layer field could
   provide — see engine.ts's own doc for the full reasoning.)

**N-09 — language-match no longer scores.** Audited via a full call-flow trace, not assumed:
`controller.ts` derives `languageHint` from `scannerSessionStore`, whose `language` field's TYPE is
the literal `'en'` (V1 is English-only by design, not convention), and BOTH
`retrieveScannerCandidates` and the visual-shortlist enrichment path (`getCardsByIds`) pass that
same `'en'` as an explicit server-side filter — every candidate that can reach the scorer in
production already has `card.language === 'en'`. Agreement is guaranteed, not evidence, and was
inflating every candidate's score UNIFORMLY (never changing relative ranking, but capable of
pushing an absolute score across a tier boundary on a fabricated +5 that discriminated nothing). The
`languageMatch` weight is removed from `SCORING_WEIGHTS`; the mismatch penalty (−12) is KEPT — a
genuine disagreement remains real, if currently unreachable, evidence against a candidate. The
'language-match' reason code is still pushed for diagnostic legibility even though it now moves
zero points. **Real consequence, disclosed rather than silently absorbed:** pure two-signal
(id-exact + name-exact) text convergence now tops out at 75 — below `highMinScore` (80) — where it
previously could reach exactly 80 (HIGH) via the now-removed +5. Genuine HIGH confidence from text
alone now requires the full id+name+set composition (rare in production, since `rawSetText` is
never populated) or the visual channel's own corroboration boost — a deliberate tightening, not a
regression: it closes the same "2.5-signal coincidence masquerading as 3-signal certainty" gap F-02
itself was about, just for the language credit specifically.

**N-19 — OCR-noise slack for the body-text-contamination penalty.** The old 26-character ceiling
(`analyze.ts`'s `looksLikeBodyTextNotName`) equalled the longest known real card name with ZERO
slack for OCR noise — a single stray inserted character on that exact name ate the full 60-point
penalty. Length alone no longer disqualifies a candidate until a real, no-slack-needed hard ceiling
(30); between the old and new ceilings, only the independent sentence-boundary and word-count checks
can flag a candidate, and real multi-sentence rules prose reliably trips one of those regardless of
its exact length, so no real rejection power is lost.

**Severe-blur visual abstention (D-103's own capture-quality.ts, ported and WIRED).** P91 built and
tested `src/domain/scanner/capture-quality.ts` (Laplacian-variance blur gate,
`BLUR_ABSTAIN_THRESHOLD=378`) but deliberately shipped it unwired. P93 ports it unchanged and wires
it below `ScannerPage` at the controller/`rectify-capture.ts` boundary (never touching
`ScannerPage.tsx` itself, in scope-safety coordination with the parallel P94 session): the blur
score is computed on the canonical rectified `RgbaImage` `rectify-capture.ts` already produces
before encoding it to a blob (no extra decode), and when it falls below the threshold, ONLY the
visual channel is skipped for that scan — OCR text recognition and manual search proceed
unaffected. New diagnostics: `CAPTURE_BLUR_SCORE`, `CAPTURE_SEVERE_BLUR`, `VISUAL_ABSTAINED`,
`VISUAL_ABSTAIN_REASON`. The threshold itself is NOT re-derived this session (see the continuous-
severity benchmark below) — kept at P91's own calibrated value.

**Real benchmark evidence (all actually run this session, not estimated):**

- **240-card/6-set benchmark** (`pnpm scanner:visual:benchmark`, same methodology D-097/D-102
  established): `NEW_HYBRID_TOP1=99.7%` (TOP3/TOP5 100%/100%, n=1440) — matches `VISUAL_ONLY_TOP1`
  exactly (99.7%), closing the hybrid-vs-visual-alone gap the audit tracked from -3.9pts
  (pre-D-103) to -0.3pts (D-103) to ~0pts here.
- **Real corpus-scale adversarial benchmark** (new, `scripts/scanner-recognition-lab/experiments/
  08-p93-hybrid-false-confidence.ts`, reusing P91's cached ~4,300-card corpus/reference index): the
  F-02 adversarial construction (a different corpus card given the true card's own coincidental
  id+name text match; the true card carries zero text evidence) run through the REAL production
  matcher, n=300 cards × 3 conditions = 900 trials. Clean: 100% correct, 0% false-HIGH. Geometry-
  only (`tilted-offcenter`, mean true similarity 0.7999 — essentially P84's own calibrated 0.812):
  60.7% correct outright, only 1.33% false-HIGH — the true card frequently still wins this
  worst-case-constructed adversarial matchup at the exact operating point the audit flagged as
  broken, and even when it loses, it almost never does so at HIGH confidence. Catastrophic
  (`tilted-glare-shadow-blur`, mean true similarity 0.1195): 0% correct (expected — the true card
  has genuinely no evidence of its own in this construction) but ALSO 0% false-HIGH — the matcher
  loses honestly (MEDIUM/LOW/NONE) rather than confidently wrong, in every one of 300 trials.
- **Continuous blur-severity sweep** (new, `.../09-p93-continuous-blur-severity.ts`, n=80,
  isolated Gaussian-blur-sigma dimension only — P91 already found its glare/shadow metrics have
  ~zero discriminative power and neither is wired into production): real TOP1 retrieval accuracy on
  pure blur alone stays high (96.3%+) at blur scores already below `BLUR_ABSTAIN_THRESHOLD`,
  cratering steeply between sigma 8-10 (71.3% → 36.3%). The shipped threshold sits conservatively
  on the safe side of that cliff — appropriate, since real captures rarely blur in total isolation
  (P91's own calibration bundles blur with the co-occurring tilt/glare/shadow a phone photo
  realistically has) — and is NOT changed based on this isolated-dimension evidence, per this
  session's own instruction not to broaden the gate without evidence.

**Explicitly not done, disclosed rather than silently skipped:** the real 19,501-card hosted-catalog
confusable-group benchmark (F-03) remains open, unchanged since every M15 session since P75 — this
session's adversarial/blur-severity benchmarks reuse P91's ~4,300-card public-corpus approximation,
not the real catalog. The dual-prototype reference-index recommendation (P91) was not implemented
(would require re-embedding the real 19,501-card index, an irreversible multi-hour operation not
undertaken without a dedicated follow-up decision). No new DINO model was evaluated (D-098 stands
unchanged — P91 already found no evidenced reason to switch).

**Verified this session:** `pnpm typecheck`/`pnpm lint`/`pnpm format:check` clean; full unit suite
green; the 240-card visual benchmark and both new real-corpus experiments above actually run, not
estimated. Full E2E/DB/build gates run as part of this session's own closing verification (see
`ai_outputs/Claude_outputs/output_93.txt`).

**Not changed:** any financial semantic; any migration; the committed 19,501-card DINO index's
actual content or the DINOv2-small model itself. No card was special-cased anywhere.

**P99 addendum — the anchor-reliability boost is QUADRATIC in the anchor's own similarity, not a
fixed or externally-calibrated increment (P98 finding, honestly disclosed here as this decision's
own follow-up instructed).** `applyVisualAnchorReliability`'s boost is
`round(visualPoints * ANCHOR_BOOST_MAX * reliability)`, and `reliability`'s own `strengthFactor`
term is `visualPoints / VISUAL_EVIDENCE_CURVE.ceilingPoints` — substituting back in gives
`boost ≈ 0.008696 × visualPoints² × marginFactor`: the anchor's own visual reading is used TWICE,
once linearly as `visualPoints`, once again to scale its own boost. Concretely, a well-separated
single-evidenced candidate (`marginFactor` saturated to 1) with ZERO text evidence reaches the
`highMinScore` threshold at similarity ≈0.817 — an entirely ORDINARY similarity, barely above P84's
own 0.812 mean genuine-match value, not a rare tail event. This is monotonic, never negative, and
never touches any candidate other than the anchor (the safety property this decision's own §5/§12
already claimed and which still holds) — what was previously undisclosed is the MAGNITUDE: the
addition grows quadratically in the anchor's own points, not linearly. The one manifestation where
this could matter (a wrong visual anchor outranking a DIFFERENT card's genuine text evidence) is
independently caught by the pre-existing `visual-text-disagreement` cap (unchanged by this
decision, inherited from P88/F-26; M93-14 pins it). A single-evidenced-candidate shape — where
text-best and visual-best trivially coincide because neither candidate has any text score, so the
disagreement cap structurally cannot engage — is NOT independently dangerous either, since a HIGH
tier there still requires the anchor to genuinely be the scanned card for the result to be correct;
it is disclosed here because the magnitude itself was previously untested, not because a concrete
false-positive path was found. Boundary pinned permanently: `tests/domain/scanner/
engine-p93-redesign.test.ts`'s M93-17 (P99), a single well-separated zero-text anchor at similarity
0.817 asserted to reach HIGH — a future re-tune of `ANCHOR_BOOST_MAX` or the visual-evidence curve
that silently reopens this now has a test to fail. `SCORING_TIERS` itself was separately
revalidated against this widened raw-score range (0-2198 real adversarial trials across four
scenario categories via `scripts/scanner-recognition-lab/experiments/10-p99-scoring-tiers-sweep.ts`,
`pnpm scanner:recognition-lab:p99-scoring-tiers-sweep`): the shipped constants produced ZERO false
HIGH results across every trial and category, and no combination in a real parameter-grid sweep
strictly dominates them (fewer false-HIGH with no worse false-medium-or-above and no worse
true-card HIGH recall) — kept unchanged, with evidence, not by coincidence.

## D-107 — Canvas-free DINOv2 preprocessing closes the real WebKit/OffscreenCanvas gap (P96)

**2026-09-03 · Accepted**

**Context.** P90's main-thread RGBA-conversion fallback (D-105) solved only half of the real
OffscreenCanvas dependency: it stopped THIS worker from constructing an `OffscreenCanvas` itself
when converting a captured `ImageBitmap` to RGBA, but `@huggingface/transformers` 4.2.0's own
`AutoProcessor`-produced `BitImageProcessor` calls `RawImage.resize`/`.center_crop` internally
during `processor(image)`, and those unconditionally construct their OWN `OffscreenCanvas`
regardless of whether the caller already supplied raw RGBA bytes — confirmed by reading the
installed bundle directly (`node_modules/@huggingface/transformers/dist/transformers.js`'s
`src/utils/image.js` section: `createCanvasFunction`/`toCanvas`, gated only on
`apis.IS_WEB_ENV`, no non-canvas branch exists). P94 found this for real (§24, D-105's own
addendum): running the real WebKit E2E spec against Playwright's WebKit build (which genuinely
reports `OffscreenCanvas === undefined` in Worker scope) produced a well-formed but real failure —
`Error: OffscreenCanvas not supported by this environment.` — thrown from inside the library's own
minified preprocessing code, not from any of this project's own worker logic.

**Decision.** Rather than patching or forking `@huggingface/transformers` to remove one internal
`OffscreenCanvas` call, this session reimplemented the exact preprocessing numerically —
`src/domain/scanner/dino-preprocess.ts`'s `preprocessRgbaForDino`: RGBA → drop alpha → bilinear
resize (shortest edge to 256, matching `preprocessor_config.json`'s `size.shortest_edge`) → center
crop 224×224 → rescale (`1/255`) → normalize (ImageNet mean/std, both copied verbatim from the
committed `public/scanner-assets/visual-v1/model/preprocessor_config.json`, never remembered
defaults) → permute HWC→CHW. Pure typed-array arithmetic — no canvas, no DOM, no
`OffscreenCanvas` anywhere in the file, so it runs identically on every JS engine.
`visual-worker.ts`'s new `runModelOnRgba` branches on `OFFSCREEN_CANVAS_AVAILABLE_IN_WORKER`: when
true, the existing AutoProcessor path is completely unchanged (zero risk to the already-proven
99.7%-TOP1 Chromium path); when false, `processor(image)` is skipped entirely — never merely
caught — in favor of the canvas-free path, which feeds the model directly via a hand-built
`Tensor('float32', ..., [1,3,224,224])`.

**RESAMPLE NOTE, disclosed rather than glossed over.** The preprocessor config's `resample: 3`
(bicubic) label does NOT describe what the browser-path AutoProcessor has ever actually done in
this project: `RawImage.resize`'s web-environment branch calls `ctx.drawImage(canvas, 0, 0, w, h)`
unconditionally and never consults `resample` at all (that parameter is Node/`sharp`-only). So
there is no existing browser-path pixel algorithm for this reimplementation to bit-match — the
real target is RETRIEVAL-OUTCOME parity, not literal resample-algorithm parity, and this module
uses plain bilinear resampling (half-pixel-center convention) as a simple, easy-to-verify choice.

**Parity evidence (`scripts/scanner-preprocess-parity/`, `pnpm scanner:preprocess:parity`), run for
real over 100 real card images × 6 shape variants (portrait-native, landscape-rotated,
odd-dimensions, near-crop-size ~230px, large-iPhone-scale ~3024×4032, RGBA-semi-transparent) = 600
evaluations, comparing this module's output against the library's own Node/`sharp`-backed
AutoProcessor path (same pinned model, same input pixels, isolating the comparison to the
preprocessing algorithm itself) — both queried against the real committed 19,501-card production
index:**

- `PREPROCESSOR_PARITY_IMAGES=100` (600 total evaluations across 6 shape variants)
- `PREPROCESSOR_MEAN_COSINE=0.9762` (min 0.9202 across all 600 evaluations)
- `PREPROCESSOR_TOP1_AGREEMENT=96.2%` overall — by variant: portrait-native 100%, RGBA-
  semi-transparent 100% (confirms alpha is genuinely ignored, not merely untested),
  odd-dimensions 99%, large-iPhone-scale 98%, near-crop-size 95%, landscape-rotated 85% (the one
  weak spot — rotation changes which pixels land at the resize/crop boundary more than any other
  variant; disclosed as a real, measured residual, not hidden)
- `PREPROCESSOR_TOP5_AGREEMENT` (identical top-5 sets) `=32.3%`; mean top-5 SET OVERLAP `=79.6%`
  (most disagreement is a swapped 4th/5th-place near-tie, not the true match falling out of
  contention — the two paths' shortlists overlap substantially even when not byte-identical)

**Verdict.** 96.2% TOP1 agreement and 0.976 mean cosine similarity are not literal 100% parity, but
the evidence supports the substitution: DINOv2 embeddings are already known (P91/P93/P95) to be
robust to small preprocessing perturbations at this similarity range, and this module is a
fallback path — it activates ONLY on an engine that would otherwise have zero working visual
recognition at all (an outright crash), so a small measured gap from a from-scratch bilinear
resize against the library's own resize is a real improvement over the status quo, not a
regression against any currently-shipping behavior. The landscape-rotated residual is flagged as a
disclosed follow-up: a future session with more time could measure whether area-averaging
downsampling (rather than plain bilinear) narrows that specific gap, but was not judged worth
delaying this fix over given the fallback framing above.

**iPhone memory (§9, not separately benchmarked on real hardware this session — reasoned from the
implementation).** `preprocessRgbaForDino` allocates, at peak: one RGBA→RGB float buffer
(`width×height×3×4` bytes), one resized buffer (`resizedWidth×resizedHeight×3×4` bytes, typically
smaller since the source is downscaled to a ~256px short edge), and the final fixed 224×224×3×4
(~600KB) tensor — each intermediate is a local variable eligible for GC the instant the next stage
starts (no retained references), so this never holds more than roughly two full-resolution-scale
buffers simultaneously, the same order of magnitude the existing OffscreenCanvas path already
holds (a canvas backing store plus its `ImageData` buffer). No raw card image is ever persisted by
either path.

**Not changed:** the default OffscreenCanvas-available path (byte-for-byte the same code, same
proven 99.7% TOP1); the committed 19,501-card visual index; any migration; any financial semantic.
`docs/SCANNER_RESEARCH.md` §11 records the same evidence in narrative form.

## D-108 — ScannerPage's controller is double-constructed by React StrictMode's render-purity check; the wrong instance gets disposed, permanently breaking OCR/visual analysis under `pnpm dev` (P96 disclosed, FIXED P99)

**2026-09-03 · Accepted (finding disclosed; fix deferred)**

**Context.** Building the first-ever real, authenticated, camera-free (file-picker) scanner E2E
test (P96 §15 — closing P94's own disclosed "real nonempty-scanner-batch authenticated E2E" gap)
surfaced a genuine bug no prior session's E2E coverage had ever exercised: every real capture
analysis failed with `ScannerEngineDisposedError` ("The card reader was closed"), thrown by
`ocr-engine.ts`'s own disposal guard, visible in the page as `ReviewView` bouncing back to
"Use photo"/"Retake" with that exact error text instead of reaching a result.

**First hypothesis, tried and DISPROVEN.** The obvious suspect was `ScannerPage.tsx`'s route-exit
cleanup effect (`useEffect(() => () => {..., controller.dispose()}, [controller])`) running under
React StrictMode's well-known EFFECT double-invoke (mount → synchronous synthetic cleanup →
synchronous synthetic remount, all for the same committed render). A fix deferring the dispose to a
cancelable macrotask (`setTimeout(..., 0)`, cancelled by a same-tick StrictMode remount) was built
and shipped — and the bug still reproduced identically. That disproof is what led to the real
diagnosis below; the timer-based fix has been reverted (it added real complexity for zero benefit).

**Actual root cause, confirmed by instance-tagged debug logging** (a monotonic counter plus
`console.error` at construction/dispose/analyzeCapture, read back through Playwright's real
browser console — not inferred from source reading alone):

```
controller #1 CREATED userId=<real-uuid>
controller #2 CREATED userId=<same real-uuid>      <- SAME dependency, constructed AGAIN
controller #1 DISPOSE (already disposed=false)      <- #1, not #2, gets torn down
controller #1 analyzeCapture called, disposed=true  <- #1, not #2, is what the click handler uses
```

React 18/19 StrictMode has a SEPARATE, RENDER-level double-invoke (distinct from the effect one):
for the initial mount, the component function body itself is called twice as part of React's
"detect impure renders" check, and the FIRST call's rendered output is discarded in favor of the
SECOND. But `useMemo(() => getScannerUiController(userId), [userId])`'s factory is not automatically
"pure-checked" or deduplicated by React — it is a real side effect (constructs a `ScannerOcrEngine`
+ `VisualRecognitionClient`), and it genuinely runs on BOTH invocations, producing two independently
alive controller instances for the identical `userId`. Empirically, the FIRST instance — not the
second, and not whichever one a naive "first render is thrown away" mental model would predict — is
the one that ends up wired into the actually-committed render's event handlers (`handleUsePhoto`
closes over it), while the route-exit cleanup effect (keyed on `[controller]`, correctly following
that same first instance through React's hook-identity bookkeeping) disposes it once StrictMode's
effect-level double-invoke runs its synthetic cleanup/remount cycle. The deferred-timer fix could
never have worked: the double CONSTRUCTION happens at the RENDER phase, before any effect (or its
cleanup timing) is even in play — there is no effect-level signal available to distinguish "which of
these two already-constructed instances is the real one."

This was invisible to every prior M15 session because every existing scanner E2E spec drives the
PRODUCTION preview server (`pnpm build && pnpm preview`, where StrictMode's entire double-invoke
machinery — both the render-level and effect-level checks — is compiled out and inert; the real
deployed PWA was NEVER affected). The `desktop-chromium-authenticated` project P94 built is the
only one that drives Vite's DEV server (`pnpm exec vite`, where StrictMode is live), and nothing had
ever navigated it to `/scan` before this session's new test.

**Decision.** Disclose and defer, rather than ship a second unverified fix attempt. The correct fix
requires moving controller construction OUT of `useMemo` and INTO the mount effect itself (stored in
a ref that event handlers read), so React's render-level double-invoke can no longer produce two
independently-alive instances in the first place — `useMemo`'s own factory has no such guarantee
StrictMode respects, but effect bodies genuinely only run once per REAL mount. That restructuring
touches every one of `controller`'s ~9 read sites in `ScannerPage.tsx`, several inside their own
`[controller]`-keyed effects (prewarm, fast-baseline polling, `analyzeCapture`, `commitBatch`), plus
two `useState` lazy initializers that currently read `controller` synchronously at first render
(`getFastScannerState`/`getVisualPrewarmState` — safe to default to `'not-loaded'` unconditionally
instead, since a truly fresh controller cannot report anything else at that exact instant, but still
a change to verify). This is a materially larger, riskier change — in one of this project's most
heavily adversarially-reviewed files — than this session could responsibly design AND re-validate
end to end after two already-spent diagnostic attempts, for a bug with zero production impact.
`tests/e2e/authenticated/account-boundary.spec.ts`'s scanner-batch test (P96 §15) is marked
`test.fixme()` with this decision's own diagnosis inline, ready to un-skip the moment a future
session lands the ref-based restructuring — the test itself is otherwise complete and correct.

**Verified:** the full unit suite (1142/1142) and lint/format/build are all clean after reverting the
ineffective timer fix and removing every debug log added during diagnosis (confirmed by
`tests/ui/scanner-network-audit.test.ts`'s own static privacy audit, which caught the leftover
`console.error` calls immediately — a real, useful catch of exactly the class of regression it
exists to prevent). Production build/bundle size unaffected (ScannerPage chunk unchanged at 105.52
KB raw, byte-identical to pre-investigation).

**Not changed:** anything about the controller's own dispose()/analyzeCapture() contracts; the
production (StrictMode-inert) code path, which was never affected by this bug in the first place;
any other file. The DECISIONS.md entry originally written for the (disproven) timer-based fix has
been fully replaced by this one rather than left alongside it as a second, contradictory record.

**P99 update — FIXED, exactly along the lines this entry's own "Decision" section above
prescribed.** Controller construction moved out of `useMemo` (a render-time side effect with no
StrictMode double-invoke protection) into the mount effect itself, keyed on `userId` alone:

```ts
const controllerRef = useRef<ScannerUiController | null>(null)
useEffect(() => {
  const instance = getScannerUiController(userId)
  controllerRef.current = instance
  return () => {
    /* camera/capture/analysis cleanup, then: */
    if (controllerRef.current === instance) controllerRef.current = null
    instance.dispose()
  }
}, [userId])
```

Effect bodies (unlike render bodies and `useMemo` factories) genuinely run once per REAL mount even
under StrictMode — its synthetic effect-level double-invoke is mount → cleanup → remount, so the
FIRST instance is always disposed by the SAME synthetic cycle that constructs the second, leaving
exactly one live instance by the time any real interaction is possible; an account switch
(`userId` change) disposes the outgoing user's instance before the new one exists, so a new user
can never inherit the previous user's controller.

Deliberately NO mirrored `useState<ScannerUiController | null>` alongside the ref — an early draft
of this fix had one (`setController(instance)` called synchronously inside the effect body) and
`pnpm lint` correctly rejected it: `react-hooks/set-state-in-effect` (a real error in this
project's ESLint config, not a warning) flags exactly that pattern. Removed rather than suppressed:
`controllerRef` gives event handlers (`handleUsePhoto`/`handleSearchSubmit`/`handleCommit`) and the
debug-panel JSX prop a synchronous, always-current reference; the prewarm/polling/variant-choices
effects that used to depend on a `controller` state value are now keyed on `userId` instead and
read `controllerRef.current` directly — correct because React always runs a component's effects in
declaration order on every commit (StrictMode's double-invoke runs the full set, then all cleanups
in reverse, then the full set again), so any effect declared AFTER the construction effect is
guaranteed to see the ref already populated. The two `useState` lazy initializers
(`fastScannerState`/`visualScannerState`) default unconditionally to `'not-loaded'`, exactly as
this entry's own "Decision" section anticipated.

All ~9 read sites updated; full unit suite green (1153/1153: P96's 1142 + 6 D-109 guard tests + 5
D-110 sale-form guard tests); typecheck clean; lint 0 errors / 28 warnings (P96's own reported
baseline, unchanged — two transient `react-hooks/exhaustive-deps` warnings from capturing
`cameraGuardRef`/`captureStoreRef` were resolved by copying them to local consts before the
cleanup closure, not suppressed); format clean; ScannerPage chunk size unaffected.
`tests/e2e/authenticated/account-boundary.spec.ts`'s scanner-batch test's `test.fixme()` is removed
— it now runs for real (see the P99 output record for the pass evidence).

**Verification method:** the authenticated E2E test this same D-108 investigation produced
(`tests/e2e/authenticated/account-boundary.spec.ts`) drives the real dev server (`pnpm exec vite`,
where StrictMode is live — the same server the original diagnosis used) through a real
`analyzeCapture()` call; that test's own pass/fail is the real, execution-level proof this fix
works under StrictMode, not just that the diff reads correctly. See its result recorded in the P99
output file rather than restated here.

---

## D-109 — `ScannerPage`'s exit-requested effect could resurrect a camera the user had just closed (P98, FIXED P99)

**2026-09-04 · Accepted**

**Context.** P98's adversarial audit (§10) traced a real, confirmed gap in P94's own camera
token model (`camera-session.ts`'s `openSeq`/`liveGeneration`, D-096-adjacent — see that module's
own doc comment): the PRIMITIVE itself is sound (P92's original N-10 finding stays fixed, proven
across the full multi-call ordering matrix in `tests/ui/scanner-camera.test.ts`), but ONE caller
site in `ScannerPage.tsx` used it incoherently. Every other place in the file that stops the
camera also invalidates the page's OWN "do I still want a camera" generation counter — the
camera-open effect's teardown, `handleShutter`, `handleFilePicked`, the D-108 controller-lifecycle
effect's cleanup — except the `exitRequested` effect (fired by the "Close scanner" X button),
which called `stopActiveScannerCamera()` but left the counter untouched.

**Concrete failure sequence (P98's own repro, confirmed by code trace).** The camera step mounts
and starts a real `acquire()` call (a real permission-prompt round trip on a device that hasn't
granted camera access yet). The user taps "Close scanner" while that prompt is still pending —
`state.exitRequested` becomes true; `state.step` does not change synchronously, so the camera-open
effect's own `cancelled` flag is not yet set; `navigate()` is async, so real unmount can lag well
behind this point. If the permission prompt is then granted, `acquire()` resolves; the camera-open
effect's `.then()` handler checked only `cancelled || generation !== <the old, un-bumped counter>`
— both false — so the stream attached and `CAMERA_STARTED` dispatched. **The camera the user had
explicitly closed turned back on**, for a window bounded by router-transition latency.

**Fix.** Extracted the page's per-mount "do I still want a camera" counter into its own small,
directly-testable primitive, `CameraAcquisitionGuard`
(`src/features/scanner/camera-acquisition-guard.ts` — distinct from, and layered on top of,
`camera-session.ts`'s own module-level `openSeq`/`liveGeneration`, which answers a different
question: "which overlapping `acquire()` call is authoritative for the shared stream slot," not
"does the PAGE still want a camera at all"). Every call site that used to bump a bare
`cameraGenerationRef.current` now calls the same guard's `begin()` (starting a new cycle, used when
actually (re)opening the camera) or `invalidate()` (ending the current cycle without starting a new
one, used by every close/exit/unmount path, `exitRequested`'s now included) — one consistent
vocabulary instead of an ad hoc counter a future call site could as easily forget to bump again.

**Not** a second, independent boolean/race model layered beside the existing architecture — this is
the SAME generation-counter pattern the file already used everywhere else, now applied
consistently, with the one previously-inconsistent call site brought in line.

**Tests** (`tests/ui/scanner-camera-acquisition-guard.test.ts`, unit-level — no React
component-rendering infrastructure exists in this project; see that file's own header comment):
`CameraAcquisitionGuard`'s `begin()`/`invalidate()`/`isCurrent()` semantics pinned directly, plus
three scenarios reproducing `ScannerPage.tsx`'s own camera-open `.then()`/`.catch()` guard clauses
verbatim against the real `openEnvironmentCamera` primitive: (1) acquire pending → exit requested →
acquire resolves ⇒ stream stopped immediately, camera stays closed; (2) acquire A pending → exit →
explicit reopen B → A resolves late → B resolves ⇒ only B attaches (A's late arrival rejects via
`camera-session.ts`'s own superseded-call guard, and the page's stale-generation check independently
would have discarded it either way); (3) unmount while pending ⇒ no resurrection. All three pass
against the real primitives, not a reimplementation.

**Verified:** unit suite 1148/1148 (up from P96's 1142: +6 for this fix's own tests); typecheck/
lint/format clean; no change to `camera-session.ts` itself (P94's primitive was already correct).

---

## D-110 — `SaleFormPage`'s permanent prefill latch could leak one holding's line items into a different holding's sale form (P98, FIXED P99)

**2026-09-04 · Accepted**

**Context.** P98's audit set out to confirm the StrictMode `setState`-after-real-unmount concern
this prompt cycle originally raised about `SaleFormPage.tsx`'s holdingId(s) prefill effect, and
found that concern is a non-issue in React 18 (`setState` on an unmounted component is a
documented, silent no-op) — but investigating it surfaced a DIFFERENT, real, previously-untested
bug: `prefillStarted` was a `useRef(false)` latch that flipped permanently true on the FIRST
effect run and was never reset, keyed on nothing. `/sales/new` (reached from the central + menu,
Portfolio's select mode, or Holding Detail's "Sell" button — all three via the same `holdingId(s)`
search param, per this file's own header comment) has no `remountDeps` configured — so a
same-component-instance navigation that changed `holdingIds` (e.g. browser back/forward landing on
a different holding's sale-add URL) re-fired the effect, which then silently no-opped FOREVER: the
NEW holding's own prefill never ran, and if the OLD holding's fetch was still in flight, its result
landed later and unconditionally appended into whatever form was now on screen for the NEW holding
— a genuine cross-entity data leak (one card's acquisition line silently injected into a different
card's sale), with no existing test covering it.

**Fix.** Replaced the permanent one-shot latch with `KeyedPrefillGuard`
(`src/features/sales/keyed-prefill-guard.ts`) — the same identity/generation discipline
`ScannerPage.tsx`'s `analyzeCapture` already used, and the same one D-109 (above) just applied to
the camera-open path, extracted here as its own small class rather than re-derived inline so its
semantics are directly unit-testable (no React component-rendering infrastructure exists in this
project). `begin(key)` starts a fetch only for a genuinely NEW key (returning `null`, a no-op, for
the SAME key StrictMode's synthetic double-invoke re-presents); `isCurrent(generation)` gates every
`.then()`/`.catch()`/`.finally()` state update, so a stale result for a superseded key can never
touch `items` or mark completion.

`prefillReady` itself was also redesigned: instead of a boolean flipped true once by the effect
(a synchronous `setState` in the effect body would itself violate `react-hooks/set-state-in-effect`
— see D-108's own note on the identical trap), it is now DERIVED during render from comparing a
`prefillCompletedKey` state value against the current `prefillKey`
(`holdingIds.length === 0 || prefillCompletedKey === prefillKey`). This means a `holdingIds` change
makes `prefillReady` false again immediately, with no effect tick needed — closing a second,
related gap: `useIsDirtyByDiff` (`src/platform/unsaved-work-registry.ts`) captures its dirty-diff
baseline on the FIRST render where `ready` is true and never re-captures it, so if `prefillReady`
had gone true prematurely (before the new holding's own data arrived), the eventual real prefill
would register as unsaved user edits against an empty/wrong baseline — a false "unsaved work"
warning on a form the user never touched. The fix ensures the baseline is captured only once the
CURRENT key's own prefill has genuinely completed.

**Known residual (disclosed, not covered by this fix):** if the OLD holding's prefill had already
completed successfully — populating `items` and capturing the dirty-diff baseline — BEFORE the user
navigated to the NEW holding (as opposed to this fix's covered scenario, where the old fetch is
still in flight at navigation time), `useIsDirtyByDiff`'s baseline stays locked to the old holding's
data; the new holding's own prefill would then register as a dirty diff against that stale
baseline. This is a narrower, lower-severity variant (the user actually saw the old holding's data
render before navigating away, rather than a silent unseen leak) that the P98 audit's own named
test scenarios do not cover and this session did not independently discover — flagged here for a
future session rather than silently left undocumented.

**Tests** (`tests/ui/sale-form-keyed-prefill-guard.test.ts`): `KeyedPrefillGuard`'s
`begin()`/`isCurrent()` semantics pinned directly, plus two scenarios reproducing
`SaleFormPage.tsx`'s own effect body verbatim against real controllable-timing async lookups: (1) A
starts → navigate to B → A resolves late ⇒ A never appears in items, B's own prefill still
completes correctly once it resolves; (2) A starts → navigate to B → A REJECTS late ⇒ no stale
error/completion state leaks into B, B still completes normally afterward with the correct
baseline-capture timing.

**Verified:** unit suite 1153/1153 (+5 for this fix's own tests, on top of D-109's +6); typecheck/
lint (0 errors, 28 warnings — P96's own reported baseline, unchanged)/format clean.
`PurchaseFormPage.tsx` was checked and does NOT have an analogous async holdingId-keyed prefill (its
own `useUnsavedWorkSnapshot` registration — referenced by this file's own F-40 comment — uses the
default `ready=true`, no async prefill involved), so it is not affected and was not changed.

---

## D-111 — P99 follow-ups: landscape-preprocessor parity gap is a synthetic-only state; blur benchmark now routed through the real rectify pipeline

**2026-09-04 · Accepted**

**Landscape parity (P96's 85% weak spot, prompt §11).** Traced the full call chain from a real
scan to the DINO preprocessing stage, code-verified rather than assumed:

1. `controller.ts`'s `analyzeCapture` calls `rectifyCapture(capture, {debug})` — UNCONDITIONALLY,
   before either the OCR or visual channel ever sees the frame (`rectify-capture.ts`'s own header:
   "produces a canonical, card-only image that BOTH the OCR and visual channels then consume").
2. `rectifyCapture` always returns a frame sized EXACTLY `RECTIFY_OUTPUT_WIDTH x
   RECTIFY_OUTPUT_HEIGHT` = 700x980 — a fixed constant, never derived from the source capture's own
   dimensions or orientation. This holds on BOTH branches: real corner detection warps the detected
   quadrilateral to 700x980, and the `usedFallback: true` path (detection failed, or rectification
   errored) still warps the plain nominal rectangle to the SAME fixed 700x980 via the identical
   `warpPerspective` call — "rectification failed" and "no rectification requested" are
   pixel-equivalent through the one code path, never a second special case (rectify.ts's own header
   makes this explicit).
3. `analyzeVisualSafely` (controller.ts) builds its `ImageBitmap` from `rectified.frame`'s blob
   using `cardRect = {left:0, top:0, width:700, height:980}` (the full rectified image — no further
   cropping), and hands that bitmap straight to `VisualRecognitionClient.analyze`.
4. The bitmap's own `width`/`height` (read directly off the `ImageBitmap`, never recomputed) are
   what eventually reach `visual-worker.ts`'s `runModelOnRgba`/`preprocessRgbaForDino` as the `rgba`
   message payload.

Conclusion: **a landscape-shaped (width > height) buffer can never reach
`preprocessRgbaForDino`/`processor(image)` in the real production pipeline** — every real scan,
regardless of camera orientation, device, file-upload EXIF orientation, or corner-detection success/
failure, feeds the DINO preprocessing stage a fixed 700x980 PORTRAIT buffer. P96's own parity
harness (`scripts/scanner-preprocess-parity/run-parity.ts`) tests a `landscape-rotated` variant by
rotating a card image 90° and feeding the RAW (pre-rectify) buffer directly to both preprocessing
paths — a deliberate stress test of the preprocessing ALGORITHM in isolation, which is a legitimate
and useful thing to measure (it establishes a worst-case bound on `preprocessRgbaForDino`'s fidelity
under an input shape the algorithm itself does not special-case for), but its 85% TOP1-agreement
result describes a state this benchmark manufactures, not one the shipped call path can ever
present to it. No preprocessing-orientation fix is needed or warranted — chasing this would tune
against an input the production code structurally cannot produce (prompt §11's own instruction: "do
not chase synthetic impossible states"). Recommend (documentation only, not code): the parity
report's own summary should note this scope explicitly in future runs so a 85% number is never
misread as a live production risk.

**Blur benchmark full-pipeline validation (prompt §7/§8, P98's disclosed gap).**
`scripts/scanner-recognition-lab/experiments/09-p93-continuous-blur-severity.ts` previously fed the
blurred corpus image directly into `computeBlurScore`, skipping the real `rectifyCard` stage
entirely — P98's audit confirmed this as a genuine calibration/production mismatch (nearest-neighbor
downsample inflates Laplacian variance 2-5x over a filtered resize near the threshold boundary) that
had never been closed. Fixed: the script now runs every query through the real `rectifyCard` (the
identical platform-neutral function `rectify-capture.ts` calls) at the real 700x980 canonical size
BEFORE computing the blur score, and embeds that SAME rectified image for retrieval (matching
`rectify-capture.ts`'s own "both channels consume the same canonical image" contract) — see that
script's own header for the full reasoning.

**Real full-pipeline results** (`pnpm scanner:recognition-lab:p93-blur-severity`, 80-card sample,
10-point Gaussian-sigma sweep, real production `rectifyCard` -> `computeBlurScore` -> real
retrieval against the full 4,296-card benchmark corpus):

| sigma | meanBlurScore | TOP1 acc | abstention rate | false-rejection rate | bad-capture catch rate |
|---|---|---|---|---|---|
| 0 (clean) | 8156.72 | 100% | 0% | 0% | n/a (0 bad captures) |
| 1 | 4505.34 | 98.8% | 0% | 0% | 0% (n=1) |
| 2 | 1149.70 | 97.5% | 1.3% | 1.3% | 0% (n=2) |
| 3 | 330.82 | 95.0% | 81.3% | 81.6% | 75% (n=4) |
| 4 | 128.58 | 90.0% | 100% | 100% | 100% (n=8) |
| 6 | 37.97 | 86.3% | 100% | 100% | 100% (n=11) |
| 8 | 14.88 | 72.5% | 100% | 100% | 100% (n=22) |
| 10 | 8.90 | 37.5% | 100% | 100% | 100% (n=50) |
| 14 | 4.66 | 6.3% | 100% | 100% | 100% (n=75) |
| 20 | 3.36 | 3.8% | 100% | 100% | 100% (n=77) |

**Disposition: KEEP 378, threshold now validated end-to-end.** The gate never misses a genuinely
bad capture past the sigma=3 boundary (100% bad-capture catch rate from sigma=4 onward, holding
through the most severe levels tested) — the safety property this project's own doctrine prioritizes
("false confidence is worse than abstention," this module's own header). The real, disclosed cost
sits exactly at the sigma=3 boundary: TOP1 accuracy is still 95% there, yet the gate already
abstains on 81.3% of those captures — a real over-rejection this full-pipeline run newly quantifies
precisely (the pre-P99 benchmark, which skipped the rectify stage, could only say the gate "trends
conservative" without a number this sharp). This is DIRECTIONALLY consistent with, and now
numerically confirms, P98's own finding from the un-rectified re-check (conservative, not
dangerously loose) — it does not newly disqualify 378, it quantifies the safety margin's real cost.
Per this prompt's own explicit instruction ("do not tune on the same cards used for validation"),
no new threshold is derived from this 80-card sample; recalibrating narrower (to reduce the sigma=3
false-rejection rate) would trade toward the riskier failure mode this project has repeatedly
chosen not to accept, and is left as a properly holdout-separated follow-up, not attempted here.

Note on `rectifyUsedFallbackRatePct` (85-100% across the sweep): expected and disclosed, not a
defect — this benchmark's corpus images are tight card crops with no background, so the corner
detector genuinely has no real margin to search (see the script's own header); the fallback path
still exercises the identical bilinear-warp-then-nearest-neighbor-downsample resize chain under
test, which is what this validation is actually checking.

---

## D-112 — dual-prototype reference index (`pristinePlus1Aux`), versioned multi-prototype format, backward-compatible with the shipped v1 index (P97)

**2026-09-04 · Accepted**

P91's recognition R&D (research/m15-p91-recognition-marathon) measured that reference-side
multi-prototype augmentation — adding one auxiliary prototype per card, a centroid of 6
deterministic photometric/geometric augmented views embedded and L2-normalized-averaged — closes
most of the moderate-distortion accuracy gap at zero added query-time inference cost (one embed
pass per scan, unchanged). P95 (research/m15-p95-recognition-phase2) independently re-confirmed the
identical strategy (`pristinePlus1Aux`) in a full six-architecture head-to-head comparison: it wins
or ties every non-catastrophic regime — including a NEW, more realistic "iPhone-like moderate"
distortion profile P91 never tested — at the lowest complexity of any option that beats plain DINO,
and explicitly REJECTED the alternatives a naive reading of the same evidence might suggest: image
rerank (NCC/SSIM/histogram) is actively dangerous outside geometry-only distortion (a 68-69%
false-confident rate on the realistic moderate regime); a general (non-blur) capture-quality gate
has no viable precision/recall tradeoff; local-feature rerank is real but non-essential; a different
backbone model has no evidence of being more photometric-robust than DINOv2-small. This session
implements ONLY the recommended strategy — dual-prototype reference augmentation — deliberately not
the rejected alternatives.

**Format.** `VisualIndexManifest` gains three OPTIONAL fields — `prototypeCount`,
`prototypeStrategy`, `prototypeStrategyVersion` — plus an optional `rowCount` cross-check, and
`coverage` gains optional `cardsWithAuxPrototype`/`cardsAuxFallback`. Absent (every already-
committed manifest) means implicitly `prototypeCount=1`, exactly today's shipped single-prototype
shape — no regeneration required, no runtime behavior change for the existing index.
`embeddings.bin` is card-major, prototype-minor (card0-proto0, card0-proto1, card1-proto0, ...);
`decodeVisualIndex` validates the byte length against `cardCount * prototypeCount * embeddingDim`
and rejects a mismatched `rowCount`, a non-positive/non-integer `prototypeCount`, or
`prototypeCount > 1` without both strategy fields present. `searchVisualIndex` scores each card by
the MAX dot product over its own prototype rows (P91/P95's own `searchMultiProto` reduction,
reproduced exactly) and pushes exactly one hit per card — the matcher downstream (untouched, out of
this session's scope) sees the identical "one similarity score per candidate" shape it always has.

**Backward compatibility is load-bearing, not incidental — verified empirically, not just by
design.** `buildIndexContentPayload`'s canonical hash object assigns the three new prototype fields
WITHOUT `?? null` (unlike the existing `sourceProjectRef`/`sourceEnglishActiveCount` fields):
`JSON.stringify` drops an `undefined`-valued key, so a v1 manifest (which never sets these fields)
serializes to a BYTE-IDENTICAL payload to what this function produced before these fields existed —
the content id of an already-published generation never shifts. This was proven, not assumed:
`pnpm scanner:index:verify` was run against this repository's actual real, committed 19,501-card
generation after every code change in this session, and it verifies to the exact same content id
(`1a1df11a73c462d8`) P94 recorded. `CHECKPOINT_SCHEMA_VERSION` bumped 2 -> 3 and
`CheckpointIdentity` gained required `prototypeCount`/`prototypeStrategy`/`prototypeStrategyVersion`
fields, so a checkpoint from a prior (single-prototype) build session is automatically discarded and
rebuilt from scratch — a single-prototype checkpoint can never silently resume into a dual-prototype
build, and vice versa.

**Auxiliary-prototype fallback (prompt §13).** A card whose pristine embedding succeeds but whose
auxiliary (6-augmentation-centroid) computation fails is still indexed and fully searchable — its
prototype-1 row is a deterministic DUPLICATE of prototype 0 (never a zero vector, which would make
that prototype an artificially bad match instead of a neutral no-op) — `coverage.cardsAuxFallback`
counts these; `coverage.cardsWithAuxPrototype` counts cards with a real auxiliary embedding. Unlike
the (deliberately permanent, not-a-skip-gate) `auxFallback` checkpoint marker's role in earlier
drafts of this session's own implementation, the SHIPPED behavior retries a failed auxiliary
computation on every resumption until it actually succeeds — exactly mirroring how a failed
PRISTINE embedding has always behaved (never persisted as "permanently given up"). `auxFallback` in
the checkpoint is diagnostic-only, always overwritten fresh, and cleared on a later success.

**Cost, measured against the real committed index, not estimated.** Real single-prototype generation:
`embeddings.bin` 7,488,384 bytes (7.14 MB) + `card-ids.json` 760,540 bytes (0.73 MB) = 7.87 MB.
Projected dual-prototype generation at the same real 19,501-card scale: `embeddings.bin`
14,976,768 bytes (14.28 MB, exactly 2x) + the same `card-ids.json` = ~15.01 MB total — a ~7.14 MB
delta, matching P95's own independent recomputation from this exact production format almost
exactly. Decoded runtime memory (Float32, one generation held at a time, unchanged pattern from the
single-prototype worker) roughly doubles in step: ~28.6 MB -> ~57.1 MB — an expected, disclosed
consequence of dequantizing twice as many rows, not an accidental duplication; the worker never
holds more than one decoded generation in memory at once, matching the existing single-prototype
pattern exactly.

**Not implemented this session, and why:** the real hosted 19,501-card dual-prototype rebuild, F-03
against the real hosted catalog, the real-19,501-scale P95 reproduction, and the production name
lexicon build all require `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, which were not present in this
environment (the same standing gap every M15 session since P75 has disclosed) — this session never
fakes, estimates, or assumes those results; it ships CODE_READY_NEEDS_OWNER_BUILD with the exact
commands recorded for the next session or the owner to run. The committed 19,501-card v1 index is
untouched. No card was special-cased anywhere.

---

## D-113 — dual-prototype benchmark-leakage fix, fail-closed index schema v2, corrected re-run and quantization evidence (P100)

**2026-09-04 · Accepted**

P98's post-repair adversarial audit (output_98.txt §18-20) CONFIRMED a real methodology defect in
P95's own two-stage architecture comparison (`experiments/17-two-stage-pipeline-search.mjs`): its
"geometryOnly" query was constructed via `applyNamedProfile('perspective-rotate', buf, trueId)` —
the exact same function, on the exact same source buffer, with the exact same deterministic
per-card seed (`augment/photometric.mjs`'s `baseSeed + idx*97`) already used to build one of the
six augmented views averaged into that card's own dual-prototype auxiliary embedding. The query
was therefore byte-identical to one of the ingredients of its own reference — the reported 100%
TOP1 on that regime measured near-tautological self-recall, not generalization. This decision
records the fix, the corrected re-run, and the fail-closed index-format contract P98 additionally
required before any real dual-prototype build.

**1. Leakage fix.** `scripts/scanner-recognition-lab/augment/heldout.mjs` is a genuinely
independent QUERY-side transform family for held-out validation — different `sharp` operations per
effect than either `photometric.mjs` (reference augmentation) or `continuous.mjs` uses (raw affine
matrices instead of `.rotate()`, a box/motion convolution kernel instead of Gaussian `.blur()`,
`.tint()` color-temperature shift instead of `.modulate()`, a linear-band `'lighten'` glare instead
of a radial `'screen'` one, and a crop/translation mechanic neither existing module has at all),
plus an independently-salted seed derivation (`'heldout::'+cardId`, multiplier base 151). Eight
named regimes: `clean` (pristine control), `heldoutGeometry`, `heldoutMildPerspective`,
`heldoutCropTranslation`, `heldoutBlur`, `heldoutExposureWhiteBalance`, `heldoutGlare`,
`mixedModerate`. `scripts/scanner-recognition-lab/retrieval/leakage-guard.mjs` is a permanent,
runtime, hash-based (`sha256`) leakage detector: every corrected benchmark script hashes a card's
full reference-ingredient set (pristine + 6 augmented views) and asserts every DISTORTED held-out
query buffer differs from all of them, throwing (aborting the run) on any collision — `clean` is
deliberately exempt (it IS the pristine buffer by definition, not a leak). Permanent regression
coverage: `tests/scanner-research/leakage-guard.test.ts` (11 cases) proves this END TO END against
a real, procedurally-generated image run through the REAL `augmentAll`/`buildAllHeldoutQueries`
pipelines (no network/model dependency, part of the ordinary `pnpm test` gate via a new
`tests/scanner-research/**/*.test.ts` include entry in `vite.config.ts`), plus structural
disjointness assertions (`HELDOUT_REGIMES` shares no name with `AUGMENTATION_PROFILES`/`AXES`/
`HARD_AUGMENTATION_PROFILES`).

**2. Corrected re-run** (`experiments/18-corrected-two-stage-comparison.mjs`, real run against the
P91/P95 4,296-card research corpus, n=300, card-id-separated 1,000-resample bootstrap 95% CIs,
900/900 leakage-guard checks passed with zero collisions):

| Regime | A (DINO) TOP1 | B (dual-proto) TOP1 | C (DINO+rerank) TOP1 | F (dual+local-feature) TOP1 |
|---|---|---|---|---|
| clean | 100% | 100% | 100% | 100% |
| heldoutGeometry | 91.3% [88,94] | **99.7% [99,100]** | 97.0% [95,98.7] | 96.3% [94,98.3] |
| mixedModerate | 81.3% [77,85.7] | **95.7% [93.3,97.7]** | 40.0% [34,45.7] (60% false-confident) | 96.3% [94,98.3] |
| hardGlareShadowBlur | 0.3% | 0.3% | 0% | 0.3% (all ~100% abstained) |

The corrected magnitude is smaller than P95's contaminated claim (which reported 100%/100% on
geometry-only for both A and B at leaked-query self-recall) but the DIRECTION survives fully:
dual-prototype alone gives a real, statistically clear gain over plain DINO on both non-trivial
non-catastrophic regimes (95% CIs do not overlap), at the lowest complexity of any option tried.
Image rerank (C) is independently RE-CONFIRMED actively dangerous outside geometry-only (60%
false-confident on the realistic moderate regime) — not an artifact of the original leak, since
this re-run never shared any construction with the reference side. Local-feature rerank (F) is
real but does not clearly beat dual-prototype alone (essentially tied on both regimes) — reconfirms
P95's own "optional, not required" conclusion. `DUAL_RECOMMENDED=yes` stands, now on
non-contaminated evidence.

A broader DINO-vs-dual sweep across all 8 `HELDOUT_REGIMES` (`experiments/
19-full-heldout-regime-sweep.mjs`, n=250, 1,750/1,750 leakage-guard checks passed) shows the gain
is real but NOT uniform — the honest, non-oversold picture:

| Regime | DINO TOP1 | Dual TOP1 | Δ (dual − DINO) |
|---|---|---|---|
| clean | 100% | 100% | 0 |
| heldoutGeometry | 92.8% [90,96] | 99.6% [98.8,100] | +6.8 |
| heldoutMildPerspective | 96.0% [93.6,98.4] | 99.6% [98.8,100] | +3.6 |
| heldoutCropTranslation | 94.8% [92,97.2] | 98.4% [96.8,99.6] | +3.6 |
| heldoutBlur | 99.2% [98,100] | 100% | +0.8 |
| heldoutExposureWhiteBalance | 96.4% [94,98.4] | 96.8% [94.4,98.8] | +0.4 (noise) |
| heldoutGlare | 100% | 100% | 0 |
| mixedModerate | 78.8% [74,83.6] | 96.0% [93.6,98.4] | **+17.2** |

Dual-prototype's gain concentrates on GEOMETRIC distortion (rotation/perspective/crop-translation)
and, most importantly, the realistic multi-axis composite (`mixedModerate`, independently
corroborated by experiment 18's own +14.4pt at n=300) — plain DINO is already near-ceiling on
isolated blur/exposure/glare, where dual-prototype adds little to nothing. This is the correct,
defensible characterization: dual-prototype is recommended because it closes the single largest,
most realistic gap (mixedModerate), not because it helps everywhere uniformly.

**3. Fail-closed index schema v2.** P97's `VisualIndexManifest.prototypeCount` renamed to
`prototypesPerCard` throughout (`src/data/scanner/visual-index.ts`, `src/domain/scanner/
index-content-id.ts`, `checkpoint-identity.ts`, `scripts/scanner-visual-index/{build-index,
verify-index}.ts`, the worker/client/controller/diagnostics-format chain, and every test) — one
canonical name, not a duplicate synonym. Two new manifest fields, `schemaVersion: number` and
`payloadFormat: string`, form an explicit discriminant DISTINCT from the free-text `version` string
(which only ever names the embedding contract, never a binary-layout version) per P98's own
finding: a future format doubling `embeddingDim` to concatenate prototypes would have passed every
pre-P100 check silently. Contract: a manifest with NONE of `schemaVersion`/`payloadFormat`/
`prototypesPerCard` is LEGACY_V1 (every already-committed generation, implicitly one prototype per
card); a manifest setting ANY of the three must set ALL three together, and `schemaVersion` must be
in a closed allow-list (`SUPPORTED_EXPLICIT_SCHEMA_VERSIONS`, currently `{2}`) — `decodeVisualIndex`
throws (fails closed, never guesses) for a partial declaration or an unrecognized `schemaVersion`/
`payloadFormat`. `visual-worker.ts` gained a symmetric pre-decode short-circuit (mirroring the
existing `EXPECTED_MODEL_REVISION` pattern) so an unrecognized schema degrades to the existing
graceful OCR-only fallback with a specific diagnostic reason, never a thrown exception surfacing to
the UI. New diagnostics fields `indexSchemaVersion`/`indexPayloadFormat` (worker/client/controller/
contract) and `INDEX_SCHEMA_VERSION=`/`INDEX_PAYLOAD_FORMAT=` lines (diagnostics-format.ts,
build-index.ts, verify-index.ts). All five explicit-schema fields enter the content-id hash
(index-content-id.ts) independently — regression tests pin that same bytes + different
`schemaVersion` alone, different `payloadFormat` alone, different `prototypesPerCard` alone (with
strategy/version held fixed), and different `prototypeStrategy` alone each mint a different content
id. **Backward compatibility re-verified empirically after the rename+redesign**: `pnpm
scanner:index:verify` against the real, unmodified, committed 19,501-card generation still reports
content id `1a1df11a73c462d8` — byte-identical to before this change.

**4. Quantization/search evidence** (throwaway scripts under `scripts/scanner-visual-index/`, not
committed as permanent tooling — their JSON reports are gitignored like every other lab benchmark
report): a 1,000+-query FP32-vs-INT8 retrieval-agreement test (the one P97 explicitly disclosed not
running) against the full 4,296-card cached research corpus, using the PRODUCTION
`quantizeEmbedding`/`VISUAL_INDEX_INT8_SCALE` functions directly — 100% TOP1 agreement, 95.7% mean
TOP5 overlap, zero rank changes for any query's own TOP1 candidate, worst similarity error 0.0086
(consistent with the existing V4 quantization-accuracy-bound unit test's <0.01 bound). A direct-
int8 vs Float32-decoded search benchmark at the real 19,501-card scale (1/2/5 prototypes/card,
against the REAL committed int8 bytes) found searching directly against the raw `Int8Array`
(dequantizing each component inline at multiply time) is not just memory-saving but ALSO FASTER
than the current decode-then-search shape at every prototype count tested (24ms vs 43ms at 1 proto,
38ms vs 58ms at 2, 61ms vs 122ms at 5 — Node/CPU environment, not a device measurement), with
byte-for-byte identical TOP-K rankings (7/7 queries at every scale). This is a genuine, low-risk
future optimization for `searchVisualIndex`, disclosed but deliberately NOT implemented in
production this session (the prompt's own scope is index format/evidence, not a matcher/search
rewrite; a future session should make this change once a real dual-prototype index actually exists
to benchmark it against end to end).

**5. Real-capture validation tooling** (`scripts/scanner-recognition-lab/real-capture/
validate-real-captures.ts`) — a ready CLI (owner supplies `--dir=`/`--mapping=`) that scores
independently-captured real photos against any P87-shaped visual index (legacy or dual-prototype)
through the exact production `decodeVisualIndex` fail-closed contract, reporting TOP1/3/5/20, true-
card rank/similarity, which prototype won, capture quality (blur score) and the shipped abstention
decision — no card-specific scoring anywhere. No independently-captured real photos exist in this
repository or its caches (checked); `REAL_CAPTURE_RESULTS=pending owner sample`.

No production matcher/scoring code (`src/domain/scanner/engine.ts`/`visual-evidence.ts`) touched.
No hosted build run; `OWNER_BUILD_AUTHORIZED` gated on the full P100 output file's final verdict.

---

## D-114 — Direct-int8 visual search with bounded top-K selection, shipped to production (P102)

**2026-09-04 · Accepted**

P100 measured (but deliberately did not ship, out of that session's own scope discipline) that
searching directly against the raw int8 index — dequantizing each component inline at multiply
time — is both faster AND lighter than the shipped decode-whole-index-to-Float32-then-search
shape, at every prototype count tested. This session ships that optimization in production, plus a
bounded top-K selection structure the earlier measurement didn't cover, and closes a real
tie-breaking bug the numerical verification surfaced along the way.

**1. Direct-int8 search.** `decodeVisualIndex` (`src/data/scanner/visual-index.ts`) no longer
materializes a Float32-decoded copy of the index at all — `DecodedVisualIndex.embeddingsInt8`
(renamed from the old decoded `embeddings` field) keeps the raw `Int8Array` exactly as handed to
it. `searchVisualIndex` dequantizes each component inline, accumulating the dot product as an
integer sum and dividing once by `VISUAL_INDEX_INT8_SCALE` per prototype (not once per dimension).
The old per-row `assertFinite` pass over the decoded Float32 copy is also gone, not replaced: an
`Int8Array` component divided by a fixed nonzero scale can never produce `NaN`/`Infinity`, so that
check was always vacuously true for this quantization scheme — it validated a conversion step that
no longer happens, never the source bytes (whose shape the existing byte-length check already
validates). Legacy v1 (`prototypesPerCard=1`) and schema-v2 (`prototypesPerCard>=2`) indexes share
this one loop, parameterized by `prototypesPerCard` — never two independent search implementations
that could drift apart.

Real, measured consequence for the dual-prototype case P97/P100 already disclosed roughly doubling
runtime memory (28.56MB -> 57.13MB) purely from dequantizing twice as many rows: that doubling no
longer happens at all, for legacy OR dual-prototype indexes — decode is now just the existing
shape/duplicate-id validation, no per-value conversion pass.

**2. Bounded top-K (`BoundedTopK`).** Measured, not assumed, before deciding whether to build this:
`Array.prototype.sort` over the full hit-object list is NOT a negligible cost next to the
dot-product scan — at the real dual-prototype scale (39,002 rows) it measured ~13ms against a
~24ms scan, a real ~36% addition, not the "two orders of magnitude smaller" an early draft of this
session's own reasoning assumed before actually measuring it. The real production search path's
`topK` is a small, fixed 30 (D-101/`controller.ts`) — far smaller than the index — so a
capacity-`topK` binary min-heap (`BoundedTopK`, exported and unit-tested directly) replaces the
full sort with O(n log topK) selection whenever `topK` is smaller than the index; a caller
requesting a FULL ranking (`topK >= cardCount` — the diagnostics rank-lookup path only, never the
hot per-scan path) falls back to the plain full sort instead, where a same-size heap would add
overhead for no benefit.

**3. Real bug found and fixed via numerical verification, not assumed correct from the algorithm
looking right on paper.** The initial `BoundedTopK` implementation disagreed with the full-sort
path on TOP1 for 3 of 4,296 real queries. Root cause: two DISTINCT cards in the real 19,501-card
catalog can have float64-identical similarity to a query (real duplicate/near-duplicate reference
embeddings — e.g. reprints sharing artwork). The full-sort path breaks such ties by ascending card
index, because `Array.prototype.sort` is stable (ES2019+) and cards are pushed into that array in
ascending index order; `BoundedTopK`'s own internal array order is sift-history order, not card
index order, so its `drainSorted()` sorting by similarity alone let exact ties resolve by an
arbitrary heap-internal order instead. The SET of kept top-K cards was already correct in every
case — only which of two exactly-tied cards was reported as the winner could differ. Fixed with an
explicit `similarity desc, then index asc` tie-break in `drainSorted()`, matching the full-sort
path's own (previously implicit, now explicitly documented) rule; two new `BoundedTopK` unit tests
pin both the top-of-ranking tie case that surfaced the bug and the eviction-boundary tie case that
was already correct.

**4. Numerical parity — real, not synthetic, and re-run after the tie-break fix, not before.**
`scripts/scanner-visual-index/verify-int8-parity.ts` (throwaway verification tool, report
gitignored like every other lab benchmark): every one of the real 4,296 cached DINOv2 embeddings
from the P91/P95 recognition-lab corpus, used as a query against (a) the REAL committed
19,501-card production index and (b) a synthetic 39,002-row (2 prototypes/card) index built from
the real int8 bytes (P100's own technique, reused) — no real dual-prototype index exists yet to
test against (owner build pending). Comparison is against a from-scratch reimplementation of the
OLD (removed) decode-then-search shape, not the new code compared against itself.

```
INT8_FP32_TOP1_AGREEMENT (legacy-v1, real index)=4,296/4,296 (100.00%)
INT8_FP32_TOP1_AGREEMENT (synthetic schema-v2)=4,296/4,296 (100.00%)
TOP3/TOP5/TOP20 set overlap=100.00% (both passes)
WORST_TOP1_SIMILARITY_ERROR=~1.8e-8 (both passes — floating-point noise, far under the existing
  V4 quantization-accuracy-bound unit test's <0.01 per-component tolerance)
WINNING_PROTOTYPE_IN_RANGE (dual-prototype pass)=4,296/4,296
DISAGREEMENT_COUNT=0 (both passes, after the tie-break fix — was 3/4,296 before it)
```

**5. Measured search speed** (`scripts/scanner-visual-index/benchmark-int8-vs-float32-search.mjs`,
P100's own script, actually re-run this session — not P100's old numbers restated — against the
real committed int8 bytes, 7 repeats, Node/CPU environment on this session's own machine (under
its own concurrent load from this session's other verification work, so the absolute numbers are
higher than P100's own report on a different machine at a different time; only the RELATIVE
comparison is the load-bearing claim, matching P100's own explicit framing for the identical
caveat):

```
DIRECT_INT8_SEARCH_MS=37.11 (1 proto, 19,501 rows) / 67.72 (2 proto) / 115.34 (5 proto)
FLOAT32_DECODED_SEARCH_MS=60.29 (1 proto) / 113.56 (2 proto) / 274.41 (5 proto)
TOP1_IDENTITY / FULL_TOPK_IDENTITY=7/7 at every scale (byte-for-byte identical rankings)
```

Direct-int8 is faster at every scale tested (~38-58% depending on prototype count), on top of no
longer allocating a decoded Float32 copy at all — a genuine memory-AND-speed win, not a tradeoff.

**Verified:** unit suite 1229/1229 (84 files, +20 new/updated cases across `BoundedTopK`,
`searchVisualIndex`'s two selection paths, and the `embeddingsInt8` rename). Typecheck/lint (0
errors, 28 pre-existing warnings)/format clean. `pnpm scanner:index:verify` against the real,
unmodified, committed 19,501-card generation still reports content id `1a1df11a73c462d8` —
byte-identical, backward compatibility re-proven after this rewrite, not assumed. Real-browser
regression check: `tests/e2e/visual-worker-real-browser.spec.ts` (the actual built worker chunk,
real DINOv2 model, real ORT WASM, real committed index) passes on both `desktop-chromium` and
`mobile-iphone` (WebKit) — a genuine embed+search round trip against the rewritten search path, in
two real browser engines, not just Node unit tests.

No production matcher/scoring code touched. No hosted build run.

---

## D-115 — Safari vs. Chromium ORT WASM byte contradiction resolved: P96 was right, P100's write-up had the labels swapped (P102)

**2026-09-04 · Accepted**

**Context.** P96's own report and P100's own report disagreed about which browser downloads which
ONNX Runtime WASM binary: P96 said non-Safari gets the larger asyncify variant (~23.57 MB) and
Safari gets the smaller non-asyncify variant (~12.94 MB); P100 said the opposite (Safari =
asyncify/23.57 MB, non-Safari = non-asyncify/12.94 MB). Neither prior session traced this back to
the actual source, so the contradiction stood unresolved into this session.

**Resolution — traced to source, not re-guessed.** `src/features/scanner/visual/visual-worker.ts`
(the `wasmPaths` assignment, immediately after `detectIsSafariUserAgent()` is called):

```
env.backends.onnx.wasm.wasmPaths = isSafari
  ? { wasm: `${ASSET_BASE}/ort/ort-wasm-simd-threaded.wasm` }          // Safari
  : { wasm: `${ASSET_BASE}/ort/ort-wasm-simd-threaded.asyncify.wasm` } // everyone else
```

`detectIsSafariUserAgent()` (`safari-detection.ts`) correctly identifies real Safari/WebKit (Apple
vendor string, not a Chromium-based browser masquerading with one) — no inversion bug in the
detection logic itself. The two physical files, measured directly from the installed
`onnxruntime-web@1.26.0-dev.20260416` package (the exact same bytes `prepare-scanner-assets.mjs`
stages into the build):

| File | Real measured bytes | Served to |
|---|---|---|
| `ort-wasm-simd-threaded.wasm` | 12,942,611 (~12.94 MB) | **Safari** |
| `ort-wasm-simd-threaded.asyncify.wasm` | 23,567,050 (~23.57 MB) | **non-Safari (Chromium etc.)** |

**P96's report was correct.** **P100's write-up inverted the Safari/non-Safari labels** — a
reporting error in that session's prose, not a code change (P100's diff never touched this section
of `visual-worker.ts`; git history confirms the ternary above is unchanged since before P96).

**Definitive matrix (real measured bytes, this session):**

```
SAFARI_WASM_FILE=ort-wasm-simd-threaded.wasm
SAFARI_WASM_BYTES=12,942,611 (~12.94 MB)
CHROMIUM_WASM_FILE=ort-wasm-simd-threaded.asyncify.wasm
CHROMIUM_WASM_BYTES=23,567,050 (~23.57 MB)
```

Counter-intuitively, **Chromium downloads the LARGER ORT WASM binary, not Safari** — the opposite
of the usual "Safari needs more polyfilling" assumption. `.mjs` glue files (paired with each
`.wasm` binary, always fetched alongside it): Safari 24,180 bytes, Chromium 47,389 bytes — the
same direction, so this does not change once the small glue file is included.

**Full first-use byte totals**, recomputed from real measured bytes (model, OCR) plus the real
committed v1 index (not the projected dual-prototype index, which does not exist yet — see the
projected figure separately below):

| Component | Bytes | Source |
|---|---|---|
| DINOv2-small model | 24,451,943 | `model-pin.mjs` pinned/verified constant |
| ORT WASM + glue (Safari) | 12,966,791 | measured, this session |
| ORT WASM + glue (Chromium) | 23,614,439 | measured, this session |
| Visual index (real, committed, v1) | 8,249,572 | measured, this session (`embeddings.bin` + `card-ids.json` + `manifest.json`) |
| OCR (Tesseract, SIMD path — the realistic path on both modern Safari and Chromium) | 9,821,253 | measured, this session (`worker.min.js` + `tesseract-core-simd-lstm.wasm(.js)` + `eng.traineddata.gz`); the two other core variants (`relaxedsimd`, non-SIMD fallback) are also shipped for feature-detected fallback but are NOT downloaded on a SIMD-capable browser, so they are excluded from this total, not silently dropped |

```
FIRST_USE_SAFARI_TOTAL_BYTES=55,489,559 (~55.49 MB) — current shipped v1 index
FIRST_USE_CHROMIUM_TOTAL_BYTES=66,137,207 (~66.14 MB) — current shipped v1 index
```

Projected once the owner builds the real dual-prototype index (replacing the visual-index
component above with P97/P100's own projected ~15,738,058-byte figure, unchanged arithmetic from
those sessions — not re-derived here, since no real dual index exists yet to remeasure):

```
FIRST_USE_SAFARI_TOTAL_BYTES (projected, dual-prototype)=62,978,045 (~62.98 MB)
FIRST_USE_CHROMIUM_TOTAL_BYTES (projected, dual-prototype)=73,625,693 (~73.63 MB)
```

No excluded component in either total — every prior session's report explicitly excluded OCR
("not independently re-measured"); this session measured it directly instead.

**Not done, disclosed:** this is a code+asset audit, not a live network capture — no real Safari or
Chromium browser actually loaded the app to confirm requests match this list exactly (e.g. that a
CDN/proxy doesn't recompress, or that HTTP range requests don't change effective bytes-on-wire).
`_headers`' own `Content-Encoding`/compression behavior for these paths was not independently
re-verified this session; the byte totals above are uncompressed (raw) file sizes, matching every
prior session's own convention for this same table.
## D-116 — robots.txt/sitemap default to "disallow everything, allow three pages" (P101)

**Decision.** `public/robots.txt` disallows the entire site by default and explicitly allows only
`/privacy`, `/terms`, `/faq`; `public/sitemap.xml` lists exactly those same three URLs.

**Why not the conventional "allow everything, disallow the private paths" shape.** PokePortfolio is
genuinely private (PRODUCT_SPEC.md §1.1: "Not a public platform. No social features... no public
profiles," invite-only, no public signup). There is no organic-discovery value in indexing a closed
tool's sign-in form, and doing so risks the app reading as a public consumer product it deliberately
isn't. Deny-by-default also means a future route added to `router.tsx` is automatically excluded
from crawling unless someone deliberately opens it up — the safer failure direction for an app whose
private routes carry real financial/collection data.

`/login` is deliberately NOT in the allow list, on the same reasoning — no discovery value, avoids
looking like a public signup surface. `/invite/$token` and `/reset-password` are never eligible
regardless of policy shape: both carry a live, single-use secret token in the URL, and indexing
either would be an actual secret-leak vector, not just an SEO nit.

**Enforcement.** `robots.txt`/`sitemap.xml` are a crawler *request*, not an access-control boundary
— Postgres RLS and route guards remain the real boundary (SECURITY.md §2/§3), unchanged by this
decision. `scripts/check-links.mjs` cross-checks `robots.txt`'s `Allow:` list against
`sitemap.xml`'s URLs and against its own hardcoded `PUBLIC_ROUTES` constant, so the three can't
silently drift — a route added to one and not the other two fails the check rather than shipping
unnoticed.

**Verified:** `node scripts/check-links.mjs` against a real production build, 29/29 checks passed,
including the three-way consistency check and the never-allow-a-token-route check.

---

## D-117 — No cookie-consent banner; nothing non-essential is stored client-side (P101)

**Decision.** No cookie/consent banner is shown anywhere in the app.

**Why.** A real inventory of every client-side storage mechanism in use, done before deciding
anything (`src/data/supabase-client.ts`, `src/ui/theme.ts`, grep across `src/` for
`localStorage`/`sessionStorage`/`document.cookie`):

- Supabase's own session token (`@supabase/supabase-js`'s default `persistSession`/`localStorage`
  storage) — strictly necessary; the app cannot function signed-in without it.
- `pp-theme` (`src/ui/theme.ts`) — a UI preference the user explicitly sets (Profile), not tracking.
- Nothing else. No analytics storage exists yet (see D-118): Cloudflare Web Analytics is, per
  Cloudflare's own documentation, cookieless and uses no client-side storage at all — confirmed
  against current docs before this decision was written, not assumed from general reputation.
- SECURITY.md §9.1's query-cache boundary already establishes the TanStack Query cache itself holds
  nothing in `localStorage` (module-lifetime memory only, cleared on identity change).

Every stored value is either strictly necessary (session) or a user-set preference with no tracking
purpose (theme). Neither category requires consent under the ePrivacy "strictly necessary" /
first-party-preference exemptions this reasoning relies on, and there is no non-essential or
third-party tracking mechanism in the app to gate behind a banner. A banner would therefore be
decorative — asking consent for something that collects nothing — which the P101 prompt explicitly
warned against ("do not add a fake cookie banner simply because a checklist says so").

**Revisit condition.** If a future session adds any cookie/storage mechanism that is NOT strictly
necessary and NOT a plain first-party UI preference (a third-party script that sets cookies, a
tracking pixel, a non-Cloudflare analytics tool), this decision no longer holds and a real
consent/preferences UI must be built and gated in front of it — see COST_POLICY.md's service-vetting
checklist for the same rule applied to the cost dimension.

---

## D-118 — Cloudflare Web Analytics adopted, opt-in via env var, off by default (P101)

**Decision.** Cloudflare Web Analytics is wired into the app (`src/analytics/cloudflareWebAnalytics.ts`,
loaded from `main.tsx`) but stays completely inactive — no script loads, no CSP allowance is
granted — unless `VITE_CF_ANALYTICS_TOKEN` is set at build time.

**Why this option.** Selection-order per COST_POLICY.md §3 (existing stack first): Cloudflare Pages
is already the hosting provider and already the account in use, so its own analytics product is a
capability the existing stack provides for $0, not a new vendor relationship. Confirmed against
current official Cloudflare documentation (developers.cloudflare.com/web-analytics, 2026-09, not
assumed from training data): free, no card/billing tier gate, and — the deciding factor over any
alternative — "does not use any client-side state, such as cookies or localStorage... does not
'fingerprint' individuals via IP address, User Agent, or any other data." That is what makes D-117's
no-consent-banner decision hold.

**Mechanism.** The official snippet
(`<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"…"}'>`)
is injected via a DOM-created `<script>` element rather than a static tag in `index.html`, so it
stays governed by the ordinary CSP `script-src` allowance rather than needing an inline-script
exception. The default snippet shape (no `"spa": false"`) auto-tracks route changes via the History
API — confirmed against Cloudflare's SPA-specific docs — which is exactly right for this
client-side-routed app and needed no custom per-navigation tracking code.

`vite.config.ts`'s `buildContentSecurityPolicy(supabaseUrl, analyticsEnabled)` gained a second,
default-`false` parameter: `script-src` gains `https://static.cloudflareinsights.com` and
`connect-src` gains `https://cloudflareinsights.com` only when `VITE_CF_ANALYTICS_TOKEN` was present
at build time, so the policy stays at its previous strict shape for every build until the owner
configures it. `tests/config/security-headers.test.ts`'s existing pins are unchanged (they call the
function with one argument, exercising the default-off shape).

**Owner action required.** Add the site in the Cloudflare dashboard (Analytics & Logs → Web
Analytics → Add a site — the existing Pages account, no new account) and set
`VITE_CF_ANALYTICS_TOKEN` as a Cloudflare Pages build environment variable. Until then this ships
code-complete but genuinely inactive, not merely "off by convention."

**Verified:** `pnpm test` (security-headers.test.ts's CSP pins unchanged, 1142/1142 overall),
`pnpm build` with no token set — `dist/_headers`' CSP `script-src`/`connect-src` unchanged from the
pre-P101 shape.

---

## D-119 — Cloudflare Web Analytics route-gated to the public allowlist; SPA auto-tracking disabled (P110)

**2026-09-05 · Accepted**

**Problem.** P107's adversarial review (output_107.txt §11) confirmed a real gap in D-118's
original design, not yet exploitable only because analytics ships off by default: `main.tsx` called
`initCloudflareWebAnalytics()` unconditionally, and D-118's own chosen snippet shape (no
`"spa": false"`) auto-tracks every SPA route change via the History API, reporting `location.href`
for each one. Every authenticated route in this app embeds an entity id directly in its path
(`/portfolio/$holdingId`, `/purchases/$purchaseId`, `/sales/$saleId`, `/openings/$openingId`,
`/catalog/$cardId`, …) — the moment the owner sets `VITE_CF_ANALYTICS_TOKEN`, every such page load
would be reported to Cloudflare, contradicting the "no custom events" framing D-118 relied on.

**Fix, in two parts.**

1. **Explicit allowlist** (`src/analytics/analyticsRoutePolicy.ts`, `isAnalyticsEligibleLocation`):
   deliberately mirrors `public/robots.txt`/`public/sitemap.xml`/`scripts/check-links.mjs`'s own
   `PUBLIC_ROUTES` (D-116) — exactly `/privacy`, `/terms`, `/faq`. `/login`, `/forgot-password`,
   `/invite/$token` and `/reset-password` are public but excluded, for the same reason D-116
   already excludes them from crawling: no discovery/analytics value, and the token routes carry a
   live secret in the URL that must never leave the origin. A location carrying ANY query string is
   also ineligible — this app's public pages never legitimately carry one, so a query string is
   itself a signal something unexpected is happening, and Cloudflare's beacon has no supported way
   to report a sanitized URL, so refusing to track it at all is the only way to guarantee query
   parameters are never transmitted.
2. **SPA auto-tracking disabled** (`src/analytics/cloudflareWebAnalytics.ts`): the beacon's
   `data-cf-beacon` config now sets `"spa": false`, so Cloudflare's own script never attaches a
   History-API hook — it can only ever report the ONE pageview it fires at its own injection time.
   `initCloudflareWebAnalytics(location)` takes the location to evaluate explicitly (never reads
   `window.location` itself) and injects the script AT MOST ONCE per session, only when that exact
   location is eligible. `main.tsx` calls it once at startup with the initial location, and again
   after every `router.subscribe('onResolved', …)` navigation — the second call is what lets a
   session that starts on a private route (or `/login`) initialize analytics later, once it
   genuinely reaches an eligible public page; the idempotent one-shot latch means it is a no-op
   every other time.

**Disclosed tradeoff.** Because the History hook is off and the script is never re-injected for a
later navigation, at most ONE pageview is ever reported per browser session — even a visit to
`/faq` followed by `/privacy` only counts the first. This undercounts genuine multi-page public
browsing. The alternative (re-injecting a fresh `<script>` element on every eligible navigation to
fire another pageview) was considered and rejected: Cloudflare's own documentation does not
describe this as a supported manual-tracking mechanism, so relying on it would be an unverified
assumption. A single, guaranteed-private-route-free pageview per session is the safe default;
revisit only if Cloudflare documents a supported manual-pageview API.

**Verified:** `tests/data/analytics-route-policy.test.ts` (allowlist correctness, deny-by-default,
query-string refusal, cross-checked against `scripts/check-links.mjs`'s own `PUBLIC_ROUTES`),
`tests/ui/cloudflare-web-analytics.test.ts` (dummy token only — public FAQ/privacy initialize;
portfolio/holding/scan/invite/reset-password never do; a query string on an eligible page never
initializes; public→private emits nothing further; private→public initializes once reached;
idempotent against a second eligible call). No real Cloudflare token used anywhere. D-118's CSP
gating (script-src/connect-src widened only when the token is present) is unchanged by this
decision — only WHEN the already-gated script is allowed to load has changed.

---

## D-120 — Dashboard-read index: replace `price_snapshots_variant_date_idx` with a three-column covering index (P108)

**2026-09-05 · Accepted**

**Context.** P105 root-caused `get_dashboard_summary` exceeding its 1500ms budget via a real
`EXPLAIN (ANALYZE, BUFFERS, VERBOSE)`: 733 of 836ms (87.5%) is one `Function Scan` on
`resolve_variant_market_values`, whose `latest_snapshot` CTE does
`distinct on (card_variant_id, provider) ... order by card_variant_id, provider, snapshot_date desc`
against `price_snapshots`. The only existing index, `price_snapshots_variant_date_idx
(card_variant_id, snapshot_date desc)`, omits `provider` and cannot satisfy that ordering — Postgres
re-sorts nearly the whole table instead of streaming one row per group. P107 independently reasoned
the same root cause from the SQL text alone (no DB access that session).

**Decision.** One forward migration
(`20260905120000_p108_dashboard_price_index.sql`): add
`price_snapshots_variant_provider_date_idx (card_variant_id, provider, snapshot_date desc) include
(price_kind, source_currency, value_minor, provider_updated_at)`, matching the `DISTINCT ON`'s exact
grouping/ordering; drop the now-redundant two-column index in the same migration, after confirming
(not merely asserting) every other reader of `price_snapshots` remains served: `get_card_variant_
price_history`'s single-variant range scan (leading-column prefix, unaffected),
`select_price_sync_batch`'s unfiltered `card_variant_id`-grouped aggregate (full-index-scan either
way, confirmed via EXPLAIN — no plan-shape regression), and `thin_price_snapshots`'/the M91
retention window's own `partition by (card_variant_id, provider) order by snapshot_date desc`
(the SAME grouping the new index leads with — a speedup, not a regression).

**Financial invariants preserved, unchanged by this migration:** unknown market value stays NULL
(the index changes access path only, not `resolve_variant_market_values`'s logic); FX remains
as-of the snapshot date; the EU/TCGplayer provider preference and the raw-only exclusion of graded
holdings are untouched; manual valuation composition still happens at the caller.

**Real measurement, not asserted:** see the output_108 handoff for the actual before/after EXPLAIN
plan shapes and the M12 snapshots-benchmark before/after timing this decision is based on.

## D-121 — `create_purchase` gains an optional, DB-required-once-present idempotency key (P108, renumbered P111; notes semantics corrected — see D-122)

**2026-09-05 · Accepted**

**Context.** P107 §17 found `create_purchase` was the only one of the four money-writing forms
with no idempotency protection at all — a dropped response after the server has already committed
has no mechanism preventing a resubmit from creating a second purchase, second holdings, and second
acquisition lots.

**Decision — the contract, not just the mechanism.** `create_purchase` gains
`p_idempotency_key uuid default null` (a new parameter — TESTING.md §6a: this is DROP+CREATE, not
CREATE OR REPLACE, since it changes the function's identity; every M10/M11 fix already in the body
— residual_nok_minor, the sealed-product RLS existence check, per-line sealed_intent on the LOT,
manual_value_minor for a sealed holding, the graded-card condition-null override — is preserved
unchanged). Unlike `create_sale`'s key (required, no payload comparison at all) or
`create_opening_from_provisional`'s key (required, named-field comparison), this key is:

- **Optional at the database layer.** Dozens of existing `tests/db/**` call sites invoke
  `create_purchase` with no key; forcing all of them to adopt one is disproportionate churn for a
  purchase-specific reliability fix (CLAUDE.md: smallest complete solution, do not expand scope
  as a side effect). A caller that omits the key gets exactly the pre-P108 behaviour.
- **Required in practice at the product boundary.** `src/data/purchases.ts`'s `createPurchase` and
  `PurchaseFormPage` always generate and send one (`useState(() => crypto.randomUUID())`, one key
  per mount, resent unchanged across a retry, never regenerated merely because an error was shown —
  the same lifecycle `SaleFormPage`'s own key already follows). Purchases structurally cannot suffer
  `SaleFormPage`'s own P107-disclosed entity-switch leak (§5 of output_107): `/purchases/new` carries
  no dynamic route param a same-tab navigation could silently swap under an unchanged component
  instance, so a fresh key per genuine new-purchase visit falls out of ordinary React unmount/remount
  rather than needing a `resetKey` mechanism of its own.
- **Compares the FULL material request, not a named subset.** The exact jsonb the client submitted
  (purchase-level fields plus every line, minus each line's `lot_notes`) is stored verbatim as
  `idempotency_request` and compared via jsonb equality (`IS DISTINCT FROM`) on replay — deliberately
  over-strict rather than under-strict: a genuine retry resends byte-identical values regardless of
  JSON key order (jsonb equality is structural, not textual), so this never rejects a real retry, and
  it never accidentally treats a financially different resubmission as a safe replay merely because
  the comparison forgot a field. `p_notes` and each line's `lot_notes` are the only fields excluded
  (cosmetic annotations, per the prompt's own "do not compare irrelevant operational metadata").
- **Race-safe, not just sequentially safe.** Mirrors P94's `add_card_acquisition` fix exactly: all
  mutations sit inside one outer `BEGIN/EXCEPTION WHEN unique_violation` block keyed on the new
  partial unique index `purchases_user_idempotency_key_idx (user_id, idempotency_key) WHERE
  idempotency_key IS NOT NULL`; a losing concurrent transaction's implicit savepoint rolls back its
  purchase/lines/holdings/lots, and the handler re-reads the winner's row under the SAME
  material-equivalence check the early path uses — a race between two genuinely different requests
  sharing a key is still refused, not silently merged.

**Verified:** `tests/db/m8_purchase_ledger.test.ts`'s new idempotency describe block — exact
sequential replay (no duplicate rows), a non-material (notes-only) edit still replays, five
distinct material-mismatch cases (quantity, unit price, card identity, purchase date, currency/FX)
each refused with `idempotency-key-reuse`, a real concurrent `Promise.all` double-submit committing
exactly one purchase/one line/one lot, and the no-key path behaving exactly as before (two calls,
two purchases).

---

## D-122 — `create_purchase` idempotent replay now preserves an edited `p_notes`, correcting D-121's "operational metadata" framing (P111)

**2026-09-05 · Accepted**

**Problem, found during P111's independent audit of D-121's own contract (prompt's own §9), not
discovered by a test.** D-121 (P108, originally its own D-117) excluded `p_notes` from
`create_purchase`'s idempotency material-equivalence check, calling it "cosmetic annotation" and
"operational metadata." Notes are neither: they are free text the USER typed, visible on every
purchase detail view (`src/features/collection/HoldingDetailPage.tsx` and equivalent), no different
in kind from a sale's or opening's own notes field. Under D-121's original body, the realistic
failure case the prompt asked P111 to trace through: a purchase commits, the response is lost
(network drop, tab suspended), the user sees no confirmation, edits the notes field to correct or
add detail, and resubmits — the SAME idempotency key is sent (never regenerated merely because an
error was shown, D-121's own documented lifecycle). The original body would silently return the
FIRST commit's row, discarding the user's edit with no error, no warning, and no visible sign
anything was lost. That is a silent-data-loss bug, not a cosmetic non-issue — CLAUDE.md's "Honesty
in the product" bar exists exactly for cases like this.

**Decision.** `p_notes` stays OUT of the material-equivalence comparison (a notes-only edit is
still the same logical purchase attempt and must still replay rather than being refused as
`idempotency-key-reuse` — rejecting it would be worse UX for no financial-safety benefit, since
notes carry no monetary weight). Instead, both replay paths (the early sequential check and the
concurrent-race exception handler) now UPDATE the existing row's `notes` to the caller's latest
`p_notes` whenever it differs, before returning it. The financial rows this call produced
originally — the purchase's totals, its lines, the holdings and acquisition lots — are still
returned completely unchanged by a replay; only the free-text annotation can move. Notes are
treated as separately mutable metadata riding alongside an idempotent financial write, not as
immutable transaction history.

**Explicitly NOT covered by this correction:** each line's `lot_notes` remains excluded from both
the equivalence check and this update-on-replay behaviour. Matching a specific submitted line back
to the specific `acquisition_lots` row it already produced, on a replay path that never re-runs the
per-line insert loop, needs a stable line-ordering guarantee `purchase_lines` does not currently
provide (no explicit sequence column) — building one is out of scope for this correction
(CLAUDE.md: smallest complete solution, do not expand scope as a side effect). Tracked in
docs/BACKLOG.md if a real product need for it ever surfaces.

**Migration discipline.** D-121's migration (`20260905120010_p108_purchase_idempotency.sql`) is
already a committed source artifact and is NOT edited — per CLAUDE.md, an applied/published
migration is never rewritten for convenience. This decision ships as a new forward migration,
`20260905130000_p111_purchase_notes_replay_semantics.sql`, a `CREATE OR REPLACE` of the same
12-parameter function (the parameter list is unchanged, so this is not the DROP+CREATE identity
change D-121 itself required over its own predecessor).

**Verified:** `tests/db/m8_purchase_ledger.test.ts`'s idempotency block extended — a notes-only
resubmit with the same key replays (no duplicate purchase) AND the returned/stored row reflects the
NEW notes, not the original; every other material-mismatch case (quantity, unit price, card
identity, purchase date, currency/FX) still refused unchanged; the concurrent-race path's own
notes-preservation exercised via the existing `Promise.all` double-submit test, asserting the
loser's notes (if different) win on the winner's row.

---

## D-123 — Fixed a real self-contradiction in P110's 404-resume design: a permanently-failed card could never actually recover (P111)

**2026-09-05 · Accepted**

**Found by tracing actual code, not by a failing test.** P110's own report (D-119's neighbor,
`docs/DECISIONS.md`'s P110 addendum to checkpoint-identity.ts) claimed a `permanentFailures` entry
"is cleared the moment its pristine fetch succeeds" — true of the success-path code itself, but
`build-index.ts`'s resume loop skipped ANY card already present in `checkpoint.permanentFailures`
unconditionally, before that fetch could ever run again. The two claims cannot both be true: a card
that 404s once could never reach the success path that clears it, on any future resume, ever. An
image temporarily missing at build time (then later uploaded) would stay permanently unindexed
until the owner manually deleted the entire multi-hour checkpoint file — exactly the failure mode
the prompt asked this session to prove or disprove, not accept on the strength of the prior
write-up's own description.

**Fix.** `src/domain/scanner/checkpoint-identity.ts` gains `shouldSkipPermanentFailure(record, now)`
— a pure, independently unit-tested function — and `PERMANENT_FAILURE_REPROBE_MS` (24 hours): a
permanent-failure record is skipped only while it is still within that window of its `failedAt`;
once stale, `build-index.ts`'s resume loop gives the card exactly one fresh probe. A repeat 404
just refreshes `failedAt` (renewing the quiet window, so a genuinely-dead reference image is still
never hammered); a success clears the entry exactly as the original design intended. Chosen over
the two other options the prompt offered: "re-probe once on a later resume/new run" is what this
implements in substance; a distributed job system was explicitly out of scope and unnecessary for
a single-machine, single-operator index-build tool.

**Why 24 hours, not shorter/longer.** Short enough that the next day's resume (or the next
scheduled hosted rebuild — index builds are not a multiple-times-per-day operation) always gets a
fresh probe. Long enough that iterating on the SAME build session — several resumes while
debugging an unrelated crash, all within hours — never re-requests a card that is genuinely still
404ing, preserving §7's original "do not hammer a stable 404" guarantee.

**Verified:** `tests/domain/scanner/checkpoint-identity.test.ts`'s new
`shouldSkipPermanentFailure` describe block — fresh failure skipped, TTL-boundary and past-TTL
cases re-probed, and a hand-edited/foreign checkpoint's unparseable `failedAt` fails safe toward
re-probing rather than permanent skip. Not re-proven against a real hosted 19k-card marathon run in
P111 (prompt §17/§37 — no real hosted index build in this session); the fix is verified at the
pure-function level the resume loop's own skip condition now calls directly.

## D-124 — Matcher tie-break comparator now fails closed on a poisoned/non-finite visual similarity (P113)

**2026-09-06 · Accepted**

**Found by adversarial fuzz testing, not a failing hand-picked case.** P113 (a chaos/fault-
injection hardening pass over the M15 scanner, run in isolation from P112's hosted work) built a
new property-based fuzz suite (`tests/domain/scanner/engine-adversarial-fuzz.test.ts`, `fast-check`)
feeding `rankScannerCandidates` thousands of random evidence matrices, including deliberately
adversarial visual-similarity values (NaN, ±Infinity, out-of-range doubles) a corrupted worker
message, a serialization bug, or a future refactor could hand the matcher — exactly the shape the
matcher's OWN existing code already defends against in `visual-evidence.ts`'s
`visualEvidencePoints`/`visualEvidenceTier` (explicit `!Number.isFinite` fail-closed guards).

`engine.ts`'s `rankScannerCandidatesFull` final sort had ONE place that same discipline was missed:
its tie-break comparator normalized a candidate's raw diagnostic `visualSimilarity` with
`?? -Infinity`, which only replaces `null`/`undefined` — a poisoned `NaN` is a real `number` by
`typeof`, so it passed through unguarded. `bSim - aSim` then evaluated to `NaN` (since
`NaN !== anything` is always true, the `if (bSim !== aSim)` branch always fires for a poisoned
candidate), handing `Array.prototype.sort` a comparator result with implementation-defined
ordering — silently breaking this function's own documented "deterministic ordering" guarantee for
every candidate TIED with the poisoned one on `rawRankScore`, whenever any single candidate in the
result carried corrupted visual evidence. The SCORE itself was never affected (already proven
finite by the same fuzz suite) — only which of several tied candidates sorts first/last became
non-deterministic.

**Severity:** real but narrow. It requires (a) a poisoned/corrupted similarity value reaching the
matcher at all — `visual-client.ts`/`visual-worker.ts` never produce one in the shipped path today
— AND (b) at least one other candidate genuinely tied on `rawRankScore`. Not reachable through any
existing shipped code path; caught only by fuzzing the matcher's own public contract directly with
adversarial input, which is exactly what a defense-in-depth boundary function should be robust
against regardless of whether today's callers happen to avoid it.

**Fix.** A new `finiteSimilarityOrFloor(value: number | null): number` helper (`engine.ts`) —
`typeof value === 'number' && Number.isFinite(value) ? value : -Infinity` — replaces the bare
`?? -Infinity` at both sides of the tie-break comparison. `typeof value === 'number'` narrows away
`null` before `Number.isFinite` runs, so no non-null assertion is needed (this repository's ESLint
config forbids `@typescript-eslint/no-non-null-assertion`). Matches the exact fail-closed contract
`visual-evidence.ts` already documents for the identical input shape — one rule, applied
consistently everywhere a similarity value crosses a decision boundary.

**Verified:** the adversarial fuzz suite (20,000 runs for the finite/deterministic-ordering
properties, 5,000 for the poisoned-vs-clean-evidence equivalence and zero-evidence-never-HIGH
properties, 2,000 for the empty-map property) passes cleanly after the fix; failed with this exact
counterexample before it (`{"...":"...", nameOcrConfidence:NaN}, Map([["fuzz-0", NaN]])` — the
first shrunk failure fast-check found). Full existing `engine`/`engine-p93-redesign`/`engine-
visual-dominance` suites (290 tests total in `tests/domain/scanner/`) re-run green after the fix —
no behavioral change to any non-adversarial, already-tested case. `pnpm test` 1385/1385,
typecheck/lint (0 errors)/format clean.

## D-125 — `allocate_largest_remainder` fixed a bigint*bigint overflow that violated F6 within its own declared domain (P117)

**2026-09-11 · Accepted**

**Found by adversarial money-boundary testing, then traced to an exact cause.** The function's
signature (`p_total bigint, p_weights bigint[]`) claims to support the full bigint domain for both
arguments, and FINANCIAL_MODEL.md §4.2/invariant F6 requires shares to sum exactly to the total
"for any input." The original body computed `p_total * v_effective[i]` in plain bigint arithmetic
before dividing by the weight sum; once that intermediate product exceeded bigint's ~9.22e18
ceiling, Postgres raised `bigint out of range` — even though `p_total`, every individual weight and
the eventual per-line share are all comfortably inside bigint's range. Reproduced directly: a
single-line EUR purchase with `unit_price_minor = 2_147_483_647` (2^31-1) and a manual FX rate of
11.54 computes `total_nok_minor = 24_781_961_286`, and `create_purchase` calls
`allocate_largest_remainder(24_781_961_286, ARRAY[2_147_483_647])` to attribute that NOK total back
to the purchase's one line — the product of those two operands (~5.3e19) overflows bigint. The
equivalent NOK-only purchase (no FX multiplier) only hits the same overflow once `unit_price_minor`
exceeds roughly sqrt(bigint max) ≈ 3.03e9, which is why the failure threshold looked
currency-dependent when a prior session (P115, `BIGINT_CHROMIUM` note in `output_115.txt`) first
brushed against it while seeding a boundary-value fixture and disclosed it as unpursued, out of
scope for that session.

**Severity:** real, but requires a single purchase line's minor-unit amount (or its NOK-converted
total) to exceed roughly two billion — many orders of magnitude past any plausible collectible
purchase. No realistic user data could ever trigger it. Fixed anyway because the function's own
type signature and F6 both promise correctness across the full bigint domain, and a general-purpose
allocator silently failing partway through its declared input range is exactly the kind of
"unrealistic input, still worth being right about" finding this hardening pass exists to catch — see
also the two immediately adjacent, deliberately NOT-fixed findings below.

**Fix.** New forward-only migration
`20260911120000_p117_allocate_largest_remainder_overflow_fix.sql`, `CREATE OR REPLACE` (signature
unchanged, so existing grants survive): the multiplication and division are now done in `numeric`
(arbitrary precision) before casting back to `bigint`, `floor()` standing in for bigint integer
division (both operands are always non-negative here, so floor and truncate agree) and numeric's
`%` operator giving the same exact remainder integer division would. No behavior changes for any
input that already succeeded — the fix only widens the domain the function can actually honor to
match what its `bigint` signature already promised. The original migration
(`20260824120010_m8_purchase_ledger.sql`) is untouched, per this project's own migration discipline.

**Two adjacent findings, deliberately NOT fixed — different, unrelated limitations:**

1. PostgREST serializes a `bigint`/`bigint[]` column or return value as a plain JSON *number*, not
   a string. Any such value at or above 2^53 silently loses precision the moment a JS client (this
   project's own frontend, or a test) runs the response through ordinary `JSON.parse` — a real
   "hidden JS Number conversion," but only reachable at magnitudes (single-digit quadrillions+ of
   minor units) FINANCIAL_MODEL.md's domain never approaches. Fixing it would mean re-typing every
   bigint-returning RPC response app-wide for no reachable benefit; not done.
2. Once the NOK-converted total of a foreign-currency purchase itself would exceed bigint's actual
   ~9.22e18 ceiling (roughly 92 quadrillion NOK for an 11.54 EUR/NOK rate), `create_purchase`
   correctly still rejects with `bigint out of range` — the real, correct ceiling of the
   `total_nok_minor bigint` column, not a bug. Confirmed by testing one order of magnitude beyond
   the fixed overflow and observing the SAME error re-appear at that much larger, genuinely
   unrepresentable value.

**Verified:** `tests/db/m8_purchase_ledger.test.ts`'s new "no bigint*bigint overflow at scale"
block (the SQL/TypeScript parity suite extended with three large-input cases whose individual
result shares all stay under 2^53, so the assertions themselves are never confounded by finding 1
above) and a new end-to-end `create_purchase` regression reproducing the exact EUR scenario. Full
`pnpm test:db` (614/615, unchanged), M13 adversarial (55/62 + 7 opt-in skipped, unchanged) and
`tests/m16-independent` (53/53, unchanged) all re-run green after the migration.

## D-126 — `VisualRecognitionClient.dispose()`/worker-crash now settle in-flight requests instead of abandoning them (P116)

**2026-09-11 · Accepted**

**Found by a targeted leak/cleanup code audit** (P116 Phase Q), and independently rediscovered
mid-session by this branch's own carried-forward visual-worker-lifecycle-soak test, which had
already documented the same defect as a known, explicitly-unfixed finding
(`tests/ui/scanner-visual-client-lifecycle-soak-p116.test.ts`'s original "finding:" describe block,
proven by racing the hung promise against a timer rather than asserting the desired outcome).

`analyze()` and `getExpectedCardRank()` (`visual-client.ts`) store their settle callbacks in
`this.pending`/`this.pendingRankRequests` and return a promise that only those callbacks can
settle. `dispose()` called `pending.clear()`/`pendingRankRequests.clear()` directly, without ever
invoking a single stored callback. A route exit, account switch, or retake that disposed the
client while a request was still in flight — or a genuine worker crash arriving AFTER `ready` had
already resolved, which made the existing `worker.addEventListener('error', ...)` handler's
`resolve(null)` on the (already-settled) ready promise a no-op — left that request's promise, and
`controller.ts`'s `Promise.all` awaiting it inside `analyzeCapture()`, pending forever. This is the
identical bug shape `ocr-engine.ts` had already found and fixed for OCR (`ScannerEngineDisposedError`,
its own doc comment naming exactly this hazard); `visual-client.ts` never received the equivalent
fix when that class was written.

**Severity:** real and directly reachable through normal UI use — no adversarial input required,
just an in-flight scan interrupted by navigation, an account switch, or a hardware/driver crash.
The `Promise.all` shape in `controller.ts` means one stuck visual request could stall the whole
`analyzeCapture()` call, not just the visual channel.

**Fix.** `dispose()` now rejects every stored `{ resolve, reject }` in `pending` with a new
`VisualClientDisposedError` (caught by `analyze()`'s own existing try/catch, surfacing as its
already-documented `null` "visual channel unavailable" result — no caller-visible contract change)
and resolves every stored `pendingRankRequests` callback with a fixed "not in index"
`ExpectedCardRank` (matching that method's own "never rejects" contract), BEFORE clearing either
map. The `worker.addEventListener('error', ...)` handler does the same before its
already-existing `resolve(null)` on the ready promise, closing the post-ready-crash case the
dispose-only fix would have missed. A related leak in the same `dispose()` path was fixed
alongside it: `controller.ts`'s staggered visual-prewarm `setTimeout`
(`ENHANCED_VISUAL_PREWARM_STAGGER_MS`) was never cancelled, so disposing within that window let the
timer later fire on a controller nothing referenced any more and construct a brand-new,
never-terminated visual `Worker` that silently downloaded the full model/index in the background.

**Verified:** `tests/ui/scanner-visual-client.test.ts`'s new "P116 Phase Q" describe block —
confirmed the exact hang reproduces on the pre-fix code (`git stash` the fix, re-run: genuine
5-second test timeout, not a flake), then that dispose()-mid-flight, worker-crash-mid-flight, and
dispose()-mid-rank-lookup all resolve promptly post-fix, and that a fresh `analyze()` call after
dispose() still works normally (no cross-generation contamination from the settled maps). The
carried-forward lifecycle-soak test's "finding" block now asserts the corrected behavior directly
instead of racing a timer. Full suite re-run green: `pnpm test` 1480/1481 (1 pre-existing skip),
typecheck/lint (0 errors)/format clean.

## D-127 — `allocate_largest_remainder` gets two more independent bigint-domain fixes: an unbounded weight-sum, and a numeric-division precision bug D-125 did not touch (P120)

> Renumbered from D-126 by P123 (2026-09-12): D-126 was already taken by
> `docs/DECISIONS.md` on `fix/p119-scanner-browser-chaos-phase3` (PR #100,
> opened 2026-09-11T21:59:54Z) for the `VisualRecognitionClient.dispose()`/worker-crash decision
> (P116) — that PR predates this one (PR #101, opened 2026-09-12T00:40:22Z), so the scanner ID is
> preserved and this financial decision moves to the next globally-free ID, D-127. See
> `docs/DECISIONS.md`'s note under D-125 and HANDOVER.md for the collision record.

**2026-09-11 · Accepted**

P120 built the large-scale property campaign D-125 (P117) disclosed as not yet done: 100,000+
randomly generated `(total, weights)` cases compared against an independent BigInt reference
(`src/domain/allocation.ts`'s `allocate()` — a from-scratch TypeScript port of the documented
largest-remainder-method contract, not a copy of the plpgsql source; its native BigInt arithmetic
has no intermediate-overflow path to share a bug with) via one batched SQL statement per run rather
than one RPC call per case, making 100,000 cases a ~10-second local run instead of the ~30-80
minutes per-case HTTP round trips would take. Two distinct real bugs surfaced, neither reachable by
D-125's own boundary probe (which tested specific values on `create_purchase`, not this function's
full declared domain directly):

1. **Weight-sum overflow.** `v_sum_weights := v_sum_weights + p_weights[i]` was still plain bigint
   arithmetic after D-125 — summing multiple near-bigint-max weights overflows even though D-125
   already widened the multiplication step. Reproduced directly:
   `allocate_largest_remainder(100, ARRAY[9223372036854775807, 9223372036854775807])` raised
   `bigint out of range`. **Reachable through the public RPC surface**: `create_purchase` places no
   upper bound on a line's `unit_price_minor` before it becomes a shipping/customs/discount
   allocation weight, so two extreme-but-otherwise-ordinary purchase lines would crash with this
   opaque error instead of a clean rejection (no data corruption either way — the transaction still
   aborts atomically). Fixed: `v_sum_weights` (and `v_effective_sum`) become `numeric`.
2. **Numeric-division precision (the more serious one).** Postgres's `numeric` `/` operator does
   NOT always return the mathematically exact quotient for large operands — it rounds to a computed
   display scale — so `floor(a::numeric / b::numeric)` was floor-ing an already-wrong, rounded-up
   value. Reproduced directly:
   `(219581130708100988383099213597811148::numeric / 1215407149863084914::numeric)` returns
   `180664669228609283`, while `div(...)` (Postgres's exact truncating integer division for
   numeric) returns the correct `180664669228609282`, confirmed against the independent BigInt
   oracle. This was present in D-125's own fix from the start, not introduced by fix 1 above — the
   property sweep is what finally exercised operands large enough to expose it. Consequence: not
   just a misallocated line, but **invariant F6 itself broke** in 17 of an initial 5,000-case run
   (`sum(shares) <> total`) — large enough rounding drift pushed the sum of floors past the true
   total, making the "distribute the remaining units" step run backward. Fixed: `div()` replaces
   `/` + `floor()`; `v_remainders` becomes `numeric[]` (a remainder is bounded by the — now
   unbounded — weight sum, not by `total`, so it needed the same widening fix 1 gave the sum
   itself; it is only ever used to rank lines for the tie-break, never returned to the caller).
   `v_floors` stays `bigint[]`: `floor(total*w_i/sum) <= total` always, and `total` is
   bigint-bounded by the function's own signature, so that direction was never at risk.

Both fixes land in one migration (`20260911130000_p120_allocate_largest_remainder_weight_sum_
overflow_fix.sql`), `CREATE OR REPLACE` — the signature is unchanged, so every caller
(`allocate_largest_remainder_signed`, `create_purchase`, `create_sale`) picks up both fixes with no
call-site change. No behavior change for any input that previously computed a correct result.

**Verified:** two new regression cases in `tests/db/m8_purchase_ledger.test.ts` reproducing each
bug exactly against the live database; the 100,000-case property campaign re-run twice (different
seeds, 200,000 cases total) at zero mismatches / zero `wrong_sum` / zero function errors / zero
negative shares after the fix, versus 486 mismatches, 17 `wrong_sum` violations and 1,049 function
errors in the first 5,000-case run before it. Full `pnpm test:db` (618/619, unchanged), M13
adversarial (55/62 + 7 opt-in skipped, unchanged) and `tests/m16-independent` (53/53, unchanged)
all re-run green after the migration.

---

## D-128 — Camera session ownership and track-`ended` handling must never depend on `HTMLMediaElement.play()` Promise settlement (P126)

**2026-09-12 · Accepted**

**Found by** root-causing the two mobile-iphone (WebKit)-only Browser E2E failures P125 left
unresolved after three rounds of blind timeout widening (5s→30s and 15s→45s), using the
`playwright-report` trace artifact from the failing CI run (34705811971) rather than guessing
again. Both failures were the same defect: `openEnvironmentCamera()` (`camera-session.ts`)
constructed the `ManagedCameraSession`, defined `onTrackEnded`, attached every track's `ended`
listener, and set `activeScannerSession` only AFTER `await video.play()` resolved. On GitHub
Actions' Linux-hosted WebKit against Playwright's mocked `canvas.captureStream()` source, that
Promise could render live preview frames while never settling — not slowly, genuinely never. No
timeout, however large, could have fixed a Promise that never settles. Two independent, real
symptoms followed directly: the shutter (`disabled={state.step !== 'camera'}` in
`ScannerPage.tsx`) stayed disabled forever, because `CAMERA_STARTED` only dispatches once the
promise this function returns resolves; and a hardware disconnect mid-session went unnoticed,
because the `ended` listener that would have called `onEnded` was never attached in the first
place. P125's own writeup wrongly attributed the first symptom to slow on-device DINOv2/OCR
inference — traced and disproven here: the shutter's `disabled` state is set before capture and
before `analyzeCapture()` ever runs; the corrected diagnosis is documented directly in the two
affected E2E test files, replacing the incorrect one.

**Decision.** `video.play()` is now initiated but never awaited inside `openEnvironmentCamera()`.
Stream ownership (`video.srcObject`, the `ManagedCameraSession` object, its `stop()` closure, the
`ended` listeners, `activeScannerSession`) is established immediately once the stream is acquired
and this call has won any open-generation race — strictly BEFORE playback is even requested. A
rejected `play()` Promise remains non-fatal (unchanged from before); a synchronously-thrown
`play()` is now equally non-fatal (`try`/`catch` around the call); and a `play()` that never
settles at all no longer blocks anything, because nothing downstream of it depends on its
resolution.

This deliberately decouples THREE previously-conflated events (prompt's own §12): stream
ownership, playback initiation, and usable pixels being available. The first real GitHub Actions
run against this fix (34721557413) proved that decoupling had a real second-order consequence:
`CAMERA_STARTED` (and therefore the shutter's `disabled` state) now flips the instant ownership is
established, which on mobile-iphone (WebKit) can genuinely be BEFORE the video element has decoded
its first frame — `captureVideoFrame()`'s existing `videoWidth === 0`/`videoHeight === 0` guard
caught this honestly (`Capture failed. The photo could not be captured. Try again.`) rather than
producing a black photo, but a shutter a real user can tap and immediately have refused is still a
regression, not an acceptable one. `ScannerPage.tsx` therefore gates the shutter on a SECOND,
separate boolean, `previewFrameReady` — plain local UI state, not folded into the reducer — set by
the video element's own `loadeddata` event (fired once real frame data exists, independent of
whether `play()`'s Promise ever settles). Session/hardware-disconnect readiness and
preview-pixel readiness are two genuinely different questions with two genuinely different
answers; keeping them as two small, separately-owned booleans (an internal generation counter in
`camera-session.ts`; one `useState` in `ScannerPage.tsx`) is the narrowest fix for each, rather
than force-fitting both through one signal that was never right for either.

**Alternatives considered.** Racing `play()` against a bounded timeout
(`Promise.race([video.play(), sleep(N)])`) was rejected outright — it converts an infinite hang
into a long, arbitrary one and still delays session ownership (and the `ended` listener) for no
reason tied to actual readiness. Trusting `captureVideoFrame()`'s existing `videoWidth`/
`videoHeight` guard alone (this decision's own first draft) was tried and disproven by real CI
within the same session: it turns an unready tap into a correctly-labelled but still user-visible
failure instead of preventing it, which is strictly worse than gating the button in the first
place once a cheap, real readiness signal (`loadeddata`) exists.

**Consequences.** Ownership and hardware-disconnect recovery are now provably independent of
whatever a given browser engine's autoplay implementation does — this is the durable rule future
scanner lifecycle changes must preserve: `HTMLMediaElement.play()`'s Promise is a playback-start
signal only, never a readiness gate for anything else, and NEITHER is `state.step === 'camera'`
alone a proof of usable pixels — that is `previewFrameReady`'s job specifically. The two
previously-inflated E2E timeouts this decision makes obsolete (45s shutter-enable, 30s
hardware-disconnect recovery) are reduced back to 15s/10s respectively — see the corrected
comments in `tests/e2e/scanner-camera-route-visibility-soak.spec.ts` and
`tests/e2e/scanner-camera-permission-matrix.spec.ts`. `ScannerState` gained one field
(`previewFrameReady`) and one action (`PREVIEW_FRAME_READY`); every existing transition into
`starting-camera` was reviewed and updated to reset it, so a future new entry point into that step
that forgets the reset is the one thing worth checking first if this regresses again.

**Verified:** a never-settling `play()` reproduced the exact hang against the pre-fix code (`tests
/ui/scanner-camera.test.ts`'s new "P126" describe block — 6 new cases, each timing out at 3s under
the OLD implementation via a temporary mutation, all passing promptly post-fix): resolution is no
longer blocked, the `ended` listener still fires exactly once and stops every track, `stop()`
during a still-pending `play()` detaches cleanly with no later resurrection, a synchronous
`play()` throw is non-fatal, and a superseded call's own pending `play()` settling late (resolve
or reject) never disturbs whichever session actually won. New reducer cases in
`tests/ui/scanner-state.test.ts` pin `previewFrameReady`'s own contract: false until
`PREVIEW_FRAME_READY`, settable in either order relative to `CAMERA_STARTED`, and reset to false
by every fresh-acquisition transition (`START_CAMERA_PRESSED`/`RETAKE_PRESSED`/
`SCAN_NEXT_PRESSED`) even after a previous session had already reached ready.

This decision went through two real rounds against actual GitHub Actions CI, not one — the first
push (removing the `await video.play()` block alone) fixed both ORIGINAL P125 failures on
mobile-iphone but immediately exposed a second, narrower race in the very next CI run
(34721557413): the shutter could now enable and be tapped before the video element had decoded
ANY frame, which `captureVideoFrame()`'s existing `videoWidth`/`videoHeight` guard caught
correctly but only as a user-visible "Capture failed. The photo could not be captured. Try again."
— confirmed via that run's own `playwright-report` trace, not guessed. The `previewFrameReady`
mechanism above closes that second race. Full local gate re-run green after both rounds:
typecheck/lint (0 errors)/format clean, `pnpm test` up to 1509/1512 (1508/1509 after round one,
+3 reducer cases in round two; 2 unrelated pre-existing failures in `tests/ui/opening-draft.test.ts`
were observed and diagnosed as a genuine local/UTC date-boundary mismatch in that file's OWN test
helper — nothing to do with this branch's camera code, not touched here), production build green
throughout (scanner index unchanged, `f25fc05d569b7cca`). Both previously-failing E2E cases plus
the full non-auth desktop-chromium suite pass locally after each round, including the previously
serial-blocked 1000-cycle visibility soak actually running to completion; the authoritative
mobile-iphone (WebKit) result is GitHub Actions CI — see this branch's final CI run for the
confirmed outcome.

---

## D-129 — A purchase line's live sibling lots (a sealed-intent split) share an edit's attributable cost by quantity-weighted exact allocation; a quantity change across siblings is refused, not guessed (P132-A / P130-01)

**2026-09-14 · Accepted**

**Context.** `set_sealed_lot_intent`'s partial split (D-051's neighbour, 20260829120000) can leave
more than one live `acquisition_lots` row on a single `purchase_lines` row — one physical lot per
sealed_intent the owner has split the quantity into. `update_purchase` was never designed for
this: it read one arbitrary live lot per line (no STRICT, no loop) and overwrote it with the
WHOLE line's new quantity and basis, leaving the other siblings' quantity and basis exactly as
they were before the edit. An independent post-release audit (P130, `output_130.txt`, finding
P130-01) reproduced this: 5 sealed units split 2/3, then an ordinary unit-price correction,
produced 8 live units summing to 90000 øre against a real line quantity of 5 and attributable
60000 øre — three phantom, sellable units and an inflated Portfolio value. A follow-up safety
session (P131) ran the read-only diagnostic this decision's fix ships with
(`scripts/finance-integrity-diagnostics.sql`) against the hosted project before any code changed:
zero purchase lines currently hold more than one live lot, so no hosted data repair was required
before implementing this fix (`output_131.txt` §4).

**Decision.** `update_purchase` now handles every live lot of a line, not one arbitrary row:
  - **Quantity unchanged, N ≥ 1 live siblings.** Every sibling's own quantity is left exactly as
    it is. The line's (possibly changed) attributable cost — in both the purchase currency and
    NOK — is redistributed across the UNCHANGED sibling quantities using
    `allocate_largest_remainder` (the same allocator FINANCIAL_MODEL.md §4.2/invariant F6 already
    proves exact for any input), weighted by each sibling's own quantity. Each sibling's own share
    is then split into `unit_cost_basis_minor` + `residual_minor` by the identical floor+residual
    rule §4.3 already uses for a single lot. Because F6 guarantees `Σ shares = total` and each
    sibling's floor+residual split exactly reconstructs its own share, `Σ live sibling lot basis =
    purchase_line attributable basis` holds exactly, in both currencies, for any number of
    siblings. `sealed_intent` and `purchase_line_id` are never touched by this path.
  - **Quantity changed, exactly one live lot.** Unchanged from the pre-existing behaviour — the
    only case that existed before this decision, and the overwhelming majority of real lines.
  - **Quantity changed, more than one live sibling.** Refused outright, before anything is
    written, naming the reason (`multi-lot-quantity-ambiguous`, matching this codebase's existing
    `idempotency-key-reuse` naming convention for a caller/test-recognisable domain error). A
    split lot's existence is the owner's own record of a real difference between those units
    (different sealed_intent); nothing in the edit request says which pile a quantity change is
    meant to add to or take from, and guessing would silently misattribute units between two
    organisationally distinct groups. The documented recourse is D-047's existing one for "this
    purchase can no longer represent what happened": void it and record a new one.
  - A lot whose `cost_basis_state` is not `'known'` has its basis columns left untouched entirely
    (FINANCIAL_MODEL.md §1.1's "never fabricate a number" rule) rather than fabricating a share
    for it; the pre-existing code would have hit `acquisition_lots_cost_basis_state_consistency`'s
    CHECK constraint outright if this case had ever been exercised in practice, an unreachable
    combination now handled by omission instead of a raw constraint failure.
  - `update_purchase`'s own P130-03 locking slice is fixed in the same migration, since the
    multi-lot rewrite above is only safe under it: every live lot on the whole purchase is locked
    `SELECT ... FOR UPDATE` in ascending id order — the identical global-ascending-order
    convention `create_sale` and `reduce_holding_quantity` already use, so this function can never
    deadlock against either — BEFORE the "no partially disposed lot" blocker is (re-)checked and
    before anything is written. A concurrent `create_sale` that locks first is safely observed
    (the edit then refuses, citing the live disposal); one that locks second safely observes the
    committed edit instead of a stale basis. Proven with a held-lock two-session harness in both
    orderings (`tests/db/p132a_multilot_purchase_integrity.test.ts`).

**Alternatives.** *Refuse the edit outright whenever a line has more than one live lot* (the
"smallest safe fix" P130 itself suggested) — rejected as unnecessarily punitive: a metadata-only
correction (retailer, notes, a price fix that leaves quantity alone) is both the common case and
completely unambiguous once quantity is held fixed, and refusing it would push owners toward
void-and-re-enter for corrections that carry no real ambiguity. *Collapse the siblings back into
one lot on edit* — rejected outright per the launch prompt and DATA_MODEL.md's own treatment of a
split as organisationally meaningful, not a formatting detail to discard on the next unrelated
edit. *Silently pick an allocation rule for a quantity change across siblings (e.g. always grow/
shrink the largest sibling)* — rejected: any such rule invents provenance the system does not
have, exactly the class of fabrication FINANCIAL_MODEL.md's core quality bar forbids elsewhere
(missing cost is never `0`; the same principle extends to "which pile these units belong to" not
being knowable from a bare quantity change).

**Consequences.** An ordinary, never-split purchase line (near-total majority of real receipts) is
completely unaffected — same shape, same behaviour as before this decision. A split line's owner
who wants to change its total quantity gets a clear, actionable refusal instead of either silent
corruption or an opaque Postgres constraint error, and must void-and-re-enter (an existing,
already-documented correction path, D-047) for that one case. P131's read-only
`scripts/finance-integrity-diagnostics.sql` already counts exactly this invariant
(`multi_live_lot_lines`, `lot_quantity_mismatch_lines`, `lot_basis_mismatch_lines`) and confirmed
zero affected hosted rows before this fix was written (`output_131.txt` §4); re-running it after
this migration deploys is the intended way to re-verify the invariant against hosted data going
forward.

## D-130 — Removed sibling lots stay removed through a purchase edit; a line with removed or no live lots cannot change quantity (P132)

**2026-09-14 · Accepted**

**Context.** D-129 covered a purchase line with several *live* lots. An independent regression
package written without reading the implementation (P132-C) found two further states the first
integrated candidate mishandled. (1) A split line one of whose siblings was removed from inventory
(`void_acquisition_lot` / `remove_holdings_from_portfolio`, purchase kept live by another line):
with one live lot left, `update_purchase` took the single-lot path and set that lot's quantity to
the full line quantity, turning the removed units back into inventory. (2) A line whose every lot
was removed: `update_purchase` accepted a quantity change, recording units that were neither
inventory nor a recorded removal. Neither state is reachable without first splitting or removing,
and hosted data held neither at P131.

A purchase-linked lot's `quantity` changes only through `update_purchase` (single lot) and
`set_sealed_lot_intent` (which conserves the line total); `reduce_holding_quantity` refuses
purchased lots, and `reconcile_opening_cost` voids a provisional lot together with its purchase.
So for a live purchase, `line quantity = Σ quantity of all the line's lots, live and voided`, and
the voided lots' quantity is exactly the removed units.

**Decision.**
- A line with live lots and removed (voided) sibling lots is edited like a split line: every live
  lot keeps its quantity; the line's attributable cost, in both currencies, is allocated across
  **all** lots of the line (live and removed) weighted by quantity with `allocate_largest_remainder`,
  and written only to the live lots. Each unit of the receipt line keeps the same cost; removed
  units are never resurrected. With no removed lot this is exactly D-129.
- A quantity change on such a line is refused (`multi-lot-quantity-ambiguous`), as for several live
  siblings: nothing says whether the change belongs to the live or the removed units.
- A line with no live lot refuses a quantity change
  (`purchase-line-quantity-without-inventory`); an edit that leaves its quantity unchanged
  (price, shipping, notes) still succeeds and writes no lot.
- Recourse in both refusals is D-047's: void the purchase and record a new one.

**Alternatives.** *Let the live lot absorb a quantity change when removed siblings exist* —
rejected: it guesses provenance, the same objection D-129 records. *Refuse every edit of a line
that has ever had a lot removed* — rejected: price and shipping corrections on such a line are
unambiguous once quantity is fixed. *Write re-costed basis to the voided lots too* — rejected:
voided rows are history and nothing reads their basis; the allocation only uses their quantity.

**Consequences.** Reading the P131 diagnostics (`scripts/finance-integrity-diagnostics.sql`): a
split line with a removed sibling is legitimate and is counted by `lines_with_live_and_voided_lots`
and by the broad `lot_quantity_mismatch_lines` (live units < line quantity). The counters that can
only mean corruption are `lot_quantity_mismatch_lines_no_voided_lots`,
`lot_quantity_mismatch_lines_excess`, the basis mismatch counters (which already skip lines with a
voided lot) and `voided_purchases_with_live_lots`. A non-zero broad counter therefore needs a look at
the voided siblings before it is called damage. Regressions:
`tests/db/p132_integration_regressions.test.ts`; independent coverage:
`test/p132c-finance-regressions` (`LINE_LOT_QUANTITY`, `LINE_QUANTITY_WITHOUT_LIVE_LOTS`).

## D-131 — Parent-purchase auto-void requires every lot of every line voided, including split siblings of the voided lot's own line (P132)

**2026-09-14 · Accepted**

**Context.** D-051 auto-voids a purchase when the last inventory it recorded is removed, counting
*other lines*. It predates sealed-intent splits (M11). After a split, voiding one sibling skipped
its own line entirely, saw every other line accounted for, and voided the purchase while the other
sibling was still live inventory — spend removed from CS while its units stayed in the portfolio.
Found by P132-C (`VOIDED_PURCHASE_LIVE_LOT`), independently noted by the P132 correction-locking
work, and reproduced on the integrated candidate.

**Decision.** A line is *accounted for* when it has at least one lot and all of its lots are
voided. `void_acquisition_lot` auto-voids the purchase only when every line on it is accounted for
— the voided lot's own line included. A line that never produces a lot (accessory, shipping, …)
is never accounted for, exactly as in D-051. `remove_holdings_from_portfolio` inherits the rule
through `void_acquisition_lot`.

**Alternatives.** *Count other live lots anywhere on the purchase instead of lines* — rejected: that
reintroduces the D-051 defect for non-inventory lines. *Auto-void under the purchase row lock* —
not needed for integrity: concurrent removal of the last two siblings can at worst leave the
purchase live with every lot removed (spend still counted, the owner can void it), never a voided
purchase with live inventory, because a new live lot can only come from splitting a lot the check
already sees as live.

**Consequences.** A single-line purchase now auto-voids only when its last sibling is removed.
Regression: `tests/db/p132_integration_regressions.test.ts`.

---

## D-132 — `fx_rate_to_nok` is NOK-per-one-major-unit everywhere, for every source; SQL becomes currency-exponent-aware and the Norges Bank ingestion layer normalizes its own `UNIT_MULT` (P130-02/P133/P134)

**2026-09-15 · Accepted**

**Context.** P130-02 (`ai_outputs/Claude_outputs/output_130.txt`) found TWO independent defects
that together corrupt JPY FX conversion:

1. Every SQL conversion site (`create_purchase`, `update_purchase`, `create_sale`, `update_sale`,
   `sales_summary`, and the two frozen-rate CHECK constraints) computed
   `round(amount_minor::numeric * fx_rate_to_nok)::bigint`, which is only correct when the source
   currency shares NOK's minor-unit exponent (2). FINANCIAL_MODEL.md §1/§7 and D-007 already state
   the opposite rule — the exponent is read per currency, never assumed to be 2 — and
   `src/domain/fx.ts` already implements it client-side; only the SQL layer disagreed with its own
   project's documented contract.
2. Independently, `supabase/functions/_shared/norges-bank.ts` returned Norges Bank's raw SDMX
   observation unchanged, ignoring the series-level `UNIT_MULT` attribute. Live-verified twice
   (2026-09-13 and 2026-09-14): EUR and USD both carry `UNIT_MULT: 0` ("Units" — the printed number
   already is NOK per 1 unit); JPY alone carries `UNIT_MULT: 2` ("Hundreds") — a printed `6.0375`
   means NOK per **100** JPY, not per 1 JPY.

For every currency this product has ever offered except JPY (NOK/EUR/USD/GBP, all exponent 2 and
all UNIT_MULT 0) both defects are numerically invisible. For JPY they happen to **cancel** on the
automatic (Norges Bank) path only: the parser hands SQL a rate 100x too large (raw per-100 instead
of per-1), and the SQL layer's missing exponent shift is also a factor of 100 in the direction that
compensates — so an auto-sourced JPY purchase or sale landed on the numerically correct
`total_nok_minor` by accident. A **manually-entered** JPY rate (which never passes through the
Norges Bank parser) hits only defect 1 and is stored ~100x too **low** with no compensation. This
is why the bug survived: the released test suite has EUR/USD/GBP fixtures only, every one of which
has a zero exponent gap and a zero UNIT_MULT, so neither defect nor their interaction was ever
exercised. Hosted diagnostics at P131 and P132 (`output_131.txt`, `output_132_i.txt`) both found
zero JPY purchase or sale rows on the hosted database at the time of those checks, so no existing
transaction data needed repair as of those reads; P136 re-verifies this immediately before release
(§9 below) rather than trusting a stale snapshot.

**Decision.**

1. **Canonical contract, unchanged, now actually enforced everywhere.** `fx_rate_to_nok` (and
   `fx_rates.rate`) means exactly one thing, automatic or manual, for every currency this product
   supports: NOK per **one MAJOR unit** of the source currency, `numeric(18,8)`. There is no
   per-currency exception, no "rate per 100 units" input, and no separate JPY convention anywhere
   in the schema, the RPCs, the ingestion layer or the client. Manual entry (the purchase/sale
   form's "NOK per 1 {currency}" field) already satisfied this; the fix brings both the automatic
   ingestion path and the SQL conversion path into agreement with the same rule, rather than
   introducing a new one.
2. **SQL becomes currency-exponent-aware (P133).** One new canonical function,
   `money_minor_to_nok_minor(amount_minor, currency, fx_rate_to_nok)`, built on a small
   `currency_minor_unit_exponent(currency)` lookup mirroring `src/domain/currency.ts` exactly
   (NOK/EUR/USD/GBP = 2, JPY = 0; raises for anything else — unsupported currencies fail closed
   rather than silently assuming exponent 2), replaces every inline
   `round(amount_minor::numeric * fx_rate_to_nok)::bigint` site: both purchase RPCs, both sale
   RPCs, `sales_summary`'s four per-row NOK aggregates, and both frozen-rate CHECK constraints
   (`purchases_total_nok_matches_rate`, `sales_net_proceeds_nok_matches_rate`). Rounding is
   unchanged — `round(numeric)`, half-away-from-zero, applied exactly once per conversion, the same
   rule every site already used and the same rule `src/domain/fx.ts`'s `divideRoundHalfUp` already
   implements client-side. For every currency other than JPY the exponent shift is zero, so the new
   formula is byte-identical to the old one (proven by a parity property test against
   `src/domain/fx.ts`'s independent `convert()`).
3. **Norges Bank ingestion normalizes its own `UNIT_MULT` (P134).** `_shared/norges-bank.ts` is the
   only place in the system permitted to know Norges Bank's SDMX attribute shapes. It resolves
   `UNIT_MULT` from `structure.attributes.series` by attribute `id` (never by assuming a fixed
   array position) and divides every observation by `10^UNIT_MULT` using exact decimal-string
   arithmetic — never `Number` division, since FINANCIAL_MODEL.md §7's invariant F11 freezes this
   value forever and a binary-floating-point artifact here would be permanent — before the value is
   ever cached into `fx_rates` or returned to a caller. `fetch-fx-rate` and `ingest-fx` both call
   this one shared function and therefore both normalize identically with no per-caller change. A
   series whose `UNIT_MULT` cannot be resolved to a plain integer (malformed value, or the
   attribute missing entirely) is refused (`NorgesBankError`), never defaulted to 0 — assuming
   "Units" for a series that actually needed a real multiplier would silently store a rate wrong by
   a power of ten with no signal anywhere it happened. SQL, `src/domain`, and every other consumer
   of `fx_rate_to_nok` never learn Norges Bank or `UNIT_MULT` exist; the two fixes are independent
   corrections at independent layers that happen to both be required for the same currency today.

**Alternatives.** *Fix only one layer* — rejected outright; see Consequences: the two defects
currently cancel for the automatic path, so fixing exactly one of them (in isolation, by an
uncoordinated deploy) does not merely leave a bug unfixed, it actively **introduces a fresh 100x
error in the opposite direction** for every new auto-sourced JPY row written while only one half is
live. *Special-case JPY at each call site or in the parser with a hardcoded `× 100` / `/ 100`* —
rejected at both layers: brittle (silently wrong the moment a second zero-exponent currency, or a
currency Norges Bank rescales differently, is ever added) and exactly the kind of currency-keyed
branch this project avoids elsewhere (`src/domain/currency.ts`'s per-currency metadata table, not
an `if (code === 'JPY')`). The fix must be generic (source exponent vs. NOK exponent; provider
`UNIT_MULT` vs. assumed 1), not JPY-specific, and both P133's and P134's mutation campaigns
specifically prove a JPY-keyed special case is killed. *A SQL currency-metadata table instead of a
lookup function* — rejected for this change: no SQL currency table exists today (D-007's "currency
table" describes `src/domain/currency.ts`, not a database table); a five-branch `case` is complete,
exact and trivially extended later. *Apply the `UNIT_MULT` correction in SQL alongside the exponent
fix* — rejected: SQL has no way to see SDMX metadata at all; the correction must happen in the
ingestion layer, before a rate is ever cached or frozen onto a transaction row. *Default an
unresolvable `UNIT_MULT` to 0* — rejected: fails open on exactly the class of provider-format
change (Norges Bank rescaling a series, or a hostile/corrupted response) this decision exists to
catch.

**Consequences.**

- NOK/EUR/USD/GBP transactions are numerically unaffected by the SQL fix (exponent shift zero) and
  unaffected by the parser fix (`UNIT_MULT` zero) — both proven by parity/property tests and by the
  full pre-existing test suite passing unchanged.
- A manually-entered JPY rate now produces the correct NOK amount instead of one ~100x too small.
- **Old automatic JPY correctness was accidental cancellation, not a sign either layer was right.**
  Before this decision, an auto-sourced JPY purchase/sale landed on the numerically correct
  `total_nok_minor` only because the parser's raw-per-100 rate and SQL's missing exponent shift
  happened to cancel for this one currency pair's specific numbers. That was never a property to
  preserve.
- **Partial deployment of only one half is unsafe and strictly worse than doing nothing.** New SQL
  + old parser: auto JPY becomes ~100x TOO HIGH (SQL now applies the correct ×100 shift to a rate
  that is still itself ×100 too large). Old SQL + new parser: auto JPY becomes ~100x TOO LOW (the
  parser now hands SQL a correct per-unit rate, but SQL still fails to apply the ×100 shift). Both
  of these partial states are worse than the pre-fix state for any JPY row written during the gap —
  never deploy the SQL migration and the edge-function redeploy as separable, independently-timed
  releases; they land in the same coordinated window (P136 §30).
- **Stored transaction NOK values are frozen and must never be casually recomputed.** Per
  FINANCIAL_MODEL.md §7 invariant F11, a purchase or sale's `total_nok_minor` /
  `net_proceeds_nok_minor` is written once at transaction time and never recomputed from its stored
  `fx_rate_to_nok` merely because the conversion CODE later changed — including by this decision.
  If any pre-fix JPY transaction row is ever found (hosted diagnostics found none as of P131/P132;
  P136 re-verifies immediately before release), its frozen NOK amount is a historical artifact of
  whatever code wrote it and is a financial-data question for the owner, not something a migration
  silently rewrites.
- **Legacy automatic `fx_rates` cache rows are rebuildable cache, not ledger.** Unlike a
  purchase/sale row, `fx_rates` is a stateless resolution cache (no FK from any transaction; a
  transaction freezes its own copy of the rate at write time) written only by service-role
  infrastructure. A cache row with `source = 'norges_bank'` and `base_currency = 'JPY'` is provably
  machine-ingested under the pre-fix parser and may be safely deleted (forcing a fresh, correctly-
  normalized fetch on next use) or normalized — never treated as financial history requiring
  owner sign-off.
- **Ambiguous historical manual JPY rows require owner review, never a silent rewrite.** A
  manually-entered JPY row's stored rate alone cannot distinguish a user who correctly followed the
  UI's own "NOK per 1 JPY" label from one who pasted a raw provider figure under the old (wrong)
  convention, from a genuinely mistaken entry. Any such row found must be listed for the owner,
  never automatically corrected.
- `total_nok_minor` for a currency outside the five this product supports today now fails closed
  with an explicit `unsupported currency code` error instead of silently computing a wrong number
  under the old exponent-2 assumption — a side effect of making the SQL fix generic, not a separate
  feature; P130-18's broader "server accepts any 3-letter code" finding for dates is unaffected and
  remains open.

Worked example (JPY, both halves live): a 10,000 JPY purchase with the Norges Bank raw observation
6.0375 (NOK per 100 JPY, `UNIT_MULT=2`) normalizes in the ingestion layer to `fx_rate_to_nok =
0.06037500` (NOK per 1 JPY), then converts in SQL to
`money_minor_to_nok_minor(10000, 'JPY', 0.06037500) = round(10000 × 0.06037500 × 10^(2-0)) =
60375` minor units, i.e. NOK 603.75 — consistent with the raw provider figure read as "6.0375 NOK
per 100 JPY": 10,000 JPY is 100 × 100 JPY, so 100 × 6.0375 NOK = NOK 603.75. Regression tests:
`tests/db/p133_currency_exponent_fx.test.ts` (SQL/exponent), `tests/data/norges-bank.test.ts`
(parser/`UNIT_MULT`), `tests/data/p135/reference/fx-oracle.test.ts` (independent second oracle,
derived without reading either fix's implementation).
