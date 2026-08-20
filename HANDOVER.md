# Handover

Current-state document, written for a session that knows nothing from any earlier conversation.
Read this first, update it last. History lives in [CHANGELOG.md](CHANGELOG.md) and
[docs/PROJECT_JOURNAL.md](docs/PROJECT_JOURNAL.md).

**Last updated:** 2026-08-17 — M1 (scaffold and harness), M2 (financial domain core) and M3
(database, migrations, RLS) complete.

---

## Status

**Planning is FROZEN. M1, M2 and M3 are complete and merged to `main`.**
**M4 (auth and invitations) is next.** See the Repository section below for the M3 PR number and
merge commit.

The next session's job is to begin **M4**, following [docs/ROADMAP.md](docs/ROADMAP.md). Scope is
settled — do not reopen it (see [docs/PLANNING_FREEZE.md](docs/PLANNING_FREEZE.md) §9).

## Read these first, in order

1. `HANDOVER.md` — this file
2. `docs/PLANNING_FREEZE.md` — the authoritative frozen scope
3. `docs/PRODUCT_SPEC.md` — what the product does
4. `docs/ARCHITECTURE.md` — the stack and why
5. `docs/DATA_MODEL.md` — schema, ownership, lifecycle (§12 has the M3 scoping notes — read it,
   several tables/enum values a naive reading of earlier sections implies exist are deliberately
   deferred to later milestones)
6. `docs/FINANCIAL_MODEL.md` — **the most important technical document here**
7. `docs/SECURITY.md` — RLS, invites, secrets
8. `docs/TESTING.md` — the mandatory gates
9. `docs/GIT_WORKFLOW.md` — branch/PR/CI/merge workflow, new as of M3
10. `docs/COST_POLICY.md` — the zero-cost constraint and verified service matrix
11. `docs/ROADMAP.md` — milestones and their gates
12. `CLAUDE.md` — working rules and skill routing

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
| **Budget: target $0/month, $50 USD lifetime ceiling** | The ceiling (D-027) is **not** pre-authorized spending — every purchase still needs individual owner approval per [COST_POLICY.md](docs/COST_POLICY.md) §1a, and nothing may be spent before the free functional baseline (§1b) exists. Actual spend to date: **$0**. When a feature cannot be built well for free, **postpone it**. Never enter payment details or enable billing without that approval. |
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
18. **The $50 lifetime cost ceiling is not standing spending authorization** — every purchase
    still needs individual owner approval, and nothing is spent before a free functional baseline
    exists. (D-027)

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
| Node.js | 24.19.0 LTS installed, but **not on this machine's default PATH** — full path is `C:\Program Files\nodejs`. Prepend it explicitly in shell commands (`$env:Path = "C:\Program Files\nodejs;" + $env:Path` in PowerShell) until/unless the machine's PATH is fixed outside this repo. |
| pnpm | 10.15.0, pinned via `package.json` `packageManager`. `corepack enable` fails with `EPERM` on this machine (Program Files isn't user-writable without elevation) — installed instead via `npm install -g pnpm@10.15.0` into the user-writable npm prefix. CI uses Corepack normally (GitHub-hosted runners don't have this permission issue). See docs/DEVELOPMENT.md §1. |
| TypeScript | **6.0.3, deliberately not the 7.x line** — `typescript-eslint` (as of 2026-08-17) caps its peer range at `<6.1.0`. Revisit when typescript-eslint supports TS 7. |
| Git | 2.51.1 |
| GitHub CLI | 2.97.0, authenticated as `Oskarhn` |
| Docker Desktop | **Still not installed** on this machine, and it was never a blocker for M3 — CI runs the full local Supabase stack on GitHub's `ubuntu-latest` runner, which has Docker preinstalled. Installing it locally remains an optional future convenience for interactive migration iteration. |
| Supabase CLI | 2.114.0, pinned as a project devDependency (`pnpm add -D supabase`), invoked via `pnpm exec supabase ...`. |
| Supabase remote project | **Still not created as of end of M3.** M3's gate (migrations apply; RLS isolation proven) is fully satisfied by CI's ephemeral stack and did not require it. A remote free dev project (`eu-north-1`) is still needed before M4, for `pnpm dev` against persisted data and for the redeem-invitation Edge Function to have somewhere to deploy to — see Owner actions below. |
| Cloudflare | No project yet. Create when deployment is first needed. |

## Repository

