-- P209 / D-212: the monthly spend window follows the owner's calendar, not the database's.
--
-- get_monthly_spend built its month list from the database's current_date (UTC). A Norwegian owner
-- in the first one or two hours after local midnight on the 1st is already in the new month while
-- the database is still in the old one: a purchase dated the 1st (a perfectly valid date, P144 allows
-- up to UTC today + 1) fell in no bar, so the bars summed to less than the collectible + hobby spend
-- the same dashboard prints. The client already knows the local date (platform/local-date.ts); the
-- function now takes it.
--
--   get_monthly_spend(p_months int, p_as_of date)        NEW overload, no defaults
--
-- p_as_of is the owner's local "today". It must be within one day of the database date (every real
-- UTC offset is covered); anything else is refused, never silently reinterpreted. The one-argument
-- function is left exactly as it is: it keeps its grants (the privilege baseline migrations that
-- tests re-apply name it), and a PostgREST call that sends only p_months still resolves to it
-- because the new overload has no defaults - a caller never has two candidates.

create function public.get_monthly_spend(p_months int, p_as_of date)
returns table (
  month date,
  collectible_nok_minor text,
  hobby_nok_minor text,
  total_nok_minor text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_as_of date := coalesce(p_as_of, current_date); -- null reads as the database date
begin
  if v_as_of < current_date - 1 or v_as_of > current_date + 1 then
    raise exception 'p_as_of must be within one day of the database date' using errcode = '22023';
  end if;

  return query
    with bounds as (
      select greatest(least(coalesce(p_months, 12), 24), 1) as n
    ),
    months as (
      select generate_series(
        date_trunc('month', v_as_of) - ((b.n - 1) || ' months')::interval,
        date_trunc('month', v_as_of),
        interval '1 month'
      )::date as month
      from bounds b
    ),
    spend as (
      select date_trunc('month', p.purchased_on)::date as month,
             coalesce(sum(pl.attributable_cost_nok_minor)
               filter (where pl.spend_class = 'collectible'), 0)::numeric as cs,
             coalesce(sum(pl.attributable_cost_nok_minor)
               filter (where pl.spend_class = 'hobby'), 0)::numeric as hs
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
end;
$$;

comment on function public.get_monthly_spend(int, date) is
  'M12 monthly spending view (last N calendar months, max 24): collectible vs hobby vs total, from non-voided purchase lines. The newest month is the month of p_as_of (the owner''s local date, within one day of the database date, D-212). The one-argument overload uses the database date. Zero months are real empty months, not missing data.';

grant execute on function public.get_monthly_spend(int, date) to authenticated;
revoke execute on function public.get_monthly_spend(int, date) from public;
