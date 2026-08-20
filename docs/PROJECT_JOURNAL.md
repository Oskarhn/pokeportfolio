# Engineering Journal

A factual record of problems solved and choices made, written for someone reading this
repository later to understand what was actually engineered.

Not a changelog ([CHANGELOG.md](../CHANGELOG.md) covers releases) and not a work log. Entries go
here when there was a real problem with a non-obvious answer.

---

## 2026-08-16 — Every marketplace API is closed; the pricing architecture had to route around it

**Problem.** The application needs European card prices in EUR. The two obvious sources are
Cardmarket and TCGplayer. Both are closed: Cardmarket states it is not accepting API
applications, and TCGplayer's public developer programme has been shut to new entrants since
roughly late 2024. pokemontcg.io, the best-known free catalog, returned HTTP 500 on two separate
probes and its maintainers have moved to a commercial product.

**Investigation.** Rather than trusting comparison articles — most of which turned out to be
content marketing for their own paid APIs — every candidate was probed directly from the
development machine.

**Finding.** TCGdex, a community-maintained MIT-licensed catalog, relays Cardmarket price points
in EUR and TCGplayer price points in USD, per card variant, with no API key. Verified live:
23 444 English cards across 218 sets, 177 Japanese sets, and a `variants_detailed[].pricing`
structure carrying `trend`, `low`, `avg`, `avg1`, `avg7` and `avg30` in EUR with a same-morning
timestamp.

**Consequence.** TCGdex became the catalog and raw-pricing foundation. Because it is
community-run with no SLA, three mitigations were designed in from the start: a provider
abstraction so no business code references provider field paths; internal UUID identity with
provider ids as nullable mapping columns, so the provider disappearing breaks nothing; and our
own snapshot table, so the accumulated price history is ours regardless of what happens upstream.

**Also learned.** The licensing question has three separate answers that are easy to conflate:
the database is MIT, the card artwork is copyright of The Pokémon Company, and the relayed
marketplace price data has undocumented provenance. An MIT licence on the first grants nothing
over the second or third. Recorded as an open uncertainty rather than resolved by assumption.

---

## 2026-08-16 — Pack-opening cost attribution: the zero-cost trap

**Problem.** An ETB costing 799 NOK is opened and produces cards. Those cards must appear in the
collection with a value, without breaking the accounting.

**First answer, wrong.** The opening keeps the cost; pulls get a cost basis of zero. Arithmetically
this produces correct portfolio totals — the 799 is counted once, the pulls are counted once.

**Why it was wrong.** A card with a cost basis of 0 and a market value of 400 displays as
infinite return. Every pulled card becomes a spectacular investment. The number is technically
derived from correct inputs and is completely misleading, which is worse than being obviously
wrong.

**Resolution.** The distinction is between *zero* and *not applicable*. Pull lots store `NULL`,
not `0`, and the system treats `NULL` cost basis as a distinct case throughout: no ROI is
computed, no cost field is displayed, and the UI says "from opening — no individual purchase
cost". Return is computed at opening scope, where the question is well-posed:
retained pull value + proceeds from sold pulls + bulk estimate − cost.

**Consequence.** An invariant that `NULL` money never means zero, enforced by a check constraint
and asserted by test. Every aggregate handles the `NULL` branch explicitly. The cost is
additional care in every query; the benefit is that no screen can show a fabricated return.

**Generalisation.** This is the same class of error as filling a chart's history with today's
price. Both produce a plausible number from an absent fact. The rule adopted across the project:
absent data is displayed as absent.

---

## 2026-08-16 — Condition multipliers: invented precision, caught before implementation

**Problem.** Cards have condition grades. Market prices should presumably reflect them.

**First answer, wrong.** A multiplier table — NM 100%, EX 85%, GD 70%, LP 55%, PL 40%, PO 25%.

**Why it was wrong.** Those percentages had no source. They were plausible-looking numbers with
no derivation, and applying them would produce a portfolio value carrying two decimal places of
apparent precision on top of a guess. Cardmarket's published price points are not
condition-specific, so there was no data to calibrate against either.

