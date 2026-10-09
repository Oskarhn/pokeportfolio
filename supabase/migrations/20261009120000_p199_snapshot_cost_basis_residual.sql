-- P199: the historical cost basis (portfolio_snapshots.cost_basis_nok_minor) omitted the lot residual.
--
-- FINANCIAL_MODEL.md section 4.3 / D-060: a lot with quantity q and attributable cost C stores
-- unit_cost_basis = floor(C / q) and residual_nok_minor = C - q * unit_cost_basis, so that
-- q * unit + residual = C exactly. The residual rides on the lot until the one disposal that
-- exhausts it. rebuild_portfolio_snapshots summed `qty_open * unit_cost_basis` and dropped the
-- residual, so every multi-unit lot with an inexact division (a shipping, customs, discount or FX
-- share that does not divide by the quantity) understated DCB by up to q - 1 minor units for as long
-- as it was open, and URC = ACMV - DCB was overstated by the same amount. Reproduced by
-- tests/db/p199_ledger_reconciliation.test.ts (23 of 24 seeded scenarios) and the focused case in
-- tests/db/p199_snapshot_cost_basis.test.ts: a 3 x 333 line plus 1 shipping stores cost 1000, unit
-- 333, residual 1, and the snapshot said 999.
--
-- The fix is one term. lot_day only carries rows with qty_open > 0, which is exactly when the
-- residual is still on the lot (a lot that has been sold out contributes nothing, as before).
-- Nothing else in the function changes: this file is the M12 definition
-- (20260830120010_m12_rebuild_engine.sql) with `residual_nok_minor` selected into `lots` and added
-- to the per-lot basis. Adjustment flooring (D-068) is untouched.
--
-- Backward compatibility: signature, ownership, grants and comment are unchanged (CREATE OR
-- REPLACE keeps them). portfolio_snapshots is a rebuildable cache (D-070); rows already stored for
-- an affected user are stale by the residual, so every user holding a live lot with a non-zero
-- residual is queued for a full rebuild below. The queue drains on the existing cron cadence;
-- until it does, Home's cost-basis figure shows the old value and the pending-recompute flag is true.

