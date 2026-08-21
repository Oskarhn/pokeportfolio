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

## 2026-08-20 — A green authorization suite and a real privilege escalation, at the same time

**Problem.** With M4's gates proven in CI and the deliberate negative test done, the first deploy to
a real Supabase project should have been a formality. The verification run against it found two
things CI could not see. The second was the privilege escalation the whole authorization suite
exists to prevent: a signed-in, non-admin session could

    PATCH /rest/v1/profiles?id=eq.<its own id>   {"is_admin": true}

and PostgREST accepted it. Every test was green.

**Cause.** A Supabase project can carry an event trigger that grants the Data API roles broad
privileges on every newly created public-schema table and function — the legacy
`auto_expose_new_tables` behaviour. The local stack CI uses has it off, matching the current cloud
default. This project had it on. So on the remote, `authenticated` already held full `UPDATE` on
`public.profiles` before M3's carefully column-restricted grant ever ran.

And **a GRANT is additive**. M3 wrote

    grant update (display_name, locale, …) on public.profiles to authenticated;

meaning "these columns and no others". SQL does not read it that way: it adds those columns to
whatever the role already has. Where the role already had everything, it added nothing and
restricted nothing. That migration's own comment — that the restriction held "at the SQL privilege
level, independent of any RLS policy" — was true of the intent and false of the deployment.

RLS did not save it, and could not have. `profiles_update_own` has `USING (id = auth.uid())`
with a matching `WITH CHECK`, and the row being updated genuinely *is* the caller's own, so the
policy is satisfied. The column grant was the only thing between a user and the admin flag.

The same mechanism had already produced the milder first finding: `REVOKE EXECUTE … FROM PUBLIC`
removes PUBLIC's implicit grant and nothing else, so three functions were locked on CI and reachable
on the remote. Those three were pure computations over caller input and disclosed nothing — which is
exactly why it was worth chasing rather than shrugging at. The mechanism that made a harmless
function reachable is the mechanism that made the admin flag writable.

**Resolution.** Every privilege is now restated as revoke-then-grant, for tables and functions
alike, and not only where the bug bit — the defect is the assumption that a narrow grant restricts,
and that assumption had been made everywhere. `anon` ends with no table privileges at all;
anonymous reads answer 401 rather than an empty array. `config.toml` additionally pins
`auto_expose_new_tables = false`, so the two environments stop diverging at the source, though the
migrations no longer depend on that.

**The uncomfortable part, kept in view.** CI was green throughout, and CI was not lying about the
code — it was faithfully testing a database whose privileges did not match the one users would hit.
An ephemeral stack rebuilt from migrations is an excellent reproducibility gate and is *not* a
statement about a deployed project. The response is `scripts/remote-security-check.mjs`: the same
assertions, run against a real deployment with nothing but the publishable key, so it can never leak
a credential and there is no excuse for skipping it. It is in the security checklist now.

The final run was 33/33 against the real project, with the escalation asserted on the stored value
rather than the HTTP status — because a write that is accepted and then filtered would pass a
status check, and a write that is accepted and applied is the entire problem.

---

## 2026-08-20 — Correct migrations and convergent migrations are not the same property

M4 fixed the `is_admin` escalation, and the fix was right. It also left a question standing that
nobody had asked yet: **the fix was verified against a database that had never been wrong.** Every
test ran against an ephemeral stack built from an empty database. That is the same blind spot that
produced the bug — an environment where the mistake could not manifest.

So the checkpoint started by trying to break it. Three gaps, in increasing order of what they would
have cost.

**Functions were revoked by name, from a hand-written list.** Tables were swept
(`revoke all on all tables …`); functions were not. Sixteen names converge sixteen functions and
say nothing about a seventeenth arriving with a grant nobody wrote — which is precisely the shape
of the original bug. Now swept with `revoke execute on all routines in schema public`, then four
granted back.

**Default privileges were never neutralized, and they turned out to be the actual mechanism.** The
M4 migration blamed an event trigger. Running the audit found something more specific:
`pg_default_acl` carries entries owned by `supabase_admin` granting `anon` and `authenticated`
everything on tables, sequences and functions in `public` — in the local stack *and* in a hosted
project. A sweep is a statement about objects that exist. A default privilege is a standing
instruction about every object created afterwards, which for this project means every table M5 is
about to add.

