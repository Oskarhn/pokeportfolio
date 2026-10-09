# P197 — Production backend rollout (2026-10-04)

`STATUS=PARTIAL_P197_BACKEND_ROLLED_OUT_AUTHENTICATED_PROOFS_OWNER_PENDING` · rollout source `main` =
`7f2d691c78c9dd6b473dff09a153bfa3518eabb0` (CI on that exact SHA: build-and-test, db-tests, native-checks all
success, run 37198818541) · **Production frontend not changed** (`d8682e047b757f63673a63ac8185a4806d68cb98`, read
before and after) · `deploy-production.yml` was not run.

Target state reached: **database 104 → 114, current-main Edge Functions deployed, old web frontend unchanged.** Metadata
only below; no secret, token, backup content or registry export appears in this repository.

## 1. State before mutation (read-only)

| Fact | Evidence |
|---|---|
| Project identity | one project visible to the tooling: name `pokeportfolio-dev`, ref `nopmkroeygmlvndzjjqs`, eu-west-3, Postgres 17.6, `ACTIVE_HEALTHY`; the CLI was linked to that ref explicitly before any write |
| Frontend | `/build-meta.json` = `d8682e0…`, built 2026-09-18T08:22:20Z |
| Hosted migrations | 104, newest `20260916121000`; `supabase db push --dry-run` listed exactly the ten files below and nothing else |
| Secret API keys | dashboard: only `production_2026_10_rotation` (old `default` / `default1` absent) |
| Function secret names | `ALLOWED_ORIGINS`, `CATALOG_SYNC_SECRET`, `ERASURE_REGISTRY_TOKEN`, `ERASURE_REGISTRY_URL`, `PRICE_SYNC_SECRET` present; `ERASURE_REGISTRY_KEY` absent (correct) |
| Hosted Auth (read back) | secure password change ON, require current password ON, min length 12, secure email change ON |
| `main` protection | PR required, `build-and-test` / `db-tests` / `native-checks` required, force push blocked; `enforce_admins=false` (unchanged policy) |
| Deploy workflow | single trigger `workflow_dispatch`; not run |
| PR #118 | open, mergeable, all checks green (docs only) — deliberately **not** merged before the rollout so the rollout source SHA stayed the one with verified CI |
| Finance diagnostics | `scripts/finance-integrity-diagnostics.sql`: every counter 0 (3 NOK purchases, no sales, no JPY) |
| Ownership / orphans / idempotency | cross-user sealed refs 0, owner violations 0, orphan rows 0, duplicate idempotency keys 0 |
| Grant audit | failed with exactly the delta migrations 105–114 add (`sealed_products` column INSERT, `allocate_purchase_discount` EXECUTE) — expected, same as the P195 rehearsal |

## 2. Backup (hard gate) — `BACKUP_RESTORE_VERIFIED=yes`

- `pnpm db:backup --expect-migrations 104` → `BACKUP COMPLETE (verified from disk)`, directory
  `20261004T203244Z` under the private backup root next to the main checkout (outside every git checkout).
  104 migration-history rows; 65 COPY tables, 129 454 rows; `data.sql` 21 910 327 B, sha256
  `bf2a2d91cf31079cd12f771fb68839319ccd7352a2c06276332e3e6bcf9c9da8`; `schema.sql` sha256
  `21358ef48ed7b1dbbcf6e3dc1a35b5649a812ae8601871dba27513daf1248470`; Postgres 17.6.
- Restored into a disposable `--network none` database with `scripts/p137/restore-drill.ts` (twice): backup re-verified,
  roles, schema, 104 history rows, roll-forward of the ten pending migrations, all 10 required tables with exactly the
  recorded row counts, grant audit clean, finance diagnostics clean, RLS/policies present, finance RPCs resolve. **18 of
  19 checks pass**; the one failure is the documented pre-existing limitation `POST_RESTORE_CRON_PRODUCTION_CALLS`
  (cron jobs are not part of a backup; RESTORE_RUNBOOK §7). The erasure-gate checks passed against a **synthetic** registry
  signed with a throwaway key — they prove the mechanics, **not** the live Production registry (§6).
- Provider backups: none (free plan, no PITR). This backup is the only recovery point.
- Deployed Edge Function sources were downloaded to the same private root as rollback sources (§4).

## 3. Migrations — applied 2026-10-04 20:42:07Z → 20:42:32Z

`supabase db push --linked` applied, in order and without error: `20260918120000_p144_financial_boundary_semantics`,
`20260918120010_p144_privilege_baseline`, `20260926120000_p173_search_cards_stable_paging`,
`20261002120000_p189_account_deletion`, `20261002120010_p189_pending_deletion_write_barrier`,
`20261002120020_p189_purge_verifies_completion`, `20261002130000_p189_restore_safe_erasure`,
`20261002140000_p191_ledger_write_gate`, `20261002140010_p191_sealed_product_visibility`,
`20261002140020_p191_privilege_baseline`.

After: **114 history rows, last `20261002140020`, no duplicate versions**; grant audit clean (`privilege baseline OK`, ledger
write gate OK); finance diagnostics every counter 0; ledger row counts identical to before (3 purchases, 3 lines, 4 lots,
1 user); `account_deletion_requests`, `account_erasure_receipts`, `restore_gate_runs` exist; `search_cards` returns pages;
the six cron jobs are unchanged and active.

