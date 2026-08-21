-- Found by actually deleting the 10,000-lot benchmark synthetic account after the performance
-- fixes above, not by inspection: `custom_collection_members.user_id references auth.users (id)`
-- had no `ON DELETE` action, so deleting an account that had added even one holding to a custom
-- collection failed outright with a foreign-key violation. This is the exact defect class M4 fixed
-- for the original eight `user_id -> auth.users(id)` references and M6 fixed again for
-- `holding_tags`/`manual_valuations` (PROJECT_JOURNAL.md, 2026-08-21) — `custom_collections.user_id`
-- itself got `on delete cascade` right in the same M7 migration; this sibling table's identical
-- column did not, because nothing re-derives "does every new user_id FK cascade" from first
-- principles per table — it has to be remembered every time, and this is the third time it wasn't.
--
-- SECURITY.md §8 describes account deletion as a cascade across all user-private data; this
-- restores that promise for the one M7 table that broke it.

alter table public.custom_collection_members
  drop constraint custom_collection_members_user_id_fkey,
  add constraint custom_collection_members_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade;
