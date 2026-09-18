# Disaster recovery: restore runbook

Owns: the ordered procedure for turning a `pnpm db:backup` backup (`docs/DEVELOPMENT.md` §4) back
into an application-correct, non-degraded database, and the validation gates that must pass before
anyone treats a restore as trustworthy. Written by P137; closes P130-07 for the scope stated below
and fixes the cron-hardcode hazard it was blocked on (P130-12).

**Two claims this document can make, and one it cannot yet:**

```
RESTORE_VALIDATED_FOR_DISPOSABLE_RECOVERY = yes   (this document; proven repeatedly, see §7)
FULL_PRODUCTION_DISASTER_RECOVERY_VALIDATED = PARTIAL
```

A disposable restore — local development, CI, a recovery drill, a staging copy — following this
runbook has been proven, against a real backup of the real (if currently near-empty) hosted
project, to reconstruct the application's data, schema, migration history, the two `auth.users`
triggers that gate account creation, the intended grant/RLS surface, and safe (disabled-by-default)
cron scheduling, without ever reaching Production. It has **not** been proven against Supabase's
managed platform layer — provisioning a **new hosted project**, its Vault, its Auth/Storage
service configuration, its edge functions, or its DNS/CSP-facing hostname — because none of that
is reachable, or safe to touch, from this repository's tooling. Promoting this from "disposable"
to "I could actually recover Production" requires the platform-level steps in §8, which are
written but not exercised here.

---

## 1. Prerequisites

- Docker Desktop running, with the images `public.ecr.aws/supabase/postgres:17.6.1.158` and
  `public.ecr.aws/supabase/gotrue:v2.196.0` available (already cached on this machine from prior
  sessions; `docker pull` them otherwise).
- A backup produced by `pnpm db:backup` (never a bare `supabase db dump`, and never a hand-made
  substitute — see the fail-closed rules in `docs/DEVELOPMENT.md` §4).
