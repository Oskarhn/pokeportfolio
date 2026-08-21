-- holding_summaries: the Collection list's one query (M6 prompt §103-104). Aggregates open
-- quantity and joins the display facts a tile needs (card name, set, image, or the manual-card
-- equivalents) so the client never issues a follow-up request per row — the N+1 shape the prompt
-- explicitly calls out as unacceptable at collection scale.
--
-- security_invoker = true (Postgres 15+): the view runs with the querying role's own privileges,
-- so RLS on holdings/acquisition_lots applies exactly as if the two tables were queried directly —
-- the same reasoning search_cards uses for SECURITY INVOKER over DEFINER (SECURITY.md §3.1).
-- No user_id predicate is written into the view body; RLS is what supplies it, and duplicating the
-- check here would be a second copy of the boundary that could quietly drift from the first.

create view public.holding_summaries
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
  mc.language as manual_language
from public.holdings h
left join public.acquisition_lots l on l.holding_id = h.id
left join public.card_variants cv on cv.id = h.card_variant_id
left join public.cards c on c.id = cv.card_id
left join public.card_sets cs on cs.id = c.set_id
left join public.manual_card_definitions mc on mc.id = h.manual_card_id
where h.deleted_at is null
group by
  h.id, cv.finish, cv.stamp, cv.subtype, c.name, c.local_id, c.image_base_url, c.language, cs.name,
  mc.name, mc.set_name, mc.collector_number, mc.language;

grant select on public.holding_summaries to authenticated;
