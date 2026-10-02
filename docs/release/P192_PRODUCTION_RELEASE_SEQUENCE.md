# Production release sequence (migrations 105–114, new Edge Functions, web client)

`STATUS=PLAN_ONLY` · nothing in this document has been executed. Hosted database: **104 migrations**
(read-only check in P192: the newest applied version is `20260916121000`). Released `main` is
`d8682e0`. Derived from `.github/workflows/ci.yml`, `docs/DEVELOPMENT.md` §4/§8, `docs/security/RELEASE_PREFLIGHT_P163.md`,
`docs/security/RESTORE_RUNBOOK.md`, `docs/release/P189_ACCOUNT_DELETION.md` and the migrations themselves. Merge
readiness is judged separately in [P192_MERGE_READINESS.md](P192_MERGE_READINESS.md).

## 1. What a push to `main` does today

From the workflow file, not from memory:

| Question | Answer |
|---|---|
| `build-and-test`, `db-tests`, `native-checks` run on a push to `main`? | Yes. `on.push.branches` is `[main, 'release/**']`; no job filters on the branch except deploy. |
| `deploy-production` eligible? | Only when `needs: [build-and-test, db-tests]` both succeed **and** `github.event_name == 'push' && github.ref == 'refs/heads/main'`. It does **not** wait for `native-checks`. |
| What does it read? | Repository secrets `PRODUCTION_SUPABASE_URL`, `PRODUCTION_SUPABASE_PUBLISHABLE_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. |
| Do those secrets exist now? | The two Cloudflare secrets exist. The two `PRODUCTION_SUPABASE_*` secrets **do not** (P192 listed names only), so the job stops at its first guard (`check-public-env --require-hosted`): fail closed, nothing uploaded. |
| Does it apply database migrations? | **No.** Nothing in CI runs `db push`. |
| Does it deploy Edge Functions? | **No.** Nothing in CI runs `functions deploy`. |
| What does it deploy? | Only the web bundle to Cloudflare Pages (`wrangler pages deploy dist --branch=main`), then verifies `/build-meta.json` and `deployment-check.mjs`. |
| Can partial deployment occur? | Yes, by construction: a green deploy job ships the **new web client** while the hosted database is still at 104 migrations and the hosted functions are still the old set, because migrations and functions are manual. |
| Does anything else deploy `main`? | **Unknown / not verifiable from the repository**: Cloudflare Pages' own Git integration ("automatic production branch deployments"). P163 Part A (c)/(e) tells the owner to turn it off and the repository cannot show whether that was done. If it is still on, a merge to `main` ships the web bundle through Cloudflare regardless of the CI gate. |

Consequence: the web client, the database and the functions are three separate rollouts with no CI-enforced
order. Merging `main` is therefore not a neutral act (see P192_MERGE_READINESS.md §3).

## 2. Ordered sequence

Steps 1–8 are owner actions or read-only checks and need no code. **Do not start step 9 before 1–8 are complete.**
"Gate" is what must be true before moving on.

| # | Step | Where | Gate |
|---|---|---|---|
| 1 | Re-verify live state: `main` SHA, hosted migration count (104), hosted function list, PR head CI green on the exact head. | read-only | numbers match this document |
| 2 | Choose and provision the **erasure registry storage** (append-only, outside the database and outside every backup it protects). `scripts/restore-gate/registry-sink.ts` is a reference sink, not a production store. | owner | an https URL that accepts append-only writes and a read path for the operator |
| 3 | Create the registry secrets: `ERASURE_REGISTRY_URL` (https), `ERASURE_REGISTRY_TOKEN` (append only) as **Edge Function secrets** (`supabase secrets set`, never committed). The registry **key** (`ERASURE_REGISTRY_KEY`) is not a function secret: it stays with the registry/operator. | owner | `supabase secrets list` shows both names (no values) |
| 4 | Verify the registry is reachable from the Edge runtime **before** enabling deletion. A configured but unreachable registry leaves a requesting account in the *pending* state (writes refused, data intact, `deletion_incomplete`/`registry`) until retried or released with `abort_account_deletion`; an *unset* registry refuses cleanly with 503 before anything changes. | owner + operator | one synthetic account deleted end to end against the real registry on a non-Production project, then the registry entry read back |
| 5 | Verify the **provider retention facts** (backup/PITR/log retention of the hosted project; the organisation plan is `free`) and record them in `docs/security/RESTORE_RUNBOOK.md`. Until then the "deleted data survives in provider backups" statement stays unverified. | owner | recorded values |
| 6 | **Hosted Auth** (dashboard, Authentication): enable *Secure password change* (`security_update_password_require_reauthentication`) and *Require current password when updating* (`SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD`). Not applied by any migration. If `supabase config push` is used instead, diff the local `config.toml` against the hosted settings first: it pushes the whole file including the invite-only hook. | owner | settings visible in the dashboard; one stale-session password change refused on a test user |
| 7 | GitHub repository **secrets**: create `PRODUCTION_SUPABASE_URL` (`https://<ref>.supabase.co`) and `PRODUCTION_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`). Rotate the secret-shaped value that sits in the public Actions variable `VITE_SUPABASE_URL` (P163 Part A (a)–(b)), then delete the stale `VITE_SUPABASE_*` variables. | owner | `node scripts/check-github-release-config.mjs` (names only) |
| 8 | **Cloudflare Pages**: turn *automatic production branch deployments* **off** and previews off, so the CI job is the only deployer (P163 Part A (c),(e); Part B step 3). | owner | dashboard shows Git integration off for Production |
| 9 | `pnpm db:backup` — must print `BACKUP COMPLETE` (validated; restore is only via the runbook, never a plain replay). | operator | manifest SHA-256 recorded |
| 10 | Read-only finance diagnostics against the hosted database (`scripts/finance-integrity-diagnostics.sql`): every counter 0; re-check the P144 date contract against existing rows (`1996-10-20` ≤ date ≤ today + 1 day). | operator | all 0 |
| 11 | `supabase db push --dry-run` must list **exactly** the ten files `20260918120000` … `20261002140020` in order (see §3). Then `db push`. | operator | `list_migrations` shows 114, no gaps |
| 12 | Grant audit (`scripts/grant-audit.sql`) on the hosted database: "privilege baseline OK" and "ledger write gate OK: 5 tables gated, 10 writers flagged". | operator | both pass |
| 13 | Deploy the Edge Functions: **`delete-account` (new)**, `search-prices` (changed), plus `ingest-prices` and `sync-catalog` (they share the changed `_shared/tcgdex.ts`; the `fetch-fx-rate`, `ingest-fx`, `redeem-invitation` files are unchanged in behaviour). Set `verify_jwt` as in `supabase/config.toml`. | operator | `list_edge_functions` shows the new version/`delete-account` ACTIVE |
| 14 | Backend smoke on the hosted project with a synthetic user: invite-only sign-up still works, Price Check reads, one purchase through the official RPC, a direct `purchases` insert **refused** (`42501`), deletion of a synthetic account writes one registry entry. | operator | all five pass |
| 15 | Web deploy: merge the PR (squash). First push-to-`main` run must show `deploy-production` starting after both required jobs, passing its guard, and `/build-meta.json` reporting that exact SHA. | CI | P163 Part B step 4 |
| 16 | Production authenticated smoke (login, Collection, Price Check, add/cancel a purchase, Profile → deletion section shows and refuses nothing it cannot do). | owner | pass |
| 17 | Record the run id, SHA, migration count and function versions in `HANDOVER.md`; close P130-08 only with that evidence. | docs | — |

