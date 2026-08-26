# Engineering Journal

A factual record of problems solved and choices made, written for someone reading this
repository later to understand what was actually engineered.

Not a changelog ([CHANGELOG.md](../CHANGELOG.md) covers releases) and not a work log. Entries go
here when there was a real problem with a non-obvious answer.

---

## 2026-08-26 — M15 integration: three findings from letting reality vote

1. **npm reality overrode the researched core pin.** The M15 architecture research pinned
   `tesseract.js-core` 6.1.2 alongside tesseract.js 7.0.0. Installing revealed v7 declares its
   own core dependency as `^7.0.0` and its worker feature-detects a relaxed-SIMD LSTM core that
   only exists in core 7 — pairing the v7 worker with 6.x assets would have been a silent
   version mismatch resolved only by runtime failure on device. Pinned 7.0.0 exactly and
   recorded the supersession in D-094 and SCANNER_RESEARCH §7. Lesson restated: "pin exact
   versions" must include verifying the dependency GRAPH the pin produces, not just that each
   package exists at that version.

2. **Staging >2 MB static assets under `public/` hard-fails `vite build`.** Workbox's default
   precache ceiling (2 MiB per file) turns every ~3.9 MB OCR core into a fatal "won't be
   precached" build error, so the branch could not even run its gates until an explicit
   `globIgnores` exclusion existed. The exclusion is one line but it lives squarely in P69's
   service-worker-policy territory; it is marked as such in vite.config.ts and flagged for P71
   conflict review rather than silently absorbed. Practical rule: any future feature that
   vendors large static files must plan its service-worker interaction at the same time as the
   vendoring script.

3. **The local DB suite is single-shot against a persistent stack.** Running `pnpm test:db` a
   second time without an intervening reset produced 35 fixture collisions
   (`cards_set_id_local_id_key`): several suites insert fixed-local_id catalog rows under the
   shared seed set and never delete them, which is fine for CI's fresh ephemeral stack and for
   ONE local run after a clean reset, but not for back-to-back runs. A clean
   `supabase db reset` plus a single run reproduced the recorded 578/0/1 green gate exactly.
   Not a product bug; recorded so the next session does not chase phantom regressions the way
   this one briefly did.

---

## 2026-08-24 — Three implementation-blind sources met for real: what first contact actually found

**Problem.** M13 ran as three parallel sessions: an export core, a UI/delivery layer and an
independent adversarial contract package written without reading either. The integrator's job was to
bind them — expecting `[M13 CONTRACT]` failures "for the right reasons" — without weakening any
oracle merely to get green.

**What first contact actually produced.** On a machine with no Docker the gated suite skipped
entirely: its gate checks for a Supabase stack *before* it looks for an implementation, so even the
pure capability bindings never executed locally. The binding work therefore happened against the
real surfaces by reading, then activated in CI's ephemeral stack where both gates pass:

1. The version constant `BACKUP_SCHEMA_VERSION` didn't match the oracle's name regexes; the CSV
   writer's `(header, rows)` signature didn't match a single-matrix probe; there was no zero-arg
   backup builder that could run unauthenticated. Each got a deliberate, documented binding —
   including a bound runner that creates a real synthetic account via the invitation flow and drives
   the real fetch/build/serialize pipeline under a real JWT.
2. The core had named its sections `profile` and `sealed_products_user_created`; the oracle's
   inventory is keyed by canonical table names. Rather than teach the oracle special cases, the
   implementation was renamed (`profiles`, `sealed_products`) so section names equal table names —
   which also made restore-side iteration mechanical.
3. Two genuine policy contradictions surfaced exactly as the integration brief predicted: the draft
   claimed "additive optional keys do not bump schema_version" while its validator refused unknown
   keys (incoherent), and the oracle warned on unknown sections while v1 should refuse them. One
   rule was chosen and both sides aligned: strict v1, evolution only through version bumps.

**The lesson worth keeping.** Implementation-blind testing paid for itself — but only because the
integration treated skip-reasons and naming divergences as findings rather than noise. The two
silent-truncation failure modes the pagination oracle demonstrated became real code
(`pagination-integrity.ts`: count reconciliation + duplicate detection) instead of a comment; the
mislabelled "keyset" pagination was corrected to offset-with-reconciliation in docs before anything
else touched them.

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

---

## 2026-08-22 — Closing the PUBLIC-EXECUTE check this journal's own previous entry flagged

**Problem.** The 2026-08-21 entry above ended by naming the gap explicitly: "did every new function
get revoked from PUBLIC" had no mechanical check, only the M4 convention of remembering to add
`revoke ... from public` at every function's creation. M7 was the first milestone since that entry
to add anything to the browser-reachable surface (`portfolio_counts`, `list_portfolio`), so it was
the first real opportunity to close the gap rather than just remembering the convention a fourth
time.

**Finding.** `scripts/grant-audit.sql`'s `actual_routine`/`expected_routine` CTEs only ever compared
grants held by `anon`/`authenticated` — looked up via `aclexplode(...)::regrole::text in
('anon','authenticated')`. PUBLIC's ACL entry has grantee oid `0`, which does not cast to a real
`regrole` at all, so it was structurally invisible to that filter, not merely unchecked by
oversight. A second CTE matching `a.grantee = 0` directly (bypassing the `::regrole` cast
entirely) is what makes the check possible, and it needed to be a genuinely separate CTE rather
than an extra `OR` branch on the existing one, since the two use different comparison mechanics.

**Verification.** Re-derived the check from first principles rather than trusting it would work:
`tests/db/sql/hostile_grants.sql` now also runs `grant execute on all routines in schema public to
public` as part of its hostile-state setup, with a same-file sanity assertion (querying
`pg_proc.proacl` directly for a known function, the identical technique the audit itself uses)
proving the hostile grant actually took effect before the convergence test relies on it. This
follows the exact "make the database wrong first, prove the check rejects it, prove the baseline
fixes it" shape TESTING.md §7a already established for the named-role surface — the same audit
methodology applied to a hole that methodology had previously missed.

**Consequence.** Every routine in `public` — twenty-plus functions across five milestones — is now
swept clear of PUBLIC's implicit grant in the M7 privilege baseline. The sweep itself only touches
grantee oid `0`, never a named role's own ACL entry, so no *named* grant was removed by this
change — but that turned out not to be the whole story, because `search_cards` had never held a
named `service_role` grant at all and was relying on PUBLIC for that access. See the next entry:
this was believed verified when written, and CI's first real run proved otherwise within the hour.
`alter default privileges ... revoke execute on functions from public` means a future migration
that forgets the per-creation revoke no longer needs to be remembered at all for this specific
failure mode — the default itself changed. See DECISIONS.md D-042.

---

## 2026-08-22 — Closing the PUBLIC gap immediately exposed the dependency it had been masking

**Problem.** The entry above claimed the PUBLIC-EXECUTE sweep was "verified: ... none of them lost
any grant a named role actually needs" — reasoned through by inspecting every migration's grant
statements, not by running anything, because this machine has no local Docker. Pushing the branch
and letting CI's ephemeral-stack `db-tests` job actually apply the migrations and run the suites,
for the first time, failed both CI jobs. The gap between "reasoned through" and "actually run" was
exactly the size of three real bugs.

