# Database — current state

Authority: this file for current migration counts and why they diverge; `docs/DATA_MODEL.md` for
schema/ownership/lifecycle rules (unchanged, durable); `docs/DEVELOPMENT.md` for migration process
rules; `docs/RESTORE_RUNBOOK.md` for restore (never a plain `psql` replay).

## Released

**104 migrations**, applied and hosted on `pokeportfolio-dev`, 0 pending. Verified via the
Supabase MCP connector's `list_migrations` (P159) ending at
`20260916121000_p138_sale_idempotency_payload_equivalence`, matching the released `main` tree at
`d8682e0`.

The primary checkout's on-disk `supabase/migrations/` currently shows 102 files — this is because
its local `main` branch is 3 commits **behind** `origin/main` (unfetched, not diverged; see
`HANDOVER.md` §3), not because the released count changed. Always check `origin/main` or a
worktree checked out at `d8682e0`, not the primary checkout's working tree, for the real released
count.

## Local candidates — migration counts genuinely diverge

None of the branches below has integrated another's migrations, so their counts are not
comparable as "the" local state — each is 104 (released) plus whatever that branch alone added:

| Branch | Local count | What it added over 104 |
|---|---|---|
| `fix/p149-auth-refresh-failure-recovery` | 106 | +2, inherited from P148 (not authored by P149 itself) |
| `fix/p151-scanner-reliability-performance` | 104 | +0 (scanner-only change, no schema) |
| `audit/p156-account-deletion-security-recovery` | 107 | +3: `20260920120000_p152_account_deletion.sql`, `20260920140000_p156_pending_deletion_write_barrier.sql`, `20260920150000_p156_purge_verifies_completion.sql` |
| `fix/p157-safe-exact-export-pipeline` | 104 | +0 (export-only change, no schema) |
| `fix/p163-integrated-ci-secret-gate` | 104 | +0 (CI/build-tooling only, no schema) |
| `feat/p173-native-integration-recovered` | 105 | +1: `20260926120000_p173_search_cards_stable_paging.sql` |
| `feat/p175-native-financial-write-flows` | 107 | +2 copied verbatim from the P144 worktree, +1 from P173 (its ancestor) |
| `test/p165-p164-independent-release-verification` | 106 (one measured run) / 104 (a second stack, per the file's own flagged inconsistency) | Independent verification run — see `docs/handover/STATE_RECONCILIATION.md` for the discrepancy note |

**Do not average, sum, or otherwise combine these counts.** If you need a real integrated count,
merge the specific branches you intend to release together and count the result — don't infer it
from this table.

## Decision-ID numbering has also diverged across these branches

`docs/DECISIONS.md` on `main` ends at **D-133**. Several unmerged branches continued the sequence
differently:

- `fix/p157-safe-exact-export-pipeline`: next sequential id, **D-134**.
- `fix/p163-integrated-ci-secret-gate`: **D-163** (prompt-number-as-id).
- `fix/p151-scanner-reliability-performance`: **D-151** (prompt-number-as-id).
- `test/p165-p164-independent-release-verification`: **D-165** (prompt-number-as-id).
- `feat/p173-native-integration-recovered`, `feat/p175-native-financial-write-flows`,
  `design/p174-…`, `fix/p167-…`, `fix/p169-…`: still at **D-133** (added no new decision entry).

Two different conventions (sequential continuation vs. prompt-number-as-id) were used across
parallel branches without coordination. **Whoever integrates these branches must renumber the
decision IDs to avoid collisions** before merging more than one branch that added a decision.
This is a real, unresolved integration hazard, not a documentation artifact — see
`docs/handover/STATE_RECONCILIATION.md`.