Native apps are **not** part of this sequence: they need signed builds, final identifiers and a physical-device pass
(§5) before any store step, and they depend on steps 11–13.

## 3. Why this order (migration batch review)

The ten migrations are one batch. Classes: `EXPAND_SAFE` (additive), `BEHAVIOR_CHANGE`, `PRIVILEGE_CHANGE`,
`CLIENT_DEPENDENT` (a client or function must match). No file contains a destructive statement outside a function body
(`drop constraint` appears once on `sales`, replaced by a looser check, and in a loop that swaps five foreign keys).

| # | Migration | Class | Notes |
|---|---|---|---|
| 105 | `20260918120000_p144_financial_boundary_semantics` | BEHAVIOR_CHANGE | Stricter completed-event dates, discount allocation, uncosted-proceeds; DECISIONS D-135 records "accepts strictly more or refuses only what the released forms already refuse", deployable in either order with the client. Rewrites `create_purchase`/`update_purchase`; adds six date-contract triggers. |
| 106 | `20260918120010_p144_privilege_baseline` | PRIVILEGE_CHANGE | Idempotent re-convergence of grants. |
| 107 | `20260926120000_p173_search_cards_stable_paging` | EXPAND_SAFE | Same signature and return columns; only a final unique sort key. |
| 108 | `20261002120000_p189_account_deletion` | BEHAVIOR_CHANGE | New tables/functions; five `NO ACTION` foreign keys to `auth.users` become `CASCADE` (short exclusive locks, tables are tiny); guard triggers on user tables. |
| 109 | `20261002120010_p189_pending_deletion_write_barrier` | BEHAVIOR_CHANGE | Refuses writes only for an account that has a pending deletion request. |
| 110 | `20261002120020_p189_purge_verifies_completion` | BEHAVIOR_CHANGE | `purge_account_data` reports `complete` only after verifying; service role only. |
| 111 | `20261002130000_p189_restore_safe_erasure` | CLIENT_DEPENDENT | Purge refuses unless a registry receipt exists: only the new `delete-account` function produces one. Nothing hosted can call the old path (there is no hosted `delete-account` today). |
| 112 | `20261002140000_p191_ledger_write_gate` | BEHAVIOR_CHANGE, CLIENT_DEPENDENT | Direct client writes to the five ledger tables are refused except organisational edits; the ten INVOKER writers announce themselves. The released web client writes only through RPCs and the allowed columns (checked, §4). |
| 113 | `20261002140010_p191_sealed_product_visibility` | BEHAVIOR_CHANGE | A holding/purchase line naming a sealed product the caller cannot see is refused with one error. |
| 114 | `20261002140020_p191_privilege_baseline` | PRIVILEGE_CHANGE | Column-level `INSERT` on `sealed_products` excluding `id` (the released client does not send `id`). |

