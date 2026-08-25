/**
 * The independent CANONICAL EXPORT ORACLE (prompt §4).
 *
 * Built implementation-blind from origin/main's migrations alone (base c5ee0c9): every relation
 * in `public`, classified exactly once, with the reason a restore author would care. This is NOT
 * derived from any implementation's inventory — an implementation that disagrees with this file
 * must either be wrong or must argue against the reasons recorded here.
 *
 * Classification semantics:
 *  - MUST_EXPORT        canonical user-private facts. Lossless JSON backup MUST carry every row
 *                       verbatim, including voided/tombstoned/superseded history. Losing one row
 *                       is irreversible data loss for the user.
 *  - IDENTITY_REFERENCE shared catalog rows the user's data points at. Not user data; exported
 *                       only as the backup's compact identity manifest so external tools can
 *                       interpret the file and a future restore can re-resolve catalog links.
 *  - MUST_NOT_EXPORT    everything else: derived caches, global market facts, system/token
 *                       internals. Their presence in a backup is a contract violation — either
 *                       misrepresenting rebuildable aggregates as data or leaking system state.
 */

export type ExportClass = 'MUST_EXPORT' | 'IDENTITY_REFERENCE' | 'MUST_NOT_EXPORT'

export interface TableSpec {
  /** Relation name as it exists in `public`. */
  readonly table: string
  readonly classification: ExportClass
  /** Why, stated for the restore author asking "what breaks if this is missing / present?". */
  readonly reason: string
  /**
   * Column-level carve-outs inside a MUST_EXPORT table: privilege/account-state internals that
   * must never appear as restorable authority (prompt §11).
   */
  readonly excludedColumns?: readonly string[]
  /**
   * For tables that straddle classes: the predicate selecting the user-owned subset that
   * MUST_EXPORT applies to. Rows outside the predicate are IDENTITY_REFERENCE at most.
   */
  readonly userOwnedSubset?: string
}

