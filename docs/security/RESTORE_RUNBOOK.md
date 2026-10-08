# Restore runbook — deleted accounts must stay deleted (P189)

> **NEVER PROMOTE A RESTORED DATABASE BEFORE THE ERASURE GATE PASSES.**
> A restored database that has not passed `postcheck` **and** `promote-check` is **NOT SAFE TO SERVE**.

This is the operator procedure for the one thing a backup cannot do by itself: remember that someone
was deleted *after* the backup was taken. It sits on top of the disaster-recovery procedure in
[`docs/RESTORE_RUNBOOK.md`](../RESTORE_RUNBOOK.md) (how a backup becomes a working database) and adds
the erasure gate to its exit criteria. Design and data scope:
[`P189_DELETION_DATA_MAP.md`](P189_DELETION_DATA_MAP.md), decision D-189.

## 1. The invariant

After an account deletion is confirmed, no normal restore of any database backup — including one
older than the deletion — may leave that identity's account or personal application data active in a
database that serves traffic.

How it is held: (1) the deletion workflow records the erasure in the **erasure registry**, which
lives outside every backup, *before* the first destructive step (the database refuses to purge
until it is recorded); (2) every restore replays the registry onto the restored image and verifies
the result *before* the image is promoted. The registry is the source of truth and is **never**
restored together with the snapshot it corrects — keep it on a different system, with different
credentials, backed up on its own schedule.

## 2. Required order

```text
1. restore ISOLATED        (disposable database; nothing points at it)
2. registry verify         restore-gate verify        — read-only; learn what is resurrected
3. erasure replay          restore-gate apply         — (dry-run first) idempotent
4. finance/integrity diagnostics   scripts/finance-integrity-diagnostics.sql, grant audit
5. deletion-resurrection checks    restore-gate postcheck   — stamps the image
6. promotion approval      restore-gate promote-check — immediately before pointing anything at it
7. serve traffic
```

Steps 2–5 are built into `scripts/p137/restore-drill.ts`; the drill **fails** unless the gate passes
(`--erasure-registry <file>`), and `--no-erasure-gate` is a loud, deliberate bypass that also fails
and prints `NOT SAFE TO SERVE`. Do not read a green drill that used the bypass as anything.

## 3. Commands

Key and registry (never on a command line, never in Git):

```bash
# once, offline: the HMAC key of the registry. Store it with the registry's credentials, NOT in the
# application's backups and NOT in the Edge Function (the function only holds an append token).
pnpm exec tsx scripts/restore-gate/restore-gate.ts keygen
export ERASURE_REGISTRY_KEY=<64+ hex>
```

Against the restored, isolated database (`--db-url` as the role that owns the restored objects):

```bash
pnpm exec tsx scripts/restore-gate/restore-gate.ts verify        --db-url "$RESTORED_DB_URL" --registry "$REGISTRY" --json
pnpm exec tsx scripts/restore-gate/restore-gate.ts apply         --db-url "$RESTORED_DB_URL" --registry "$REGISTRY" --dry-run
pnpm exec tsx scripts/restore-gate/restore-gate.ts apply         --db-url "$RESTORED_DB_URL" --registry "$REGISTRY"
pnpm exec tsx scripts/restore-gate/restore-gate.ts postcheck     --db-url "$RESTORED_DB_URL" --registry "$REGISTRY"
pnpm exec tsx scripts/restore-gate/restore-gate.ts promote-check --db-url "$RESTORED_DB_URL" --registry "$REGISTRY"
```

Options: `--json` (one machine-readable object), `--allow-empty-registry` (say, on purpose, that nobody
was ever deleted), `--expect-head-seq <n>` (refuse a registry shorter than the head you recorded
elsewhere), `--db-url-env <NAME>`. Output is counts and relation names only — never an id, address or row.

| Exit | Meaning | Promotion |
|---|---|---|
| 0 | clean / replayed and re-verified / stamped / promotable | allowed only after `promote-check` = 0 |
| 1 | an erased account is present, or replay did not converge | **no** |
| 2 | registry missing, empty, malformed, wrongly keyed, torn, wrong schema, failed integrity | **no** |
| 3 | the image lacks the machinery — roll migrations forward first | **no** |
| 4 | database unreadable | **no** |
| 5 | registry and image disagree (the image holds a receipt the registry lacks ⇒ the registry is **older than the backup**, or foreign) | **no** — find the right registry; do not "fix" it by editing it |
| 6 | promote-check: no passing stamp, or the stamp does not cover the current registry head | **no** |