Ordering rules that follow:

1. **Registry and secrets before migrations 108–111 matter in practice**, and **function before client**: with the
   migrations applied but no registry configured every deletion is refused with 503 (safe); with the *client* shipped
   before the function, the Profile page offers a deletion that the platform cannot perform (a 404 from a missing
   function, no data effect). Hence steps 2–4 and 13 before 15.
2. **Migrations before the new web client.** The new client works against 104 (P165: 104/106 matrix; deletion is the exception, see
   §4), but 105–114 close real defects and a client that is newer than the schema should not be the long-lived state.
3. **Migrations are forward-only.** There is no down migration; rollback is "restore from the verified backup through the
   runbook" and is a decision, not a button. Rolling back the *web* alone is always possible (Cloudflare keeps the
   previous deployment) and is safe against DB114 (§4, released-client rows).
4. Never rename an applied migration. The three P191 files were renamed in P192 only because they had **not** been
   applied anywhere (hosted newest = `20260916121000`).

## 4. Compatibility matrix (evidence in P192_MERGE_READINESS.md §5)

| Frontend | Database | Result in P192 |
|---|---|---|
| Released (`d8682e0`) | 114 migrations | see the measured result in P192_MERGE_READINESS.md §5 |
| New (this RC) | 104 | see the measured result in P192_MERGE_READINESS.md §5 |
| New (this RC) | 114 | CI `db-tests` authenticated E2E, run on every push |

## 5. Not covered by this sequence (release blockers, owner side)

Physical Android / arm64 runtime; Mac/Xcode/iPhone runtime; final application identifiers and signing; final icon and
navigation decisions if still open; TalkBack pass. They block a **store release**, not the web release above.

## 6. Rollback criteria

- Web: any failed post-deploy verification, console-visible auth failure, or a financial RPC refused for an official flow →
  re-point Cloudflare Pages at the previous deployment (dashboard) — no database change needed.
- Functions: redeploy the previous function version (`delete-account` absent is a valid state; the UI then shows an error and
  nothing is deleted).
- Database: **no automatic rollback.** If a migration fails, `db push` stops at the failing file inside its own transaction;
  stop, keep the backup, diagnose. Restoring is only through `docs/security/RESTORE_RUNBOOK.md` and **must** pass
  `restore-gate postcheck` and `promote-check` before it serves, otherwise deleted accounts reappear.
