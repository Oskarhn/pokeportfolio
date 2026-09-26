import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { AuthController } from '../../src/auth/auth-controller'
import {
  createChunkedSessionStorage,
  type SessionStorage,
} from '../../src/auth/chunked-session-storage'
import {
  AUTH_STORAGE_KEY,
  createNativeClient,
  removeStoredSession,
} from '../../src/auth/create-client'
import { createSharedCollectionPort } from '../../src/collection/shared-data-adapter'
import { fxRateReaderFor } from '../../src/features/price-check/fx-source'
import { createReleasedPriceCheckPort } from '../../src/price-check/released-adapter'
import { createFixturePriceCheckPort } from '../../src/price-check/fixture-adapter'
import type { RequestLogEntry } from '../../src/net/spike-fetch'
import { createRuntime, type Runtime } from '../../src/wiring/runtime'
import { FakePhotoPort, MemoryKeyValueStore } from '../support/fakes'
import { setBackendClient } from '../support/backend-supabase-client'

/**
 * Harness for the tests that run against the REAL isolated local Supabase stack (default project id
 * pokeportfolio-p158-mobile on ports 553xx; a worktree may record its own in .local-backend/stack.json,
 * see scripts/local-backend.mjs; synthetic data only). They run only when P158_LOCAL_BACKEND=1, so
 * `pnpm test` never needs Docker.
 */

export const BACKEND_ENABLED = process.env.P158_LOCAL_BACKEND === '1'
/** `describe` when the backend is enabled, `describe.skip` otherwise. */
export const backendDescribe = BACKEND_ENABLED ? describe : describe.skip

const dir = join(__dirname, '../../.local-backend')

interface PublicEnv {
  apiUrl: string
  publishableKey: string
  dbContainer: string
  apiPort?: number
}

/** The stack this worktree started (written by `local-backend.mjs start`), or the P158 default. */
export function stackIdentity(): { projectId: string; portOffset: number } {
  const file = join(dir, 'stack.json')
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { projectId: string; portOffset: number })
    : { projectId: 'pokeportfolio-p158-mobile', portOffset: 1000 }
}
interface Fixture {
  users: {
    a: { id: string; email: string; password: string }
    b: { id: string; email: string; password: string }
  }
  counts: { aHoldings: number; bHoldings: number }
}

export function catalog(): Record<string, { cardId: string; variants: Record<string, string> }> {
  const out = psql(
    "select coalesce(json_object_agg(local_id, json_build_object('cardId', id, 'variants', vs)), '{}'::json) from (select c.local_id, c.id, (select json_object_agg(v.finish::text, v.id) from public.card_variants v where v.card_id = c.id) vs from public.cards c where c.local_id like 'S0%') t;",
  )
  return JSON.parse(out) as Record<string, { cardId: string; variants: Record<string, string> }>
}

export function publicEnv(): PublicEnv {
  return JSON.parse(readFileSync(join(dir, 'public-env.json'), 'utf8')) as PublicEnv
}
export function fixture(): Fixture {
  return JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')) as Fixture
}

/** Read-only SQL against the isolated stack's own database container. */
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
    {
      input: sql,
      encoding: 'utf8',
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    },
  )
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`)
  return r.stdout.trim()
}

export interface Session {
  client: ReturnType<typeof createNativeClient>
  storage: SessionStorage
  store: MemoryKeyValueStore
  log: RequestLogEntry[]
}

/** A native client exactly as the app builds it, over an in-memory stand-in for SecureStore that
 *  REJECTS values above the documented 2048-byte iOS limit. */
export function newSession(
  options: { store?: MemoryKeyValueStore; baseFetch?: typeof fetch; url?: string } = {},
): Session {
  const env = publicEnv()
  const store = options.store ?? new MemoryKeyValueStore(2048)
  const storage = createChunkedSessionStorage(store)
  const log: RequestLogEntry[] = []
  const client = createNativeClient(
    { url: options.url ?? env.apiUrl, publishableKey: env.publishableKey, host: '127.0.0.1' },
    {
      storage,
      ...(options.baseFetch ? { baseFetch: options.baseFetch } : {}),
      fetchOptions: { onRequest: (e) => log.push(e) },
    },
  )
  return { client, storage, store, log }
}

/** The full runtime over a REAL client: real GoTrue, real PostgREST, real shared data layer. */
export function realRuntime(session: Session): Runtime {
  setBackendClient(session.client)
  const fixturePort = createFixturePriceCheckPort()
  const runtime = createRuntime({
    auth: session.client.auth,
    removeStoredSession: () => removeStoredSession(session.storage),
    collection: createSharedCollectionPort(),
    priceCheck: { released: createReleasedPriceCheckPort(), fixture: fixturePort },
    priceFeature: {
      invoke: (name, opts) => session.client.functions.invoke(name, opts),
      readFx: fxRateReaderFor(session.client),
    },
    photo: new FakePhotoPort(),
  })
  runtime.auth.start()
  return runtime
}

export async function settle(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

export async function until(predicate: () => boolean, ms = 15000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await settle(20)
  }
}

export { AUTH_STORAGE_KEY, AuthController }
