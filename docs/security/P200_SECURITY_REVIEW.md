# P200 / P206 — security, privacy and authorization review

Engineering record of the P200 audit (authorization, sessions, tooling, dependencies, request bounds)
and its completion in P206. Facts are labelled by how they were established; nothing here describes a
Production change, because none was made.

Status labels: **fixed** (code merged-ready in a PR, not deployed), **pinned** (a test records a known
property), **owner decision** (a hosted setting or a product policy that code must not invent).

## 1. Scope and method

All database work ran on an isolated local Supabase stack. Hosted systems were only read: public
`GET /build-meta.json`, response headers, `gh api` reads of repository settings, `pnpm audit`. No
migration, Edge Function deployment, registry operation, credential change or account deletion was
performed against Production.

## 2. Authorization matrix (verified on a local database, at 114 and at 118 migrations)

`tests/authorization/p200_cross_tenant_matrix.test.ts` is **catalog-driven**: it reads `pg_class` and
`pg_proc`, so a new table or a newly browser-callable function fails it until someone classifies it.

| Property | Result |
|---|---|
| Every table in `public` has RLS enabled | yes, 37 tables (+ `price_sync_attempts` once P201 lands, server-only) |
| `anon` has any table grant | none; `anon` executes only `invitation_status` |
| Every write policy has `WITH CHECK` | yes |
| Tenant B against tenant A on every user-owned table | no read, update, delete, forged insert or owner reassignment |
| 14 id-taking write RPCs aimed at A's ids | all refused; A byte-identical afterwards; errors name nothing of A (`clear_manual_valuation` is an owner-scoped no-op) |
| Aggregate RPCs for an empty tenant | reveal none of A's data |
| Server-only tables (`invitation_claims`, `account_erasure_receipts`, …) | unreachable for `anon`, `authenticated` and the administrator |
| `SECURITY DEFINER` functions (44) | all pin an empty `search_path`; none browser-reachable takes an actor id |
| Administrator forged via profile update, `user_metadata`, forged or `alg=none` JWT | refused |
| Views | `security_invoker`; Realtime publication empty; no storage buckets |

Sessions (`tests/authorization/p200_sessions.test.ts`): expired and malformed bearer tokens are refused
(the expiry case is **skipped, not passed**, if a stack's JWT secret differs from the default and the
control token is refused); a rotated-away refresh token is refused; global sign-out ends every refresh
chain; a revoked session is refused by `delete-account`; a deleted account's tokens are refused.

**Pinned properties (tests record them as known, they are not defects fixed here):**

- **Access tokens outlive sign-out.** An issued access token keeps working at the Data API until it
  expires (`jwt_expiry = 3600`). `delete-account` re-resolves the token against Auth, so the destructive
  path is safe; reads and ordinary writes of the signed-out account remain possible for up to an hour.
- **Refresh rotation tolerance.** Measured locally: replaying the direct parent of the newest refresh
  token is tolerated (`refresh_token_reuse_interval = 10`), and a refused older replay did not revoke the
  newest token. That is GoTrue behaviour; re-check it on the hosted project before relying on it.

## 3. Findings and where each is fixed

| # | Finding | Severity | Resolution |
|---|---|---|---|
| F1 | Service-role tests, campaigns and benchmarks had no check that their target is local; `docs/DEVELOPMENT.md` even allowed "a throwaway/dev project" although the only hosted project is Production | P2 | **fixed**: one canonical guard, `scripts/lib/local-target.mjs` (docs/TESTING.md §9.1). P200's and P203's independent guards were reconciled into it |
| F2 | Public `redeem-invitation` read an unbounded body, and JSON `null`/number/array reached `body.token` (HTTP 500) | P3 | **fixed**: 4 KiB bound (413), non-object JSON → 400. **Needs an Edge Function redeploy (not done)** |
| F3 | `seroval < 1.6.3` and `source-map-js < 1.2.2` reachable through the router and Tailwind | P3 | **fixed**: caret-bounded `pnpm.overrides`; lockfile delta is exactly those two packages |
| F4 | Ctrl+C in the owner deletion-proof tool was silent, so "cancelled before the request" and "request sent, outcome unknown" looked alike | P3 | **fixed**: three phases, fixed output, exit 130; never advises a rerun after the request left |
| F5 | `scripts/lib/psql-exec.mjs` checked `DB_URL` only on its docker fallback and echoed the URL (password included) in the error | P3 | **fixed** in the F1 change |
| F6 | Three scripts guarded themselves with a regex that a userinfo form (`http://localhost:80@evil.example`) passes | P3 | **fixed** in the F1 change |

