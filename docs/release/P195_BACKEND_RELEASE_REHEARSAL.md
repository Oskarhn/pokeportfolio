# P195 — Production backend readiness and release rehearsal

`STATUS=PARTIAL_P195_BACKEND_RELEASE_REHEARSAL` · `READY_FOR_P196_PRODUCTION_BACKEND_ROLLOUT=no` (two owner items, §8) ·
base `main` = `fae5250955fe2a2d9c142bfa7e2213b823218ae2` · **Production web, database, Edge Functions and serving SHA
were not changed** (only the two authorised Auth settings, §3).

Rehearsal environment: **`LOCAL_ONLY`** — a full local Supabase stack (own project id, ports, containers) against a
**real, hosted, test-namespace erasure registry**. A hosted isolated Supabase project was not created: the tools in
this session cannot set Edge Function secrets or read a new project's secret key (no Supabase access token; a
`supabase login` is an owner step), and a `delete-account` rehearsal without secrets proves nothing. Cost of the
attempt would have been $0; nothing was created. What a hosted rehearsal would add is limited to hosted-runtime
differences (GoTrue/Edge platform versions); P196's backend smoke (sequence step 14) covers those.

## 1. Production state recorded before and after (read-only)

| Fact | Before | After |
|---|---|---|
| Production web (`/build-meta.json`) | `d8682e047b757f63673a63ac8185a4806d68cb98`, built 2026-09-18T08:22:20Z | same (§11) |
| Hosted migrations | 104, newest `20260916121000` | 104 (§11) |
| Edge Functions | redeem-invitation v7, sync-catalog v6, fetch-fx-rate v3, ingest-prices v2, ingest-fx v3, search-prices v3; no `delete-account` | same (§11) |
| Plan | org `O5k4r` **free**; project `pokeportfolio-dev` (eu-west-3, Postgres 17.6) | — |
| Hosted data (aggregate counts) | 1 auth user, 3 purchases, 3 purchase lines, 0 sales | — |

Pre-release diagnostics against the **hosted** database (read-only aggregate counts, same queries as
`scripts/finance-integrity-diagnostics.sql` plus the P191 sealed-ownership query): **every integrity counter is 0** —
quantity/basis/D1 mismatches, voided-with-live, negative or overfull remaining, out-of-range dates (P144 contract),
unsupported currencies, unsafe integers, negative attributable costs, cross-user sealed references. No data would
trip migrations 105–114.

## 2. Exposed legacy `sb_secret_` key — `EXPOSED_KEY_NOT_IDENTIFIABLE`

Dashboard inventory (metadata only; no value was revealed or printed):

| Name | Type | Status | Created / last used |
|---|---|---|---|
| `default` | secret | active | not shown by the dashboard |
| `default1` | secret | active | not shown by the dashboard |
| `default`, `default1` | publishable | active | — |
| legacy `anon` / `service_role` JWT pair | legacy | present (tab not opened) | — |

The Actions variable that held the value was deleted in P193 and GitHub keeps no history of variable values; the
two masked prefixes cannot be matched to it without reading the leaked value, which P195 deliberately did not do.
A count-only search of local transcripts found both prefixes in the same number of files, so it does not
discriminate. **Nothing was revoked** (revoking an unidentified key would be guessing).

Consumers verified: the Edge Functions read `SUPABASE_SECRET_KEYS` (`default` preferred, **first entry as
fallback**, `_shared/service-key.ts`); the Vault holds only `price_sync_secret` (a shared secret, not an API key);
no `cron.job` embeds a key. So the key set can be rotated without code changes.

**Owner action (`KEY_ROTATION_OWNER_ACTION_REQUIRED=yes`)** — one procedure that is correct whichever key leaked:

1. Dashboard → Project Settings → API Keys → **Secret keys** → *New secret key* (name `rotated-2026-10`).
2. Prove a function still works with it in place (the platform injects every named key): from the dashboard invoke
   `redeem-invitation` with a bogus token (expect 400) and watch `ingest-prices` logs on the next 15-minute cron.
3. Delete `default1`, wait for the next `ingest-prices` cron run to succeed, then delete `default`
   (the code falls back to the first remaining entry, i.e. the new key).
4. Decide the legacy JWT pair the same way (disable *Legacy anon, service_role API keys* once nothing needs them;
   the released web bundle uses the publishable key).
5. Re-read the list: only `rotated-2026-10` should remain as a secret key. Record the date in HANDOVER.

