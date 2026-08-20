# Changelog

Notable changes, newest first. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

This file records **what changed**. [HANDOVER.md](HANDOVER.md) records **current state**, and
[docs/PROJECT_JOURNAL.md](docs/PROJECT_JOURNAL.md) records **why hard things were done the way
they were**.

---

## [Unreleased]

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
