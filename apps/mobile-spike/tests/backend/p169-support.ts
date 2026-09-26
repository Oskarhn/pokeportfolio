import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createChunkedSessionStorage } from '../../src/auth/chunked-session-storage'
import { createNativeClient, removeStoredSession } from '../../src/auth/create-client'
import { createSharedCollectionPort } from '../../src/collection/shared-data-adapter'
import type { P169Feature } from '../../src/features/feature'
import { fxRateReaderFor } from '../../src/features/price-check/fx-source'
import type { SearchPricesInvoker } from '../../src/features/price-check/search-prices-source'
import type { RequestLogEntry } from '../../src/net/spike-fetch'
import { createFixturePriceCheckPort } from '../../src/price-check/fixture-adapter'
import { createReleasedPriceCheckPort } from '../../src/price-check/released-adapter'
import { createRuntime, type Runtime } from '../../src/wiring/runtime'
import { setBackendClient } from '../support/backend-supabase-client'
import { FakePhotoPort, MemoryKeyValueStore } from '../support/fakes'

/**
 * Harness for tests against the REAL isolated P169 stack (project pokeportfolio-p169, API 55921;
 * with P169_STACK=db106 the DB-106 candidate stack, API 56021): real GoTrue, PostgREST, the served
 * search-prices functions (candidate + released, from git objects) and the local synthetic TCGdex
 * mock. Synthetic data only. Runs only with P169_LOCAL_BACKEND=1.
 */

export const P169_ENABLED = process.env.P169_LOCAL_BACKEND === '1'
export const p169Describe = P169_ENABLED ? describe : describe.skip

// P169_STACK: db106 (the DB-106 candidate stack), p170 (the integrated stack) or unset (P169's).
const STACK_DIRS: Record<string, string | undefined> = { db106: 'p169-db106', p170: 'p170' }
const stackName: string = process.env.P169_STACK ?? ''
const dir = join(__dirname, '../../.local-backend', STACK_DIRS[stackName] ?? 'p169')
export const MOCK_URL = `http://127.0.0.1:${process.env.P169_MOCK_PORT ?? '55979'}`

interface PublicEnv {
  apiUrl: string
  publishableKey: string
  dbContainer: string
}
export interface Fixture {
  users: {
    a: { id: string; email: string; password: string }
    b: { id: string; email: string; password: string }
  }
  catalog: Record<string, { cardId: string; variants: Record<string, string> }>
}

export function publicEnv(): PublicEnv {
  return JSON.parse(readFileSync(join(dir, 'public-env.json'), 'utf8')) as PublicEnv
}
export function fixture(): Fixture {
  if (!existsSync(join(dir, 'fixture.json'))) throw new Error('P169 stack not seeded')
  return JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')) as Fixture
}

export function psql(sql: string): string {
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      publicEnv().dbContainer,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: sql, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  )
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`)
  return r.stdout.trim()
}

/** Every table whose content a read-only feature must never change. */
export const LEDGER_TABLES = [
  'holdings',
  'acquisition_lots',
  'manual_valuations',
  'manual_card_definitions',
  'purchases',
  'purchase_lines',
  'sales',
  'sale_lines',
  'lot_disposals',
  'lot_cost_adjustments',
  'sealed_products',
  'openings',
  'price_snapshots',
  'fx_rates',
  'profiles',
  'cards',
  'card_variants',
] as const

export function ledgerHashes(): Record<string, string> {
  const sql = LEDGER_TABLES.map(
    (t) =>
      `select '${t}' || '=' || count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '-') from public.${t} x;`,
  ).join('\n')
  return Object.fromEntries(
    psql(sql)
      .split('\n')
      .map((l) => l.split('=') as [string, string]),
  )
}

export async function mockProviderCalls(): Promise<number> {
  const r = (await (await fetch(`${MOCK_URL}/__log`)).json()) as { requests: unknown[] }
  return r.requests.length
}

export interface P169Session {
  runtime: Runtime
  feature: P169Feature
  log: RequestLogEntry[]
  client: ReturnType<typeof createNativeClient>
}

/**
 * The app's composition over a REAL native client (read-only policy + exact-transport guard).
 * `functionTarget: 'released'` rewrites the function URL BENEATH the guards to the released
 * function served next to the candidate: the client and its policy still see `search-prices`.
 */
export function p169Session(
  options: { functionTarget?: 'candidate' | 'released' } = {},
): P169Session {
  const env = publicEnv()
  const storage = createChunkedSessionStorage(new MemoryKeyValueStore(2048))
  const log: RequestLogEntry[] = []
  const baseFetch: typeof fetch =
    options.functionTarget === 'released'
      ? (input, init) =>
          fetch(
            typeof input === 'string'
              ? input.replace('/functions/v1/search-prices', '/functions/v1/search-prices-released')
              : input,
            init,
          )
      : fetch
  const client = createNativeClient(
    { url: env.apiUrl, publishableKey: env.publishableKey, host: '127.0.0.1' },
    { storage, baseFetch, fetchOptions: { onRequest: (e) => log.push(e) } },
  )
  setBackendClient(client)
  const invoke: SearchPricesInvoker = (name, opts) => client.functions.invoke(name, opts)
  const runtime = createRuntime({
    auth: client.auth,
    removeStoredSession: () => removeStoredSession(storage),
    collection: createSharedCollectionPort(),
    priceCheck: {
      released: createReleasedPriceCheckPort(),
      fixture: createFixturePriceCheckPort(),
    },
    priceFeature: {
      invoke,
      readFx: fxRateReaderFor(client),
      searchOptions: { debounceMs: 0 },
    },
    photo: new FakePhotoPort(),
  })
  runtime.auth.start()
  return { runtime, feature: runtime.feature, log, client }
}

export async function signIn(s: P169Session, who: 'a' | 'b'): Promise<void> {
  const u = fixture().users[who]
  const r = await s.runtime.auth.signIn(u.email, u.password)
  if (!r.ok) throw new Error(`sign-in failed: ${r.kind}`)
  await until(() => s.runtime.authority.userId === u.id)
}

export async function until(predicate: () => boolean, ms = 20000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}
