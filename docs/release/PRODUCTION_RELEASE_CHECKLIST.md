# Production release checklist

`STATUS=NOTHING_CHECKED` — every box is open. Tick a box only with evidence (command output, dashboard
state, run id), and record the evidence in `HANDOVER.md`. Policy: `P193_MAIN_AND_PRODUCTION_POLICY.md`.
Detailed ordering and reasons: `P192_PRODUCTION_RELEASE_SEQUENCE.md`.

A Production web deploy does not apply migrations or deploy Edge Functions. The `backend_ack` input of
the **Deploy Production** workflow exists so a real deploy cannot start before this list is done.

## Credentials

- [ ] The exposed secret-shaped legacy `VITE_SUPABASE_URL` value: identified in the Supabase dashboard
      (API keys), confirmed whether active, and revoked/rotated if it is. Anything that used it updated.
- [ ] Repository secrets `PRODUCTION_SUPABASE_URL` and `PRODUCTION_SUPABASE_PUBLISHABLE_KEY` created
      (`node scripts/check-github-release-config.mjs` lists names only).

## Backend (before the web deploy)

- [ ] `pnpm db:backup` printed `BACKUP COMPLETE`; manifest SHA-256 recorded.
- [ ] Erasure registry storage chosen, reachable from the Edge runtime, secrets set.
- [ ] Provider retention facts reviewed and recorded in `docs/security/RESTORE_RUNBOOK.md`.
- [ ] Hosted Auth: *Secure password change* and *Require current password* enabled.
- [ ] Finance diagnostics against the hosted database: every counter 0.
- [ ] `supabase db push --dry-run` lists exactly migrations 105–114; `db push` applied; grant audit passes.
- [ ] Edge Functions deployed: `delete-account`, `search-prices`, `ingest-prices`, `sync-catalog`.
- [ ] Backend smoke with a synthetic user passed.

## Web release

- [ ] `main` contains the commit to release; its `build-and-test`, `db-tests` and `native-checks` are green.
- [ ] **Deploy Production** dry run (`dry_run = true`) passed for that exact SHA.
- [ ] Cloudflare Pages automatic production deployments still **Disabled** (dashboard).
- [ ] Real run (`dry_run = false`, `backend_ack = BACKEND-ROLLED-OUT`) green; `/build-meta.json` reports the SHA.
- [ ] Production authenticated smoke passed.
- [ ] Run id, SHA, migration count and function versions recorded in `HANDOVER.md`.

## P197 evidence (2026-10-04) — backend

- [x] Exposed key resolved: only `production_2026_10_rotation` remains as secret key; GitHub `PRODUCTION_SUPABASE_*` secrets and Supabase `ERASURE_REGISTRY_URL`/`_TOKEN` present.
- [x] `pnpm db:backup` BACKUP COMPLETE, restored into a disposable database (18/19, documented cron limitation) — [P197](P197_PRODUCTION_BACKEND_ROLLOUT.md) §2.
- [x] Finance diagnostics 0; dry-run listed exactly 105–114; applied; grant audit clean; hosted = 114.
- [x] Edge Functions deployed: `search-prices`, `ingest-prices`, `sync-catalog`, `delete-account`.
- [x] Authenticated read smoke, `delete-account` end to end (one synthetic non-admin account), registry head/export (seq 0 → 1, chain verified), Edge-token pairing and restore gate against the **live** registry (drill 20/21, only the documented cron limitation) — [P197B](P197B_PRODUCTION_DELETION_PROOF.md), 2026-10-09.
- [ ] **Owner (not blocking):** off-machine copies of the pre-deletion backup and the proof folder are owner-attested, not independently hash-verified; mark the old operator-token password-manager entry REVOKED.
- [ ] Authenticated graded/sealed valuation test (not run in P197B); the finance read RPCs passed.

## P195 evidence (2026-10-03)

- [x] Erasure registry storage chosen, deployed (production Worker empty) and exercised in a test namespace; export verifies and feeds the restore gate — [P195_ERASURE_REGISTRY.md](../security/P195_ERASURE_REGISTRY.md).
- [x] Hosted Auth: *Secure password change* and *Require current password when updating* ON.
- [x] Provider retention facts: free plan, no scheduled backups, no PITR, log retention unknown (registry retention indefinite).
- [x] Migrations 105–114, functions, delete-account, registry failure, restore gate and rollback rehearsed locally; old and new web clients safe against DB114 — [P195_BACKEND_RELEASE_REHEARSAL.md](P195_BACKEND_RELEASE_REHEARSAL.md).
- [ ] **Owner:** rotate the unidentifiable secret keys (record §2).
- [ ] **Owner:** `PRODUCTION_SUPABASE_URL` / `PRODUCTION_SUPABASE_PUBLISHABLE_KEY` GitHub secrets; Supabase secrets `ERASURE_REGISTRY_URL` / `ERASURE_REGISTRY_TOKEN`; `supabase login` + `link` for `pnpm db:backup` on Production.