**Resolution.** Condition is stored as a real property and used for filtering, sorting and
export. It does not adjust value. The UI states that the reference price is for the printing,
not for the specific copy. Manual valuation covers a played card honestly.

**Consequence.** Less convenient, more truthful. Configurable multipliers remain possible later,
but only as an opt-in, user-set, visibly-marked estimate.

---

## 2026-08-16 — iOS camera lifecycle constrained the routing architecture

**Problem.** Bulk card scanning is a core product goal. The primary platform is an installed iOS
PWA.

**Finding.** WebKit does not persist camera permission across URL changes in standalone mode.
Bug 215884 has been open since 2020 and remains unresolved in 2026. A scanner that navigates per
card would prompt for camera permission on every card. The commonly suggested workaround is
granting Safari blanket camera access, which is not something to require of a user.

**Consequence.** The routing architecture was fixed before any scanner code exists: one route
owns the session and one `MediaStream`, per-card confirmation is an in-route overlay, and no
navigation or URL mutation occurs while the camera is live. This makes the scanner route the one
documented exception to the app-wide convention that filter state lives in the URL.

**Why decide it now.** The scanner is scheduled several phases out. Discovering this constraint
after building it would mean rewriting its routing; encoding it now costs a paragraph of
documentation. The underlying assumption still needs validating on real hardware with a
throwaway page before the scanner phase begins — an open browser bug report is evidence, not
proof of current behaviour.

---

## 2026-08-16 — Storage ceiling shaped the price-history design

**Problem.** Portfolio charts need a real price history, and no free source provides one, so it
must be accumulated. Supabase's free plan caps the database at 500 MB.

**Arithmetic.** Snapshotting all 23 400 English variants daily at roughly 48 bytes per row is
about 410 MB per year — over 80% of the ceiling, for data covering cards nobody owns.

**Resolution.** A `watched_card_variants` view drives ingestion: only variants a user holds or
has held. At an assumed 3 000 watched variants across two price kinds, roughly 105 MB per year,
with rows older than twelve months thinned to weekly.

**Accepted limitation.** A variant's price history begins when it is first acquired, not when
the app started. Documented rather than hidden, and preferable to the alternative of
backfilling with today's price.

---

## 2026-08-16 — Tracking every card, and why it did not blow the storage budget

**Problem.** The requirement changed: instead of tracking valuable cards and aggregating the rest,
every physical card must be individually trackable — Basic Energy, commons, duplicates, cards
worth two øre, cards with no market price at all. Working scale moves from a few thousand
holdings to potentially ten thousand or more.

**The apparent obstacle.** The free database tier caps at 500 MB, and the plan was already to
accumulate daily price snapshots because no free source provides historical prices. Ten times the
collection appeared to mean ten times the price history, which would not fit.

**Why it did not.** Price is a property of a *printing*, not of a *copy*. Owning eighty identical
Basic Grass Energy produces one snapshot row per day, not eighty; quantity lives in the lots and
is applied at aggregation time. Snapshot volume therefore scales with distinct printings owned —
which plateaus, because duplicates, playsets and energies collapse — rather than with cards
owned, which does not.

**Measured expectation.** A 10 000-card collection realistically spans 3 000–4 000 distinct
variants. At two price kinds and daily snapshots that is roughly 105 MB/year, with thinning after
twelve months. The holdings and lots themselves are about 200 bytes each, so 10 000 lots is ~2 MB.

**Consequence.** All-card tracking cost nothing in storage terms. The real costs were elsewhere
and were addressed directly: keyset pagination and virtualisation for the collection view, lazy
image loading sized to the current grid density, and dashboard figures read from precomputed
snapshots so their cost is near-independent of collection size.

**Generalisable point.** The instinct that "ten times the data means ten times the storage" was
wrong because it conflated two different cardinalities. Checking which entity a cost actually
scales with, before designing around it, turned a blocking constraint into a non-issue.

---

## 2026-08-16 — Cost basis needed a state, not a nullable number

**Context.** An earlier decision established that pack-opening pulls store `NULL` cost basis
rather than zero, because zero renders as infinite return. Extending tracking to gifts, trades
and pre-tracking collections produced four more situations that all wanted `NULL`.