Secrets never go in GitHub Actions **variables**: verified — `gh variable list` is empty, repository **secrets** are
only `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`; `scripts/check-github-release-config.mjs` (names only)
fails closed today on the two absent `PRODUCTION_SUPABASE_*` secrets, which is the intended pre-P196 state.

## 3. Hosted Auth hardening — done

| Setting (Authentication → Sign In / Providers → Email) | Before | After (read back after reload) |
|---|---|---|
| Secure password change | OFF | **ON** |
| Require current password when updating | OFF | **ON** |
| unchanged: Secure email change ON, minimum length 12, leaked-password check OFF (Pro plan), MFA untouched | | |

Why this cannot break the released client: its only password-change path is `ResetPasswordPage`
(`updateUser({ password })` after the emailed recovery link). The GoTrue source (`internal/api/user.go`) requires a
nonce only when the session is **older than 24 h** (a recovery session is new) and skips the current-password check
explicitly when `session.IsRecovery()`. Login is unaffected. **Not tested against the hosted project**: no synthetic
hosted account exists (sign-up is invite-only and creating one would leave clutter in Production Auth); local P191
runtime proof and the source reading are the evidence. Reversible by flipping the two switches back.

## 4. Erasure registry — `REGISTRY_STORAGE_READY=yes`

Architecture, comparison of D1/R2/KV/Durable Objects, endpoints, secrets, export and retention:
[P195_ERASURE_REGISTRY.md](../security/P195_ERASURE_REGISTRY.md), decision D-195. Summary: Worker + SQLite Durable Object on
Workers Free ($0), append-only (no route, SQL triggers, single writer), HMAC chain compatible with P189, separate append /
operator / key secrets, export = registry file format. Production Worker deployed and **empty (seq 0)**; synthetic
testing only on the separate `-test` Worker.

Proven on the deployed `-test` Worker with the real `delete-account` function (§6): append, idempotent repeat, second
subject, conflict, chain/head, export verifies with the canonical parser, tamper refused. Corrupt exports fail closed
(`restore-gate` exit 2): changed `seq` (`sequence is not contiguous`), torn tail (`does not end with a newline`), first
record dropped, wrong key (`integrity check failed`).

## 5. Migrations 105–114 — `MIGRATIONS_REHEARSED=yes`

Start: stack at exactly 104 migrations (the 104 repository files up to `20260916121000`) with a synthetic dataset
written through the official RPCs: users A/B and a deletion user, a multi-line card purchase, two sales (one with fees
above gross → negative proceeds), a JPY purchase with a manual rate, an accessory/valuation, a curated sealed
acquisition and an opening, a user-private sealed product, an unredeemed invitation, FX rows, price snapshots
(`scripts/release-rehearsal/seed-db104.ts`). Integrity snapshot (counts + content hash per ledger table,
`snapshot.sql`) taken before.

| Step | Result |
|---|---|
| Clean diagnostics at DB104 | finance diagnostics all 0; sealed ownership 0/0; grant audit lists exactly the delta 105–114 adds (e.g. `sealed_products` column INSERT, `allocate_purchase_discount` EXECUTE) |
| **Hostile legacy state** (rolled back) | injected: lot quantity +1, a purchase dated 1990, a curated sealed product re-owned by another user → diagnostics flag `lot_quantity_mismatch_lines`, `…_excess`, `…_no_voided_lots`, `lot_basis_*_mismatch`, `d1_quantity_mismatch_lots`, `out_of_range_date_purchases`; the whole 105–114 batch still **applies** with those rows present and migration 113 raises `WARNING: P191: 2 existing row(s) reference another user's private sealed product`; rollback left the database byte-identical (snapshot equal) |
| Real application, one file at a time | all ten applied in order, history rows 105…114; in-transaction SQL time per file (ms): 105 `9`, 106 `29`, 107 `1`, 108 `22`, 109 `4`, 110 `1`, 111 `15`, 112 `12`, 113 `3`, 114 `37` (CLI wall time 1.2–1.6 s each, dominated by CLI start-up) |
| After DB114 | `grant-audit.sql`: `privilege baseline OK` + `ledger write gate OK: five tables gated, ten writers flagged`; finance diagnostics all 0; row counts of all 14 ledger/market tables identical to DB104; `search_cards` stable paging and RPC compatibility covered by §7 |

## 6. delete-account, registry failure, restore gate

`scripts/release-rehearsal/delete-account-rehearsal.ts`, real deployed function, real hosted `-test` registry:

