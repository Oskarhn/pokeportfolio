# Handover

Current-state document, written for a session that knows nothing from any earlier conversation.
Read this first, update it last. History lives in [CHANGELOG.md](CHANGELOG.md) and
[docs/PROJECT_JOURNAL.md](docs/PROJECT_JOURNAL.md).

**Last updated:** 2026-08-20 — M1 (scaffold and harness), M2 (financial domain core), M3
(database, migrations, RLS) and M4 (invite-only authentication) complete.

---

## Status

**Planning is FROZEN. M1–M4 are complete and merged to `main`.**
**M5 (catalog and search) is next.** See the Repository section for PR numbers.

Scope is settled — do not reopen it (see [docs/PLANNING_FREEZE.md](docs/PLANNING_FREEZE.md) §9).

## Read these first, in order

1. `HANDOVER.md` — this file
2. `docs/PLANNING_FREEZE.md` — the authoritative frozen scope
3. `docs/PRODUCT_SPEC.md` — what the product does
4. `docs/ARCHITECTURE.md` — the stack and why
5. `docs/DATA_MODEL.md` — schema, ownership, lifecycle (§12 has the scoping notes — read it,
   several tables and enum values that earlier sections imply exist are deliberately deferred)
6. `docs/FINANCIAL_MODEL.md` — **the most important technical document here**
7. `docs/SECURITY.md` — §5 is the invite-only model; §12's checklist is short and load-bearing
8. `docs/TESTING.md` — the mandatory gates
9. `docs/GIT_WORKFLOW.md` — branch/PR/CI/merge workflow
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

1. **Every physical card is trackable** — energies, commons, duplicates, unpriced cards. (D-017)
2. **Lot-based cost basis.** `card_variant` → `holding` → `acquisition_lot`. (D-001)
3. **Cost basis is a state**, not a nullable number. (D-002, D-020)
4. **Price history is keyed per card variant, never per copy.** (D-019)
5. **Manually costed openings create a real provisional purchase**, voided when the receipt
   arrives. Money counted exactly once. (D-021)
6. **Email + password**, not OTP — the built-in mail provider allows 2 emails/hour. (D-022)
7. **Four distinct grouping concepts**: storage location, custom collection, tag, smart filter.
   (D-018)
8. **Collection value is the primary dashboard figure.** (D-023)
9. **Scanner ships before openings** post-MVP. (D-024)
10. **JSON backup is in MVP**, versioned. (D-025)
11. **No condition multipliers.** (D-009) · 12. **No fabricated price history.** (D-008)
13. **Raw prices never value graded cards.** (F10)
14. **Vite SPA, not a meta-framework.** (D-004)
15. **Scanner owns one route and one MediaStream.** (D-006)
16. **`user_id` denormalised onto child tables.** (D-011)
17. **Admin has no application access to other users' data.** (SECURITY §4)
18. **The $50 lifetime ceiling is not standing spending authorization.** (D-027)
19. **Invite-only is two server-side gates, and the auth hook denies unconditionally.** (D-028)
20. **Invitations bind to an address; redeemed accounts are created already confirmed.** (D-029)
21. **Invitation tokens are SHA-256, not a password hash.** (D-030)
22. **Invitation management is a Postgres RPC; only redemption is an Edge Function.** (D-031)
23. **Password policy is length-only: minimum 12, no composition rules.** (D-032)

## Architecture

| Layer | Choice |
|---|---|
| Frontend | Vite · React 19 · TypeScript strict · TanStack Router + Query |
| UI | Tailwind v4 · shadcn/ui on Base UI, copied in and owned |
| Charts | `lightweight-charts` — **validate with a spike before building the dashboard**; fallback visx |
| Backend | Supabase — PostgreSQL + RLS, Auth, Edge Functions, `pg_cron`, free plan |
| Auth | Email + password, invite-only, enforced by two independent server-side gates |
| Catalog + raw prices | TCGdex (free, no key) — Cardmarket EUR, TCGplayer USD |
| FX | Norges Bank EXR API |
| Sealed + graded value | Manual valuation — no free EUR source exists |
| Hosting | Cloudflare Pages, static — **not set up yet** |
| Money | Integer minor units + ISO 4217. Never float. |

## How invite-only actually works