Two things about those entries are worth writing down, because neither is obvious and both were
initially got wrong. They cannot be revoked: `ALTER DEFAULT PRIVILEGES FOR ROLE` needs membership,
and `postgres` is not a member of `supabase_admin` in either environment. The first attempt wrapped
that in an exception handler, which would have put a statement in a migration that has never once
succeeded — protection-shaped, and not protection. And they do not need to be: a default privilege
attaches only to objects its own role creates, and everything in `public` here is created by
`postgres`, because `db push`, `db reset` and the dashboard SQL editor all connect as `postgres`.
So the migration revokes the defaults for `postgres`, states plainly why it leaves the others
alone, and the audit accepts that one grantor while failing on every other.

**`UPDATE` was granted whole-table everywhere except `profiles`.** `is_admin` got a column list
because the stakes were obvious. Nothing else did — so a session could rewrite `user_id`, the
primary key, `created_at`, and the columns that record what created a row. RLS stops the row moving
to someone else, so this is not the escalation `is_admin` was. It is the same *shape*: a policy
carrying weight that belongs to a privilege, on tables where the policy is the only thing standing
there. Every user-owned table now grants `UPDATE` by column list, with identity and provenance
absent.

**What actually closes it.** Not care. Three independent statements of the same fact, any of which
can fail: the migration, `scripts/grant-audit.sql` asserting the catalog agrees, and the remote
check proving none of it is exploitable. And then CI makes the database *hostile* first — the exact
legacy auto-expose state the deployed project was in — proves the audit rejects that state,
re-applies the baseline, and proves it converges. The middle step matters as much as the last:
an audit that cannot fail is not a check. The first run of it did fail, on real deviations, which is
the only reason it is worth trusting.

Two smaller things learned, both of which cost a CI round trip:

- `pg_get_function_identity_arguments` includes parameter *names*, so an audit built on it compares
  `invitation_status(p_token text)` against `invitation_status(text)` and fails on a rename that
  changes no privilege. Built from `proargtypes` instead — the input signature, which is what
  actually identifies a grant.
- PostgreSQL reports an `UPDATE` column-privilege refusal at **table** granularity. A role holding
  column-level `UPDATE` and no table-level `UPDATE` gets "permission denied for table profiles",
  not "…for column is_admin"; the column wording belongs to `SELECT`. Asserting on the column
  message produces a test that fails while the privilege is doing its job.

**SHA-256 for invitation tokens was re-examined and kept.** The instinct to reach for Argon2 comes
from a different threat model: a slow KDF exists because a password has perhaps 40 bits of entropy
and must survive offline guessing. An invitation token here is 256 bits from a CSPRNG. There is no
dictionary to run, so there is nothing for a slow hash to slow down, and the property that matters
— a database dump contains nothing replayable as a token — is delivered by any preimage-resistant
hash. Changing it would be cost with no corresponding gain. Left alone.

---

## 2026-08-20 — A real card disproved the variant schema before any user data existed to break

M3 modelled a card's ownable printings as one `variant_type` enum: `normal`, `holo`, `reverse`,
`first_edition`, `promo`, `stamped`, `other`. It looked complete at design time — every value from
the provider's boolean flags had a slot. The first real card fetched for M5's ingest disproved it.

Base Set Charizard's `variants_detailed[]` contains an entry that is simultaneously `type: "holo"`,
`subtype: "shadowless"`, and `stamp: ["1st-edition"]`. There is no value of `variant_type` that
represents "holo and shadowless and first-edition" — the enum treats finish and edition as the same
axis, and this card needs three independent ones. Fitting it would have meant picking one label and
losing information a collector actually cares about (shadowless commands a real price premium over
unlimited, independent of first-edition status).