**Finding 1 — `search_cards` had been PUBLIC-callable by omission, not by design, since M5.**
`tests/db/search_cards.test.ts` calls `search_cards` through the **service-role** client — a
deliberate choice, since that file is about functional correctness ("do the right rows come back"),
not access control, which lives in `tests/authorization/catalog.test.ts` instead. But
`search_cards` was never explicitly granted to `service_role` in any migration; `authenticated` was
the only named grant it ever had. It worked anyway, for over a year of this project's own
milestones, purely because PostgreSQL's implicit PUBLIC-EXECUTE default meant `service_role` — like
every other role — could call it regardless. The M7 sweep revoked that default for real, and the
very next CI run turned "works by accident" into `permission denied for function search_cards`, on
every single one of that file's 16 tests. Fixed by making the grant explicit
(`to authenticated, service_role`) — the correct, deliberate version of the access that was already
happening, not a widening of anything.

**Finding 2 — a real RLS bug in `custom_collection_members`, not a test artifact.**
`custom_collections.user_id` and `manual_card_definitions.user_id` both default to `auth.uid()`, so
a client insert that only supplies the columns it actually knows about (never `user_id`) still
satisfies `WITH CHECK (user_id = auth.uid())`. `custom_collection_members.user_id` was written
without that default — an oversight, not a deliberate choice; nothing in DATA_MODEL.md's own
specification asked for the two tables to behave differently. The result: `src/data/
customCollections.ts`'s `addHoldingToCollection` — real application code, not a fixture — would
have failed for every real user the moment it ran, rejected by RLS with a NULL `user_id` rather
than the NOT NULL constraint one might expect, because Postgres evaluates the policy's `WITH CHECK`
expression against whatever value ends up in the row, and NULL simply fails the equality check
rather than tripping a separate error path. Caught by
`tests/authorization/m7_portfolio.test.ts`'s own CRUD test, which does exactly what the real UI
does (an authenticated client, no explicit `user_id`) rather than the service-role shortcut most
fixtures use. Fixed with `default auth.uid()`, matching the other two tables. Inspection of just
`20260821120030_m6_holding_tags.sql` suggested the identical bug existed in M6's already-shipped
`holding_tags` table, and this entry originally flagged that as a separate follow-up — **wrong**,
corrected below (2026-08-22, "A bug report built on an incomplete inspection").

