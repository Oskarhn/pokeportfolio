# Git publication plan

Authority: this file for what is and is not safe to push given repository visibility, the
candidate lineage, and the GitHub settings recommended before publication.
`docs/GIT_WORKFLOW.md` for the durable branch/PR/CI conventions (unchanged).
`docs/CURRENT_STATE/BRANCH_PRUNING_PLAN.md` for the branch-by-branch classification;
`docs/release/P188_INTEGRATION_MATRIX.md` for what the candidate contains and why.

**This is a plan, not an action.** Nothing here pushes, closes, deletes or reconfigures anything.
Figures were verified live on 2026-10-02 (P188) with read-only `gh` calls; re-verify before acting.

## 1. Current repository state (live-verified 2026-10-02)

| Fact | Value |
|---|---|
| Visibility | **PUBLIC** — contradicts `CLAUDE.md`'s hard rule; unchanged since first observed (2026-09-27) |
| Default branch | `main`; `origin/main` = `d8682e047b757f63673a63ac8185a4806d68cb98` (released, = Production) |
| Branch protection on `main` | none |
| Repository rulesets | none |
| Open PRs | 30 (PR #112 is draft, OPEN, MERGEABLE: `fix/p142-ci-gated-production-deploy`) |
| Remote branches | 67 |
| Newest workflow run | 2026-09-18 (PR #112, `db-tests` failure). **No run since**, so Actions capacity is still unverified, not blocked or resolved |

**PR #112 is `SUPERSEDED_BY_P163`.** P163 integrates the P142 workflow it carries and the P160
guard, and P188 contains P163. Do not merge #112 and do not close it from a session; closing or
re-pointing it is the owner's call once the P188 line replaces it.

## 2. The release-candidate line (local, not pushed)

```
d8682e0 (released main, 104 migrations)
  └─ … native lineage P173 → P175 → P177 → P178 → P179 → P180 → P181 → P182 → P184 → P185 → P186 (3fac34f)
        └─ P187 iOS readiness, rebuilt without its attribution trailer (tree-identical to 79c447d)
            ├─ merge P164  (P143/145/146/147/148/149 auth + exact money, P151, P153/P161 Price Check, P157/P162 exports)
            ├─ merge P163  (P142 deploy gate + P160 secret guard)
            ├─ merge P165  (verification fixes for the P164 seams)
            └─ P188 changes: build profiles, feature-branch CI trigger, comment rewording, documentation
                 = release/p188-cross-platform-rc   (107 migrations; LOCAL_RC; see docs/release/P188_RELEASE_CANDIDATE.md)
```

Kept **out** of the line on purpose: `audit/p156-account-deletion-security-recovery` (restore
resurrection and public deletion URL are unresolved owner decisions; matrix §4). Design-only and
documentation-only branches stay where they are.

## 3. What must not be pushed while the repository is PUBLIC

Any branch carrying unreleased project source. That includes the P188 branch (it contains the
deployment-gate and secret-guard work, whose publication is itself a security-relevant disclosure),
the native lineage, and the account-deletion audit. **P188 is therefore not pushed.** The publication
step in the P188 prompt is conditional on the owner having made the repository private; it was
re-checked at the end of the session (see `docs/release/P188_RELEASE_CANDIDATE.md` §7).

## 4. When the repository is private: how to publish the candidate

1. Push **only** `release/p188-cross-platform-rc` (no `main`, no force, no old P17x/P18x branches).
2. `.github/workflows/ci.yml` now triggers on pushes to `release/**` as well as pull requests, so the
   push itself starts `build-and-test` and `db-tests`. The `deploy-production` job is restricted to
   a push to `refs/heads/main` and needs no Production secret on this branch; the validation jobs read
   none.
3. Watch that run's own result. If a job fails, classify it (real code failure, workflow defect,
   expected missing secret, billing/capacity, transient) before changing anything; never weaken a
   required gate to get green.
4. Open a PR into `main` only after the run is green. Merge is squash, per `GIT_WORKFLOW.md`.

## 5. Recommended GitHub settings (NOT applied — owner action)

Read-only observation today: no protection, no rulesets. Recommended, in this order:

1. **Make the repository private** (Settings → General → Danger Zone) — before anything in §4.
2. A ruleset or branch protection on `main`: require a pull request; require status checks
   `build-and-test` and `db-tests` (strict: branch up to date); block force pushes and deletion;
   optionally require conversation resolution. Do not allow bypass for admins.
3. Delete the stale `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` **variables**, create the
   four secrets in `docs/security/RELEASE_PREFLIGHT_P163.md` Part A, and rotate the key implicated by
   the secret-shaped variable value (P159/P160 S-1).
4. Cloudflare Pages: turn off the Git-integrated automatic deploy and preview builds against the
   Production Supabase project, so the gated job is the only path (P130-08).
5. Check Actions minutes / billing so the first run is not refused for capacity.

## 6. What must pass before a `main` merge

Unchanged (`GIT_WORKFLOW.md` §1/§2/§4/§11): CI green on both jobs, a reviewed diff, no secrets.
A merge of the P188 line additionally needs the owner decisions in
`docs/release/P188_RELEASE_CANDIDATE.md` §6 (hosted migration order, Edge Function deploys).
