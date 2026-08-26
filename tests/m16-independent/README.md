# M16 independent openings adversarial contract (P52)

Implementation-blind adversarial contract suite for **M16 — Openings**. Written against
current `origin/main` (`92b238c`) plus the canonical documents — FINANCIAL_MODEL §4/§5/§8
(E1–E5, E13), DATA_MODEL §5.6–§5.8/§8/§9, DECISIONS D-002/D-021/D-060/D-061/D-084/D-085,
SECURITY, TESTING, PRODUCT_SPEC §4.7, UX_FLOWS F5 — and output_44's pre-implementation
research (its uncertain details independently re-derived, arithmetic corrected) WITHOUT
reading any concurrent implementation branch.

Test-only: no file under `src/` or `supabase/` is touched. The suite cannot make `main`
red: the standard vitest include lists never reach this directory, and every
database-backed case gates itself on explicit runtime probes.

Run:

```bash
pnpm exec vitest run --config tests/m16-independent/vitest.config.ts
```

Environment: the same ephemeral-stack variables `pnpm test:db` uses (`SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). Without them, pure-oracle suites run
and database-backed suites skip with stated reasons. Never point this at a hosted project.

## Case classification

| Class | Meaning | Where |
|---|---|---|
| `ACTIVE_TESTS` | Run today, pass on current main | `domain/*` (pure oracles) |
| `ACTIVE_CURRENT_SCHEMA` | Run against a stack TODAY; asserts facts about the shipped schema itself (e.g. `audit_events` must not exist) | `db/integration.test.ts`, `db/security.test.ts` |
| `IMPLEMENTATION_GATED` | Skip until the M16 openings surface is discovered at runtime; then assert the contract for real, failing loudly as `[M16 CONTRACT]` on divergence | everything under `db/` gated through `skipUnlessM16` |
| `ORACLE_ONLY` | Executable specification of required behaviour, no implementation binding yet | `helpers/oracle.ts`, `domain/integration-ordering.test.ts` |

The discovery gate lives in `helpers/contract.ts`: it probes for the `openings` table,
the two `opening_id` linkage columns and every RPC whose name matches `/open/i`, then
binds semantic slots (date / source lots / quantities / manual cost / opening id) onto
whatever parameter names the implementation actually chose. A signature that cannot be
mapped is a loud, self-explaining failure — never a guessed call.

## The economic oracle (`helpers/oracle.ts`)

Central invariant: **OPENING DOES NOT CREATE SPEND.** For a linked sealed purchase,
GPO before = GPO after and CS before = CS after; opening changes OWNERSHIP FORM only.
Pulled-card cost basis is NULL — never zero. The opening owns the analytical cost.

Residual rule restated independently from FINANCIAL_MODEL §4.3 / DATA_MODEL §5.7:
per-unit floor division against the ORIGINAL quantity; the lot's residual (and any
adjustment residual) attaches ONLY to the disposal that reduces `quantity_remaining`
to exactly zero. The hard-coded exact case: 3 units / 29995 øre → unit 9998,
residual +1; open 2 first = 19996, final 1 = 9999, sum 29995. Values 19995, 19997,
19966, 29994, 29996 are named WRONG answers the suite rejects.

Opening result (§5.3, verbatim): retained tracked value + net proceeds from sold pulls
+ bulk estimate (0 if absent) − opening cost; ROI undefined when cost is NULL. F8 is
proven by construction in `domain/opening-return.test.ts`: in a single-opening world
TTEP equals opening_return over the same kroner, so summing them double-counts the
purchase money exactly once too many.

## Concurrency stance (§11)

The burst cases fire genuinely overlapping requests via `Promise.all` against real row
locks and assert EXACT conservation outcomes (Σ successful opened quantities, exact
final `quantity_remaining`). This is behavioural evidence of serialization, not a
pg_locks transcript — no concurrency "proof" is claimed beyond what is observed. The
integrator should additionally capture `pg_locks`/lock-order evidence when wiring these
suites into CI's db-tests job.

## Integration guidance (for the P53 integrator)

1. Run this suite against a branch containing M16. Expect `[M16 CONTRACT]` failures to
   name any surface whose shape diverged; update `helpers/contract.ts` bindings
   deliberately, never by loosening an assertion.
2. Two integration paths must land TOGETHER (§18): reset clears openings AND backup v2
   exports them. `db/integration.test.ts` holds both oracles.
3. Backup blocker rule: a v1 backup generated after M16 that silently omits openings is
   a BLOCKER. `schema_version` MUST be ≥ 2 once the openings table exists.
4. No `audit_events` dependency is permitted: the table does not exist on current schema
   (DATA_MODEL §7 status correction). If an implementation introduces a generic
   audit_events table solely for reconciliation auditing, that is flagged as a
   scope/architecture issue by an active test, not absorbed.
5. Wire the DB-gated suites into CI's db-tests job only once they are expected to pass
   everywhere (typecheck step + execution step, mirroring the M12/M13 pattern), and add
   a `test:m16-adversarial` package script at that point if wanted.