**Finding 3 — a self-inflicted test bug, included here because it looks identical to a real one
until inspected.** `tests/db/m7_constraints.test.ts`'s `createHolding()` helper used one fixed
`(seedCatalog variant, condition)` pair for every call. Two different `it()` blocks calling it for
the same synthetic user collided on `holdings_identity`'s partial unique index — a correct
rejection of a genuinely duplicate identity, not a schema defect. Distinguishable from Findings 1-2
by the error itself (`duplicate key value violates unique constraint`, not a permission or RLS
error) and by which file changed to fix it (the test's own fixture, not a migration). Fixed by
creating a fresh `manual_card_definitions` row — guaranteed unique — per call instead.

**Consequence.** All three fixed in one follow-up commit on the same PR (#14); CI's second run
passed both jobs, 269/269 database and authorization tests (up from 251 at the M6 merge). The
lesson restates one this journal has recorded before, in a new shape: reasoning carefully about SQL
from first principles is necessary but is not the same claim as "this has been run," and the
gap between those two claims is exactly where bugs live. A machine without Docker does not get to
skip that gap — it just moves the first real run from a local terminal to CI, which is precisely
what happened here.

---

## 2026-08-22 — CI green is not the same claim as fast, and the 10,000-lot gate proved it

**Problem.** CI's `db-tests` job proved `list_portfolio`/`portfolio_counts` *correct* — 269/269
tests passing against an ephemeral stack seeded with a handful of rows. It says nothing about
whether either function is fast enough to be usable at the scale M7's own gate names explicitly:
10,000+ lots, staying interactive on a phone (M7 prompt §53/§57, ROADMAP.md's M7 gate). That
requires actual data at that scale, which only exists once seeded — so this was checked directly
against `pokeportfolio-dev` with a real, isolated, disposable synthetic account rather than
assumed from CI's green checkmark.

**Finding.** Seeded 7,500 holdings and 10,109 acquisition lots (real duplication, five conditions,
tags, storage locations, custom-collection membership) for one throwaway `.invalid` account, then
called `list_portfolio` across every sort mode and `portfolio_counts()` exactly as the deployed app
would. Results: 5.5-8 seconds per call, and two sort modes — including `value_desc`, the *permanent
default* — failed outright with `57014 canceling statement due to statement timeout`. Root cause:
both functions computed each holding's aggregate quantity via `LEFT JOIN LATERAL (select sum(...)
... where l.holding_id = h.id) q on true` — a correlated subquery that PostgreSQL must re-evaluate
once per outer row, forcing a nested-loop plan across 7,500 holdings. `holding_summaries` (M6) had
already solved the identical problem correctly, using a plain `LEFT JOIN ... GROUP BY` instead —
that shape lets the planner choose a hash join and a single hash-aggregate pass over both tables,
touching each once rather than probing `acquisition_lots` once per holding. Neither M7 function
followed that precedent; both were written with LATERAL because it reads slightly more directly as
"the aggregate for this row," and nothing surfaced the performance difference until data at real
scale existed to measure it against.

**Fix.** Rewrote both functions' aggregation as a `MATERIALIZED` CTE using the same
`LEFT JOIN ... GROUP BY` shape as `holding_summaries`, restricted to the caller's own holdings
before the join to `acquisition_lots` even happens. Every filter, cursor comparison and ORDER BY
expression is unchanged — only how the aggregate columns are computed. Re-measured against the
*same* seeded data (no re-seed needed, proving the fix in isolation): every sort mode, the filtered
query, and the keyset second page all completed in 130-570 ms; `portfolio_counts()` dropped from
~5.4 s to ~140 ms after its own first (plan-caching) call. `20260822120030_m7_portfolio_query_perf_fix.sql`,
`20260822120040_m7_portfolio_counts_perf_fix.sql`.

**A second, unrelated bug surfaced while cleaning up.** Deleting the synthetic benchmark account
afterward failed with a foreign-key violation: `custom_collection_members.user_id` referenced
`auth.users(id)` with no `ON DELETE` action. This is the third time this exact defect class has
been found — M4 fixed it for the original eight `user_id` columns, M6 fixed it again for
`holding_tags`/`manual_valuations`, and this session's own custom_collections migration got
`custom_collections.user_id` right (`on delete cascade`) but missed its sibling table's identical
column. Fixed (`20260822120050_m7_custom_collection_members_cascade_fix.sql`), verified by actually
deleting the synthetic account a second time (succeeded, zero residue across holdings, lots,
collections and memberships, checked directly), and a new regression test added
(`tests/db/m7_constraints.test.ts`, "account deletion cascades every M7 table") matching the
pattern M6 established for exactly this failure mode.

**Consequence.** Three real findings from one deliberate real-infrastructure test that CI could not
have produced (CI never seeds 10,000 rows, and ephemeral accounts are usually deleted with almost
nothing attached to them): a severe, gate-failing performance defect in the milestone's single most
important query, and a second instance of a defect class this project has now hit three times.
The recurring shape across M4/M6/M7's cascade misses — a rule fixed once, by hand, at the moment
it was found, that does not propagate to the next new table — is the same lesson the 2026-08-21
entry already named as worth a mechanical check rather than memory. It remains unbuilt; this entry
is the third data point arguing for it, not a fourth attempt to fix it by remembering harder.

## 2026-08-22 — A CSP gap named in a code comment three milestones ago, closed only once a real screen needed it

**Problem.** `vite.config.ts`'s Cloudflare-headers plugin has restricted `img-src` to
`'self' data: blob:` since M4 introduced the generated Content-Security-Policy, with a comment
added at M5 reading: "No external image host yet. M5's card artwork comes from the TCGdex CDN and
will need that origin added here — deliberately, not by loosening this to `https:`." M5 and M6
never actually rendered a `<img>` pointed at that CDN (search results and holding detail showed
text/metadata only), so the gap the comment predicted stayed theoretical through two milestones of
CI passing. M7 is the first milestone that renders real card artwork — search results and Portfolio
grid tiles — and nobody revisited the comment when that code was written, because the CSP is not
part of what `pnpm build`, `pnpm test`, or CI's `build-and-test`/`db-tests` jobs exercise: `_headers`
is a Cloudflare Pages-only file, ignored entirely by `vite dev` and `vite preview`.

**Finding.** Only surfaced by browser-verifying the actual deployed `pokeportfolio-dev.pages.dev`
build after merging PR #14 — every `assets.tcgdex.net` image request was blocked at the browser
level with `Refused to load ... violates ... "img-src 'self' data: blob:"`, console-visible but
silent in the UI (the grid tile's text fallback rendered instead, so nothing *looked* broken enough
to demand investigation without actually opening devtools). This is exactly the failure mode the
original comment worried about avoiding by naming an explicit origin rather than loosening to
`https:` — except the origin was never added, so the restriction just quietly ate the feature it
was protecting against loosening.

**Fix.** Added `https://assets.tcgdex.net` to `img-src` explicitly (docs/API_SOURCES.md's
documented image CDN host), still not `https:` generally. `fix/m7-csp-image-host`, PR #15. Verified
by building locally with a placeholder `VITE_SUPABASE_URL` and confirming the generated
`dist/_headers` CSP string included the new host, then re-verified against the live deployment
after merge and a Cloudflare rebuild — card artwork now loads with zero console errors.

**Consequence.** A security header is exactly the kind of configuration M4's own journal entry
already named as "correct where it was written and wrong where it ran" — except here the risk ran
the other way: not a hole opened, but a legitimate feature silently disabled by a restriction
nobody has any automated way to notice going stale, because the thing that would notice (an actual
browser loading an actual deployed page) is precisely the step CI cannot perform. The standing
lesson is the same one M5/M6/M7's deployment checklists already encode — browser-verify the live
build, not just CI — reinforced here because this is the first time that step, rather than a
database script, is what found the bug.

## 2026-08-22 — A bug report built on an incomplete inspection

**Problem.** The 2026-08-22 entry above ("Closing the PUBLIC gap...") claimed, based on reading
`20260821120030_m6_holding_tags.sql` alone, that `holding_tags.user_id` had the same missing-default
defect as `custom_collection_members.user_id` and flagged it as a follow-up. A later report repeated
that claim in more detail, reasoning from the same single migration file: `user_id uuid not null
references auth.users (id)`, no default, and `src/data/collection.ts`'s `setHoldingTags()` inserting
`{ holding_id, tag_id }` without `user_id` — which does look like exactly the shape that fails RLS.

**Finding.** It does not fail. `20260821120070_m6_user_id_defaults.sql`, committed later the same
M6 milestone, already runs `alter table public.holding_tags alter column user_id set default
auth.uid();` alongside the identical fix for `storage_locations` and `tags`. Both the original
follow-up flag and the later report read only the table's `create table` statement and never
checked whether a subsequent migration in the same milestone touched the same column — an
incomplete inspection producing a false positive, the mirror image of this project's more usual
failure mode (reasoning that turns out right only once something actually runs). Confirmed directly
against the live project before writing this entry: `select column_default from
information_schema.columns where table_name = 'holding_tags' and column_name = 'user_id'` returns
`auth.uid()` on `pokeportfolio-dev` right now.

**What was real.** The suspicion was not baseless — it was the *correct* generalization from the
`custom_collection_members` finding, checking a sibling table for the identical defect class,
exactly the instinct that has caught real bugs elsewhere in this project (the M4/M6/M7 cascade
misses). It just needed one more `grep` before being reported as fact. And a genuine, smaller gap
sat underneath the false one: no authorization test exercised a real authenticated-client insert
into `holding_tags` relying on that default — every existing test either uses the service-role
client (`tests/db/m6_constraints.test.ts`'s ownership-trigger tests, which bypass RLS) or supplies
`user_id` explicitly. `tests/authorization/coverage.test.ts`'s `COVERED_TABLES` comment claimed
`holding_tags` was covered by `m6_collection.test.ts`; it was not, until now. Added the missing
test there, matching the shape `m7_portfolio.test.ts` already uses for `custom_collection_members`.

**Consequence.** No migration needed — the fix already exists and is already deployed. The real
takeaway is procedural: a claim about schema state is a claim about the *current* state of every
migration file touching that column, not just the one that created it, and "already fixed
elsewhere in the same milestone" is a real, recurring shape in this project's own history (this is
the second time — see 20260821120070 itself fixing three tables' defaults in one pass). Checking
the live database directly, rather than trusting a file read, is what caught this before a
redundant migration shipped.

## 2026-08-24 — M8: two more user_id-default-class gaps, and a void scope bug that only mattered once purchases got a second line

**Problem 1.** `retailers.user_id` had no `default auth.uid()` since M3 — the same defect class as
the `storage_locations`/`tags`/`holding_tags` gaps M6 already found and fixed
(`20260821120070_m6_user_id_defaults.sql`), just on a fourth table nothing had exercised yet.
`retailers` shipped in the same M3 migration as `storage_locations`/`tags` but was not in scope for
M6's fix, because nothing in M6's UI created a retailer directly from the client — M8's own
`src/data/retailers.ts` is the first code path that does. Found by writing that code and hitting a
`null value in column "user_id" violates not-null constraint` against a real Supabase stack, not by
inspection. Fixed the same way as the M6 precedent:
`20260824120005_m8_retailers_user_id_default.sql`.

**Problem 2.** `purchases.retailer_id` had no ownership-check trigger at all, on any migration,
since M3. The foreign key only proves the referenced row exists, not that it belongs to the same
user — exactly the "inserting a child row pointing at another user's parent" attack SECURITY.md
§3.3 already lists, just against a column nothing had ever set to a client-supplied non-null value
before M8. `add_card_acquisition` (M6) never touches `retailer_id` at all. Found while writing the
cross-tenant authorization test for `create_purchase`'s `p_retailer_id` argument — asked "what
actually stops this" and the honest answer was nothing. Fixed with a new
`purchases_check_retailer_owner()` trigger, the same `*_check_owner()` shape
`acquisition_lots_check_owner`/`holdings_check_manual_card_owner` already use
(`20260824120007_m8_purchases_retailer_owner_check.sql`).

**Problem 3, a real logic bug rather than a missing-default gap.** `void_acquisition_lot`'s
auto-void-the-parent-purchase check (M6, `20260821120050_m6_add_card_acquisition.sql`) counted
other live lots citing the *same purchase line* before deciding to void the whole parent purchase.
That is correct only because every purchase M6 could create has exactly one line. Once M8 makes a
real multi-line purchase possible, the same check would have voided an entire multi-card receipt
the moment the *first* of its several lines' lots was individually voided via the pre-existing
per-lot void control on the holding detail page — silently erasing the other lines' spend from
`GPO`/`CS` as a side effect of correcting one card. Found by design review while writing M8's own
`void_purchase` (asking "does the existing void path already handle this correctly for more than
one line" rather than assuming M6's version generalized), not by a failing test — there was no test
for it because no multi-line purchase could exist before this milestone. Fixed by widening the
check to count live lots anywhere in the whole parent purchase
(`20260824120010_m8_purchase_ledger.sql`), a strict generalization that leaves every existing
single-line purchase's behaviour unchanged, and added a regression test
(`tests/db/m8_purchase_ledger.test.ts`, "void_acquisition_lot: parent-purchase scope corrected")
that creates a two-card-line purchase, voids one lot, asserts the purchase is still live, voids the
second, and asserts it now voids.

**Consequence.** All three are the same underlying lesson stated three ways: a code path that has
never been exercised by real client input is not verified by the mere fact that CI has been green
around it. M3's `retailers`/`purchases.retailer_id` and M6's `void_acquisition_lot` were each
written correctly for the traffic that existed at the time they shipped; none of the three had a
test that could have caught the gap, because the gap only exists once a *different* milestone's
code starts calling them a *different* way. The standing mitigation is the one this project already
follows elsewhere (M4/M6/M7's own findings): when a milestone is the first to actually exercise an
existing table or function from a new angle, re-derive whether its existing guarantees still hold
for that angle — do not assume "it shipped before, so it was checked."

---

## 2026-08-26 — A performance fix silently reverted itself the next time the function had to be rewritten

**Problem.** M9 needed to rewrite `list_portfolio`'s body regardless (to add the resolver join), so
before touching it, its current shape was read in full rather than assumed. It still had the
`join lateral (select sum(...) ... where l.holding_id = h.id) q on true` per-holding aggregate the
real M7 10,000-lot benchmark had already found forces a nested-loop plan — the exact defect
`20260822120030_m7_portfolio_query_perf_fix.sql` fixed, measured at 130-570 ms afterward.

**How it came back.** M7.1's number-sort feature (`20260823120010_m71_number_sort.sql`) added a
new parameter to `list_portfolio`. Postgres identifies a function by name *and* argument types, so
`CREATE OR REPLACE` cannot add a parameter — it silently creates a second overload instead of
replacing the first, which then fails at call time with "function is not unique." The correct fix
(`DROP FUNCTION` with the exact old signature, then `CREATE FUNCTION`) is what that migration
correctly did. But dropping and recreating means retyping the entire function body from a source
other than "diff against the previous version" — and the version that got retyped was, in effect,
reconstructed from the pre-perf-fix mental model, not from the actually-shipped
`with lot_agg as materialized (...) group by h.id` shape. `portfolio_counts()` was untouched by
M7.1 (its own signature never changed), so it kept the correct shape the whole time — the
regression is specific to the one function whose signature happened to change.

**Nothing caught it for three milestones.** CI's ephemeral fixtures are far too small to make a
nested-loop plan visibly slow; the difference only shows up against thousands of rows, which is
exactly the scale CI deliberately does not seed (that is what `scripts/portfolio-perf-benchmark.mjs`
against a real project is for, and nobody re-ran it between M7.1 and M9).

**Fix.** Restored the materialized-CTE shape in the same M9 migration that already had to rewrite
`list_portfolio`'s body for the resolver join (`20260826120030_m9_list_portfolio_resolver.sql`),
rather than filing it as a separate bug report. Recorded as DECISIONS.md D-054.

**The generalizable lesson.** A migration that must `DROP`+`CREATE` a function for a reason
unrelated to its performance-critical internals (a new parameter, a new return column) is exactly
the moment a previous performance fix can silently regress, because the whole body is being retyped
by hand rather than edited surgically with a diff against what shipped. The standing mitigation:
when a `DROP FUNCTION`/`CREATE FUNCTION` pair is needed for an unrelated reason, read the *current*
migration file in full first — not a summary, not a memory of what it should contain — and carry
forward any non-obvious shape (a materialized CTE instead of the naive join, an index hint, a
specific `FILTER` clause) explicitly, the same discipline PROJECT_JOURNAL.md already recommends for
re-deriving guarantees when a new caller exercises existing code from a new angle.

---

## 2026-08-26 — Real TCGdex pricing payloads disagreed with each other about where a variant's price lives

**Problem.** M9's price-mapping adapter needs to attach a Cardmarket/TCGplayer price to the *exact*
`card_variant` it belongs to — finish, stamp, subtype, size (D-033) — never a guess, because a wrong
price on the wrong printing is worse than no price at all (prompt §15).

**Investigation.** Rather than designing the mapper from the API_SOURCES.md description alone, five
real cards were fetched live and inspected field-by-field: a Base Set Charizard (multiple declared
variants, only one carrying real embedded pricing), a Sword & Shield-era common (`swsh1-2` Roselia:
no embedded pricing on *any* variant, both `variantId: "generated"`), a Scarlet & Violet common
(same card-level-only shape), and a Basic Energy card with six declared variants
(`sve-001`) where the plain "reverse, no stamp" printing and a professor-program-stamped sibling
both carried their *own* distinct Cardmarket `idProduct` — genuinely different products despite
looking identical at the finish/subtype level TCGdex's boolean flags alone would suggest.

**Finding.** Two incompatible-looking pricing shapes both occur on real cards, not as an edge case
but as the *common* case for one of them: (1) `variants_detailed[i].pricing`, present and
variant-scoped, when TCGdex has bothered to assign it — the least ambiguous evidence available; (2)
the card-level top-level `pricing` object, the *only* source for an ordinary modern normal/reverse
card, where Cardmarket carries just two slots (base fields for "normal", `-holo`-suffixed fields for
whichever *one* non-normal finish exists) and TCGplayer is keyed by named finish bucket. The
Charizard payload also proved the card-level `-holo` fields can belong to a Cardmarket product that
matches *none* of the card's own declared variants — real, observed, not a hypothetical worry.

**Consequence.** The mapper (`_shared/tcgdex.ts`'s pricing section) tries embedded pricing first,
and falls back to the card-level fields only when the ambiguity checks pass (exactly one variant of
the relevant finish exists); anything else resolves to no price. All five real payloads are locked
in as regression fixtures (`tests/data/tcgdex-pricing.test.ts`) so a genuine upstream shape change
would fail a specific, real assertion rather than only being noticed in production.

---

## 2026-08-27 — Two real bugs M9.1 introduced and caught before merge, neither of them by CI

**Problem 1: a stale `grant-audit.sql` entry.** `get_market_movers` needed a new `p_sort` parameter
(M9.1 prompt §21), which changes the function's identity — a signature-changing `DROP`+`CREATE`,
the exact defect class D-054/TESTING.md §6a already exists to warn about. `scripts/grant-audit.sql`
still listed the old two-argument overload. CI's `db-tests` job caught it immediately and correctly
— `MISSING routine ... EXECUTE get_market_movers(integer, integer, market_mover_sort)` — exactly
the reproducibility gate working as designed (TESTING.md §10's "CI is a reproducibility gate"
principle). Fixed by updating the audit's expected-signature string to match.

**Problem 2: `fx_rates.rate` silently is a JSON number, not a decimal string, over a plain
PostgREST `select`.** `search-prices`'s new NOK-conversion code (prompt §10) read `fx_rates.rate`
via `db.from('fx_rates').select('rate')` and passed the result straight into a decimal-string
parser (`.replace('.', '')`, expecting text). This is *not* a hypothetical: every M9 SQL function
that returns a money- or rate-shaped value explicitly casts it to `text` in its final `SELECT`,
specifically because PostgREST serializes `numeric` columns as JSON numbers by default — the exact
boundary rule DATA_MODEL.md §17 already documents for money columns returned from a function. A
plain table `select()` (as opposed to an RPC call) has no such cast, so it hits the same boundary
without the guard. Calling `.replace()` on a JS number throws at runtime — every `search-prices`
invocation would have 500'd, silently degrading every Search and Card Detail price to "—" (the
frontend already swallows pricing failures, DESIGN_SYSTEM.md's honesty rule doing its job as a
safety net but masking the underlying bug completely). Not caught by CI: `db-tests` never invokes
Edge Function business logic, only the database and authorization suites. Found by re-reading the
diff against the established "cast money to text" convention rather than by any test.

**Consequence.** Fixed with an explicit `.toString()` at the read boundary — the identical
conversion `src/data/fx.ts`'s client-side equivalent already needed for the same reason (also found
and fixed during this session, before it ever shipped). No regression test exists for Edge Function
business logic in this codebase yet (`tests/data/tcgdex-pricing.test.ts` covers only the pure
mapping layer, not the HTTP handler) — a real, disclosed gap, not silently accepted: a future
session adding meaningful Edge Function test coverage should start with this exact boundary class,
since it is now confirmed to bite in practice, not just in theory.

## 2026-08-22 — The 10k-lot Portfolio "regression" was the benchmark measuring the wrong moment, not a defect in the query

M9.1 left a real, disclosed gap: `list_portfolio`'s unfiltered first-page query hit 4-7.6s across
three CI runs and one genuine statement timeout, while `portfolio_counts()` — calling the identical
`resolve_variant_market_values` resolver with the identical variant array — stayed fast (26-90ms).
That contrast was the whole basis for suspecting `list_portfolio`'s own ~12-branch CASE-based
`ORDER BY`/cursor predicate as the differentiator. `force_generic_plan` (PR #28) tested that theory
and partly disproved it (filtered queries got worse, the unfiltered path stayed just as slow), but
the actual root cause stayed open into M9.2.

**Getting real evidence instead of guessing again.** `scripts/portfolio-perf-explain.sql` (new)
captures `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)` against the benchmark's own seeded account,
impersonating the synthetic user the same way Supabase's own stack does (`set role authenticated`
+ `set_config('request.jwt.claims', ...)`, session-scoped rather than transaction-scoped since
psql autocommits each statement in a plain `-f` script — a real mistake caught while writing this
script, not shipped: an earlier draft used `set local role`/`is_local=true`, which would have
reverted before the very next statement in the file ever saw it). Run twice by
`portfolio-perf-benchmark.mjs`: once immediately after the 10,000-lot bulk seed, once again after
an explicit `ANALYZE`.

**What CI's own real run showed (PR #30/#31).** Immediately post-seed, every one of the seven
tables `list_portfolio` touches had `pg_class.reltuples = -1` — Postgres's literal "never analyzed"
sentinel, because a fresh ephemeral instance's autovacuum worker had not run even once in the few
seconds between seeding and querying. In that state, `list_portfolio` measured 7.4-7.9s across
three repeated calls — matching the earlier finding — but **`portfolio_counts()` measured 7754ms in
the exact same cold state**, not the 26-90ms M9.1 recorded. That single number rewrites the whole
diagnosis: `portfolio_counts` was never architecturally immune to whatever this problem is; the
earlier benchmark run just happened to call it after enough other RPC round-trips had passed for
autovacuum to catch up, while `list_portfolio` (called first, and repeatedly, in that run's
sequence) got measured cold. `Buffers: shared hit` corroborates the mechanism directly: ~1.4
million shared buffer hits cold, collapsing to 649-3,367 after `ANALYZE` — the planner moving off
whatever plan a total absence of row-count information produces once it has real numbers to work
with. Post-`ANALYZE`, every one of the 12 supported sorts (3 repeated runs each) landed at
62-202ms, `portfolio_counts()` at 32ms, every filtered/scoped/keyset path 30-70ms — beating M7's
original 130-570ms baseline with real headroom.

**Decision:** no change to `list_portfolio` or `portfolio_counts`'s SQL (docs/DECISIONS.md D-059,
TESTING.md §45's "ANALYZE alone explains it" branch). The real fix is to the benchmark's own
methodology — it was measuring "milliseconds after a synthetic bulk insert, before autovacuum's
first cycle," not a state real production usage (incremental, one add or one purchase-import line
at a time) actually produces. `portfolio-perf-benchmark.mjs` now runs `ANALYZE` on the seeded
tables before timing anything, and — since this defect class has now recurred three times (M7's
LATERAL regression, M9.1's timeout, and this false lead) without CI ever failing on its own
benchmark, and representative statistics remove the reason it never did — now fails the CI step
outright if any call exceeds 1.5s or errors.

**The generalizable lesson:** a benchmark that bulk-seeds a large synthetic dataset and immediately
queries it is not measuring the application under representative conditions unless it also accounts
for planner statistics explicitly — autovacuum's eventual consistency is a fine assumption for real
usage patterns and a dangerous one for a benchmark's own artificial one. The next session that
writes a CI benchmark seeding more than a trivial number of rows into a table it is about to query
should run `ANALYZE` first, on purpose, rather than rediscover this the same way this session did.

---

## 2026-08-28 — Two tables DATA_MODEL.md had described for milestones that never revisited them

**Problem.** M10 (Sales and History) needed to freeze an exact effective cost basis for a sale —
`unit_cost_basis` plus its share of any `lot_cost_adjustments` (grading fees etc., FINANCIAL_MODEL.md
§4.4/E6). Writing the RPC surfaced that `lot_cost_adjustments` did not exist as a table anywhere in
`supabase/migrations/`. DATA_MODEL.md §5.6 has documented its shape since M3, and M3's own scope
note explicitly deferred it alongside `lot_disposals`/`openings`/`trades`/`lot_transfers` — the
difference is that every one of those got picked back up by the milestone that needed it
(`lot_disposals` this same session; `openings`/`trades`/`lot_transfers` still correctly wait for
M16/M17/M18), while `lot_cost_adjustments` fell through: M6 wired the grading *fields* onto
`holdings` (grader/grade/cert_number) without also shipping the table those fields' financial
consequences were supposed to live in, and nothing since (M8, M9) needed to read it, so the gap
stayed invisible. Documentation describing a table is not evidence the table exists — this is the
second time in this project a review-by-reading-the-doc missed a real schema gap (the first was
M4's privilege-surface documentation matching intent but not the deployed database, HANDOVER.md's
"the thing most worth knowing before touching the schema").

**A second, related gap, found while writing the residual test for the same freeze.**
`acquisition_lots.residual_minor` (M6) keeps `quantity × unit + residual = attributable_cost` exact
in a lot's original currency, but `create_purchase`/`update_purchase` computed the *NOK-side* unit
cost with a plain floor division and never stored what it dropped. Invisible for every NOK-currency
purchase this project's synthetic fixtures have ever exercised (`attributable = attributable_nok`
exactly when `fx_rate = 1`, so the existing original-currency residual happened to cover it) — a
real, silent leak of up to `quantity − 1` øre only for a foreign-currency purchase of a
`quantity > 1` lot, a combination no existing test (financial, db, or authorization) had reason to
construct before a *sale* needed the exact NOK figure.

**Resolution.** Both closed as real, disclosed migrations rather than routed around:
`20260828115000_m10_lot_cost_adjustments.sql` creates the table to its documented shape, granting
`authenticated` `SELECT` only (no validated write path exists until M17's real "record a grading
submission" RPC — a bare `INSERT` grant today would let a user inflate their own cost basis by
citing any unrelated purchase line). `20260828110000_m10_lot_residual_nok_fix.sql` adds
`residual_nok_minor`, backfills it from each lot's own `purchase_lines.attributable_cost_nok_minor`
(the source of truth was already there, just not reconciled into a residual), and re-creates
`create_purchase`/`update_purchase` (same signature, no privilege churn) to compute it going
forward. Full reasoning, and the residual-consumption rule this unblocked (which of a lot's several
eventual disposals gets the leftover øre): DECISIONS.md D-060.

**The generalizable lesson:** when a milestone's own DATA_MODEL section describes a table, check
`supabase/migrations/` before assuming it shipped — a scope note deferring several tables together
does not mean every one of them gets picked up together later; each needs its own milestone to
actually need it before anyone notices it is still missing. Silent floor-division remainders are
the same lesson in miniature: they cost nothing until a feature needs the *exact* total, which is
usually much later than the code that dropped the remainder.

---

## 2026-08-28 — Freezing sale history genuinely needed a stronger privilege model than purchases had

**Problem.** M10's own prompt (§107) asked for something M8's purchase ledger never had to satisfy:
frozen cost basis, allocated amounts and realized result must be *unreachable* by a direct write
from the browser, not merely correct when written through the intended RPC. M8's
`purchases.total_nok_minor` is directly `UPDATE`-grantable to `authenticated`, because
`update_purchase` (SECURITY INVOKER, this project's default since M4.1) needs that grant to do its
own job — the accepted residual risk is a user corrupting their own private purchase row via a raw
PATCH, never a cross-tenant issue, and nothing in M8's prompt asked for more than that.

**Why the same shape doesn't satisfy M10.** A SECURITY INVOKER `update_sale` would need
`authenticated` to hold `UPDATE` on `sale_lines.cost_basis_at_sale_nok_minor` and
`realized_result_nok_minor` for its own legitimate write to succeed — which is exactly the grant
that would let a user rewrite their own realized profit/loss figure directly, no RPC involved. A
`CHECK` constraint can keep a row internally *consistent* (e.g. `realized_result = net_proceeds −
cost_basis`) but cannot stop a coordinated forgery that changes several columns to a
still-self-consistent, still-wrong story.

**Resolution.** `create_sale`/`update_sale`/`void_sale` are `SECURITY DEFINER` — the first RPCs in
this project's write surface to deviate from the INVOKER default, done under the exact escape hatch
the house rule names ("unless an actual documented requirement proves otherwise"). `authenticated`
now holds `SELECT` only on `sales`/`sale_lines`/`lot_disposals`, verified directly in
`tests/authorization/m10_sales.test.ts` (a same-owner direct `INSERT`/`UPDATE` is rejected
identically to a cross-tenant one — there is no privilege to exploit, not merely a check to defeat).
What replaces RLS/grants as the authorization boundary inside these three functions is the same
discipline every other RPC here already had: `v_user_id := auth.uid()` resolved once, every
subsequent statement filtered by it explicitly. The one precedent already in the codebase for this
exact pattern — `recompute_lot_quantity_remaining`, the D1 trigger — had already made the same call
for `acquisition_lots.quantity_remaining` a few migrations earlier in this same session, for the
identical reason (a column an attacker could otherwise use to "revive" already-sold inventory).

**The generalizable lesson:** SECURITY INVOKER's blast radius is bounded by whatever grant its own
writes need — which is fine right up until one of those columns is something a user must never be
able to set directly, at which point INVOKER cannot express the requirement at all, no matter how
careful the RPC's own validation is. Recognising that boundary before writing the grants (not after
an authorization test found a hole) is what made this a design decision instead of a late patch.

---

## 2026-08-29 — A schema sketched three milestones early was wrong in exactly the way "audit first" exists to catch

**Problem.** M11's prompt opened with an instruction that read, on first pass, like standard due
diligence: audit the real sealed-inventory schema before building UI on top of it, and specifically
test whether a holding-level `sealed_intent` column can represent a user who owns three identical
booster boxes with different plans for each — two kept sealed, one queued to open. It could not, and
the reason is worth recording because the schema in question had looked correct for three whole
milestones.

**Why it looked fine for so long.** `sealed_intent` was added to `holdings` back when `sealed_products`
and the rest of the sealed catalog shape were first sketched (M3), pulled forward the same way
`manual_valuations` and the `opening`/`trade_in` lot-origin values were (D-038) — infrastructure laid
early because a later milestone would need it, not because anything exercised it yet. Nothing did:
M6 through M10 never wrote to it, never read it, never built a single screen that depended on its
cardinality being right. A column can sit in a schema for months looking finished simply because
finished and untested are indistinguishable from the outside.

**What the audit actually found.** `holdings_identity` — the unique index stopping the same physical
state from fragmenting into duplicate holdings — correctly does *not* include `sealed_intent` in its
key, because intent is meant to be organisational, the same category as `storage_location_id`. But
that design choice has a direct consequence nobody had traced through: every acquisition lot for the
same sealed product/condition/grading-state combination collapses into one holding row, and a
holding-level `sealed_intent` column has exactly one slot for that entire position. `create_purchase`
(M8) had already been defaulting every new sealed holding's intent to `'undecided'` at creation and
silently leaving it there on every subsequent matching purchase — a real, reproducible bug, just one
nothing had ever surfaced because nothing had ever asked the question "what if two acquisitions of
the same product want different fates?"

**The fix, and why it wasn't a bigger one.** `sealed_intent` moved to `acquisition_lots`
(DECISIONS.md D-061) — the exact same relocation `storage_location_id` already went through in M6
for the identical structural reason (D-036), which made this feel less like inventing a new pattern
and more like finishing one the codebase had already established. The one genuinely new piece of
machinery is `set_sealed_lot_intent`, which splits a lot when an intent change covers only part of
its remaining quantity — a new sibling lot at the new intent, the original shrunk by the same
amount, both keeping the original's `unit_cost_basis_minor` untouched so the split is provably a
reorganisation and never a valuation event.

**A second, smaller bug the same audit pass caught before it shipped.** `create_purchase`'s
acquisition-lot INSERT had never set `sealed_intent` at all — it was written against the old,
holdings-level design and never touched again. Left as-is, the very first sealed purchase line under
the new not-null-when-sealed trigger check would have failed outright with no test having ever
called it out, because no existing test exercised a sealed purchase line's resulting lot row closely
enough to notice the missing column. Fixed in the same migration set, before any test was written
against it — caught by re-reading the function against the new trigger constraint, not by a failing
CI run.

**The generalizable lesson:** "pulled forward early" and "already correct" are not the same claim,
and a milestone that finally uses a three-milestone-old column owes it the same audit a brand-new
column would get — arguably more, since nothing has ever pressed on it. The M11 prompt's insistence
on testing the exact real-world scenario (three boxes, mixed intent) before writing a line of UI is
what turned a plausible-looking column into a found, fixed, and tested defect instead of a shipped
one.

## 2026-08-30 - The manual-valuation history audit found its sharpest edge inside the test fixture itself

M12's highest-risk audit item was whether `manual_valuations` (append-only since M6:
`effective_from`, `created_at`, `superseded_at`) can reconstruct "which value was active on date
D" for any historical D. The answer is yes — but only under a precise model (D-062): rows own
`[effective_from, next effective_from)` ordered by `(effective_from, created_at, id)`, with
`superseded_at` meaning an economic end **only for the terminal row, and only when it ended by a
clear**. The trap the prompt warned about is real: treating `superseded_at` as every row's end
date makes any backdated correction apply nowhere, silently defeating `effective_from`'s entire
purpose.

The model's sharpest edge surfaced while writing the tests, not the engine. The first fixture
version inserted valuation rows directly without the RPC's supersede step — which both violates
the active-row partial unique index and produces a state no real user could have: multiple live
rows per holding. Fixing the helper to supersede-then-insert exposed the genuinely ambiguous
case the engine must answer deterministically: a backdated correction whose `effective_from`
lands *before* an earlier-inserted, later-effective, since-cleared row. Under D-062 the
correction owns only up to that later row's `effective_from`; the cleared row still owns its own
stretch up to its clear date; determinism comes from canonical data alone, full stop. That is a
defensible reading of "corrections rewrite history" — and because full rebuild and incremental
recompute run the *same* model, the byte-equality gate cannot drift even in this corner. The
lesson generalizes: when a history-reconstruction rule has an ambiguous-looking case, the test
fixture must exercise exactly that case through the real write path, not through a shortcut that
quietly changes the semantics being tested.

Two smaller finds from the same desk-check discipline that preceded CI (which remains the real
executor on this machine-less-Docker setup): the first draft of the rebuild's final assembly used
per-date correlated LATERALs to accumulate spend/proceeds — the exact shape D-054 exists to
police — replaced by a window-function running sum over the date spine before it ever ran; and a
near-miss where cumulative-spend deltas included purchases dated before the rebuild window,
which would have double-counted them against the opening balance had the join not filtered them
incidentally. Both were caught by re-reading the statement chain against its own invariants, not
by a green run — CI catching plpgsql errors is the norm here, so anything caught earlier is
found money.

One infrastructure note for whoever touches these triggers next: PostgreSQL does not check
EXECUTE on trigger functions at firing time — the same production-tested property that lets
`supabase_auth_admin` fire `handle_new_user` ungranted. That is why the M12 invalidation
triggers can be revoked from every named role (so no session can call them directly) while user
mutations still fire them implicitly. It also means the grant-audit's PUBLIC sweep plus named
revokes fully cover this class of function, unlike M6's finding about directly-called RPCs.

---

## 2026-08-30 - Three ways a correct-looking interval rule still had to be designed around overlap

The review fix for the manual-valuation resurrection bug (D-062's clear-then-later-insertion
corner) looked like a one-line change: when a row's `superseded_at` predates the next row's
creation, end it at the clear date. Two naive formulations of exactly that rule are wrong, and
the difference only shows up in sequences no existing fixture exercised.

Comparing against `lead(created_at)` - the immediately-next row in `(effective_from,
created_at, id)` order - misclassifies a WEDGED correction. Set A@D10, atomically replace with
B@D30, then backdate C@D20 into the middle: C sorts between A and B, so A's lead() is now C, whose
creation is strictly later than A's supersession. The comparison reads "cleared independently",
ends A at its supersession wall-clock date, and that date is LATER than C's effective_from -
producing two intervals covering the same days, which the engine's per-day join would have
double-counted straight into CMV. The safe formulation pairs by transaction timestamp: a row was
atomically replaced iff ANY row's `created_at` equals its `superseded_at` (the successor the
superseding transaction inserted, wherever it now sorts); otherwise it was cleared. With that
pairing, every branch satisfies valid_to <= next effective_from, so coverage stays single-valued
by construction rather than by hope.