The fix (D-033) replaced the enum with three columns — `finish`, `stamp`, `subtype` — matching
TCGdex's own dimensions rather than inventing a taxonomy. The two free-text columns are a deliberate
choice: the enum's failure mode was assuming a closed vocabulary, and there was no reason to build a
second closed vocabulary five minutes later. `tests/data/tcgdex-provider.test.ts` pins the mapping
against the real Charizard payload (trimmed, captured 2026-08-20) specifically so a change to this
shape fails a test rather than silently mis-categorising a card again.

The lesson generalises past this one schema. **A card's provider payload is the closest thing this
project has to a spec for physical printings, and reading a few of them before finalising a
schema is cheaper than migrating one after real collection data depends on it** — which is exactly
why M5 does this now, before M6 attaches holdings to `card_variants`, and why PLANNING_FREEZE.md §9
treats "a provider changed, a measurement failed" as legitimate grounds to reopen a decision that
looked settled.

---

## 2026-08-20 — Provider ids are unique per language, not globally, and two ON CONFLICT bugs followed from getting that wrong twice

The M3 schema put a global `unique` index on `card_sets.tcgdex_set_id` and `cards.tcgdex_card_id`,
and gave `card_series` no provider-id column at all. A live request settled whether that was safe:
`/v2/en/sets` and `/v2/ja/sets` both return a set id `neo1`; both series lists return a series id
`neo`. TCGdex's id space is scoped **per language**, not global. Ingesting Japanese Neo Genesis
after English Neo Genesis would have thrown a unique-violation on the very row that proves the
catalog needs to support Japanese at all.

Fixed by adding `language` to `card_series` (plus the provider-id column it should have had from
M3) and scoping every provider-id uniqueness constraint to `(language, tcgdex_*_id)`. First pass at
the fix used a *partial* unique index — `WHERE tcgdex_set_id IS NOT NULL`, which reads as a
reasonable guard against two curated rows both being `NULL`. Running the actual ingest function
against the real project failed immediately: `there is no unique or exclusion constraint matching
the ON CONFLICT specification`. PostgREST's `upsert(... {onConflict: 'language,tcgdex_set_id'})`
asks Postgres to match a unique constraint or index by its literal column list, and Postgres will
not infer a match against a *partial* index from a bare column list — the predicate has to be
restated in the conflict clause itself, which the client library's simple form does not do.

The partial predicate was not buying anything to begin with: a plain (non-partial) unique
constraint on a nullable column already permits any number of `NULL`s, because SQL treats every
`NULL` as unequal to every other value, including another `NULL`. Dropping `WHERE ... IS NOT NULL`
lost nothing and made the constraint upsert-targetable
(`20260820154000_m5_provider_id_upsert_targets.sql`). The `card_variants` identity index had the
identical shape of bug from a different angle — built as an *expression* index
(`coalesce(stamp, ''), coalesce(subtype, '')`) so two `NULL` stamps would not collide, which is
correct in principle and equally un-targetable by `on_conflict`. Fixed by making `stamp`/`subtype`
`NOT NULL DEFAULT ''` instead, so the identity constraint could be a plain column-list constraint.

Both bugs share one root cause: a schema decision that looked right by inspection and was wrong the
first time it had to survive an actual `INSERT ... ON CONFLICT`. Neither was visible in the
migration SQL, in `pnpm typecheck`, or in a code review — only in running the real ingest against a
real project, which is the reason this milestone budgeted for that rather than treating "the
migration applied" as proof the ingest would work.

---

## 2026-08-20 — A marketplace product id is not a per-variant identity either

Continuing the same audit: `card_variants.cardmarket_product_id` and `.tcgplayer_product_id` had
unique indexes, on the assumption that a marketplace lists each finish as a separate product.
`swsh1-2` (Roselia, Sword & Shield) disproves it — its `normal` and `reverse` variants share one
TCGplayer `productId` in TCGdex's own response; the marketplace prices both finishes under one
listing with per-finish price fields, not two listings. Ingesting Roselia would have failed the
same unique constraint on the second variant.

