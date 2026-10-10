-- P209 / D-211: Home discloses what the live value is built from (FINANCIAL_MODEL.md E9).
--
-- E9: "the card row and the dashboard both show a staleness marker with the snapshot date". The card
-- row did; the dashboard did not, so a portfolio priced from 20-day-old observations looked exactly
-- like one priced this morning. get_dashboard_summary gains four columns, all computed in the same
-- resolver pass as the live value they describe:
--
--   stale_priced_holding_count          holdings valued from a provider observation 4-30 days old
--   oldest_price_date                   the oldest observation date among provider-valued holdings;
--                                       NULL when no holding is valued from a provider price
--   zero_valued_holding_count           holdings whose value is exactly 0 (a value, not a gap)
--   unpriced_manual_only_holding_count  unpriced holdings no provider price can value (graded, sealed
--                                       and custom cards: they need a manual valuation)
--
-- The return type changes, so the function is dropped and re-created with its previous grants.
-- Existing columns keep their names, order and meaning; the client reads columns by name.
-- This restates the D-210 definition (numeric products and sums) with the additions only.

drop function public.get_dashboard_summary();

create function public.get_dashboard_summary()
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
  thp_nok_minor text,
  -- D-211: what the live figure is built from. Counts are holdings with copies on hand.
  stale_priced_holding_count text,
  oldest_price_date date,
  zero_valued_holding_count text,
  unpriced_manual_only_holding_count text
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
    select r.card_variant_id, r.price_state, r.snapshot_date,
           r.value_nok_minor::bigint as value_nok_minor
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
           end as unit_value_nok_minor,
           -- Valued from a provider observation (not a manual valuation): its state and date.
           case when mv.value_nok_minor is null and la.holding_kind = 'raw_card'
                     and r.price_state in ('fresh', 'stale') then r.price_state end as provider_state,
           case when mv.value_nok_minor is null and la.holding_kind = 'raw_card'
                     and r.price_state in ('fresh', 'stale') then r.snapshot_date end as provider_price_date
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
      coalesce(sum(uncosted_lots), 0)::bigint as uncosted_open_lots,
      count(*) filter (where provider_state = 'stale')::bigint as stale_priced,
      min(provider_price_date) as oldest_price_date,
      -- A valuation of exactly 0 is a value (a manual 0 or a provider quote of 0); it is counted
      -- apart from "no price", which stays NULL and is never summed as 0.
      count(*) filter (where unit_value_nok_minor = 0)::bigint as zero_valued,
      -- Unpriced holdings that no provider price can ever value: graded, sealed and custom cards
      -- need a manual valuation; the rest are raw cards with no usable observation (<= 30 days).
      count(*) filter (
        where unit_value_nok_minor is null
          and (holding_kind <> 'raw_card' or card_variant_id is null)
      )::bigint as unpriced_manual_only
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
    (sn.market_value_nok_minor + ld.nsp - ld.gpo)::text,
    lv.stale_priced::text,
    lv.oldest_price_date,
    lv.zero_valued::text,
    lv.unpriced_manual_only::text
  from live lv
  cross join ledger ld
  left join snap sn on true
  left join first_tracked ft on true;
end;
$$;

grant execute on function public.get_dashboard_summary() to authenticated;
revoke execute on function public.get_dashboard_summary() from public;

comment on function public.get_dashboard_summary() is
  'M12 Home headline: latest-snapshot CMV/TTEP/spend/proceeds cumulatives, current data-quality and raw/graded/sealed breakdown, lifetime GPO/CS/HS/NSP/RRC/PUD/NCCO/THCO/THP, an honest pending_recompute flag, and (D-211) the age and kind of the prices the live value is built from. One bounded request; the headline comes from the cache, never a per-card recompute on load (UX_FLOWS.md F10).';
