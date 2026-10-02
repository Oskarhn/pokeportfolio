# Git publication plan

Authority: this file for the publication state (what is pushed, where, under which visibility policy)
and the GitHub settings recommended before a `main` merge.
`docs/GIT_WORKFLOW.md` §13 for the standing push rule; `docs/DECISIONS.md` D-190 for the decision.
`docs/CURRENT_STATE/BRANCH_PRUNING_PLAN.md` for the branch-by-branch classification;
`docs/release/P188_INTEGRATION_MATRIX.md` for what the candidate contains and why.

Repository visibility: **`PUBLIC_BY_OWNER_CHOICE`** (D-190, 2026-10-02). Intentional; not a blocker and
not a warning. Earlier reports that call public visibility a contradiction or a reason not to push are
historical and superseded by this file.

## 1. Current repository state

| Fact | Value |
|---|---|
| Visibility | `PUBLIC_BY_OWNER_CHOICE` |
| Default branch | `main`; `origin/main` = `d8682e047b757f63673a63ac8185a4806d68cb98` (released, = Production) |
| Development RC branch | `release/p190-cross-platform-development-rc` (pushed 2026-10-02; draft PR into `main`; **development RC, do not merge/deploy yet**) |
| Branch protection on `main` | none |
| Repository rulesets | none |
| PR #112 (`fix/p142-ci-gated-production-deploy`) | `SUPERSEDED_BY_P163`; P163 is contained in the P190 line |

Live PR, run and SHA figures for the RC branch belong to `docs/PROJECT_STATE.json` and the PR itself,
not to this paragraph; re-verify with `gh` before relying on them.

## 2. The release-candidate line

```
d8682e0 (released main, 104 migrations)
  └─ … native lineage P173 → P175 → P177 → P178 → P179 → P180 → P181 → P182 → P184 → P185 → P186
        └─ P187 iOS readiness, rebuilt without its attribution trailer (tree-identical to 79c447d)
            ├─ merge P164  (auth + exact money, P151, P153/P161 Price Check, P157/P162 exports)
            ├─ merge P163  (P142 deploy gate + P160 secret guard)
            ├─ merge P165  (verification fixes for the P164 seams)
            └─ P188 (build profiles, release/** CI trigger, documentation; 107 migrations)
                └─ P189 (restore-safe account deletion; 111 migrations)
                    └─ P190 (CI hardening, publication policy)  = release/p190-cross-platform-development-rc
```

`audit/p156-account-deletion-security-recovery` is superseded by P189 and stays out of the line.
Design-only and documentation-only branches stay where they are. Old remote branches that carry
historical attribution are outside the P190 ancestry and are not rewritten.

## 3. Push rule

Standing rule (`GIT_WORKFLOW.md` §13): completed development phases SHOULD be pushed to their
feature/release branch after local checks, GitHub Actions runs after the push, and a development
branch need not be feature-complete or Production-ready. Main merge and Production deployment have
separate, stricter gates.

Public visibility does **not** authorize committing credentials, private keys, Production
configuration secrets, personal data, signing material or private backups. Before every push: secret
scan of the diff and history, and no real local usernames, Production account ids, test-user
credentials, registry records or backup content in committed documentation.

## 4. Publishing a release candidate

1. Push **only** the `release/**` branch (no `main`, no force, no old P17x/P18x branches).
2. `.github/workflows/ci.yml` triggers on pushes to `release/**` as well as pull requests, so the push
   starts `build-and-test` and `db-tests`. `deploy-production` is restricted to a push to
   `refs/heads/main` and needs no Production secret on this branch; the validation jobs read none.
3. Watch that run. If a job fails, classify it (product, test, workflow, CI environment, transient,
   capacity) before changing anything; never weaken a required gate to get green.
4. Open a **draft** PR into `main`. Merge only after the owner decisions in
   `docs/release/P188_RELEASE_CANDIDATE.md` §6 and `docs/release/P189_ACCOUNT_DELETION.md`; squash per
   `GIT_WORKFLOW.md`.

## 5. Recommended GitHub settings (NOT applied — owner action)

Read-only observation: no protection, no rulesets. Recommended baseline, now more relevant because the
repository is public and a large integration PR is open:

1. A ruleset or branch protection on `main`: require a pull request; require status checks
   `build-and-test` and `db-tests`; block force pushes and deletion; conversation resolution
   optional. Do not allow bypass for admins.
2. Delete the stale `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` **variables**, create the
   four secrets in `docs/security/RELEASE_PREFLIGHT_P163.md` Part A, and rotate the key implicated by
   the secret-shaped variable value (P159/P160 S-1). Treat the repository as public when judging what
   that value exposed.
3. Cloudflare Pages: turn off the Git-integrated automatic deploy and preview builds against the
   Production Supabase project, so the gated job is the only path (P130-08).

## 6. What must pass before a `main` merge

Unchanged (`GIT_WORKFLOW.md` §1/§2/§4/§11): CI green on both jobs for the exact head SHA, a reviewed
diff, no secrets. A merge of the P190 line additionally needs the owner decisions in
`docs/release/P188_RELEASE_CANDIDATE.md` §6 (hosted migration order, Edge Function deploys) and the
P189 blockers (production erasure-registry storage, provider retention settings).
