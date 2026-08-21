-- retailers.user_id has had no `default auth.uid()` since M3, unlike storage_locations/tags,
-- which the M6 migration below already fixed for exactly this reason. Nothing exercised the gap
-- until now: M8 is the first feature that creates a retailer directly from the client
-- (src/data/retailers.ts's createRetailer), which is what surfaced it. Same defect class M4, M6
-- and M7 each found and fixed for a different table (docs/PROJECT_JOURNAL.md) — see
-- 20260821120070_m6_user_id_defaults.sql, which this migration is the direct continuation of.
-- RLS's `WITH CHECK (user_id = auth.uid())` remains the actual enforcement either way; this only
-- changes what a caller has to type.

alter table public.retailers alter column user_id set default auth.uid();
