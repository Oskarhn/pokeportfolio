# Security and privacy — current state

Authority: this file for current open findings and account-deletion status;
`docs/SECURITY.md` for the durable trust-boundary model, RLS/invite rules (unchanged);
`docs/release/P188_INTEGRATION_MATRIX.md` §8 for the P130 findings relevant to the release.
There is no `docs/PRIVACY.md` in this repository yet; the deletion data scope is `docs/security/P189_DELETION_DATA_MAP.md`.

## Open findings in the RELEASED product (Production, `d8682e0`)

- **P130-19** — client `Number(bigint)` on money-write paths. **Fixed in the P188 candidate** (P146/P149
  via the P164 merge); still OPEN in Production until that line is released.
- **P130-08** — no enforced CI/deploy gate. The gated job is **in the P188 candidate**; closed only
  after the owner's Cloudflare action and secrets. `docs/CURRENT_STATE/RELEASE_AND_DEPLOYMENT.md`.
- **GitHub Actions variable `VITE_SUPABASE_URL` is secret-key-shaped**, not yet rotated/corrected.
- **Repository is PUBLIC**, contradicting `CLAUDE.md`. 24 remote branches on it carry
  attribution trailers in their commit messages (matrix §6); unchanged and not rewritten.

## P130 items taken up in P191 (development RC, PR #113)

Record: [docs/security/P191_SECURITY_BOUNDARY_CLOSURE.md](../security/P191_SECURITY_BOUNDARY_CLOSURE.md); decision D-191.
Code-side only — none of it is in Production, and the hosted database still has 104 migrations.

- **P130-13** direct-edit ledger grants — **CLOSED in the RC**: a write gate trigger on the five ledger
  tables refuses direct client writes; ten INVOKER writers announce themselves; grants unchanged.
- **P130-14** private `sealed_products` id oracle / pin — **CLOSED in the RC** (ownership trigger; `id`
  no longer client-insertable).
- **P130-20** password change — **OWNER_ACTION_REQUIRED**: local `secure_password_change = true`, tested;
  enable it (and "require current password") on the hosted project.
- **P130-26** raw technical errors — **CLOSED** (closed vocabulary; static audits web + native).
- **P130-29/-30** CI and model supply chain — **PARTIALLY_CLOSED**: runners/pnpm pinned, bounded model
  download, Android ONNX runtime was floating (`latest.integration`) and is pinned, `onnxruntime-node`
  NuGet install stopped; no upstream attestation, Supabase images/Playwright browsers version-pinned only.
- **P130-36** advisories — reviewed; none reachable in a shipped artefact.
- **P130-09** — **CLOSED**: all typed-input forms defer an automatic reload.

## Account deletion — restore-safe (P189), proven in Production (P197B), supersedes P156

- **P197B (2026-10-09):** one real Production deletion of a synthetic non-admin account passed every proof (200 deleted; stale tokens and re-login refused; registry seq 0 → 1 with a verified HMAC chain; restore of the pre-deletion backup with the live registry replays the erasure, `PROMOTABLE`; drill 20/21 with only the documented cron limitation). `PRODUCTION_REGISTRY_STORAGE_READY=yes`. Still open: provider retention facts, the in-place-restore plan, off-machine copies are owner-attested only. Record: [`docs/release/P197B_PRODUCTION_DELETION_PROOF.md`](../release/P197B_PRODUCTION_DELETION_PROOF.md).

- **P189** (`security/p189-restore-safe-account-deletion`, on the exact P188 candidate) integrates the
  P152/P156 deletion work *selectively* and closes the restore resurrection: the erasure is recorded in
  an off-backup registry **before** anything is destroyed (enforced by the database), a restored database
  must pass the erasure gate before it serves, web and native call one backend contract, and a public
  `/account-deletion` page exists. Record: [`docs/release/P189_ACCOUNT_DELETION.md`](../release/P189_ACCOUNT_DELETION.md);
  decision D-189; operator procedure [`docs/security/RESTORE_RUNBOOK.md`](../security/RESTORE_RUNBOOK.md);
  data scope [`docs/security/P189_DELETION_DATA_MAP.md`](../security/P189_DELETION_DATA_MAP.md).
  `audit/p156-account-deletion-security-recovery` is `SUPERSEDED_BY_P189` (kept as evidence, not merged).
- **Still owner decisions / gates, stated rather than hidden:** where the production registry lives and
  its credentials (`PRODUCTION_REGISTRY_STORAGE_READY=yes` since P197B — a missing or mismatched credential still refuses every deletion);
  the hosted project's backup/PITR/log settings (`PROVIDER_RETENTION_VERIFIED=no`); the hosted
  **in-place restore** cannot be isolated, so the runbook's two options need an owner choice; the
  completion time of an e-mailed deletion request; whether a hash of a deleted account id is acceptable
  personal-data handling. None of these is invented or promised in the product copy.
- (Historical, P189) not deployed, not pushed, hosted database untouched. Since then the four P189 migrations
  (`20261002120000`…`20261002130000`) were applied to Production by P197; the in-app deletion UI is still not released.

## Toolchain / access findings (P159, P160) still relevant

- Stitch MCP access fails authentication (no dynamic client registration) — needs a real key
  registered outside chat.
- The Cloudflare MCP connector has no Pages tools; Pages settings must be changed by the owner in the
  dashboard.
- `docs/toolchain/p159/TOOL_CAPABILITY_MATRIX.md` exists only on `docs/p159-toolchain-audit`.
