# Changelog

Notable changes, newest first. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

This file records **what changed**. [HANDOVER.md](HANDOVER.md) records **current state**, and
[docs/PROJECT_JOURNAL.md](docs/PROJECT_JOURNAL.md) records **why hard things were done the way
they were**.

---

## [Unreleased]

### Added — 2026-08-20 · M4.1 privilege convergence, deployment and real end-to-end validation

M4 closed a live privilege escalation. M4.1 answers the question that fix raised: whether the
migrations reach the intended privilege surface from a project that starts out wrong, rather than
only from an empty database. Three gaps said no.

Function grants were revoked from a hand-written list of names, so a function arriving pre-granted
would have survived — swept now, then granted back to exactly four. Default privileges were never
neutralized, and they turned out to be the real mechanism: `pg_default_acl` carries entries granting
`anon` and `authenticated` everything on new objects in `public`, in every environment. The ones
owned by `postgres` are revoked; the ones owned by `supabase_admin` are unreachable, documented, and
harmless because a default privilege attaches only to objects its own role creates. And `UPDATE` was
granted whole-table on every user-owned table except `profiles`, leaving `user_id`, primary keys,
`created_at` and the provenance columns writable by their owner with only RLS standing there — now
granted column by column, with identity and provenance absent.

`scripts/grant-audit.sql` asserts that surface against the catalog as an independent second
statement of intent, and runs unchanged in the Supabase SQL editor against a deployed project — the
check that was missing when CI and the real project disagreed. CI makes the database hostile first,
proves the audit rejects that state, re-applies the baseline and proves it converges.

Also: the deferred `invitation_claims.consumed_user_id` foreign key tested from both sides, claim
expiry recovery, `finalize_invitation_redemption` idempotency, the GoTrue Admin-API assumption
re-verified against current upstream source, and the SHA-256 token decision re-examined and kept.

Deployment: the application is served over HTTPS from Cloudflare Pages on the Free plan, built from
`main`, with a Content-Security-Policy generated from the Supabase URL the bundle was built against
so the two cannot drift.

### Added — 2026-08-20 · M4 invite-only authentication and account security

Account creation is closed. Two independent server-side gates enforce it: a **Before User Created
auth hook** that rejects every self-service signup path GoTrue exposes, and a `BEFORE INSERT`
trigger on `auth.users` requiring a live invitation claim (invariant S2). The hook rejects
unconditionally rather than checking anything, because GoTrue does not invoke it from the Auth Admin
API — verified against the `supabase/auth` source — which means there is no forgeable metadata and
no race window. A hook that merely allowed signup for invited addresses was considered and rejected:
it would have let anyone who knew an invited address set the password first.

Invitations now bind to a single address, store only `sha256(token)`, expire (7 days by default),
are single-use and revocable, and expose no `token_hash` through the Data API even to an admin.
Redemption is a three-step claim/create/finalize flow whose availability is computed from claims
rather than a counter, so an abandoned attempt frees itself in two minutes and no sequence of
failures can burn an invitation permanently; concurrency is handled by a row lock plus a partial
unique index, not by application-level check-then-act. `redeem-invitation` is the only Edge
Function — invitation issue and revocation are admin-gated Postgres RPCs, because generating a token
needs no Deno runtime and no second copy of the secret key.

Application: sign-in, invitation redemption, password recovery, an admin invitation screen, session
handling, and public/protected/admin route classes. Provisional visually, but with the parts that
would be a bug in any visual direction — password-manager `autocomplete` attributes, paste never
blocked, errors announced rather than only coloured, 44px touch targets, and one sign-in error
message so the form does not become an account-enumeration oracle.

Testing: an 18-case invite-only attack suite run against the live API with the publishable key
(uninvited signup, **invited-address signup**, forged `user_metadata`, a hand-built
`/auth/v1/signup` carrying `app_metadata` and `role: service_role`, Auth Admin creation with no
claim, replay, tampering, expiry, revocation, an attacker-supplied address in the redemption body, a
rejected password leaving the invitation usable, and two redemptions racing one token), 22 admin
authorization cases, and 26 browser cases at desktop and iPhone viewports. Both gates were
deliberately disabled on a throwaway branch and CI watched to fail on the named tests before being
reverted. CI now runs the browser suite and asserts the Edge Function is reachable before the auth
tests, so redemption cases cannot pass by being skipped.

Fixed, from an adversarial review of the M3 foundation: account deletion was impossible — eight
`user_id` foreign keys to `auth.users` had no `ON DELETE` action, contradicting SECURITY.md §8
— `token_hash` was admin-readable through the Data API, and functions relied on `PUBLIC`'s
default `EXECUTE`. Password policy is now 12 characters minimum with no composition rules.

Deployed to a free `pokeportfolio-dev` project, and verifying it there found what CI could not:
the project auto-grants the Data API roles broad privileges on new tables and functions, and a
`GRANT` is additive — so M3's column-restricted `profiles` grant restricted nothing, and a
signed-in non-admin could set their own `is_admin` flag while the authorization suite was green.
Every privilege is now restated as revoke-then-grant for tables and functions alike, `anon` holds
no table privileges at all, and `scripts/remote-security-check.mjs` runs the same assertions
against a real deployment with nothing but the publishable key. Final remote run: 33/33, with the
escalation asserted on the stored value rather than the HTTP status.

Cost: $0; no billing enabled anywhere. Detail: `claude_outputs/output_7.txt` (not committed).

