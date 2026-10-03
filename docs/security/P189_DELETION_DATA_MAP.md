# Account deletion — data map (P189)

What "delete my account" removes, what it deliberately leaves, and what a restore does about it.
Derived from `pg_constraint` on a fresh stack (every foreign key to `auth.users`, every `public`
table) — not from a hand-kept list. Three suites keep it honest: `tests/db/p152_account_deletion_graph.test.ts`
(every reference to `auth.users` is accounted for and cascades; a new `public` table fails until it
is classified), `tests/db/p156_cross_user_reference_graph.test.ts` (no cascade or set-null foreign
key crosses from one account into another) and `tests/db/p189_restore_safe_erasure.test.ts` (the
restore replay removes every row listed here).

Classification vocabulary (the prompt's, used as-is):
`ERASE_REQUIRED_BY_PRODUCT_CONTRACT` · `ANONYMIZE` · `TECHNICALLY_REQUIRED` ·
`RETENTION_POLICY_OWNER_DECISION`. Nothing here is a legal retention rule; none was invented. Where
the product contract does not decide, the entry says **OWNER_DECISION_REQUIRED**.

## 1. The contract

Deleting an account removes the login and every application row that belongs to it, in the live
database, before the response says `deleted`. Backups are outside that action (§6) and are made safe
differently: the erasure is recorded off-platform *before* anything is deleted, and a restore must
replay that record before the restored database may serve (`RESTORE_RUNBOOK.md`). The word
"permanently erased from every backup" is not used anywhere, because it is not true and the
application cannot make it true.

## 2. Application tables (`public`)

All rows are matched by the owner column shown. "Purge" = `purge_account_data` (child-first,
batched, completion-verified); "cascade" = the foreign key to `auth.users` with `ON DELETE CASCADE`,
which removes whatever remains when the Auth user is deleted. "Restore replay" = what
`restore_gate_apply` does on a restored image: the same workflow (pending → recorded → purge →
delete the Auth user → scrub), so the behaviour is identical to a live deletion.

| Table | Linkage | Decision | Class | Reason | FK behaviour | Restore replay |
|---|---|---|---|---|---|---|
| `profiles` | `id` = auth id | delete (personal fields nulled by the purge first) | ERASE_REQUIRED_BY_PRODUCT_CONTRACT | display name is free text the person typed | CASCADE | row removed with the auth user |
| `retailers`, `storage_locations`, `tags`, `custom_collections`, `custom_collection_members`, `holding_tags` | `user_id` | delete | ERASE_REQUIRED_BY_PRODUCT_CONTRACT | personal organisation of the portfolio | CASCADE | purged |
| `manual_card_definitions` | `user_id` | delete | ERASE_REQUIRED_BY_PRODUCT_CONTRACT | user-authored card definitions | CASCADE | purged |
| `holdings`, `acquisition_lots`, `openings` | `user_id` | delete | ERASE_REQUIRED_BY_PRODUCT_CONTRACT | the collection itself | CASCADE | purged (opening-linked lots before openings) |
| `purchases`, `purchase_lines` | `user_id` | delete | ERASE_REQUIRED_BY_PRODUCT_CONTRACT | personal financial history | CASCADE | purged |
| `sales`, `sale_lines`, `lot_disposals`, `lot_cost_adjustments` | `user_id` | delete | ERASE_REQUIRED_BY_PRODUCT_CONTRACT | personal financial history (was `NO ACTION` before P152: a user with a sale could not be deleted at all) | CASCADE (changed by P189 migration 1) | purged |
| `manual_valuations` | `user_id` | delete | ERASE_REQUIRED_BY_PRODUCT_CONTRACT | personal valuations | CASCADE | purged |
| `portfolio_snapshots`, `portfolio_recompute_queue` | `user_id` | delete | ERASE_REQUIRED_BY_PRODUCT_CONTRACT | derived from the person's holdings | CASCADE | purged |
| `sealed_products` | `created_by_user_id` | delete the person's **private** definitions only | ERASE_REQUIRED_BY_PRODUCT_CONTRACT | a `NULL` creator means shared catalog; `SET NULL` would publish a private definition, so the key is `CASCADE` | CASCADE; if another account references one, the purge fails closed | purged; shared rows never selected |
| `invitation_redemptions` | `user_id` | delete | ERASE_REQUIRED_BY_PRODUCT_CONTRACT | links the person to the invitation | CASCADE | removed with the auth user |
| `invitations` | the redemption links it to the account | **keep the row, replace `email` with `redacted-<invitation id>@redacted.invalid`, null `label`** | ANONYMIZE | administrative audit record of an action by someone else; the address is personal data | `created_by` is `SET NULL` (an admin deleting their own account keeps their invitations) | same redaction |
| `invitation_claims` | `consumed_user_id` and the invitation | delete | ERASE_REQUIRED_BY_PRODUCT_CONTRACT | holds the address; a live claim would also block re-inviting | CASCADE | deleted |
| `account_deletion_requests` | `user_id` | removed with the account | TECHNICALLY_REQUIRED while pending | the retryable state machine; holds a uuid, counters, stage, `deletion_id`, `registry_state` | CASCADE (no tombstone) | created during replay, then removed |
| `account_erasure_receipts` (P189) | **none** — `deletion_id`, `subject_hash`, `registry_seq`, time | kept | TECHNICALLY_REQUIRED | witness copy of the registry so a restore can see a registry that is older than the backup; no foreign key, no personal data | none | mirrored from the registry during replay |
| `restore_gate_runs` (P189) | none | kept | TECHNICALLY_REQUIRED | operator stamp of a gate run | none | written by `postcheck` |

Not touched, by design: the shared catalog and market data (`card_series`, `card_sets`, `cards`,
`card_variants`, `price_snapshots`, `fx_rates`, `catalog_sync_runs`, `price_sync_runs`,
`portfolio_recompute_runs`, `environment_ingest_config`) and shared (`created_by_user_id IS NULL`)
sealed products. A digest of all of them is asserted unchanged by the deletion suites.

Idempotency and scanner state have no table of their own: purchase/sale/scanner idempotency keys are
columns on the rows listed above and go with them. No scanner image is persisted server-side (the
scanner is on-device; `docs/ARCHITECTURE.md`). Exports are generated on the device and are not stored.

## 3. Supabase Auth (`auth`)

| Data | Decision | Class | Mechanism |
|---|---|---|---|
| `auth.users`, `auth.identities`, `auth.sessions`, `auth.refresh_tokens`, `auth.mfa_*` | delete | ERASE_REQUIRED_BY_PRODUCT_CONTRACT | `auth.admin.deleteUser(id, shouldSoftDelete=false)` (hard delete); the foreign keys cascade. A soft delete keeps a hashed identifier and is not what "delete" promises. |
| `auth.audit_log_entries` | removed **best effort** | RETENTION_POLICY_OWNER_DECISION | `scrub_account_audit_trail` deletes entries naming the account where the platform grants the privilege and returns `-1` where it does not; it never fails a finished deletion. Whether the hosted project writes this table at all is a project setting not known to the repository (§5). **OWNER_DECISION_REQUIRED** |
| Already-issued access tokens | cannot be recalled before expiry | TECHNICALLY_REQUIRED | After deletion every owned table's foreign key refuses a write for that id, and Auth answers `user_not_found`; `tests/db/p152_account_deletion.test.ts` asserts a stale token can neither write nor read anything. |

## 4. Off-platform record (the registry)

One record per erasure, outside every backup: schema version, sequence number, random deletion id,
`subject` = SHA-256 of a namespaced lower-cased account UUID, UTC time, scope version, hash-chain
link and HMAC. **No email, name, financial data, card data, credential or token.** The random Auth
user UUID is sufficient: it is the key every owned row and the login carry, and a 122-bit random
value cannot be enumerated back from its hash. Details and integrity rules: `scripts/restore-gate/erasure-registry.ts`.
It is itself operational data about deletions and is treated as such: minimal fields, append-only,
integrity-checked, never in Git (only synthetic fixtures are), never part of an application backup,
reachable only with an operator-held key. Whether a hash of a deleted account's id is personal data
under the owner's jurisdiction is a legal question this repository does not answer —
**OWNER_DECISION_REQUIRED** (§7).

## 5. Client-side state removed at deletion

Web: the per-account export-reminder timestamp is removed; the Supabase session is ended; the theme
choice is a device preference and stays. Native: the session in SecureStore, the identity-scoped
query/cache stores, the P180 pending-write journal and scanner/photo transient state are cleared in
the same step (`apps/mobile-spike`, native deletion flow).

## 6. What deletion does not reach (stated, never promised away)

| Where | Fact | Source class |
|---|---|---|
| Provider database backups | Supabase documents daily backups (Pro: last 7 days; Team: 14; Enterprise: up to 30) and, as an add-on, point-in-time recovery; projects are restored **in place** and are inaccessible while it runs. Whether this project is on a plan with backups or PITR, and its retention, is not known to the repository. | OFFICIAL_PROVIDER_BEHAVIOR (docs fetched 2026-10-02: <https://supabase.com/docs/guides/platform/backups>); **project plan: VERIFIED_PROJECT_SETTING — the only Supabase organization on the account is on the `free` plan** (read-only `get_organization`, 2026-10-02). The retention table in the documentation lists daily backups only for Pro, Team and Enterprise and the page does not say what the free plan includes, so whether the hosted project has any provider backup is UNKNOWN_OWNER_SETTING (dashboard); the backups this repository knows about are the operator's own `pnpm db:backup` files |
| Provider logs | "Retention depends on your pricing plan"; no auth-log retention is stated. | OFFICIAL_PROVIDER_BEHAVIOR (<https://supabase.com/docs/guides/platform/logs>); project value UNKNOWN_OWNER_SETTING |
| Operator-made backups (`pnpm db:backup`) | Private files outside Git; not rewritten by a deletion; protected only by the restore gate. Their retention is the operator's. | RETENTION_POLICY_OWNER_DECISION — **OWNER_DECISION_REQUIRED** |
| Cloudflare (hosting/analytics) | Request logs and aggregate analytics under Cloudflare's own rules; no user data is stored there by the application. | UNKNOWN_OWNER_SETTING |
| Files the person exported | On their device. | — |

No retention period appears in the product, the public page or this file as a promise.

## 7. Owner decisions this map cannot make

1. Whether the registry's hashed subject is acceptable personal-data handling, and how long a record
   is kept (a record can never be dropped while any backup older than the erasure may exist).
2. Where the production registry lives (must be outside backups, separately backed up, append-only
   for the function's credential) — `COST_POLICY.md` applies.
3. Operator backup retention; Auth audit-log table writes (switch off in the dashboard or accept the
   best-effort scrub); provider backup/PITR/log settings of the hosted project.
4. The completion time promised for an emailed deletion request (none is promised today).
5. Whether a support contact other than the one already published on the Privacy page should exist.
