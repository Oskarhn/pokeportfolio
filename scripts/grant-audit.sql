-- The browser-reachable privilege surface, asserted as a whole.
--
-- WHY THIS FILE EXISTS. M4 shipped a live privilege escalation that CI could not see: the
-- deployed project auto-granted the Data API roles broad privileges on every new table, `GRANT`
-- adds rather than restricts, and so a column-restricted grant restricted nothing. The
-- authorization suite was green throughout, because it tests behaviour through PostgREST and every
-- behaviour it thought to try was correct. Nothing anywhere stated the intended privilege surface
-- and checked that the database agreed.
--
-- This does. It is deliberately a second, independent statement of what
-- supabase/migrations/20260820140000_m41_privilege_baseline.sql establishes — if the two disagree,
-- one of them is wrong and that is worth a build failure. Do not "fix" a failure by copying the
-- actual surface in here without working out which side is the defect.
--
-- HOW TO RUN IT
--
--   CI, against the ephemeral stack, on every push:
--     psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/grant-audit.sql
--
--   Against a deployed project, by hand, after any migration/config/function deploy: paste this
--   file into the Supabase SQL editor and run it. It reads catalog metadata only — no rows, no
--   personal data, no secrets — so it is safe to run against any environment, and it changes
--   nothing.
--
--   Clean run: "Success. No rows returned."
--   Otherwise: an error listing every privilege that is present and should not be, or absent and
--   should be.
--
-- WHAT IT DOES NOT COVER. RLS policies, which decide rows rather than privileges, and are covered
-- by tests/authorization/. Behavioural exploitability, covered by scripts/remote-security-check.mjs
-- from the attacker's side of the boundary with nothing but a publishable key. This file is the
-- third leg: what the catalog actually says, which is the leg that was missing.

do $$
declare
  v_diff text;
