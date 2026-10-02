# P189 — restore-safe account deletion (local integration candidate)

`STATUS=SUCCESS_P189_RESTORE_SAFE_ACCOUNT_DELETION` · local only, not pushed (the repository is
**PUBLIC**; `GIT_WORKFLOW.md` §13) · not merged · not deployed · hosted database untouched.

Built on the exact P188 candidate `2783c93e4ebc54a70b6678b6dc76ff848c2793b3`. Decision record: D-189
(`docs/DECISIONS.md`). Operator procedure: [`docs/security/RESTORE_RUNBOOK.md`](../security/RESTORE_RUNBOOK.md).
Data scope: [`docs/security/P189_DELETION_DATA_MAP.md`](../security/P189_DELETION_DATA_MAP.md).

## 1. What was wrong, reproduced first

With the P152/P156 deletion code on the P188 tree and nothing else changed: synthetic users A and B with a
full ledger (holdings, purchase with lines, sale with disposals and cost adjustment, opening, manual
valuation, tags/collections/retailers/storage, a private sealed product, snapshot and recompute queue);
a real `pg_dump -Fc` of the whole database (auth schema included) while A existed; A deleted through the
deployed `delete-account` function (200, every owned table 0 in the live database); the old dump restored
into a second database. **`RESURRECTION_REPRODUCED=yes`**: `auth.users` 1, `auth.identities` 1 and all 22
account-owning `public` tables (`retailers, storage_locations, tags, purchases, purchase_lines, holdings,
acquisition_lots, manual_card_definitions, holding_tags, manual_valuations, custom_collections,
custom_collection_members, sales, sale_lines, lot_disposals, lot_cost_adjustments, openings,
sealed_products, portfolio_snapshots, portfolio_recompute_queue, invitation_redemptions, profiles`) came back.
`tests/db/p189_restore_safe_erasure.test.ts` § R0 keeps the reproduction as a permanent test.

## 2. P156 audit — every change classified

P156 is `6b3ac90362ea0f992e9223cbda3431e2da5699a5` (branch `audit/p156-account-deletion-security-recovery`),
13 commits on `d8682e0` including the P152 base. **Not merged; none of its history was imported**
(`P156_WHOLESALE_MERGED=no`). Code was taken by path; the migrations were re-timestamped after the
P188 chain (`20261002120000/10/20`) because none was ever applied anywhere, then P189's own migration
(`20261002130000`) was appended. 53 files changed in P156; classification:

| P156 change | Class | What P189 did |
|---|---|---|
| `delete-account` Edge Function, `_shared/account-deletion.ts` (authenticate → intent → password → begin → purge → Auth delete) | `NEEDS_MODIFICATION` | kept; registry step added between `begin` and `purge`, new closed error vocabulary (`deletion_unavailable`, stage `registry`) |
| `20260920120000_p152_account_deletion.sql` (cascade fix for 5 `NO ACTION` keys, pending table, insert guard, `begin`/`purge`/`scrub`, supporting index) | `SAFE_AND_STILL_REQUIRED` | imported verbatim, re-timestamped |
| `20260920140000_p156_pending_deletion_write_barrier.sql` (31 of 38 writes succeeded for a pending identity) | `SAFE_AND_STILL_REQUIRED` | imported verbatim, re-timestamped |
| `20260920150000_p156_purge_verifies_completion.sql` (ctid-skip reported `complete`) | `SAFE_AND_STILL_REQUIRED` | imported verbatim, re-timestamped |
| OAuth/MFA accounts refused (`reauthentication_unsupported`), bounded body read, honest lost-answer copy | `SAFE_AND_STILL_REQUIRED` | kept |
| `scripts/restore-gate/check-restore-erasures.ts`, `erasure-registry*.ts` (undated list of SHA-256, a refuse-only gate, owner appends by hand) | `SUPERSEDED` | replaced by the signed registry, the write contract, the replay (`apply`) and the stamp/`promote-check` flow |
| `tests/db/p156_restore_resurrection.test.ts`, `tests/ops/restore-erasure-gate.test.ts` | `SUPERSEDED` | replaced by `p189_restore_safe_erasure.test.ts`, `tests/ops/erasure-registry.test.ts`, `tests/ops/restore-gate.test.ts` |
| P152/P156 suites (`p152_*`, `p156_pending_write_barrier`, `p156_cross_user_reference_graph`, `p156_purge_concurrent_update`, `p156_deletion_*`, trust boundary, grants) | `SAFE_AND_STILL_REQUIRED` | imported; adapted to the recorded-erasure contract (`beginRecorded`) and the lease-based client |
| `src/data/account-deletion.ts` (client on `supabase.auth`) | `NEEDS_MODIFICATION` | rewritten on the P149 identity lease (`LeasedDb`); lost-answer probe via Auth `user_not_found` only |
| `DeleteAccountSection.tsx`, `account-deleted-notice.ts`, Login notice | `NEEDS_MODIFICATION` | rebuilt on `useLeasedMutation`; cleanup inside the mutation (a lease callback is skipped once the session ends) |
| `PrivacyPage.tsx` rewrite, `docs/PRIVACY.md`, `PRIVACY_POLICY_DRAFT.md`, Apple/Google worksheets | `NEEDS_MODIFICATION` / not imported | Privacy page corrected (deletion + on-device storage); the drafts/worksheets assert unverified provider and controller facts and stay on the P156 branch |
| `docs/prototypes/account-deletion-request.html` (unpublished, bracketed owner fields) | `SUPERSEDED` | replaced by the real `/account-deletion` route |
| `.gitleaks.toml` entry for the local default JWT secret | `SAFE_AND_STILL_REQUIRED` | imported (the attack tests forge local tokens) |
| P156's "owner appends to the registry by hand" operating model | `UNSAFE_DO_NOT_INTEGRATE` | a deletion nobody recorded was invisible to the gate; recording is now part of the deletion itself |
| `HANDOVER.md`/`CLAUDE.md` edits on P156 | n/a | not imported; this branch updates them itself |