The second trap was the least() guard itself. An independently cleared row ends at min(clear
date, next effective_from), which handles the case where a later valuation is BACKDATED INTO the
cleared span - corrections rewrite history; they must win from their own effective_from rather
than extend what they correct.

Third, the adversarial oracle already encoded "always min(next_eff, clear_date)", which diverges
from the paired engine rule for one input class: future-dated atomic replacements (new
effective_from AFTER the supersession wall-clock). Neither suite constructed one, but aligning
both sides on the same explicit pairing - replaced means boundary = replacement's effective_from;
cleared means own clear date - removed the divergence class instead of leaving it to fixture luck.
The lesson generalizes: when an implementation and an independent oracle agree, check WHICH RULE
each encodes before trusting the agreement; identical outputs over shared fixtures can come from
different rules that part ways on the first unshared input.

## 2026-08-30 - A fresh generated-types artifact disagreed with the hand-maintained one, and the artifact was wrong about nullability

**Problem.** M12's `database.types.ts` had been hand-maintained (no local Docker, established
precedent since M6), and the standing instruction was to replace it with CI's generated artifact
before trusting it further. The release phase finally produced a real generated artifact — the
hosted project had every migration applied, so `supabase gen types --linked` worked without
Docker for the first time. The diff was large: 231 insertions, 122 deletions against the
committed file.

