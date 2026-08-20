# Handover

Current-state document, written for a session that knows nothing from any earlier conversation.
Read this first, update it last. History lives in [CHANGELOG.md](CHANGELOG.md) and
[docs/PROJECT_JOURNAL.md](docs/PROJECT_JOURNAL.md).

**Last updated:** 2026-08-20 — M1 (scaffold and harness), M2 (financial domain core), M3
(database, migrations, RLS), M4 (invite-only authentication), M4.1 (privilege convergence,
deployment, real end-to-end) and M5 (catalog, TCGdex ingest, search) complete.

---

## Status

**Planning is FROZEN. M1–M5 are complete.** M6 (collection: holdings, lots, origin) is next. See
the Repository section for PR numbers.

The application is deployed and reachable: **https://pokeportfolio-dev.pages.dev**. The owner has a
working administrator account on the development project, and the shared catalog now holds the real
English and Japanese physical Pokémon TCG card set — see "M5 — Catalog, ingest and search" below.

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
24. **`card_variants` identity is finish + stamp + subtype, not one enum.** (D-033)
25. **Provider ids are scoped per language; marketplace product ids are not per-variant identity.**
    (D-034)
26. **Catalog ingest is gated by an operator secret, not a user session.** (D-035)

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
| Hosting | Cloudflare Pages, static — deployed since M4.1, `pokeportfolio-dev.pages.dev` |
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

Every privilege is expressed as **revoke, then grant**, and M4.1 made that converge from a project
that starts out wrong rather than only from an empty one
(`20260820140000_m41_privilege_baseline.sql`). What a new session must actually do:

**Any migration that creates a table, view or function in `public` ends with an explicit
`revoke … from anon, authenticated` and grants back exactly what is intended — and updates the
expected set in `scripts/grant-audit.sql`.** CI fails otherwise, deliberately. An object with no
privilege decision is a defect, not a default. `SECURITY.md` §5.9 has the whole picture; the short
version is that the intended surface is stated in three independent places and any one of them can
fail the build.

Two facts that will otherwise cost you an afternoon:

- **The auto-exposure mechanism is `ALTER DEFAULT PRIVILEGES`, not only an event trigger.**
  `pg_default_acl` carries entries owned by `supabase_admin` granting `anon` and `authenticated`
  everything on new objects in `public`, locally and on the hosted project. They cannot be revoked
  (`postgres` is not a member of that role) and do not need to be — a default privilege attaches
  only to objects its own role creates, and everything in `public` here is created by `postgres`.
  The audit accepts that one grantor and fails on every other. Do not "fix" it.
- **CI is a reproducibility gate, not a statement about a deployed project.** Run the deployment
  gate in SECURITY.md §13 after any deploy touching auth, policies or grants — including
  `scripts/grant-audit.sql` pasted into the Supabase SQL editor, which is the check that would have
  caught the escalation before a user could.

## M5 — Catalog, ingest and search

**TCGdex, REST, re-verified 2026-08-20** (API_SOURCES.md, RESEARCH.md R24-R27) — GraphQL and a bulk
database dump were both evaluated and rejected (GraphQL's list queries have no language argument
and its docs are unfinished; no bulk export exists). No key, no cost, no rate limit hit across the
full ingest.

**Two real schema defects found and fixed before M6 needed them not to exist** (D-033/D-034,
PROJECT_JOURNAL.md): `card_variants` identity is now `finish` + `stamp` + `subtype`, not the single
`variant_type` enum M3 shipped — a real card (Base Set Charizard) is holo, shadowless and
first-edition at once, which the old enum could not represent. Provider-id uniqueness on
`card_series`/`card_sets`/`cards` is scoped to `(language, tcgdex_*_id)`, not global — TCGdex reuses
ids like `neo1` across English and Japanese. `card_variants.cardmarket_product_id`/
`tcgplayer_product_id` are no longer unique — a marketplace can price two finishes under one product
id.

**Ingest:** `supabase/functions/sync-catalog`, one `(language, set)` per invocation, bounded
concurrency 5 for card detail, idempotent (upserts on the corrected keys), Pokémon TCG Pocket
excluded via `serie.id === "tcgp"` (checked server-side). Gated by `CATALOG_SYNC_SECRET`
(D-035) — an operator bearer secret, not a Supabase platform key and not reachable from the browser
bundle. `scripts/run-catalog-sync.mjs` drives a full sync set-by-set. Command in "Commands" below.