## 3. What was built

- **Database** (`20261002130000_p189_restore_safe_erasure.sql`): `erasure_subject_hash`, request state
  (`deletion_id`, `registry_state`, `registry_seq`, stage `registry_failed`), `account_erasure_receipts`,
  `prepare/record_account_erasure`, operator-only `abort_account_deletion`, a purge that refuses before the
  record exists, and the operator-only `restore_gate_*` functions (scan, check, apply, postcheck) plus
  `restore_gate_runs`. Migrations: **111** (107 + 4), no duplicate timestamps.
- **Registry and gate** (`scripts/restore-gate/`): signed registry format and strict parser, file-backed
  sink (HTTP contract v1), `restore-gate` CLI (`verify`, `apply`, `postcheck`, `promote-check`, `find`,
  `add`, `keygen`; `--dry-run`, `--json`, exit codes 0–6), restore-drill integration (the drill fails
  unless the gate ran).
- **Edge function**: `loadSinkConfig`/`appendErasure` (https required except loopback/Docker host; only a
  confirmed record for the very record sent counts), registry step in the state machine.
- **Web**: `/account-deletion` public page (robots/sitemap/footer/analytics list updated), Profile →
  Delete account on the identity lease, Privacy page corrected.
- **Native**: Profile → Delete account (`DeleteAccountPanel`), `AccountDeletionController` on the same
  contract, journal `clearForUser`, `TextField` gained a masked mode.
- **Tests, CI**: see §4. CI generates ephemeral registry credentials and the DB/E2E jobs start the sink.

## 4. Verification (all local; commands in `docs/TESTING.md` §6g)

Filled from the closing run — see `ai_outputs/Claude_outputs/output_189.txt` for the exact counts.

## 5. Readiness

| Gate | State |
|---|---|
| `PUBLIC_DELETION_INFO_PAGE_READY` | **yes** (page built and verified; not deployed, URL not final until deployed) |
| `WEB_IN_APP_DELETE_READY` | **yes** locally (real browser + real stack) |
| `NATIVE_IN_APP_DELETE_READY` | **yes** locally (unit + emulator smoke, see the output file) |
| `RESTORE_SAFE_ERASURE_READY` | **yes** locally: backup → delete → restore → registry replay → verified, repeatedly |
| `PRODUCTION_REGISTRY_STORAGE_READY` | **no — owner decision** (where, credentials, append-only, separate backup) |
| `PROVIDER_RETENTION_VERIFIED` | **no — owner/hosted settings** (documentation facts only) |

## 6. Known limits and warnings

1. **Hosted in-place restore** cannot be isolated (provider documentation); the runbook gives the two
   options and marks them owner decisions. The gate protects only databases that are put through it.
2. The registry's tail truncation is detected only through the database witness and `--expect-head-seq`.
3. **CI wiring is unverified until a first CI run**: the sink address on a Linux runner
   (`172.17.0.1`) and the new steps are static-checked and exercised locally via the same commands.
4. A pre-existing P137 drill limit: `cron.job` is not captured by a backup and is only recreated by
   replaying migrations the backup lacks, so the drill's cron check fails on an already-current backup;
   every other drill check passes. Not changed.
5. `restore_gate_runs` regains `service_role` access whenever the privilege baseline is re-applied
   (it grants service_role every table); a stamp never authorises promotion alone.
6. The native native-API (`delete-account`) smoke on the emulator uses the local stack only.
