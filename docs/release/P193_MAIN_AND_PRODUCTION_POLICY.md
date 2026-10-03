# Main and Production policy (P193)

`STATUS=IMPLEMENTED` — the workflow split, the tests, GitHub `main` protection and the Cloudflare change
in §4 were applied and read back. Nothing was released.

## 1. The rule

```text
feature / release branch  ->  PR  ->  required CI  ->  merge to main      (development)
main                      !=  Production release
Production                =   a manual, explicit release of ONE validated main SHA
```

Merging a pull request, or pushing to `main`, never deploys Production. `main` is the integrated
development branch; it may contain work that is not Production-ready (for example migrations 105–114,
which are not applied to the hosted database).

## 2. What enforces it

| Layer | State | How it is checked |
|---|---|---|
| `.github/workflows/ci.yml` | Validates only: `build-and-test`, `db-tests`, `native-checks` on pull requests and on pushes to `main` / `release/**`. No deploy job, no Production or Cloudflare secret. | `tests/config/release-control-plane.test.ts`, `release-pipeline-integration.test.ts` (mutation proofs) |
| `.github/workflows/deploy-production.yml` | One trigger: `workflow_dispatch`. Inputs: `sha` (required, full 40-hex), `dry_run` (default **true**), `backend_ack`. | same tests; the dry run is the only part ever exercised without a release |
| Cloudflare Pages Git integration | Automatic production-branch deployments **disabled** (§4). | read back from the dashboard after the change |
| GitHub `main` protection | PR required (0 approvals), status checks `build-and-test`, `db-tests`, `native-checks`, force pushes and deletion blocked. Admins are **not** forced (§5). | `gh api repos/Oskarhn/pokeportfolio/branches/main/protection` |

## 3. Releasing Production

1. Complete `docs/release/PRODUCTION_RELEASE_CHECKLIST.md` (backup, registry, Auth settings, migrations,
   Edge Functions, secrets) — none of it is automated by the web deploy.
2. Run **Deploy Production** with `dry_run = true` and the SHA. The `verify` job (no secrets, no upload)
   requires that the SHA is a full 40-hex commit, exists, is an ancestor of `origin/main`, and that
   `build-and-test`, `db-tests` and `native-checks` all succeeded on exactly that commit (newest check-run
   per name, read from the GitHub API with the job token). Anything else fails closed.
3. Re-run with `dry_run = false` and `backend_ack = BACKEND-ROLLED-OUT`. The `deploy` job checks out the
   verified SHA, runs the public-configuration guard, builds, scans `dist/`, verifies the build identity,
   uploads with `--commit-hash`, then checks that Production serves exactly that SHA.

The workflow must be dispatched from `main` (a branch cannot dispatch a modified copy).

## 4. Cloudflare Pages (observed and changed in P193)

Project `pokeportfolio-dev` (Git repository `Oskarhn/pokeportfolio`, production branch `main`).

| | Before | After (read back) |
|---|---|---|
| Automatic production deployments | Enabled | **Disabled** |
| Production deployment | `d8682e0`, deployment `ca7d4198` | unchanged, `/build-meta.json` still reports `d8682e0` |
| Deploy hooks | none | none |
| Preview branches | custom include list (left as it was) | unchanged |

The preview-branch setting was not part of the `main != Production` decision and was left alone. The
project and its domain were not touched; the manual path (`wrangler pages deploy` from the workflow)
remains available. Rollback of this setting is the same checkbox under Settings → Builds → Branch control.

## 5. Owner recovery path

`enforce_admins` is `false` on purpose: as the sole maintainer the owner can still push or merge
directly if a check is broken or CI is unavailable. Use it only for CI-config repairs, record it in the
journal, and turn `enforce_admins` on later if a second maintainer joins.

## 6. Credentials found while doing this

The public Actions variable `VITE_SUPABASE_URL` held a secret-shaped value (P192). Both legacy
`VITE_SUPABASE_*` variables were **deleted** in P193 (names only recorded here). Deleting a variable does
not revoke what it contained: whether that credential is still active could not be established without
reading the value, which the session was not permitted to do. Rotation therefore remains an owner action
(`docs/release/PRODUCTION_RELEASE_CHECKLIST.md`, "credentials").
