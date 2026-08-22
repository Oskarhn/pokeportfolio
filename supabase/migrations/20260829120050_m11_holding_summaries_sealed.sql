-- M11: holding_summaries (Holding Detail's one query, M6) gains sealed identity and the per-lot
-- intent breakdown, mirroring list_portfolio's own additions (20260829120010) exactly — same join
-- shape, same three FILTERed sums. CREATE OR REPLACE VIEW, not DROP+CREATE: Postgres explicitly
-- allows a view's replacement query to append new output columns at the end without changing the
-- view's identity, unlike a function whose parameter/return list changed (D-054/D-059 does not apply
-- to views for this reason) — every existing column keeps its name, type and position.

create or replace view public.holding_summaries
with (security_invoker = true)
as
select
  h.id as holding_id,
  h.user_id,
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
  h.updated_at,
  coalesce(sum(l.quantity_remaining) filter (where l.voided_at is null), 0)::bigint as quantity,
  count(l.id) filter (where l.voided_at is null and l.quantity_remaining > 0) as lot_count,
  cv.finish as variant_finish,
  cv.stamp as variant_stamp,
  cv.subtype as variant_subtype,
  c.name as card_name,
  c.local_id as card_local_id,
  c.image_base_url as card_image_base_url,
  c.language as card_language,
  cs.name as card_set_name,
  mc.name as manual_name,
  mc.set_name as manual_set_name,
  mc.collector_number as manual_collector_number,
  mc.language as manual_language,
  h.sealed_product_id,
  sp.product_type as sealed_product_type,
  sp.name as sealed_product_name,
  sp.language as sealed_product_language,
  sp.pack_count as sealed_pack_count,
  sp.image_url as sealed_image_url,
  sp_set.id as sealed_set_id,
  sp_set.name as sealed_set_name,
  (sp.created_by_user_id is not null) as sealed_is_custom,
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
left join public.card_variants cv on cv.id = h.card_variant_id
left join public.cards c on c.id = cv.card_id
left join public.card_sets cs on cs.id = c.set_id
left join public.manual_card_definitions mc on mc.id = h.manual_card_id
left join public.sealed_products sp on sp.id = h.sealed_product_id
left join public.card_sets sp_set on sp_set.id = sp.set_id
where h.deleted_at is null
group by
  h.id, cv.finish, cv.stamp, cv.subtype, c.name, c.local_id, c.image_base_url, c.language, cs.name,
  mc.name, mc.set_name, mc.collector_number, mc.language,
  sp.product_type, sp.name, sp.language, sp.pack_count, sp.image_url, sp.created_by_user_id,
  sp_set.id, sp_set.name;

grant select on public.holding_summaries to authenticated;
