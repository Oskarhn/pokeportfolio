-- M9.1 hotfix (TESTING.md §7/§37, D-054's own lesson applied again): CI's newly-integrated
-- 10,000-lot benchmark found a REAL regression, not just a CI-runner-noise number — list_portfolio
-- genuinely hit `statement timeout` (57014) at realistic scale (10,000 lots, ~3,500 distinct
-- variants), the exact failure class M7's original benchmark found once already.
--
-- Diagnosis (from the benchmark's own real numbers, not guesswork): list_portfolio's first several
-- calls in a session measured 4.0-7.5 seconds each and one attempt outright timed out;
-- resolve_variant_market_values, called by list_portfolio AND by portfolio_counts with the exact
-- same large card_variant_id array, showed no such symptom in portfolio_counts (which stayed at
-- 33-53 ms even on an early call in the same session). The resolver itself is therefore not the
-- primary suspect — what list_portfolio alone has is a ~12-branch CASE-based ORDER BY across every
-- sort mode plus a matching ~12-branch cursor predicate, in ONE static parameterized query.
--
-- PostgreSQL's PL/pgSQL layer re-plans a parameterized query using a CUSTOM plan (built from the
-- actual runtime parameter values) for its first several executions per session before considering
-- a cached GENERIC plan (`plan_cache_mode`, PG12+) — for a query this structurally complex, custom
-- replanning is itself expensive, and is exactly the kind of cost that would show up as "slow the
-- first several times, then fast" (matching the 7472ms -> 64.7ms drop measured for the byte-
-- identical value_desc query re-run later in the same benchmark run) and can occasionally produce
-- a pathologically bad custom plan (matching the observed timeout).
--
-- Fix: force list_portfolio onto a generic plan from its very first call, skipping the expensive
-- and occasionally-pathological custom-replan phase entirely. A per-function GUC override
-- (`ALTER FUNCTION ... SET ...`) — no signature change, no privilege-baseline update needed.
-- get_market_movers gets the same treatment defensively: it shares the identical CASE-based
-- multi-sort-mode ORDER BY shape M9.1 just introduced, the same architecture class this fix targets.
--
-- This is disclosed as the best-evidence fix given real CI measurements, not a certainty proven by
-- EXPLAIN ANALYZE — see HANDOVER.md/claude_outputs/output_16.txt for the full reasoning and the
-- explicit recommendation that a future session confirm this with EXPLAIN ANALYZE against the real
-- project if any further slowness is ever observed.

alter function public.list_portfolio(
  public.portfolio_sort_order, int, text, uuid, public.card_condition, boolean, public.grader,
  boolean, text, boolean, uuid, uuid, uuid, boolean, boolean, uuid, text, text, bigint, date,
  timestamptz, bigint, boolean, text
) set plan_cache_mode = 'force_generic_plan';

alter function public.get_market_movers(int, int, public.market_mover_sort)
  set plan_cache_mode = 'force_generic_plan';