**Search:** `public.search_cards(p_query, p_language, p_limit, p_offset)`, `SECURITY INVOKER`,
ranks `cards` joined to `card_sets` by trigram similarity plus a heuristic split of a trailing
collector-number token (`"Base Set 4"`, `"Charizard 4/102"`). Trigram indexes on both `cards.name`
(M3) and `card_sets.name` (M5). Browser-verified against the real remote catalog: English/Japanese
name search, short (2-char) queries, set+number combined queries, language filter, card detail with
real multi-variant data, mobile viewport — desktop and mobile both clean.

**UI:** `/catalog` (search) and `/catalog/$cardId` (detail), both behind `RequireSession`. No
"Add to collection" — that is M6.

**Full ingest counts (English + Japanese, into `pokeportfolio-dev`):** English — 20 series, 199
sets, 20,946 cards, 32,857 variants, 568 Energy cards. Japanese — 14 series, 175 sets, 11,744 cards,
14,226 variants, 197 Energy cards. Total: 32,690 cards, 47,083 variants. 9,300 cards (28%) have no
provider image; 695 (2%) have no rarity — both stored as `NULL`, never a placeholder. Six sets
(`swsh9.5tg`/`swsh10.5tg`/`swsh11.5tg`/`swsh12.5tg`, `ja/sn10a`, `ja/sn11`) never ingested — a
TCGdex-side edge/CDN inconsistency specific to the Edge Function's network path, confirmed by a
same-moment direct request from this development machine succeeding where the function's did not;
re-running `scripts/run-catalog-sync.mjs --only=<setId>` later is expected to pick them up. Separately,
72 sets have a non-zero `cardCount` but a genuinely empty `cards[]` array in TCGdex's own response
(verified directly) — a provider data gap, not an ingest defect, accounting for ~5,451 of the
~5,480-card difference between summed provider counts and actual ingested cards. Full reconciliation
detail and the 4 sets with small partial gaps: `claude_outputs/output_9.txt`. Per-set log:
`catalog_sync_runs`.

**Known limitations, not bugs:** the name+number search split is a heuristic, not a parser — it
covers the product spec's named examples, not arbitrary phrasing. Sealed products, price snapshots
and card images are out of scope (M11/M9/never-cached-locally respectively). Card artwork is
hotlinked from `assets.tcgdex.net`, never copied into Supabase Storage or committed — same
considered-not-established licensing position as before M5, restated in API_SOURCES.md.

**One incident worth flagging to a new session immediately:** while fetching the anon key for local
dev via `supabase projects api-keys`, that command's response included the project's secret
(`service_role`) key in full — not requested, not needed, but present in this session's transcript.
It was not used, stored in any file, or committed anywhere (verified). **The owner should consider
rotating `pokeportfolio-dev`'s secret key** as a precaution; nothing in the repository depends on
its current value, since the Edge Functions get it injected fresh by the platform regardless.

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
| Cloudflare | **Pages project `pokeportfolio-dev`, Free plan, no payment method.** Git-connected to `main`; preview deployments off. Nothing to install locally — deployment happens on merge. |
| psql | **Not on this machine.** The privilege audit runs in CI, or in the Supabase SQL editor against a deployed project — or, found during M5, `pnpm exec supabase db query --linked -f <file.sql>`, which runs arbitrary SQL against the linked remote through the CLI's own authenticated session. No `psql`, no database password. Same trust level as the SQL editor: privileged and deliberate, never for routine schema changes. |

## Remote Supabase project

