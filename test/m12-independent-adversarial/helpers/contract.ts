import type { TestClient } from '../../../tests/db/setup'

/**
 * Contract probes for the M12 dashboard surface (test/m12-independent-adversarial/README.md §3).
 *
 * Everything here is deliberately BLACK-BOX. This package was written against the documented
 * contract only — DATA_MODEL.md §6 (`portfolio_snapshots`, `portfolio_recompute_queue`),
 * FINANCIAL_MODEL.md §3/§6, UX_FLOWS.md F10 and the M12 adversarial brief — without reading the
 * implementation branch. These helpers therefore DISCOVER what exists at runtime instead of
 * assuming it:
 *
 *  - `m12SchemaPresent` probes for the snapshot cache table. When it is absent (current main),
 *    suites gate themselves through `skipUnlessM12` so they skip with an explicit reason rather
 *    than failing noisily against a milestone that has not been applied yet. Against a branch
 *    that CLAIMS to implement M12, absence is itself a finding.
 *  - `discoverRpc` reads PostgREST's OpenAPI description to learn whether a function exists and
 *    what its parameter names are, WITHOUT invoking it. Engine functions are then called through
 *    `bindEngineArgs`, which maps semantic slots (user / from / through) onto whatever parameter
 *    names the implementation actually chose. A signature that cannot be mapped is a loud,
 *    self-explaining failure — never a guessed call into the wrong function.
 */

export type ContractViolation = Error & { contractViolation: true }

export function contractViolation(message: string): ContractViolation {
  const err = new Error(`[M12 CONTRACT] ${message}`) as ContractViolation
  err.contractViolation = true
  return err
}

const tableCache = new Map<string, boolean>()

/** Probes relation existence through the Data API without assuming any grant shape. */
export async function tableExists(service: TestClient, relation: string): Promise<boolean> {
  const cached = tableCache.get(relation)
  if (cached !== undefined) return cached

  const { error } = await service.from(relation).select('*').limit(1)
  // A missing relation surfaces as PGRST205 ("Could not find the table ... in the schema cache")
  // or, on some PostgREST versions, as a 404-shaped "relation does not exist" message. Anything
  // else (permission denied etc.) means the table EXISTS but is not readable even by this client
  // — which for our purposes still counts as present.
  const missing =
    error !== null &&
    (error.code === 'PGRST205' ||
      /could not find the table|does not exist|relation .* does not exist/i.test(error.message))
  const result = !missing
  tableCache.set(relation, result)
  return result
}

export interface RpcSignature {
  name: string
  paramNames: string[]
}

let openApiPaths: Record<string, unknown> | null | undefined

