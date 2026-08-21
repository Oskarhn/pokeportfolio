-- Defaults user_id to the calling session on the user-private tables M6's UI writes to directly
-- from the client (storage_locations, tags — both shipped in M3 without one; holding_tags, this
-- milestone's own join table). A client insert no longer has to restate auth.uid() as a literal
-- value; RLS's WITH CHECK (user_id = auth.uid()) remains the actual enforcement either way, so
-- this changes nothing about what is allowed, only what a caller has to type.

alter table public.storage_locations alter column user_id set default (select auth.uid());
alter table public.tags alter column user_id set default (select auth.uid());
alter table public.holding_tags alter column user_id set default (select auth.uid());
