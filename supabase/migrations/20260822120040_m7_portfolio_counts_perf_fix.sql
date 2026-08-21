-- Same fix as 20260822120030, for the same reason, found immediately after fixing
-- `list_portfolio`: `portfolio_counts()` had the identical `LEFT JOIN LATERAL` per-holding
-- aggregate, and the 10,000-lot benchmark measured it at ~5.4 seconds against the seeded
-- benchmark account even after list_portfolio's fix dropped every sort mode to 130-570ms.
-- Converted to the same materialized-CTE GROUP BY shape — one hash aggregate pass over this
-- user's holdings/lots instead of 7,500 correlated subquery evaluations.

create or replace function public.portfolio_counts()
returns table (
  physical_card_count text,
  unique_holding_count text,
  graded_count text,
  manual_count text
)
language sql
stable
set search_path = ''
as $$
  with lot_agg as materialized (
    select
      h.id as holding_id,
      h.grading_state,
      h.manual_card_id,
      coalesce(sum(l.quantity_remaining) filter (where l.voided_at is null), 0)::bigint as quantity
    from public.holdings h
    left join public.acquisition_lots l on l.holding_id = h.id
    where h.deleted_at is null and h.user_id = (select auth.uid())
    group by h.id, h.grading_state, h.manual_card_id
  )
  select
    coalesce(sum(quantity) filter (where quantity > 0), 0)::text,
    count(*) filter (where quantity > 0)::text,
    count(*) filter (where quantity > 0 and grading_state = 'graded')::text,
    count(*) filter (where quantity > 0 and manual_card_id is not null)::text
  from lot_agg;
$$;