async function loadOpenApiPaths(): Promise<Record<string, unknown> | null> {
  if (openApiPaths !== undefined) return openApiPaths
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
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

/**
 * Discovers an RPC's existence and parameter names from the OpenAPI document. Never invokes the
 * function. Returns null when the function does not exist (or the spec cannot be read — callers
 * decide which of those is fatal for their assertion).
 */
export async function discoverRpc(
  _service: TestClient,
  name: string,
): Promise<RpcSignature | null> {
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

  // PostgREST's OpenAPI v2 document describes an RPC request body as a SINGLE parameter named
  // "args" whose schema.properties carry the actual argument names; some versions place the same
  // map under requestBody.content["application/json"].schema.properties instead. Without this
  // descent, every multi-argument function looks like it takes one argument called "args" and
  // every bindParams call would raise a false signature-divergence contract violation.
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

export type EngineSlots = 'user' | 'from' | 'through' | 'date'

/**
 * Maps semantic slots onto the discovered parameter names. The M12 engine contract is stated in
 * semantic terms (whose portfolio, which date range); the implementation's parameter spelling is
 * its own choice, so the suite adapts to it rather than hard-coding a guess.
 */
export function bindParams(
  sig: RpcSignature,
  wanted: Partial<Record<EngineSlots, unknown>>,
): Record<string, unknown> {
  const bound: Record<string, unknown> = {}
  const unmatched: string[] = []

  const matchers: Record<EngineSlots, RegExp> = {
    user: /user/i,
    from: /from|start/i,
    through: /through|to_|end/i,
    date: /date|on$/i,
  }

  for (const [slot, value] of Object.entries(wanted) as [EngineSlots, unknown][]) {
    const name = sig.paramNames.find((p) => matchers[slot].test(p))
    if (!name) {
      unmatched.push(slot)
      continue
    }
    bound[name] = value
  }

  if (unmatched.length > 0) {
    throw contractViolation(
      `RPC "${sig.name}" exists but its parameters (${sig.paramNames.join(', ') || 'none'}) do not ` +
        `cover the contract slots [${unmatched.join(', ')}]. The engine's signature has diverged ` +
        `from the documented rebuild(user, from, through) contract; update helpers/contract.ts ` +
        `deliberately, not silently.`,
    )
  }
  return bound
}

export interface M12Surface {
  snapshots: boolean
  queue: boolean
  rebuild: RpcSignature | null
  drain: RpcSignature | null
}

let surfaceCache: M12Surface | null = null

export async function probeM12Surface(service: TestClient): Promise<M12Surface> {
  if (surfaceCache) return surfaceCache
  const [snapshots, queue, rebuild, drain] = await Promise.all([
    tableExists(service, 'portfolio_snapshots'),
    tableExists(service, 'portfolio_recompute_queue'),
    discoverRpc(service, 'rebuild_portfolio_snapshots'),
    discoverRpc(service, 'drain_portfolio_recompute_queue'),
  ])
  surfaceCache = { snapshots, queue, rebuild, drain }
  return surfaceCache
}

/**
 * True when the harness environment points at an ephemeral Supabase stack (same variables
 * `pnpm test:db` requires). Without one, every database-backed test skips with an explicit
 * reason instead of crashing in fixture setup - the oracle self-tests still run everywhere.
 */
export function hasSupabaseEnv(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

/**
 * Gate for every M12-dependent test. On current main this skips the test with an explicit
 * message; once applied against an M12 implementation it runs for real. Use INSIDE each `it`
 * before any fixture work, because beforeAll-time seeding must not fail on a pre-M12 schema.
 */
export async function skipUnlessM12(
  ctx: { skip: (note?: string) => void },
  service: TestClient,
): Promise<M12Surface> {
  if (!hasSupabaseEnv()) {
    ctx.skip(
      'No Supabase ephemeral stack configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset). ' +
        'Export the values from `pnpm exec supabase status -o env` or run in CI db-tests.',
    )
  }
  const surface = await probeM12Surface(service)
  if (!surface.snapshots || !surface.queue) {
    ctx.skip(
      'M12 schema not present on this database (portfolio_snapshots / portfolio_recompute_queue ' +
        'missing). This suite targets the M12 dashboard contract; apply it against the ' +
        'implementation branch.',
    )
  }
  return surface
}

/** Read RPC names the contract expects Home to be built on (UX_FLOWS.md F10, HANDOVER M12 section). */
export const READ_RPCS = [
  'get_dashboard_summary',
  'get_portfolio_history',
  'get_monthly_spend',
  'get_recent_activity',
] as const

export type ReadRpcName = (typeof READ_RPCS)[number]

export async function readRpcSignature(
  service: TestClient,
  name: ReadRpcName,
): Promise<RpcSignature | null> {
  return discoverRpc(service, name)
}

export const SNAPSHOT_COLUMNS = [
  'market_value_nok_minor',
  'attributed_value_nok_minor',
  'cost_basis_nok_minor',
  'collectible_spend_to_date_nok_minor',
  'sales_proceeds_to_date_nok_minor',
  'open_lot_count',
  'unvalued_lot_count',
] as const

export type SnapshotColumn = (typeof SNAPSHOT_COLUMNS)[number]

export type SnapshotRowLike = {
  snapshot_date: string
  computed_at?: string | null
} & Partial<Record<SnapshotColumn, unknown>>
