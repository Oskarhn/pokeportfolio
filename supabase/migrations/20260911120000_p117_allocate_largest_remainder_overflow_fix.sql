-- P117: fix a real bigint*bigint multiplication overflow inside allocate_largest_remainder.
--
-- FINANCIAL_MODEL.md §4.2 / invariant F6 requires the allocator to sum exactly to the
-- allocated total "for any input" — both p_total and p_weights are typed bigint, so the
-- function's own signature claims to support the full bigint domain for each. The original
-- body computed `p_total * v_effective[i]` in plain bigint arithmetic before dividing by
-- v_effective_sum; once that intermediate product exceeds bigint's ~9.22e18 ceiling, Postgres
-- raises "bigint out of range" even though every individual input and the final result are
-- well within bigint's range.
--
-- Reproduced directly: a single-line EUR purchase with unit_price_minor = 2_147_483_647 (2^31-1)
-- and a manual FX rate of 11.54 computes total_nok_minor ≈ 24_781_961_286, then calls
-- allocate_largest_remainder(24_781_961_286, ARRAY[2_147_483_647]) while splitting that NOK
-- total across the purchase's one attributable-cost line — the product of those two operands
-- (≈5.3e19) overflows bigint. The equivalent NOK-only purchase (no FX multiplier) only hits the
-- same overflow once unit_price_minor exceeds roughly sqrt(bigint max) ≈ 3.03e9, which is why the
-- failure threshold looked currency-dependent when first observed (P115's BIGINT_CHROMIUM note).
--
-- Fix: do the multiplication and division in `numeric` (arbitrary precision), then cast back to
-- bigint only after the value is already inside bigint's range — floor() replaces bigint integer
-- division exactly (both operands are always non-negative here, so floor and truncate agree),
-- and numeric's `%` operator gives the same exact remainder integer division would. No behaviour
-- change for any input that previously succeeded (verified by the SQL/TypeScript parity suite in
-- tests/db/m8_purchase_ledger.test.ts, unchanged and still passing) — the fix only widens the
-- domain the function can actually honor to match what its bigint signature already promised.
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
  v_sum_weights bigint := 0;
  v_effective bigint[];
  v_effective_sum bigint;
  v_floors bigint[] := '{}';
  v_remainders bigint[] := '{}';
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
    v_floors := v_floors || floor((p_total::numeric * v_effective[i]) / v_effective_sum)::bigint;
    v_remainders := v_remainders || ((p_total::numeric * v_effective[i]) % v_effective_sum)::bigint;
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