`apply` is idempotent: a second run replays nothing and changes nothing. Every command is
deterministic and read-only except `apply` (replay) and `postcheck` (writes one stamp row).

## 4. Why each check exists

- **verify/postcheck scan every column that names an account** — `auth.users`, `auth.identities` and
  every foreign key to `auth.users` in `public`, derived from the catalog — so a table added later is
  covered. An id found in an owner column but absent from `auth.users` is an *orphan* and is refused
  rather than guessed at.
- **Registry older than the backup** is detected where it can be: the database keeps a witness copy
  of every receipt (`account_erasure_receipts`). A restored image with a receipt the registry lacks,
  or whose sequence is above the registry's head, is refused (exit 5). Truncation of the registry's
  tail cannot be seen from the file alone; the witness and `--expect-head-seq` are the defence.
- **promote-check never trusts a stamp**: it requires a passing stamp for the *current* registry head
  and then verifies again. A registry that grew after the stamp invalidates it.

## 5. Hosted Supabase: the in-place restore problem (read before an incident)

Facts (official documentation, fetched 2026-10-02): a Supabase project is restored **in place** from a
daily backup or point-in-time recovery, and "the project is inaccessible during this process"
(<https://supabase.com/docs/guides/platform/backups>). Therefore the dashboard restore cannot be
"isolated first": when it finishes, the project is the live database again, and for the interval
before you run the gate a resurrected account **can sign in**. This runbook cannot close that
interval technically; the options are:

1. **Preferred:** restore *our own* verified backup (`pnpm db:backup` output) into a **new, empty**
   project or the local drill, run the gate there, and only then move the application (frontend
   build values, Edge Function secrets) to it.
2. If a dashboard restore of the live project is unavoidable: take the application offline first
   (Cloudflare Pages maintenance page, and disable sign-in for the duration — a mechanism the owner
   must choose; none is configured today), restore, run the gate against the live project's
   database **before** re-enabling sign-in, then `postcheck` and `promote-check`.

Which of these the owner can actually do depends on settings this repository cannot see
(plan, backups/PITR, network restrictions). They are listed as **OWNER_DECISION_REQUIRED**, not assumed.

## 6. Registry operations

- **Write path.** The `delete-account` Edge Function appends to the registry through an HTTPS endpoint
  (`ERASURE_REGISTRY_URL` + `ERASURE_REGISTRY_TOKEN`, contract in `scripts/restore-gate/registry-sink.ts`).
  If either is missing or invalid the function refuses every deletion with `503 deletion_unavailable`
  before touching anything — there is no "delete without recording" mode. The reference sink is a
  file-backed server (`registry-sink.ts`) used by the tests; **production** uses the Cloudflare Worker + Durable Object
  of [P195_ERASURE_REGISTRY.md](P195_ERASURE_REGISTRY.md) (same contract; `GET /v1/export` is the registry file the
  gate reads; `scripts/restore-gate/registry-export.ts` pulls and verifies it). Take an export before every restore.
- **A deletion that cannot reach the registry** leaves the account *pending* (writes blocked) with
  all its data intact and answers `deletion_incomplete`, stage `registry`; repeating the request
  retries. To release such an account an operator may call `abort_account_deletion(<id>)` as the
  database owner — **only after** `restore-gate find --registry … --id <id>` confirms the registry does
  not hold it (if the registry did accept it and only the answer was lost, aborting would leave a
  live account in the registry, and the next restore would delete it). `abort_account_deletion`
  refuses to act on an account whose erasure is recorded.
- **Pending accounts that never finish** (the person never retried) are completed by re-running the
  same function, or by the gate's replay on the next restore; they are write-blocked meanwhile.
- **Manual record** (operator-handled erasure): `restore-gate add --registry … --id <uuid>`.
- **Retention of the registry:** a record may never be dropped while any backup older than that
  erasure can still be restored. Deleting old registry records is therefore an owner decision tied to
  backup retention; none is made here.
- **Loss of the registry** is a security incident: restores are refused (exit 2) until the right
  registry is recovered; do not recreate one empty to get green.

## 7. Verified evidence (local; hosted not exercised)

See `docs/TESTING.md` §6g for the exact commands and counts. In short: `tests/db/p189_restore_safe_erasure.test.ts`
restores a real pre-deletion backup, shows every account-owning relation resurrected (the hazard),
and proves `apply`/`postcheck`/`promote-check` remove it, are idempotent, refuse every bad registry,
detect a registry older than the backup and never touch a live account. With `P189_FULL_DRILL=1` the
same is run through `pnpm db:backup` and `scripts/p137/restore-drill.ts`.

## 8. What this does not do

- It does not rewrite or shorten any backup, and it does not claim to.
- It does not cover a *compromised* operator or registry key; it makes tampering with the file
  detectable, not impossible.
- It does not protect a database that is promoted without the gate — the tooling makes that loud, not
  impossible. The hosted in-place restore (§5) is the largest open gap.
- Production registry storage and the provider retention facts are owner gates
  (`PRODUCTION_REGISTRY_STORAGE_READY=no`, `PROVIDER_RETENTION_VERIFIED=no`).

## 7. Known limitation: scheduled jobs are not part of a backup (P195, pre-existing P137 finding)

`cron.job` is not captured by `pnpm db:backup`; it is recreated only by replaying migrations the backup lacks. A restore of an
already-current backup therefore comes up **without** the recurring jobs (price and FX ingestion, snapshot recompute, retention).
The restore drill reports this as `POST_RESTORE_CRON_PRODUCTION_CALLS` FAIL on a current backup (measured again in P195: every
erasure-gate step passed, this one check failed, in both the DB104 and the DB114 drill). Until a fix exists, after promoting a
restored image re-create the jobs by re-running the `cron.schedule` statements of the migrations that define them
(`m9_cron_schedule`, `m12_cron`, `p42_cron_cadence`, `p137_environment_scoped_ingest_dispatch`) and check `select jobname, active from cron.job`.

## 9. Proving restore-safe deletion against Production (owner-operated)

`scripts/restore-gate/owner-deletion-proof.ts` deletes **one** named synthetic account through the real
`delete-account` Edge Function and then proves the invariant of §1 against a *pre-deletion* backup. It runs
on the owner's machine because it needs the account password, the registry operator token and the registry
HMAC key, none of which may be pasted into a chat, a command line or Git. Passwords and keys are read from
the TTY with echo off (the two registry values may come from `ERASURE_OPERATOR_TOKEN` / `ERASURE_REGISTRY_KEY`);
tokens live only in process memory; output is PASS/FAIL lines and counts.

```text
pnpm exec tsx scripts/restore-gate/owner-deletion-proof.ts \
  --backup <pre-deletion backup dir> --out-dir <private dir outside every checkout> \
  --expect-user-id <full UUID of the account> --publishable-key <sb_publishable_…> [--skip-drill]
```

Gates, in order; a failed gate stops the run and nothing is ever re-sent:

1. Target is Production (project `nopmkroeygmlvndzjjqs` + the Production registry Worker) or a loopback
   rehearsal; a mixture is refused. Backup verified from disk, stamped with the Production fingerprint,
   taken **after** the account existed, holding its live purchase and lot, and naming the administrator(s).
2. Registry reachable, key valid, chain verified.
3. Sign-in; the id equals `--expect-user-id`; e-mail identity and no verified second factor (the function
   would refuse otherwise); `profiles.is_admin = false` read through RLS with the account's own session.
4. The account's own holding exists. 5. Read-only authenticated smoke: Search, the browser CORS preflight
   and an authenticated call of `search-prices`, and the finance read RPCs. A failure stops the run **before**
   the deletion, with the account intact.
6. Registry head read immediately before; the operator types `DELETE <first 8 hex of the id>`.
7. `POST /functions/v1/delete-account {expectedUserId, password, confirm:true}` → `200 {"status":"deleted"}`.
8. The stale access token, the stale refresh token and a password sign-in are all refused.
9. The registry gained **exactly one** record — this account — with every earlier record byte-identical,
   verified with the operator's own key.
10. The restore drill runs the pre-deletion backup with the live registry export
    (`--erasure-registry`, `--expect-erased-present`) and is judged by **content**: the image must have
    contained the erased account, the replay must have removed at least one account and left the image
    `clean`, postcheck and promote-check must pass, and every other account — administrator data included —
    must be unchanged. The only check allowed to fail is the documented cron limitation of §7.

If the Edge Function answers `503 deletion_unavailable` / `deletion_incomplete`, or gives no answer, the
account may be *pending* (writes blocked, data intact). Do not rerun the tool; diagnose from the stage label
and the registry head, as in §6. Nothing here recreates or resets the registry to obtain a green result.
