# P194: development RC merged into `main`

Merge is not release. `main` is the integrated development line; Production is the older, explicitly
released SHA.

| Item | Value |
|---|---|
| PR | #113, normal merge commit (history kept), merged 2026-10-03T10:27:36Z |
| Merged head | `9aa5e252fe1ca8bc5cdacf6e677d5d4225a42fb0` |
| `main` after merge | `b26fcf249e2254570672daee3756779339664e04` |
| Main CI | run 37116493073: `build-and-test`, `db-tests`, `native-checks` green; no deploy job exists |
| Production | `d8682e047b757f63673a63ac8185a4806d68cb98`, unchanged (`/build-meta.json` read before and after) |
| Hosted DB | 104 migrations, newest `20260916121000`, unchanged. `main` carries 114 source migrations |
| Edge Functions | unchanged (`redeem-invitation` v7, `sync-catalog` v6, `fetch-fx-rate` v3, `ingest-prices` v2, `ingest-fx` v3, `search-prices` v3; no `delete-account`) |
| Manual deploy dry run | run 37117692463, `workflow_dispatch` on `main`, `dry_run=true`, sha = `main` SHA: `verify` passed (SHA on `origin/main`, three required checks succeeded), `deploy` skipped, no secret used |
| Cloudflare automatic production deploys | disabled (confirmed by the owner in the dashboard before the merge; the assistant could not read it behind a bot check) |
| Workflow permissions | `contents: read`, `checks: read` |

`release/p190-cross-platform-development-rc` is `MERGED_TO_MAIN`. Keep it for traceability; delete it in
a later cleanup together with the other merged feature branches.

## Still blocking a release (`PRODUCTION_RELEASE_READY=no`)

Ordered for planning. Gates: [PRODUCTION_RELEASE_CHECKLIST.md](PRODUCTION_RELEASE_CHECKLIST.md).

- **MUST_BEFORE_WEB_RELEASE:** Production erasure-registry storage/config; provider backup/PITR/log-retention
  verification; hosted Auth (secure password change, require current password); hosted DB migrations 105-114
  after `pnpm db:backup`; Edge Functions `delete-account`, `search-prices`, `ingest-prices`, `sync-catalog` and
  their secrets; `PRODUCTION_SUPABASE_URL` / `PRODUCTION_SUPABASE_PUBLISHABLE_KEY` GitHub secrets.
- **SECURITY_HARDENING:** rotate or revoke the old `sb_secret_`-shaped key that transited the deleted
  `VITE_SUPABASE_URL` variable, unless it is shown to be inactive (owner action; not readable by the assistant).
- **MUST_BEFORE_NATIVE_STORE_RELEASE:** physical Android and arm64 run; Mac/Xcode and iPhone run; final
  production application IDs and signing.
- **PRODUCT_DECISION:** icon and navigation decisions if still considered open.
