/**
 * Black-box contract probes for the M16 openings surface.
 *
 * This package was written implementation-blind against origin/main + the
 * canonical documents, WITHOUT reading any concurrent implementation branch.
 * Nothing here hard-codes an import of a module or RPC that may not exist:
 *
 *  - table/column presence is probed through the Data API at runtime;
 *  - RPC existence and parameter NAMES are read from PostgREST's OpenAPI
 *    description (never invoked blind);
 *  - opening RPCs are discovered by scanning the whole spec for
 *    /rpc/<name> entries matching /open/i, then classified by verb — the
 *    implementation's naming is its own choice within that envelope.
 *
 * On current origin/main nothing matches → every gated suite SKIPS with an
 * explicit reason. Against a branch claiming M16, absence of the documented
 * surface — or a signature the binders cannot map — fails LOUDLY as
 * [M16 CONTRACT] so integration fixes bindings deliberately instead of
 * silently loosening assertions.
 */

import type { TestClient } from '../../db/setup'

export type ContractViolation = Error & { contractViolation: true }

export function contractViolation(message: string): ContractViolation {
  const err = new Error(`[M16 CONTRACT] ${message}`) as ContractViolation
  err.contractViolation = true
  return err
}

const tableCache = new Map<string, boolean>()

/** Probes relation existence through the Data API without assuming any grant shape. */
export async function tableExists(service: TestClient, relation: string): Promise<boolean> {
  const cached = tableCache.get(relation)
  if (cached !== undefined) return cached

  const { error } = await service.from(relation).select('*').limit(1)
  // A missing relation surfaces as PGRST205 ("Could not find the table ... in the schema
  // cache") or an equivalent message. Anything else means the relation EXISTS but may be
  // unreadable even for this client — which still counts as present.
  const missing =
    error !== null &&
    (error.code === 'PGRST205' ||
      /could not find the table|does not exist|relation .* does not exist/i.test(error.message))
  const result = !missing
  tableCache.set(relation, result)
  return result
}

/**
 * Probes whether a selectable column exists on a table. Absence is detected via the
 * schema-cache error shapes PostgREST returns for unknown select columns; any other
 * error conservatively counts as "present but restricted".
 */
const columnCache = new Map<string, boolean>()

export async function columnExists(
  service: TestClient,
  table: string,
  column: string,
): Promise<boolean> {
  const key = `${table}.${column}`
  const cached = columnCache.get(key)
  if (cached !== undefined) return cached

  const { error } = await service.from(table).select(column).limit(1)
  let present: boolean
  if (!error) {
    present = true
  } else if (
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    /could not find|column .* does not exist|does not exist/i.test(error.message)
  ) {
    present = false
  } else {
    present = true
  }
  columnCache.set(key, present)
  return present
}

// ---------------------------------------------------------------------------
// OpenAPI discovery (m12-adversarial pattern; never invokes anything)
// ---------------------------------------------------------------------------

interface RpcSignatureBase {
  name: string
  paramNames: string[]
}

let openApiPaths: Record<string, unknown> | null | undefined

async function loadOpenApiPaths(): Promise<Record<string, unknown> | null> {
  if (openApiPaths !== undefined) return openApiPaths
  const url = process.env['SUPABASE_URL']
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY']
  if (!url || !key) {
    openApiPaths = null
    return openApiPaths
  }
  try {
    const response = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
    if (!response.ok) {
      openApiPaths = null
      return openApiPaths
    }
    const spec = (await response.json()) as { paths?: Record<string, unknown> }
    openApiPaths = spec.paths ?? null
  } catch {
    openApiPaths = null
  }
  return openApiPaths
}

