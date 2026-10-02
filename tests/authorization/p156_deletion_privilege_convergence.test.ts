import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { connectDb } from '../db/lib/account-deletion-deps'

/**
 * P156: the destructive account-deletion surface, put through the same hostile-grant convergence CI
 * runs for the rest of the schema — but asserted object by object.
 *
 * P152 added a table and six functions that must never be browser-reachable and relied on the
 * existing P133 baseline sweep to close them if a database ever arrived with hostile grants (an
 * untrusted restore, a platform default). "Relied on" is not "shown". This makes the database wrong
 * on purpose, proves each new object is then EXPOSED to anon and authenticated (so the check cannot
 * pass vacuously), re-applies the newest `*_privilege_baseline.sql` chosen the way CI chooses it,
 * and proves each object is closed again with service_role still able to use it.
 *
 * It restores the converged state in a `finally`, so a failure here cannot leave the shared test
 * database hostile for the suites that run after it.
 */

const ROOT = process.cwd()
const migrationsDir = join(ROOT, 'supabase', 'migrations')

const latestBaseline = (): string => {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('_privilege_baseline.sql'))
    .sort()
  if (files.length === 0) throw new Error('no *_privilege_baseline.sql migration found')
  return join(migrationsDir, files[files.length - 1]!)
}

const RPCS = ['begin_account_deletion', 'purge_account_data', 'scrub_account_audit_trail']
const TRIGGER_FUNCTIONS = [
  'account_deletion_write_guard',
  'account_deletion_write_guard_sealed',
  'account_deletion_caller_guard',
]

let db: pg.Client

beforeAll(async () => {
  db = await connectDb()
})
afterAll(async () => {
  await db.end()
})

interface Exposure {
  name: string
  anon: boolean
  authenticated: boolean
  service_role: boolean
  public_exec: boolean
}

async function functionExposure(): Promise<Exposure[]> {
  const res = await db.query<Exposure>(
    `select p.proname as name,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
            exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     where a.grantee = 0) as public_exec
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = any($1)
      order by 1`,
    [[...RPCS, ...TRIGGER_FUNCTIONS]],
  )
  return res.rows
}

async function tableExposure() {
  const res = await db.query<{ anon: boolean; authenticated: boolean; service_role: boolean }>(
    `select has_table_privilege('anon', 'public.account_deletion_requests', 'SELECT, INSERT, UPDATE, DELETE') as anon,
            has_table_privilege('authenticated', 'public.account_deletion_requests', 'SELECT, INSERT, UPDATE, DELETE') as authenticated,
            has_table_privilege('service_role', 'public.account_deletion_requests', 'SELECT, INSERT, UPDATE, DELETE') as service_role`,
  )
  return res.rows[0]!
}

const applyBaseline = () => db.query(readFileSync(latestBaseline(), 'utf8'))
const runAudit = () => db.query(readFileSync(join(ROOT, 'scripts', 'grant-audit.sql'), 'utf8'))

describe('the account-deletion surface converges from a hostile privilege state', () => {
  it('is closed on the converged schema', async () => {
    for (const fn of await functionExposure()) {
      expect(fn.anon, fn.name).toBe(false)
      expect(fn.authenticated, fn.name).toBe(false)
      expect(fn.public_exec, fn.name).toBe(false)
    }
    expect(await tableExposure()).toEqual({ anon: false, authenticated: false, service_role: true })
  })

  it('is exposed by the hostile state (so the closing below is not vacuous) and closed again by the baseline', async () => {
    try {
      await db.query(readFileSync(join(ROOT, 'tests', 'db', 'sql', 'hostile_grants.sql'), 'utf8'))

      const exposed = await functionExposure()
      expect(exposed.map((f) => f.name).sort()).toEqual([...RPCS, ...TRIGGER_FUNCTIONS].sort())
      for (const fn of exposed) {
        expect(fn.anon, `${fn.name} exposed to anon`).toBe(true)
        expect(fn.authenticated, `${fn.name} exposed to authenticated`).toBe(true)
      }
      expect(await tableExposure()).toEqual({ anon: true, authenticated: true, service_role: true })
      // The audit must notice the hostile state, otherwise it proves nothing afterwards.
      await expect(runAudit()).rejects.toThrow()
    } finally {
      await applyBaseline()
    }

    for (const fn of await functionExposure()) {
      expect(fn.anon, fn.name).toBe(false)
      expect(fn.authenticated, fn.name).toBe(false)
      expect(fn.public_exec, fn.name).toBe(false)
      // The three RPCs keep service_role (the Edge Function needs them); trigger functions need none.
      expect(fn.service_role, fn.name).toBe(RPCS.includes(fn.name))
    }
    expect(await tableExposure()).toEqual({ anon: false, authenticated: false, service_role: true })
    await expect(runAudit()).resolves.toBeDefined()
  })

  it('every SECURITY DEFINER function in public is owned by postgres and pins an empty search_path', async () => {
    const res = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prosecdef
          and (p.proconfig is null
               or not ('search_path=""' = any (p.proconfig))
               or pg_get_userbyid(p.proowner) <> 'postgres')`,
    )
    expect(res.rows[0]!.n).toBe(0)
  })
})