Fixed by dropping uniqueness on both columns entirely (D-034) — they remain indexed, because M9's
price ingest will still want to join on them, but they no longer claim an identity property the
data does not have. Combined with the `"generated"` sentinel TCGdex returns for `variantId` when it
has no real cross-reference (observed on several modern cards, mapped to `NULL` rather than stored
as a fake id), the pattern across all three provider-id columns on `card_variants` is the same:
**verify a "this uniquely identifies X" assumption against a real payload before encoding it as a
database constraint** — the two vintage/finish-rich cards this milestone happened to fetch first
were exactly the ones that disproved it, and a synthetic test fixture written from imagination
would not have.

---

## 2026-08-20 — The hostile-grant convergence test itself needed to know about M5, and only CI could tell us

M4.1 built a real safety net: grant hostile privileges, prove the audit rejects them, re-apply "the
baseline migration," prove it converges. It worked exactly as designed — for M4's surface. The M5
branch's first real CI run against the ephemeral stack failed the convergence step with `MISSING
routine authenticated EXECUTE search_cards(text, text, integer, integer)`.

The mechanism: `revoke execute on all routines in schema public from anon, authenticated` in
`20260820140000_m41_privilege_baseline.sql` is a sweep — it revokes *every* function's grant,
including ones that did not exist in August when that file was written. Re-applying only that file
after a hostile-grant test therefore converges to exactly the M4.1-era surface, dropping anything a
later migration added on top. `search_cards`'s own grant (in `20260820151000_m5_catalog_search.sql`)
never gets reasserted, because nothing tells the hostile-grant recovery step to run that file too —
and it could not simply run every privilege-bearing migration since M4.1 in sequence anyway, because
some of them also `CREATE TABLE`, which is not safe to replay against a database that already has
that table.

The fix mirrors what M4.1 did to M4: a new pure-privilege migration
(`20260820157000_m5_privilege_baseline.sql`) that restates the *complete* current surface — M4.1's
grants plus `search_cards` — and nothing but `REVOKE`/`GRANT`/`ALTER DEFAULT PRIVILEGES`, so it is
safe to re-run any number of times. `.github/workflows/ci.yml` now re-applies this file instead of
M4.1's for the convergence check.

This was not discoverable by re-reading the M4.1 migration, by `pnpm typecheck`, or by running
`grant-audit.sql` against a database that had only ever been migrated forward once (which is what
`pnpm exec supabase db push` against the linked remote project does, and which this session did,
repeatedly, before pushing the branch — every one of those runs showed a clean audit). It surfaced
only because CI's hostile-grant test specifically manufactures the "wrong starting state, then
recover" scenario the M4 escalation actually was. **The lesson restates one already in this
document, one level up: a check designed to prevent a class of bug needs to be re-verified against
every future addition to that class, not just written once and trusted** — and the reason M4.1
built the convergence test as a *replayable procedure* rather than a one-time fix is exactly what
made this failure loud and specific instead of silent.

---

## 2026-08-20 — Two ingest gaps, investigated instead of accepted or invented around

The full English + Japanese ingest completed at 32,690 cards / 47,083 variants across 374 of 380
attempted sets, and the temptation with any large real-data run is to call a 98%+ set success rate
good enough and move on. Two of the six missing sets' worth of investigation turned out to matter.

**Six sets 404'd from the Edge Function specifically.** A direct `curl` from this development
machine, run at the same moment a retry from `sync-catalog` was failing, returned `200` for the
identical URL. A sanity-check re-sync of an unrelated, known-good set (`base1`) from the Edge
Function immediately afterward succeeded normally. That combination rules out both "the set doesn't
exist" and "the function is broken" — what's left is TCGdex's own edge/CDN infrastructure answering
inconsistently depending on which network the request arrives from. Nothing to fix on this side;
recorded as a known gap with the exact retry command that should close it once TCGdex's edge state
settles.

**72 sets have a `cardCount` and an empty `cards[]`.** The reconciliation check this milestone's
prompt asked for (compare summed provider counts against actual ingested rows) found 76 mismatched
sets, not zero. The instinct at that point is to assume an ingest bug — a pagination limit, a
concurrency race, something dropping cards silently. Fetching one of the mismatched sets
(`ja/CS2b`) directly showed `cardCount.total: 101` and `cards: []` in the same TCGdex response.
`sync-catalog` had done the only correct thing available to it: create the set row from the metadata
that existed, and ingest zero cards from a card list that was empty. Most of these turned out to be
the same physical Japanese product (`トリプレットビート`, "Triplet Beat") catalogued under a dozen
different set ids, presumably one per regional SKU — plausibly TCGdex's own de-duplication marking
eleven of the twelve as pointers rather than populating each with its own 101-row card list.

The shared lesson: a reconciliation check exists to produce a number that needs explaining, not a
number that needs to be zero. Both gaps above were explainable from live data in a few minutes each,
and neither is a defect in this project's code — but *finding that out* required treating the
mismatch as a question rather than either ignoring it (M5 prompt §35 explicitly forbids "silently
accept unexplained large mismatches") or assuming the bug must be ours and trying to patch around
data the provider itself does not have.

---

## Real-device testing log

Recorded as it happens. Emulation is not evidence of Safari behaviour.

| Date | Device / OS | Tested | Result |
|---|---|---|---|
| 2026-08-20 | iPhone, Safari | Add to Home Screen from `pokeportfolio-dev.pages.dev`; launch from the icon | **Pass.** Installs and launches standalone. |
| 2026-08-20 | iPhone, installed PWA | Sign-in screen rendering | **Pass**, but see the defect below — the screen was complete and not clipped, and could be scrolled away. |
| 2026-08-20 | iPhone, installed PWA | Sign in, sign out | **Pass.** |
| 2026-08-20 | iPhone, installed PWA | Session survives closing the app, swiping it out of the switcher, and relaunching | **Pass.** Still signed in. |
| 2026-08-20 | iPhone, installed PWA | Scroll behaviour on the sign-in screen | **Defect.** The form could be scrolled entirely off the top, leaving only "Forgot your password?" on screen. Fixed in PR #6; awaiting re-verification. |

### The one defect the phone found, and why nothing else could

`min-h-dvh` sized the shell to the **largest** viewport — browser chrome retracted, keyboard
dismissed. Whenever the genuinely visible area is smaller than that, the difference is empty page
below the content, and empty page scrolls. `min-h-svh` is the **smallest** viewport, so the shell
never claims more height than is on screen.

Chromium's mobile emulation resolves `dvh`, `svh` and the visual viewport to the same number.
Measured directly on the deployment at a 375×812 viewport, `scrollHeight - clientHeight` was
exactly `0` — no overflow, nothing to find. The Playwright suite had run this page at an iPhone
viewport on every commit since M4 and was green throughout.

So the vertical-fit assertion added alongside the fix is deliberately labelled in the test file as
**not** a regression guard for this bug: it passed before the fix as well as after. It holds a real
invariant on every viewport the suite runs, and that is all it does. The guard for this class of
defect is a person with a phone, which is why this table exists and why the header above it says
emulation is not evidence.

---

## 2026-08-21 — A concrete two-binder scenario found a real cardinality mistake before real data existed

**Problem.** M6 needed to check DATA_MODEL.md's storage-location design against an actual scenario
before building the add-to-collection flow against it: the owner has two identical NM copies of a
card in Binder 1 and a third, equally identical, copy in Binder 2. `holdings_identity` correctly
merges all three into one holding — same variant, same condition, same grading state, nothing about
those three columns differs. But `holdings.storage_location_id` was a single column. One holding,
one location column, three copies split across two locations: unrepresentable.

**Investigation.** The document itself (§5.2) states the cardinality as "one per holding" without
qualification, and the M3 schema matched it faithfully. The question was not whether the code
matched the document — it did — but whether the document's own stated cardinality was actually
correct for a case a Pokémon collector will hit constantly (splitting a playset across a binder and
a trade box is closer to normal than exceptional).

**Finding.** It wasn't correct. A `holding` answers "what do I own, in what state" — variant,
condition, grading. Location is a fact about *where a specific batch currently sits*, which is
exactly what an `acquisition_lot` already models (a batch acquired together, at one cost, on one
date). The document's own §5.4 elsewhere says ordinary lot differences, not new holdings, are the
right place for variation that isn't a different physical state — location had just never been
checked against that rule.

**Consequence.** `storage_location_id` moved from `holdings` to `acquisition_lots` in the same
migration set that added the M6 schema (D-036), before any real collection data existed to migrate.
Same shape as M5's D-033/D-034 catalog-identity corrections, and the same lesson repeats: a schema
that has never been checked against a real physical scenario is a guess with good formatting, not a
verified design. `profiles.default_storage_location_id` needed no change — its role as a prefill
default survives the reinterpretation from "default holding location" to "default lot location"
without a column change.

---

## 2026-08-21 — Closing out the M5 key-exposure note without a session-invalidating overreaction

**Problem.** M5 recorded that `supabase projects api-keys`, run to fetch the anon key for local
dev, returned `pokeportfolio-dev`'s complete key set — including the legacy `service_role`
secret — into that session's transcript. Not requested, not used, not stored, not committed
(verified by the M5 session itself), but present, and HANDOVER.md's standing position was that the
owner should consider rotating it as a precaution. M6 was the milestone that actually closes that
out, since it is the first to write real (if still synthetic-in-CI) user collection data.

**Investigation.** The obvious mitigation — rotate the JWT signing secret, the historical way to
invalidate a leaked `service_role` value — was checked against current Supabase documentation
rather than assumed. It would invalidate *every* issued user JWT project-wide, not just the
service-role credential, because the signing secret underlies all of them. For a value that was
never actually used or persisted anywhere, forcing every invited user to sign in again is a
disproportionate response to research first, not a default to reach for.

**Finding.** Supabase's current migration path (verified 2026-08-21, not assumed from the M4/M4.1
session's note that the migration existed) replaces the legacy `anon`/`service_role` JWT pair with
named `sb_publishable_…`/`sb_secret_…` keys. Both can be created alongside the legacy pair without
disturbing it; Edge Functions receive the new secret automatically via a `SUPABASE_SECRET_KEYS`
JSON map, no redeploy required for the injection itself, only for the function code that reads it;
and legacy keys can be **deactivated** rather than deleted — reversible, and does not invalidate
issued user sessions, because API-key authentication and JWT signing are different mechanisms
layered on top of each other.

**Consequence.** D-039. The command that caused the original exposure
(`supabase projects api-keys`) is never run again — new-key creation is a dashboard action the
project owner performs directly. `supabase/functions/_shared/service-key.ts` prefers
`SUPABASE_SECRET_KEYS`, falling back to the legacy variable only for the local stack, which has not
changed and still emits only the old pair. The frontend env var renamed from
`VITE_SUPABASE_ANON_KEY` to `VITE_SUPABASE_PUBLISHABLE_KEY`. Legacy keys are deactivated only after
the new pair is verified working end to end against the real deployed project — never assumed
correct from a green CI run alone, the same discipline SECURITY.md §13's deployment gate already
demanded for anything touching auth, policies or grants.

---

## 2026-08-21 — The privilege-baseline convergence check pointed at a filename, and filenames get stale

**Problem.** SECURITY.md §5.9 already named this as a known fragility after M5: CI's hostile-grant
convergence step re-applies "the baseline migration" by a hardcoded filename
(`20260820157000_m5_privilege_baseline.sql`), and every milestone that adds a browser-reachable
table or function needs a new pure-privilege restatement — meaning the hardcoded filename goes
stale on exactly the milestone that needs the check to still work. M6 is that milestone: it adds
`manual_card_definitions`, `holding_tags`, `manual_valuations` and three RPCs to the browser-
reachable surface, and would have needed the same manual CI edit M5 needed relative to M4.1's file,
with the same risk of someone forgetting it on M7.

**Investigation.** The options considered: keep the hardcoded pointer and rely on remembering to
update it (the status quo, already flagged as fragile); teach the hostile-grant test to replay
every privilege-bearing migration in sequence (rejected in M5's own file header — replaying
migrations that also `CREATE TABLE` is not idempotent, so this was never actually available);
or select the baseline by a naming convention CI can discover on its own.

**Finding.** Every privilege-restatement migration this project has wri­tten is already named
`*_privilege_baseline.sql`, and migration filenames are timestamp-prefixed by convention — so a
plain lexicographic sort of that glob always yields the newest one, with no heuristic that could
guess wrong. The only new failure mode is the discovery step itself finding nothing, which is
distinguishable from every other failure and should stop the build rather than silently reuse
whatever the last successful run had.

**Consequence.** `.github/workflows/ci.yml`'s convergence step now does
`ls supabase/migrations/*_privilege_baseline.sql | sort | tail -n 1` and fails outright if the glob
is empty, instead of naming a file. Immutable historical migrations are untouched — this changes
only how CI *selects* the current one, not what any of them contain. A future milestone that adds a
browser-reachable object still needs its own new `*_privilege_baseline.sql` restatement (that part
was never the fragile step — `grant-audit.sql` and the checklist in SECURITY.md §12 already demand
it), but the CI wiring around it no longer needs a matching hand-edit.

---

## 2026-08-21 — Two more privilege bugs CI could not see, both caught by the real deployment

**Problem.** After M6's PR merged with CI green, the same two-layer pattern M4/M4.1 established —
CI proves reproducibility, only the real deployed project proves correctness — caught two more real
defects in the same session, neither of which any ephemeral-stack test could have found.

**Finding 1 — anon could call the new RPCs.** `add_card_acquisition`, `set_manual_valuation` and
`void_acquisition_lot` were reachable by an anonymous session on the real deployed project, despite
never being granted EXECUTE. Cause: PostgreSQL grants EXECUTE on a newly created function to
`PUBLIC` by default, and every role (`anon` included) automatically holds whatever `PUBLIC` holds —
a *separate* ACL entry from any grant made to a named role. `REVOKE EXECUTE ... FROM anon,
authenticated` (the M6 privilege baseline's blanket sweep) cannot touch it; only
`REVOKE ... FROM PUBLIC` can. This is the exact defect class M4 already found and documented
(`20260820120040_m4_explicit_function_revokes.sql`) — every other function-creating migration in
this project revokes from `public` at creation time, and these three new ones simply skipped that
step. Caught immediately by `tests/authorization/function_grants.test.ts`'s anonymous-caller case
the moment CI ran against a real ephemeral stack for the first time — not by the grant-audit (which,
by construction, only ever checks grants held by `anon`/`authenticated` by name, and structurally
cannot see a `PUBLIC` grant; this is a known limitation of that check, not a new one). Fixed in the
same migration that created the functions, matching the established M4 pattern exactly.

**Finding 2 — account deletion failed on two new tables.** Running the real add-to-collection flow
against `pokeportfolio-dev` with synthetic accounts (M6 prompt §98) and then cleaning them up, the
cleanup itself failed: `manual_valuations_user_id_fkey` had no `ON DELETE` action.
`holding_tags.user_id` carried the identical defect. This is the same class of bug M4 fixed for the
original eight `user_id -> auth.users(id)` references (PROJECT_JOURNAL.md, 2026-08-20) — these two
new M6 tables just didn't inherit the fix, because nothing re-derives "does every FK to auth.users
cascade" from first principles each time a table is added; it has to be remembered per table. No
existing test asserted account-deletion cascade behaviour at all — SECURITY.md §8's promise had
never actually been exercised by CI for *any* table, only fixed once by hand in M4. Fixed with a
migration restoring `ON DELETE CASCADE` on both columns, verified by actually deleting the synthetic
accounts against the real project (cascaded cleanly, zero orphaned rows, checked directly), and a
new regression test (`tests/db/m6_constraints.test.ts`, "account deletion cascades every M6 table")
that creates a user, gives it one row in every M6 table, deletes it, and asserts nothing survives —
the first such test in the suite for any table, not just the two this incident touched.

**Consequence.** Both are one-line-per-defect fixes with an outsized lesson: a rule enforced once,
by hand, at the moment it was discovered (M4's cascade fix; the "revoke from public" convention)
does not propagate to new tables on its own. Nothing mechanical currently re-checks "does every new
`user_id -> auth.users(id)` FK cascade" or "did every new function get revoked from PUBLIC" across a
whole migration the way `grant-audit.sql` mechanically re-checks the *table/column* privilege
surface. Worth a real check in a future milestone, rather than trusting memory a third time.
