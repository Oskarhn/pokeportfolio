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