-- Fixes a real gap found by post-merge verification against the deployed project, not by
-- inspection: `holding_tags.user_id` and `manual_valuations.user_id` referenced auth.users(id)
-- with no ON DELETE action, so deleting an account that owned either row failed with a foreign
-- key violation. Every other user_id -> auth.users(id) reference in this schema cascades
-- (M4 fixed the original eight the same way — see PROJECT_JOURNAL.md, 2026-08-20). These two new
-- M6 tables should have shipped with the same behaviour and did not; SECURITY.md §8 states account
-- deletion cascades all user-private data, and that promise has to hold for every table, not most
-- of them.
--
-- Found running the real M6 add-to-collection flow against pokeportfolio-dev with synthetic
-- accounts and then cleaning them up (M6 prompt §98): deleting the account failed on
-- manual_valuations_user_id_fkey. holding_tags carries the identical defect and would have failed
-- the same way the first time an account that had tagged a holding was deleted.

alter table public.holding_tags
  drop constraint holding_tags_user_id_fkey,
  add constraint holding_tags_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade;

alter table public.manual_valuations
  drop constraint manual_valuations_user_id_fkey,
  add constraint manual_valuations_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade;