| Check | Result |
|---|---|
| Normal deletion of the synthetic user with data | 200 `deleted`; registry head advanced by exactly one; auth account, purchases and profile gone; old access token → 403; signing in again fails; receipt present **externally** (export parse) and as the database witness |
| **Registry unavailable** (Worker secret removed → 503) | **no false success** (503), `deletion_incomplete` + `stage: registry` + retryable; auth account and data untouched; the account is *pending* and further writes are refused (`P0001`) |
| Service restored, retry | login still possible, deletion completes 200, head +1, everything gone |
| Restore of the **pre-delete** DB114 backup into the isolated drill with the exported registry | `ERASURE_GATE apply replayed=1 verdict=clean residue={}`; `postcheck` clean; `promote-check` **PROMOTABLE** |
| `--mutation F` (skip replay), `--no-erasure-gate`, tampered registry | all refused: `NOT SAFE TO SERVE` / `registry refused — sequence_gap` |
| Restore of the **pre-migration DB104** backup (rollback rehearsal) | restores 104 history rows, rolls 105–114 forward, grant audit + finance diagnostics clean, gate passes (`replayed=1`) |

One drill check fails by design of a pre-existing limitation: `POST_RESTORE_CRON_PRODUCTION_CALLS` (18 of 19 checks pass in both the DB104 and DB114 drills).
`cron.job` is not part of a backup and is recreated only by migrations the backup lacks, so a restore of a current backup has
**no recurring jobs**. Documented in [RESTORE_RUNBOOK.md](../security/RESTORE_RUNBOOK.md) §7 with the manual recreation step.

## 7. Compatibility matrix (local stack at DB114 with the new functions and the registry sink)

| Frontend | Backend | Result |
|---|---|---|
| Released `d8682e0` (fresh worktree, own lockfile install) | DB114 + new Edge Functions | authenticated Playwright suite **79 / 79** |
| `main` `fae5250` + P195 | DB114 + new Edge Functions + registry | authenticated Playwright suite **167 / 167** |
| (DB suites, `pnpm test:db`, CI order on a clean `db reset`) | DB114 | **1242 passed, 4 skipped**, 0 failed — includes the P189 deletion/restore suites, ledger gate, sealed oracle, finance/JPY/transport-guard suites |

Old web + new backend is safe: **the backend can be rolled out before the web**.

## 8. Edge Functions and secrets

Source diff `d8682e0 → main` under `supabase/functions`: **new** `delete-account` (+ `_shared/account-deletion.ts`, `erasure-sink.ts`);
**changed** `search-prices` (observations), `_shared/tcgdex.ts` (safe-integer price guard — used by `ingest-prices`, `search-prices`,
`sync-catalog`), `_shared/price-observations.ts` (new), `_shared/service-key.ts` (adds `resolvePublishableKey` only).
`fetch-fx-rate`, `ingest-fx`, `redeem-invitation` have **no source difference** and are not redeployed. Deployed sources were
compared by version number and, for `fetch-fx-rate`, by reading the deployed file (it is the pre-P153 `service-key.ts`
plus the unchanged Norges Bank client); the platform's bundle hash is not reproducible locally, so byte equality of the
others is **not** established. To deploy: `delete-account` (verify_jwt = true), `search-prices`, `ingest-prices`, `sync-catalog`.

| Function | Name | Class | Needed before P196 |
|---|---|---|---|
| all | `SUPABASE_URL`, `SUPABASE_SECRET_KEYS`/`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEYS`/`SUPABASE_ANON_KEY` | platform-injected (NOT_REQUIRED to set) | — |
| delete-account | `ERASURE_REGISTRY_URL` | PUBLIC_CONFIG | **set** (`https://pokeportfolio-erasure-registry.oskarhn06.workers.dev`) |
| delete-account | `ERASURE_REGISTRY_TOKEN` | FUNCTION_SECRET (append token) | **set** from the production env file |
| delete-account, redeem-invitation | `ALLOWED_ORIGINS` | PUBLIC_CONFIG | must include the Production web origin (the Pages domain serving the app) |
| ingest-prices, ingest-fx | `PRICE_SYNC_SECRET` | FUNCTION_SECRET | already exists (Vault `price_sync_secret` is its pair) — verify, unchanged |
| sync-catalog | `CATALOG_SYNC_SECRET` | FUNCTION_SECRET | already exists — verify, unchanged |
| (registry Worker) | `ERASURE_REGISTRY_KEY`, `ERASURE_OPERATOR_TOKEN` | OPERATOR_SECRET — **never** a Supabase secret | held by the operator only |

