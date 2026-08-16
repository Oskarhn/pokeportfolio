# Changelog

Notable changes, newest first. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

This file records **what changed**. [HANDOVER.md](HANDOVER.md) records **current state**, and
[docs/PROJECT_JOURNAL.md](docs/PROJECT_JOURNAL.md) records **why hard things were done the way
they were**.

---

## [Unreleased]

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
