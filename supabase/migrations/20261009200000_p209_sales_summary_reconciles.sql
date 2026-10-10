-- P209 / D-212: sales_summary's components reconcile to NSP.
--
-- NSP = SGP - SF - OSC + SCB (FINANCIAL_MODEL.md section 2). sales_summary converted gross, fees,
-- outbound shipping and buyer shipping to NOK each on its own and summed NSP from the frozen
-- per-sale figure, so for a sale such as 3 gross, 1 fee, 1 shipping at 0.5 NOK per unit the
-- components gave 2 - 1 - 1 = 0 against a frozen NSP of 1 (round(0.5)). Nothing renders the
-- components today, so no user saw it; the API contract said otherwise. The gross is now the figure
-- that makes the identity hold for every sale: frozen NSP + converted fees + converted shipping -
-- converted buyer shipping. Signature, ACL and every other column are unchanged.

create or replace function public.sales_summary()
returns table (
  sale_count integer,
  gross_nok_minor text,
  fees_nok_minor text,
  outbound_shipping_nok_minor text,
  buyer_shipping_nok_minor text,
  nsp_nok_minor text,
  rrc_nok_minor text,
  pud_nok_minor text
)
language sql
stable
set search_path = ''
as $$
  select
    (select count(*)::int from public.sales s
      where s.user_id = auth.uid() and s.voided_at is null),
    -- D-212: NSP = SGP - SF - OSC + SCB (FINANCIAL_MODEL.md section 2). The frozen NSP and the three
    -- converted charges are authoritative, so the gross is the figure that makes the identity hold per
    -- sale; converting the gross on its own could differ from it by a minor unit.
    coalesce((select sum(
                s.net_proceeds_nok_minor
                + public.money_minor_to_nok_minor(s.fees_minor, s.currency, s.fx_rate_to_nok)
                + public.money_minor_to_nok_minor(s.shipping_cost_minor, s.currency, s.fx_rate_to_nok)
                - public.money_minor_to_nok_minor(s.shipping_charged_minor, s.currency, s.fx_rate_to_nok))
              from public.sales s where s.user_id = auth.uid() and s.voided_at is null), 0)::text,
    coalesce((select sum(public.money_minor_to_nok_minor(s.fees_minor, s.currency, s.fx_rate_to_nok))
              from public.sales s where s.user_id = auth.uid() and s.voided_at is null), 0)::text,
    coalesce((select sum(public.money_minor_to_nok_minor(s.shipping_cost_minor, s.currency, s.fx_rate_to_nok))
              from public.sales s where s.user_id = auth.uid() and s.voided_at is null), 0)::text,
    coalesce((select sum(public.money_minor_to_nok_minor(s.shipping_charged_minor, s.currency, s.fx_rate_to_nok))
              from public.sales s where s.user_id = auth.uid() and s.voided_at is null), 0)::text,
    coalesce((select sum(s.net_proceeds_nok_minor)
              from public.sales s where s.user_id = auth.uid() and s.voided_at is null), 0)::text,
    coalesce((select sum(sl.realized_result_nok_minor)
              from public.sale_lines sl join public.sales s on s.id = sl.sale_id
              where s.user_id = auth.uid() and s.voided_at is null
                and sl.cost_basis_at_sale_nok_minor is not null), 0)::text,
    coalesce((select sum(sl.net_proceeds_nok_minor)
              from public.sale_lines sl join public.sales s on s.id = sl.sale_id
              where s.user_id = auth.uid() and s.voided_at is null
                and sl.cost_basis_at_sale_nok_minor is null), 0)::text;
$$;