create or replace function public.rebuild_portfolio_snapshots(
  p_user_id uuid,
  p_from date,
  p_through date
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- A reversed range is a malformed maintenance call and is rejected below rather than silently
  -- reordered: every legitimate caller (the drain, the sweep, explicit service-role rebuilds)
  -- passes from <= through, so normalization could only ever mask a swapped-argument mistake by
  -- launching an unrequested rebuild with no error signal.
  v_from date;
  v_through date;
  v_use_eu boolean;
  v_first_tracked date;
  v_written integer := 0;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;
  if p_from is null or p_through is null then
    raise exception 'p_from and p_through are required';
  end if;
  if p_through < p_from then
    raise exception
      'rebuild_portfolio_snapshots: p_through % precedes p_from % - reversed range rejected',
      p_through, p_from;
  end if;
  v_from := p_from;
  v_through := least(p_through, current_date);

  select coalesce(p.use_eu_pricing, true) into v_use_eu
    from public.profiles p where p.id = p_user_id;
  v_use_eu := coalesce(v_use_eu, true);

  delete from public.portfolio_snapshots s
   where s.user_id = p_user_id
     and s.snapshot_date between v_from and v_through;

  -- Earliest date any canonical fact begins for this user. Nothing before it can have a
  -- snapshot: no ownership, no spend, no proceeds — storing zero-filled rows there would
  -- fabricate history (prompt §27/§48/§91).
  select min(d) into v_first_tracked from (
    select min(l.acquired_on) as d from public.acquisition_lots l
      where l.user_id = p_user_id and l.voided_at is null
    union all
    select min(p.purchased_on) from public.purchases p
      where p.user_id = p_user_id and p.voided_at is null
    union all
    select min(s.sold_on) from public.sales s
      where s.user_id = p_user_id and s.voided_at is null
  ) f;

  if v_first_tracked is null or v_through < v_first_tracked or v_through < v_from then
    return 0;
  end if;
  v_from := greatest(v_from, v_first_tracked);

  insert into public.portfolio_snapshots (
    user_id, snapshot_date,
    market_value_nok_minor, attributed_value_nok_minor, cost_basis_nok_minor,
    collectible_spend_to_date_nok_minor, sales_proceeds_to_date_nok_minor,
    open_lot_count, unvalued_lot_count, computed_at
  )
  with lots as materialized (
    -- Every non-voided lot of every live holding, with its identity for valuation. Voided lots
    -- are corrections: they are excluded from every historical state entirely (prompt §21),
    -- exactly as the current-state queries treat them.
    select l.id as lot_id, l.holding_id, l.acquired_on, l.quantity, l.residual_nok_minor,
           l.cost_basis_state, l.unit_cost_basis_nok_minor
    from public.acquisition_lots l
    join public.holdings h on h.id = l.holding_id
    where l.user_id = p_user_id
      and l.voided_at is null
      and h.deleted_at is null
      and h.user_id = p_user_id
  ),
  dates as materialized (
    select d::date as d from generate_series(v_from, v_through, interval '1 day') d
  ),
  -- ── ownership timeline: quantity remaining as of each date ────────────────────────────────
  grid as materialized (
    select l.lot_id, l.holding_id, l.quantity, l.cost_basis_state,
           l.unit_cost_basis_nok_minor, dt.d
    from lots l join dates dt on dt.d >= l.acquired_on
  ),
  disposed_per_day as materialized (
    select ld.lot_id, ld.disposed_on as d, sum(ld.quantity) as qty
    from public.lot_disposals ld
    join lots l on l.lot_id = ld.lot_id
    where ld.voided_at is null and ld.disposed_on <= v_through
    group by ld.lot_id, ld.disposed_on
  ),
  adjusted_per_day as materialized (
    select a.lot_id, a.occurred_on as d, sum(a.amount_nok_minor) as amt
    from public.lot_cost_adjustments a
    join lots l on l.lot_id = a.lot_id
    where a.occurred_on <= v_through
    group by a.lot_id, a.occurred_on
  ),
  -- Two single-stream joins + GROUP BY (never a correlated per-row subquery, D-054 discipline):
  -- cumulative disposal quantity and cumulative adjustment amount as of each date.
  lot_qty_day as materialized (
    select g.lot_id, g.holding_id, g.d, g.cost_basis_state, g.unit_cost_basis_nok_minor,
           g.quantity - coalesce(sum(dp.qty), 0)::int as qty_open
    from grid g
    left join disposed_per_day dp on dp.lot_id = g.lot_id and dp.d <= g.d
    group by g.lot_id, g.holding_id, g.d, g.quantity, g.cost_basis_state, g.unit_cost_basis_nok_minor
  ),
  lot_adj_day as materialized (
    select g.lot_id, g.d, coalesce(sum(ap.amt), 0)::bigint as adj_to_date
    from grid g
    left join adjusted_per_day ap on ap.lot_id = g.lot_id and ap.d <= g.d
    group by g.lot_id, g.d
  ),
  lot_day as materialized (
    select q.*, a.adj_to_date
    from lot_qty_day q join lot_adj_day a on a.lot_id = q.lot_id and a.d = q.d
    where q.qty_open > 0
  ),
  -- ── manual valuation intervals (D-062): economic validity [effective_from, valid_to), rows
  -- sorted by (effective_from, created_at, id). Two distinct ways a row can end, and the schema's
  -- timestamps distinguish them because now() is the TRANSACTION timestamp:
  --
  --   ATOMIC REPLACEMENT  set_manual_valuation supersedes the old row and inserts the new one in
  --   ONE transaction, so the old row's superseded_at equals the successor row's created_at.
  --   D-062: the replacement's effective_from defines the economic boundary — the old value runs
  --   to the day the new one begins.
  --
  --   INDEPENDENT CLEAR   clear_manual_valuation stamps superseded_at and inserts nothing. If a
  --   NEW valuation only arrives later as a separate transaction, the old row was cleared and
  --   STAYS CLEARED: it ends at its own clear date, and the gap before the later row's
  --   effective_from resolves through the normal provider/missing path. A user's explicit clear
  --   must never be silently resurrected by an unrelated later insertion.
  --
  -- The pairing test below is "does ANY later-created row share this row's supersession
  -- timestamp", not "does the immediately-next row in sort order" — a still-later backdated
  -- correction can sort BETWEEN a row and its actual successor in (effective_from, created_at)
  -- order, and misreading that as a clear would produce overlapping intervals (double-counted
  -- days). With the pairing test every interval satisfies valid_to <= next row's effective_from,
  -- so per-day coverage stays single-valued by construction.
  mv_supersede_pairs as materialized (
    select distinct m.holding_id, m.superseded_at
    from public.manual_valuations m
    join public.manual_valuations n
      on n.user_id = m.user_id
     and n.holding_id = m.holding_id
     and n.created_at = m.superseded_at
    where m.user_id = p_user_id
      and m.superseded_at is not null
  ),
  mv_intervals as materialized (
    select mv.holding_id, mv.effective_from,
           lead(mv.effective_from) over w as next_eff,
           case
             -- Terminal row: active → open-ended; cleared → ends at the clear date itself.
             when lead(mv.effective_from) over w is null
               then cast(mv.superseded_at as date)
             -- Superseded by a transaction that also inserted a successor: replacement boundary.
             when pair.superseded_at is not null
               then lead(mv.effective_from) over w
             -- Cleared independently, with independent later insert(s) following: the clear stays
             -- cleared. least() covers the backdated-correction case where the later row's
             -- effective_from lands before the clear date — corrections rewrite history; they do
             -- not extend what they correct.
             else least(cast(mv.superseded_at as date), lead(mv.effective_from) over w)
           end as valid_to,
           mv.value_nok_minor
    from public.manual_valuations mv
    left join mv_supersede_pairs pair
      on pair.holding_id = mv.holding_id and pair.superseded_at = mv.superseded_at
    where mv.user_id = p_user_id
    window w as (partition by mv.holding_id order by mv.effective_from, mv.created_at, mv.id)
  ),
  holding_meta as materialized (
    select h.id as holding_id, h.holding_kind, h.card_variant_id
    from public.holdings h
    where h.user_id = p_user_id and h.deleted_at is null
  ),
  manual_days as materialized (
    select mi.holding_id, dt.d, mi.value_nok_minor
    from mv_intervals mi join dates dt
      on dt.d >= mi.effective_from
     and (mi.valid_to is null or dt.d < mi.valid_to)
  ),
  -- ── provider observations as step functions over the range (age measured from D, prompt §25)
  owned_variants as materialized (
    select distinct hm.card_variant_id
    from holding_meta hm
    where hm.card_variant_id is not null and hm.holding_kind = 'raw_card'
  ),
  obs as materialized (
    select ps.card_variant_id, ps.provider, ps.snapshot_date, ps.source_currency, ps.value_minor
    from public.price_snapshots ps
    join owned_variants ov on ov.card_variant_id = ps.card_variant_id
    where ps.snapshot_date > v_from - 31   -- older observations can never resolve inside the range
      and ps.snapshot_date <= v_through
  ),
  obs_step as materialized (
    select o.*,
           lead(o.snapshot_date) over (
             partition by o.card_variant_id, o.provider order by o.snapshot_date
           ) as next_date
    from obs o
  ),
  obs_fx as materialized (
    select
      d.base_currency, d.snapshot_date,
      (
        select fr.rate from public.fx_rates fr
        where fr.base_currency = d.base_currency
          and fr.quote_currency = 'NOK'
          and fr.source = 'norges_bank'
          and fr.rate_date <= d.snapshot_date
        order by fr.rate_date desc
        limit 1
      ) as rate
    from (
      select distinct o.source_currency as base_currency, o.snapshot_date
      from obs_step o where o.source_currency <> 'NOK'
    ) d
  ),
  steps as materialized (
    select os.card_variant_id, os.provider, os.snapshot_date,
           least(os.snapshot_date + 31, coalesce(os.next_date, os.snapshot_date + 31)) as valid_to,
           case when os.source_currency = 'NOK' then os.value_minor::numeric
                when fx.rate is not null then round(os.value_minor * fx.rate)
           end as nok_value
    from obs_step os
    left join obs_fx fx
      on fx.base_currency = os.source_currency and fx.snapshot_date = os.snapshot_date
  ),
  provider_days as materialized (
    select s.card_variant_id, dt.d, s.nok_value, s.provider
    from steps s join dates dt
      on dt.d >= s.snapshot_date and dt.d < s.valid_to
    where s.nok_value is not null
  ),
  -- One resolved unit value per (variant, date), honouring the same use_eu_pricing preference
  -- (D-052) as the current-value resolver — freshness never overrides the preference.
  provider_choice as materialized (
    select pd.card_variant_id, pd.d,
           max(pd.nok_value) filter (where pd.provider = 'tcgdex_cardmarket') as cm,
           max(pd.nok_value) filter (where pd.provider = 'tcgdex_tcgplayer') as tp
    from provider_days pd
    group by pd.card_variant_id, pd.d
  ),
  variant_unit as materialized (
    select pc.card_variant_id, pc.d,
           case when v_use_eu and pc.cm is not null then pc.cm
                when v_use_eu and pc.tp is not null then pc.tp
                when not v_use_eu and pc.tp is not null then pc.tp
                else pc.cm
           end as unit_value
    from provider_choice pc
  ),
  holding_days as materialized (
    select distinct ld.holding_id, ld.d from lot_day ld
  ),
  -- Per-holding unit value on a day: active manual interval wins; otherwise a provider value
  -- ONLY for raw cards (F10 — graded and sealed resolve manual-or-missing, unchanged from M9).
  holding_unit as materialized (
    select hd.holding_id, hd.d,
           case
             when md.value_nok_minor is not null then md.value_nok_minor
             when hm.holding_kind = 'raw_card' and vu.unit_value is not null then vu.unit_value::bigint
             else null
           end as unit_value
    from holding_days hd
    join holding_meta hm on hm.holding_id = hd.holding_id
    left join manual_days md on md.holding_id = hd.holding_id and md.d = hd.d
    left join variant_unit vu on vu.card_variant_id = hm.card_variant_id and vu.d = hd.d
  ),
  lot_valued as materialized (
    select ld.d, ld.lot_id, ld.qty_open, ld.adj_to_date,
           lq.cost_basis_state, lq.unit_cost_basis_nok_minor, hu.unit_value
    from lot_day ld
    join lots lq on lq.lot_id = ld.lot_id
    join holding_meta hm on hm.holding_id = ld.holding_id
    left join holding_unit hu on hu.holding_id = ld.holding_id and hu.d = ld.d
  ),
  -- DCB as of D: quantity × unit basis plus the lot's proportional share (floor) of adjustments
  -- that had occurred by D — a future grading adjustment never inflates a past snapshot
  -- (prompt §58). Exact integers; the flooring rule is DECISIONS.md D-068.
  daily_core as materialized (
    select lv.d,
           coalesce(sum(lv.qty_open * lv.unit_value)
             filter (where lv.unit_value is not null), 0)::bigint as cmv,
           coalesce(sum(lv.qty_open * lv.unit_value)
             filter (where lv.unit_value is not null and lv.cost_basis_state = 'known'), 0)::bigint as acmv,
           coalesce(sum(
             lv.qty_open * lq.unit_cost_basis_nok_minor
             + lq.residual_nok_minor
             + floor(lv.adj_to_date * lv.qty_open / greatest(lq.quantity, 1))
           ) filter (where lv.cost_basis_state = 'known'), 0)::bigint as dcb,
           count(*)::bigint as open_lot_count,
           count(*) filter (where lv.unit_value is null)::bigint as unvalued_lot_count
    from lot_valued lv
    join lots lq on lq.lot_id = lv.lot_id
    group by lv.d
  ),
  spend_by_day as materialized (
    select p.purchased_on as d,
           coalesce(sum(pl.attributable_cost_nok_minor)
             filter (where pl.spend_class = 'collectible'), 0)::bigint as cs_delta,
           coalesce(sum(pl.attributable_cost_nok_minor)
             filter (where pl.spend_class = 'hobby'), 0)::bigint as hs_delta
    from public.purchase_lines pl
    join public.purchases p on p.id = pl.purchase_id
    where pl.user_id = p_user_id
      and p.user_id = p_user_id
      and p.voided_at is null
      and p.purchased_on <= v_through
    group by p.purchased_on
  ),
  proceeds_by_day as materialized (
    select s.sold_on as d, sum(s.net_proceeds_nok_minor)::bigint as nsp_delta
    from public.sales s
    where s.user_id = p_user_id and s.voided_at is null and s.sold_on <= v_through
    group by s.sold_on
  ),
  spend_before as materialized (
    select coalesce(sum(pl.attributable_cost_nok_minor) filter (where pl.spend_class = 'collectible'), 0)::bigint as cs,
           coalesce(sum(pl.attributable_cost_nok_minor) filter (where pl.spend_class = 'hobby'), 0)::bigint as hs
    from public.purchase_lines pl
    join public.purchases p on p.id = pl.purchase_id
    where pl.user_id = p_user_id and p.voided_at is null and p.purchased_on < v_from
  ),
  proceeds_before as materialized (
    select coalesce(sum(s.net_proceeds_nok_minor), 0)::bigint as nsp
    from public.sales s
    where s.user_id = p_user_id and s.voided_at is null and s.sold_on < v_from
  ),
  -- Frozen-ledger cumulatives over the date spine: opening balance before the range plus a
  -- running sum of per-day deltas. Set-based window, no correlated per-date subquery.
  spine as materialized (
    select dt.d,
           sb.cs + coalesce(sum(sd.cs_delta) over (order by dt.d), 0)::bigint as cs,
           pb.nsp + coalesce(sum(pd.nsp_delta) over (order by dt.d), 0)::bigint as nsp
    from dates dt
    left join spend_by_day sd on sd.d = dt.d
    left join proceeds_by_day pd on pd.d = dt.d
    cross join spend_before sb
    cross join proceeds_before pb
  )
  select
    p_user_id,
    spine.d,
    coalesce(dc.cmv, 0),
    coalesce(dc.acmv, 0),
    coalesce(dc.dcb, 0),
    spine.cs,
    spine.nsp,
    coalesce(dc.open_lot_count, 0),
    coalesce(dc.unvalued_lot_count, 0),
    now()
  from spine
  left join daily_core dc on dc.d = spine.d;

  get diagnostics v_written = row_count;
  return v_written;
end;
$$;

-- Queue every user whose cache is now known to be stale. enqueue_portfolio_recompute keeps the
-- earliest dirty_from if the user is already queued.
select public.enqueue_portfolio_recompute(t.user_id, t.first_acquired)
from (
  select l.user_id, min(l.acquired_on) as first_acquired
  from public.acquisition_lots l
  where l.voided_at is null
    and l.cost_basis_state = 'known'
    and l.residual_nok_minor > 0
  group by l.user_id
) t;