**Finding.** Categorising every hunk showed three classes: genuine generator-version noise
(a new `__InternalSupabase` metadata block, a `graphql_public` schema section, identity columns
retyped from `id?: number` to `id?: never`, alphabetical reordering, newly-inferred view
relationships); the known intentional `p_fx_rate_to_nok` string divergence; and — the dangerous
class — a wholesale nullability change across EVERY RPC result: `string | null` became `string`
for all RETURNS TABLE columns of all functions, including ones untouched by M12 and long
deployed. That uniformity is what proved it was a generator policy change, not schema
information: the SQL genuinely returns NULL for THP/TTEP before a user's first snapshot exists,
and the reviewed test asserts exactly that. Adopting the artifact would have deleted the
TypeScript-level null checks guarding the project's absent-data-is-never-zero rule.

**Resolution.** The committed file stands; nothing was regenerated. The lesson: a generated
artifact proves its generator ran, not that its inferences are schema truth — for RPC results,
nullability is a policy choice the generator makes, and a newer generator's "non-nullable"
default can be strictly worse than a careful hand-maintained file. Diff categories, not just
diff lines.

## 2026-08-30 - Two hosted-release observations that looked like defects and were not

**Problem.** During the controlled release, two hosted-state readings looked alarming.

First, a forged-identity smoke check (JWT-claim impersonation with a nonexistent user id) saw
`get_dashboard_summary()` return ONE row where history/activity/direct-table reads correctly
returned zero — a naive leak test fails on it. Reading the returned row showed why: latest and
first tracked dates NULL, market value NULL, snapshot open-lot count NULL, live-holding counts
0. The summary is an aggregate shape; for an empty identity it legitimately returns one
all-absent row rather than zero rows. That is the project's honesty rule applied at the type
level — absent data renders as absent (NULL), never as a fabricated zero. The correct invariant
is "no non-NULL data field", not "zero rows".

