-- M12 Dashboard — bounded browser read surface (prompt Part F).
--
-- Four coherent RPCs replace "15 independent lifetime aggregate requests" on Home:
--   get_dashboard_summary()   headline figures from the LATEST SNAPSHOT (UX_FLOWS.md F10: no
--                             per-card computation on page load) plus current data-quality /
--                             breakdown counts and lifetime ledger figures, in ONE request,
--                             plus an honest pending_recompute flag (prompt §67).
--   get_portfolio_history()   the chart series: stored NOK snapshots over a bounded range,
--                             optionally converted to EUR/USD with the HISTORICAL rule
--                             (snapshot-date-appropriate FX, prompt §77/D-067). Main Portfolio
--                             scope only — custom collections have no canonical membership
--                             history (D-065) and this function is deliberately unscoped.
--   get_monthly_spend()       calendar-month CS/HS/GPO straight from purchase_lines (purchases
--                             are the simpler truth than snapshots here, prompt §83).
--   get_recent_activity()     small bounded union over canonical events only (prompt §87) —
--                             acquisitions, purchases, sales, manual valuations. No event-
--                             sourcing table is invented for a feed.
--
-- All SECURITY INVOKER (every predicate derives from auth.uid(); nothing to forge), all money
-- columns cast to text (PostgREST bigint boundary, DATA_MODEL.md §14).

-- Internal helper for the pending flag: the queue itself is service-only (no browser grant,
-- prompt §93), so an INVOKER summary cannot read it directly. This DEFINER wrapper answers
-- exactly one question about exactly one user — auth.uid(), never a caller-supplied id — and
-- is itself revoked from every browser-reachable role, so it is reachable ONLY through
-- get_dashboard_summary().
create or replace function public.m12_recompute_pending_for_self()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.portfolio_recompute_queue q where q.user_id = auth.uid()
  );
$$;

revoke execute on function public.m12_recompute_pending_for_self()
  from public, anon, authenticated;

