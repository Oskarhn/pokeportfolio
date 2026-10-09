# P197B — Production account-deletion and restore-safety proof (2026-10-09)

`STATUS=P197B_COMPLETE` · `READY_FOR_P198_FRONTEND_RELEASE=yes` (eligible to begin; **nothing is deployed**) · Production
frontend unchanged (`d8682e047b757f63673a63ac8185a4806d68cb98`) · tooling merged in PR #124 (`8f982ae`) and PR #125
(`6eadd33`), required checks `build-and-test`, `db-tests`, `native-checks` green on both.

Metadata only. No credential, token, key, registry export, backup content, e-mail address or other personal data appears in
this repository. The synthetic account is referred to by the first eight hex characters of its id (`4109f35e`).

## 1. What was proven, and how strongly

| Claim | Evidence | Strength |
|---|---|---|
| One real `delete-account` request for the synthetic **non-admin** account `4109f35e…` returned `200 {"status":"deleted"}` | the owner-operated tool; the account id was matched in full against `--expect-user-id`; profile `is_admin = false` read through RLS with the account's own session | **real, authenticated, Production** |
| The deletion was requested exactly once | one run reached the request; an earlier attempt ended silently at the last prompt **before** any request (independently confirmed: 0 `account_deletion_requests`, 0 requests to the function in the Edge logs, registry unchanged) | verified by independent read |
| Old access token, old refresh token and a fresh password sign-in are refused | Auth `403`, `400`, `400` | real |
| The erasure registry advanced from seq 0 to seq 1, exactly one new record (this account), earlier records untouched | the tool's own before/after export, verified with the operator credentials | real |
| The export's HMAC chain verifies with the Production HMAC key | the key was **replaced once** while the ledger was empty (§2), so its provenance is known by construction; the first real record then verified under it | **real; HMAC provenance now proven** |
| Edge Function → Production Worker append works end to end (URL, append token, HMAC) | the single real append above | **real** |
| A restore of the **exact pre-deletion Production backup** with the **real post-deletion registry** does not resurrect the account | isolated restore drill: erased account present before replay = 1, replay removed it (`replayed=1`, verdict `clean`, no residue in any table), 0 erased accounts after, postcheck stamped clean for the current registry head, promote-check `PROMOTABLE` | **real** |
| Administrator data unchanged | 1 admin profile, 3 purchases, 4 lots in Production after the run and in the restored image | real |
| Production database after | `auth.users` 1; every row of the deleted account absent (sessions, refresh tokens, identities, profile, purchases, lots); `account_erasure_receipts` 1; `account_deletion_requests` 0 (nothing pending); 114 migrations | independent read, Supabase tooling |
| Authenticated read smoke before the deletion | Search returned rows; browser CORS preflight 204; authenticated `search-prices` 200; finance RPCs `get_dashboard_summary`, `portfolio_counts`, `purchase_spending_summary`, `get_holding_value_provenance` succeeded | real |

Pre-deletion backup: `20261008T102641Z` (manifest `complete`, finished 2026-10-08T10:27:54Z, i.e. **before** the deletion; 114
history rows; stamped with the Production project fingerprint; holds the synthetic account). It lives in the private backup
root outside every git checkout, with a hash-identical second copy on another volume of the same PC.

## 2. How the registry credentials were recovered (so the next operator knows)

The Production operator token and HMAC key were not at hand when the proof was due. Recovery rules held throughout: the
ledger was never reset or recreated, the Durable Object and Worker binding were preserved, the append token was never changed,
and nothing secret passed through a chat, a command line or this repository.

1. The original operator token was found in the owner's password manager and authenticated (head/export `200`, seq 0).
2. No HMAC key existed anywhere (it lives only in the Worker). With the ledger **provably empty and stable** (seq 0, 0 records,
   two reads 10 s apart) the owner replaced it once, saved it in the password manager (hidden paste-back), and the tool waited
   15 minutes without contacting the Worker. Measured on the test Worker: a Durable Object that keeps receiving requests keeps
   the old key; it re-reads after about 60 s of silence. **Never replace the key once any record exists.**
