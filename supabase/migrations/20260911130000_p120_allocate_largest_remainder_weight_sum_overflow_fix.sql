-- P120: fix a second, distinct bigint overflow inside allocate_largest_remainder, in the
-- WEIGHT-SUMMATION step P117's D-125 fix did not touch.
--
-- D-125 (P117) widened `p_total * v_effective[i]` to numeric because that intermediate product
-- could exceed bigint even when every real input/output stayed inside it. The summation
-- `v_sum_weights := v_sum_weights + p_weights[i]` was left as plain bigint arithmetic — reproduced
-- directly this session:
--   select public.allocate_largest_remainder(100::bigint,
--     ARRAY[9223372036854775807, 9223372036854775807]::bigint[]);
--   -> ERROR: bigint out of range (line 26, the v_sum_weights accumulation)
--
-- This is REACHABLE through the public RPC surface, not just a synthetic-fuzz curiosity:
-- create_purchase places no upper bound on a line's unit_price_minor before it becomes a
-- shipping/customs/discount allocation WEIGHT, so two purchase lines each near bigint max would
-- crash allocate_largest_remainder with this opaque internal error instead of a clean rejection —
-- the transaction still aborts cleanly (no partial commit, no corruption), but the caller gets a
-- raw Postgres error rather than a validation message. FINANCIAL_MODEL.md §4.2/invariant F6 makes
-- the same "for any input the bigint signature accepts" claim D-125 already used to justify
-- widening the multiplication; this migration completes that widening for the summation path too.
--
-- Fix, part 1: v_sum_weights (and therefore v_effective_sum) become numeric, which is unbounded,
-- so summing any number of bigint-range weights can never overflow regardless of how many lines
-- are summed or how large each one is.
--
-- Fix, part 2 — a SECOND, independent, more serious bug found by the same large-scale property
-- fuzz that motivated part 1, present since P117's original migration (not introduced by part 1):
-- Postgres's numeric `/` operator does NOT always return the mathematically exact quotient for
-- very large operands — it rounds to a computed display scale. Reproduced directly:
--   select (219581130708100988383099213597811148::numeric / 1215407149863084914::numeric);       -- 180664669228609283 (WRONG)
--   select div(219581130708100988383099213597811148::numeric, 1215407149863084914::numeric);      -- 180664669228609282 (exact, confirmed against an independent BigInt oracle)
-- `floor(a::numeric / b::numeric)` therefore silently rounds UP in some large-operand cases before
-- floor() ever sees a fraction to round down — an off-by-one FLOOR share that a 5,000-case random
-- property sweep against an independent BigInt reference (src/domain/allocation.ts's `allocate()`)
-- caught as both misallocated shares AND, in 17/5000 cases, `sum(shares) <> total` (v_sum_floors
-- exceeding total makes v_remaining negative, silently violating FINANCIAL_MODEL.md §4.2's
-- invariant F6). Fixed by using Postgres's `div()` — exact truncating integer division for
-- numeric, equivalent to floor() here since both operands are always non-negative — instead of
-- `/` followed by floor(). The `%` (modulo) operator was independently confirmed exact at the same
-- scale (reconstructs the original product via `div(a,b)*b + (a%b) = a`), so it is unchanged.
--
-- Fix, part 3: v_remainders becomes numeric[] (was bigint[]) — a remainder is only ever used to
-- RANK lines against each other for the tie-break, never returned to the caller, but its value is
-- bounded by v_effective_sum (not by p_total), so once part 1 lets v_effective_sum legitimately
-- exceed bigint's range, a remainder can too; casting it to bigint would reintroduce exactly the
-- overflow part 1 fixed. v_floors stays bigint[]: floor(total*w_i/sum) <= total always (w_i <=
-- sum), and total is bigint-bounded by the function's own signature, so this direction is safe
-- regardless of how large sum's numeric value is.
--
-- No behavior change for any input that previously computed a mathematically correct result —
-- verified by the unchanged 6-case parity suite plus a 5,000-case property re-run (0 mismatches,
-- 0 wrong_sum, 0 function_errors after this fix, versus 486/5,000 mismatches and 17/5,000
-- wrong_sum before it).
--
-- CREATE OR REPLACE, not DROP+CREATE: the signature (parameter/return types) is unchanged.

create or replace function public.allocate_largest_remainder(p_total bigint, p_weights bigint[])
returns bigint[]
language plpgsql
immutable
set search_path to ''
as $$
declare
  v_n int := coalesce(array_length(p_weights, 1), 0);
  v_sum_weights numeric := 0;
  v_effective bigint[];
  v_effective_sum numeric;
  v_floors bigint[] := '{}';
  v_remainders numeric[] := '{}';
  v_sum_floors bigint := 0;
  v_remaining bigint;
  v_shares bigint[];
  v_order int[];
  i int;
begin
  if v_n = 0 then
    raise exception 'allocate_largest_remainder: weights must be non-empty';
  end if;
  if p_total < 0 then
    raise exception 'allocate_largest_remainder: total must be non-negative';
  end if;

  for i in 1..v_n loop
    if p_weights[i] < 0 then
      raise exception 'allocate_largest_remainder: weights must be non-negative';
    end if;
    v_sum_weights := v_sum_weights + p_weights[i];
  end loop;

  if v_sum_weights = 0 then
    select array_agg(1::bigint) into v_effective from generate_series(1, v_n);
    v_effective_sum := v_n;
  else
    v_effective := p_weights;
    v_effective_sum := v_sum_weights;
  end if;

  for i in 1..v_n loop
    -- numeric arithmetic here, not bigint: p_total * v_effective[i] can exceed bigint's range
    -- even though p_total, each weight and the eventual per-line share never do.
    -- div(), not `/` + floor(): Postgres's numeric `/` operator rounds to a computed display
    -- scale rather than returning the exact quotient once operands get large enough, which made
    -- floor() see an already-wrong value; div() is exact truncating integer division, equivalent
    -- to floor() here since both operands are always non-negative.
    v_floors := v_floors || div(p_total::numeric * v_effective[i], v_effective_sum)::bigint;
    v_remainders := v_remainders || ((p_total::numeric * v_effective[i]) % v_effective_sum);
    v_sum_floors := v_sum_floors + v_floors[i];
  end loop;

  v_remaining := p_total - v_sum_floors;
  v_shares := v_floors;

  -- Indices ordered by remainder desc, ties by index asc — array_agg over a set-returning
  -- subquery preserves the ORDER BY, which is guaranteed for a single, un-nested array_agg.
  select array_agg(idx order by rem desc, idx asc)
    into v_order
    from unnest(v_remainders) with ordinality as t(rem, idx);

  for i in 1..v_remaining loop
    v_shares[v_order[i]] := v_shares[v_order[i]] + 1;
  end loop;

  return v_shares;
end;
$$;