async function rpcSignature(name: string): Promise<RpcSignatureBase | null> {
  const paths = await loadOpenApiPaths()
  if (!paths) return null
  const entry = paths[`/rpc/${name}`]
  if (!entry || typeof entry !== 'object') return null
  const post = (entry as { post?: { parameters?: unknown; requestBody?: unknown } }).post
  const rawParams = Array.isArray(post?.parameters) ? (post?.parameters as unknown[]) : []
  let paramNames = rawParams
    .map((p) => p as { name?: string })
    .map((p) => p.name)
    .filter((n): n is string => typeof n === 'string')

  // PostgREST describes the body either as one "args" parameter carrying
  // schema.properties, or under requestBody.content["application/json"].
  if (paramNames.length === 0 || paramNames.includes('args')) {
    const bodyParam = rawParams.find((p) => (p as { name?: string }).name === 'args') as
      { schema?: { properties?: Record<string, unknown> } } | undefined
    const bodyContent = post?.requestBody as
      | { content?: { 'application/json'?: { schema?: { properties?: Record<string, unknown> } } } }
      | undefined
    const bodyProps =
      bodyParam?.schema?.properties ??
      bodyContent?.content?.['application/json']?.schema?.properties
    if (bodyProps && Object.keys(bodyProps).length > 0) {
      paramNames = Object.keys(bodyProps)
    }
  }
  return { name, paramNames }
}

/** Every RPC in the spec whose name mentions openings/opened ("open" alone is too noisy). */
export interface DiscoveredOpeningRpc {
  name: string
  paramNames: string[]
  verbs: string[]
}

const VERB_MATCHERS: readonly { verb: string; pattern: RegExp }[] = [
  { verb: 'create', pattern: /create|^add$|^record$|^new/i },
  { verb: 'pull', pattern: /pull/i },
  { verb: 'void', pattern: /void|cancel|reverse/i },
  { verb: 'reconcile', pattern: /reconcile|link/i },
  { verb: 'read', pattern: /^get|^list|^fetch|^detail/i },
  { verb: 'update', pattern: /update|edit|amend/i },
]

