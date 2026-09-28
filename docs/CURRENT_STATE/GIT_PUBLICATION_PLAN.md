# Git publication plan

Authority: this file for what is/isn't safe to push given current repository visibility, and the
proposed integration path. `docs/GIT_WORKFLOW.md` for the durable branch/PR/CI conventions this
plan operates inside (unchanged). `docs/CURRENT_STATE/BRANCH_PRUNING_PLAN.md` for the branch-by-
branch keep/archive classification this plan references.

**This is a plan, not an action.** Nothing here pushes, closes, or deletes anything. All figures
verified live 2026-09-28 (P183) via `gh` — re-verify before acting if this file is read much later.

## 1. Current repository state (live-verified 2026-09-28)

| Fact | Value |
|---|---|
| Visibility | **PUBLIC** (contradicts `CLAUDE.md`'s hard rule — see `HANDOVER.md` §1/§14) |
| Default branch | `main` |
| `origin/main` SHA | `d8682e047b757f63673a63ac8185a4806d68cb98` (matches the released frontend and hosted DB record — `HANDOVER.md` §1) |
| Branch protection on `main` | None |
| Repository rulesets | None |
| Open PRs (spot-checked) | PR #112 (`fix/p142-ci-gated-production-deploy` → `main`), OPEN, MERGEABLE, last CI run 2026-09-18: `build-and-test` SUCCESS, `db-tests` FAILURE. Superseded by P163 (below) but not closed. |
| Remote branches | 66 (per P176's count; not recounted branch-by-branch this session — see `BRANCH_PRUNING_PLAN.md`) |
| Draft PRs | 27 (per P176's count, not independently recounted) |

## 2. Current local candidate chain (none pushed)

The native lineage, in order, none merged or pushed:

```
d8682e0 (released main)
  → P173  feat/p173-native-integration-recovered            105 migrations, device-verified
    → P175  feat/p175-native-financial-write-flows           107 migrations
      → P177  test/p177-native-financial-runtime             107 migrations, device-verified
        → P178  feat/p178-dark-native-ui                     107 migrations
          → P179  test/p179-dark-ui-finish-gate               107 migrations
            → P180  feat/p180-native-financial-reliability   107 migrations, device-verified
              → P181  feat/p181-native-device-accessibility-performance-gate   107 migrations
                (current native tip, 45ebfefa9a5038e20dd1999644eb96c1ae6352ef)
```

Plus independent (non-native) local candidates off the same `d8682e0` base: `fix/p163-integrated-
ci-secret-gate` (deployment gate), `audit/p156-account-deletion-security-recovery` (account
deletion), `fix/p149-auth-refresh-failure-recovery` (closes P130-19), `fix/p151-scanner-
reliability-performance`, `fix/p157-safe-exact-export-pipeline`, `design/p174-stitch-owner-
decision-pack` (superseded by the P178 implementation decision — see §3). None of these shares an
integration branch with another or with the native chain; each needs its own merge/conflict pass.

## 3. Superseded branches (do not treat as active work)

- `fix/p142-ci-gated-production-deploy` and `fix/p160-predeploy-secret-guard` → superseded by
  `fix/p163-integrated-ci-secret-gate` (integrates both).
- `feat/p152-privacy-account-deletion` → superseded by `audit/p156-account-deletion-security-
  recovery` (P156 builds on P152 with an independent security audit + fixes).
- `spike/p158-native-collection-pricecheck` → superseded by `spike/p166-native-runtime-stitch`.
- `spike/p166-native-runtime-stitch` → superseded by `fix/p167-native-android-runtime-hardening`.
- `feat/p169-native-catalog-price-check`, `feat/p170-integrated-native-android` (unknown
  completion status) → superseded/recovered by `feat/p173-native-integration-recovered`.
- `design/p168-stitch-native-ui`, `design/p171-stitch-owner-review` → superseded by `design/p174-
  stitch-owner-decision-pack`.
- `design/p174-stitch-owner-decision-pack` itself → the direction it informed has now been
  **implemented** as `feat/p178-dark-native-ui` (the owner's DARK_FIRST_UTILITY_STRUCTURE_FOIL_
  IDENTITY hybrid choice). P174 remains useful as the design record, not as a pending decision.
- Every `feat/p1xx-…`/`fix/p1xx-…` branch in the P104–P141 hardening chain that predates the
  released `d8682e0` tip → already released (their content is in `main`); kept only as history.
- Full branch-by-branch classification: `docs/CURRENT_STATE/BRANCH_PRUNING_PLAN.md`.

## 4. Which branch should eventually become the native RC

**`feat/p181-native-device-accessibility-performance-gate`** (the current tip of the P173→P181
chain) is the natural base for a future native release-candidate branch — it carries every prior
phase's fixes and is the most device-verified point in the lineage. It is **not ready to become an
RC today**: the disclosed gaps in `HANDOVER.md` §9 (TalkBack never run, device matrix not
exhaustive, JPY never driven as an on-device purchase, native card recognition unproven on this
tip) should close first, and the branch has never been integration-tested against the
non-native local candidates (P149/P151/P156/P157/P163) it would eventually need to merge with.
Recommended path: close §9's native gaps on this branch (or a follow-on branch based on it) before
naming anything `release/native-rc-*`.

## 5. What should NOT be pushed while the repository stays PUBLIC

Per `GIT_WORKFLOW.md` §13 and `CLAUDE.md`'s repository-visibility hard rule: **do not push any
branch carrying unreleased project source** while visibility is PUBLIC, including but not limited
to the entire native lineage (§2), the deployment-gate/secret-guard work (P163 — pushing this
specifically would also be pushing a fix for a security finding, which is worse to expose than
ordinary feature work), the account-deletion audit (P156), and the auth-refresh fix (P149). None
of this should reach a public GitHub repository before the owner resolves the visibility
contradiction.

## 6. What CAN be pushed once the repository is private again (or the owner explicitly accepts public)

Once visibility is resolved, the normal branch → PR → CI → merge workflow (`GIT_WORKFLOW.md` §2)
applies with no special restriction — every local candidate in §2 becomes a normal push/PR
candidate again, in whatever integration order the owner picks (P159's `NEXT_RELEASE_ORDER`, in
the P159 worktree, has a reasoned starting proposal not yet promoted to a canonical doc).

## 7. What CI should run after a push

Unchanged from `GIT_WORKFLOW.md` §2/§10: `.github/workflows/ci.yml`'s `build-and-test` and
`db-tests` jobs (typecheck, lint, format, domain tests, build, secret scan, full ephemeral-database
migration + authorization suite). CI is **post-push validation**, not a prerequisite for making the
push itself (`GIT_WORKFLOW.md` §13) — but see §8 below for what must pass before anything merges.

## 8. What must pass before a `main` merge

Unchanged, `GIT_WORKFLOW.md` §1/§2/§4/§11: CI green (`build-and-test` and `db-tests` both passing,
not merged with a red gate or an admin override), a reviewed diff, no secrets. `main`'s lack of
GitHub-configured branch protection (§1 above) does not relax this — protection here is enforced by
process, and this plan does not propose buying GitHub Pro or otherwise weakening that discipline
just because the repository happens to be public right now.
