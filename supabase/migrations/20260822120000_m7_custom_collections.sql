-- M7: custom_collections and custom_collection_members (DATA_MODEL.md §5.2.1, D-018's third
-- grouping concept). User-defined, playlist-like groups — "Trade Binder", "Favourites",
-- "151 Master Set" — that a holding may belong to many of at once. Purely organisational:
-- membership never touches ownership, cost basis, value or storage (invariant C1 below).
--
-- No SECURITY DEFINER RPC wraps CRUD here (M7 prompt §74): every operation authenticated needs —
-- create/rename/delete a collection, add/remove a holding — is a plain owner-scoped table
-- write under RLS, exactly like storage_locations/tags. A DEFINER function would grant nothing a
-- plain grant does not already, and would have to defend against a forged user_id that RLS
-- WITH CHECK already makes structurally impossible.

create table public.custom_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  description text,
  sort_order int not null default 0,
  color text,
  created_at timestamptz not null default now(),
  constraint custom_collections_name_not_blank check (btrim(name) <> '')
);

create index custom_collections_user_idx on public.custom_collections (user_id, sort_order);

alter table public.custom_collections enable row level security;

create policy custom_collections_owner on public.custom_collections
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, delete on public.custom_collections to authenticated;
grant update (name, description, sort_order, color) on public.custom_collections to authenticated;

-- service_role needs explicit grants too — see the note in 20260817120020_create_catalog_tables.sql.
grant all on public.custom_collections to service_role;

-- ── custom_collection_members ────────────────────────────────────────────────────────────────
-- Membership at holding level, not lot level (DATA_MODEL.md §5.2.1): the user thinks "this card
-- is in my trade binder", not "the copy I bought in March is". No UPDATE policy — a membership
-- row is inserted or deleted, never edited in place, same shape as holding_tags.

create table public.custom_collection_members (
  collection_id uuid not null references public.custom_collections (id) on delete cascade,
  holding_id uuid not null references public.holdings (id) on delete cascade,
  user_id uuid not null references auth.users (id),
  sort_order int not null default 0,
  added_at timestamptz not null default now(),
  primary key (collection_id, holding_id)
);

create index custom_collection_members_holding_idx on public.custom_collection_members (holding_id);

-- Invariant S1 (SECURITY.md §3.2): both parents — the collection and the holding — must belong to
-- the row's own user_id. Same shape as holding_tags_check_owner. Runs with invoker rights: RLS on
-- both parent tables already hides another user's row, so a cross-tenant attempt reads as
-- "not found" rather than confirming the row exists.
create or replace function public.custom_collection_members_check_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  collection_owner uuid;
  holding_owner uuid;
begin
  select user_id into collection_owner
    from public.custom_collections where id = new.collection_id;
  if collection_owner is null or collection_owner <> new.user_id then
    raise exception 'custom_collection_members.user_id must match the owner of collection %',
      new.collection_id;
  end if;

  select user_id into holding_owner from public.holdings where id = new.holding_id;
  if holding_owner is null or holding_owner <> new.user_id then
    raise exception 'custom_collection_members.user_id must match the owner of holding %',
      new.holding_id;
  end if;

  return new;
end;
$$;

create trigger custom_collection_members_owner_check
  before insert or update on public.custom_collection_members
  for each row execute function public.custom_collection_members_check_owner();

alter table public.custom_collection_members enable row level security;

create policy custom_collection_members_owner_select on public.custom_collection_members
  for select to authenticated using (user_id = (select auth.uid()));
create policy custom_collection_members_owner_insert on public.custom_collection_members
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy custom_collection_members_owner_delete on public.custom_collection_members
  for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, delete on public.custom_collection_members to authenticated;

-- service_role needs explicit grants too — see the note in 20260817120020_create_catalog_tables.sql.
grant all on public.custom_collection_members to service_role;

-- Invariant C1 (DATA_MODEL.md §5.2.1): deleting a custom_collection cascades only to membership
-- rows via the FK above (`on delete cascade` on collection_id) — no holding, lot or transaction
-- is ever affected. Asserted by tests/db/m7_custom_collections.test.ts.
