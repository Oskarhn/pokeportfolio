-- purchases.retailer_id had no ownership check since M3 — the FK only proves the row exists, not
-- that it belongs to the same user, so nothing stopped a caller pointing their own purchase at
-- another user's retailer (SECURITY.md §3.3's "inserting a child row pointing at another user's
-- parent" attack, S1). Latent and unexercised until now: M6's add_card_acquisition never set
-- retailer_id at all, and no retailer-selection UI existed before M8. Same defect class as
-- 20260824120005 (retailers.user_id's missing default) and the M4/M6/M7 findings before it — found
-- before it could be exploited against real data, not after.

create or replace function public.purchases_check_retailer_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  retailer_owner uuid;
begin
  if new.retailer_id is not null then
    select user_id into retailer_owner from public.retailers where id = new.retailer_id;
    if retailer_owner is null or retailer_owner <> new.user_id then
      raise exception 'purchases.retailer_id must belong to the same owner';
    end if;
  end if;
  return new;
end;
$$;

create trigger purchases_retailer_owner_check
  before insert or update on public.purchases
  for each row execute function public.purchases_check_retailer_owner();