**Problem.** They are not the same fact. A gift genuinely cost nothing. A card bought in 2014 for
a forgotten amount cost real money the system cannot see. A pull's cost exists but belongs to the
opening. Stored as bare `NULL`, all three are indistinguishable, and the application cannot tell
the user which kind of ignorance it has.

**Resolution.** `cost_basis_state ∈ {known, unallocated_opening, not_paid, unknown, trade_in}`,
with the amount present if and only if the state is `known`, enforced by check constraint.

**What it buys.** Correct UI copy — "gift" versus "cost unknown" versus "from opening" instead of
a blank field that reads as zero. Correct aggregate behaviour, since uncosted lots are counted
and surfaced rather than silently dropped. And an honest disclosure: the overall position figure
overstates reality when pre-tracking cards are present, and the app can say so because it knows.

---

## 2026-08-16 — A login that sends no email

**Problem.** The planned authentication was email one-time codes. The zero-cost audit found that
the platform's built-in email provider allows **two auth emails per hour, project-wide** — not per
user — and its own documentation calls it unsuitable for production.

**Why that is fatal for OTP.** Every login sends an email. Two logins in an hour, or onboarding
two people in one sitting, exhausts the quota. The failure is not degraded service; it is being
locked out of your own application.

**Options.** A custom SMTP provider would fix it, and free tiers exist that need no domain. But
that puts a third-party service, an account and a deliverability failure mode on the critical
path of every single login. One candidate with a generous free tier was excluded outright because
it requires a verified domain — and a domain is a purchase, which fails the zero-cost constraint
even though the service itself is free.

**Resolution.** Email and password. Normal login sends nothing. Account creation is already gated
by an invitation function, so email confirmation is unnecessary. Password reset remains an email
path but is genuinely rare — a handful of events per year against a limit of two per hour — and
has an admin-assisted fallback.

**Trade acknowledged.** This exchanges a delivery dependency for a credential to protect.
Password handling is now in scope where it previously was not, and the security model covers it
explicitly. That is the right trade when the alternative is a login that can rate-limit itself
out of existence.

---

## 2026-08-17 — The bigint/PostgREST precision boundary is real, not theoretical

