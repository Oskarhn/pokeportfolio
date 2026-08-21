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
    ('view',  'holding_summaries',      'authenticated', 'SELECT')
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
    ('profiles.collection_default_view'), ('profiles.low_value_threshold_minor'),
    ('profiles.hide_low_value_by_default'), ('profiles.default_condition'),
    ('profiles.default_language'), ('profiles.default_storage_location_id'),

    ('sealed_products.set_id'), ('sealed_products.product_type'), ('sealed_products.name'),
    ('sealed_products.language'), ('sealed_products.pack_count'), ('sealed_products.image_url'),
    ('sealed_products.cardmarket_product_id'), ('sealed_products.tcgplayer_product_id'),

    ('retailers.name'), ('retailers.notes'),

    ('storage_locations.name'), ('storage_locations.kind'), ('storage_locations.sort_order'),

    ('tags.name'),

    ('holdings.holding_kind'), ('holdings.card_variant_id'), ('holdings.sealed_product_id'),
    ('holdings.manual_card_id'),
    ('holdings.condition'), ('holdings.grading_state'), ('holdings.grader'), ('holdings.grade'),
    ('holdings.cert_number'), ('holdings.sealed_intent'),
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
    ('acquisition_lots.residual_minor'), ('acquisition_lots.notes'),
    ('acquisition_lots.voided_at'), ('acquisition_lots.storage_location_id'),

    -- M6: manual card fallback — every user-supplied identifying field.
    ('manual_card_definitions.name'), ('manual_card_definitions.set_name'),
    ('manual_card_definitions.collector_number'), ('manual_card_definitions.language'),
    ('manual_card_definitions.finish'), ('manual_card_definitions.stamp'),
    ('manual_card_definitions.subtype'), ('manual_card_definitions.size'),
    ('manual_card_definitions.notes'),

    -- M6: manual valuations — append-only; superseded_at is the one post-insert write.
    ('manual_valuations.superseded_at')
  ),

  -- The complete set of functions a browser may call. Twelve others exist in this schema and are
  -- reachable by nobody: the six trigger functions (five from M3/M4 plus M5's
  -- cards_language_matches_set), the four service-role redemption internals, hash_invitation_token,
  -- and before_user_created.
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
    ('routine',
     'add_card_acquisition(uuid, uuid, grading_state, card_condition, grader, numeric, text, ' ||
     'boolean, text, lot_origin, cost_basis_state, bigint, integer, date, uuid, text, bigint)',
     'authenticated', 'EXECUTE'),
    ('routine', 'set_manual_valuation(uuid, bigint, text, date)',   'authenticated', 'EXECUTE'),
    ('routine', 'void_acquisition_lot(uuid, text)',                 'authenticated', 'EXECUTE')
  ),

  expected as (
    select kind, obj, grantee, priv from expected_schema
    union all select kind, obj, grantee, priv from expected_relation
    union all select 'column', obj, 'authenticated', 'SELECT' from expected_column_select
    union all select 'column', obj, 'authenticated', 'UPDATE' from expected_column_update
    union all select kind, obj, grantee, priv from expected_routine
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
