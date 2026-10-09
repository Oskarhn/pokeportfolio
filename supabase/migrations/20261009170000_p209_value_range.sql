-- P209 / D-210: one range invariant for money, end to end.
--
-- THE DEFECT (P199 U2, reproduced on a disposable local stack). The RPC accepts any non-negative
-- bigint as a manual valuation (FINANCIAL_MODEL.md M3: the supported range is the whole signed bigint).
-- Every read then multiplied that unit value by the owned quantity in bigint arithmetic:
--   unit 9e18 minor x 2 copies  ->  ERROR 22003 "bigint out of range"
-- in get_dashboard_summary, portfolio_counts, list_portfolio, get_holding_value_provenance, get_opening
-- and rebuild_portfolio_snapshots, so one mistyped valuation made the whole portfolio unreadable and
-- the owner could not open the holding to correct it.
--
-- THE INVARIANT (D-210):
--   1. Every stored amount, and every derived amount of ONE holding (unit value x owned copies), is a
--      signed bigint. A write that would leave a holding outside that range is REFUSED with a named
--      error (SQLSTATE 22003), never wrapped, clamped or rounded. Two triggers enforce it, so no
--      writer (RPC, service role, a future function) can bypass it.
--   2. Every aggregate across holdings or days is exact NUMERIC arithmetic and leaves the database
--      as text (M3). portfolio_snapshots stores its five money sums as numeric(38,0): a sum over many
--      holdings can legitimately exceed bigint even when no single amount does.
--
-- Changed here (all CREATE OR REPLACE with unchanged signatures and ACLs; outputs were already text):
--   rebuild_portfolio_snapshots, get_dashboard_summary, list_portfolio, portfolio_counts,
--   get_holding_value_provenance, get_opening  -- products and sums are numeric
--   portfolio_snapshots money columns          -- bigint -> numeric(38,0) (a rebuildable cache, D-070)
--   rebuild_portfolio_snapshots also drops a float: the adjustment share was floor(bigint) = float8;
--   it is floor(numeric) now.
-- Not changed: get_market_movers multiplies a provider price DIFFERENCE by a quantity, bounded by
-- the provider's range, not by user input.

alter table public.portfolio_snapshots
  alter column market_value_nok_minor type numeric(38, 0),
  alter column attributed_value_nok_minor type numeric(38, 0),
  alter column cost_basis_nok_minor type numeric(38, 0),
  alter column collectible_spend_to_date_nok_minor type numeric(38, 0),
  alter column sales_proceeds_to_date_nok_minor type numeric(38, 0);

-- ── invariant 1: a holding's value fits a bigint ─────────────────────────────────────────────────
-- SECURITY DEFINER so the check reads the owner's rows whatever role performs the write; it reads
-- only the holding named by the written row and returns nothing to the caller but a refusal.
create or replace function public.assert_holding_value_in_range()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_holding_id uuid;
  v_unit numeric;
  v_copies numeric;
begin
  if tg_table_name = 'manual_valuations' then
    if new.superseded_at is not null then
      return null;
    end if;
    v_holding_id := new.holding_id;
    v_unit := new.value_nok_minor;
  else
    if new.voided_at is not null then
      return null;
    end if;
    v_holding_id := new.holding_id;
    select mv.value_nok_minor into v_unit
      from public.manual_valuations mv
      where mv.holding_id = v_holding_id and mv.superseded_at is null;
  end if;

  if v_unit is null or v_unit = 0 then
    return null;
  end if;

  select coalesce(sum(l.quantity_remaining), 0) into v_copies
    from public.acquisition_lots l
    where l.holding_id = v_holding_id and l.voided_at is null;

  if v_unit * v_copies > 9223372036854775807 then
    raise exception
      'holding value out of range: % per copy x % copies exceeds the supported maximum of 9223372036854775807 minor units',
      v_unit, v_copies
      using errcode = '22003';
  end if;
  return null;
end;
$$;

revoke execute on function public.assert_holding_value_in_range() from public, anon, authenticated;

comment on function public.assert_holding_value_in_range() is
  'D-210: refuses a write that would make unit manual value x owned copies of one holding exceed the signed bigint range. SQLSTATE 22003, never clamps.';

create trigger manual_valuations_value_in_range
  after insert on public.manual_valuations
  for each row execute function public.assert_holding_value_in_range();

