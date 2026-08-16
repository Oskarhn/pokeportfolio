# Handover

Current-state document, written for a session that knows nothing from any earlier conversation.
Read this first, update it last. History lives in [CHANGELOG.md](CHANGELOG.md) and
[docs/PROJECT_JOURNAL.md](docs/PROJECT_JOURNAL.md).

**Last updated:** 2026-08-16 — planning frozen; implementation begins next session.

---

## Status

**Planning is FROZEN. Implementation has not started. There is no application code.**

The next session's job is to begin implementation at milestone **M1**, following
[docs/ROADMAP.md](docs/ROADMAP.md). Scope is settled — do not reopen it (see
[docs/PLANNING_FREEZE.md](docs/PLANNING_FREEZE.md) §9).

## Read these first, in order

1. `HANDOVER.md` — this file
2. `docs/PLANNING_FREEZE.md` — the authoritative frozen scope
3. `docs/PRODUCT_SPEC.md` — what the product does
4. `docs/ARCHITECTURE.md` — the stack and why
5. `docs/DATA_MODEL.md` — schema, ownership, lifecycle
6. `docs/FINANCIAL_MODEL.md` — **the most important technical document here**
7. `docs/SECURITY.md` — RLS, invites, secrets
8. `docs/TESTING.md` — the mandatory gates
9. `docs/COST_POLICY.md` — the zero-cost constraint and verified service matrix
10. `docs/ROADMAP.md` — milestones and their gates
11. `CLAUDE.md` — working rules and skill routing

Then run `git status` and `git log --oneline -10`.

## Product, in one paragraph

PokePortfolio is a private, invite-only application for tracking a Pokémon TCG collection as both
a collection and a set of financial records. It keeps a permanent spending ledger that survives
products being opened, cards being graded and items being sold, alongside market valuation and
portfolio history. Primary platform is an installed PWA on iPhone; desktop is first-class for
bulk work. Expected scale: 1–10 users, potentially 10 000+ cards each.

## Constraints that are not negotiable

| Constraint | Detail |
|---|---|
| **Budget: 0 NOK/month** | No paid service, tier, domain or billing without explicit owner approval. When a feature cannot be built well for free, **postpone it**. Never enter payment details or enable billing. |
| **Repository stays private** | Never change visibility. Requires owner approval plus a completed [PUBLICATION_CHECKLIST](docs/PUBLICATION_CHECKLIST.md) pass. |
| **No real data in Git** | All fixtures synthetic. The owner's actual collection never enters the repository. |
| **Financial and authorization tests are gates** | A milestone touching money or ownership is not done until both suites pass. |
| **Absent data is displayed as absent** | Missing cost is never `0`. Missing price is never `0`. A missing result renders as **—**. |

## Decisions a new session must not accidentally reverse

Full context in [docs/DECISIONS.md](docs/DECISIONS.md).

1. **Every physical card is trackable** — energies, commons, duplicates, unpriced cards. Never
   aggregate them away to tidy a view. (D-017)
2. **Lot-based cost basis.** `card_variant` → `holding` → `acquisition_lot`. Never average
   duplicate costs. (D-001)
3. **Cost basis is a state**, not a nullable number: `known` / `unallocated_opening` /
   `not_paid` / `unknown` / `trade_in`. Amount present iff `known`. (D-002, D-020)
4. **Price history is keyed per card variant, never per copy.** This is what makes all-card
   tracking affordable. (D-019)
5. **Manually costed openings create a real provisional purchase**, reconciled and voided when
   the real receipt arrives. Money counted exactly once. (D-021)
6. **Email + password**, not OTP — the built-in mail provider allows 2 emails/hour project-wide.
   (D-022)
7. **Four distinct grouping concepts**: storage location, custom collection, tag, smart filter.
   Never merged. (D-018)
8. **Collection value is the primary dashboard figure**, position immediately beside it. (D-023)
9. **Scanner ships before openings** post-MVP. (D-024)
10. **JSON backup is in MVP**, versioned. (D-025)
11. **No condition multipliers.** The price source is not condition-specific. (D-009)
12. **No fabricated price history.** It accumulates from our own snapshots. (D-008)
13. **Raw prices never value graded cards.** (F10)
14. **Vite SPA, not a meta-framework.** Every screen is authenticated; SSR buys nothing. (D-004)
15. **Scanner owns one route and one MediaStream** — iOS re-prompts for camera permission on URL
    change. (D-006)
16. **`user_id` denormalised onto child tables** for one-line RLS predicates. (D-011)
17. **Admin has no application access to other users' data.** (SECURITY §4)

## Architecture