export const EXPORT_INVENTORY: readonly TableSpec[] = [
  // ── User-private core ────────────────────────────────────────────────────────────────────────
  {
    table: 'profiles',
    classification: 'MUST_EXPORT',
    reason:
      'User preferences (locale, currency, theme, density, thresholds, defaults) are provided ' +
      'data a restored account must carry to behave identically.',
    excludedColumns: ['is_admin', 'disabled_at'],
  },
  {
    table: 'retailers',
    classification: 'MUST_EXPORT',
    reason:
      'User-defined purchase provenance; purchases.retailer_id references these by UUID and a ' +
      'restore that drops them strands every FK.',
  },
  {
    table: 'storage_locations',
    classification: 'MUST_EXPORT',
    reason:
      'Physical storage locations are both user-entered data and SECURITY-relevant provenance; ' +
      'holdings/acquisition_lots reference them by UUID.',
  },
  {
    table: 'tags',
    classification: 'MUST_EXPORT',
    reason: 'User-defined labels; holding_tags references them by UUID.',
  },
  {
    table: 'holdings',
    classification: 'MUST_EXPORT',
    reason:
      'The collection itself, including deleted_at tombstones and the manual_card_id link — ' +
      'the holdings_identity index means two same-looking holdings are distinct rows that must ' +
      'never merge on restore.',
  },
  {
    table: 'acquisition_lots',
    classification: 'MUST_EXPORT',
    reason:
      'The financial lot ledger: origin, cost_basis_state, original-currency AND NOK unit costs, ' +
      'both residual columns, per-lot sealed_intent, voided_at corrections. Without lots there ' +
      'is no cost basis and no ownership timeline.',
  },
  {
    table: 'manual_card_definitions',
    classification: 'MUST_EXPORT',
    reason:
      'Cards the shared catalog does not list (permanent provider gaps). Purely user-private; ' +
      'losing them deletes real cards from the record.',
  },
  {
    table: 'manual_valuations',
    classification: 'MUST_EXPORT',
    reason:
      'FULL history including superseded_at rows — what a holding was believed worth on a date ' +
      'is historical fact; exporting only active rows fabricates a thinner history than existed.',
  },
  {
    table: 'holding_tags',
    classification: 'MUST_EXPORT',
    reason: 'Membership edges between holdings and tags; loss silently flattens organisation.',
  },
  {
    table: 'custom_collections',
    classification: 'MUST_EXPORT',
    reason: 'Playlist-like user groups (name/description/sort/color).',
  },
  {
    table: 'custom_collection_members',
    classification: 'MUST_EXPORT',
    reason: 'Membership edges holding→collection; sort_order and added_at are part of the state.',
  },

  // ── Purchase ledger ─────────────────────────────────────────────────────────────────────────
  {
    table: 'purchases',
    classification: 'MUST_EXPORT',
    reason:
      'Receipts including VOIDED ones: origin, frozen FX triple (fx_rate_to_nok/fx_rate_date/' +
      'fx_source), notes, voided_at. A void is a correction event, not an absence.',
  },
  {
    table: 'purchase_lines',
    classification: 'MUST_EXPORT',
    reason:
      'Stored allocations (allocated_shipping/customs/discount, attributable_cost in both ' +
      'currencies) export VERBATIM — recomputing them at export time would contradict the ' +
      'write-time-freeze model and could diverge if the allocator ever changes.',
  },
  {
    table: 'lot_cost_adjustments',
    classification: 'MUST_EXPORT',
    reason:
      'Grading fees/shipping/restoration adjustments that EUCB freezes into sold results. ' +
      'Browser holds SELECT-only today (write path arrives with M17) but the ROWS are canonical ' +
      'user data — read-only access is enough for export.',
  },

  // ── Sales ledger ────────────────────────────────────────────────────────────────────────────
  {
    table: 'sales',
    classification: 'MUST_EXPORT',
    reason:
      'Sales including voided ones, with frozen net proceeds, realized result split ' +
      '(known-cost vs uncosted buckets), marketplace, idempotency_key and the frozen FX triple. ' +
      'Negative net proceeds/results are LEGAL domain values here and must survive verbatim.',
  },
  {
    table: 'sale_lines',
    classification: 'MUST_EXPORT',
    reason:
      'Per-lot disposal lines with the FROZEN pair cost_basis_at_sale_nok_minor / ' +
      'realized_result_nok_minor (NULL together when the lot had no known basis — never 0).',
  },
  {
    table: 'lot_disposals',
    classification: 'MUST_EXPORT',
    reason:
      'Every quantity reduction (kind, disposed_on, voided_at). Without voided disposals the D1 ' +
      'invariant and the whole ownership timeline are unrecoverable after restore.',
  },

  // ── Sealed products (straddles classes) ─────────────────────────────────────────────────────
  {
    table: 'sealed_products',
    classification: 'MUST_EXPORT',
    reason: 'USER-CREATED sealed products are canonical user data no other source can reconstruct.',
    userOwnedSubset: 'created_by_user_id = exporting user (curated rows are identity reference)',
  },

  // ── Shared catalog: identity reference, never a dump ────────────────────────────────────────
  {
    table: 'card_series',
    classification: 'IDENTITY_REFERENCE',
    reason: 'Referenced through card_sets; belongs in the identity manifest projection only.',
  },
  {
    table: 'card_sets',
    classification: 'IDENTITY_REFERENCE',
    reason: 'Set name/slug/language/series needed to interpret variants; not user data.',
  },
  {
    table: 'cards',
    classification: 'IDENTITY_REFERENCE',
    reason: 'Card name/number/artist/set reference for the identity manifest.',
  },
  {
    table: 'card_variants',
    classification: 'IDENTITY_REFERENCE',
    reason:
      'The UUID every card holding/line actually cites. Manifest carries internal id first, ' +
      'provider ids second, so a future restore re-resolves catalog links collision-free.',
  },

  // ── Market data: public/global facts, never user backup ─────────────────────────────────────
  {
    table: 'fx_rates',
    classification: 'MUST_NOT_EXPORT',
    reason:
      'Public Norges Bank observations. Every transaction already carries its own frozen rate ' +
      'triple (F11); archiving the cache adds nothing and implies false precision after ' +
      'retention pruning of the source.',
  },
  {
    table: 'price_snapshots',
    classification: 'MUST_NOT_EXPORT',
    reason:
      'Global market data, retention-THINNED (60d daily → weekly): any slice in a backup is an ' +
      'arbitrary survivor set that would masquerade as complete history, and provider-derived ' +
      'value series legitimately restart after a restore while manual valuations survive.',
  },

  // ── Derived cache: THE regression contract (prompt §10, D-070) ───────────────────────────────
  {
    table: 'portfolio_snapshots',
    classification: 'MUST_NOT_EXPORT',
    reason:
      "Derived/rebuildable dashboard cache; M12's own permanent gate proves full-rebuild == " +
      'incremental from canonical rows. Archiving stale computations misrepresents them as ' +
      'data. A human CSV SHOWING a current-value summary is a different artifact and remains ' +
      'allowed if product later chooses it — backup canonicality ≠ report convenience.',
  },
  {
    table: 'portfolio_recompute_queue',
    classification: 'MUST_NOT_EXPORT',
    reason: 'Internal dirty-marking for the cache; meaningless outside a live database.',
  },
  {
    table: 'portfolio_recompute_runs',
    classification: 'MUST_NOT_EXPORT',
    reason:
      'Worker observability log (drain timing, user/row counts, errors) — internal operations ' +
      'metadata, not user data.',
  },

  // ── System / invitation internals ───────────────────────────────────────────────────────────
  {
    table: 'invitations',
    classification: 'MUST_NOT_EXPORT',
    reason:
      'System invitation records with token HASHES. Never user data; hashes must not travel ' +
      'inside user-readable artifacts.',
  },
  {
    table: 'invitation_claims',
    classification: 'MUST_NOT_EXPORT',
    reason: 'Token-hash claim records; service/internal-only by design.',
  },
  {
    table: 'invitation_redemptions',
    classification: 'MUST_NOT_EXPORT',
    reason: 'Redemption bookkeeping tying claims to auth users; account-state internals.',
  },

  // ── Service observability ───────────────────────────────────────────────────────────────────
  {
    table: 'catalog_sync_runs',
    classification: 'MUST_NOT_EXPORT',
    reason:
      'Catalog ingest job observability (runs, counts, errors) — operational metadata about ' +
      'the sync pipeline, never user data, and its presence would leak service activity.',
  },
  {
    table: 'price_sync_runs',
    classification: 'MUST_NOT_EXPORT',
    reason:
      'Price/FX ingest job observability — operational metadata about scheduled jobs, never ' +
      'user data; exporting it would disclose service-side activity patterns.',
  },
]

