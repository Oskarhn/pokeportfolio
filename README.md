# PokePortfolio

A private Pokémon TCG collection and financial tracking application.

**Status:** Foundation complete — architecture, financial model and data model are specified.
No application code yet. See [ROADMAP.md](docs/ROADMAP.md).

> Working name. Not final branding.

---

## What it is

Most collection apps tell you what your cards are worth. Most spending trackers do not
understand that a booster box turns into cards. This one does both, and keeps the accounting
correct while items move between states.

The organising idea: **money and things have separate lifecycles.** An Elite Trainer Box costing
799 NOK becomes nine packs which become ninety cards. The 799 NOK does not disappear when the
box is opened, does not get silently reallocated across the cards, and does not become ninety
cost bases. It stays recorded as money spent, and the cards it produced are tracked with their
provenance intact.

That single constraint drives most of the design: a permanent purchase ledger, lot-level cost
basis, opening-scoped return rather than fabricated per-card ROI, and a rule that absent data is
displayed as absent rather than guessed.

## What it answers

- What is the collection worth, and how has that changed?
- What has this hobby actually cost, separating collectibles from accessories?
- What came back through sales, and what was the real result?
- Did opening that box pay off — and how incomplete is that answer?
- Which specific copy of a duplicate did I sell, and at what cost basis?
- Did grading that card make money?

## Deliberately not

Tax reporting. Deck building. A marketplace. Social features. Public signup. Price predictions
or buy/sell signals. Games other than Pokémon.

---

## Design principles

**Absent data is displayed as absent.** No backfilled price history from today's prices. No
condition multipliers invented to look precise. No raw-card price standing in for a graded card.
No cost basis of zero on a pulled card implying infinite return.

**Money is never a float.** Integer minor units with an explicit currency code. Allocation uses
largest-remainder rounding so parts sum exactly to the whole.

**Provenance is reachable.** Every value carries its source, source currency, exchange rate and
timestamp. Every number can be traced to the transaction that produced it.

**Terminology means what it says.** "Overall position" is not called profit. An unrealized
result is only reported where a defensible cost basis exists.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vite · React 19 · TypeScript strict · TanStack Router + Query |
| UI | Tailwind CSS v4 · shadcn/ui on Base UI · `lightweight-charts` |
| Backend | Supabase — PostgreSQL with RLS, Auth, Edge Functions, `pg_cron` |
| Auth | Email OTP, invite-only, enforced server-side |
| Data | TCGdex (catalog, images, Cardmarket/TCGplayer prices) · Norges Bank (FX) |
| Hosting | Cloudflare Pages |
| Testing | Vitest · fast-check · Playwright |

Reasoning for each in [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [DECISIONS.md](docs/DECISIONS.md).

## Platforms

iPhone as an installed PWA is the primary target. Android from the same codebase. Desktop
browser is first-class for bulk work and analysis. Native clients are not built, but the backend
is directly reusable by one.

---

## Local development

Requires Node 24 LTS and pnpm. Full setup, commands and migration rules in
[DEVELOPMENT.md](docs/DEVELOPMENT.md).

```bash
corepack enable
pnpm install
cp .env.example .env.local   # then fill in from the Supabase dashboard
pnpm dev
```

Environment variables are documented by name in [.env.example](.env.example). No secret is ever
committed to this repository.

---

## Documentation

| Document | Purpose |
|---|---|
| [HANDOVER.md](HANDOVER.md) | Current state — read this first |
| [PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) | What the product does |
| [FINANCIAL_MODEL.md](docs/FINANCIAL_MODEL.md) | Every formula and invariant, with worked examples |
| [DATA_MODEL.md](docs/DATA_MODEL.md) | Schema, ownership, lifecycle |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack and rationale |
| [SECURITY.md](docs/SECURITY.md) | Trust boundaries, RLS, invitations |
| [TESTING.md](docs/TESTING.md) | Strategy and mandatory gates |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Environment and commands |
| [ROADMAP.md](docs/ROADMAP.md) | Phases and completion gates |
| [DECISIONS.md](docs/DECISIONS.md) | Decisions expensive to reverse |
| [RESEARCH.md](docs/RESEARCH.md) | Findings, sources, open uncertainties |
| [API_SOURCES.md](docs/API_SOURCES.md) | External services and their terms |
| [UX_FLOWS.md](docs/UX_FLOWS.md) | Workflow behaviour |
| [DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | Visual direction |
| [SCANNER_RESEARCH.md](docs/SCANNER_RESEARCH.md) | Scanner feasibility |
| [PROJECT_JOURNAL.md](docs/PROJECT_JOURNAL.md) | Problems solved and why |
| [BACKLOG.md](docs/BACKLOG.md) | Unscheduled work, and what was rejected |

---

## Privacy

This is a private, invite-only application. There is no public signup. Each user's collection
and financial records are isolated at the database level by row-level security, verified by
automated tests. The administrator can manage invitations but has no application-level access to
another user's data.

Anyone invited should understand that whoever operates the deployment has infrastructure-level
database access. That is inherent to self-hosting and is stated rather than papered over.

## Attribution

Unofficial and unaffiliated with The Pokémon Company, Nintendo, Creatures Inc. or GAME FREAK.
No official logos or brand assets are used as application branding.

Card data and images: [TCGdex](https://tcgdex.dev). Market price data originates from Cardmarket
and TCGplayer. Exchange rates: [Norges Bank](https://www.norges-bank.no). Licensing detail and
open questions in [API_SOURCES.md](docs/API_SOURCES.md).
