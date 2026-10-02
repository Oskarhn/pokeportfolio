# docs/CURRENT_STATE/

Focused current-state expansions of `HANDOVER.md`. Each file here answers, for its topic: what
exists now, what is released vs local, dependencies, blockers, and which canonical doc governs
the durable rules (architecture, invariants) once something ships.

**These files are current-state, not historical narrative.** Session-by-session history belongs
in `docs/PROJECT_JOURNAL.md` or `docs/handover/archive/`. When a fact here goes stale, update it
in the same commit as the change that made it stale — do not let it drift the way the old
`HANDOVER.md` did (see `docs/handover/README.md`).

| File | Answers |
|---|---|
| [NATIVE_MOBILE.md](NATIVE_MOBILE.md) | Native (React Native/Expo) app state: what's built, what's verified, what isn't |
| [RELEASE_AND_DEPLOYMENT.md](RELEASE_AND_DEPLOYMENT.md) | CI/CD, deploy gate, repository/hosting state |
| [DATABASE.md](DATABASE.md) | Per-branch migration counts and why they diverge |
| [SECURITY_AND_PRIVACY.md](SECURITY_AND_PRIVACY.md) | Open security findings, account deletion status |
| [GIT_PUBLICATION_PLAN.md](GIT_PUBLICATION_PLAN.md) | What's safe to push given repo visibility; proposed native-RC path |
| [BRANCH_PRUNING_PLAN.md](BRANCH_PRUNING_PLAN.md) | Branch-by-branch keep/superseded/archive classification |
| [../release/P188_RELEASE_CANDIDATE.md](../release/P188_RELEASE_CANDIDATE.md), [../release/P188_INTEGRATION_MATRIX.md](../release/P188_INTEGRATION_MATRIX.md) | The local release candidate: contents, verification, release order; what it contains versus every local branch |

Machine-readable pointers for the same facts: [`docs/PROJECT_STATE.json`](../PROJECT_STATE.json).
Top-level current state: [`HANDOVER.md`](../../HANDOVER.md).
