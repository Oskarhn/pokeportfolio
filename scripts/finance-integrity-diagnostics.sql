-- Finance integrity diagnostics (P131) — READ-ONLY, AGGREGATE COUNTS ONLY.
--
-- One SELECT statement, no function calls with side effects, no row content: every value is a
-- count across all users. Safe to run against the hosted project with
--   pnpm exec supabase db query --linked -f scripts/finance-integrity-diagnostics.sql
-- and meant to be re-run after the P130-01/02/03 remediation to show the counts return to zero.
--
-- What each count means (legitimate states vs corruption):
--
-- P130-01 (sealed split + update_purchase). set_sealed_lot_intent legitimately splits one purchase
-- line's lot into several live sibling lots whose quantities and basis still SUM to the line.
-- update_purchase rewrites only one arbitrary live lot to the full line, fabricating units/basis.
--   multi_live_lot_lines           lines with >1 live lot (the at-risk population, not itself damage)
--   lot_quantity_mismatch_lines    lines with >=1 live lot where Σ live lot quantity <> line quantity
--     ..._no_voided_lots           same, restricted to lines with no voided lot (cannot be legitimate)
--     ..._excess                   Σ live lot quantity > line quantity (phantom units; never legitimate)
--   lot_basis_mismatch_lines       lines with >=1 live known lot and no voided lot where
--                                  Σ (unit_cost_basis_nok_minor * quantity + residual_nok_minor)
--                                  <> attributable_cost_nok_minor
--   lot_basis_ccy_mismatch_lines   same in the purchase currency (unit_cost_basis_minor/residual_minor
--                                  vs attributable_cost_minor)
--   lines_with_live_and_voided_lots  lines mixing live and voided lots (a voided split sibling can
--                                  be "resurrected" by update_purchase without any sum mismatch)
--
-- P130-03 / D1 (lot remaining quantity = quantity - Σ live disposals).
--   voided_lots_with_live_disposals, d1_quantity_mismatch_lots (live lots),
--   d1_quantity_mismatch_voided_lots, negative_remaining_lots, overfull_remaining_lots,
--   live_disposal_exceeds_lot_quantity (Σ live disposals of a lot > its quantity),
--   voided_purchases_with_live_lots, voided_purchases_with_live_disposals,
--   voided_sales_with_live_disposals, voided_openings_with_live_disposals,
--   voided_openings_with_live_pull_lots
--
-- P130-02 (JPY FX). Counts of JPY purchases/sales by fx_source; manual-rate rows need owner review.
--
-- Optional consistency (diagnostics only): unsupported currency codes (domain supports NOK, EUR,
-- USD, GBP, JPY), transaction dates before 1996-01-01 or after today + 1 day, and stored money
-- beyond the client's safe-integer boundary (|value| > 2^53 - 1).
select jsonb_build_object(
  'generated_at_utc', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'transaction_read_only', current_setting('transaction_read_only'),

  'purchase_lines_total', (select count(*) from public.purchase_lines),
  'purchase_lines_with_live_lots', (
    select count(distinct al.purchase_line_id)
    from public.acquisition_lots al
    where al.purchase_line_id is not null and al.voided_at is null),

  'multi_live_lot_lines', (
    select count(*) from (
      select al.purchase_line_id
      from public.acquisition_lots al
      where al.purchase_line_id is not null and al.voided_at is null
      group by al.purchase_line_id
      having count(*) > 1) x),

  'lot_quantity_mismatch_lines', (
    select count(*) from (
      select pl.id
      from public.purchase_lines pl
      join public.acquisition_lots al on al.purchase_line_id = pl.id and al.voided_at is null
      group by pl.id, pl.quantity
      having sum(al.quantity) <> pl.quantity) x),

  'lot_quantity_mismatch_lines_no_voided_lots', (
    select count(*) from (
      select pl.id
      from public.purchase_lines pl
      join public.acquisition_lots al on al.purchase_line_id = pl.id and al.voided_at is null
      where not exists (
        select 1 from public.acquisition_lots v
        where v.purchase_line_id = pl.id and v.voided_at is not null)
      group by pl.id, pl.quantity
      having sum(al.quantity) <> pl.quantity) x),

  'lot_quantity_mismatch_lines_excess', (
    select count(*) from (
      select pl.id
      from public.purchase_lines pl
      join public.acquisition_lots al on al.purchase_line_id = pl.id and al.voided_at is null
      group by pl.id, pl.quantity
      having sum(al.quantity) > pl.quantity) x),

  'lot_basis_mismatch_lines', (
    select count(*) from (
      select pl.id
      from public.purchase_lines pl
      join public.acquisition_lots al on al.purchase_line_id = pl.id and al.voided_at is null
      where not exists (
        select 1 from public.acquisition_lots v
        where v.purchase_line_id = pl.id and v.voided_at is not null)
      group by pl.id, pl.attributable_cost_nok_minor
      having bool_and(al.cost_basis_state = 'known')
         and sum(al.unit_cost_basis_nok_minor::numeric * al.quantity + al.residual_nok_minor)
             <> pl.attributable_cost_nok_minor) x),

  'lot_basis_ccy_mismatch_lines', (
    select count(*) from (
      select pl.id
      from public.purchase_lines pl
      join public.acquisition_lots al on al.purchase_line_id = pl.id and al.voided_at is null
      where not exists (
        select 1 from public.acquisition_lots v
        where v.purchase_line_id = pl.id and v.voided_at is not null)
      group by pl.id, pl.attributable_cost_minor
      having bool_and(al.cost_basis_state = 'known')
         and sum(al.unit_cost_basis_minor::numeric * al.quantity + al.residual_minor)
             <> pl.attributable_cost_minor) x),

  'lines_with_live_and_voided_lots', (
    select count(*) from (
      select al.purchase_line_id
      from public.acquisition_lots al
      where al.purchase_line_id is not null
      group by al.purchase_line_id
      having bool_or(al.voided_at is null) and bool_or(al.voided_at is not null)) x),

  'voided_lots_with_live_disposals', (
    select count(distinct al.id)
    from public.acquisition_lots al
    join public.lot_disposals ld on ld.lot_id = al.id and ld.voided_at is null
    where al.voided_at is not null),

  'd1_quantity_mismatch_lots', (
    select count(*)
    from public.acquisition_lots al
    where al.voided_at is null
      and al.quantity_remaining <> al.quantity - coalesce((
        select sum(ld.quantity) from public.lot_disposals ld
        where ld.lot_id = al.id and ld.voided_at is null), 0)),

  'd1_quantity_mismatch_voided_lots', (
    select count(*)
    from public.acquisition_lots al
    where al.voided_at is not null
      and al.quantity_remaining <> al.quantity - coalesce((
        select sum(ld.quantity) from public.lot_disposals ld
        where ld.lot_id = al.id and ld.voided_at is null), 0)),

  'negative_remaining_lots', (
    select count(*) from public.acquisition_lots where quantity_remaining < 0),

  'overfull_remaining_lots', (
    select count(*) from public.acquisition_lots where quantity_remaining > quantity),

  'live_disposal_exceeds_lot_quantity', (
    select count(*) from (
      select al.id
      from public.acquisition_lots al
      join public.lot_disposals ld on ld.lot_id = al.id and ld.voided_at is null
      group by al.id, al.quantity
      having sum(ld.quantity) > al.quantity) x),

  'voided_purchases_with_live_lots', (
    select count(distinct p.id)
    from public.purchases p
    join public.purchase_lines pl on pl.purchase_id = p.id
    join public.acquisition_lots al on al.purchase_line_id = pl.id and al.voided_at is null
    where p.voided_at is not null),

  'voided_purchases_with_live_disposals', (
    select count(distinct p.id)
    from public.purchases p
    join public.purchase_lines pl on pl.purchase_id = p.id
    join public.acquisition_lots al on al.purchase_line_id = pl.id
    join public.lot_disposals ld on ld.lot_id = al.id and ld.voided_at is null
    where p.voided_at is not null),

  'voided_sales_with_live_disposals', (
    select count(distinct s.id)
    from public.sales s
    join public.sale_lines sl on sl.sale_id = s.id
    join public.lot_disposals ld on ld.sale_line_id = sl.id and ld.voided_at is null
    where s.voided_at is not null),

  'voided_openings_with_live_disposals', (
    select count(distinct o.id)
    from public.openings o
    join public.lot_disposals ld on ld.opening_id = o.id and ld.voided_at is null
    where o.voided_at is not null),

  'voided_openings_with_live_pull_lots', (
    select count(distinct o.id)
    from public.openings o
    join public.acquisition_lots al on al.opening_id = o.id and al.voided_at is null
    where o.voided_at is not null),

  'jpy_purchase_count', (select count(*) from public.purchases where currency = 'JPY'),
  'jpy_purchase_live_count', (
    select count(*) from public.purchases where currency = 'JPY' and voided_at is null),
  'jpy_purchase_manual_fx_count', (
    select count(*) from public.purchases where currency = 'JPY' and fx_source = 'manual'),
  'jpy_purchase_auto_fx_count', (
    select count(*) from public.purchases where currency = 'JPY' and fx_source = 'norges_bank'),
  'jpy_sale_count', (select count(*) from public.sales where currency = 'JPY'),
  'jpy_sale_live_count', (
    select count(*) from public.sales where currency = 'JPY' and voided_at is null),
  'jpy_sale_manual_fx_count', (
    select count(*) from public.sales where currency = 'JPY' and fx_source = 'manual'),
  'jpy_sale_auto_fx_count', (
    select count(*) from public.sales where currency = 'JPY' and fx_source = 'norges_bank'),
  'purchase_currency_counts', (
    select coalesce(jsonb_object_agg(currency, n), '{}'::jsonb)
    from (select currency, count(*) as n from public.purchases group by currency) x),
  'sale_currency_counts', (
    select coalesce(jsonb_object_agg(currency, n), '{}'::jsonb)
    from (select currency, count(*) as n from public.sales group by currency) x),

  'unsupported_currency_purchases', (
    select count(*) from public.purchases
    where currency not in ('NOK', 'EUR', 'USD', 'GBP', 'JPY')),
  'unsupported_currency_sales', (
    select count(*) from public.sales
    where currency not in ('NOK', 'EUR', 'USD', 'GBP', 'JPY')),
  'out_of_range_date_purchases', (
    select count(*) from public.purchases
    where purchased_on < date '1996-01-01' or purchased_on > current_date + 1),
  'out_of_range_date_sales', (
    select count(*) from public.sales
    where sold_on < date '1996-01-01' or sold_on > current_date + 1),
  'unsafe_integer_money_purchases', (
    select count(*) from public.purchases
    where greatest(abs(subtotal_minor), abs(shipping_minor), abs(customs_minor), abs(discount_minor),
                   abs(total_minor), abs(total_nok_minor)) > 9007199254740991),
  'unsafe_integer_money_purchase_lines', (
    select count(*) from public.purchase_lines
    where greatest(abs(unit_price_minor), abs(line_total_minor), abs(attributable_cost_minor),
                   abs(attributable_cost_nok_minor)) > 9007199254740991),
  'unsafe_integer_money_sales', (
    select count(*) from public.sales
    where greatest(abs(gross_minor), abs(fees_minor), abs(shipping_cost_minor),
                   abs(shipping_charged_minor), abs(net_proceeds_minor),
                   abs(net_proceeds_nok_minor)) > 9007199254740991),
  'unsafe_integer_money_lots', (
    select count(*) from public.acquisition_lots
    where abs(coalesce(unit_cost_basis_minor, 0)) > 9007199254740991
       or abs(coalesce(unit_cost_basis_nok_minor, 0)) > 9007199254740991)
) as diagnostics;