-- ── get_dashboard_summary ────────────────────────────────────────────────────────────────────

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
      coalesce(sum(unit_value_nok_minor * quantity)
        filter (where unit_value_nok_minor is not null and holding_kind = 'raw_card'), 0)::bigint as raw_value,
      coalesce(sum(unit_value_nok_minor * quantity)
        filter (where unit_value_nok_minor is not null and holding_kind = 'graded_card'), 0)::bigint as graded_value,
      coalesce(sum(unit_value_nok_minor * quantity)
        filter (where unit_value_nok_minor is not null and holding_kind = 'sealed'), 0)::bigint as sealed_value,
      coalesce(sum(uncosted_lots), 0)::bigint as uncosted_open_lots
    from owned
  ),
  ledger as materialized (
    select
      coalesce((select sum(p.total_nok_minor) from public.purchases p
                where p.user_id = v_user and p.voided_at is null), 0)::bigint as gpo,
      coalesce((select sum(pl.attributable_cost_nok_minor) from public.purchase_lines pl
                join public.purchases p on p.id = pl.purchase_id
                where pl.user_id = v_user and p.voided_at is null
                  and pl.spend_class = 'collectible'), 0)::bigint as cs,
      coalesce((select sum(pl.attributable_cost_nok_minor) from public.purchase_lines pl
                join public.purchases p on p.id = pl.purchase_id
                where pl.user_id = v_user and p.voided_at is null
                  and pl.spend_class = 'hobby'), 0)::bigint as hs,
      coalesce((select sum(s.net_proceeds_nok_minor) from public.sales s
                where s.user_id = v_user and s.voided_at is null), 0)::bigint as nsp,
      coalesce((select sum(sl.realized_result_nok_minor) from public.sale_lines sl
                join public.sales s on s.id = sl.sale_id
                where s.user_id = v_user and s.voided_at is null
                  and sl.cost_basis_at_sale_nok_minor is not null), 0)::bigint as rrc,
      coalesce((select sum(sl.net_proceeds_nok_minor) from public.sale_lines sl
                join public.sales s on s.id = sl.sale_id
                where s.user_id = v_user and s.voided_at is null
                  and sl.cost_basis_at_sale_nok_minor is null), 0)::bigint as pud
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

comment on function public.get_dashboard_summary() is
  'M12 Home headline: latest-snapshot CMV/TTEP/spend/proceeds cumulatives, current data-quality '
  'and raw/graded/sealed breakdown, lifetime GPO/CS/HS/NSP/RRC/PUD/NCCO/THCO/THP, and an honest '
  'pending_recompute flag — one bounded request. Headline comes from the cache, never a per-card '
  'recompute on load (UX_FLOWS.md F10).';

grant execute on function public.get_dashboard_summary() to authenticated;
revoke execute on function public.get_dashboard_summary() from public;

-- ── get_portfolio_history ────────────────────────────────────────────────────────────────────
-- Stored snapshots only. Display conversion follows D-067: a NOK point on D converts with the
-- FX observation on/before D, so EUR/USD history legitimately includes FX movement. Storage is
-- never rewritten and frozen transactional FX is never consulted.

create or replace function public.get_portfolio_history(
  p_display_currency text default null,
  p_from date default null,
  p_to date default null
)
returns table (
  snapshot_date date,
  market_value_nok_minor text,
  has_coverage boolean,
  open_lot_count text,
  unvalued_lot_count text,
  display_value_minor text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_ccy text := upper(coalesce(p_display_currency, 'NOK'));
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;
  if v_ccy not in ('NOK', 'EUR', 'USD') then
    raise exception 'unsupported display currency';
  end if;

  return query
  with hist as materialized (
    select s.snapshot_date, s.market_value_nok_minor, s.open_lot_count, s.unvalued_lot_count
    from public.portfolio_snapshots s
    where s.user_id = v_user
      and s.snapshot_date <= current_date
      -- Bounded MAX window (4 years) — the oldest rows are the ones dropped when a range
      -- exceeds the cap, never the recent ones.
      and s.snapshot_date >= greatest(coalesce(p_from, current_date - 1460), current_date - 1460)
      and s.snapshot_date <= coalesce(p_to, current_date)
    order by s.snapshot_date desc
    limit 4000
  ),
  fx as materialized (
    select distinct h.snapshot_date,
      (
        select fr.rate from public.fx_rates fr
        where fr.base_currency = v_ccy
          and fr.quote_currency = 'NOK'
          and fr.source = 'norges_bank'
          and fr.rate_date <= h.snapshot_date
        order by fr.rate_date desc
        limit 1
      ) as rate
    from hist h
    where v_ccy <> 'NOK'
  )
  select
    h.snapshot_date,
    h.market_value_nok_minor::text,
    h.unvalued_lot_count < h.open_lot_count,
    h.open_lot_count::text,
    h.unvalued_lot_count::text,
    case
      when v_ccy = 'NOK' then h.market_value_nok_minor::text
      when fx.rate is not null then round(h.market_value_nok_minor / fx.rate)::text
      else null
    end
  from hist h
  left join fx on fx.snapshot_date = h.snapshot_date
  order by h.snapshot_date asc;
end;
$$;

comment on function public.get_portfolio_history(text, date, date) is
  'M12 chart series: stored NOK daily snapshots (main-portfolio scope only — custom collections '
  'have no canonical membership history, D-065). has_coverage=false marks a day whose open lots '
  'were entirely unresolvable — the UI renders a gap, never a zero-valued point (prompt §33).';

grant execute on function public.get_portfolio_history(text, date, date) to authenticated;
revoke execute on function public.get_portfolio_history(text, date, date) from public;

-- ── get_monthly_spend ────────────────────────────────────────────────────────────────────────
-- Calendar months straight from purchase_lines under business-date semantics. GPO = CS + HS per
-- month holds by construction (both sums partition the same rows) — asserted in tests (F1).

create or replace function public.get_monthly_spend(p_months int default 12)
returns table (
  month date,
  collectible_nok_minor text,
  hobby_nok_minor text,
  total_nok_minor text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with bounds as (
    select greatest(least(coalesce(p_months, 12), 24), 1) as n
  ),
  months as (
    select generate_series(
      date_trunc('month', current_date) - ((b.n - 1) || ' months')::interval,
      date_trunc('month', current_date),
      interval '1 month'
    )::date as month
    from bounds b
  ),
  spend as (
    select date_trunc('month', p.purchased_on)::date as month,
           coalesce(sum(pl.attributable_cost_nok_minor)
             filter (where pl.spend_class = 'collectible'), 0)::bigint as cs,
           coalesce(sum(pl.attributable_cost_nok_minor)
             filter (where pl.spend_class = 'hobby'), 0)::bigint as hs
    from public.purchase_lines pl
    join public.purchases p on p.id = pl.purchase_id
    where pl.user_id = auth.uid()
      and p.user_id = auth.uid()
      and p.voided_at is null
    group by 1
  )
  select m.month,
         coalesce(s.cs, 0)::text,
         coalesce(s.hs, 0)::text,
         (coalesce(s.cs, 0) + coalesce(s.hs, 0))::text
  from months m
  left join spend s on s.month = m.month
  order by m.month asc;
$$;

comment on function public.get_monthly_spend(int) is
  'M12 monthly spending view (last N calendar months, max 24): collectible vs hobby vs total, '
  'from non-voided purchase lines. Zero months are real empty months, not missing data.';

grant execute on function public.get_monthly_spend(int) to authenticated;
revoke execute on function public.get_monthly_spend(int) from public;

-- ── get_recent_activity ──────────────────────────────────────────────────────────────────────
-- Bounded union over canonical events (prompt §87). Purchase-origin lots are excluded — their
-- purchase row is already the activity entry; counting both would double-report one action.

create or replace function public.get_recent_activity(p_limit int default 8)
returns table (
  activity_type text,
  primary_id uuid,
  secondary_id uuid,
  occurred_on date,
  amount_nok_minor text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from (
    select 'purchase'::text, p.id, null::uuid, p.purchased_on,
           p.total_nok_minor::text
    from public.purchases p
    where p.user_id = auth.uid() and p.voided_at is null
    union all
    select 'sale'::text, s.id, null::uuid, s.sold_on,
           s.net_proceeds_nok_minor::text
    from public.sales s
    where s.user_id = auth.uid() and s.voided_at is null
    union all
    select 'valuation'::text, mv.id, mv.holding_id,
           cast(mv.created_at as date), mv.value_nok_minor::text
    from public.manual_valuations mv
    where mv.user_id = auth.uid() and mv.superseded_at is null
    union all
    select 'acquisition'::text, l.id, l.holding_id, l.acquired_on,
           (case when l.unit_cost_basis_nok_minor is not null
                 then l.unit_cost_basis_nok_minor * l.quantity end)::text
    from public.acquisition_lots l
    where l.user_id = auth.uid() and l.voided_at is null
      and l.origin <> 'purchase'
  ) as acts(activity_type, primary_id, secondary_id, occurred_on, amount_nok_minor)
  order by acts.occurred_on desc
  limit least(greatest(coalesce(p_limit, 8), 1), 20);
$$;

comment on function public.get_recent_activity(int) is
  'M12 optional recent-activity feed: a bounded union over canonical purchases, sales, active '
  'manual valuations and non-purchase acquisitions. No audit-event table invented for a feed.';

grant execute on function public.get_recent_activity(int) to authenticated;
revoke execute on function public.get_recent_activity(int) from public;
