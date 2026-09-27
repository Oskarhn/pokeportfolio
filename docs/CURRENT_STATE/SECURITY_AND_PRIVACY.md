# Security and privacy — current state

Authority: this file for current open findings and account-deletion status;
`docs/SECURITY.md` for the durable trust-boundary model, RLS/invite rules (unchanged).
There is no `docs/PRIVACY.md` yet in this repository — see "Account deletion" below.

## Open findings in the released product

- **P130-19** — client code performs `Number(bigint)` on some money-write paths (`purchases.ts`,
  `sales.ts`, `collection.ts`, `opening.ts`, `profile.ts`, `portfolio.ts` cursor). Confirmed OPEN
  in the released base by P157's explicit re-check. A fix exists on the unmerged
  `fix/p149-auth-refresh-failure-recovery` branch but does not count as closed until merged.
- **P130-08** — no enforced CI/deploy gate. See `docs/CURRENT_STATE/RELEASE_AND_DEPLOYMENT.md`.
- **GitHub Actions variable `VITE_SUPABASE_URL` is secret-key-shaped**, not yet rotated/corrected.
  See `docs/CURRENT_STATE/RELEASE_AND_DEPLOYMENT.md` for the full finding and owner actions.
- **Repository is PUBLIC**, contradicting `CLAUDE.md`. See `docs/CURRENT_STATE/RELEASE_AND_DEPLOYMENT.md`.

## Account deletion — LOCAL ONLY, not released

- Implemented across P152 (initial account-deletion migration,
  `20260920120000_p152_account_deletion.sql`) and P156 (independent security audit + recovery
  fixes: a pending-deletion write barrier and a purge-completion verifier).
- Branch: `audit/p156-account-deletion-security-recovery`,
  SHA `6b3ac90362ea0f992e9223cbda3431e2da5699a5`, 3 new migrations over the 104-migration base.
- **Not merged, not released.** Do not tell a user account deletion is available in the shipped
  product.
- No canonical `docs/PRIVACY.md` exists yet. When this candidate is integrated, promote its
  deletion/retention invariants into a real `docs/PRIVACY.md` and add it to `HANDOVER.md` §16's
  canonical documentation map rather than leaving privacy rules scattered across a feature branch.

## Toolchain / access findings (P159, P160) still relevant

- Stitch MCP access fails authentication ("Incompatible auth server: does not support dynamic
  client registration") — likely an invalid/placeholder API key, not proven. Needs a real key
  registered outside chat before Stitch is usable.
- The Cloudflare MCP connector in this environment has no Pages tools (only
  Workers/D1/KV/R2/Hyperdrive) — Cloudflare Pages settings (production branch, auto-deploy,
  preview policy) cannot be read or changed from any session tool; this must be done by the owner
  directly in the Cloudflare dashboard.
- `docs/toolchain/p159/TOOL_CAPABILITY_MATRIX.md` (in the P159 worktree, not yet merged) has the
  full capability matrix if a future session needs to re-check what's available.
