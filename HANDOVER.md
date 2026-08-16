# Handover

Current-state document. A fresh session should be able to continue from this file alone.
Not a history log — [CHANGELOG.md](CHANGELOG.md) and
[docs/PROJECT_JOURNAL.md](docs/PROJECT_JOURNAL.md) hold history.

**Last updated:** 2026-08-16 — Phase 1 (Foundation) complete; awaiting owner review before
Phase 2.

---

## Product

PokePortfolio is a private, invite-only application for tracking a Pokémon TCG collection as
both a collection and a set of financial records. It maintains a permanent spending ledger that
survives products being opened, cards being graded and items being sold, alongside market
valuation and portfolio history. Primary platform is an installed PWA on iPhone; desktop is
first-class for bulk work. Expected scale: 1–10 users.

Full definition: [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md).

## Current goal

Owner review of the Phase 1 foundation. After approval, begin **Phase 2 — Scaffold**
([docs/ROADMAP.md](docs/ROADMAP.md)).

## Current state

Documentation and repository foundation only. **No application code exists.**

| Item | State |
|---|---|
| Canonical documentation | Complete — 17 documents |
| Financial model | Locked: 10 worked examples, 11 invariants |
| Data model | Locked: full lifecycle, no provenance loss |
| Architecture | Selected |
| Security model | Defined; not implemented |
| Test strategy | Defined; no tests written |
| Node.js | 24.19.0 LTS installed |
| GitHub CLI | Installed; **not authenticated** |
| Git repository | Initialised, first commits made |
| GitHub remote | Not created — blocked on auth |
| Supabase project | Not created |
| Docker Desktop | Not installed (needed only for a local Supabase stack) |

## Architecture

| Layer | Choice |
|---|---|
| Frontend | Vite · React 19 · TypeScript strict · TanStack Router + Query |
| UI | Tailwind v4 · shadcn/ui on Base UI (owned, copied in) |
| Charts | TradingView `lightweight-charts` — validate with a spike before building on it |
| Backend | Supabase, region `eu-north-1` (Stockholm), free plan |
| Auth | Email OTP, six digits, invite-only enforced server-side |
| Catalog + raw prices | TCGdex (free, no key) — Cardmarket EUR and TCGplayer USD |
| FX | Norges Bank EXR API |
| Sealed + graded value | Manual valuation — no free EUR source exists |
| Hosting | Cloudflare Pages |
| Money | Integer minor units, ISO 4217, never float |

Reasoning: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Key decisions — do not reverse without reading DECISIONS.md

1. **Lot-based cost basis.** `card_variant` → `holding` → `acquisition_lot`. Never average
   duplicate costs. (D-001)
2. **Opening pulls have `NULL` cost basis, never zero.** `NULL` means not applicable. No
   per-card ROI for pulls; return is computed at opening scope. (D-002)
3. **No condition multipliers.** The price source is not condition-specific; inventing
   percentages was considered and rejected. (D-009)
4. **No fabricated price history.** History accumulates from our own daily snapshots and begins
   at first tracking. (D-008)
5. **Raw prices never value graded cards.** (F10)
6. **Snapshot only held variants**, not the full catalog — the 500 MB free-tier ceiling. (R13)
7. **Vite SPA, not a meta-framework.** Every screen is authenticated; SSR buys nothing. (D-004)
8. **Email OTP, not magic links.** A magic link opens Safari, not the installed PWA. (D-005)
9. **Scanner owns one route and one MediaStream.** iOS re-prompts for camera permission on URL
   change. Decided before the scanner is built. (D-006)
10. **`user_id` denormalized onto child tables** for one-line RLS predicates. (D-011)
11. **Admin has no application access to other users' data.** (SECURITY §4)
12. **Repository stays private.** Never change visibility. (PUBLICATION_CHECKLIST)

## Recently completed

Phase 1. Research verified against primary sources and live API probes, decisions consolidated,
17 canonical documents written, toolchain installed, repository initialised with
secret-prevention configuration.

Two earlier recommendations were corrected during this phase rather than carried forward:
zero-cost basis for opening pulls (now `NULL`), and invented condition multipliers (now none).
Both are recorded in the journal.

## In progress

