-- M9 prompt §37: "Return to market value" — the missing half of the M6 manual-valuation lifecycle.
-- M6 shipped set_manual_valuation (supersede-then-insert) but no way back to "no manual override,
-- resolve automatically". Superseding the active row with nothing new inserted is exactly that:
-- history is preserved (the old row stays, superseded_at set), and the resolver (§6) simply finds
-- no active manual_valuations row and falls through to the provider price. A no-op when there was
-- no active valuation to clear, rather than an error — the UI only ever shows this action when one
-- exists, and a second call (e.g. a retried request) must stay safe.

create function public.clear_manual_valuation(p_holding_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  update public.manual_valuations
    set superseded_at = now()
    where holding_id = p_holding_id
      and user_id = v_user_id
      and superseded_at is null;
end;
$$;

grant execute on function public.clear_manual_valuation(uuid) to authenticated;
revoke execute on function public.clear_manual_valuation(uuid) from public;