begin
  with
  -- ── ACTUAL ────────────────────────────────────────────────────────────────────────────────
  actual_relation as (
    select
      case c.relkind when 'S' then 'sequence' when 'v' then 'view'
                     when 'm' then 'matview'  else 'table' end as kind,
      c.relname::text as obj,
      a.grantee::regrole::text as grantee,
      a.privilege_type::text as priv
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    where n.nspname = 'public'
      and a.grantee::regrole::text in ('anon', 'authenticated')
  ),

  actual_column as (
    select
      'column' as kind,
      c.relname || '.' || att.attname as obj,
      a.grantee::regrole::text as grantee,
      a.privilege_type::text as priv
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
    cross join lateral aclexplode(att.attacl) a
    where n.nspname = 'public'
      and a.grantee::regrole::text in ('anon', 'authenticated')
  ),

  actual_routine as (
    select
      'routine' as kind,
      -- Built from proargtypes rather than from regprocedure or
      -- pg_get_function_identity_arguments. regprocedure schema-qualifies or not depending on
      -- search_path, and psql and the Supabase SQL editor do not agree about search_path;
      -- pg_get_function_identity_arguments includes parameter *names*, which would make this file
      -- fail on a rename that changes no privilege at all. proargtypes is the input signature and
      -- nothing else, which is exactly what identifies the grant.
      p.proname::text || '(' || coalesce((
        select string_agg(replace(pg_catalog.format_type(t, null), 'public.', ''), ', '
                          order by ord)
          from unnest(p.proargtypes) with ordinality as sig(t, ord)
      ), '') || ')' as obj,
      a.grantee::regrole::text as grantee,
      a.privilege_type::text as priv
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(p.proacl) a
    where n.nspname = 'public'
      and a.grantee::regrole::text in ('anon', 'authenticated')
  ),

  -- M7: the PUBLIC-EXECUTE blind spot (M7 prompt §69-71). PostgreSQL grants EXECUTE on a new
  -- function to PUBLIC by default — a separate ACL entry from anything granted or revoked from a
  -- *named* role, so `actual_routine`/`expected_routine` above (which only ever look at
  -- anon/authenticated) cannot see it. `aclexplode` represents the PUBLIC grantee as a null
  -- `grantee` column (grantee oid 0, which does not cast to a real `regrole`), so it is matched
  -- directly rather than through the ::regrole::text cast the named-role CTEs use.
  actual_routine_public as (
    select
      'routine-public' as kind,
      p.proname::text || '(' || coalesce((
        select string_agg(replace(pg_catalog.format_type(t, null), 'public.', ''), ', '
                          order by ord)
          from unnest(p.proargtypes) with ordinality as sig(t, ord)
      ), '') || ')' as obj,
      'PUBLIC' as grantee,
      a.privilege_type::text as priv
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(p.proacl) a
    where n.nspname = 'public'
      and a.grantee = 0
  ),

  -- Schema-level. USAGE is required and expected; CREATE is not.
  actual_schema as (
    select
      'schema' as kind,
      n.nspname::text as obj,
      a.grantee::regrole::text as grantee,
      a.privilege_type::text as priv
    from pg_namespace n
    cross join lateral aclexplode(n.nspacl) a
    where n.nspname = 'public'
      and a.grantee::regrole::text in ('anon', 'authenticated')
  ),

  -- Standing instructions about objects that do not exist yet. The mechanism that would let M5's
  -- tables arrive pre-granted, invisible to any check that only looks at what exists today.
  --
  -- `supabase_admin` is excluded, and the exclusion is a finding rather than a convenience. Both
  -- the local stack and a hosted project ship default privileges owned by that role granting
  -- anon and authenticated everything on tables, sequences and functions in `public`. They are
  -- unreachable: ALTER DEFAULT PRIVILEGES FOR ROLE requires membership, and `postgres` is not a
  -- member of `supabase_admin` in either environment — which is also why
  -- 20260820140000_m41_privilege_baseline.sql does not try.
  --
  -- What makes that acceptable rather than a hole is that a default privilege applies only to
  -- objects its own role creates. Every object in `public` here is created by `postgres`:
  -- `supabase db push`, `supabase db reset` and the dashboard SQL editor all connect as
  -- `postgres`, so `supabase_admin`'s defaults never attach to anything of ours. And if that ever
  -- stopped being true, the relation and routine checks above would fail on the resulting grant —
  -- this section is the leading indicator, not the only one.
  --
  -- Any other grantor is a genuine deviation and fails, which is what the hostile-state test in
  -- CI exercises: it sets these for `postgres`, the role that does create our tables.
  actual_default as (
    select
      'default-privilege' as kind,
      d.defaclobjtype::text || ' created by ' || d.defaclrole::regrole::text as obj,
      a.grantee::regrole::text as grantee,
      a.privilege_type::text as priv
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    where n.nspname = 'public'
      and a.grantee::regrole::text in ('anon', 'authenticated')
      and d.defaclrole::regrole::text <> 'supabase_admin'
  ),

  actual as (
    select * from actual_relation
    union all select * from actual_column
    union all select * from actual_routine
    union all select * from actual_routine_public
    union all select * from actual_schema
    union all select * from actual_default
  ),

  -- ── EXPECTED ──────────────────────────────────────────────────────────────────────────────
  --
  -- Written out in full rather than derived. A rule of the form "every column except these" would
  -- pass a table that gained a writable column nobody decided to expose, which is the exact
  -- failure this is here to catch.

  expected_schema(kind, obj, grantee, priv) as (values
    ('schema', 'public', 'anon',          'USAGE'),
    ('schema', 'public', 'authenticated', 'USAGE')
  ),

  -- anon has no table privileges at all. That is not an omission below; it is the statement.
  expected_relation(kind, obj, grantee, priv) as (values
    ('table', 'card_series',            'authenticated', 'SELECT'),
    ('table', 'card_sets',              'authenticated', 'SELECT'),
    ('table', 'cards',                  'authenticated', 'SELECT'),
    ('table', 'card_variants',          'authenticated', 'SELECT'),
    ('table', 'profiles',               'authenticated', 'SELECT'),
    ('view',  'invitation_overview',    'authenticated', 'SELECT'),
    ('table', 'invitation_redemptions', 'authenticated', 'SELECT'),
    ('table', 'sealed_products',        'authenticated', 'SELECT'),
    ('table', 'sealed_products',        'authenticated', 'INSERT'),
    ('table', 'sealed_products',        'authenticated', 'DELETE'),
    ('table', 'retailers',              'authenticated', 'SELECT'),
    ('table', 'retailers',              'authenticated', 'INSERT'),
    ('table', 'retailers',              'authenticated', 'DELETE'),
    ('table', 'storage_locations',      'authenticated', 'SELECT'),
    ('table', 'storage_locations',      'authenticated', 'INSERT'),
    ('table', 'storage_locations',      'authenticated', 'DELETE'),
    ('table', 'tags',                   'authenticated', 'SELECT'),
    ('table', 'tags',                   'authenticated', 'INSERT'),
    ('table', 'tags',                   'authenticated', 'DELETE'),
    ('table', 'holdings',               'authenticated', 'SELECT'),
    ('table', 'holdings',               'authenticated', 'INSERT'),
    ('table', 'holdings',               'authenticated', 'DELETE'),
    ('table', 'purchases',              'authenticated', 'SELECT'),
    ('table', 'purchases',              'authenticated', 'INSERT'),
    ('table', 'purchase_lines',         'authenticated', 'SELECT'),
    ('table', 'purchase_lines',         'authenticated', 'INSERT'),
    ('table', 'acquisition_lots',       'authenticated', 'SELECT'),
    ('table', 'acquisition_lots',       'authenticated', 'INSERT'),
    -- M6: manual card fallback, holding tags, manual valuations, and the Collection list view.
    ('table', 'manual_card_definitions', 'authenticated', 'SELECT'),
    ('table', 'manual_card_definitions', 'authenticated', 'INSERT'),
    ('table', 'manual_card_definitions', 'authenticated', 'DELETE'),
    ('table', 'holding_tags',           'authenticated', 'SELECT'),
    ('table', 'holding_tags',           'authenticated', 'INSERT'),
    ('table', 'holding_tags',           'authenticated', 'DELETE'),
    ('table', 'manual_valuations',      'authenticated', 'SELECT'),
    ('table', 'manual_valuations',      'authenticated', 'INSERT'),
    ('view',  'holding_summaries',      'authenticated', 'SELECT'),
    -- M7: custom collections (playlist-like groups) and their membership join table.
    ('table', 'custom_collections',         'authenticated', 'SELECT'),
    ('table', 'custom_collections',         'authenticated', 'INSERT'),
    ('table', 'custom_collections',         'authenticated', 'DELETE'),
    ('table', 'custom_collection_members',  'authenticated', 'SELECT'),
    ('table', 'custom_collection_members',  'authenticated', 'INSERT'),
    ('table', 'custom_collection_members',  'authenticated', 'DELETE'),
    -- M8: the Norges Bank FX-rate cache — market data, read-only for the browser.
    ('table', 'fx_rates',                   'authenticated', 'SELECT'),
    -- M9: shared price-history market data, read-only for the browser. watched_card_variants and
    -- price_sync_runs get no grant at all, to anon or authenticated — service-role/infra-only
    -- (prompt §11/§28), same shape as catalog_sync_runs.
    ('table', 'price_snapshots',            'authenticated', 'SELECT'),
    -- M10: the sale ledger (DATA_MODEL.md §5.7/§5.11). SELECT only — create_sale/update_sale/
    -- void_sale are SECURITY DEFINER (prompt §107), so authenticated needs no INSERT/UPDATE grant
    -- on any of the three tables at all; every write happens inside those functions.
    ('table', 'sales',                      'authenticated', 'SELECT'),
    ('table', 'sale_lines',                 'authenticated', 'SELECT'),
    ('table', 'lot_disposals',              'authenticated', 'SELECT'),
    -- M10 prerequisite: the never-shipped lot_cost_adjustments table (DATA_MODEL.md §5.6),
    -- created now because create_sale is the first real reader. SELECT only — no controlled write
    -- RPC exists yet (M17 owns it).
    ('table', 'lot_cost_adjustments',       'authenticated', 'SELECT'),
    -- M12: the snapshot cache — owner-readable only (RLS scopes rows to auth.uid()), no write
    -- grant of any kind: rebuild_portfolio_snapshots under the service role is the sole writer.
    ('table', 'portfolio_snapshots',        'authenticated', 'SELECT'),
    -- M16: the opening canonical table — owner-readable only. create_opening /
    -- create_opening_from_provisional / void_opening / reconcile_opening_cost are SECURITY
    -- DEFINER (the D-060 standard for frozen financial figures), so authenticated holds SELECT
    -- and nothing else on this table.
    ('table', 'openings',                   'authenticated', 'SELECT')
    -- portfolio_recompute_queue / portfolio_recompute_runs get NO grant at all, to anon or
    -- authenticated — service/internal-only, same shape as catalog_sync_runs/price_sync_runs.
    -- invitations: column-level SELECT only, below. invitation_claims: nothing, ever.
  ),

  expected_column_select(obj) as (values
    ('invitations.id'), ('invitations.email'), ('invitations.label'),
    ('invitations.expires_at'), ('invitations.max_uses'), ('invitations.use_count'),
    ('invitations.revoked_at'), ('invitations.created_at'), ('invitations.created_by')
    -- token_hash is absent. That is the whole point of the column list.
  ),

  -- Every UPDATE a session may perform, column by column. Absent everywhere, on purpose:
  -- id, user_id, created_at, updated_at, the parent FK on child rows, and the provenance columns
  -- named in the migration header.
  expected_column_update(obj) as (values
    ('profiles.display_name'), ('profiles.locale'), ('profiles.display_currency'),
    ('profiles.theme'), ('profiles.collection_grid_density'),
    ('profiles.collection_default_view'), ('profiles.collection_default_sort'),
    ('profiles.low_value_threshold_minor'),
    ('profiles.hide_low_value_by_default'), ('profiles.default_condition'),
    ('profiles.default_language'), ('profiles.default_storage_location_id'),
    -- M7.1: value-privacy eye and the European-pricing preference (inert until M9).
    ('profiles.hide_values'), ('profiles.use_eu_pricing'),

    ('sealed_products.set_id'), ('sealed_products.product_type'), ('sealed_products.name'),
    ('sealed_products.language'), ('sealed_products.pack_count'), ('sealed_products.image_url'),
    ('sealed_products.cardmarket_product_id'), ('sealed_products.tcgplayer_product_id'),

    ('retailers.name'), ('retailers.notes'),

    ('storage_locations.name'), ('storage_locations.kind'), ('storage_locations.sort_order'),

    ('tags.name'),

    ('holdings.holding_kind'), ('holdings.card_variant_id'), ('holdings.sealed_product_id'),
    ('holdings.manual_card_id'),
    ('holdings.condition'), ('holdings.grading_state'), ('holdings.grader'), ('holdings.grade'),
    ('holdings.cert_number'),
    ('holdings.is_favorite'), ('holdings.notes'), ('holdings.deleted_at'),

    ('purchases.purchased_on'), ('purchases.retailer_id'), ('purchases.currency'),
    ('purchases.subtotal_minor'), ('purchases.shipping_minor'), ('purchases.customs_minor'),
    ('purchases.discount_minor'), ('purchases.total_minor'), ('purchases.fx_rate_to_nok'),
    ('purchases.fx_rate_date'), ('purchases.fx_source'), ('purchases.total_nok_minor'),
    ('purchases.notes'), ('purchases.voided_at'),

    ('purchase_lines.line_type'), ('purchase_lines.spend_class'), ('purchase_lines.description'),
    ('purchase_lines.card_variant_id'), ('purchase_lines.sealed_product_id'),
    ('purchase_lines.condition'), ('purchase_lines.quantity'),
    ('purchase_lines.unit_price_minor'), ('purchase_lines.line_total_minor'),
    ('purchase_lines.allocated_shipping_minor'), ('purchase_lines.allocated_customs_minor'),
    ('purchase_lines.allocated_discount_minor'), ('purchase_lines.attributable_cost_minor'),
    ('purchase_lines.attributable_cost_nok_minor'),

    ('acquisition_lots.cost_basis_state'), ('acquisition_lots.purchase_line_id'),
    ('acquisition_lots.acquired_on'), ('acquisition_lots.quantity'),
    ('acquisition_lots.quantity_remaining'), ('acquisition_lots.unit_cost_basis_minor'),
    ('acquisition_lots.cost_basis_currency'), ('acquisition_lots.unit_cost_basis_nok_minor'),
    ('acquisition_lots.residual_minor'),
    -- M10 (20260828110000): the NOK-side counterpart of residual_minor.
    ('acquisition_lots.residual_nok_minor'),
    ('acquisition_lots.notes'),
    ('acquisition_lots.voided_at'), ('acquisition_lots.storage_location_id'),
    -- M11 (20260829120000): moved here from holdings — see that migration's header.
    ('acquisition_lots.sealed_intent'),

    -- M6: manual card fallback — every user-supplied identifying field.
    ('manual_card_definitions.name'), ('manual_card_definitions.set_name'),
    ('manual_card_definitions.collector_number'), ('manual_card_definitions.language'),
    ('manual_card_definitions.finish'), ('manual_card_definitions.stamp'),
    ('manual_card_definitions.subtype'), ('manual_card_definitions.size'),
    ('manual_card_definitions.notes'),

    -- M6: manual valuations — append-only; superseded_at is the one post-insert write.
    ('manual_valuations.superseded_at'),

    -- M7: custom collections — name/description/ordering/color, never user_id or membership.
    ('custom_collections.name'), ('custom_collections.description'),
    ('custom_collections.sort_order'), ('custom_collections.color')
    -- M10: the sale ledger (sales/sale_lines/lot_disposals) has no UPDATE grant at all — see the
    -- table-level comment above. Nothing belongs in this list for those three tables.
  ),

  -- The complete set of functions a browser may call. Every other function in this schema is
  -- reachable by nobody: trigger functions, the service-role redemption internals, the M5 ingest
  -- helpers, and M9's select_price_sync_batch/thin_price_snapshots (service-role-only, same
  -- reasoning as catalog_sync_runs).
  expected_routine(kind, obj, grantee, priv) as (values
    ('routine', 'invitation_status(text)',                          'anon',          'EXECUTE'),
    ('routine', 'invitation_status(text)',                          'authenticated', 'EXECUTE'),
    ('routine', 'is_admin()',                                       'authenticated', 'EXECUTE'),
    ('routine', 'create_invitation(text, integer, text)',           'authenticated', 'EXECUTE'),
    ('routine', 'revoke_invitation(uuid)',                          'authenticated', 'EXECUTE'),
    ('routine', 'card_condition_to_text(card_condition)',           'authenticated', 'EXECUTE'),
    ('routine', 'grader_to_text(grader)',                           'authenticated', 'EXECUTE'),
    ('routine', 'search_cards(text, text, integer, integer)',       'authenticated', 'EXECUTE'),
    -- M6: the atomic collection-writing surface.
    -- M11: gained p_sealed_product_id/p_sealed_intent (DROP+CREATE — an added parameter is a new
    -- signature for Postgres's own matching rules; the old 17-arg form no longer exists to grant).
    ('routine',
     'add_card_acquisition(uuid, uuid, grading_state, card_condition, grader, numeric, text, ' ||
     'boolean, text, lot_origin, cost_basis_state, bigint, integer, date, uuid, text, bigint, ' ||
     'uuid, sealed_intent)',
     'authenticated', 'EXECUTE'),
    ('routine', 'set_manual_valuation(uuid, bigint, text, date)',   'authenticated', 'EXECUTE'),
    ('routine', 'void_acquisition_lot(uuid, text)',                 'authenticated', 'EXECUTE'),
    -- M11: the sealed-lot intent surface — organisational only (20260829120000).
    ('routine', 'set_sealed_lot_intent(uuid, sealed_intent, integer)', 'authenticated', 'EXECUTE'),
    -- M7: Portfolio counts and the sorted/filtered/keyset-paginated browsing surface.
    ('routine', 'portfolio_counts(uuid)', 'authenticated', 'EXECUTE'),
    -- M11: list_portfolio gained p_holding_kind/p_sealed_product_type/p_sealed_intent (trailing).
    ('routine',
     'list_portfolio(portfolio_sort_order, integer, text, uuid, card_condition, boolean, ' ||
     'grader, boolean, text, boolean, uuid, uuid, uuid, boolean, boolean, uuid, text, text, ' ||
     'bigint, date, timestamp with time zone, bigint, boolean, text, holding_kind, ' ||
     'sealed_product_type, sealed_intent)',
     'authenticated', 'EXECUTE'),
    -- M7.1: the collector-number natural-sort key function list_portfolio's number_asc/desc use.
    ('routine', 'natural_sort_key(text)', 'authenticated', 'EXECUTE'),
    -- M8: the largest-remainder allocator and the purchase-ledger write/void/summary surface.
    ('routine', 'allocate_largest_remainder(bigint, bigint[])', 'authenticated', 'EXECUTE'),
    ('routine',
     'create_purchase(date, text, jsonb, uuid, bigint, bigint, bigint, numeric, date, fx_source, text)',
     'authenticated', 'EXECUTE'),
    ('routine',
     'update_purchase(uuid, date, text, jsonb, uuid, bigint, bigint, bigint, numeric, date, fx_source, text)',
     'authenticated', 'EXECUTE'),
    ('routine', 'void_purchase(uuid, text)', 'authenticated', 'EXECUTE'),
    ('routine', 'purchase_spending_summary()', 'authenticated', 'EXECUTE'),
    -- M8.1: the bulk-safe Remove from Portfolio surface.
    ('routine', 'remove_holdings_from_portfolio(uuid[])', 'authenticated', 'EXECUTE'),
    -- P28: the Holding Detail quantity-correction surface (20260831120000).
    ('routine', 'reduce_holding_quantity(uuid, jsonb)', 'authenticated', 'EXECUTE'),
    -- P43: the atomic full reset (SECURITY DEFINER, auth.uid()-scoped only) and the unified
    -- History read surface (SECURITY INVOKER, owner-only by construction). 20260901120010.
    ('routine', 'reset_my_portfolio_data()', 'authenticated', 'EXECUTE'),
    ('routine', 'list_history_events(text, boolean, integer, timestamp with time zone, uuid)',
     'authenticated', 'EXECUTE'),
    -- M9: the valuation resolver surface. select_price_sync_batch/thin_price_snapshots are
    -- service-role-only and deliberately absent here, same reasoning as catalog_sync_runs.
    ('routine', 'clear_manual_valuation(uuid)', 'authenticated', 'EXECUTE'),
    ('routine', 'resolve_variant_market_values(uuid[])', 'authenticated', 'EXECUTE'),
    ('routine', 'get_holding_value_provenance(uuid)', 'authenticated', 'EXECUTE'),
    ('routine', 'get_card_variant_price_history(uuid, date)', 'authenticated', 'EXECUTE'),
    ('routine', 'get_market_movers(integer, integer, market_mover_sort)', 'authenticated', 'EXECUTE'),
    -- M10: the signed largest-remainder wrapper and the sale-ledger write/void/summary surface.
    ('routine', 'allocate_largest_remainder_signed(bigint, bigint[])', 'authenticated', 'EXECUTE'),
    ('routine',
     'create_sale(date, text, jsonb, uuid, text, bigint, bigint, bigint, numeric, date, fx_source, text)',
     'authenticated', 'EXECUTE'),
    ('routine',
     'update_sale(uuid, date, text, jsonb, text, bigint, bigint, bigint, numeric, date, fx_source, text)',
     'authenticated', 'EXECUTE'),
    ('routine', 'void_sale(uuid, text)', 'authenticated', 'EXECUTE'),
    ('routine', 'sales_summary()', 'authenticated', 'EXECUTE'),
    -- M12: the dashboard read surface (20260830120030_m12_dashboard_reads.sql). The engine
    -- functions (rebuild_portfolio_snapshots / drain_portfolio_recompute_queue /
    -- enqueue_portfolio_daily_maintenance / enqueue_portfolio_recompute /
    -- m12_recompute_pending_for_self) and every m12_* trigger function are service/internal-only
    -- and deliberately absent here, same reasoning as select_price_sync_batch.
    ('routine', 'get_dashboard_summary()', 'authenticated', 'EXECUTE'),
    ('routine', 'get_portfolio_history(text, date, date)', 'authenticated', 'EXECUTE'),
    ('routine', 'get_monthly_spend(integer)', 'authenticated', 'EXECUTE'),
    ('routine', 'get_recent_activity(integer)', 'authenticated', 'EXECUTE'),
    -- M12: summary's pending-recompute helper — answers one boolean about auth.uid()'s own queue
    -- row; direct browser calls are harmless by construction (see baseline migration).
    ('routine', 'm12_recompute_pending_for_self()', 'authenticated', 'EXECUTE'),
    -- M16: the opening write/read surface (20260902120010). Writers are SECURITY DEFINER; the
    -- openings_check_owner trigger function and the extended acquisition/lot check-owner bodies
    -- are trigger-only and deliberately absent here. Signatures carry P53's idempotency-key
    -- parameter and the total-paid provisional contract (D-090); list_opening_sources is the
    -- INVOKER source-picker read.
    ('routine',
     'create_opening(uuid, integer, date, opening_tracking, jsonb, bigint, integer, text, uuid, uuid)',
     'authenticated', 'EXECUTE'),
    ('routine',
     'create_opening_from_provisional(uuid, integer, bigint, date, date, opening_tracking, ' ||
     'jsonb, bigint, integer, text, uuid)',
     'authenticated', 'EXECUTE'),
    ('routine', 'void_opening(uuid, text)', 'authenticated', 'EXECUTE'),
    ('routine', 'reconcile_opening_cost(uuid, uuid)', 'authenticated', 'EXECUTE'),
    ('routine', 'get_opening(uuid)', 'authenticated', 'EXECUTE'),
    ('routine', 'list_opening_sources(uuid)', 'authenticated', 'EXECUTE')
  ),

  -- M7: the expected PUBLIC-EXECUTE surface for every routine in `public` is empty. No project
  -- application routine is ever meant to be callable by an unauthenticated, unidentified grantee —
  -- `invitation_status`'s deliberate anon-reachability (SECURITY.md §5) is still a grant to the
  -- *named* `anon` role, not to PUBLIC, and is asserted in `expected_routine` above, unaffected by
  -- this being empty.
  expected_routine_public(kind, obj, grantee, priv) as (
    select 'routine-public', null::text, null::text, null::text where false
  ),

  expected as (
    select kind, obj, grantee, priv from expected_schema
    union all select kind, obj, grantee, priv from expected_relation
    union all select 'column', obj, 'authenticated', 'SELECT' from expected_column_select
    union all select 'column', obj, 'authenticated', 'UPDATE' from expected_column_update
    union all select kind, obj, grantee, priv from expected_routine
    union all select kind, obj, grantee, priv from expected_routine_public
  ),

  -- ── DIFF ──────────────────────────────────────────────────────────────────────────────────
  diff as (
    select 'UNEXPECTED' as direction, kind, obj, grantee, priv
      from (select kind, obj, grantee, priv from actual
            except select kind, obj, grantee, priv from expected) e
    union all
    select 'MISSING', kind, obj, grantee, priv
      from (select kind, obj, grantee, priv from expected
            except select kind, obj, grantee, priv from actual) m
  )

  select string_agg(
           format('  %-10s %-18s %-14s %-9s %s', direction, kind, grantee, priv, obj),
           E'\n' order by direction, kind, grantee, obj, priv)
    into v_diff
    from diff;

  if v_diff is not null then
    raise exception E'browser-reachable privilege surface does not match the baseline:\n\n%\n\n'
      'UNEXPECTED means a privilege exists that nothing in supabase/migrations/ asked for — the '
      'shape of the M4 escalation, and the reason this check exists. MISSING means the baseline '
      'says a privilege should be there and it is not; something the application needs is about '
      'to break. Reconcile toward '
      'supabase/migrations/20260820140000_m41_privilege_baseline.sql, not toward whatever the '
      'database happens to contain.', v_diff;
  end if;

  raise notice 'privilege baseline OK: anon and authenticated hold exactly the intended surface.';
end;
$$;