- `https://github.com/Oskarhn/pokeportfolio` — **private**
- M1/M2 landed via [PR #1](https://github.com/Oskarhn/pokeportfolio/pull/1)
  (`feat/foundation-domain-core`), CI green, squash-merged to `main` at `c7051b1`. The source
  branch is deleted.
- M3 landed via PR #`<filled in at merge — see docs/GIT_WORKFLOW.md for the standard workflow>`
  (`feat/m3-database-rls`), CI green including the new `db-tests` job, squash-merged to `main` at
  `<commit filled in at merge>`. The source branch is deleted. `main` is pushed and the working
  tree is clean.
- `docs/GIT_WORKFLOW.md` (new in M3) is now the canonical reference for the branch/PR/CI/merge
  process every subsequent milestone follows.
- Author identity is set repo-locally to the GitHub `noreply` address. No personal email appears
  anywhere in metadata, content or the object database. Verified.
- `claude_outputs/` is gitignored and must stay that way. It is a local mentor-handoff channel,
  not project documentation, and must never be committed.
- `.claude/launch.json` (dev-server preview config) is gitignored and machine-local — recreate it
  if missing; see docs/DEVELOPMENT.md.

## Output file convention

`claude_outputs/output_N.txt`, one per major phase. **The number is stated explicitly in each
prompt — never infer it, and never backfill missing historical files.** Last completed: 6. Next
expected: 7.

## Known issues

- **Node is not on this machine's default shell PATH.** Every shell command that needs
  node/npm/pnpm must prepend `C:\Program Files\nodejs` (and, for global npm-installed tools,
  `%APPDATA%\npm`) to `$env:Path` first. This is a machine configuration issue, not a repository
  issue — CI is unaffected (GitHub-hosted runners don't have it).
- **TypeScript is pinned to 6.0.3, not 7.x**, solely because `typescript-eslint` doesn't support
  TS 7 yet (peer range `<6.1.0` as of 2026-08-17). `create-vite` scaffolds 7.x by default; do not
  let a future `pnpm update` silently jump the major version without re-checking that peer range.
- **`src/data/database.types.ts` does not exist in the repository yet.** `pnpm db:types` needs a
  live schema to introspect; the M3 PR generates it via CI's ephemeral stack and uploads it as a
  workflow artifact rather than assuming its shape. Whoever picks up M4/M5 should run
  `pnpm db:start && pnpm db:types` (or download the CI artifact) and commit the result in the
  first commit that actually needs typed queries — do not hand-write this file.
- `src/features/`, `src/lib/` do not exist yet — deliberately. They arrive when a later milestone
  gives them real content (CLAUDE.md's "no placeholder directories" rule).
- **The `auth.users` S2 backstop trigger (reject signup without a redemption) is not implemented
  yet, and — corrected mid-M3 after a real CI failure — nothing else closes that door either.**
  `[auth] enable_signup = false` looked like the obvious config-level stopgap and was tried first,
  but it turned out to also disable email/password *login* for every existing user, not just new
  self-registration (a known GoTrue behaviour, confirmed empirically when it broke the M3
  authorization suite in CI). It was reverted to the platform default (`true`). This is a
  deliberate M3/M4 boundary, not an oversight — see DATA_MODEL.md §12 and SECURITY.md — but unlike
  the earlier draft of this file claimed, it **is** currently exploitable (public signup works)
  in any environment this schema is deployed to. Nothing here has a public deployment yet, so
  there is no live exposure today, but the S2 trigger is not optional polish for M4 — it is the
  only thing that will actually close this.
- **No remote Supabase project is linked yet.** M3's gate did not require one (CI's ephemeral
  stack proved it). M4 needs one for the Edge Function and for `pnpm dev` against real data — see
  Owner actions below.

## Open uncertainties

None block M4. Detail in [docs/RESEARCH.md](docs/RESEARCH.md).

| # | Uncertainty | Needed by |
|---|---|---|
| U2 | Whether Cardmarket's public Product Catalogue covers Pokémon sealed, and its terms. Requires an authenticated session. | Sealed valuation improvement |
| U3 / U4 | TCGdex rate limits and price cadence in practice | M9 |
| S6 | Whether camera permission survives an in-route session on current iOS | **Spike before M15** — gates the scanner approach |
| S7 | Whether Basic Energy printings are distinguishable by image at all | M15 |
| — | Whether TCGdex models Basic Energy printings adequately | M5, verify at ingest |
| — | Trade item-leg accounting rule: carryover vs fair value | M18 only |

## Next actions

**M1, M2 and M3 are done.** Start **M4 — Auth and invitations**
([docs/ROADMAP.md](docs/ROADMAP.md)):

1. Create the Supabase remote project (`eu-north-1`, free plan) if not already done — **requires
   the owner's Supabase account**, see Owner actions below. Link it with `supabase link`.
2. `redeem-invitation` Edge Function: the sole account-creation path, validating token hash,
   expiry, use count and revocation, creating the user with the service role.
3. The `auth.users` backstop trigger (S2) — deferred from M3, see Known issues above. Build it
   alongside the Edge Function it depends on, and update the M3 authorization test fixture
   (`tests/db/setup.ts`'s `createSyntheticUser`) if the backstop needs synthetic users to carry a
   redemption row too.
4. Admin invitation management (create/revoke) — the `invitations` schema and RLS already exist
   from M3.
5. Password reset via the built-in low-volume email, with the admin-assisted fallback documented
   in SECURITY.md §5.1.
6. Extend `tests/authorization/` to cover the real signup/redemption path per TESTING.md §4's
   invite-only attack table (expired/revoked/reused tokens, direct signUp rejection).

**Gate:** direct public signup is rejected (S2); the full authorization suite passes; login works
inside an installed PWA on a phone.

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

Verified 2026-08-17:

- `typescript-eslint` (latest as of this date) peer-caps TypeScript at `<6.1.0` — TS 7.x is not
  yet supported. `create-vite` defaults to TS 7.x; this repo pins 6.0.3 instead.
- `gitleaks` (the CLI/Docker image itself) is MIT-licensed with no license key required for any
  use case, including private repos. The separate `gitleaks-action` GitHub Marketplace wrapper
  has its own licensing story for organisations; this repo avoids that question entirely by
  running the official `zricethezav/gitleaks` Docker image directly in CI instead of the
  Marketplace action.
- `corepack enable` fails with `EPERM` on a non-admin Windows account when Node is installed to
  `C:\Program Files\nodejs` — a Windows/ACL fact, not a pnpm or Corepack bug.
- Supabase CLI: `pnpm add -D supabase` is the current official way to pin it as a project
  devDependency (not a global npm/pnpm install) — verified 2026-08-17. Run it via
  `pnpm exec supabase ...`.
- PostgREST serializes Postgres `bigint` as a plain JSON number by default, which loses precision
  above `Number.MAX_SAFE_INTEGER` — confirmed against supabase/postgrest-js issues #319 and #419,
  and proven against the actual local stack in `tests/db/money-boundary.test.ts`. Every future
  query selecting a money column must cast to text (`total_minor::text`); see
  `src/data/money.ts`.
- GitHub Actions' `ubuntu-latest` runners have Docker preinstalled, so `supabase start` (a
  Docker-based local stack) runs there with no extra setup — this is what let M3's CI `db-tests`
  job exist without installing Docker Desktop on this development machine.

## Commands

Live now; see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §3 for the full table.

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm check        # typecheck + lint + format:check + test — the gate, currently green
pnpm test:db      # database + authorization suites — needs `pnpm db:start` first (Docker), or read CI logs
pnpm test:e2e     # Playwright, builds + previews first
pnpm build
```

67 unit/property tests pass (`tests/financial/`, `tests/data/`), 4 Playwright smoke tests pass
(desktop + mobile-iPhone viewport). The database and authorization suites
(`tests/db/`, `tests/authorization/`) pass in CI against an ephemeral local Supabase stack — they
cannot run on this development machine directly (no Docker), only via CI or a linked remote
project. CI runs `build-and-test` (the same local gate plus a `gitleaks` secret scan) and
`db-tests` (migrate → authorization suite → generate types) on every push and PR.

## Owner actions outstanding

| # | Action | Blocks |
|---|---|---|
| 1 | Create a Supabase account and a free-plan `eu-north-1` remote dev project (no card) | M4 (Edge Function deployment target, `pnpm dev` against real data) |
| 2 | Optional: install Docker Desktop for a local Supabase stack | Local iteration convenience only — CI already covers the gate without it |
| 3 | Optional: fix Node's absence from this machine's default PATH | Convenience only — see Known issues |

Nothing blocks starting M4's schema/Edge-Function work today; item 1 blocks deploying and
end-to-end testing the redeem-invitation flow specifically.
