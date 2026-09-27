# Native mobile spike: index

**Provisional. Owner approval required.** As of P178 the owner has chosen a visual direction
(dark-first, Utility structure + Foil identity — see P178_STITCH_IMPLEMENTATION.md); navigation
(N1/N2/current four tabs) and the app icon remain unselected, and the P154 proposals are unchanged
on those two points. The spike lives in [`apps/mobile-spike`](../../apps/mobile-spike/README.md).

| Document | Answers |
|---|---|
| [DECISION_RECORD](DECISION_RECORD.md) | What the spike is and is not, decisions taken, framework versions and sources |
| [SOURCE_REUSE_MATRIX](SOURCE_REUSE_MATRIX.md) | Which web modules run unchanged, the mechanism, hazards found in the shared code |
| [BACKEND_COMPATIBILITY](BACKEND_COMPATIBILITY.md) | Dependency table (DB 104 vs the P149 candidate DB 106 vs P153), findings from the real stack, local-stack isolation |
| [AUTH_IDENTITY](AUTH_IDENTITY.md) | Session storage decision and measurement, lifecycle, identity boundary diagram, adopting P149 |
| [PRICE_CHECK_CONTRACT](PRICE_CHECK_CONTRACT.md) | Read-only adapter contract, released vs fixture adapters, adopting P153 |
| [PHOTO_SPIKE](PHOTO_SPIKE.md) | Photo ownership contract, what attaches to P151/P153 later, camera portability |
| [TEST_EVIDENCE](TEST_EVIDENCE.md) | Every number, the mutation proofs, and what P158 did **not** run (P166 has since run Android + Hermes) |
| [INTEGRATION_PLAN](INTEGRATION_PLAN.md) | Phased replacement of every `SPIKE_ONLY` adapter |
| [P166_RUNTIME_AND_STITCH_REVIEW](P166_RUNTIME_AND_STITCH_REVIEW.md) | Release build on an Android 16 emulator: Hermes exact-money proof, device steps, performance, runtime findings |
| [P166_STITCH_DESIGN_BRIEF](P166_STITCH_DESIGN_BRIEF.md) | Stitch status (connected, no screens generated), three directions, seven screens, exact steps |
| [P167_ANDROID_HARDENING](P167_ANDROID_HARDENING.md) | Android runtime hardening: the picker after an Activity recreation, dark chrome, large text, keyboard, touch targets |
| [P169_NATIVE_PRICE_CHECK](P169_NATIVE_PRICE_CHECK.md) | Native catalog search and read-only Price Check, contracts, findings F1-F9 |
| [P173_INTEGRATED_NATIVE_ANDROID](P173_INTEGRATED_NATIVE_ANDROID.md) | The two tracks integrated in one app: graph proof, reconciliation, device evidence, fixes, limits |
| [P175_NATIVE_FINANCIAL_WRITES](P175_NATIVE_FINANCIAL_WRITES.md) | The first native financial writes: migration integration plan, the identity-leased write seam, what's implemented, scope boundaries, test evidence |
| [P177_DOC_CORRECTIONS](P177_DOC_CORRECTIONS.md) | Native financial runtime verification: device+DB proof for all five write flows, the Edge Runtime DB-suite result, corrections to prior status labels |
| [P178_STITCH_IMPLEMENTATION](P178_STITCH_IMPLEMENTATION.md) | Dark-first design system (Utility structure + Foil identity), the JPY currency-selector fix, and a screen-by-screen comparison against the accepted P174 Stitch references |

Inputs (read-only): [`docs/design/p154`](../design/p154/README.md), [`docs/design/p174`](../design/p174/README.md) (in the `p174` worktree; not committed there yet).