Second, `portfolio_recompute_runs` recorded started_at identical to finished_at to the
microsecond. This is Postgres's transaction-stable `now()`: the drain runs as one outer
transaction by design, so both timestamps freeze at the same transaction start. Far from being
a defect, identical timestamps corroborate that the documented single-transaction semantics are
what actually runs.

**Resolution.** Both documented here so the next session's verification scripts assert the
right properties: content-based emptiness checks for aggregate RPCs, and no expectation of
wall-clock duration inside single-transaction run records.

## 2026-08-24 - A green PR failed CI on main with a byte-identical tree, and the tree was the whole argument

**Problem.** Merging PR #40 (Home polish � five files, none of them SQL, scripts, or DB tests)
turned `main`'s `db-tests` red: the permanent portfolio-snapshots benchmark died mid-seed with
SQLSTATE 57014, a statement timeout, roughly thirty seconds into bulk-inserting ~297k synthetic
price observations. The same commit content had passed the identical job on the PR's own check
run hours earlier. Nothing about the merge could have changed database behaviour.

**Resolution.** The decisive fact was mechanical, not diagnostic: a squash merge of a branch
based on an unchanged `main` produces a commit whose **tree is byte-identical to the PR head's
tree** (`git log --format=%T` on both commits proved it: one hash). The failing run and the
passing run had therefore executed exactly the same code. A statement timeout during a large
bulk seed on a shared runner is contention-shaped, not correctness-shaped. Re-running only the
failed job on the same SHA was accordingly not "retrying until green" � it was resolving a
documented coin-flip in the runner's favour, with the prior pass as prior evidence. It passed;
the release continued. The rule worth keeping: before re-running anything, prove the tree did
not change; if the tree changed, a re-run proves nothing and the failure must be read as real.

