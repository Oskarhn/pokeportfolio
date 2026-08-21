-- holding_tags: many-to-many between holdings and tags (DATA_MODEL.md §5.2's four grouping
-- concepts — a tag is "many per holding", distinct from storage location (one per lot, as of the
-- previous migration) and from custom collections, which are M7 (DATA_MODEL.md §12).

create table public.holding_tags (
  holding_id uuid not null references public.holdings (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  user_id uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (holding_id, tag_id)
);

create index holding_tags_tag_idx on public.holding_tags (tag_id);

-- S1 (SECURITY.md §3.2): both the holding and the tag must belong to the row's own user_id.
-- Runs with invoker rights, same reasoning as acquisition_lots_check_owner.
create or replace function public.holding_tags_check_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  holding_owner uuid;
  tag_owner uuid;
begin
  select user_id into holding_owner from public.holdings where id = new.holding_id;
  if holding_owner is null or holding_owner <> new.user_id then
    raise exception 'holding_tags.user_id must match the owner of holding %', new.holding_id;
  end if;

  select user_id into tag_owner from public.tags where id = new.tag_id;
  if tag_owner is null or tag_owner <> new.user_id then
    raise exception 'holding_tags.user_id must match the owner of tag %', new.tag_id;
  end if;

  return new;
end;
$$;

create trigger holding_tags_owner_check
  before insert or update on public.holding_tags
  for each row execute function public.holding_tags_check_owner();

alter table public.holding_tags enable row level security;

-- No UPDATE policy: a join row is either present or absent, never edited in place.
create policy holding_tags_owner_select on public.holding_tags
  for select to authenticated using (user_id = (select auth.uid()));
create policy holding_tags_owner_insert on public.holding_tags
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy holding_tags_owner_delete on public.holding_tags
  for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, delete on public.holding_tags to authenticated;

-- service_role needs explicit grants too — see the note in 20260817120020_create_catalog_tables.sql.
grant all on public.holding_tags to service_role;