### Added — 2026-08-17 · M3 database foundation, migrations and RLS

Real persistent-storage foundation. Supabase project structure (`supabase/`), CLI pinned as a
project devDependency, eight timestamped migrations covering the shared catalog
(`card_series`/`card_sets`/`cards`/`card_variants`/`sealed_products`), profiles, invitations
(schema only — enforcement lands with M4's Edge Function), user-scoped reference data
(`retailers`/`storage_locations`/`tags`), purchases/purchase_lines and holdings/acquisition_lots.
Row Level Security enabled on every table with explicit `WITH CHECK` on every write policy;
`user_id` denormalized onto every child table with an ownership-verifying trigger (invariant S1);
`profiles.is_admin` locked down at the SQL column-privilege level, not just RLS. A two-client
authorization suite (`tests/authorization/`) exercises the real PostgREST API as two distinct
authenticated users, covering every user-private table plus the critical cross-tenant
child-parent attack and the "admin has zero access to other users' private data" property. A
database constraint suite (`tests/db/`) proves the FINANCIAL_MODEL invariants the schema is
supposed to enforce (M1/M2 cost-basis-state consistency, the holdings identity index, purchase
total/line-total arithmetic checks) actually reject bad data. The Postgres `bigint` /
PostgREST JSON-number precision boundary for money columns is documented and proven with a real
round-trip test, not assumed. CI gained a `db-tests` job that runs the full migration and
authorization suite against an ephemeral local Supabase stack on every push and PR — no remote
credentials involved. Existing M1/M2 gates (64 domain tests, Playwright smoke tests, typecheck,
lint, format, build) remain green throughout. Cost: $0; no billing enabled anywhere. Detail:
`claude_outputs/output_6.txt` (not committed).

### Added — 2026-08-17 · M1 foundation and M2 financial domain core

First application code. Vite + React 19 + TypeScript strict scaffold, ESLint/Prettier, Vitest +
fast-check, Playwright, a minimal PWA shell, and GitHub Actions CI with an open-source secret
scan — all zero-cost. Pure-TypeScript financial domain layer: `Money` (integer minor units, no
float), currency metadata, a largest-remainder allocator, FX conversion, `CostBasisState` and
`MarketValue` as discriminated unions, and the inventory/spending/sales/position metrics from
FINANCIAL_MODEL.md. Worked examples E1, E3 and E7 reproduce exactly against the real domain
functions; 64 tests pass, including property tests for the allocator (invariant F6) and
randomised checks for F1, F3 and F5. No database, no auth, no external service yet — M1/M2 are
deliberately infrastructure-independent. Detail: `claude_outputs/output_5.txt` (not committed).

### Changed — 2026-08-17 · Cost policy: $50 USD lifetime discretionary ceiling

Target operating cost stays $0/month; a separate, owner-approved, **lifetime** ceiling of $50 USD
now exists for genuinely excellent one-time options. Not pre-authorized spending — every purchase
still needs individual approval, and nothing may be spent before a free functional baseline
exists. See D-027 and docs/COST_POLICY.md §1.

### Changed — 2026-08-16 · Planning frozen

Scope and product semantics settled; implementation has an authoritative target.

- **Every physical card is individually trackable** — energies, commons, duplicates and unpriced
  cards are first-class inventory. Replaces a proposal to aggregate low-value cards. Organisation
  and filtering, not aggregation, keep large collections navigable.
- **Custom collections, smart value filters and a configurable grid density** added to MVP as the
  organisational answer to a ten-thousand-card collection. Mobile gallery defaults to two columns
  and is user-settable 1–4.
- **Cost basis became a state** — `known` / `unallocated_opening` / `not_paid` / `unknown` /
  `trade_in` — so a gift, a forgotten purchase price and a pack pull are no longer
  indistinguishable `NULL`s.
- **Manually costed openings now create a real provisional purchase**, reconciled and voided when
  the real receipt is entered. Previously such costs were excluded from lifetime spending, which
  made the product's headline metric understate reality.
- **A dedicated History area** for items no longer owned: sold, traded, other disposals. Disposals
  with no cost basis show proceeds and a result of **—**, never a fabricated profit.
- **Trades modelled in the schema**, with the item-leg accounting rule deliberately left open and
  disposal-time cost and market value frozen so either rule remains adoptable.
- **Authentication changed from email OTP to email and password.** The built-in mail provider
  allows two auth emails per hour project-wide, which makes OTP a lockout risk; password login
  sends no email at all.
- **Scanner moved ahead of openings** post-MVP, and **JSON backup moved into MVP**.
- Zero-cost audit re-verified against all-card tracking: price history is keyed per card variant
  rather than per copy, so snapshot volume is decoupled from collection size.

### Added — 2026-08-16 · Project foundation

- Canonical documentation set covering product, financial model, data model, architecture,
  security, testing, development, roadmap, decisions, research, external sources, UX flows,
  design system, scanner research, backlog, publication checklist and engineering journal.
- Financial model with ten worked examples and eleven named invariants, each mapped to a
  planned test.
- Data model covering the full lifecycle from purchase through sealed, opening, grading and
  sale without provenance loss.
- Architecture selected: Vite + React SPA, Supabase (PostgreSQL with RLS), Cloudflare Pages.
- Security model: RLS on every table, invite-only enforced server-side, admin role with no
  access to other users' data.
- Development toolchain: Node 24.19.0 LTS, pnpm, GitHub CLI.
- Repository initialised with secret-prevention configuration.

No application code in this release.