Full detail in [docs/SECURITY.md](docs/SECURITY.md) §5. The shape a new session needs:

**Gate 1 — the Before User Created auth hook.** `public.before_user_created` rejects *every*
invocation. GoTrue calls this hook from every self-service account-creation path and from none of
the Auth Admin API — verified against the `supabase/auth` source, recorded as R21. So the hook needs
to inspect nothing: there is no metadata to forge and no window to race. It lives in
`supabase/config.toml`, so it reaches a project through `supabase config push`, never a dashboard
toggle.

**Gate 2 — a `BEFORE INSERT` trigger on `auth.users`** requiring a live `invitation_claims` row
(invariant S2). Travels with the migrations, and closes what the hook does not: the Auth Admin API
and the dashboard.

**Consequence a new session will hit immediately:** `auth.admin.createUser` no longer works on its
own, for anyone. Creating a user means issuing an invitation, claiming it, creating, finalizing —
all service-role-only. `tests/db/setup.ts` already does this; use `createSyntheticUser`.

**Why not the obvious design.** A hook that allowed signup for any address holding a valid
invitation would let whoever knew that address set the password before the invited person opened
their link. Knowing an address is not possessing a token. Do not "simplify" toward that.

## The thing most worth knowing before touching the schema

**A `GRANT` adds; it never restricts.** M3 wrote a column-restricted `UPDATE` grant on `profiles`
intending to exclude `is_admin`, and on the deployed project — which auto-grants the Data API roles
broad privileges on new tables — it excluded nothing. A signed-in non-admin could set their own
`is_admin` flag while the authorization suite was green.

Every privilege is now expressed as **revoke, then grant**
(`20260820120050_m4_revoke_then_grant_table_privileges.sql`). Keep doing that. And note the wider
lesson: **CI is a reproducibility gate, not a statement about a deployed project.** Run
`node scripts/remote-security-check.mjs` after any deploy touching auth, policies or grants.

## Environment

| Item | State |
|---|---|
| Node.js | 24.19.0 LTS, **not on this machine's default PATH** — prepend `C:\Program Files\nodejs`. |
| pnpm | 10.15.0. Installed via `npm install -g` into `%APPDATA%\npm`, which is **also not on the default PATH** — prepend both, or call binaries directly (`.\node_modules\.bin\supabase.CMD`). |
| TypeScript | **6.0.3, deliberately not 7.x** — `typescript-eslint` peer-caps at `<6.1.0`. |
| Git | 2.51.1 · GitHub CLI 2.97.0, authenticated as `Oskarhn` |
| Docker Desktop | Still not installed. Not a blocker — CI runs the full local Supabase stack on `ubuntu-latest`. `supabase db push` warns about it harmlessly. |
| Supabase CLI | 2.114.0, pinned as a devDependency. **Authenticated** as of M4. |
| Playwright browsers | chromium + webkit installed locally. |
| Cloudflare | No project yet. Create when deployment is first needed. |

## Remote Supabase project

| Item | Value |
|---|---|
| Name | `pokeportfolio-dev` — **development only**, never production |
| Ref | `nopmkroeygmlvndzjjqs` (a public identifier, not a secret) |
| Region | **`eu-west-3` (Paris)**, not the `eu-north-1` the docs planned. EU either way, so GDPR posture is unchanged and ~20 ms of latency did not justify recreating it and re-entering a database password. A future production project should still choose deliberately rather than inherit this. |
| Plan | **Free. No payment card. No billing enabled.** |
| Postgres | 17.6 |
| State | All 14 migrations applied · `config push` done, so the auth hook is live · `redeem-invitation` deployed · verified 33/33 by `scripts/remote-security-check.mjs` |

**The remote is never the source of truth.** Schema and security live in `supabase/migrations/` and
`supabase/config.toml`. A clean environment must be reconstructible from the repository plus
secrets. If you find drift, reconcile toward the repository.

### Secrets, conceptually — never values, never in this file

| Secret | Where it lives |
|---|---|
| Database password | The owner's password manager. Claude has never seen it. |
| Supabase CLI access token | The CLI's own credential store, created by `supabase login`. |
| Publishable key (legacy `anon`) | `.env.local` (gitignored). Public by design. |
| Secret key (legacy `service_role`) | The Supabase platform only, injected into the Edge Function environment. Never fetched into a session, never in the repo, never in `claude_outputs/`. |