- The repository checkout whose `supabase/migrations/` you want the restored database brought
  forward to (normally the same commit the backup's `manifest.json` was taken near, or later).
- Nothing here needs, or should be given, a real Production connection string, the
  `service_role` key, or the `price_sync_secret`. The whole procedure runs against a disposable
  target with no route to Production (§2).

## 2. Isolation, not an afterthought

Every step below runs against a **disposable database on a Docker `--internal` network**
(`docker network create --internal <name>`). `--internal` networks have no default gateway to the
outside world — a container on one that tries to reach the real internet times out, it does not
get a response, redirected or otherwise (verified directly: `curl` from such a network to a real
host returns curl exit code 28, "operation timeout", never a connection). This is different from
(and stronger for this purpose than) the `--add-host` pinning earlier sessions used on a shared
local stack: pinning trusts every process on the network to only ever resolve the pinned name,
while `--internal` makes the negative true by construction, whether or not the restored data or
schema knows about a hostname at all.

The one reason this restore procedure is not `--network none` (fully off) is that reconstructing
the **real, current** `auth` schema (§4) requires running the real GoTrue service against the
target database over the network — a bare `--network none` container cannot receive that
connection. `--internal` is the minimum widening that permits container-to-container traffic while
keeping the "no route to Production" property intact.

`pnpm exec tsx scripts/p137/restore-drill.ts --backup <dir>` automates the whole procedure below,
end to end, disposably, and is what CI or a future operator should actually run — the steps are
spelled out here for the person who needs to understand or audit what it does.

## 3. Restore order

```
1. docker network create --internal <net>
2. docker run <supabase/postgres image> --network <net>          (disposable target)
3. Bootstrap the CURRENT auth schema with the real GoTrue image   (§4 — before any data)
4. roles.sql            (tolerate "already exists"/"role does not exist" for
                          platform-only roles this app does not use, e.g. supabase_realtime_admin —
                          fail on any of: postgres, anon, authenticated, service_role,
                          supabase_auth_admin)
5. schema.sql            (recreates every public.* object, including the pg_cron/pg_net
                          `CREATE EXTENSION` statements)
6. migration_history_schema.sql + migration_history_data.sql
   — STOP AND DO NOT CONTINUE if this step is skipped or fails: without a restored history there
     is no reliable way to know which migrations are already applied, and every step after this
     one depends on that (mutation B in §7 proves the validator itself stops here).
7. Roll forward: replay, in order, every file in supabase/migrations/ whose version is NOT already
   in the restored history. This is ordinary post-restore migration catch-up (`supabase migration
   up` does the equivalent), not specific to any one fix — but it is also what actually applies
   the P137 cron-isolation migration and the latest privilege baseline to an old backup, so
   skipping it (as a "restore that stops at schema+data" does) reproduces P130-07's original
   findings exactly: grant-audit fails, and cron.job is completely empty (pg_cron's own schema is
   never captured by schema.sql, so a restore with no migration replay has literally NO cron jobs,
   not old-and-dangerous ones — see mutation A in §7).
8. Reattach the auth.users triggers (§5) — needed regardless of whether the roll-forward step ran,
   because schema.sql never captures anything attached to the `auth` schema.
9. data.sql, under `session_replication_role = replica` (so triggers do not re-fire during bulk
   load) — see §6 for which tables are load-bearing and which are tolerated as best-effort.
10. Ingest-cron neutralisation (§9) — mandatory for any target that is not the real Production
    project, which for this runbook's disposable scope is always.
11. Re-apply the lexicographically-latest `*_privilege_baseline.sql` (belt-and-suspenders; step 7
    already applies it when it is one of the pending files, but an operator restoring onto a
    checkout mid-way through a privilege-baseline change should not skip this).
12. `psql -f scripts/grant-audit.sql` — the exit gate. "Success. No rows returned." or the restore
    is not validated, full stop.
13. Data/finance/app-compatibility checks (§10).

Do not shortcut this to `psql < roles.sql < schema.sql < data.sql` and call it done. That is
exactly the plain replay P130-07 tested and found insecure.
```

## 4. Why GoTrue has to actually run

The bare `supabase/postgres` image ships an old, minimal `auth` schema baseline (missing
`email_confirmed_at`, `phone`, `banned_until`, `is_anonymous`, `deleted_at`, and entire tables —
MFA, WebAuthn, SAML, SCIM, the OAuth2 server). GoTrue owns and versions that schema itself, via its
own internal migration runner (`gotrue`'s `pop` migrator), applied when the **auth service**
starts — not by any database-only backup or restore, and not something `supabase/migrations/`
touches (that directory only ever adds objects, like the two triggers in §5, on top of whatever
`auth` schema GoTrue has already built).

Concretely: create a `--internal` network, start the disposable Postgres container on it, set a
password for `supabase_auth_admin` (only the image's true superuser, `supabase_admin` — not
`postgres`, which is privileged but not superuser on this image, matching real Supabase Postgres —
can do this under Postgres 17's tightened `CREATEROLE` rules), then run
`public.ecr.aws/supabase/gotrue:v2.196.0` once, pointed at that database
(`DATABASE_URL=postgres://supabase_auth_admin:<pw>@<db-container>:5432/postgres?search_path=auth`),
wait for its log line `"GoTrue migrations applied successfully"` (70 migrations as of v2.196.0),
then stop it. The database now has a current `auth` schema; GoTrue itself is not needed again for
the rest of the restore.

**Skipping this and hand-patching `auth.users` columns instead was tried and rejected.** The drift
is not one or two columns — it is dozens of columns and a dozen entire tables. Approximating
GoTrue's own schema by hand would mean re-implementing its migration history, which is strictly
more work and less trustworthy than running the 4 MB image that already does it correctly.

## 5. `auth.users` trigger reattachment

Two migrations attach objects directly to `auth.users` (the only two across all of
`supabase/migrations/` — confirmed by `grep -n "on auth\.users" supabase/migrations/*.sql`, and by
`scripts/p137/restore-drill.ts`'s own dynamic extraction, which finds them programmatically rather
than by this hardcoded list so a future third one is not silently missed):

- `20260817120040_create_profiles.sql` — `on_auth_user_created`, `after insert`, creates the
  matching `profiles` row.
- `20260820120030_m4_signup_gate.sql` — `enforce_invited_signup_before_insert`, `before insert`,
  invariant S2: no account without a live, consumed invitation claim.

Both trigger FUNCTIONS live in `public` and are restored correctly by `schema.sql`. Only the
`CREATE TRIGGER ... ON auth.users ...` **attachment** itself is missing after a plain restore
(P130-07's "auth.users triggers 2 -> 0"), because `schema.sql` — by Supabase's own dump design —
excludes the `auth` schema entirely, attachment included. The fix is to re-issue exactly those two
`CREATE TRIGGER` statements (not the whole migration file, which would also try to recreate the
`profiles` table `schema.sql` already restored, and fail).

Do this **before** restoring `data.sql`, and restore `data.sql` under `replica` mode regardless —
replaying historical `auth.users` rows must never re-trigger the invite-gate check against
whatever claim rows happened to be live at restore time.

## 6. What the backup actually protects, table by table

Classification per the P137 prompt's own taxonomy. "Required" = `DEFAULT_REQUIRED_TABLES` in
`scripts/db-backup/backup-core.ts`, the same list `pnpm db:backup` itself refuses to call complete
without.

| Component | Classification |
|---|---|
| `auth.users`, `public.profiles`, `purchases`, `purchase_lines`, `holdings`, `acquisition_lots`, `lot_disposals`, `sales`, `sale_lines`, `openings` (data) | **Captured by backup** — exact row counts verified every restore (§10). |
| Every other `public.*` table (catalog, prices, snapshots, invitations, …) | **Captured by backup** — restored best-effort, not individually gated (the required list above is the ledger's load-bearing core). |
| `auth.users` / `enforce_invited_signup` / `handle_new_user` trigger **attachment** | **Recreated by migration replay** — §5, not in the backup at all. |
| `pg_cron` / `pg_net` extensions, cron job **definitions** | **Recreated by migration replay** — `schema.sql` captures the `CREATE EXTENSION` statements; the job rows themselves live in the `cron` schema and are captured by neither `schema.sql` nor `data.sql` (confirmed: a restore with no migration replay has `cron.job` completely empty, not stale-and-dangerous — mutation A, §7). |
| Grants / privilege baseline | **Recreated by migration replay** — the latest `*_privilege_baseline.sql`, applied either as part of roll-forward or explicitly (§3 step 11); `schema.sql` alone does not converge this correctly (mutation A reproduces the exact P130-07 grant blowout when roll-forward is skipped). |
| `auth.*` schema structure (columns, MFA/WebAuthn/SAML/SCIM/OAuth2-server tables) | **External platform configuration** — owned by the GoTrue service's own migrator, reconstructed here by actually running that service (§4), not by anything database-backup-shaped. |
| `auth.audit_log_entries`, `auth.flow_state`, `auth.custom_oauth_providers`, `auth.oauth_*`, `auth.mfa_*`, `auth.saml_*`, `auth.scim_*`, `auth.webauthn_*`, `auth.sessions`, `auth.one_time_tokens` (data) | **Not required** — GoTrue-internal operational/audit state, never application data, not in `DEFAULT_REQUIRED_TABLES`; a schema-version gap between the disposable drill's GoTrue version and the real hosted project's can leave some of these tables' data un-restored without affecting anything this application does. |
| `storage.*` | **Not required** — this application does not use Supabase Storage buckets; `buckets_vectors`/`vector_indexes` are already excluded from the data dump by `pnpm db:backup` itself. |
| Vault secrets (`price_sync_secret`) | **External platform configuration, not recoverable from a database backup by design** — Vault-stored secrets are deliberately never dumped. Re-provisioned out-of-band, same as on first setup. |
| GoTrue's Auth Hook wiring (`before_user_created` -> `public.before_user_created`) | **External platform configuration** — a `supabase/config.toml` setting pushed with `supabase config push` / the dashboard, not a database object. The *function* it calls is restored by `schema.sql`; the *wiring* is not, and this runbook cannot exercise `supabase config push` against a disposable target. |
| `environment_ingest_config` (P137) | **Captured by backup only if it was ever set** — and if it was (i.e. the backup came from an already-configured Production), the restore procedure actively **clears** it for any non-Production target (§9). This is intentional, not a gap. |
| Edge function deployments (`ingest-prices`, `ingest-fx`, `redeem-invitation`, `fetch-fx-rate`) | **External platform configuration** — deployed code, not database state. A promoted/rebuilt project needs `supabase functions deploy`, out of scope here. |
| A new hosted project's DNS/CSP-facing hostname | **External platform configuration** — the frontend build bakes in `VITE_SUPABASE_URL`; a genuinely new project needs a rebuild, out of scope here. |

## 7. Mutation proof (what the validator actually catches)

Run with `--mutation <A|B|C|D|E>`. All five pass as of this runbook (`git log`-visible in the
P137 branch; re-run locally to reproduce — no hosted access needed, ~30s each):

- **A** — skip migration roll-forward entirely (the closest reproduction of P130-07's original
  "plain roles+schema+data replay"). Detected two independent ways: `grant-audit.sql` fails with
  the exact "UNEXPECTED privilege" shape the M4 incident and P130-07 both found, **and**
  `cron.job` is completely empty (not stale-and-dangerous — see §6).
- **B** — skip `migration_history_schema.sql`/`migration_history_data.sql`. Detected: restored
  history row count is 0, not the manifest's recorded count; the validator stops immediately
  rather than guessing which migrations are safe to roll forward (§3 step 6).
- **C** — pre-seed the restored data with an **enabled** `environment_ingest_config` row (base
  URL = the real Production hostname), simulating a Production backup landing on a disposable/
  local/staging target. Detected and **fixed by the procedure itself**: the mandatory
  neutralisation step (§9) clears it, and the restored database ends with zero configured ingest
  targets and zero hostname occurrences in any cron command.
- **D** — a backup copy whose `data.sql` is actually a schema-only dump (the exact P130-06
  defect) saved under the data filename. Detected before any restore is attempted at all: reusing
  `verifyBackupDirectory` from `scripts/db-backup/backup-core.ts` (P131) refuses it — "no COPY
  data blocks — this is a schema-only dump".
- **E** — a tampered `manifest.json` (migration-history row count silently changed). Detected the
  same way: the `BACKUP_COMPLETE` marker's SHA-256 no longer matches the manifest, and
  verification refuses before any restore is attempted.

## 8. What would still be required for a real Production disaster

Everything in §6 marked **external platform configuration**, concretely, in order, for the
scenario "the current hosted project is gone and a new one must serve Production":

1. Provision a new Supabase project (owner action, dashboard).
2. `supabase link` this repository to it; run `roles.sql` -> `schema.sql` -> migration history ->
   roll-forward (this runbook's §3, against the new project instead of a disposable container).
3. Let the new project's own GoTrue instance bootstrap its auth schema (automatic on a real
   project — §4's manual GoTrue-container step is a disposable-drill substitute for this).
4. Reattach the two `auth.users` triggers (§5) — same statements, against the new project.
5. Restore `data.sql` (replica mode), same as §3 step 9.
6. `supabase config push` to wire the Before User Created hook (`public.before_user_created`) —
   this runbook cannot exercise this step; it is the one piece of §6 for which there is currently
   no drill at all, disposable or otherwise.
7. Re-provision `price_sync_secret` in the new project's Vault, out-of-band, never in git.
8. Run this runbook's §9 neutralisation, THEN, deliberately, the one-time
   `insert into public.environment_ingest_config (...)` enabling ingest — only against the new
   project, and only after confirming it, not the old one, is what DNS/the frontend build now
   point at.
9. `supabase functions deploy` every edge function.
10. Rebuild and redeploy the frontend with the new project's `VITE_SUPABASE_URL` (CSP `connect-src`
    is baked in at build time — P130-07's own finding).
11. Run `scripts/remote-security-check.mjs` and the authenticated E2E suite against the new
    project before calling it live.

None of steps 1, 3 (real, non-drill), 6, 9, 10 or 11 were exercised by P137 — they need a real
Supabase project, which this session does not create or touch (task scope: no hosted mutations).
This is the entire reason `FULL_PRODUCTION_DISASTER_RECOVERY_VALIDATED` stays `PARTIAL` rather than
becoming `yes`.

## 9. Ingest-cron neutralisation (mandatory, every non-Production target)

After `data.sql` is restored, unconditionally:

```sql
delete from public.environment_ingest_config;
```

This is required even when the source backup's data contained no configured row (the common
case today — Production itself has never run the one-time enable step) — the step is unconditional
*because* a future backup, taken after Production is configured, would otherwise carry that
configuration onto whatever restores it, silently reintroducing exactly the hazard P130-12 fixed
(P137's migration makes local/CI/disposable/restored databases default to no outbound ingest
scheduling; carrying over an explicit Production configuration through backup data is the one way
that default could be defeated, so this step closes it explicitly rather than relying on the
default alone). Confirm afterward:

```sql
select count(*) from public.environment_ingest_config where base_url is not null;  -- must be 0
select count(*) from cron.job where command ~ '\.supabase\.co';                    -- must be 0
```

## 10. Post-restore verification (the actual exit gate)

In order, all required:

1. `psql -f scripts/grant-audit.sql` — "Success. No rows returned."
2. Anon-executable `SECURITY DEFINER` functions in `public` = exactly `{invitation_status}`, the
   one documented, audited exception (P130-07's headline finding was 34; this is the re-proof that
   it is back down to the one intentional case, not a naive "zero" that would also flag a correct
   restore as broken).
3. Required-table row counts (§6) match the backup manifest exactly — aggregate counts only, never
   row contents, never printed or committed anywhere.
4. `scripts/finance-integrity-diagnostics.sql` (read-only) runs clean against the restored data.
5. Core finance RPCs resolve (`create_purchase`, `create_sale`, `set_sealed_lot_intent`,
   `void_purchase` present in `pg_proc`) and RLS is enabled with policies present on `public.*`.
6. Ingest-cron neutralisation confirmed (§9).

`scripts/p137/restore-drill.ts` runs all of the above (plus §3-§9) end to end and exits non-zero on
any failure. Treat a restore as `RESTORE_VALIDATED_FOR_DISPOSABLE_RECOVERY` only when it exits 0.

## 11. Abort / rollback rules

- Any step in §3 failing on a **required** table, role, or the grant audit (§10.1) stops the
  procedure — do not continue "to see how far it gets." A partially-restored disposable database
  is deleted (`docker rm -f -v`), not patched forward by hand.
- Never point this procedure at a database anyone might mistake for real Production. Every command
  in this runbook is written against a disposable, `--internal`-networked container; if adapting
  §8 for a genuine new-project promotion, that adaptation is the owner's explicit, separate
  decision — not an extension of a routine drill.
- If §9's neutralisation step is ever skipped or its post-check (§9's two `select count(*)`
  queries) returns nonzero, the restore is **not validated**, regardless of what every other check
  says.
