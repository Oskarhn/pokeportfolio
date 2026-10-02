# Security and privacy — current state

Authority: this file for current open findings and account-deletion status;
`docs/SECURITY.md` for the durable trust-boundary model, RLS/invite rules (unchanged);
`docs/release/P188_INTEGRATION_MATRIX.md` §8 for the P130 findings relevant to the release.
There is no `docs/PRIVACY.md` in this repository yet — see "Account deletion" below.

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

## Account deletion — LOCAL ONLY, kept separate, NOT in the P188 candidate

- P152 + P156, branch `audit/p156-account-deletion-security-recovery`, SHA `6b3ac903…`, 3 migrations
  over the 104 base. **Classified `UNSAFE_OR_UNRESOLVED`** (matrix §4): a restore of a pre-deletion
  backup resurrects the deleted account (reproduced); the mitigation is an owner-kept off-backup
  erasure registry plus a promotion gate that P188 does not have; the public deletion URL and the
  hosted retention facts are owner decisions.
- Do not tell a user account deletion exists. The native app has no in-app deletion, which blocks
  store distribution (`docs/mobile/BUILD_CONFIGURATION_PROFILES.md` §4).
- When integrated, promote its invariants into a real `docs/PRIVACY.md` and add the three migrations
  after `20260926120000`.

## Toolchain / access findings (P159, P160) still relevant

- Stitch MCP access fails authentication (no dynamic client registration) — needs a real key
  registered outside chat.
- The Cloudflare MCP connector has no Pages tools; Pages settings must be changed by the owner in the
  dashboard.
- `docs/toolchain/p159/TOOL_CAPABILITY_MATRIX.md` exists only on `docs/p159-toolchain-audit`.