| Layer | Choice |
|---|---|
| Frontend | Vite · React 19 · TypeScript strict · TanStack Router + Query |
| UI | Tailwind v4 · shadcn/ui on Base UI, copied in and owned |
| Charts | `lightweight-charts` — **validate with a spike before building the dashboard**; fallback visx |
| Backend | Supabase — PostgreSQL + RLS, Auth, Edge Functions, `pg_cron`, region `eu-north-1`, free plan |
| Auth | Email + password, invite-only, enforced server-side |
| Catalog + raw prices | TCGdex (free, no key) — Cardmarket EUR, TCGplayer USD |
| FX | Norges Bank EXR API |
| Sealed + graded value | Manual valuation — no free EUR source exists |
| Hosting | Cloudflare Pages, static |
| Money | Integer minor units + ISO 4217. Never float. |

## Environment

| Item | State |
|---|---|
| Node.js | 24.19.0 LTS installed |
| pnpm | Via Corepack — **not yet enabled**, do this in M1 |
| Git | 2.51.1 |
| GitHub CLI | 2.97.0, authenticated as `Oskarhn` |
| Docker Desktop | **Not installed.** Needed only for a local Supabase stack; a remote dev project is the documented fallback. |
| Supabase | **No project exists yet.** Create in M3, free plan, `eu-north-1`. |
| Cloudflare | No project yet. Create when deployment is first needed. |

## Repository

- `https://github.com/Oskarhn/pokeportfolio` — **private**
- Branch `main`, pushed, working tree clean
- Author identity is set repo-locally to the GitHub `noreply` address. No personal email appears
  anywhere in metadata, content or the object database. Verified.
- `claude_outputs/` is gitignored and must stay that way. It is a local mentor-handoff channel,
  not project documentation, and must never be committed.

## Output file convention

`claude_outputs/output_N.txt`, one per major phase. **The number is stated explicitly in each
prompt — never infer it, and never backfill missing historical files.** Last completed: 4. Next
expected: 5.

## Known issues

None in the codebase — there is no codebase.

## Open uncertainties

None block M1. Detail in [docs/RESEARCH.md](docs/RESEARCH.md).

| # | Uncertainty | Needed by |
|---|---|---|
| U2 | Whether Cardmarket's public Product Catalogue covers Pokémon sealed, and its terms. Requires an authenticated session. | Sealed valuation improvement |
| U3 / U4 | TCGdex rate limits and price cadence in practice | M9 |
| S6 | Whether camera permission survives an in-route session on current iOS | **Spike before M15** — gates the scanner approach |
| S7 | Whether Basic Energy printings are distinguishable by image at all | M15 |
| — | Whether TCGdex models Basic Energy printings adequately | M5, verify at ingest |
| — | Trade item-leg accounting rule: carryover vs fair value | M18 only |

## Next actions

Start at **M1 — Scaffold and harness** ([docs/ROADMAP.md](docs/ROADMAP.md)):

1. `corepack enable`, pin pnpm, `.nvmrc` already reads 24.19.0
2. Scaffold Vite + React 19 + TypeScript strict, plus `noUncheckedIndexedAccess`
3. ESLint, Prettier, Vitest, fast-check, Playwright
4. Establish `src/domain` · `src/data` · `src/features` · `src/ui` · `src/routes`
5. Wire `pnpm check` = typecheck + lint + test
6. GitHub Actions: install → typecheck → lint → test → build → secret scan
7. PWA shell: manifest, icons, service worker, safe areas

**Gate:** `pnpm check` green, CI green on a pull request.

Then M2 (Money type and allocator, with property tests) before touching a database. The financial
engine is pure TypeScript and can be proven correct before any schema exists.

**Do not** attempt the whole MVP in one branch. Each milestone is a reviewable unit with a
behavioural gate.

## What not to re-research

Verified 2026-08-16 against primary sources; re-check only if something visibly breaks:

- Cardmarket and TCGplayer developer APIs are closed to new applicants
- pokemontcg.io returns HTTP 500 and is not viable
- TCGdex relays Cardmarket EUR and TCGplayer USD prices free, no key; 23 444 EN cards, 218 EN
  sets, 177 JA sets
- No free source of historical EUR card prices exists
- No free EUR source for sealed or graded prices exists
- Norges Bank FX API works, no key
- Supabase free plan: 500 MB DB, no automated backups, pauses after ~7 days idle, `pg_cron`
  available, built-in email limited to 2/hour project-wide
- Cloudflare Pages free: unlimited bandwidth, 500 builds/month, no card
- GitHub Actions free: 2 000 private-repo minutes/month, $0 default spending limit
- Node 24 is Active LTS

## Commands

Nothing runs yet. Once M1 lands, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §3. The gate
command is `pnpm check`.

## Owner actions outstanding

| # | Action | Blocks |
|---|---|---|
| 1 | Create a Supabase account (free plan, no card) | M3 onward. Not needed for M1 or M2. |
| 2 | Optional: install Docker Desktop for a local Supabase stack | Local database testing only |

Nothing blocks starting M1 today.
