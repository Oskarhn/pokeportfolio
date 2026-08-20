-- Extensions and shared helper functions used across later M3 migrations.
--
-- gen_random_uuid() is built into PostgreSQL core since v13 and needs no extension.
-- pg_trgm is used for fast fuzzy card-name search (DATA_MODEL.md §10).

create extension if not exists pg_trgm with schema extensions;

-- Keeps `updated_at` current on row modification. Applied selectively — only to tables with
-- genuinely mutable metadata (DATA_MODEL.md §9 distinguishes mutable metadata from immutable
-- historical facts, which never get this trigger).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Generic BEFORE UPDATE trigger: stamps updated_at = now(). Never attached to immutable historical tables (e.g. acquisition_lots, purchases).';