`.env.local` currently points at **placeholders**, not the remote project. Point it at
`https://nopmkroeygmlvndzjjqs.supabase.co` plus the publishable key to run `pnpm dev` against real
data. Get the key from the dashboard or
`.\node_modules\.bin\supabase.CMD projects api-keys --project-ref nopmkroeygmlvndzjjqs`.

## Repository

- `https://github.com/Oskarhn/pokeportfolio` — **private**
- M1/M2 via [PR #1](https://github.com/Oskarhn/pokeportfolio/pull/1), M3 via
  [PR #2](https://github.com/Oskarhn/pokeportfolio/pull/2), M4 via
  [PR #3](https://github.com/Oskarhn/pokeportfolio/pull/3). All squash-merged, branches deleted.
- PR #4 was the deliberate negative security test — both invite-only gates disabled to prove the
  suite fails. Closed unmerged, branch deleted. It is not a mistake in the history.
- `claude_outputs/` is gitignored and must stay that way.
- `.claude/launch.json` and `.env.local` are gitignored and machine-local.

## Known issues and limitations

- **Node and pnpm are not on this machine's default shell PATH.** Prepend both, or call binaries
  directly. CI is unaffected.
- **TypeScript pinned to 6.0.3**, solely because `typescript-eslint` does not support TS 7 yet.
- **`src/lib/` does not exist yet** — deliberately, per the no-placeholder-directories rule.
- **No deployment.** Cloudflare Pages is not set up, so the app runs only on `localhost`. Invitation
  links therefore point at `localhost:5173` today; they are built from the browser's own origin, so
  they will follow the deployment automatically.
- **The installed-PWA-on-a-phone check is not done.** It needs the app deployed somewhere a phone
  can reach. It is the one part of M4's gate still outstanding; see docs/TESTING.md §8.
- **`m4-remote-check-2@example.invalid` is a leftover synthetic account** on the dev project from the
  remote verification. Harmless; delete it with
  `delete from auth.users where email = 'm4-remote-check-2@example.invalid';` when convenient. It is
  also a live test of the account-deletion cascade.
- **No administrator exists on the dev project yet.** Run the bootstrap in docs/DEVELOPMENT.md §7
  once, for the owner's own address, before using the admin invitation screen.
- **Regenerate `src/data/database.types.ts` (`pnpm db:types`) in the same commit as any migration.**
  It is generated from CI's ephemeral stack, downloaded from the `database-types` artifact.

## Open uncertainties

None block M5. Detail in [docs/RESEARCH.md](docs/RESEARCH.md).

| # | Uncertainty | Needed by |
|---|---|---|
| U2 | Whether Cardmarket's public Product Catalogue covers Pokémon sealed, and its terms | Sealed valuation improvement |
| U3 / U4 | TCGdex rate limits and price cadence in practice | M9 |
| S6 | Whether camera permission survives an in-route session on current iOS | **Spike before M15** |
| S7 | Whether Basic Energy printings are distinguishable by image at all | M15 |
| — | Whether TCGdex models Basic Energy printings adequately | M5, verify at ingest |
| — | Trade item-leg accounting rule: carryover vs fair value | M18 only |

## Next actions

**M1–M4 are done.** Start **M5 — Catalog and search**
([docs/ROADMAP.md](docs/ROADMAP.md)). Before writing ingest code:

1. **Re-verify TCGdex** against its current documentation. The M3-era findings (23 444 EN cards,
   218 EN sets, 177 JA sets, Cardmarket EUR and TCGplayer USD relayed free without a key) were
   recorded on 2026-08-16 and should be re-checked, not assumed.
2. **Check how TCGdex models Basic Energy printings** at ingest — a listed uncertainty, and D-017
   means they are first-class inventory rather than something to aggregate away.
3. Ingest runs server-side into the shared catalog tables, which have **no client write grant** —
   that is deliberate, so the ingest path is a service-role/Edge Function concern.
4. Every external payload gets parsed and validated at the boundary (DEVELOPMENT.md §6).

Two small things worth doing early, neither of which is M5:

- **Deploy to Cloudflare Pages.** It unblocks the installed-PWA check, real invitation links and
  phone testing, and it is free.
- **Bootstrap the owner's admin account** on the dev project (DEVELOPMENT.md §7).

**Do not** attempt the whole MVP in one branch. Each milestone is a reviewable unit with a
behavioural gate.

## What not to re-research

Verified 2026-08-16, re-check only if something visibly breaks: Cardmarket and TCGplayer developer
APIs closed to new applicants · pokemontcg.io returns HTTP 500 · TCGdex relays Cardmarket EUR and
TCGplayer USD free, no key · no free source of historical EUR card prices · no free EUR source for
sealed or graded prices · Norges Bank FX API works, no key · Supabase free plan: 500 MB DB, no
automated backups, pauses after ~7 days idle, `pg_cron` available, built-in email 2/hour
project-wide · Cloudflare Pages free: unlimited bandwidth, 500 builds/month, no card · GitHub
Actions free: 2 000 private-repo minutes/month, $0 default spending limit · Node 24 is Active LTS.

Verified 2026-08-17: `typescript-eslint` peer-caps TypeScript at `<6.1.0` · `gitleaks` CLI is MIT
with no license key · `corepack enable` fails `EPERM` on a non-admin Windows account · Supabase CLI
belongs as a devDependency · PostgREST serializes `bigint` as a JSON number, losing precision above
2^53 (cast money columns to text) · `ubuntu-latest` ships Docker, so `supabase start` works in CI.

Verified 2026-08-20 (M4, and all load-bearing — see RESEARCH R21–R23):

- **GoTrue invokes the Before User Created hook from every self-service account-creation path and
  from none of the Auth Admin API.** Established by reading `supabase/auth` at master, not from
  documentation. The entire invite-only design rests on it, so the authorization suite asserts both
  halves — public signup fails *and* redemption succeeds — and drift in either direction fails CI.
- The hook is available on Free, configurable as `[auth.hook.before_user_created]` in `config.toml`,
  and reaches a project through `supabase config push`.
- Supabase is migrating `anon`/`service_role` to `sb_publishable_…`/`sb_secret_…`; legacy keys are
  deprecated at the end of 2026. Semantics unchanged; both names appear in this repository.
- GoTrue lowercases every email it stores (`strings.ToLower`), which is why invitations normalize
  with `lower(btrim(...))` rather than inventing a competing rule.
- **A Supabase project may auto-grant the Data API roles privileges on new tables and functions**,
  and `GRANT` is additive — so a narrow grant does not restrict. This produced a live privilege
  escalation that CI could not see. See the journal entry.

## Commands

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm check        # typecheck + lint + format:check + test — the pre-commit gate
pnpm test:db      # database + authorization suites — needs `pnpm db:start` (Docker), or read CI
pnpm test:e2e     # Playwright, builds + previews first
pnpm build
```

Remote, all deliberate acts rather than a loop (DEVELOPMENT.md §3):

```bash
pnpm exec supabase db push
pnpm exec supabase config push
pnpm exec supabase functions deploy redeem-invitation
node scripts/remote-security-check.mjs
```

**Green as of the M4 merge:** 67 domain/property tests · 26 Playwright tests (desktop + iPhone) ·
11 database and authorization test files, including 18 invite-only attack cases, 22 admin
authorization cases and the function-grant surface · 33/33 remote checks against the dev project.
CI runs `build-and-test` (gate + E2E + gitleaks) and `db-tests` (ephemeral Supabase stack → migrate
→ assert the Edge Function is reachable → suites → generate types) on every push and PR, with **no
remote credentials anywhere**.

## Owner actions outstanding

| # | Action | Blocks |
|---|---|---|
| 1 | Bootstrap the admin account on the dev project (DEVELOPMENT.md §7) | Using the admin invitation screen |
| 2 | Delete the leftover `m4-remote-check-2@example.invalid` account | Nothing — tidiness |
| 3 | Optional: create a free Cloudflare Pages project | Installed-PWA check, phone testing, real invitation links |
| 4 | Optional: install Docker Desktop | Local iteration convenience only |
| 5 | Optional: fix Node/pnpm absence from the default PATH | Convenience only |

Nothing blocks starting M5.