Nothing. Phase 1 is closed.

## Known issues

None in the codebase — there is no codebase. Environmental gaps:

- GitHub CLI is not authenticated, so no remote exists.
- Docker Desktop is absent, so a local Supabase stack cannot run yet. A remote dev project is
  the documented fallback.

## Research uncertainties

Carried deliberately. None block Phase 2. Full detail in [docs/RESEARCH.md](docs/RESEARCH.md).

| # | Uncertainty | Needed by |
|---|---|---|
| U1 | Whether TCGdex has any arrangement with Cardmarket/TCGplayer for relaying prices | Before any public release |
| U2 | Whether Cardmarket's public Product Catalogue covers Pokémon sealed, and its terms — requires an authenticated session | Sealed valuation, V1 |
| U3 | TCGdex rate limits in practice | Ingest batch sizing, Phase 6 |
| U4 | TCGdex price update cadence | Snapshot scheduling, Phase 6 |
| U5 | Real-device iOS PWA behaviour | PWA polish, V1 |
| U6 | Whether manual sealed/graded valuation is tolerable in daily use | Reassess after real use |
| S6 | Whether camera permission survives an in-route session on current iOS | Spike before Phase 12 — gates the scanner approach |

## Blockers and owner actions

| # | Action | Blocks |
|---|---|---|
| 1 | Authenticate GitHub CLI: `gh auth login` | Creating the private remote and pushing |
| 2 | Review and approve the Phase 1 foundation | Starting Phase 2 |
| 3 | Create a Supabase account and project, `eu-north-1`, free plan — or approve the agent doing so | Phase 2.2 onward |
| 4 | Optional: install Docker Desktop for a local Supabase stack | Local database testing; remote dev project works without it |

## Next actions

In order, once the blockers above are cleared:

1. Create the private GitHub repository `pokeportfolio` and push.
2. Phase 2.1 — Vite + React + TS scaffold, strict config, pnpm, lint, format. Gate:
   `pnpm check` passes.
3. Phase 2.2 — Supabase project, first migration, generated types.
4. Phase 2.3 — Domain layer: `Money`, allocator, currency table. Gate: allocator property tests
   pass (F6).
5. Phase 2.4 — Test harness including the two-client authorization fixture. Verify a
   deliberately failing isolation test actually fails.
6. Phase 2.5 — CI. Phase 2.6 — PWA shell.

Do not begin Phase 3 until the Phase 2 gate is met.

## Important files

Read in this order for a cold start:

1. `HANDOVER.md` — this file
2. `CLAUDE.md` — working rules, documentation precedence, skill routing
3. `docs/PRODUCT_SPEC.md` — what is being built
4. `docs/FINANCIAL_MODEL.md` — the most important technical document in the repository
5. `docs/DATA_MODEL.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md` — as the task requires
6. `docs/ROADMAP.md` — the current phase and its gate

## Commands

Nothing runs yet. Once the scaffold exists, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §3.
The gate command is `pnpm check` (typecheck + lint + test).

## External services

| Service | Purpose | Auth | Cost | State |
|---|---|---|---|---|
| TCGdex | Catalog, images, raw prices | None | Free | Verified, not yet integrated |
| Norges Bank | FX rates | None | Free | Verified, not yet integrated |
| Supabase | Database, auth, functions, cron | Project keys | Free plan | **Not created** |
| Cloudflare Pages | Hosting | Account | Free | Not created |
| GitHub | Source control | `gh auth` | Free | **Not authenticated** |

No secrets exist yet. When they do: `.env.local` only, `service_role` in Supabase Edge Function
secrets only, never in this repository.

## Git and GitHub state

- Local repository initialised on branch `main`; working tree clean.
- Author identity is set **repo-locally** to the GitHub-provided `noreply` address so no personal
  email appears in commit metadata. Global Git config was not touched.
- Local mentor handoff files under `claude_outputs/` are gitignored and must stay that way. They
  are not project documentation and must never be committed.
- **No remote.** Repository must be created **private**.
- Never change visibility without the owner's explicit approval and a completed pass through
  [docs/PUBLICATION_CHECKLIST.md](docs/PUBLICATION_CHECKLIST.md).