| Item | Value |
|---|---|
| Name | `pokeportfolio-dev` — **development only**, never production |
| Ref | `nopmkroeygmlvndzjjqs` (a public identifier, not a secret) |
| Region | **`eu-west-3` (Paris)**, not the `eu-north-1` the docs planned. EU either way, so GDPR posture is unchanged and ~20 ms of latency did not justify recreating it and re-entering a database password. A future production project should still choose deliberately rather than inherit this. |
| Plan | **Free. No payment card. No billing enabled.** |
| Postgres | 17.6 |
| State | All migrations applied (15 through M4.1, +7 for M5) · `config push` done, so the auth hook is live and `site_url` names the deployment · `redeem-invitation` and `sync-catalog` deployed, with `ALLOWED_ORIGINS`/`CATALOG_SYNC_SECRET` set · `scripts/grant-audit.sql` clean against the live catalog (verified via `supabase db query --linked`) · `scripts/remote-security-check.mjs` green · shared catalog populated with the real English + Japanese physical card set (M5) |
| Accounts | The owner's administrator account, and nothing else. Synthetic test accounts use the RFC 2606 `.invalid` TLD and are removed after use. |

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
  [PR #3](https://github.com/Oskarhn/pokeportfolio/pull/3), M4.1 via
  [PR #5](https://github.com/Oskarhn/pokeportfolio/pull/5). All squash-merged, branches deleted.
- PR #4 was the deliberate negative security test — both invite-only gates disabled to prove the
  suite fails. Closed unmerged, branch deleted. It is not a mistake in the history.
- `claude_outputs/` is gitignored and must stay that way.
- `.claude/launch.json` and `.env.local` are gitignored and machine-local.

## Known issues and limitations

- **Node and pnpm are not on this machine's default shell PATH.** Prepend both, or call binaries
  directly. CI is unaffected.
- **TypeScript pinned to 6.0.3**, solely because `typescript-eslint` does not support TS 7 yet.
- **`src/lib/` does not exist yet** — deliberately, per the no-placeholder-directories rule.
- **Environment variables are baked into the Cloudflare bundle at build time.** Editing one in the
  dashboard changes nothing until a redeploy — and a wrong value fails silently, as a generic
  "Could not reach the server". `node scripts/deployment-check.mjs` exists because of exactly that.
- **A service worker serves the previous shell on the first load after a deploy.** `autoUpdate`
  takes over on the next load. Normal PWA behaviour, but it briefly makes a corrected deployment
  look uncorrected — reload before concluding anything about a fresh deploy.
- **The deployed CSP is exercised only on Cloudflare.** `vite dev` and `vite preview` ignore
  `_headers`, so a policy mistake is invisible locally. `deployment-check.mjs` is the compensating
  control; run it after any deploy.
- **`supabase_admin`'s default privileges in `public` cannot be revoked.** Documented above and in
  SECURITY.md §5.9. Safe, for a stated reason. Not a TODO.
- **Regenerate `src/data/database.types.ts` (`pnpm db:types`) in the same commit as any migration
  that changes the schema.** It is generated from CI's ephemeral stack, downloaded from the
  `database-types` artifact. M4.1's migration changes privileges only, so the file is unchanged.
- **The search-by-number heuristic is not a parser.** It splits a trailing collector-number-shaped
  token off the query text; it does not understand "the second Charizard" or similar phrasing. This
  is deliberate scope (M5 prompt §44), not a gap to close reflexively.
- **Card images are hotlinked from `assets.tcgdex.net`, never cached in Supabase Storage.** Same
  considered, re-examine-before-public-release licensing position as the rest of the catalog
  (API_SOURCES.md). An asset occasionally 404s; the UI falls back to a neutral placeholder rather
  than a broken-image icon.
- **This session's transcript contains `pokeportfolio-dev`'s secret (`service_role`) key**, exposed
  by `supabase projects api-keys` returning every key instead of just the anon one requested. Not
  used, not stored, not committed — but the owner may want to rotate it. See "M5 — Catalog" above.

## Open uncertainties

None block M6. Detail in [docs/RESEARCH.md](docs/RESEARCH.md).

| # | Uncertainty | Needed by |
|---|---|---|
| U2 | Whether Cardmarket's public Product Catalogue covers Pokémon sealed, and its terms | Sealed valuation improvement |
| U4 | TCGdex price update cadence in practice | M9 |
| S6 | Whether camera permission survives an in-route session on current iOS | **Spike before M15** |
| S7 | Whether Basic Energy printings are distinguishable by image at all | M15 |
| — | Trade item-leg accounting rule: carryover vs fair value | M18 only |

~~U3 (TCGdex rate limits in practice)~~ — resolved by the M5 full-catalog ingest: no rate-limit
response across ~380 sets. ~~Whether TCGdex models Basic Energy printings adequately~~ — resolved:
yes, ordinary cards with `category = "Energy"`, ordinary variants; see "M5 — Catalog" below.

## Next actions

**M1–M5 are done.** Start **M6 — Collection: holdings, lots, origin**
([docs/ROADMAP.md](docs/ROADMAP.md)): search a card (built in M5), add it to the collection, enter
purchase cost or mark it Pulled/Gifted/Unknown/etc., see owned quantity, preserve acquisition lots,
record condition. `holdings.card_variant_id` references `card_variants` — M5 corrected that table's
identity model specifically so M6 would not have to migrate it out from under real user data
(D-033/D-034).

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

Verified 2026-08-20 (M5), re-check only if something visibly breaks: TCGdex REST is the ingest
path — GraphQL's `cards`/`card` queries carry no language argument and its docs are unfinished, no
bulk database dump exists · TCGdex ids are unique per language only, never globally · Pokémon TCG
Pocket is series id `tcgp`, English only as of this date · `variants_detailed[]` sometimes carries
the literal placeholder `"generated"` for `variantId`, and marketplace product ids can be shared
across a card's sibling finishes · image CDN is `{base}/{quality}.{ext}`, `quality` ∈ `low`/`high`,
`webp` recommended · no rate-limit response observed across a full ~380-set ingest.

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

Verified 2026-08-20 (M4.1):

- **The auto-exposure mechanism is `pg_default_acl` entries owned by `supabase_admin`**, present in
  the local stack and the hosted project alike, granting `anon` and `authenticated` everything on
  new objects in `public`. Unreachable from a migration and harmless — see the schema note above.
- **GoTrue's Admin API still invokes no Before User Created hook**, re-verified at
  `supabase/auth@bc32168e13fdc928c98b449fc76bc3fdb9a293c5` (master, 2026-08-20; release v2.196.0).
  RESEARCH R21 carries the detail and what protects the project if it changes.
- `REVOKE` on a table also revokes that role's column privileges on it, and `ALL TABLES IN SCHEMA`
  covers views and foreign tables but **not materialized views** — if M5 adds one, it needs its own
  line in the baseline migration.
- **PostgreSQL reports an `UPDATE` column-privilege refusal at table granularity** — "permission
  denied for table profiles", not "…for column is_admin". The column wording belongs to `SELECT`.
- **Cloudflare Pages, Free:** SPA fallback is automatic when the output has no top-level
  `404.html`; `_headers` supports 100 rules; `.nvmrc` is respected but `packageManager`/Corepack is
  **not**, so pnpm is pinned with `PNPM_VERSION`. Build image v3 defaults: Node 22.16.0, pnpm
  10.11.1.

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
pnpm exec supabase functions deploy sync-catalog --use-api   # --use-api avoids needing Docker
pnpm exec supabase secrets set ALLOWED_ORIGINS=https://pokeportfolio-dev.pages.dev
pnpm exec supabase secrets set CATALOG_SYNC_SECRET=<random>  # operator secret, D-035
```

Full catalog refresh (M5), not part of any loop — initial ingest plus manual refresh only:

```bash
CATALOG_SYNC_URL=https://nopmkroeygmlvndzjjqs.supabase.co/functions/v1/sync-catalog \
CATALOG_SYNC_SECRET=<the secret set above> \
node scripts/run-catalog-sync.mjs --language=en --language=ja
```

Then the deployment gate (SECURITY.md §13) — never skip it after touching auth, policies or grants:

```bash
node scripts/remote-security-check.mjs   # Supabase, publishable key only
node scripts/deployment-check.mjs        # Cloudflare, what browsers actually receive
```

Plus `scripts/grant-audit.sql` pasted into the Supabase SQL editor. It reads catalog metadata only;
clean means "Success. No rows returned."

Deployment itself needs no command. Merging to `main` builds it.

**Green as of the M5 merge:** 80 domain/property/data tests (67 + 13 M5 provider-adapter tests) ·
28 Playwright tests (desktop + iPhone; +2 for the /catalog route guard) · **~204 database and
authorization tests across 16 files** (176 through M4.1, +8 catalog constraint tests, +16 search
correctness tests, +4 search_cards/catalog_sync_runs authorization tests), including 18 invite-only
attack cases, 22 admin authorization cases, the function-grant surface, the system-owned columns and
the claim mechanics · 17/17 remote checks against the dev project · deployment checks against
Cloudflare · `grant-audit.sql` clean against the live catalog, verified via
`supabase db query --linked` in addition to the SQL editor.

CI runs `build-and-test` (gate + E2E + gitleaks) and `db-tests` (ephemeral Supabase stack → migrate
→ assert the Edge Function is reachable → **assert the privilege baseline → make the database
hostile, prove the audit rejects it, re-apply, prove convergence** → suites → generate types) on
every push and PR, with **no remote credentials anywhere**.

## Owner actions outstanding

| # | Action | Blocks |
|---|---|---|
| 1 | Optional: install Docker Desktop | Local iteration convenience only |
| 2 | Optional: fix Node/pnpm absence from the default PATH | Convenience only |

Nothing blocks starting M5. The admin account, the deployment and the installed-PWA check are all
done.
