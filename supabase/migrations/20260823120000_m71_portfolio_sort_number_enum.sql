-- M7.1 (owner UI/UX refinement pass, prompt §41/§72): Portfolio's "Card number low/high" sort,
-- explicitly requested and previously absent — M7's ten sort modes had no collector-number order.
--
-- Split into its own migration/transaction, matching the established pattern in
-- 20260821120000_m6_enum_extensions.sql: a value added by ALTER TYPE ... ADD VALUE can only be
-- used in the same transaction that added it under a narrow relaxation (PG12+); a separate file
-- removes any doubt rather than relying on the nuance, and the function that consumes these values
-- (list_portfolio) is rewritten in the next migration.

alter type public.portfolio_sort_order add value if not exists 'number_asc';
alter type public.portfolio_sort_order add value if not exists 'number_desc';