Production dependency audit after the change: 6 → 4 advisories. Remaining: `sharp` ×3 and `sprintf-js`,
all under `@huggingface/transformers` (Node-side lab scripts only). Verified: the built bundle contains no
`sharp` module (the only string match is the UI copy "sharper photo"). They are **not** overridden:
forcing `sharp ≥ 0.35.5` would change image decoding beneath the pinned scanner-index content id.
Development-only advisories (`fast-uri` via `vite-plugin-pwa`, `brace-expansion` via ESLint, `undici` via
`wrangler`, `vitest`) execute on the developer machine or CI against trusted input and are not shipped.

## 4. Owner decisions and follow-ups

None of these was changed. Each is written so the owner can act without re-research.

### D1 — GitHub secret scanning, push protection, Dependabot security updates

Observed (2026-10-10, `gh api`): all disabled; the repository is public, where they are free. Gitleaks
in CI runs **after** a push and scans every ref (a single bad commit on any branch fails every run).
Push protection blocks the secret **before** it reaches the remote. *Action:* Settings → Code security →
enable secret scanning, push protection, Dependabot security updates. *Watch for:* push protection will
block a test fixture that looks like a provider token; fixtures are assembled at run time for that
reason (`tests/ops/release-evidence.test.ts`).

### D2 — Production deployment environment approval

Observed: no GitHub `environment` exists. `deploy-production.yml` is gated by `workflow_dispatch`,
a dry-run default, SHA/CI verification and a typed `backend_ack`. A compromised maintainer token or
a mis-click still reaches Production without a second person or a second factor. *Action:* create a
`production` environment with a required reviewer, move the deploy secrets into it, add
`environment: production` to the deploy job. With one maintainer, "reviewer = the owner" still adds a
deliberate second step and an audit entry.

### D3 — Revoked access-token lifetime (`jwt_expiry`)

Observed: `supabase/config.toml` says 3600 s; the hosted value was not read. A revoked or signed-out
session's access token works at the Data API until it expires (§2). *Action (hosted setting):*
Dashboard → Authentication → JWT expiry. 900 s bounds the window to 15 minutes at the cost of a refresh
roughly every 15 minutes from supabase-js (already automatic). No code change is needed.

### D4 — Last administrator can delete their own account (product decision)

Observed: `DeleteAccountSection.tsx` warns, the server does not check; invitations then cannot be
created. Options, with consequences — **no policy is chosen here**:

1. Server guard in `begin_account_deletion`: refuse (`last_admin`) while the caller is the only
   `is_admin` profile. Smallest; needs a migration, an Edge Function mapping and a UI message.
2. Require an explicit hand-over (promote another account first). Same guard, plus an admin-promotion
   path the product does not have today.
3. Accept and document a break-glass: the owner re-creates an administrator with the service role.

### D5 — Bounds on arrays and request bodies

Observed: `create_purchase`, `update_purchase`, `create_sale`, `create_opening` and
`remove_holdings_from_portfolio` compute `jsonb_array_length` / `array_length` but cap neither; the
practical bound is the PostgREST statement timeout. `sync-catalog` and `ingest-prices` authenticate
**before** reading the body (not exposed); `fetch-fx-rate` and `search-prices` require a JWT but call
`request.json()` unbounded. *Action:* choose product caps (the largest realistic purchase or sale), add a
`raise exception` on the line count in each RPC, and reuse `_shared/bounded-body.ts` in the two
JWT-protected functions (`cardIds` also needs an element cap). Needs the caps from the owner.

### D6 — Cloudflare automatic production deployments

Not read (it lives in the Cloudflare dashboard). Evidence it is off: Production kept serving `d8682e0`
while `main` moved on by hundreds of commits (P200, P193). *Action:* Workers & Pages → project →
Settings → Builds → confirm no Git-connected production branch deploys on push; afterwards compare
`/build-meta.json` with `main` after a merge.

### D7 — Redeploy `redeem-invitation`

The F2 fix is in the repository only. It takes effect after the owner deploys the function (no
migration). Until then Production still reads an unbounded body and can return 500 for `null`.

## 5. What was not covered

Playwright/E2E was not re-run for these changes beyond CI; no screen-reader, real-device or hosted
verification; Windows Ctrl+C delivery is test-covered only where the runner's process tree has Ctrl+C
enabled (the test skips otherwise, and says so).