## 4. Edge Functions

| Function | Class | Before | After | Rollback source |
|---|---|---|---|---|
| `search-prices` | UPDATED | v9 `1223b761…` | v10 `1cc77aa5…` | downloaded deployed source = `d8682e0` source |
| `ingest-prices` | UPDATED | v8 `b3fb7834…` | v9 `a3e089ca…` | downloaded deployed source = `d8682e0` source |
| `sync-catalog` | UPDATED | v12 `c90f0d09…` | v13 `1b19bb99…` | downloaded deployed source (its `_shared/tcgdex.ts` is older than `d8682e0`'s — use the download, not git) |
| `delete-account` | NEW | absent | v1 `dea079b4…` | undeploy (absence is a valid state) |
| `redeem-invitation` | UNCHANGED | v13 `7b222fbb…` | v13 same hash | — |
| `fetch-fx-rate` | UNCHANGED | v9 `1fd60272…` | v9 same hash | — |
| `ingest-fx` | UNCHANGED | v9 `3115fa04…` | v9 same hash | — |

Deployed sources of all six pre-existing functions were downloaded and diffed: `redeem-invitation`, `fetch-fx-rate`,
`ingest-fx` are byte-identical (modulo line endings) to `main`, so they were not redeployed. `verify_jwt` is as in
`supabase/config.toml` for all seven. Order used: search-prices → ingest-prices → sync-catalog → delete-account. The
first `delete-account` deploy attempt returned a platform 500 (no function was created); the retry succeeded.

## 5. Smoke results

| Check | Result |
|---|---|
| `ingest-prices` through the real 15-minute cron path (new v9, real `PRICE_SYNC_SECRET`) | 20:45:00 → HTTP 200, `ok:true`, 6 snapshots written, 0 provider errors |
| `search-prices` / `ingest-prices` / `sync-catalog` without or with a wrong bearer | 401 each |
| `delete-account` no auth / wrong bearer / publishable key only / oversize body | 401 / 401 / 401 `unauthenticated` / 401 |
| `remote-security-check.mjs` phase 1 | 17/17 |
| Registry Worker, no/wrong token | 401 (reachable, refuses) |
| Logs after the rollout (edge + Postgres error severity) | no 5xx, no Postgres ERROR/FATAL |
| Frontend after | still `d8682e0…` |

## 6. What was NOT done, and why (truthful gaps)

> **Closed by P197B (2026-10-09):** the authenticated `delete-account` run, the registry head/export, the Edge-token pairing and the restore gate against the live registry were completed — see [P197B_PRODUCTION_DELETION_PROOF.md](P197B_PRODUCTION_DELETION_PROOF.md). The list below is the state at 2026-10-04.

The session's operating rules forbid creating accounts and entering passwords on a non-local host, even when the task asks
for it; the registry operator credentials had been moved out of the machine by the owner. Therefore **not verified**:

- Old frontend logged in against DB114 (collection read, portfolio summary, finance RPCs, logout) — unauthenticated
  surfaces and the unchanged P195 matrix (79/79 old frontend against a local DB114) only.
- `delete-account` end to end (synthetic user, 200, stale session dead, registry receipt) and **whether
  `ERASURE_REGISTRY_TOKEN` equals the Worker's append token** — presence/digest only. A mismatch fails closed
  (`503`, retryable, account pending-but-intact); the account population is one owner account and the released web has no
  deletion UI.
- Registry head before/after, registry export, and `PRODUCTION_REGISTRY_RESTORE_GATE` against the live registry.
- Authenticated finance / non-NOK / direct-write-refused / sealed-oracle probes on Production. These are covered by the DB
  suites (1242 passed) and the P195 local DB114 rehearsal, not by a Production run.
- Cloudflare Pages automatic-deploy setting (dashboard needs a login this session does not perform): **inferred** off
  from the unchanged serving SHA across the merges of PRs #113–#117.

Owner-run checklist (one synthetic account, then remove it): create an invitation in the admin UI, redeem it, add a tiny
purchase, call `delete-account` with that account's session and password, confirm 200 and that the old token is refused;
`registry-export.ts` (operator token) must then show head seq 1; feed the export plus the `20261004T203244Z` backup to
`restore-drill.ts --erasure-registry`. If the deletion answers 503, fix `ERASURE_REGISTRY_TOKEN` (set it to the Worker's
append token) and retry; if that cannot be fixed, undeploy `delete-account`.

## 7. Rollback decision points (as executed)

Before migration: abort = no mutation (not needed). During/after migrations: all ten applied cleanly, DB114 kept. Function
failure: redeploy the downloaded source of that function (the only failure seen was a transient platform 500 on first
`delete-account` deploy; retry succeeded). Widespread backend incompatibility: restore the `20261004T203244Z` backup into a
**new** project via the drill and the erasure gate (RESTORE_RUNBOOK); no down-migrations exist and none were invented.
`ROLLBACK_REQUIRED=no`.

## 8. Next

(Update 2026-10-09: the owner proofs are done — P197B.) P198 = release the current validated `main` frontend (manual `deploy-production.yml`, `backend_ack = BACKEND-ROLLED-OUT`),
after the owner-run proofs in §6 — in particular the delete-account and registry checks — or an explicit owner decision to
accept them as open. Production is now **old frontend + DB114 + current functions**; do not read `main` as Production.
