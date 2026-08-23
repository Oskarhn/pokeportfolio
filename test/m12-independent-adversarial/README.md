# M12 Independent Adversarial Contract Suite

An independent test/audit package for the M12 Dashboard milestone. It was written against the
**documented contract only** - DATA_MODEL.md §6, FINANCIAL_MODEL.md §3/§6/§8, UX_FLOWS.md F10,
TESTING.md §3, SECURITY.md and the M12 adversarial brief - without inspecting the implementation
branch, its commits or its code. It is designed to be applied against that branch later; nothing
in here is shaped around any implementation detail that is not already canonical documentation.

## What it asserts

| Priority | Gate | Where |
|---|---|---|
| 1 | Full rebuild == incremental recompute == independent oracle, byte-identical on every semantic column over a rich event sequence; rebuild idempotence; poison-and-repair | `m12_rebuild_equivalence.test.ts` |
| 2 | Historical ownership correctness (acquire day 30 -> nothing days 1-29; sell day 100 -> zero from day 100; same-day acquire+sell end-of-day lock; sale moves earlier/later) | `m12_snapshot_semantics.test.ts`, oracle self-tests |
| 3 | Historical price correctness: no look-ahead past D; freshness measured FROM D forever; provider corrections change D-and-forward while earlier snapshots stay byte-identical; FX correction propagation | `m12_snapshot_semantics.test.ts`, `domain/oracle.test.ts` |
| 4 | Manual valuation history reconstructable: set / change / backdated correction / clear, judged by an explicit interval model (see LOCK note) | oracle self-tests + semantics |
| 5 | `dirty_from` coalescing and old/new date edits (backdate dirties the NEW earlier date; sale moves dirty the OLD earlier date too; existing boundary coalesces with a newer-earlier event into the minimum) | `m12_queue_mechanics.test.ts` |
| 6 | Zero vs missing: a genuine zero observation is valued at exactly 0 and never counted unvalued; an unpriced holding is excluded from value and counted - never conflated | oracle self-tests + semantics |
| 7 | Cross-user snapshot/queue isolation; admin has no bypass into another user's dashboard data (marker-scan technique) | `m12_security_adversarial.test.ts` |
| 8 | Cache forgery refused at the GRANT level: no INSERT/UPDATE/DELETE for browser-held roles even on own rows; queue writes likewise | `m12_security_adversarial.test.ts` |
| 9 | Elevated routines (`rebuild_portfolio_snapshots` / `drain_portfolio_recompute_queue`) unreachable from anon/authenticated sessions | `m12_security_adversarial.test.ts` |
| 10 | Custom-collection scope: membership changes move nothing financial; scoped reads must disclose current-only status or carry no pre-membership dated values | `m12_collection_honesty.test.ts` |
| 13/14 | Sealed manual-only valuation history; graded F10 exclusion historically (raw price never values a graded holding on ANY past date) | semantics file |
| 15 | Performance pathologies audit (env-gated): rebuild / single-edit drain / dashboard read / history window | `perf/scale_audit.test.ts` |

Scenario letters A-S from the adversarial brief map onto these files; `P`'s deep fault-injection
variant is deliberately skipped with instructions (below).

## The independence model

Three layers share no code with the implementation:

1. **Canonical write paths.** Events are driven through the real product RPCs
   (`create_purchase`, `update_purchase`, `create_sale`, `void_sale`,
   `set_manual_valuation`, `clear_manual_valuation`) plus service-role market-data facts.
2. **The oracle** (`helpers/oracle.ts`). Pure TypeScript recomputation of every expected snapshot
   figure directly from canonical fact tables. It never reads derived columns. Its interpretation
   choices are marked `LOCK` in source:
   - Manual-valuation interval model: each valuation covers `[effective_from, nextBoundary)` where
     the boundary is the next row's effective_from or its own clear date. This is the only reading
     under which history stays reconstructable from final table state while `clear` still changes
     today's resolution. If the suite fails here, reconcile against the implementation branch's
     decision record (D-062 area) deliberately - do not edit the test silently.
   - Freshness age is measured from historical day D, never from today.
   - Provider preference follows `use_eu_pricing` without cross-provider freshness comparison.
3. **Contract probes** (`helpers/contract.ts`). Table existence and function signatures are
   DISCOVERED at runtime (PostgREST OpenAPI), never invoked blindly. Engine calls are bound by
   mapping semantic slots (user/from/through) onto whatever parameter names exist; an unmappable
   signature fails loudly as a contract violation instead of calling the wrong thing.

## Running

Against CI's ephemeral stack or a local stack (same variables as `pnpm test:db`):

```
pnpm test:m12-adversarial
```

- On current `main`: the pure oracle suite runs (22 tests); everything touching the M12 schema
  skips with an explicit reason. Nothing fails spuriously.
- Against an M12 implementation branch: all suites arm themselves and judge it.

Performance audit only: `M12_PERF_AUDIT=1 pnpm test:m12-adversarial perf`.

Typecheck the package alone: `pnpm exec tsc -p test/m12-independent-adversarial/tsconfig.json --noEmit`.

## Known limitations, stated rather than hidden

- **Deep fault injection (scenario P)** needs a failure inside the drain transaction, which
  PostgREST-only access cannot produce (no DDL, no open transactions across requests). It ships as
  a skipped test carrying precise instructions for whoever adds a hook. The observable part -
  reversed-range rejection leaving queued work intact - is live.
- **Collection-scoped read shape** is discovered, not assumed; if no scope parameter exists, the
  suite records that honesty-by-omission is satisfied and moves on. If one exists, backward
  projection without disclosure fails.
- **Snapshot column names** come straight from DATA_MODEL.md §6; a renamed column surfaces as a
  loud read error, which is itself a finding.
- **Row continuity** is asserted: every calendar day from the first tracked date must have a row,
  because a sparse series cannot answer chart queries honestly.

## Repository accommodations (the only files outside this directory touched)

1. `eslint.config.js`: an override block mirroring the existing `tests/db` treatment (node
   globals; relaxed unsafe-access rules for the untyped Supabase client).
2. `package.json`: one script, `test:m12-adversarial`.

No application code, migration, CI workflow or canonical doc was modified by this package.