3. 40 of the 48 characters of the original operator token were echoed once by a diagnostic. The token was therefore rotated
   (new token saved in the password manager first, hidden paste-back, then stored DPAPI-encrypted for the owner's Windows
   user); the old token is rejected (`401`).
4. A pairing check (`GET /v1/head` with the saved append token: `403` = valid append token on a read route; SHA-256 of the
   Supabase secret compared with the token's) found that the Edge Function secret `ERASURE_REGISTRY_TOKEN` was **not** the
   Worker's append token (the pairing risk open since P195). The owner corrected it in the Supabase dashboard; the check then
   passed without writing to the registry.

Why a wrangler check by a coding-agent session said "authenticated" while the owner's own shell said "not logged in": the
Claude desktop app is an MSIX package, so `%APPDATA%` writes of its processes (the OAuth login) are redirected into the
package store. A login seen by a tool session is not the owner's login; the account guard in the owner's shell was correct.

## 3. Documented limitation and caveats (not hidden)

- **Restore drill 20/21.** The one failing check is `POST_RESTORE_CRON_PRODUCTION_CALLS`: `cron.job` is not part of a backup
  (RESTORE_RUNBOOK §7). Every erasure-gate check passed.
- **Off-machine copies are owner-attested, not independently verified.** The owner states that the pre-deletion backup and the
  proof folder (result file, registry exports before/after, drill log) are stored outside the PC. No session hashed them.
  `p197b-offsite-copy.ps1 -VerifyOnly` (private) can do that when a copy is needed again.
- **Graded/sealed valuation testing with an authenticated session is still outstanding.** The finance read RPCs passed, and the
  owner's "NOK 15" is a *purchase cost* (1500 minor units, known cost basis), not a manual valuation; no valuation test with a
  signed-in session was run.
- The hosted **in-place** restore still cannot be isolated (RESTORE_RUNBOOK §5); provider retention is unchanged
  (`PROVIDER_RETENTION_VERIFIED=no`; free plan, no scheduled backups, no PITR).
- Supabase reports `delete-account` as version 5 with the same artifact hash (`dea079b4…`) as the version rolled out in P197;
  the source is unchanged. No Edge Function, migration or frontend was deployed by P197B.
- The registry now holds one real record. The HMAC key, the operator token and the append token are in the owner's password
  manager; local DPAPI copies of the operator token and the HMAC key exist for the owner-operated tool. None of them may be
  rotated or the ledger reset without the RESTORE_RUNBOOK procedure.

## 4. Follow-ups (operational, none blocks P198)

1. Mark the **old** operator-token entry in the password manager as REVOKED (the token is rejected; keep only the new one).
2. Tool: print a clear "Cancelled — nothing was deleted" message and write the summary file when the final prompt receives
   Ctrl+C (today it exits silently with code 130, which looked like a crash). Backlog item.
3. Keep the proof folder and the registry export off the PC; re-export the registry head after any future deletion.
4. Authenticated graded/sealed valuation test (P198 or a dedicated pass).
5. Provider retention facts and an isolated in-place restore remain owner gates (HANDOVER §12).

## 5. Handoff to P198

P198 = release the current validated `main` frontend. **Not started, not deployed.**

- Use the manual `deploy-production.yml` with the **full SHA** of `main` at that time, CI evidence for that exact SHA, a `dry_run`
  first, then `backend_ack = BACKEND-ROLLED-OUT`. Re-read the Production frontend SHA before and after.
- Production is currently *old web + DB114 + current Edge Functions*; the restore-safe deletion UI ships with the new web.
  Test the web and native deletion surfaces in an isolated pre-release build first. A further real deletion appends to the
  same registry — never as a rehearsal.
- Do not touch the registry, its secrets or the HMAC key; do not delete accounts as part of the release.
- Re-run an authenticated smoke after the release, including the valuation test of §4.4.
