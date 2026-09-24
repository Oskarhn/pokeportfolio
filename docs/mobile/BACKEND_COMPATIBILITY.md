# Backend compatibility

The spike talks to the **released** backend only (`main` `d8682e0`, **104 migrations**). Two parallel,
**unreleased** candidates exist: P149 (auth + finance hardening, **106 migrations**) and P153 (Price
Check, an additive Edge Function change, **no migration**). Nothing below assumes either is live.

## Dependency table: what the slice calls

| Slice function | Database / Edge artefact | Defined in (latest) | On released `main` (DB 104)? | In P149 (DB 106)? | In P153? |
|---|---|---|---|---|---|
| Sign in / refresh / sign out | Supabase Auth (GoTrue) | platform | **yes** | yes | n/a |
| Collection page | RPC `list_portfolio` | `20260829120010_m11_list_portfolio_sealed` | **yes** | unchanged | n/a |
| Collection total, counts | RPC `portfolio_counts` | `20260829120010_m11_list_portfolio_sealed` | **yes** | unchanged | n/a |
| Card detail: summary | view `holding_summaries` | `20260829120050_m11_holding_summaries_sealed` | **yes** | unchanged | n/a |
| Card detail: provenance | RPC `get_holding_value_provenance` | `20260826120020_m9_valuation_resolver` | **yes** | unchanged | n/a |
| Catalog search | RPC `search_cards` | `20260820156000_m5_search_cards_slash_number_fix` | **yes** | unchanged | reuses it |
| Card, variants | tables `cards`, `card_variants` (RLS read) | m5 | **yes** | unchanged | reuses them |
| Latest price snapshot per variant | RPC `get_card_variant_price_history` | `20260826120020_m9_valuation_resolver` | **yes** | unchanged | n/a |
| Raw price observations `observations[]` | Edge Function `search-prices` (additive field) | P153 `supabase/functions/search-prices/index.ts` | **no** | no | **yes, Edge only** |
| Exact-money client (quote unsafe integers) | client code `src/data/exact-json-guard.ts` | P149 | **no** | **yes** | n/a |
| Identity lease / leased client | client code `src/auth/identity-lease.ts`, `src/data/leased-client.ts` | P149 | **no** | **yes** | n/a |
| Ingest cron fail-closed | `20260916120000_p137_environment_scoped_ingest_dispatch` | released | **yes** (in the 104) | yes | n/a |

### DB 104 vs DB 106 for this slice

P149's two extra migrations are `20260918120000_p144_financial_boundary_semantics` (new function
`allocate_purchase_discount`; `create_purchase` / `update_purchase` replaced with **unchanged
signatures**; a `sales` constraint; a completed-event date trigger) and
`20260918120010_p144_privilege_baseline`. **Every read the slice makes is byte-for-byte the same on 104
and 106.** The spike has no write feature, so nothing in DB 106 changes its behaviour. What P149 adds
that matters to a mobile client is client-side (exact-money transport, identity lease), and is a
**replacement of SPIKE_ONLY code**, not a new dependency ([INTEGRATION_PLAN](INTEGRATION_PLAN.md)).

## Findings from running against the real local stack (DB 104)

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | `list_portfolio` clamps `p_limit` to **100** (`least(greatest(p_limit,1),100)`); the shared wrapper decides "next page" by `results.length === limit` | 500 requested → 100 returned → list looked finished | Adapter clamps; test `the adapter never asks for more than the server page cap` |
| F2 | `get_card_variant_price_history` resolves **one provider per variant, by the caller's profile preference** (`use_eu_pricing`, default Cardmarket). A variant with Cardmarket **and** TCGplayer snapshots shows one | test `the released history RPC returns ONE provider per variant` | A released-interface Price Check cannot show both side by side; that is exactly what P153's `observations[]` adds |
| F3 | Keyset cursor value: the server **accepts a decimal string** for `p_cursor_value_minor`. As a JSON number, a value above 2^53 is rounded, and the next page **silently omits** a row (`…236` sent as `…200` excludes a holding valued `…235`) | `EXPLORATORY` test in `tests/backend/collection.test.ts` | Confirms H1. An exact-money client sends strings; until then `value_desc` paging past a huge value **fails closed** |
| F4 | A price snapshot is `fresh` up to **3 days** old, then `stale`. Seeded snapshots dated 2026-09-20 read `stale` on 2026-09-24 | test computes the expectation from the age | UI copy must not say "current" for `stale` |
| F5 | `price_snapshots` is constrained: Cardmarket rows are **EUR**, TCGplayer rows **USD**. There is **no JPY** snapshot | table constraint `price_snapshots_kind_matches_provider` | JPY (zero exponent) source amounts reach a client only through P153's response; the spike proves JPY with a synthetic fixture and the formatter tests |
| F6 | A real supabase-js session is **2 039 bytes** stored (minimal synthetic user), 9 bytes under the documented ~2 048-byte SecureStore figure | `MEASURED` line in `tests/backend/auth-session.test.ts` | A hosted account with more identity/metadata is larger; single-value storage is unsafe → chunked |
| F7 | Ingest cron dispatch is **fail-closed on the running stack**: `environment_ingest_config` has 0 rows; `net.http_request_queue` and `net._http_response` are empty | `tests/backend/isolation.test.ts` | No Production-directed outbound call was made by this stack |
| F8 | Users cannot be created directly (M4 invite-only backstop); the existing invitation-claim harness is reused for synthetic users | `tests/db/setup.ts` `createSyntheticUser` | Seeding needs the service role **in a Node script only**, never in the app |
| F9 | RLS holds through the native path: user B asking for user A's holding id gets not-found/error, not data | `tests/backend/identity.test.ts` | |
| F10 | `list_portfolio` for a 10 006-holding user: 101 pages × 100, ~8 s total, ~2–23 MB Node heap growth (GC-dependent) | `MEASURED` line | Node numbers, **not Hermes** and not a device |

## Local stack isolation (verified)

| Property | Value |
|---|---|
| Project id | `pokeportfolio-p158-mobile` (repo default is `pokeportfolio`; other worktrees run their own) |
| Ports | 55321 API, 55322 DB, 55320 shadow (repo default 543xx) |
| Generated config | `apps/mobile-spike/.local-backend/supabase/config.toml` (gitignored). Studio, realtime, storage, analytics, edge runtime, mail disabled; auth `site_url` set to the local origin; **no Production origin anywhere** (the generator refuses to write one) |
| Containers | only `db`, `auth` (GoTrue), `rest` (PostgREST), `kong`. The other worktree's stacks were never touched |
| Stop | `pnpm backend:stop` stops **this** project only (`supabase stop --no-backup --workdir …`) |
| Keys in the app | publishable key only. The generator's env command prints URL + publishable key; the service-role key is read only by the seed script (Node) |
| Android emulator host | derived from configuration, never hard-coded: `127.0.0.1`/`localhost` → `10.0.2.2` (override `EXPO_PUBLIC_ANDROID_EMULATOR_HOST`, or keep the URL with `EXPO_PUBLIC_ANDROID_LOOPBACK=adb-reverse`) |
| Cleartext HTTP | Debug builds of RN allow cleartext to the dev machine; a release build would not. **Not exercised** (no Android build) |