## 2026-08-24 (P42) - The dashboard was honest about being stale but had no way to become current

An owner-reported production bug looked, from the repro, like a ghost-spend regression: remove a
quick-add test card, watch Home sit on "Updating..." for minutes, and see the acquisition's spend
still on screen. The hosted read-only diagnosis disproved the accounting theory in one query
each: every removed test lot's single-line parent purchase had already been voided by the M8.1
auto-void, a detector for "live purchases whose every line-lot is voided" returned zero rows, and
the queue was empty. The ledger had been correct the whole time.

The actual defect class is easy to build accidentally: `get_dashboard_summary` reports
`pending_recompute` honestly, GPO/CS are computed live inside that same request, and CMV/TTEP
come from the snapshot cache - but NOTHING ever re-fetched the summary while pending stayed
true. React Query refetches on mount, focus and invalidation only. A user watching an
already-mounted Home page could wait forever; a user returning later saw correct figures, which
matches exactly what the hosted data showed after the fact. Two independent latency sources
stacked: up to 15 minutes of cron cadence, then unbounded client-side silence on top.

Two lessons worth keeping. First, an honesty signal without a refresh mechanism is only half a
feature - the badge told the truth about staleness while the screen had no path out of it.
Second, the diagnosis order mattered: prove the canonical state before touching any display
code. Had the auto-void actually regressed, polling would have hidden a real financial defect
behind a smoother UX. The synthetic suites now pin both halves separately: the ledger contract
(quick-add -> remove -> baseline restored EXACTLY) in `tests/db/p42_owner_refresh.test.ts`, and
the poll/settle decisions as pure domain functions in `tests/data/dashboard.test.ts`.