/** Views exist in `public` but are projections, never backup sources. */
export const KNOWN_VIEWS: readonly string[] = [
  'watched_card_variants', // service-role-only
  'invitation_overview',
  'holding_summaries',
]

/**
 * Tables that do not exist on main today but whose future arrival MUST trigger an explicit
 * classification decision before they silently fall out of (or leak into) backups.
 */
export const FORWARD_COMPAT_TABLES: readonly string[] = [
  'openings', // M16
  'trades', // M18
  'lot_transfers', // M17
  'grading_submissions', // M17
  'audit_events', // DATA_MODEL §7 prose names it; NO such table exists in supabase/migrations yet (verified by grep)
]

// ── Derived lookups ─────────────────────────────────────────────────────────────────────────

const byTable = new Map(EXPORT_INVENTORY.map((spec) => [spec.table, spec]))

export function classify(table: string): ExportClass | null {
  return byTable.get(table)?.classification ?? null
}

export function specOf(table: string): TableSpec | undefined {
  return byTable.get(table)
}

export function mustExportTables(): readonly TableSpec[] {
  return EXPORT_INVENTORY.filter((s) => s.classification === 'MUST_EXPORT')
}

export function mustNotExportTables(): readonly string[] {
  return EXPORT_INVENTORY.filter((s) => s.classification === 'MUST_NOT_EXPORT').map((s) => s.table)
}

export function identityReferenceTables(): readonly string[] {
  return EXPORT_INVENTORY.filter((s) => s.classification === 'IDENTITY_REFERENCE').map(
    (s) => s.table,
  )
}

/**
 * Columns that may hold NEGATIVE money values by real CHECK constraints on main. Every other
 * money column is constrained non-negative, so a negative value there is either corruption or
 * a sanitization bug mangling a legitimate negative elsewhere (prompt §7).
 */
export const NEGATIVE_LEGAL_MONEY_COLUMNS: ReadonlySet<string> = new Set([
  'sales.net_proceeds_minor',
  'sales.net_proceeds_nok_minor',
  'sales.realized_result_nok_minor',
  'sale_lines.net_proceeds_minor',
  'sale_lines.net_proceeds_nok_minor',
  'sale_lines.realized_result_nok_minor',
])

/**
 * Privilege/auth internals that must never appear anywhere inside a backup as restorable state
 * (prompt §11). profiles.is_admin/disabled_at are the concrete cases today; email lives in
 * auth.users and is deliberately absent from `public` entirely (data minimisation).
 */
export const PRIVILEGE_INTERNAL_COLUMNS: ReadonlyMap<string, readonly string[]> = new Map([
  ['profiles', ['is_admin', 'disabled_at']],
])
