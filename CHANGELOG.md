# Changelog

Notable changes, newest first. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

This file records **what changed**. [HANDOVER.md](HANDOVER.md) records **current state**, and
[docs/PROJECT_JOURNAL.md](docs/PROJECT_JOURNAL.md) records **why hard things were done the way
they were**.

---

## [Unreleased]

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