create trigger acquisition_lots_value_in_range
  after insert or update of quantity_remaining, voided_at on public.acquisition_lots
  for each row execute function public.assert_holding_value_in_range();


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
  -- D-209: the first day on which a live disposal carries the lot's residual. From that day the
  -- residual is no longer on the lot, however many units are open (an out-of-order void brings units
  -- back; a backdated exhausting sale leaves units open on earlier days).
  residual_carried as materialized (
    select ld.lot_id, min(ld.disposed_on) as carried_on
    from public.lot_disposals ld
    join lots l on l.lot_id = ld.lot_id
    where ld.voided_at is null and ld.consumed_lot_residual and ld.disposed_on <= v_through
    group by ld.lot_id
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
           coalesce(sum(lv.qty_open * lv.unit_value::numeric)
             filter (where lv.unit_value is not null), 0)::numeric as cmv,
           coalesce(sum(lv.qty_open * lv.unit_value::numeric)
             filter (where lv.unit_value is not null and lv.cost_basis_state = 'known'), 0)::numeric as acmv,
           coalesce(sum(
             lv.qty_open * lq.unit_cost_basis_nok_minor
             + case when rc.carried_on <= lv.d then 0 else lq.residual_nok_minor end
             + floor(lv.adj_to_date::numeric * lv.qty_open / greatest(lq.quantity, 1))
           ) filter (where lv.cost_basis_state = 'known'), 0)::numeric as dcb,
           count(*)::bigint as open_lot_count,
           count(*) filter (where lv.unit_value is null)::bigint as unvalued_lot_count
    from lot_valued lv
    join lots lq on lq.lot_id = lv.lot_id
    left join residual_carried rc on rc.lot_id = lv.lot_id
    group by lv.d
  ),
  spend_by_day as materialized (
    select p.purchased_on as d,
           coalesce(sum(pl.attributable_cost_nok_minor)
             filter (where pl.spend_class = 'collectible'), 0)::numeric as cs_delta,
           coalesce(sum(pl.attributable_cost_nok_minor)
             filter (where pl.spend_class = 'hobby'), 0)::numeric as hs_delta
    from public.purchase_lines pl
    join public.purchases p on p.id = pl.purchase_id
    where pl.user_id = p_user_id
      and p.user_id = p_user_id
      and p.voided_at is null
      and p.purchased_on <= v_through
    group by p.purchased_on
  ),
  proceeds_by_day as materialized (
    select s.sold_on as d, sum(s.net_proceeds_nok_minor)::numeric as nsp_delta
    from public.sales s
    where s.user_id = p_user_id and s.voided_at is null and s.sold_on <= v_through
    group by s.sold_on
  ),
  spend_before as materialized (
    select coalesce(sum(pl.attributable_cost_nok_minor) filter (where pl.spend_class = 'collectible'), 0)::numeric as cs,
           coalesce(sum(pl.attributable_cost_nok_minor) filter (where pl.spend_class = 'hobby'), 0)::numeric as hs
    from public.purchase_lines pl
    join public.purchases p on p.id = pl.purchase_id
    where pl.user_id = p_user_id and p.voided_at is null and p.purchased_on < v_from
  ),
  proceeds_before as materialized (
    select coalesce(sum(s.net_proceeds_nok_minor), 0)::numeric as nsp
    from public.sales s
    where s.user_id = p_user_id and s.voided_at is null and s.sold_on < v_from
  ),
  -- Frozen-ledger cumulatives over the date spine: opening balance before the range plus a
  -- running sum of per-day deltas. Set-based window, no correlated per-date subquery.
  spine as materialized (
    select dt.d,
           sb.cs + coalesce(sum(sd.cs_delta) over (order by dt.d), 0)::numeric as cs,
           pb.nsp + coalesce(sum(pd.nsp_delta) over (order by dt.d), 0)::numeric as nsp
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



create or replace function public.get_dashboard_summary()
returns table (
  pending_recompute boolean,
  latest_snapshot_date date,
  first_tracked_date date,
  market_value_nok_minor text,
  market_value_has_coverage boolean,
  attributed_value_nok_minor text,
  cost_basis_nok_minor text,
  unrealized_result_nok_minor text,
  collectible_spend_to_date_nok_minor text,
  sales_proceeds_to_date_nok_minor text,
  ttep_nok_minor text,
  snapshot_open_lot_count text,
  snapshot_unvalued_lot_count text,
  physical_card_count text,
  unique_holding_count text,
  graded_holding_count text,
  sealed_holding_count text,
  sealed_unit_count text,
  manual_entry_count text,
  priced_holding_count text,
  unpriced_holding_count text,
  manual_valued_holding_count text,
  auto_priced_holding_count text,
  raw_value_nok_minor text,
  graded_value_nok_minor text,
  sealed_value_nok_minor text,
  uncosted_open_lot_count text,
  gpo_nok_minor text,
  cs_nok_minor text,
  hs_nok_minor text,
  nsp_nok_minor text,
  rrc_nok_minor text,
  pud_nok_minor text,
  ncco_nok_minor text,
  thco_nok_minor text,
  thp_nok_minor text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_variant_ids uuid[];
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  select array_agg(distinct h.card_variant_id) into v_variant_ids
    from public.holdings h
    where h.user_id = v_user and h.card_variant_id is not null and h.deleted_at is null;

  return query
  with snap as materialized (
    select s.*
    from public.portfolio_snapshots s
    where s.user_id = v_user
    order by s.snapshot_date desc
    limit 1
  ),
  first_tracked as materialized (
    select min(snapshot_date) as d from public.portfolio_snapshots where user_id = v_user
  ),
  -- Current-state counts and the raw/graded/sealed value breakdown — the same materialized-CTE
  -- shape portfolio_counts uses (D-054 discipline), resolved once, never recomputed per tile.
  lot_agg as materialized (
    select
      h.id as holding_id, h.holding_kind, h.card_variant_id, h.manual_card_id,
      coalesce(sum(l.quantity_remaining) filter (where l.voided_at is null), 0)::bigint as quantity,
      count(l.id) filter (
        where l.voided_at is null and l.quantity_remaining > 0
        and l.cost_basis_state <> 'known'
      ) as uncosted_lots
    from public.holdings h
    left join public.acquisition_lots l on l.holding_id = h.id
    where h.deleted_at is null and h.user_id = v_user
    group by h.id, h.holding_kind, h.card_variant_id, h.manual_card_id
  ),
  resolved as materialized (
    select r.card_variant_id, r.price_state, r.value_nok_minor::bigint as value_nok_minor
    from public.resolve_variant_market_values(coalesce(v_variant_ids, array[]::uuid[])) r
  ),
  owned as materialized (
    select la.*,
           mv.value_nok_minor as manual_value_nok_minor,
           (mv.value_nok_minor is not null) as is_manual_valued,
           case
             when mv.value_nok_minor is not null then mv.value_nok_minor
             when la.holding_kind = 'raw_card' and r.price_state in ('fresh', 'stale')
               then r.value_nok_minor
             else null
           end as unit_value_nok_minor
    from lot_agg la
    left join public.manual_valuations mv
      on mv.holding_id = la.holding_id and mv.superseded_at is null
    left join resolved r on r.card_variant_id = la.card_variant_id
    where la.quantity > 0
  ),
  live as materialized (
    select
      coalesce(sum(quantity), 0)::bigint as physical_card_count,
      count(*)::bigint as unique_holding_count,
      count(*) filter (where holding_kind = 'graded_card')::bigint as graded_holding_count,
      count(*) filter (where holding_kind = 'sealed')::bigint as sealed_holding_count,
      coalesce(sum(quantity) filter (where holding_kind = 'sealed'), 0)::bigint as sealed_unit_count,
      count(*) filter (where manual_card_id is not null)::bigint as manual_entry_count,
      count(*) filter (where unit_value_nok_minor is not null)::bigint as priced,
      count(*) filter (where unit_value_nok_minor is null)::bigint as unpriced,
      count(*) filter (where is_manual_valued)::bigint as manual_valued,
      count(*) filter (where unit_value_nok_minor is not null and not is_manual_valued)::bigint as auto_priced,
      coalesce(sum(unit_value_nok_minor::numeric * quantity)
        filter (where unit_value_nok_minor is not null and holding_kind = 'raw_card'), 0)::numeric as raw_value,
      coalesce(sum(unit_value_nok_minor::numeric * quantity)
        filter (where unit_value_nok_minor is not null and holding_kind = 'graded_card'), 0)::numeric as graded_value,
      coalesce(sum(unit_value_nok_minor::numeric * quantity)
        filter (where unit_value_nok_minor is not null and holding_kind = 'sealed'), 0)::numeric as sealed_value,
      coalesce(sum(uncosted_lots), 0)::bigint as uncosted_open_lots
    from owned
  ),
  ledger as materialized (
    select
      coalesce((select sum(p.total_nok_minor) from public.purchases p
                where p.user_id = v_user and p.voided_at is null), 0)::numeric as gpo,
      coalesce((select sum(pl.attributable_cost_nok_minor) from public.purchase_lines pl
                join public.purchases p on p.id = pl.purchase_id
                where pl.user_id = v_user and p.voided_at is null
                  and pl.spend_class = 'collectible'), 0)::numeric as cs,
      coalesce((select sum(pl.attributable_cost_nok_minor) from public.purchase_lines pl
                join public.purchases p on p.id = pl.purchase_id
                where pl.user_id = v_user and p.voided_at is null
                  and pl.spend_class = 'hobby'), 0)::numeric as hs,
      coalesce((select sum(s.net_proceeds_nok_minor) from public.sales s
                where s.user_id = v_user and s.voided_at is null), 0)::numeric as nsp,
      coalesce((select sum(sl.realized_result_nok_minor) from public.sale_lines sl
                join public.sales s on s.id = sl.sale_id
                where s.user_id = v_user and s.voided_at is null
                  and sl.cost_basis_at_sale_nok_minor is not null), 0)::numeric as rrc,
      coalesce((select sum(sl.net_proceeds_nok_minor) from public.sale_lines sl
                join public.sales s on s.id = sl.sale_id
                where s.user_id = v_user and s.voided_at is null
                  and sl.cost_basis_at_sale_nok_minor is null), 0)::numeric as pud
  )
  select
    public.m12_recompute_pending_for_self(),
    sn.snapshot_date,
    ft.d,
    (sn.market_value_nok_minor)::text,
    coalesce(sn.open_lot_count = 0 or sn.unvalued_lot_count < sn.open_lot_count, true),
    (sn.attributed_value_nok_minor)::text,
    (sn.cost_basis_nok_minor)::text,
    (sn.attributed_value_nok_minor - sn.cost_basis_nok_minor)::text,
    (sn.collectible_spend_to_date_nok_minor)::text,
    (sn.sales_proceeds_to_date_nok_minor)::text,
    (sn.market_value_nok_minor
     + sn.sales_proceeds_to_date_nok_minor
     - sn.collectible_spend_to_date_nok_minor)::text,
    (sn.open_lot_count)::text,
    (sn.unvalued_lot_count)::text,
    lv.physical_card_count::text,
    lv.unique_holding_count::text,
    lv.graded_holding_count::text,
    lv.sealed_holding_count::text,
    lv.sealed_unit_count::text,
    lv.manual_entry_count::text,
    lv.priced::text,
    lv.unpriced::text,
    lv.manual_valued::text,
    lv.auto_priced::text,
    lv.raw_value::text,
    lv.graded_value::text,
    lv.sealed_value::text,
    lv.uncosted_open_lots::text,
    ld.gpo::text,
    ld.cs::text,
    ld.hs::text,
    ld.nsp::text,
    ld.rrc::text,
    ld.pud::text,
    (ld.cs - ld.nsp)::text,
    (ld.gpo - ld.nsp)::text,
    -- THP = CMV + NSP − GPO, and CMV comes from the snapshot: no snapshot row yet means CMV is
    -- UNAVAILABLE, so THP is unavailable too — NULL, never a 0-based fabrication (the same
    -- missing-data rule ttep_nok_minor follows two lines up).
    (sn.market_value_nok_minor + ld.nsp - ld.gpo)::text
  from live lv
  cross join ledger ld
  left join snap sn on true
  left join first_tracked ft on true;
end;
$$;



create or replace function public.list_portfolio(
  p_sort public.portfolio_sort_order default 'value_desc',
  p_limit int default 30,
  p_query text default null,
  p_set_id uuid default null,
  p_condition public.card_condition default null,
  p_graded boolean default null,
  p_grader public.grader default null,
  p_favorite boolean default null,
  p_language text default null,
  p_manual_only boolean default null,
  p_custom_collection_id uuid default null,
  p_storage_location_id uuid default null,
  p_tag_id uuid default null,
  p_low_value boolean default null,
  p_missing_value boolean default null,
  p_cursor_holding_id uuid default null,
  p_cursor_name text default null,
  p_cursor_set_name text default null,
  p_cursor_quantity bigint default null,
  p_cursor_acquired_on date default null,
  p_cursor_added_at timestamptz default null,
  p_cursor_value_minor bigint default null,
  p_cursor_has_value boolean default null,
  p_cursor_number_key text default null,
  p_holding_kind public.holding_kind default null,
  p_sealed_product_type public.sealed_product_type default null,
  p_sealed_intent public.sealed_intent default null
)
returns table (
  holding_id uuid,
  holding_kind public.holding_kind,
  card_variant_id uuid,
  manual_card_id uuid,
  condition public.card_condition,
  grading_state public.grading_state,
  grader public.grader,
  grade numeric(3, 1),
  cert_number text,
  is_favorite boolean,
  notes text,
  created_at timestamptz,
  quantity bigint,
  lot_count bigint,
  variant_finish public.card_finish,
  variant_stamp text,
  variant_subtype text,
  card_name text,
  card_local_id text,
  card_image_base_url text,
  card_language text,
  card_set_id uuid,
  card_set_name text,
  manual_name text,
  manual_set_name text,
  manual_collector_number text,
  manual_language text,
  sealed_product_id uuid,
  sealed_product_type public.sealed_product_type,
  sealed_product_name text,
  sealed_product_language text,
  sealed_pack_count int,
  sealed_image_url text,
  sealed_set_id uuid,
  sealed_set_name text,
  sealed_is_custom boolean,
  qty_keep_sealed bigint,
  qty_planned_to_open bigint,
  qty_undecided bigint,
  unit_value_nok_minor text,
  holding_value_nok_minor text,
  price_state text,
  acquired_on_min date,
  acquired_on_max date,
  has_multiple_storage_locations boolean,
  number_sort_key text
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_limit int := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_threshold bigint;
  v_variant_ids uuid[];
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select p.low_value_threshold_minor into v_threshold
    from public.profiles p where p.id = v_user_id;

  select array_agg(distinct h.card_variant_id) into v_variant_ids
    from public.holdings h
    where h.user_id = v_user_id and h.card_variant_id is not null and h.deleted_at is null;

  return query
  with lot_agg as materialized (
    select
      h.id as holding_id,
      coalesce(sum(l.quantity_remaining) filter (where l.voided_at is null), 0)::bigint as quantity,
      count(l.id) filter (where l.voided_at is null and l.quantity_remaining > 0) as lot_count,
      min(l.acquired_on) filter (where l.voided_at is null) as acquired_min,
      max(l.acquired_on) filter (where l.voided_at is null) as acquired_max,
      count(distinct l.storage_location_id) filter (
        where l.voided_at is null and l.storage_location_id is not null
      ) as storage_location_count,
      -- M11: per-intent remaining-quantity breakdown, one pass, no second scan of acquisition_lots.
      coalesce(sum(l.quantity_remaining) filter (
        where l.voided_at is null and l.sealed_intent = 'keep_sealed'
      ), 0)::bigint as qty_keep_sealed,
      coalesce(sum(l.quantity_remaining) filter (
        where l.voided_at is null and l.sealed_intent = 'planned_to_open'
      ), 0)::bigint as qty_planned_to_open,
      coalesce(sum(l.quantity_remaining) filter (
        where l.voided_at is null and l.sealed_intent = 'undecided'
      ), 0)::bigint as qty_undecided
    from public.holdings h
    left join public.acquisition_lots l on l.holding_id = h.id
    where h.deleted_at is null and h.user_id = v_user_id
    group by h.id
  ),
  resolved as materialized (
    select r.card_variant_id, r.price_state, r.value_nok_minor::bigint as value_nok_minor
    from public.resolve_variant_market_values(coalesce(v_variant_ids, array[]::uuid[])) r
  )
  select
    h.id,
    h.holding_kind,
    h.card_variant_id,
    h.manual_card_id,
    h.condition,
    h.grading_state,
    h.grader,
    h.grade,
    h.cert_number,
    h.is_favorite,
    h.notes,
    h.created_at,
    q.quantity,
    q.lot_count,
    cv.finish,
    cv.stamp,
    cv.subtype,
    c.name,
    c.local_id,
    c.image_base_url,
    c.language,
    cs.id,
    cs.name,
    mc.name,
    mc.set_name,
    mc.collector_number,
    mc.language,
    h.sealed_product_id,
    sp.product_type,
    sp.name,
    sp.language,
    sp.pack_count,
    sp.image_url,
    sp_set.id,
    sp_set.name,
    (sp.created_by_user_id is not null),
    q.qty_keep_sealed,
    q.qty_planned_to_open,
    q.qty_undecided,
    val.unit_value_nok_minor::text,
    val.holding_value_nok_minor::text,
    val.price_state,
    q.acquired_min,
    q.acquired_max,
    q.storage_location_count > 1,
    public.natural_sort_key(coalesce(c.local_id, mc.collector_number, ''))
  from lot_agg q
  join public.holdings h on h.id = q.holding_id
  left join public.card_variants cv on cv.id = h.card_variant_id
  left join public.cards c on c.id = cv.card_id
  left join public.card_sets cs on cs.id = c.set_id
  left join public.manual_card_definitions mc on mc.id = h.manual_card_id
  left join public.sealed_products sp on sp.id = h.sealed_product_id
  left join public.card_sets sp_set on sp_set.id = sp.set_id
  left join public.manual_valuations mv on mv.holding_id = h.id and mv.superseded_at is null
  left join resolved r on r.card_variant_id = h.card_variant_id
  -- F10: a raw provider price never values a graded or sealed holding, regardless of what the
  -- resolver returned for the underlying printing's card_variant_id (sealed holdings never have a
  -- card_variant_id in the first place, so r is already null for them via the join above — this
  -- branch is unchanged from M9). This LATERAL is pure computation over already-joined row-local
  -- values (no table scan inside it) — purely so the CASE expressions below can be written once and
  -- reused in SELECT/WHERE/ORDER BY; it is not the per-holding correlated-subquery-against-a-table
  -- pattern the migration header's perf note is about.
  cross join lateral (
    select
      case
        when mv.value_nok_minor is not null then mv.value_nok_minor
        when h.holding_kind = 'raw_card' and r.price_state in ('fresh', 'stale') then r.value_nok_minor
        else null
      end as unit_value_nok_minor,
      case
        when mv.value_nok_minor is not null then 'manual'
        when h.holding_kind = 'raw_card' then coalesce(r.price_state, 'missing')
        else 'missing'
      end as price_state
  ) resolved_case
  cross join lateral (
    select
      resolved_case.unit_value_nok_minor,
      resolved_case.price_state,
      case
        when resolved_case.unit_value_nok_minor is not null then resolved_case.unit_value_nok_minor::numeric * q.quantity
        else null
      end as holding_value_nok_minor
  ) val
  where q.quantity > 0
    and (p_query is null or btrim(p_query) = ''
         or c.name ilike '%' || p_query || '%'
         or mc.name ilike '%' || p_query || '%'
         or sp.name ilike '%' || p_query || '%')
    and (p_set_id is null or coalesce(cs.id, sp_set.id) = p_set_id)
    and (p_condition is null or h.condition = p_condition)
    and (p_graded is null
         or (p_graded and h.grading_state = 'graded')
         or (not p_graded and h.grading_state <> 'graded'))
    and (p_grader is null or h.grader = p_grader)
    and (p_favorite is null or h.is_favorite = p_favorite)
    and (p_language is null or coalesce(c.language, mc.language, sp.language) = p_language)
    and (p_manual_only is null
         or (p_manual_only and h.manual_card_id is not null)
         or (not p_manual_only and h.manual_card_id is null))
    and (p_custom_collection_id is null or exists (
      select 1 from public.custom_collection_members m
      where m.holding_id = h.id and m.collection_id = p_custom_collection_id
        and m.user_id = v_user_id
    ))
    and (p_storage_location_id is null or exists (
      select 1 from public.acquisition_lots l2
      where l2.holding_id = h.id and l2.voided_at is null
        and l2.storage_location_id = p_storage_location_id
    ))
    and (p_tag_id is null or exists (
      select 1 from public.holding_tags t where t.holding_id = h.id and t.tag_id = p_tag_id
    ))
    -- M11: Portfolio's type filter (All/Raw/Graded/Sealed) and sealed-only refinements.
    and (p_holding_kind is null or h.holding_kind = p_holding_kind)
    and (p_sealed_product_type is null or sp.product_type = p_sealed_product_type)
    and (p_sealed_intent is null or exists (
      select 1 from public.acquisition_lots l3
      where l3.holding_id = h.id and l3.voided_at is null and l3.quantity_remaining > 0
        and l3.sealed_intent = p_sealed_intent
    ))
    -- Low value / missing value: the per-item UNIT value (DATA_MODEL.md §5.2.2 — "is this specific
    -- card cheap" is per-printing, not "is my whole stack of it cheap"). Already correct for sealed:
    -- val.unit_value_nok_minor resolves to manual-or-null for any non-raw-card holding.
    and (p_low_value is not true or (val.unit_value_nok_minor is not null and val.unit_value_nok_minor <= v_threshold))
    and (p_missing_value is not true or val.unit_value_nok_minor is null)
    and (
      p_cursor_holding_id is null
      or (
        (p_sort = 'name_asc' and (lower(coalesce(c.name, mc.name, sp.name, '')), h.id)
           > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
        or (p_sort = 'name_desc' and (lower(coalesce(c.name, mc.name, sp.name, '')), h.id)
           < (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
        or (p_sort = 'set_asc' and (lower(coalesce(cs.name, mc.set_name, sp_set.name, '')), h.id)
           > (lower(coalesce(p_cursor_set_name, '')), p_cursor_holding_id))
        or (p_sort = 'quantity_desc' and (q.quantity, h.id)
           < (coalesce(p_cursor_quantity, 0), p_cursor_holding_id))
        or (p_sort = 'added_newest' and (h.created_at, h.id)
           < (coalesce(p_cursor_added_at, now()), p_cursor_holding_id))
        or (p_sort = 'added_oldest' and (h.created_at, h.id)
           > (coalesce(p_cursor_added_at, now()), p_cursor_holding_id))
        or (p_sort = 'acquired_newest' and (coalesce(q.acquired_max, h.created_at::date), h.id)
           < (coalesce(p_cursor_acquired_on, current_date), p_cursor_holding_id))
        or (p_sort = 'acquired_oldest' and (coalesce(q.acquired_min, h.created_at::date), h.id)
           > (coalesce(p_cursor_acquired_on, current_date), p_cursor_holding_id))
        or (p_sort = 'number_asc' and (
          public.natural_sort_key(coalesce(c.local_id, mc.collector_number, '')), h.id
        ) > (coalesce(p_cursor_number_key, ''), p_cursor_holding_id))
        or (p_sort = 'number_desc' and (
          public.natural_sort_key(coalesce(c.local_id, mc.collector_number, '')), h.id
        ) < (coalesce(p_cursor_number_key, ''), p_cursor_holding_id))
        or (p_sort = 'value_desc' and (
          (val.holding_value_nok_minor is not null and coalesce(p_cursor_has_value, false) and (
            val.holding_value_nok_minor < coalesce(p_cursor_value_minor, 0)
            or (val.holding_value_nok_minor = coalesce(p_cursor_value_minor, 0)
                and (lower(coalesce(c.name, mc.name, sp.name, '')), h.id)
                    > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
          ))
          or (val.holding_value_nok_minor is null and coalesce(p_cursor_has_value, false))
          or (val.holding_value_nok_minor is null and not coalesce(p_cursor_has_value, false)
              and (lower(coalesce(c.name, mc.name, sp.name, '')), h.id)
                  > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
        ))
        or (p_sort = 'value_asc' and (
          (val.holding_value_nok_minor is not null and coalesce(p_cursor_has_value, false) and (
            val.holding_value_nok_minor > coalesce(p_cursor_value_minor, 0)
            or (val.holding_value_nok_minor = coalesce(p_cursor_value_minor, 0)
                and (lower(coalesce(c.name, mc.name, sp.name, '')), h.id)
                    > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
          ))
          or (val.holding_value_nok_minor is null and coalesce(p_cursor_has_value, false))
          or (val.holding_value_nok_minor is null and not coalesce(p_cursor_has_value, false)
              and (lower(coalesce(c.name, mc.name, sp.name, '')), h.id)
                  > (lower(coalesce(p_cursor_name, '')), p_cursor_holding_id))
        ))
      )
    )
  order by
    case when p_sort in ('value_desc', 'value_asc') and val.holding_value_nok_minor is not null then 0
         when p_sort in ('value_desc', 'value_asc') then 1
         else 0 end,
    case when p_sort = 'value_desc' then val.holding_value_nok_minor end desc,
    case when p_sort = 'value_asc' then val.holding_value_nok_minor end asc,
    case when p_sort = 'quantity_desc' then q.quantity end desc,
    case when p_sort = 'added_newest' then h.created_at end desc,
    case when p_sort = 'added_oldest' then h.created_at end asc,
    case when p_sort = 'acquired_newest' then coalesce(q.acquired_max, h.created_at::date) end desc,
    case when p_sort = 'acquired_oldest' then coalesce(q.acquired_min, h.created_at::date) end asc,
    case when p_sort = 'number_asc'
      then public.natural_sort_key(coalesce(c.local_id, mc.collector_number, '')) end asc,
    case when p_sort = 'number_desc'
      then public.natural_sort_key(coalesce(c.local_id, mc.collector_number, '')) end desc,
    case when p_sort = 'set_asc' then lower(coalesce(cs.name, mc.set_name, sp_set.name, '')) end asc,
    case when p_sort = 'name_desc' then lower(coalesce(c.name, mc.name, sp.name, '')) end desc,
    lower(coalesce(c.name, mc.name, sp.name, '')) asc,
    h.id asc
  limit v_limit;
end;
$$;



create or replace function public.portfolio_counts(p_custom_collection_id uuid default null)
returns table (
  physical_card_count text,
  unique_holding_count text,
  graded_count text,
  manual_count text,
  priced_holding_count text,
  unpriced_holding_count text,
  portfolio_value_nok_minor text,
  cards_value_nok_minor text,
  sealed_value_nok_minor text,
  sealed_holding_count text,
  sealed_priced_holding_count text,
  sealed_unpriced_holding_count text,
  sealed_unit_count text
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_variant_ids uuid[];
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select array_agg(distinct h.card_variant_id) into v_variant_ids
    from public.holdings h
    where h.user_id = v_user_id and h.card_variant_id is not null and h.deleted_at is null;

  return query
  with lot_agg as materialized (
    select
      h.id as holding_id,
      h.holding_kind,
      h.card_variant_id,
      h.manual_card_id,
      coalesce(sum(l.quantity_remaining) filter (where l.voided_at is null), 0)::bigint as quantity
    from public.holdings h
    left join public.acquisition_lots l on l.holding_id = h.id
    where h.deleted_at is null and h.user_id = v_user_id
      and (p_custom_collection_id is null or exists (
        select 1 from public.custom_collection_members m
        where m.holding_id = h.id and m.collection_id = p_custom_collection_id
          and m.user_id = v_user_id
      ))
    group by h.id, h.holding_kind, h.card_variant_id, h.manual_card_id
  ),
  resolved as materialized (
    select r.card_variant_id, r.price_state, r.value_nok_minor::bigint as value_nok_minor
    from public.resolve_variant_market_values(coalesce(v_variant_ids, array[]::uuid[])) r
  ),
  owned as materialized (
    select
      la.*,
      mv.value_nok_minor as manual_value_nok_minor,
      case
        when mv.value_nok_minor is not null then mv.value_nok_minor
        when la.holding_kind = 'raw_card' and r.price_state in ('fresh', 'stale') then r.value_nok_minor
        else null
      end as unit_value_nok_minor
    from lot_agg la
    left join public.manual_valuations mv on mv.holding_id = la.holding_id and mv.superseded_at is null
    left join resolved r on r.card_variant_id = la.card_variant_id
    where la.quantity > 0
  )
  select
    coalesce(sum(quantity), 0)::text,
    count(*)::text,
    count(*) filter (where holding_kind = 'graded_card')::text,
    count(*) filter (where manual_card_id is not null)::text,
    count(*) filter (where unit_value_nok_minor is not null)::text,
    count(*) filter (where unit_value_nok_minor is null)::text,
    coalesce(sum(unit_value_nok_minor::numeric * quantity) filter (where unit_value_nok_minor is not null), 0)::text,
    coalesce(sum(unit_value_nok_minor::numeric * quantity)
      filter (where unit_value_nok_minor is not null and holding_kind <> 'sealed'), 0)::text,
    coalesce(sum(unit_value_nok_minor::numeric * quantity)
      filter (where unit_value_nok_minor is not null and holding_kind = 'sealed'), 0)::text,
    count(*) filter (where holding_kind = 'sealed')::text,
    count(*) filter (where holding_kind = 'sealed' and unit_value_nok_minor is not null)::text,
    count(*) filter (where holding_kind = 'sealed' and unit_value_nok_minor is null)::text,
    coalesce(sum(quantity) filter (where holding_kind = 'sealed'), 0)::text
  from owned;
end;
$$;



create or replace function public.get_holding_value_provenance(p_holding_id uuid)
returns table (
  price_state text,
  unit_value_nok_minor text,
  quantity text,
  holding_value_nok_minor text,
  provider public.price_provider,
  price_kind public.price_kind,
  source_currency text,
  source_value_minor text,
  fx_rate numeric,
  snapshot_date date,
  provider_updated_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_holding record;
  v_quantity bigint;
  v_manual_value bigint;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  select h.id, h.holding_kind, h.card_variant_id
    into v_holding
    from public.holdings h
    where h.id = p_holding_id and h.user_id = v_user_id;

  if v_holding.id is null then
    raise exception 'holding % not found', p_holding_id;
  end if;

  select coalesce(sum(l.quantity_remaining) filter (where l.voided_at is null), 0)::bigint
    into v_quantity
    from public.acquisition_lots l
    where l.holding_id = p_holding_id;

  select mv.value_nok_minor into v_manual_value
    from public.manual_valuations mv
    where mv.holding_id = p_holding_id and mv.superseded_at is null;

  if v_manual_value is not null then
    return query select
      'manual'::text, v_manual_value::text, v_quantity::text, (v_manual_value::numeric * v_quantity)::text,
      null::public.price_provider, null::public.price_kind, null::text, null::text,
      null::numeric, null::date, null::timestamptz;
    return;
  end if;

  if v_holding.holding_kind <> 'raw_card' or v_holding.card_variant_id is null then
    return query select
      'missing'::text, null::text, v_quantity::text, null::text,
      null::public.price_provider, null::public.price_kind, null::text, null::text,
      null::numeric, null::date, null::timestamptz;
    return;
  end if;

  -- resolve_variant_market_values only returns a row for a variant that has at least one
  -- snapshot ever (its GROUP BY produces no group otherwise) — a variant with zero history
  -- must still resolve to exactly one "missing" row here, so this is a LEFT JOIN against a
  -- single-row source, never a bare `FROM resolve_variant_market_values(...)` that would
  -- silently return zero rows instead.
  return query
  select
    coalesce(r.price_state, 'missing'),
    r.value_nok_minor,
    v_quantity::text,
    (r.value_nok_minor::numeric * v_quantity)::text,
    r.provider, r.price_kind, r.source_currency, r.source_value_minor, r.fx_rate,
    r.snapshot_date, r.provider_updated_at
  from (select v_holding.card_variant_id as cvid) x
  left join public.resolve_variant_market_values(array[v_holding.card_variant_id]) r
    on r.card_variant_id = x.cvid;
end;
$$;



create or replace function public.get_opening(p_opening_id uuid)
returns table (
  id uuid,
  opened_on date,
  sealed_product_id uuid,
  sealed_product_name text,
  source_lot_id uuid,
  quantity_opened int,
  cost_source public.opening_cost_source,
  cost_nok_minor text,
  tracking_completeness public.opening_tracking,
  bulk_remainder_estimate_nok_minor text,
  bulk_remainder_count int,
  provisional_purchase_id uuid,
  reconciled_at timestamptz,
  reconciled_to_purchase_id uuid,
  notes text,
  voided_at timestamptz,
  created_at timestamptz,
  retained_tracked_value_nok_minor text,
  priced_pull_lot_count int,
  unpriced_pull_lot_count int,
  sold_pull_lot_count int,
  net_proceeds_from_sold_pulls_nok_minor text,
  opening_return_nok_minor text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with opening as materialized (
    select o.*
    from public.openings o
    where o.id = p_opening_id and o.user_id = auth.uid()
  ),
  -- RETAINED live pulls of this opening (quantity_remaining > 0), each carrying its holding's
  -- active manual valuation if one exists (the partial unique index guarantees at most one
  -- active row per holding). P56 §8 (P54 finding L1): priced/unpriced counts and retained value
  -- are explicitly a CURRENT-INVENTORY frame — a pull lot fully sold out of this opening is NOT
  -- coverage for cards still here and is excluded here entirely. Sold provenance is reported
  -- separately by sold_pull_lot_count/net proceeds below, which keep counting every lot the
  -- opening ever produced.
  pulls as materialized (
    select l.id as lot_id, h.card_variant_id, l.quantity_remaining,
           mv.value_nok_minor as manual_value
    from public.acquisition_lots l
    join public.holdings h on h.id = l.holding_id
    left join public.manual_valuations mv
      on mv.holding_id = h.id and mv.superseded_at is null
    where l.opening_id = (select o.id from opening o)
      and l.user_id = auth.uid()
      and l.voided_at is null
      and l.quantity_remaining > 0
  ),
  variant_ids as (
    select coalesce(array_agg(distinct p.card_variant_id), '{}') as ids
    from pulls p
    where p.card_variant_id is not null
  ),
  -- ONE resolver call for ALL distinct variants (D-054 discipline) — never per row.
  resolved as materialized (
    select r.card_variant_id, r.price_state, r.value_nok_minor
    from public.resolve_variant_market_values((select ids from variant_ids)) r
    where r.price_state in ('fresh', 'stale')
  ),
  pull_value as materialized (
    select
      p.lot_id,
      case
        when p.manual_value is not null then p.manual_value::numeric * p.quantity_remaining
        when rv.value_nok_minor is not null then rv.value_nok_minor::numeric * p.quantity_remaining
        else 0
      end as value_component,
      (p.manual_value is not null or rv.value_nok_minor is not null)::int as priced,
      (p.manual_value is null and rv.value_nok_minor is null)::int as unpriced
    from pulls p
    left join resolved rv on rv.card_variant_id = p.card_variant_id
  ),
  retained as (
    select coalesce(sum(pv.value_component), 0)::numeric as total,
           coalesce(sum(pv.priced), 0)::int as priced_count,
           coalesce(sum(pv.unpriced), 0)::int as unpriced_count
    from pull_value pv
  ),
  proceeds as (
    select count(distinct sl.lot_id)::int as sold_lot_count,
           coalesce(sum(sl.net_proceeds_nok_minor), 0)::numeric as total
    from public.sale_lines sl
    join public.sales s on s.id = sl.sale_id
    join public.acquisition_lots al on al.id = sl.lot_id
    where al.opening_id = (select o.id from opening o)
      and s.voided_at is null
  )
  select o.id, o.opened_on, o.sealed_product_id, sp.name, o.source_lot_id, o.quantity_opened,
         o.cost_source, o.cost_nok_minor::text, o.tracking_completeness,
         o.bulk_remainder_estimate_nok_minor::text, o.bulk_remainder_count,
         o.provisional_purchase_id, o.reconciled_at, o.reconciled_to_purchase_id,
         o.notes, o.voided_at, o.created_at,
         r.total::text, r.priced_count, r.unpriced_count, pr.sold_lot_count, pr.total::text,
         (case when o.cost_nok_minor is null then null::numeric
               else r.total + pr.total + coalesce(o.bulk_remainder_estimate_nok_minor, 0)
                    - o.cost_nok_minor
          end)::text
  from opening o
  join public.sealed_products sp on sp.id = o.sealed_product_id
  cross join retained r
  cross join proceeds pr;
$$;