The tools here cannot list Production function secrets; whether `ALLOWED_ORIGINS`, `PRICE_SYNC_SECRET`,
`CATALOG_SYNC_SECRET` are set is therefore UNKNOWN to P195 (they must be, for the released functions to work).
Search/ingest/catalog behaviour (unsafe bigint transport fails closed, JPY exponent/UNIT_MULT semantics, deterministic
catalog upsert) is covered by the DB and unit suites above and by the E2E Price Check specs; no provider was called.

## 9. Backup, retention, rollback

- **Backup rehearsal**: `pnpm db:backup --db-url <local> --expect-migrations 104` → `BACKUP COMPLETE (verified from disk)`,
  five files with SHA-256 manifest, stored outside every checkout (`%USERPROFILE%\.pokeportfolio-p195\rehearsal\backups`); a
  second backup at 114. The Production run needs `supabase login` + `link` (owner) because it authenticates through the CLI's
  own role — not attempted (no private Production data was dumped).
- **Provider facts (dashboard, read-only)**: plan **free**; scheduled backups **none** ("Free Plan does not include project
  backups"); **PITR not available** (Pro add-on); backup retention **n/a**; log retention **UNKNOWN** (not shown).
  Consequence: the only restorable images are the operator's own backups. Registry retention: indefinite (D-195).
- **Rollback strategy** (no down-migrations exist; none invented): (1) web alone — repoint Cloudflare Pages to the previous
  deployment; safe against DB114 (79/79); (2) functions — redeploy the previous version (absent `delete-account` is a valid state);
  (3) database — **recovery point = the verified `pnpm db:backup` taken immediately before step 11**, restored into a **new, empty**
  Supabase project through the drill with the erasure gate, then move the application to it (an in-place dashboard restore is not
  possible on the free plan anyway). Rehearsed end to end locally (§6, last row). After a restore re-create the cron jobs (§6).

## 10. Go / no-go matrix for P196

| Gate | | Evidence / what is left |
|---|---|---|
| `EXPOSED_KEY_RESOLVED` | **OWNER_ACTION** | not identifiable; rotate per §2 |
| `REGISTRY_STORAGE_READY` | YES | §4 |
| `REGISTRY_EXPORT_READY` | YES | manual `registry-export.ts`; no schedule |
| `PROVIDER_RETENTION_KNOWN` | YES | free plan: no backups, no PITR; log retention UNKNOWN |
| `HOSTED_AUTH_HARDENED` | YES | §3 (config read back; no hosted functional test) |
| `MIGRATIONS_REHEARSED` | YES | §5 (local DB104→114) |
| `EDGE_FUNCTIONS_REHEARSED` | YES (local runtime) | hosted deploy is P196 |
| `DELETE_ACCOUNT_REHEARSED` | YES | §6 |
| `RESTORE_GATE_REHEARSED` | YES | §6 |
| `OLD_FRONTEND_NEW_BACKEND_SAFE` | YES | §7 |
| `NEW_FRONTEND_NEW_BACKEND_SAFE` | YES | §7 |
| `BACKUP_REHEARSED` | YES (local) | Production backup needs owner CLI login |
| `ROLLBACK_REHEARSED` | YES | §9, with the cron limitation |
| `PRODUCTION_SECRETS_READY` | **OWNER_ACTION** | GitHub `PRODUCTION_SUPABASE_URL` / `PRODUCTION_SUPABASE_PUBLISHABLE_KEY`; Supabase `ERASURE_REGISTRY_URL` / `_TOKEN`; verify `ALLOWED_ORIGINS` |

`READY_FOR_P196_PRODUCTION_BACKEND_ROLLOUT=no` until the key is rotated (the readiness rule needs it resolved or clearly
inactive). Everything else the rule names is `YES`.

**Owner actions before P196:** (1) rotate the secret keys (§2); (2) move `registry-prod.env` values into a password manager and
delete the files (§4 of the registry doc); (3) `supabase login` and `supabase link --project-ref nopmkroeygmlvndzjjqs` (backup,
`db push`, `secrets set`, `functions deploy`); (4) create the two GitHub secrets — names only here:
`PRODUCTION_SUPABASE_URL` = `https://nopmkroeygmlvndzjjqs.supabase.co`, `PRODUCTION_SUPABASE_PUBLISHABLE_KEY` = one of the two
`sb_publishable_…` keys; (5) decide an export schedule for the registry.

## 11. Final non-mutation check

Recorded in the session output (`output_195.txt`): Production `/build-meta.json`, hosted migration count and function
versions re-read after all work; Cloudflare automatic production deploys stay disabled (no new deployment appeared; the only
Cloudflare changes are two Workers in a separate service).
