# Handover

Current-state document, written for a session that knows nothing from any earlier conversation.
Read this first, update it last. History lives in [CHANGELOG.md](CHANGELOG.md) and
[docs/PROJECT_JOURNAL.md](docs/PROJECT_JOURNAL.md).

**Last updated:** 2026-08-22 — M1 (scaffold and harness), M2 (financial domain core), M3
(database, migrations, RLS), M4 (invite-only authentication), M4.1 (privilege convergence,
deployment, real end-to-end), M5 (catalog, TCGdex ingest, search), M6 (collection: holdings, lots,
origin, cost) and M7 (Portfolio: organisation, display, navigation) complete in code. M7's PR
([#14](https://github.com/Oskarhn/pokeportfolio/pull/14)) is open with **CI green** — see "M7
verification state" below for exactly what that does and does not yet prove, since the branch is
not merged and nothing has been pushed to the real project yet.

---

## Status

**Planning is FROZEN. M1–M7 are complete in code, CI-green on PR #14.** M8 (purchases and the
spending ledger) is next, once M7 finishes merging and deploying. See "M7 verification state"
immediately below before assuming anything about M7 beyond what is explicitly marked done.

The application is deployed and reachable: **https://pokeportfolio-dev.pages.dev**, on the M6
state — M7 has not yet been merged or deployed as of this handover (see below). The owner has a
working administrator account on the development project, the shared catalog holds the real
English and Japanese physical Pokémon TCG card set (M5), and the deployed M6 build lets the owner
search a card, add it to their collection with real acquisition provenance and cost, and see it in
`/collection`.

**M6 also migrated the project's Supabase API keys** (D-039) — see "Security: key migration" below
before touching anything credential-related. The legacy `anon`/`service_role` pair is now
**deactivated** on `pokeportfolio-dev`. If you are about to run `supabase projects api-keys`,
stop: that exact command is what caused the M5 exposure this migration closed out. It stays
unnecessary for everyday work; if you ever genuinely need it, use `--reveal` deliberately and never
capture the output into anything persisted.

Scope is settled — do not reopen it (see [docs/PLANNING_FREEZE.md](docs/PLANNING_FREEZE.md) §9).

## M7 verification state — read before assuming anything is deployed

This machine has no local Docker (§4/Environment table, unchanged since M3), so `pnpm db:start`/
`pnpm test:db` could never run against a real Postgres on this machine directly. CI's ephemeral
stack proved correctness; `pokeportfolio-dev` itself proved performance and deployment behaviour.
Both have now actually run, not just been described.

**Actually verified, green:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`
(80/80 domain tests, unchanged — M7 touched no `src/domain` logic), `pnpm build`, `pnpm test:e2e`
(50/50 Playwright, desktop + iPhone) all pass locally. CI's `db-tests` job is green on PR #14:
19/19 test files, 269/269 database and authorization tests (up from 251 at the M6 merge). CI's
`build-and-test` is also green (gate + E2E + gitleaks).

**Real bugs found by actually running things, all fixed on the branch — five in total, three
categories** (full account: PROJECT_JOURNAL.md 2026-08-22, both entries):

1. CI's first run: `search_cards` needed an explicit `service_role` grant once the PUBLIC-EXECUTE
   sweep (D-042) removed the implicit default `tests/db/search_cards.test.ts`'s service-role
   client had been silently relying on.
2. CI's first run: `custom_collection_members.user_id` needed `default auth.uid()` — without it, a
   real authenticated-client insert (the app's own `addHoldingToCollection` code path) was
   rejected by RLS.
3. CI's first run: a test-only fixture bug in `tests/db/m7_constraints.test.ts`, reusing one fixed
   holding identity across multiple tests for the same synthetic user.
4. **The real 10 000-lot benchmark: `list_portfolio`/`portfolio_counts` were genuinely too slow to
   ship** — 5.5-8 seconds per call against 7,500 holdings/10,109 lots, with `value_desc` (the
   *permanent default sort*) and `added_newest` actually timing out
   (`57014 canceling statement due to statement timeout`). Root cause: a `LEFT JOIN LATERAL`
   per-holding aggregate, which forces a nested-loop plan, instead of the plain
   `LEFT JOIN ... GROUP BY` shape `holding_summaries` (M6) already uses correctly. Rewritten as a
   `MATERIALIZED` CTE with that shape; re-measured against the *same* seeded data at
   **130-570 ms across every sort mode, the filtered query and keyset pagination** —
   `20260822120030_m7_portfolio_query_perf_fix.sql`, `20260822120040_m7_portfolio_counts_perf_fix.sql`.
5. Deleting the benchmark synthetic account afterward failed: `custom_collection_members.user_id`
   had no `ON DELETE CASCADE` — the third time this project has hit this exact defect class (M4,
   M6, now this). Fixed (`20260822120050_m7_custom_collection_members_cascade_fix.sql`), verified
   by actually deleting the account a second time (succeeded, zero residue), and a new regression
   test added (`tests/db/m7_constraints.test.ts`, "account deletion cascades every M7 table").

The identical latent `user_id`-default bug from item 2 also exists in M6's already-shipped
`holding_tags` table — flagged as a separate follow-up task rather than edited here, since that
migration may already be applied to the real project.

**Done this session, against the real `pokeportfolio-dev` project:**

1. ~~Open the PR and confirm CI is green~~ — **done.** PR #14, both jobs passing (269/269 db tests).
2. ~~`supabase db push` / `remote-security-check.mjs` / `grant-audit.sql` against the real
   project~~ — **done.** All six M7 migrations applied; `grant-audit.sql` clean (verified twice,
   before and after the perf/cascade fixes); `remote-security-check.mjs` 17/17 (phase 1) then
   33/33 (phase 2, full redemption) against a throwaway `.invalid` invitation, deleted after use.
3. ~~The 10 000-lot benchmark~~ — **done, against a real isolated synthetic account (7,500
   holdings, 10,109 lots), not the local stack.** Seeded and queried via direct SQL/HTTP rather
   than running `scripts/portfolio-perf-benchmark.mjs` itself, because that script needs the
   Supabase secret key and this session never fetches it — the equivalent verification used
   privileged `supabase db query --linked` access (already legitimately available, no secret key)
   for seeding/cleanup and the publishable key + a real password sign-in for the timed RPC calls.
   Account fully deleted afterward, verified zero residue. **This run is what found and fixed
   findings 4 and 5 above** — the actual point of the gate.

**Not yet done:**

4. Merge PR #14, confirm the Cloudflare deploy, and browser-verify the deployed Portfolio UI —
   grid/list/table, density, sort, filters, custom collections, bottom nav — the way M5/M6 verified
   their deployed builds.
5. A short real-iPhone check (M7 prompt §120) — genuinely needs the owner's own phone; ask for it
   only once step 4 is done.

Do not report M7 as fully finished to the owner until items 4-5 also happen.

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
27. **Storage location lives on the acquisition lot, not the holding.** (D-036) — a shared holding
    cannot represent identical copies split across two physical locations.
28. **A holding has three possible identity sources** — `card_variant_id` / `sealed_product_id` /
    `manual_card_id` — **exactly one non-null.** (D-037) `manual_card_definitions` is the
    user-private fallback for a catalog-missing card; never written into the shared catalog.
29. **`lot_origin`/`cost_basis_state` gained `opening`/`trade_in`/`unallocated_opening`/`trade_in`
    ahead of M16/M18**, without the `opening_id`/`trade_line_id` linking columns those milestones
    still own. (D-038) A "Pulled" lot has no opening reference yet; that is expected, not a bug.
30. **Supabase key model migrated to `sb_publishable_…`/`sb_secret_…`; legacy `anon`/`service_role`
    is deactivated, not deleted, and was not rotated via the JWT signing secret.** (D-039)

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

**Deployed and verified.** PR #9 merged; Cloudflare rebuilt `main` (bundle `index-w9CHprYD.js`).
`node scripts/deployment-check.mjs` 27/27, `scripts/remote-security-check.mjs` 17/17,
`grant-audit.sql` clean against the live catalog — all three re-run after the merge, not assumed
from the pre-merge state. A second throwaway synthetic account
(`m5-deploy-verify@example.invalid`, deleted after use) redeemed a real invitation on the actual
`pokeportfolio-dev.pages.dev` origin and ran a real search there, confirming the deployed bundle —
not just the local dev server — talks to the real catalog correctly.

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

**The key-exposure incident flagged here is resolved as of M6** — see "Security: key migration"
immediately below. It is kept in this document's history rather than deleted so a future session
understands why the key model looks the way it does.

## M6 — Collection: holdings, lots, origin and cost

Search a card, add it to the collection, record how it was acquired and (where applicable) what
it cost, see it in `/collection`, add another copy later without losing the first lot's
provenance, inspect the lots behind a holding. See DECISIONS.md D-036–D-039 for the four material
decisions and PROJECT_JOURNAL.md (2026-08-21 entries) for what real deployment verification found
and fixed.

**Manual card fallback (D-037).** `holdings` now has three possible identity sources —
`card_variant_id` / `sealed_product_id` / `manual_card_id` — exactly one non-null. A manual card
(`manual_card_definitions`) is the honest answer for a physical card the shared catalog does not
list: name, set name, collector number, language, finish, stamp, subtype, notes — no provider id,
no rarity, no price, no image requirement. User-private, never written into the shared catalog,
never visible to another user. Reachable from `/catalog`'s empty-search state and from
`/collection/manual/new`.

**Storage location relocated to the lot (D-036).** `holdings.storage_location_id` moved to
`acquisition_lots.storage_location_id` — a real two-binder scenario proved the original
one-per-holding cardinality couldn't represent identical copies split across two locations.
`profiles.default_storage_location_id` keeps its role as a prefill default, now for new lots.

**Origins pulled forward (D-038).** `lot_origin` gained `opening` (UI label "Pulled") and
`trade_in`; `cost_basis_state` gained `unallocated_opening` and `trade_in` — ahead of their
originally-planned M16/M18 arrival, required by D-017. Neither `opening_id` nor `trade_line_id`
exists yet; those columns and the linking workflow are still M16's/M18's. A full
origin → permitted-cost-basis-state mapping replaces the M3 gift-only check
(`acquisition_lots_origin_cost_state_consistency`).

**Manual valuations (pulled forward from M11).** `manual_valuations` — append-only, superseded via
`set_manual_valuation(p_holding_id, p_value_minor, p_note, p_effective_from)`, currency fixed to
NOK pending FX (M9). Wired to graded holdings in the M6 UI; the resolver (manual → fresh → stale →
missing) stays M9's, since M6 has no other price source to resolve against.

**The atomic surface.** `add_card_acquisition` (SECURITY INVOKER) finds-or-creates the
identity-matching holding — race-safe via the real `holdings_identity` unique index, catching
`unique_violation` and re-reading rather than locking — and writes one acquisition lot, plus a
real single-line `purchases`/`purchase_lines` row when the cost is known (not "provisional" — a
complete, ordinary purchase as far as it goes; M8 adds richer multi-line purchases over the same
tables). `void_acquisition_lot` is the mistake-correction path: void semantics, and voids the sole
purchase a known-cost lot exclusively created so a corrected mistake never leaves a ghost spend in
`GPO`/`CS`. `holding_summaries` (`security_invoker` view) gives the Collection list one query.

**UI (as originally shipped in M6; superseded by M7's Portfolio browsing surface — see "M7 —
Portfolio" below for the current routes and behaviour):** `/collection` (2-column mobile grid,
hardcoded pending M7's density setting), `/collection/$holdingId` (identity, lots, void,
favourite, manual value), `/add` (progressive form: quantity, raw/graded, origin-driven cost
disclosure, storage, favourite, notes), `/collection/manual/new`. "Add to collection" lived on
each variant in `/catalog/$cardId`.

**Security: key migration (D-039).** `pokeportfolio-dev` moved to named
`sb_publishable_…`/`sb_secret_…` keys, closing out the M5 exposure note. `VITE_SUPABASE_ANON_KEY`
renamed to `VITE_SUPABASE_PUBLISHABLE_KEY` everywhere (code, `.env.example`, CI, Cloudflare env).
Both Edge Functions read `SUPABASE_SECRET_KEYS` first (`supabase/functions/_shared/service-key.ts`),
falling back to the legacy `SUPABASE_SERVICE_ROLE_KEY` only because the *local* stack still emits
it. **The legacy `anon`/`service_role` pair is deactivated on the real project as of this
milestone** — verified working end to end *before* deactivation and *again after* (33/33 remote
checks, real redemption + real add-to-collection flow, both times), reversible if ever needed.
Never rotated via the JWT signing secret, so no user session was invalidated.

**Two real bugs found by testing against the actual deployed project, not by CI** (CI was green on
both before the real test ran):

1. `add_card_acquisition`/`set_manual_valuation`/`void_acquisition_lot` were anon-callable despite
   no direct grant — PostgreSQL grants EXECUTE on a new function to `PUBLIC` by default, a separate
   ACL entry from anything later revoked from `anon` by name. Same defect class M4 already found
   and fixed (`20260820120040_m4_explicit_function_revokes.sql`); these three just skipped the
   "revoke from public at creation" step every other function-creating migration follows. Fixed in
   the same migration, `grant-audit.sql` unaffected (it never modelled a `PUBLIC` grant either way
   — a known limitation of that check, not a new one).
2. `holding_tags.user_id`/`manual_valuations.user_id` had no `ON DELETE` action, so deleting an
   account that had tagged a holding or set a manual valuation failed outright. Same defect class
   M4 fixed for the original eight `user_id → auth.users(id)` references. Fixed
   (`20260821130000_m6_user_id_cascade_fix.sql`), verified by actually deleting a synthetic account
   with one row in every M6 table against the real project (cascaded cleanly, zero orphans), and a
   new regression test now exists for account-deletion cascade generally
   (`tests/db/m6_constraints.test.ts`) — the first such test in the suite for *any* table.

**CI privilege-baseline fragility fixed (SECURITY.md §5.9's own flagged issue).** The hostile-grant
convergence step no longer hardcodes a baseline migration filename — it selects the
lexicographically-latest `*_privilege_baseline.sql` and fails outright if none exists.
`20260821120100_m6_privilege_baseline.sql` is the current one.

**Deployed and verified.** PR #11 (M6 feature) and PR #12 (the cascade fix) merged; Cloudflare
rebuilt `main` after the Cloudflare env var was updated to `VITE_SUPABASE_PUBLISHABLE_KEY` and the
deployment was manually retried (env var changes don't trigger a rebuild on their own).
`deployment-check.mjs` 27/27, `remote-security-check.mjs` 33/33 (with `INVITE_TOKEN` — full
redemption phase), `grant-audit.sql` clean against the live project (`supabase db query --linked`).
Three synthetic `.invalid` accounts exercised the real flow (search, purchased card, reused
holding, manual card, graded card + manual value, bulk Energy ×12, Collection aggregation) against
the actual deployed bundle and actual ingested catalog, then were deleted — zero residue, checked
directly.

**Known limitations:** `database.types.ts` was regenerated from CI's artifact this session (no
local Docker to run `pnpm db:types` directly) — diffed field-for-field identical to a careful
hand-authored version first, so this is the same trustworthy output the command would have
produced. Session defaults for fast repeated entry (UX_FLOWS.md F2.1) are not implemented — the
RPC's argument shape was designed so the scanner (M15) can supply them later without a
business-logic change, but nothing pre-fills them yet. The mobile bottom navigation with a central
quick-add (the frozen UX plan) is not built; AppShell still carries a plain top-nav header — M7
owns navigation refinement once there is more to navigate. No dedicated `frontend-design` skill
pass was run; the Collection UI matches the existing Catalog/Auth screens' established Tailwind
patterns directly, consistent with DESIGN_SYSTEM.md §0's "provisional, not final" phase.

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
| State | All migrations applied (15 through M4.1, +7 for M5, +10 for M6) · `config push` done, so the auth hook is live and `site_url` names the deployment · `redeem-invitation` and `sync-catalog` deployed (current code, reading `SUPABASE_SECRET_KEYS`), with `ALLOWED_ORIGINS`/`CATALOG_SYNC_SECRET` set · `scripts/grant-audit.sql` clean against the live project (verified via `supabase db query --linked`) · `scripts/remote-security-check.mjs` 33/33 · shared catalog populated with the real English + Japanese physical card set (M5) · **legacy `anon`/`service_role` keys deactivated (M6, D-039)** — the project now authenticates browsers via `sb_publishable_…` and Edge Functions via `sb_secret_…` only |
| Accounts | The owner's administrator account, and nothing else. Synthetic test accounts use the RFC 2606 `.invalid` TLD and are removed after use. |

**The remote is never the source of truth.** Schema and security live in `supabase/migrations/` and
`supabase/config.toml`. A clean environment must be reconstructible from the repository plus
secrets. If you find drift, reconcile toward the repository.

### Secrets, conceptually — never values, never in this file

| Secret | Where it lives |
|---|---|
| Database password | The owner's password manager. Claude has never seen it. |
| Supabase CLI access token | The CLI's own credential store, created by `supabase login`. |
| Publishable key (`sb_publishable_…`, M6) | `.env.local` (gitignored) and Cloudflare Pages env var `VITE_SUPABASE_PUBLISHABLE_KEY`. Public by design — it is embedded in every browser bundle served, which is exactly how this session obtained it to run the remote checks below, rather than via any key-listing CLI command. |
| Secret key (`sb_secret_…`, M6) | The Supabase platform only, injected into the Edge Function environment as `SUPABASE_SECRET_KEYS`. Never fetched into a session, never in the repo, never in `claude_outputs/`. |
| Legacy `anon`/`service_role` | **Deactivated** on `pokeportfolio-dev` as of M6 (D-039). Reversible from the dashboard if ever needed; not deleted. |

`.env.local` is filled in and points at the real project
(`https://nopmkroeygmlvndzjjqs.supabase.co` plus the current publishable key) as of M6. **Do not
run `supabase projects api-keys` to refresh it** — that command is what caused the M5 exposure this
milestone closed out. If the publishable key is ever needed again, it is safe to read directly out
of the deployed bundle (it is public by design) rather than from that command.

## Repository

- `https://github.com/Oskarhn/pokeportfolio` — **private**
- M1/M2 via [PR #1](https://github.com/Oskarhn/pokeportfolio/pull/1), M3 via
  [PR #2](https://github.com/Oskarhn/pokeportfolio/pull/2), M4 via
  [PR #3](https://github.com/Oskarhn/pokeportfolio/pull/3), M4.1 via
  [PR #5](https://github.com/Oskarhn/pokeportfolio/pull/5) plus real-device follow-ups
  [#6](https://github.com/Oskarhn/pokeportfolio/pull/6)/[#7](https://github.com/Oskarhn/pokeportfolio/pull/7)/[#8](https://github.com/Oskarhn/pokeportfolio/pull/8),
  M5 via [PR #9](https://github.com/Oskarhn/pokeportfolio/pull/9) plus a docs follow-up
  [#10](https://github.com/Oskarhn/pokeportfolio/pull/10), M6 via
  [PR #11](https://github.com/Oskarhn/pokeportfolio/pull/11) plus the cascade-fix follow-up
  [#12](https://github.com/Oskarhn/pokeportfolio/pull/12). All squash-merged, branches deleted.
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
  M6 had no local Docker to run `pnpm db:types` directly — the file was hand-authored to match the
  new migrations, then replaced with CI's actual generated artifact once green, confirmed
  field-for-field identical. If a future session again lacks Docker, that same
  hand-author-then-replace sequence is safe, provided the replacement step actually happens before
  the PR is treated as done.
- **The search-by-number heuristic is not a parser.** It splits a trailing collector-number-shaped
  token off the query text; it does not understand "the second Charizard" or similar phrasing. This
  is deliberate scope (M5 prompt §44), not a gap to close reflexively.
- **Card images are hotlinked from `assets.tcgdex.net`, never cached in Supabase Storage.** Same
  considered, re-examine-before-public-release licensing position as the rest of the catalog
  (API_SOURCES.md). An asset occasionally 404s; the UI falls back to a neutral placeholder rather
  than a broken-image icon.
- **Resolved as of M6:** an M5-session transcript contained `pokeportfolio-dev`'s legacy secret
  (`service_role`) key, exposed by `supabase projects api-keys` returning every key instead of just
  the anon one requested. Never used, stored or committed. The legacy pair (that key included) is
  now deactivated project-wide — see "M6 — Collection" above, D-039.
- **`add_card_acquisition`'s M6 fast-add flow is NOK-only.** No FX ingestion exists before M9, so a
  direct-purchase or manual-value amount in another currency has no honest NOK conversion to
  freeze yet. Foreign-currency direct entry is an M8/M9 concern, not a gap to close in M6.
- **Session defaults (UX_FLOWS.md F2.1) are not implemented.** Origin/condition/storage do not
  persist between adds within a session yet — every add currently starts from the same defaults.
  The RPC's argument shape was designed for the scanner (M15) to supply them later.

## Open uncertainties

None block M7. Detail in [docs/RESEARCH.md](docs/RESEARCH.md).

| # | Uncertainty | Needed by |
|---|---|---|
| U2 | Whether Cardmarket's public Product Catalogue covers Pokémon sealed, and its terms | Sealed valuation improvement |
| U4 | TCGdex price update cadence in practice | M9 |
| S6 | Whether camera permission survives an in-route session on current iOS | **Spike before M15** |
| S7 | Whether Basic Energy printings are distinguishable by image at all | M15 |
| — | Trade item-leg accounting rule: carryover vs fair value | M18 only |

~~U3 (TCGdex rate limits in practice)~~ — resolved by the M5 full-catalog ingest: no rate-limit
response across ~380 sets. ~~Whether TCGdex models Basic Energy printings adequately~~ — resolved:
yes, ordinary cards with `category = "Energy"`, ordinary variants; see "M5 — Catalog" above.

## M7 — Portfolio: organisation, display and navigation

Owner UI requirements pass (Prompt 11), implemented directly rather than deferred — see
"M7 verification state" above for what has and has not actually been run. Full detail:
`claude_outputs/output_11.txt`.

**Terminology (D-040).** The user-facing screen that browses owned cards is now **Portfolio**,
not Collection — navigation, headings, copy. `/collection`, `/collection/$holdingId` and
`/collection/manual/new` redirect to their `/portfolio` equivalents rather than disappearing.
Internal naming (`holdings`, `holding_summaries`, `add_card_acquisition`, the
`src/features/collection/` folder for the pages that did not structurally change) is unchanged —
see PRODUCT_SPEC.md's terminology note.

**Navigation, shipped for the first time.** Mobile bottom nav (Home, Search, Portfolio, More,
Profile, central **+**) and an equivalent desktop top nav — the frozen UX plan M6 explicitly
deferred. `src/features/nav/{BottomNav,DesktopNav,QuickAddMenu}.tsx`. Bottom-nav geometry
(six equal flex slots, an absolutely-positioned raised + button so five destinations coexist with
a genuinely centred action): DESIGN_SYSTEM.md §4.2. The + shows only what exists today — Search
cards, Add manually — never Purchase/Sealed/Sale/Scan/Opening before those milestones ship
(UX_FLOWS.md F11.1).

**Portfolio browsing.** Grid (density 1–4, mobile default 2 / desktop 4 — DESIGN_SYSTEM.md §4.1),
List, and Table (also on mobile, horizontally scrollable) — all three window their rows via
TanStack Virtual (`src/features/portfolio/{VirtualGrid,ListAndTableViews}.tsx`) over one
keyset-paginated RPC, `list_portfolio` (DATA_MODEL.md §14). Sort by is visible, ten options, and
`value_desc` is the permanent intended default — resolving to a graded holding's real manual
valuation and a deterministic name-ordered fallback for every raw card, never the acquisition cost
standing in for market value (DECISIONS.md D-041; this is the transitional pre-M9 behaviour to
re-examine only when M9's valuation resolver exists). Density/View/Sort chosen in the toolbar
persist to the profile (`collection_grid_density`/`collection_default_view`/
`collection_default_sort`) and are also reflected in the URL (`/portfolio?sort=...&density=...`)
so back-navigation and shared links behave.

**Filters.** Quick chips (Sort/Density/View buttons plus a Filters button showing the active
count) and a full filter sheet (`FiltersSheet.tsx`) share one state — condition, raw/graded,
grader, favourite, manual-only, custom collection, low value, missing value. Low value/missing
value are honestly scoped to a graded holding's manual valuation before M9 (D-041) — never a fake
raw-card figure.

**Custom collections.** `custom_collections`/`custom_collection_members` shipped exactly as
DATA_MODEL.md §5.2.1 already specified — plain owner-RLS tables, no RPC layer
(SECURITY.md §3.2.1). A horizontal chip row on the Portfolio page (`CollectionsBar.tsx`) makes
them discoverable without a detour through More; the same chip row's "+ Collections" opens
create/rename/delete. No drag-and-drop reordering (owner decision) — the ordinary Sort by control
works the same way inside a filtered collection.

**Search.** Renamed "Search" in navigation (route stays `/catalog`). Cards/Sets segmented control
— Sets is a plain `card_sets` read with real metadata (name, language, symbol, release date, card
count), no new RPC (`CatalogPage.tsx`, `SetDetailPage.tsx`). Every card result — in Cards mode or
inside a set — carries an independent quick-add **+** (`AddQuickButton.tsx`) that preselects a
card's only variant and jumps straight to `/add`, or opens card detail for a real choice among
several — the exact M6 add flow, reused rather than duplicated.

**Home/Profile/More.** `HomePage.tsx` shows only truthful current data (physical/graded/manual
counts) with an honestly-marked "Portfolio value — not available yet" panel reserved for M9/M12 —
no sample chart, no fabricated total. `ProfilePage.tsx`: display name (editable), email, admin
badge, theme, low-value threshold, sign out. `MorePage.tsx`: admin invitations (moved here from
the old top nav) plus a link into Profile — no disabled future-feature entries.

**Security.** Closed the PUBLIC-EXECUTE privilege blind spot M6's own journal entry had flagged as
unclosed (D-042, PROJECT_JOURNAL.md 2026-08-22) — see "M7 verification state" above for the fact
that this has been written and reasoned through but not yet proven by CI on this machine.

**Performance.** Verified against a real 7,500-holding/10,109-lot synthetic account on
`pokeportfolio-dev` — not simulated, not assumed from CI. The first version (`LEFT JOIN LATERAL`
per-holding aggregation) measured 5.5-8 seconds per call and two sort modes — including
`value_desc`, the permanent default — timed out outright. Rewritten as a `MATERIALIZED` CTE using
the same `LEFT JOIN ... GROUP BY` shape `holding_summaries` already uses; re-measured at
**130-570 ms** across every sort mode, the filtered query and keyset pagination
(`20260822120030_m7_portfolio_query_perf_fix.sql`, `20260822120040_m7_portfolio_counts_perf_fix.sql`
— full account in PROJECT_JOURNAL.md 2026-08-22). `scripts/portfolio-perf-benchmark.mjs` remains
the repeatable version of this same measurement for a future session with local Docker (it needs
the Supabase secret key, which this session never fetches — this run instead used
`supabase db query --linked` for seeding/cleanup and the publishable key for the timed calls).

**Known limitations, recorded rather than silently accepted:**

- The initial JS bundle is ~638 KB (180 KB gzipped) after adding TanStack Virtual and the M7
  feature set — a code-splitting pass (dynamic `import()` per route) would help but was not done
  this milestone; not a regression that blocks anything, just larger than ideal.
- The Table view's virtualization uses an absolutely-positioned `<tr>`/`display: block` `<tbody>`
  trick (the standard TanStack Virtual recipe for tables) — this is not fully semantic HTML table
  markup and may read slightly worse to a screen reader than a plain table; not accessibility-audited
  beyond the baseline (visible focus, real labels, 44px targets) this project already holds every
  surface to.
- Quick filter chips for Set/Value/Condition open the same full `FiltersSheet` rather than
  dedicated one-tap mini-pickers (M7 prompt §34 asked for "clean chips/buttons/popovers" without
  mandating three separate implementations) — a scope simplification, not a missing feature; the
  Graded chip is the one genuinely one-tap boolean toggle.
- No dedicated desktop popover/sidebar variant of the filter/sort/density panels — the same
  `Sheet` component (bottom sheet on mobile, centred modal on desktop) serves both, per
  DESIGN_SYSTEM.md §0's "provisional, not final" phase.
- `src/features/collection/` keeps its M6 name even though its three remaining pages
  (`HoldingDetailPage`, `AddToCollectionPage`, `ManualCardPage`) are reached from `/portfolio/...`
  routes now — deliberate minimal-churn choice (D-040), not an oversight.

## Next actions

**M1–M7 are done in code.** Finish M7's actual verification first (the five numbered items under
"M7 verification state" above), then start **M8 — Purchases and the spending ledger**
([docs/ROADMAP.md](docs/ROADMAP.md)): multi-line purchases, retailers, shipping, customs,
discounts, backdating, the allocation engine wired into writes, foreign currency via Norges Bank
FX, collectible/hobby split, void semantics.

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
- **Cloudflare Pages env var changes need a manual redeploy.** They are baked in at build time;
  editing one in the dashboard does nothing until the next build. "Retry deployment" on the latest
  entry in the Deployments tab rebuilds from the same commit with the current env vars.

Verified 2026-08-21 (M6, and load-bearing for the key migration):

- **Supabase's current publishable/secret key migration path**: both key types can be created
  through the dashboard (Settings → API Keys → "Publishable and secret API keys" tab → "Create new
  API keys") alongside the legacy pair without disturbing it. Edge Functions receive the new secret
  automatically via `SUPABASE_SECRET_KEYS` (a JSON map, one entry per named key — no redeploy needed
  for the injection itself, only for function code that reads the new variable name). Legacy keys
  can be **deactivated**, not only deleted — reversible, and does not invalidate issued user
  sessions, because API-key authentication and JWT signing are separate mechanisms.
- **`supabase projects api-keys` (no `--reveal` flag) no longer prints the secret key in full** in
  the currently pinned CLI (2.114.0) — it masks secret-shaped values by default and only reveals
  them with an explicit `--reveal` flag. This is a real change from the M5 session's experience, not
  assumed: confirmed via `--help`. Still avoided in this session regardless — the safety classifier
  blocked an attempt to run even the non-`--reveal` form, and that block was treated as correct
  rather than worked around. The publishable key was instead read directly out of the deployed
  bundle (public by design), which is the pattern to repeat if this is ever needed again.
- **PostgreSQL grants EXECUTE on a newly created function to `PUBLIC` by default**, a separate ACL
  entry from anything granted or revoked from a named role afterward — `REVOKE ... FROM anon` never
  touches it; only `REVOKE ... FROM PUBLIC` does. Every function-creating migration in this project
  already revokes from `public` at creation for exactly this reason (established in M4); a new
  function that skips that step is anon-callable regardless of what the later privilege-baseline
  sweep does. `grant-audit.sql` cannot see this class of gap — it only checks grants held by
  `anon`/`authenticated` by name, never `PUBLIC` — so a green audit does not prove anon lacks access
  to a function; it proves anon holds no *direct* grant. Keep this in mind before trusting the audit
  as the whole story for a *function's* privilege state, unlike a table's, where it is.
- **A column `DEFAULT` cannot contain a subquery** — `default (select auth.uid())` is valid in an
  RLS `USING`/`WITH CHECK` clause but raises `SQLSTATE 0A000` as a column default. Use the bare
  function call (`default auth.uid()`) instead.
- **`COMMENT ON FUNCTION ... IS` takes a single string literal, not an expression** — `'a' || 'b'`
  is a syntax error there even though string concatenation is valid SQL everywhere else.

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

M7's 10 000-lot Portfolio benchmark, against an isolated synthetic account only — never the
owner's real one (DEVELOPMENT.md, "Live since M7"):

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ANON_KEY=... \
node scripts/portfolio-perf-benchmark.mjs --lots=10000
```

Then the deployment gate (SECURITY.md §13) — never skip it after touching auth, policies or grants:

```bash
node scripts/remote-security-check.mjs   # Supabase, publishable key only
node scripts/deployment-check.mjs        # Cloudflare, what browsers actually receive
```

Plus `scripts/grant-audit.sql` pasted into the Supabase SQL editor. It reads catalog metadata only;
clean means "Success. No rows returned."

Deployment itself needs no command. Merging to `main` builds it.

**Green as of the M6 merge (PR #12):** 80 domain/property/data tests · 40 Playwright tests
(desktop + iPhone) · 251 database and authorization tests across 17 files · 33/33 remote checks ·
27/27 deployment checks · `grant-audit.sql` clean against the live project · a real end-to-end M6
collection flow against the deployed bundle with synthetic accounts, zero residue.

**Green on PR #14 (`feat/m7-portfolio-display`), CI-verified, not yet merged:** 80 domain/
property/data tests (unchanged — M7 added no `src/domain` logic) · 50 Playwright tests (desktop +
iPhone; +12 unique cases for the new/renamed routes and the `/collection` → `/portfolio`
redirects) · **269 database and authorization tests across 19 files** (up from 251/17 at M6 — the
two new M7 files, `tests/db/m7_constraints.test.ts` and `tests/authorization/m7_portfolio.test.ts`)
· the new PUBLIC-grant audit check and its hostile-grants proof, both passing · `pnpm typecheck`/
`pnpm lint`/`pnpm format:check`/`pnpm build` all green. This is CI against the ephemeral stack —
**not yet run against `pokeportfolio-dev`** (see "M7 verification state" above, items 2-5).

CI runs `build-and-test` (gate + E2E + gitleaks) and `db-tests` (ephemeral Supabase stack → migrate
→ assert the Edge Function is reachable → **assert the privilege baseline → make the database
hostile, prove the audit rejects it, re-apply, prove convergence** → suites → generate types) on
every push and PR, with **no remote credentials anywhere**.

## Owner actions outstanding

| # | Action | Blocks |
|---|---|---|
| 1 | Optional: install Docker Desktop | Local iteration convenience — every M7 DB/authorization test still had to wait for CI this session instead of running locally first |
| 2 | Optional: fix Node/pnpm absence from the default PATH | Convenience only |
| 3 | A short real-iPhone check once the deployed M7 build exists (M7 prompt §120) | Final sign-off on the new bottom nav/gestures on real hardware |
| 4 | Give feedback on the first Portfolio UI version (grid/list/table, nav, filters, custom collections) once deployed | Informs M8+ and the eventual M12a visual pass — not a blocker, but the owner explicitly wants to be asked here |

The admin account, the M6 deployment, the API-key model and the installed-PWA check remain done
from before M7.
