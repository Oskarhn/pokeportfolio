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

## Still OPEN in the P188 candidate (release-relevant, owner/design decisions)

- **P130-13** direct-edit grants on ledger columns (`quantity_remaining`, frozen basis, residual,
  purchase totals) — the writing functions are `SECURITY INVOKER`, so revoking breaks them.
- **P130-14** private `sealed_products` id existence/deletion pin by another user — needs a trigger.
- **P130-20** `secure_password_change` is still `false` locally and unverified on the hosted project
  (the client-side identity check of D-139 is in).
- **P130-26** raw technical errors in financial forms; **P130-09** Add card / Add sealed / Openings
  wizard are not registered with the unsaved-work registry.
- **P130-29/-30** mutable action tags and `gitleaks:latest`; the model download has no timeout and
  `onnxruntime-node`'s NuGet download is unverified (the model itself is SHA-256 pinned).

## Account deletion — restore-safe, LOCAL ONLY (P189), supersedes P156

- **P189** (`security/p189-restore-safe-account-deletion`, on the exact P188 candidate) integrates the
  P152/P156 deletion work *selectively* and closes the restore resurrection: the erasure is recorded in
  an off-backup registry **before** anything is destroyed (enforced by the database), a restored database
  must pass the erasure gate before it serves, web and native call one backend contract, and a public
  `/account-deletion` page exists. Record: [`docs/release/P189_ACCOUNT_DELETION.md`](../release/P189_ACCOUNT_DELETION.md);
  decision D-189; operator procedure [`docs/security/RESTORE_RUNBOOK.md`](../security/RESTORE_RUNBOOK.md);
  data scope [`docs/security/P189_DELETION_DATA_MAP.md`](../security/P189_DELETION_DATA_MAP.md).
  `audit/p156-account-deletion-security-recovery` is `SUPERSEDED_BY_P189` (kept as evidence, not merged).
- **Still owner decisions / gates, stated rather than hidden:** where the production registry lives and
  its credentials (`PRODUCTION_REGISTRY_STORAGE_READY=no` — without them every deletion is refused);
  the hosted project's backup/PITR/log settings (`PROVIDER_RETENTION_VERIFIED=no`); the hosted
  **in-place restore** cannot be isolated, so the runbook's two options need an owner choice; the
  completion time of an e-mailed deletion request; whether a hash of a deleted account id is acceptable
  personal-data handling. None of these is invented or promised in the product copy.
- Not deployed, not pushed (the repository is PUBLIC), hosted database untouched. The four P189
  migrations (`20261002120000`…`20261002130000`) follow `20260926120000`.

## Toolchain / access findings (P159, P160) still relevant

- Stitch MCP access fails authentication (no dynamic client registration) — needs a real key
  registered outside chat.
- The Cloudflare MCP connector has no Pages tools; Pages settings must be changed by the owner in the
  dashboard.
- `docs/toolchain/p159/TOOL_CAPABILITY_MATRIX.md` exists only on `docs/p159-toolchain-audit`.