export async function discoverOpeningRpcs(): Promise<DiscoveredOpeningRpc[]> {
  const paths = await loadOpenApiPaths()
  if (!paths) return []
  const found: DiscoveredOpeningRpc[] = []
  for (const path of Object.keys(paths)) {
    const match = /^\/rpc\/([a-z0-9_]+)$/i.exec(path)
    if (!match) continue
    const name = match[1]
    if (!name) continue
    if (!/open/i.test(name)) continue
    const sig = await rpcSignature(name)
    if (!sig) continue
    const verbs = VERB_MATCHERS.filter((v) => v.pattern.test(name)).map((v) => v.verb)
    found.push({ name, paramNames: sig.paramNames, verbs })
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

function findRpc(
  discovered: readonly DiscoveredOpeningRpc[],
  classify: (rpc: DiscoveredOpeningRpc) => boolean,
): DiscoveredOpeningRpc | null {
  return discovered.find(classify) ?? null
}

/** Matches a parameter name against any of the given patterns. */
function takeParam(rpc: DiscoveredOpeningRpc, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const hit = rpc.paramNames.find((p) => pattern.test(p))
    if (hit) return hit
  }
  return null
}

// ---------------------------------------------------------------------------
// Semantic-slot binders
//
// The CONTRACT is semantic (which lot(s), how many units, which date); the
// implementation's parameter spelling is its own. Each binder maps slots onto
// discovered names and throws a loud contractViolation when the surface cannot
// express the documented behaviour — never silently guesses a call.
//
// P53 INTEGRATION BINDING (deliberate, assertion-preserving):
// The shipped implementation folds pull creation INTO the atomic
// create-with-pulls design (`create_opening(p_source_lot_id, p_quantity, …,
// p_pulls jsonb)`), and expresses the provisional path as a dedicated
// `create_opening_from_provisional(… p_total_paid_minor …)` taking the receipt
// TOTAL rather than a per-unit price. The binders below therefore accept BOTH
// dialects where both are canonical-compatible:
//   - consumption list as [{lot_id|source_lot_id, quantity}] OR the scalar
//     (source_lot_id + quantity) pair of the single-source-lot model;
//   - pull attachment via a dedicated pull-shaped RPC OR folded into creation;
//   - the provisional money slot via manual-cost/total-paid/unit-price names.
// Nothing here loosens an assertion: every divergence outside these dialects
// still fails as [M16 CONTRACT].
// ---------------------------------------------------------------------------

export interface ConsumptionIntent {
  /** Sealed acquisition lot the units come from. */
  lotId: string
  quantity: number
}

/** A pulled card riding creation (folded design) or a dedicated add-pull RPC. */
export interface PullIntent {
  cardVariantId?: string
  manualCardId?: string
  quantity: number
  condition?: string
}

export interface OpeningCreateIntent {
  openedOn: string
  /** Linked-lot path: consumes owned sealed units. */
  consumptions?: readonly ConsumptionIntent[]
  /** D-021 provisional path: manual cost, no owned consumable lot. */
  manualCostNokMinor?: number
  /** Pulled cards attached atomically at creation time (P53 §15 execution-bound). */
  pulls?: readonly PullIntent[]
  notes?: string
}

/**
 * Binds create_opening. Three payload dialects are attempted for the consumption
 * list because all are canonical-compatible spellings of "consume q from lot":
 *   [{ lot_id, quantity }]            (singular keys, output_44/DATA_MODEL shape)
 *   [{ source_lot_id, quantity }]     (the §5.8 sketch's source_lot_id vocabulary)
 *   scalar p_source_lot_id + p_quantity (the shipped single-source-lot model)
 */
export function bindOpeningCreateArgs(
  rpc: DiscoveredOpeningRpc,
  intent: OpeningCreateIntent,
): Record<string, unknown> {
  const dateParam =
    takeParam(rpc, [/^p_?opened_?on$/i, /opened_?on/i, /opened_?date/i]) ??
    fail(rpc, ['opened_on date'])
  const args: Record<string, unknown> = { [dateParam]: intent.openedOn }

  const arrayLotsParam = takeParam(rpc, [/^p_?source_?lots$/i, /consum/i])
  const scalarLotParam = takeParam(rpc, [/^p_?source_?lot_?id$/i, /^p_?lot_?id$/i])
  const lotsParam = arrayLotsParam ?? scalarLotParam
  const costParam = takeParam(rpc, [/manual_?cost/i, /total_?paid/i, /cost_?minor/i, /^p_?cost/i])
  const wantsProvisional = intent.manualCostNokMinor !== undefined

  if (wantsProvisional && intent.consumptions) {
    throw contractViolation(
      `create-opening RPC "${rpc.name}" was called with BOTH linked lots and a manual cost; ` +
        `F12 forbids two live cost sources. Fix the test intent.`,
    )
  }

  if (intent.consumptions) {
    const scalar =
      scalarLotParam !== null && takeParam(rpc, [/^p_?quantity$/i]) !== null && !arrayLotsParam
    if (!lotsParam) {
      throw contractViolation(
        `create-opening RPC "${rpc.name}" exposes parameters (${rpc.paramNames.join(', ')}) that ` +
          `cannot express linked-lot consumption [source lots + quantities]. If consumption moved ` +
          `to another surface, update helpers/contract.ts deliberately.`,
      )
    }
    if (scalar) {
      // Shipped single-source-lot model: one lot id + one quantity per call.
      if (intent.consumptions.length !== 1) {
        throw contractViolation(
          `create-opening RPC "${rpc.name}" binds the single-source-lot dialect but the intent ` +
            `names ${intent.consumptions.length} lots. One opening consumes ONE lot — split the intent.`,
        )
      }
      const only = intent.consumptions[0]!
      args[scalarLotParam!] = only.lotId
      const qtyParam = takeParam(rpc, [/^p_?quantity$/i])
      if (!qtyParam) {
        throw contractViolation(
          `create-opening RPC "${rpc.name}" has no quantity parameter alongside ${scalarLotParam}.`,
        )
      }
      args[qtyParam] = only.quantity
    } else {
      args[lotsParam] = intent.consumptions.map((c) => ({
        lot_id: c.lotId,
        source_lot_id: c.lotId,
        quantity: c.quantity,
      }))
    }
  } else if (wantsProvisional) {
    if (!costParam) {
      throw contractViolation(
        `create-opening RPC "${rpc.name}" exposes parameters (${rpc.paramNames.join(', ')}) that ` +
          `cannot express the D-021 provisional manual cost. FINANCIAL_MODEL §5.5 requires it. ` +
          `If the implementation ships a dedicated provisional-create RPC instead, bind it via ` +
          `bindProvisionalOpeningArgs deliberately.`,
      )
    }
    args[costParam] = intent.manualCostNokMinor
  }

  // Folded pulls: attach at creation when the implementation exposes a pulls array.
  if (intent.pulls && intent.pulls.length > 0) {
    const pullsParam = takeParam(rpc, [/^p_?pulls$/i, /^p_?pull_?items$/i])
    if (!pullsParam) {
      throw contractViolation(
        `create-opening RPC "${rpc.name}" exposes no pulls-array parameter among ` +
          `(${rpc.paramNames.join(', ')}) — pulls cannot ride creation. Update ` +
          `helpers/contract.ts deliberately if a separate pull surface exists.`,
      )
    }
    args[pullsParam] = intent.pulls.map((pull) => ({
      card_variant_id: pull.cardVariantId ?? null,
      manual_card_id: pull.manualCardId ?? null,
      quantity: pull.quantity,
      condition: pull.condition ?? null,
    }))
  }
  return args
}

export interface AddPullIntent {
  openingId: string
  quantity: number
  cardVariantId?: string
  condition?: string
}

export function bindAddPullArgs(
  rpc: DiscoveredOpeningRpc,
  intent: AddPullIntent,
): Record<string, unknown> {
  const openingParam = takeParam(rpc, [/opening_?id/i]) ?? fail(rpc, ['opening_id'])
  const qtyParam = takeParam(rpc, [/^p_?quantity$/i, /quantity/i]) ?? fail(rpc, ['quantity'])
  const variantParam = takeParam(rpc, [/card_?variant_?id/i])
  const conditionParam = takeParam(rpc, [/condition/i])

  if (intent.cardVariantId !== undefined && !variantParam) {
    throw contractViolation(
      `pull-addition RPC "${rpc.name}" has no card variant parameter ` +
        `(${rpc.paramNames.join(', ')}) — pulls must attach to catalog identity.`,
    )
  }

  const args: Record<string, unknown> = {
    [openingParam]: intent.openingId,
    [qtyParam]: intent.quantity,
  }
  if (intent.cardVariantId !== undefined && variantParam) args[variantParam] = intent.cardVariantId
  if (intent.condition !== undefined && conditionParam) args[conditionParam] = intent.condition
  return args
}

// ---------------------------------------------------------------------------
// Provisional-path binding (P53): prefers the dedicated provisional-create RPC
// the shipped implementation exposes, falling back to a manual-cost slot on the
// generic create RPC only when no dedicated surface exists.
// ---------------------------------------------------------------------------

export function findProvisionalCreateRpc(surface: M16Surface): DiscoveredOpeningRpc | null {
  return (
    findRpc(
      surface.openingRpcs,
      (r) =>
        r.verbs.includes('create') && /provisional|from_?purchase|buy|total_?paid/i.test(r.name),
    ) ?? null
  )
}

export interface ProvisionalCreateIntent {
  sealedProductId?: string
  /** The receipt TOTAL paid (D-090) or a legacy per-unit figure — the binder is spelling-agnostic. */
  manualCostNokMinor: number
  purchasedOn?: string
  openedOn?: string
  quantity?: number
  notes?: string
}

export function bindProvisionalOpeningArgs(
  rpc: DiscoveredOpeningRpc,
  intent: ProvisionalCreateIntent,
): Record<string, unknown> {
  const productParam = takeParam(rpc, [/sealed_?product_?id/i])
  const totalParam = takeParam(rpc, [
    /total_?paid/i,
    /^p_?unit_?price/i,
    /manual_?cost/i,
    /cost_?minor/i,
    /^p_?cost/i,
  ])
  const purchasedOnParam = takeParam(rpc, [/purchased_?on/i, /^p_?date$/i])
  const openedOnParam = takeParam(rpc, [/opened_?on/i])

  if (!productParam || !totalParam) {
    throw contractViolation(
      `provisional-create RPC "${rpc.name}" parameters (${rpc.paramNames.join(', ')}) cannot ` +
        `express (sealed product, money). FINANCIAL_MODEL §5.5 requires both. Update ` +
        `helpers/contract.ts deliberately — never by loosening an assertion.`,
    )
  }

  const args: Record<string, unknown> = {
    [productParam]: intent.sealedProductId,
    [totalParam]: intent.manualCostNokMinor,
  }
  if (intent.quantity !== undefined) {
    const qtyParam = takeParam(rpc, [/^p_?quantity$/i, /quantity/i])
    if (qtyParam) args[qtyParam] = intent.quantity
  }
  if (intent.purchasedOn !== undefined && purchasedOnParam) {
    args[purchasedOnParam] = intent.purchasedOn
  }
  if (intent.openedOn !== undefined && openedOnParam) args[openedOnParam] = intent.openedOn
  if (intent.notes !== undefined) {
    const notesParam = takeParam(rpc, [/^p_?notes$/i, /notes/i])
    if (notesParam) args[notesParam] = intent.notes
  }
  return args
}

export function bindOpeningIdOnlyArgs(
  rpc: DiscoveredOpeningRpc,
  openingId: string,
): Record<string, unknown> {
  const openingParam = takeParam(rpc, [/opening_?id/i]) ?? fail(rpc, ['opening_id'])
  return { [openingParam]: openingId }
}

function fail(rpc: DiscoveredOpeningRpc, slot: string[]): never {
  throw contractViolation(
    `RPC "${rpc.name}" exists but its parameters (${rpc.paramNames.join(', ') || 'none'}) do not ` +
      `cover the contract slot(s) [${slot.join(', ')}]. Update helpers/contract.ts deliberately — ` +
      `never by loosening an assertion.`,
  )
}

// ---------------------------------------------------------------------------
// Surface probe + gates
// ---------------------------------------------------------------------------

export interface M16Surface {
  /** openings canonical table present. */
  openingsTable: boolean
  /** acquisition_lots.opening_id linkage column present. */
  pullLinkColumn: boolean
  /** lot_disposals.opening_id linkage column present. */
  disposalLinkColumn: boolean
  /** audit_events must NOT exist on current schema (§10). */
  auditEventsTable: boolean
  openingRpcs: readonly DiscoveredOpeningRpc[]
}

let surfaceCache: M16Surface | null = null

export async function probeM16Surface(service: TestClient): Promise<M16Surface> {
  if (surfaceCache) return surfaceCache
  const [openingsTable, pullLinkColumn, disposalLinkColumn, auditEventsTable, openingRpcs] =
    await Promise.all([
      tableExists(service, 'openings'),
      columnExists(service, 'acquisition_lots', 'opening_id'),
      columnExists(service, 'lot_disposals', 'opening_id'),
      tableExists(service, 'audit_events'),
      discoverOpeningRpcs(),
    ])
  surfaceCache = {
    openingsTable,
    pullLinkColumn,
    disposalLinkColumn,
    auditEventsTable,
    openingRpcs,
  }
  return surfaceCache
}

export function hasSupabaseEnv(): boolean {
  return Boolean(process.env['SUPABASE_URL'] && process.env['SUPABASE_SERVICE_ROLE_KEY'])
}

/**
 * Gate for DB-backed suites needing a stack but NOT the M16 schema
 * (ACTIVE_CURRENT-SCHEMA tests). Skips without an ephemeral stack.
 */
export async function requireSupabaseStack(ctx: { skip(note?: string): void }): Promise<void> {
  if (!hasSupabaseEnv()) {
    ctx.skip(
      'No Supabase ephemeral stack configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset). ' +
        'Run `pnpm db:start`, export the values from `pnpm exec supabase status -o env`, or CI. ' +
        'Until then this case is IMPLEMENTATION_GATED_PENDING_CI_RESET.',
    )
  }
}

/**
 * Gate for every M16-dependent test. On current main this skips with an explicit
 * message naming what is missing; once aimed at an M16 branch it runs for real.
 * Use INSIDE each `it` (beforeAll-time seeding must not fail on a pre-M16 schema).
 */
export async function skipUnlessM16(
  ctx: { skip(note?: string): void },
  service: TestClient,
): Promise<M16Surface> {
  if (!hasSupabaseEnv()) {
    ctx.skip(
      'No Supabase ephemeral stack configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset). ' +
        'IMPLEMENTATION_GATED_PENDING_CI_RESET.',
    )
  }
  const surface = await probeM16Surface(service)
  if (!surface.openingsTable || !surface.pullLinkColumn || !surface.disposalLinkColumn) {
    ctx.skip(
      'M16 openings schema not present on this database (openings table and/or the ' +
        'acquisition_lots / lot_disposals opening_id linkage columns are missing). This suite ' +
        'asserts the M16 contract and stays skipped until the implementation lands.',
    )
  }
  return surface
}

/** Finds the create-shaped opening RPC, loudly absent → contract violation when M16 exists. */
export function requireCreateOpeningRpc(surface: M16Surface): DiscoveredOpeningRpc {
  const rpc = findRpc(surface.openingRpcs, (r) => r.verbs.includes('create'))
  if (!rpc) {
    throw contractViolation(
      `M16 schema is present but no create-shaped opening RPC was discovered ` +
        `(scanned every /rpc/* matching /open/i: ${surface.openingRpcs.map((r) => r.name).join(', ') || 'none'}).`,
    )
  }
  return rpc
}

/**
 * Pull attachment surface (P53 §4/§15 binding decision). The shipped implementation folds
 * pull creation INTO the atomic create-with-pulls call; a separate pull-shaped RPC is NOT
 * required merely to satisfy heuristic discovery. This resolver names which dialect exists so
 * the oracles attach pulls execution-bound instead of skipping:
 *   - dedicated: a /pull/i-named RPC — attach post-hoc via bindAddPullArgs;
 *   - folded:    pulls ride creation via bindOpeningCreateArgs({ pulls }).
 * Neither mode weakens an assertion: pull lots must still exist, still carry NULL basis, and
 * still be owner-scoped wherever an oracle looks.
 */
export type PullSurface =
  { mode: 'dedicated'; rpc: DiscoveredOpeningRpc } | { mode: 'folded'; rpc: DiscoveredOpeningRpc }

export function resolvePullSurface(surface: M16Surface): PullSurface {
  const dedicated = findRpc(surface.openingRpcs, (r) => r.verbs.includes('pull'))
  if (dedicated) return { mode: 'dedicated', rpc: dedicated }
  return { mode: 'folded', rpc: requireCreateOpeningRpc(surface) }
}

export function requireVoidOpeningRpc(surface: M16Surface): DiscoveredOpeningRpc {
  const rpc = findRpc(surface.openingRpcs, (r) => r.verbs.includes('void'))
  if (!rpc) {
    throw contractViolation(
      `M16 schema is present but no void-shaped opening RPC was discovered ` +
        `(${surface.openingRpcs.map((r) => r.name).join(', ') || 'none'}). ` +
        `DATA_MODEL §9 requires the void lifecycle for openings.`,
    )
  }
  return rpc
}

/** Optional surfaces: reconciliation / reads. Returns null when genuinely absent. */
export function findReconcileRpc(surface: M16Surface): DiscoveredOpeningRpc | null {
  return findRpc(surface.openingRpcs, (r) => r.verbs.includes('reconcile'))
}

export function findReadRpcs(surface: M16Surface): readonly DiscoveredOpeningRpc[] {
  return surface.openingRpcs.filter((r) => r.verbs.includes('read'))
}

/**
 * Named-RPC discovery for surfaces that ALREADY exist on current main
 * (drain_portfolio_recompute_queue, list_history_events, …). These are stable,
 * shipped APIs — safe to call by their real names; discovery only guards
 * against running before the stack has migrations applied.
 */
export async function discoverNamedRpc(name: string): Promise<RpcSignatureBase | null> {
  return rpcSignature(name)
}

/**
 * Drains the M12 recompute queue via the service role (the engine routine is
 * service-only by design). Used by the backdated-timeline oracle to force the
 * snapshot cache to converge deterministically instead of waiting on cron.
 */
export async function drainRecomputeQueue(service: TestClient): Promise<number> {
  const sig = await discoverNamedRpc('drain_portfolio_recompute_queue')
  if (!sig) throw new Error('drain_portfolio_recompute_queue not found — pre-M12 stack?')
  const { data, error } = await service.rpc('drain_portfolio_recompute_queue')
  if (error) throw new Error(`queue drain failed: ${error.message}`)
  return typeof data === 'number' ? data : Number(data ?? 0)
}
