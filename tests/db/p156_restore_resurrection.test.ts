import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'
import { seedAccountLedger } from './lib/account-ledger-fixture'

/**
 * P156: does restoring a backup taken BEFORE an account was deleted bring that account back — and
 * does the promotion gate notice?
 *
 * A real logical dump of the running local database is taken with A and B present, A is then deleted
 * through the deployed function, and the pre-deletion dump is restored into a SECOND, disposable
 * database in the same local Postgres. Nothing inside that dump can know A was deleted afterwards.
 * The restored image is then judged by scripts/restore-gate/check-restore-erasures.ts against an
 * off-backup registry.
 *
 * Needs the local stack's database container (name in P156_DB_CONTAINER, e.g.
 * supabase_db_pokeportfolio-p156) because it runs pg_dump/pg_restore inside it as the superuser.
 * Without that variable the suite is skipped — CI has no such container; the gate's decision logic
 * is covered without it in tests/ops/restore-erasure-gate.test.ts. It touches only the disposable
 * database it creates and drops.
 */

const CONTAINER = process.env.P156_DB_CONTAINER
const RESTORE_DB = 'p156_restore_drill'
const FUNCTION_URL = `${process.env.SUPABASE_URL ?? ''}/functions/v1/delete-account`
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')

const docker = (args: string[], allowFailure = false): string => {
  try {
    return execFileSync('docker', ['exec', CONTAINER!, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (e) {
    if (allowFailure) return (e as { stdout?: string }).stdout ?? ''
    throw e
  }
}

const gate = (dbName: string, registry: string, extra: string[] = []) => {
  const url = `postgresql://postgres:postgres@127.0.0.1:${new URL(process.env.DB_URL!).port}/${dbName}`
  const r = spawnSync(
    process.execPath,
    [
      TSX,
      'scripts/restore-gate/check-restore-erasures.ts',
      '--db-url',
      url,
      '--registry',
      registry,
      ...extra,
    ],
    { encoding: 'utf8' },
  )
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

const addToRegistry = (registry: string, id: string) =>
  execFileSync(
    process.execPath,
    [TSX, 'scripts/restore-gate/erasure-registry-add.ts', '--registry', registry, '--id', id],
    {
      encoding: 'utf8',
    },
  )

describe.skipIf(!CONTAINER)(
  'a pre-deletion backup resurrects an erased account, and the gate refuses it',
  () => {
    let service: TestClient
    let a: SyntheticUser
    let b: SyntheticUser
    let dir: string
    let registry: string

    beforeAll(async () => {
      service = createServiceClient()
      dir = mkdtempSync(join(tmpdir(), 'p156-restore-'))
      registry = join(dir, 'erasure-registry.txt')
      a = await createSyntheticUser(service, 'restore-a')
      b = await createSyntheticUser(service, 'restore-b')
      await seedAccountLedger(service, a, await signInAs(a), 'restore-a')
      await seedAccountLedger(service, b, await signInAs(b), 'restore-b')

      // 1. The backup, taken while A still exists.
      docker([
        'pg_dump',
        '-U',
        'supabase_admin',
        '-Fc',
        '-d',
        'postgres',
        '-f',
        '/tmp/p156_pre_deletion.dump',
      ])

      // 2. A is deleted for real, through the deployed function.
      const token = (await (await signInAs(a)).auth.getSession()).data.session!.access_token
      const res = await fetch(FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: process.env.SUPABASE_ANON_KEY ?? '',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ expectedUserId: a.id, password: a.password, confirm: true }),
      })
      expect(res.status).toBe(200)

      // 3. The old backup is restored into a disposable database.
      docker([
        'psql',
        '-U',
        'supabase_admin',
        '-d',
        'postgres',
        '-c',
        `drop database if exists ${RESTORE_DB}`,
      ])
      docker(['createdb', '-U', 'supabase_admin', RESTORE_DB])
      // pg_restore reports harmless errors (platform-only extensions/roles); the content check below
      // is what proves the restore happened.
      docker(
        [
          'pg_restore',
          '-U',
          'supabase_admin',
          '-d',
          RESTORE_DB,
          '--no-owner',
          '/tmp/p156_pre_deletion.dump',
        ],
        true,
      )
    }, 300_000)

    afterAll(async () => {
      docker(
        [
          'psql',
          '-U',
          'supabase_admin',
          '-d',
          'postgres',
          '-c',
          `drop database if exists ${RESTORE_DB}`,
        ],
        true,
      )
      docker(['rm', '-f', '/tmp/p156_pre_deletion.dump'], true)
      rmSync(dir, { recursive: true, force: true })
      await service.from('account_deletion_requests').delete().eq('user_id', b.id)
      await deleteSyntheticUser(service, b.id)
    }, 120_000)

    it("the live database no longer has A, but the restored old image does — and holds A's ledger", async () => {
      expect((await service.auth.admin.getUserById(a.id)).data.user).toBeNull()
      const restored = new pg.Client({
        connectionString: `postgresql://postgres:postgres@127.0.0.1:${new URL(process.env.DB_URL!).port}/${RESTORE_DB}`,
      })
      await restored.connect()
      try {
        const user = await restored.query('select 1 from auth.users where id = $1', [a.id])
        const holdings = await restored.query(
          'select count(*)::int as n from public.holdings where user_id = $1',
          [a.id],
        )
        expect(user.rowCount).toBe(1)
        expect(holdings.rows[0].n).toBeGreaterThan(0)
      } finally {
        await restored.end()
      }
    })

    it('WITHOUT a registry entry the gate cannot tell (and refuses an empty registry rather than pass it)', () => {
      writeFileSync(registry, '# erasure-registry/v1\n')
      expect(gate(RESTORE_DB, registry).code).toBe(2)
    })

    it('with the erasure recorded, the gate REFUSES the restored image (exit 1) and names only tables and counts', () => {
      addToRegistry(registry, a.id)
      const r = gate(RESTORE_DB, registry)
      expect(r.code).toBe(1)
      expect(r.out).toContain('NOT PROMOTABLE')
      expect(r.out).toContain('auth.users')
      expect(r.out).not.toContain(a.id)
      expect(r.out).not.toContain(a.email)
      expect(readFileSync(registry, 'utf8')).not.toContain(a.id)
    })

    it('the same registry passes the LIVE database, where A is gone and B was never erased', () => {
      const r = gate('postgres', registry)
      expect(r.code).toBe(0)
      expect(r.out).toContain('no erased account is present')
    })

    it('a registry that is missing or malformed is a refusal (2), and an unreachable database is 4', () => {
      expect(gate(RESTORE_DB, join(dir, 'does-not-exist.txt')).code).toBe(2)
      writeFileSync(join(dir, 'bad.txt'), 'not a registry\n')
      expect(gate(RESTORE_DB, join(dir, 'bad.txt')).code).toBe(2)
      expect(gate('database_that_does_not_exist', registry).code).toBe(4)
    })

    it('an image without the deletion machinery (a backup older than the feature, not rolled forward) is refused (3)', async () => {
      const stale = 'p156_restore_stale'
      docker([
        'psql',
        '-U',
        'supabase_admin',
        '-d',
        'postgres',
        '-c',
        `drop database if exists ${stale}`,
      ])
      docker(['createdb', '-U', 'supabase_admin', stale])
      try {
        const c = new pg.Client({
          connectionString: `postgresql://postgres:postgres@127.0.0.1:${new URL(process.env.DB_URL!).port}/${stale}`,
        })
        await c.connect()
        await c.end()
        expect(gate(stale, registry).code).toBe(3)
      } finally {
        docker(
          [
            'psql',
            '-U',
            'supabase_admin',
            '-d',
            'postgres',
            '-c',
            `drop database if exists ${stale}`,
          ],
          true,
        )
      }
    })
  },
)