**Problem.** FINANCIAL_MODEL.md requires money as exact integer minor units, so every monetary
column is Postgres `bigint`. Research into how Supabase's client actually serializes `bigint`
(supabase/postgrest-js issues #319 and #419) confirmed PostgREST returns `bigint` as a plain JSON
number by default, and JSON/JS numbers only carry exact precision up to `Number.MAX_SAFE_INTEGER`
(2^53 − 1).

**Why this mattered enough to test rather than assume.** The project's own rule is "never invent
project state" — a plausible-sounding claim about a library's behaviour is exactly the kind of
thing that should be verified against the actual stack, not carried forward from a GitHub issue
thread. `tests/db/money-boundary.test.ts` inserts a value one integer above the safe threshold
and proves both halves: selecting with an explicit `total_minor::text` cast round-trips exactly
via `BigInt()`; selecting the same column without the cast returns a different, silently rounded
number.

**Resolution.** `src/data/money.ts` documents the boundary and its mitigation before any query
code exists to use it: every future read of a money column must cast to text in the select list.
Not a practical risk at this application's real scale — a collection would need to be worth
roughly 90 quadrillion NOK in øre before it mattered — but the boundary is now tested rather than
assumed, and the pattern is established before M5+ query code has a chance to get it wrong.

---

## 2026-08-17 — Local Docker unavailability turned into the CI database-testing strategy

**Problem.** M3 needs migrations and RLS policies exercised against a real Postgres instance. The
development machine has no Docker Desktop installed, so `supabase start` cannot run locally, and
the prompt explicitly ruled out installing Docker just to unblock this.

**Investigation.** GitHub Actions' `ubuntu-latest` runners ship Docker preinstalled, and the
Supabase CLI's local stack (`supabase start`, `supabase db reset`) is exactly the Docker-based
stack the local machine lacks. Supabase's own CI documentation confirms this exact pattern:
`supabase/setup-cli` (or, as here, the CLI already pinned as a project devDependency) plus
`supabase start` inside a GitHub Actions job.

**Resolution.** A `db-tests` job runs the full ephemeral local stack on every push and PR —
migrations from empty, `db reset`, the authorization and database test suites, and generated-type
export — entirely on the Linux runner, never touching any remote Supabase project or credential.
This means the M3 gate (migrations apply; RLS isolation tests pass; a broken policy would fail
red) is provable in CI today, independent of whether or when a remote dev project gets linked.
The remote free dev project (once the owner creates one) becomes the tool for manual/interactive
work on the Windows machine, not the thing CI depends on.

**Consequence.** Docker never needed installing on the development machine to satisfy M3's gate.
If local iteration against a live database becomes valuable later, installing Docker Desktop
remains available as a separate, owner-approved choice — it was never a blocker.

---

## 2026-08-17 — Ownership triggers deliberately run with invoker rights, not SECURITY DEFINER

**Problem.** The child-parent ownership triggers (`purchase_lines_check_owner`,
`acquisition_lots_check_owner`, SECURITY.md invariant S1) need to read the parent row's `user_id`
to compare against the child's. The obvious way to make that read reliable is `SECURITY DEFINER`,
which bypasses RLS.

**Why that would have been worse.** With `SECURITY DEFINER`, a cross-tenant attempt (user B
inserting a child row pointing at user A's parent) could see A's real `user_id` and produce a
precise "owner mismatch" error — which also confirms to B that the targeted parent row exists and
who owns it. That is an information leak SECURITY.md explicitly asks the test suite to check for
("empty result, not an error leak").

**Resolution.** The triggers run with default invoker rights. RLS on the parent table already
hides another user's row from the `SELECT` inside the trigger, so a cross-tenant attempt sees
`parent_user_id IS NULL` and fails with "not found" rather than "owner mismatch" — rejecting the
write without confirming the target row's existence. `tests/authorization/purchases.test.ts` and
`tests/authorization/holdings_and_lots.test.ts` exercise this directly.

**Generalisable point.** The instinct to reach for `SECURITY DEFINER` whenever a trigger needs to
"see more" is usually solving the wrong problem — here, RLS's own hiding behaviour was the
correct security property, and definer rights would have quietly undone it.

---

## 2026-08-20 — An enum's own `::text` cast cannot go in an index, and CI caught it first

**Problem.** `holdings_identity` (DATA_MODEL.md §5.4) needs to coalesce `condition` and `grader`
— both custom enum columns — down to an empty string when null, since no enum member means
"absent". The natural expression is `coalesce(condition::text, '')`. CI's `db-tests` job failed
applying the migration to an empty database: `ERROR: functions in index expression must be marked
IMMUTABLE`.

**Why.** Postgres auto-generates I/O functions for a `CREATE TYPE ... AS ENUM`, and marks the
enum-to-text conversion `STABLE`, not `IMMUTABLE` — because `ALTER TYPE ... RENAME VALUE` could in
principle change what a given internal value prints as, which would change an index's contents
without Postgres knowing. An index expression is required to be provably deterministic forever, so
`STABLE` isn't good enough, even though nothing in this project ever renames an enum label.

**Resolution.** Two minimal `IMMUTABLE`-marked SQL wrapper functions
(`card_condition_to_text`, `grader_to_text`) that do exactly the same cast, added in the same
migration. This is the documented community pattern for this exact error, not a workaround
invented under pressure — the promise the `IMMUTABLE` marking makes ("same input, same output,
forever") is one this project can actually keep, since these enums only grow by adding new values,
never by renaming existing ones.

**Why this is worth recording.** This was caught by CI actually attempting the migration against
a real, ephemeral Postgres instance — exactly the value the M3 CI investment (see the "Local
Docker unavailability" entry above) was supposed to provide, on the very first real test of it.
Neither `pnpm check`, code review, nor reasoning about the SQL in the abstract would have caught
this; it required a real `CREATE INDEX` to fail.

## 2026-08-20 — Two Supabase-platform assumptions were wrong, and CI caught both in one run

**Problem 1.** After fixing the `holdings_identity` index (previous entry), the same CI run still
failed: every insert into `holdings`, `purchases` and other new tables from the `service_role`
test client returned `permission denied for table ..., HINT: GRANT INSERT ON public.holdings TO
service_role`.

**Why.** `service_role` bypasses RLS, and it was assumed (reasonably, by analogy with a
superuser) that it also bypasses ordinary `GRANT`-based privilege checks. It does not. Recent
Supabase projects — local and hosted, per the `auto_expose_new_tables` note already present in
`supabase/config.toml` before this was discovered — do not auto-expose newly created tables,
views, sequences or functions to *any* Data API role, `service_role` included. Bypassing RLS and
having table-level privileges are two separate things.

**Resolution.** Every migration now grants `ALL` on its tables to `service_role` explicitly,
alongside the narrower `authenticated` grants. The two `IMMUTABLE` wrapper functions from the
previous entry needed explicit `EXECUTE` grants for the same reason — they run as part of the
`holdings_identity` index expression on every write, so both writing roles need permission to
call them.

**Problem 2, more consequential.** With the grants fixed, a second, unrelated failure remained:
every `signInWithPassword` call in the authorization suite failed with "Email logins are
disabled" — even though the corresponding user had just been created successfully via the Auth
admin API.

**Why.** `supabase/config.toml`'s `[auth] enable_signup = false` had been set to enforce
invite-only signup at the config level, mirroring SECURITY.md §5's "Dashboard: email signup
disabled at the Supabase Auth level" line. This turned out to conflate two things GoTrue does not
actually separate cleanly: disabling `enable_signup` disables the email/password grant type
entirely, including *login* for users who already exist — not only the public self-registration
endpoint. This is a documented GoTrue limitation (supabase/gotrue#330 and others), not a
misconfiguration on this project's part, but it was still wrong to rely on here: every legitimately
invited, redemption-created user in the real product would have been unable to sign in.

**Resolution.** Reverted to the platform default (`enable_signup = true`). Invite-only enforcement
is not this toggle's job — it is the `auth.users` S2 backstop trigger, already scheduled for M4
alongside the `redeem-invitation` Edge Function it depends on. Until M4 ships, the public signup
endpoint is genuinely open in any environment this schema is deployed to; there is no live
deployment yet, so nothing is exposed today, but this is now stated plainly rather than papered
over with a config setting that looked protective and was not.

**Generalisable point.** Both mistakes were reasonable extrapolations from how "trusted"
constructs usually behave (a service-role-style key acting like a superuser; a "disable signup"
toggle only affecting signup) that turned out to be specific to older platform defaults or a
cross-cutting implementation detail. Neither was caught by reasoning about the SQL or the config
in the abstract — both were caught by CI actually running the real stack, on the very first PR
that exercised it. This is the concrete return on the "Local Docker unavailability turned into the
CI database-testing strategy" decision from two entries above: real infrastructure surfaces real
platform behaviour that documentation and code review alone do not.

## 2026-08-20 — The invite-only gate turned on a fact the documentation does not state

**Problem.** M3 left `/auth/v1/signup` open and said so. The planned fix was a single
`auth.users` trigger rejecting any insert without a redemption. Between M3 and M4, Supabase's
**Before User Created** hook became generally available on the free plan — a mechanism designed for
exactly this — so continuing with the older plan purely because an older document said so would have
been the wrong instinct.

**The hard part** was not choosing the hook. It was working out what the hook may safely do.

The obvious implementation is "allow this signup if the address has a valid outstanding invitation".
That is a hole. Anyone who knew an invited person's address could call `/auth/v1/signup` and choose
the password themselves, before the invited person ever opened their link. Knowing an address is not
possessing a token, and a gate built on the first is not a gate.

The alternative is to have the hook deny *everything* and create accounts through some path the hook
does not cover. That only works if such a path exists and is server-only. Supabase's documentation
does not say whether `auth.admin.createUser` triggers the hook — the page is written from the
perspective of restricting signups, not of exempting privileged creation.

**Investigation.** Reading the GoTrue source settled it. `triggerBeforeUserCreated` is invoked from
`signup.go`, `mail.go`, `anonymous.go`, `external.go`, `web3.go`, `samlacs.go`,
`token_oidc.go` and `invite.go`. `internal/api/admin.go` — the Auth Admin API — invokes no hook
at all. A repository-wide search for `BeforeUserCreated` returns those files and not `admin.go`.

**Resolution.** The hook rejects unconditionally. There is no metadata to forge, no address to be on
a list, and no window between validation and creation for anyone to race. Behind it, a
`BEFORE INSERT` trigger on `auth.users` demands a live claim, because the hook is *configuration*
— a project that received `db push` but not `config push` would be running with the door open —
and because the trigger closes what the hook does not, namely the Admin API and the dashboard.

**What this cost.** `auth.admin.createUser` no longer works on its own for anybody, including the
authorization suite's fixtures. M3 had anticipated exactly this and used it as a reason to defer.
The right answer turned out to be to embrace it: the fixture now issues an invitation, claims it,
creates the user and finalizes the redemption — the same route the Edge Function takes. It is a
better fixture than the one it replaced, because it exercises the real path instead of stepping
around it.

**What is deliberately fragile, and watched.** The whole design rests on a source-level fact rather
than a documented guarantee. If a future GoTrue release invoked the hook from the Admin API, our
redemption would break. That is the right failure direction — loud, and caught by CI, rather than a
gate quietly opening — and the suite asserts both halves, that public signup fails *and* that
redemption succeeds, so drift in either direction fails the build.

---

## 2026-08-20 — Account deletion was impossible, and no test could have noticed

**Problem.** An adversarial review of the M3 schema, run before writing any M4 code, found that
every user-private table declared `user_id uuid not null references auth.users (id)` with no
`ON DELETE` action. PostgreSQL defaults that to `NO ACTION`, so deleting an `auth.users` row
failed the moment that user owned a single row anywhere. SECURITY.md §8 described account deletion
as a cascade. It was not one.

**Why nothing caught it.** The M3 fixture calls `auth.admin.deleteUser` in `afterAll` and
discards the result, and no M3 test ever wrote an `invitation_redemptions` row — the one table
whose FK would have failed first. The suite was green and the schema was wrong. A test that ignores
a return value is not a test of that value.

**Resolution.** All eight foreign keys now declare `ON DELETE CASCADE`, applied by looking the
constraint names up in `pg_constraint` rather than assuming PostgreSQL's default naming — a
migration that silently no-ops because a name drifted is worse than one that fails loudly.
`invitations.created_by` is the deliberate exception at `ON DELETE SET NULL`: an invitation is an
audit record of an administrative action, and outliving its issuer is the point.

**The generalisable bit.** This was found by reading the schema against the document that describes
it, not by running anything. Some classes of defect have no failing test to write until something
else makes them load-bearing — M4 is what would have made this one bite.

---

## 2026-08-20 — Proving the invite-only suite by breaking the gate on purpose

**Problem.** An attack test that has never failed is not evidence. `expect(error).not.toBeNull()`
passes for a great many reasons, most of which have nothing to do with the control being tested.

**Method.** The same technique M3 used on an RLS policy, applied to the M4 gate. A throwaway branch
disabled *both* controls — `enabled = false` on the auth hook, and a temporary migration dropping
the `auth.users` trigger — and opened a pull request purely to make CI run against an ephemeral
stack. No remote project was touched, and nothing merged.

**Result.** `db-tests` failed 9 of 10 test files. The two gate-specific assertions failed exactly
as designed and can be read off individually: *"answers a public signup with the invite-only hook"*
identifies gate 1, and *"rejects Auth Admin user creation with no invitation claim"* identifies gate
2. Every public-signup attack case failed, including the invited-address one. So did the redemption
bookkeeping, and so did most of the other suites — because the fixture that creates test users runs
through the claim mechanism, an unenforced gate makes the fixture itself fail. The suite is
load-bearing in both directions.

The branch was closed and deleted immediately. The feature branch's own CI was green before and
after.

---

## Real-device testing log

Recorded as it happens. Emulation is not evidence of Safari behaviour.

| Date | Device / OS | Tested | Result |
|---|---|---|---|
| — | — | — | Not yet performed |