---

## 2026-08-26 (M16/P53) - The receipt total is the contract: exactness shaped the schema, not the other way around

Buy-and-open looked like pure UI orchestration until the 29995 case was written down. The owner
states "3 packs, paid 299,95" - and the ledger had nowhere honest to put the last ore. M3's
`purchase_lines_line_total_matches_unit_price` equality CHECK forced line_total = unit x qty =
29994; the M8 allocation CHECK pinned attributable to line_total + allocations; GPO/CS read
attributable. Every legal-looking workaround fabricated something: a 1-ore fake shipping fee, a
fake discount, a header-only total that the spending summary would undercount by the residual.
The honest representation required changing ONE intra-row invariant: replace the equality CHECK
with the largest-remainder envelope (excess < quantity), store floor(total/qty) as the display
unit value, and let the lot's existing residual columns carry the difference so consumption
reproduces the entered total exactly through ANY split of openings. Lesson: when a prompt says
"respect actual CHECK constraints", read it as "model them first, then decide which single one
is wrong for the new fact" - widening only, with every pre-existing row validating unchanged.

The second lesson of this session is about parallel-source integration. P52's oracle package was
written implementation-blind, and its binders assumed dialects the shipped backend deliberately
does not use (an array-of-lots create payload; a separate add-pull RPC). Both are reasonable
spellings of the same contract, so both were bound rather than one side being declared wrong:
scalar-lot + folded-pull attachment joined the binder vocabulary next to the originals, and the
provisional path gained a dedicated binder that prefers its real RPC and FAILS LOUDLY if the
idempotency parameter is missing. Adaptation without loosening is what keeps an independent
oracle worth having after integration day.

Third: void semantics. P50's symmetric provisional-void felt tidy until stated in words - it
could restore live sealed inventory whose purchase no longer counted, i.e. a free sealed box.
"The opening did not happen" is a different sentence from "the purchase did not happen", and the
ledger now enforces the difference. The tests that had encoded the old symmetry were rewritten,
not weakened: they now pin that spend stays counted across open+void and that only the separate
purchase-correction surface can remove it.

## 2026-08-25 (M16/P56) - A restored lot is not a free lot: reconciliation had to annihilate what it replaced

Reconciliation looked complete: retire the provisional consumption, freeze the real lot's exact
share, repoint the opening, void the provisional purchase, stamp provenance on the row. Two
independent reviews (P54, P55) and this repair session's own re-read converged on the same
missed consequence: retiring the consumption disposal makes D1 RESTORE the provisional source lot
to full live availability at the exact moment its purchase stops counting. The result of the
flagship happy path was a phantom - live sealed inventory with known basis citing a voided
receipt - reachable by every user who ever reconciled, invisible to tests that asserted only
purchases and disposals and never the lot's own liveness.

The fix is one UPDATE inside the same transaction, but placing it correctly required separating
two policies that look like opposites and are not. Void-opening keeps the source purchase active
("the opening did not happen" - the money was really spent). Reconciliation REPLACES the
provisional purchase ("this was really that receipt") - so everything the provisional purchase
brought into existence must leave together: purchase, lot, consumption. Same ledger discipline,
opposite lifecycles; conflating them either resurrects the free-sealed-lot world or strands real
spend.

Two smaller lessons from the same pass. First, coverage counts inherit their frame from the
query that computes them: a "priced pulls" count computed over all non-voided lots reads as
"cards still here" once it sits beside retained value - the frame has to be stated in the WHERE
clause (quantity_remaining > 0), not in prose. Second, a client-side cache that prevents
duplicate writes only works while the cache lives; surviving a remount requires persisting the
created identity into state that outlives the component - the user-scoped draft, not a ref.

## 2026-08-25 (M16/P59) - An idempotency key that dies with the component protects nothing across a remount

The server-side idempotency machinery (D-089) was correct under every interleaving the audits
could construct, yet the client could still cause a double purchase: the key was minted in
per-mount React state, so "server committed, response lost, user leaves, user returns" produced
a NEW key on return and the replay lookup never had a chance. The lesson generalizes beyond this
feature: an invariant enforced by pairing (client identity + server arbiter) requires the client
half to live as long as the LOGICAL operation, not as long as one mount of its UI. Moving the
key into the draft also made the stale-'submitting' recovery almost free - once the key survives
the remount, treating an interrupted submission as retryable is safe in BOTH directions (committed
replays; uncommitted creates), so recovery code never has to guess what happened.

Two copy findings were really honesty findings. "Cost entered manually - not linked to a
purchase" read plausible until set beside FINANCIAL_MODEL 5.5: the provisional path creates a
REAL spend-counted purchase, so the marker denied a fact the rest of the UI asserted. And a fully
sold pull rendered like a held card because the row had quantity data nobody displayed - the fix
was presentation ("Sold" / "1 of 2 remaining"), not new queries. The reconciliation picker
followed the same grain: rather than a privileged definer read or N+1 lookups, three owner-only
provenance columns on an existing bounded invoker read let the client mirror the server's target
rule while the RPC stays the only authority.
