-- manual_card_definitions: the honest fallback for a physical card the shared catalog does not
-- (yet) list (M6 prompt §16-19, D-017's "every physical card is trackable"). M5's ingest found
-- real, permanent provider gaps — dozens of sets with a non-zero card count and an empty cards[]
-- array, ~9,300 cards with no image, six sets that never ingested — so "TCGdex has the card"
-- cannot be a precondition for ownership.
--
-- Deliberately thin: only what identifies the physical item. No fake provider id, no guessed
-- rarity, no invented price, no image requirement. User-private — never written into the shared
-- catalog tables, never visible to another user, never touched by sync-catalog.
--
-- Ownership class "User-private" (DATA_MODEL.md §1): full CRUD restricted to user_id = auth.uid().

create table public.manual_card_definitions (
  id uuid primary key default gen_random_uuid(),
  -- Defaulted so a client insert never has to state the obvious; RLS WITH CHECK still enforces
  -- user_id = auth.uid() independently, so the default is a convenience, not the access control.
  user_id uuid not null default (select auth.uid()) references auth.users (id) on delete cascade,
  name text not null,
  set_name text,
  collector_number text,
  language text,
  finish text,
  stamp text,
  subtype text,
  size public.card_size,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint manual_card_definitions_name_not_blank check (btrim(name) <> '')
);

create index manual_card_definitions_user_idx on public.manual_card_definitions (user_id);

create trigger manual_card_definitions_set_updated_at before update on public.manual_card_definitions
  for each row execute function public.set_updated_at();

alter table public.manual_card_definitions enable row level security;

create policy manual_card_definitions_owner on public.manual_card_definitions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, delete on public.manual_card_definitions to authenticated;
-- Column-restricted UPDATE grant, same shape as every other user-owned table (SECURITY.md §5.9):
-- id, user_id, created_at and updated_at are system-owned and excluded even though this table
-- carries no financial or provenance column of its own.
grant update (
  name, set_name, collector_number, language, finish, stamp, subtype, size, notes
) on public.manual_card_definitions to authenticated;

-- service_role needs explicit grants too — see the note in 20260817120020_create_catalog_tables.sql.
grant all on public.manual_card_definitions to service_role;
