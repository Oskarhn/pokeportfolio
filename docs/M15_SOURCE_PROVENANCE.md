# M15 source provenance matrix

Standalone reference for what happened to each intended behaviour across the M15 scanner/finance
integration chain (P106 → P108 → P109 → P110 → P111 → P112). Coverage of this already exists,
distributed across HANDOVER.md's P111 section and the DECISIONS.md entries themselves; this file
exists so it can be checked in one place and machine-verified (see
`tests/config/m15-source-provenance.test.ts`) rather than reconstructed from memory.

Status values: **PRESENT** (shipped as originally designed), **SUPERSEDED** (a later source
replaced it with different behaviour — the original is gone on purpose), **RENUMBERED** (the
behaviour is unchanged, only its decision ID moved), **DELIBERATELY_EXCLUDED** (considered and
explicitly not carried forward, with a recorded reason).

| Source | Intended behaviour | Status | Where it actually lives now |
|---|---|---|---|
| P106 | SaleForm items-only reset on entity switch | SUPERSEDED | P109's full-entity reset (`createInitialSaleFormFields()`/`EntityKeyChangeTracker`) is sole authority; P106's items-only code path was fully removed, not merged alongside it |
| P108 | `create_purchase` idempotency key, originally decision D-117 | RENUMBERED | D-121 (`docs/DECISIONS.md`) — P106 had already claimed D-117 for its own cookie-consent decision; no behaviour changed, only the ID |
| P108 | Dashboard-read covering index, originally decision D-116 | RENUMBERED | D-120 — same collision reason as above (P101 had already claimed D-116 for the robots.txt/sitemap default) |
| P108 | `create_purchase` idempotent replay excludes `p_notes` entirely from both the equivalence check AND any post-replay update | SUPERSEDED | D-122 (P111): notes stay out of the equivalence check (a notes-only edit still replays), but a legitimate replay now writes the caller's latest `p_notes` onto the existing row — D-121's original "operational metadata" framing was wrong; notes are user-visible content |
| P109 | Full-entity SaleForm/PurchaseEdit reset on switch, real-browser proof | PRESENT | `tests/e2e/authenticated/entity-switch-regression.spec.ts` |
| P110 | Visual index 404-resume: a stable 404 is never hammered within a run or same-day resume | PRESENT (design), FIXED (implementation) | D-123 (P111) — P110's own report claimed the resume loop clears a permanent-failure entry on a fresh probe; tracing the actual code found `build-index.ts` skipped any card already in `permanentFailures` unconditionally, so it could never reach that success path. Fixed via `shouldSkipPermanentFailure()` + a 24h re-probe window in `src/domain/scanner/checkpoint-identity.ts`; the "never hammered within a run" half of the design was already correct and is unchanged |
| P110 | Cloudflare Web Analytics route-gated to the public allowlist, decision D-119 | PRESENT | `docs/DECISIONS.md` D-119, `src/analytics/analyticsRoutePolicy.ts` |
| P111 | Clean, attribution-free commit history for the whole M15 lineage | DELIBERATELY_EXCLUDED (partial) | P111's own 8 commits are clean (independently re-verified twice). 10 commits deep in the SHARED M15 ancestor lineage — dated 2026-09-02, predating P102, reachable from every M15 branch (P102/P105/P106/P108/P109/P110/P111) — carry `Co-Authored-By: Claude Sonnet 5`. Rewriting them was explicitly out of scope for P111 (would force-rewrite ancestry several other open PRs depend on) and remains out of scope for P112 too — **not because it is unresolved, but because P112 structurally does not need it**: this branch (`feat/p112-m15-hosted-release-candidate`) is rooted directly on `main` and never imports that ancestry at all, so its own `git log main..HEAD` is clean by construction (re-verified in P112 — zero attribution hits). The contaminated commits still exist on the OLD source branches/PRs (#80/#82/#83/#84/#85/#86/#88); merging or rebasing THOSE onto `main` still requires the owner-approved rewrite this note originally flagged. That rewrite is not a blocker for P112's own merge. |
| P94 | `add_card_acquisition` race-path replay skips the voided/material-equivalence checks the sequential early-check path already runs | SUPERSEDED | `20260903120020_p94_scanner_idempotency_race_fix.sql` — the exception-handler path now runs the identical checks |

## Decision ID uniqueness

D-001 through D-123, zero duplicates — enforced by `tests/config/decision-ids-unique.test.ts`
(full-file grep, not just the tail).

## What this file does NOT need to track

Every other P106/P108/P109/P110 behaviour not listed above shipped as originally designed with no
supersession, renumbering, or exclusion — the migrations, tests, and DECISIONS.md entries
themselves are the source of truth for those; duplicating them here would be exactly the "giant
historical essay" this file is deliberately not.
