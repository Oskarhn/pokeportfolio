-- P191 / P130-14: another user's private sealed product is neither an existence oracle nor a pin.
--
-- sealed_products rows are curated (created_by_user_id NULL, visible to all) or private to their
-- creator (RLS policy sealed_products_read). Two references to a product row cross that boundary:
--
--   holdings.sealed_product_id, purchase_lines.sealed_product_id, openings.sealed_product_id
--
-- Foreign-key checks are performed by the system as the table owner, so they ignore RLS. Reproduced
-- before this migration, as user B naming user A's private product id:
--   * a direct INSERT into holdings was ACCEPTED where a random UUID raised 23503 — a deterministic
--     existence signal for any UUID B learns or guesses;
--   * the accepted row then made A's own product undeletable (A's DELETE failed 23503 on B's row)
--     and, worse, made A's account purge fail closed — one user could block another's erasure;
--   * INSERT into sealed_products with a chosen id raised 23505 for A's id and succeeded for a
--     random one (closed by the column-level INSERT grant in 20261003120020, which excludes id).
-- The RPC paths (create_purchase, add_card_acquisition, create_opening_from_provisional) already
-- answered uniformly; the table-level paths did not, and the schema is the right place to say so.
--
-- THE RULE. A row may reference a sealed product only if the product is curated or was created by
-- the row's own user_id. The check is explicit (SECURITY DEFINER read, so RLS and the caller's role
-- do not change the answer) and the failure is ONE error for "does not exist" and "exists but is
-- not yours" — same SQLSTATE (23503, the class a missing foreign key already produced), same
-- message, no detail naming the key. Writes by any role are checked, including service_role.
--
-- Existing rows are not rewritten. A pre-flight counts rows that already violate the rule and
-- reports them as a WARNING (an abort would block a release over data this migration did not
-- create); the diagnostic is in docs/security/P191_SECURITY_BOUNDARY_CLOSURE.md.

do $$
declare
  v_bad bigint;
begin
  select
    (select count(*) from public.holdings h
       join public.sealed_products sp on sp.id = h.sealed_product_id
      where sp.created_by_user_id is not null and sp.created_by_user_id <> h.user_id)
    + (select count(*) from public.purchase_lines l
         join public.sealed_products sp on sp.id = l.sealed_product_id
        where sp.created_by_user_id is not null and sp.created_by_user_id <> l.user_id)
    + (select count(*) from public.openings o
         join public.sealed_products sp on sp.id = o.sealed_product_id
        where sp.created_by_user_id is not null and sp.created_by_user_id <> o.user_id)
  into v_bad;
  if v_bad > 0 then
    raise warning 'P191: % existing row(s) reference another user''s private sealed product; they are left untouched and should be reviewed', v_bad;
  end if;
end;
$$;

create or replace function public.enforce_sealed_product_reference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sealed_product_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.sealed_product_id is not distinct from old.sealed_product_id then
    return new;
  end if;

  if not exists (
    select 1
      from public.sealed_products sp
     where sp.id = new.sealed_product_id
       and (sp.created_by_user_id is null or sp.created_by_user_id = new.user_id)
  ) then
    -- Deliberately identical for "no such row" and "someone else's private row".
    raise exception 'sealed_product_id must reference an available sealed product'
      using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_sealed_product_reference() from public;

create trigger holdings_sealed_product_visible
  before insert or update of sealed_product_id on public.holdings
  for each row execute function public.enforce_sealed_product_reference();

create trigger purchase_lines_sealed_product_visible
  before insert or update of sealed_product_id on public.purchase_lines
  for each row execute function public.enforce_sealed_product_reference();

create trigger openings_sealed_product_visible
  before insert or update of sealed_product_id on public.openings
  for each row execute function public.enforce_sealed_product_reference();
