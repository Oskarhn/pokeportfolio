import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { seedAccountLedger, USER_OWNED_TABLES } from './lib/account-ledger-fixture'
import {
  parseRegistry,
  parseRegistryKey,
  RegistryStore,
  hashAccountId,
} from '../../scripts/restore-gate/erasure-registry'

/**
 * P189 — restore-safe account deletion, proven against the real database workflow:
 *
 *   seed → real logical backup (pg_dump of the whole database, auth schema included) → delete
 *   through the DEPLOYED function (which records the erasure in the off-platform registry sink) →
 *   restore the OLD backup into a disposable database → replay the registry with the gate CLI →
 *   verify.
 *
 * Needs the stack's database container (P156_DB_CONTAINER) to run pg_dump / pg_restore as the
 * superuser, and the registry sink tests/db/global-setup.ts starts (ERASURE_REGISTRY_*). Without
 * them the suite is skipped; CI starts both. The decision logic is covered without a database in
 * tests/ops/*. Every account here is synthetic; the registry file is read only through the strict
 * parser, and no assertion or output carries an id.
 */

const CONTAINER = process.env.P156_DB_CONTAINER
const KEY_TEXT = process.env.ERASURE_REGISTRY_KEY
const REGISTRY = process.env.P189_REGISTRY_FILE
const ENABLED = Boolean(CONTAINER && KEY_TEXT && REGISTRY)
const FUNCTION_URL = `${process.env.SUPABASE_URL ?? ''}/functions/v1/delete-account`
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
const PORT = ENABLED ? new URL(process.env.DB_URL!).port : ''
// The gate runs as the role that OWNS the restored objects (here the restoring superuser), exactly as an
// operator would; the API roles hold no execute privilege on it.
const urlOf = (db: string) => `postgresql://supabase_admin:postgres@127.0.0.1:${PORT}/${db}`

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
const sql = (db: string, statement: string): string =>
  docker(['psql', '-U', 'supabase_admin', '-d', db, '-At', '-c', statement])

interface GateRun {
  code: number | null
  out: string
  json: Record<string, unknown> | null
}
function gate(
  command: string,
  db: string,
  registry: string,
  extra: string[] = [],
  key: string | undefined = KEY_TEXT,
): GateRun {
  const r = spawnSync(
    process.execPath,
    [
      TSX,
      'scripts/restore-gate/restore-gate.ts',
      command,
      '--db-url',
      urlOf(db),
      '--registry',
      registry,
      '--json',
      ...extra,
    ],
    { encoding: 'utf8', env: { ...process.env, ERASURE_REGISTRY_KEY: key ?? '' } },
  )
  const out = `${r.stdout}${r.stderr}`
  const parseJson = (): Record<string, unknown> | null => {
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as Record<string, unknown>
    } catch {
      return null
    }
  }
  return { code: r.status, out, json: parseJson() }
}

async function query<T = Record<string, unknown>>(
  db: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: urlOf(db) })
  await c.connect()
  try {
    return (await c.query(text, params)).rows as T[]
  } finally {
    await c.end()
  }
}

/** Row count per owning relation for one account inside one database (never ids, only counts). */
async function footprint(db: string, userId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const users = await query<{ n: number }>(
    db,
    'select count(*)::int n from auth.users where id=$1',
    [userId],
  )
  out['auth.users'] = users[0]!.n
  const ids = await query<{ n: number }>(
    db,
    'select count(*)::int n from auth.identities where user_id=$1',
    [userId],
  )
  out['auth.identities'] = ids[0]!.n
  for (const { table, column } of USER_OWNED_TABLES) {
    const r = await query<{ n: number }>(
      db,
      `select count(*)::int n from public.${table} where ${column}=$1`,
      [userId],
    )
    out[`public.${table}`] = r[0]!.n
  }
  return out
}
const present = (f: Record<string, number>) => Object.entries(f).filter(([, n]) => n > 0)

async function digest(db: string, userId: string): Promise<string> {
  const parts: string[] = []
  for (const { table, column } of USER_OWNED_TABLES) {
    const r = await query<{ d: string }>(
      db,
      `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) d from public.${table} t where t.${column}=$1`,
      [userId],
    )
    parts.push(r[0]!.d)
  }
  return parts.join(':')
}

describe.skipIf(!ENABLED)('restore-safe account deletion (P189)', () => {
  let service: TestClient
  let dir: string
  let a: SyntheticUser
  let d: SyntheticUser
  let live: SyntheticUser
  const dbs: string[] = []
  const created: SyntheticUser[] = []
  let liveDigestBefore = ''
  let registryCopy: string

  const dump = (name: string): string => {
    const file = `/tmp/p189_${name}.dump`
    docker(['pg_dump', '-U', 'supabase_admin', '-Fc', '-d', 'postgres', '-f', file])
    return file
  }
  const restore = (file: string, name: string): string => {
    sql('postgres', `drop database if exists ${name}`)
    docker(['createdb', '-U', 'supabase_admin', name])
    dbs.push(name)
    // Harmless platform-only errors are tolerated; the content checks are what prove the restore.
    docker(['pg_restore', '-U', 'supabase_admin', '-d', name, '--no-owner', file], true)
    return name
  }
  const remove = async (u: SyntheticUser) => {
    const token = (await (await signInAs(u)).auth.getSession()).data.session!.access_token
    const res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.SUPABASE_ANON_KEY ?? '',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ expectedUserId: u.id, password: u.password, confirm: true }),
    })
    expect(res.status).toBe(200)
  }

  let backupBefore = '' // A, D, live all present
  let backupAfterA = '' // A gone; D, live present
  let backupAfterAll = '' // A, D gone; live present

  beforeAll(async () => {
    service = createServiceClient()
    dir = mkdtempSync(join(tmpdir(), 'p189-dr-'))
    for (const label of ['dr-a', 'dr-d', 'dr-live']) {
      const u = await createSyntheticUser(service, label)
      created.push(u)
      await seedAccountLedger(service, u, await signInAs(u), label)
    }
    ;[a, d, live] = created as [SyntheticUser, SyntheticUser, SyntheticUser]
    backupBefore = dump('before')
    await remove(a)
    backupAfterA = dump('after_a')
    await remove(d)
    backupAfterAll = dump('after_all')
    registryCopy = join(dir, 'registry.ndjson')
    copyFileSync(REGISTRY!, registryCopy)
    liveDigestBefore = await digest('postgres', live.id)
  }, 600_000)

  afterAll(async () => {
    for (const name of dbs) sql('postgres', `drop database if exists ${name}`)
    for (const n of ['before', 'after_a', 'after_all'])
      docker(['rm', '-f', `/tmp/p189_${n}.dump`], true)
    rmSync(dir, { recursive: true, force: true })
    await service.from('account_deletion_requests').delete().eq('user_id', live.id)
    await deleteSyntheticUser(service, live.id)
  }, 120_000)

  describe('R0 the hazard itself (why the gate exists)', () => {
    it('a plain restore of the pre-deletion backup resurrects BOTH deleted accounts, login and ledger', async () => {
      const img = restore(backupBefore, 'p189_r0')
      for (const u of [a, d]) {
        const f = await footprint(img, u.id)
        expect(f['auth.users']).toBe(1)
        expect(f['auth.identities']).toBe(1)
        expect(f['public.holdings']).toBeGreaterThan(0)
        expect(f['public.sales']).toBeGreaterThan(0)
        expect(present(f).length).toBe(Object.keys(f).length) // every relation came back
      }
      // ...while the live database has neither.
      expect(present(await footprint('postgres', a.id))).toEqual([])
      expect(present(await footprint('postgres', d.id))).toEqual([])
    })
  })

  describe('R1 / R4 / R8 backup before deletion → restore → gate: deleted accounts stay gone, the live one is untouched', () => {
    let img: string
    beforeAll(() => {
      img = restore(backupBefore, 'p189_r1')
    }, 300_000)

    it('verify refuses the image: NOT SAFE TO SERVE, counts only', () => {
      const r = gate('verify', img, registryCopy)
      expect(r.code).toBe(1)
      expect(r.json).toMatchObject({ verdict: 'resurrected', present_accounts: 2 })
      expect(r.out).not.toContain(a.id)
      expect(r.out).not.toContain(a.email)
    })

    it('promote-check and postcheck refuse it too, and an unstamped image is not promotable', () => {
      expect(gate('postcheck', img, registryCopy).code).toBe(1)
      expect(gate('promote-check', img, registryCopy).code).not.toBe(0)
    })

    it('apply --dry-run reports what it would do and changes nothing', async () => {
      const before = await footprint(img, a.id)
      const r = gate('apply', img, registryCopy, ['--dry-run'])
      expect(r.code).toBe(0)
      expect(r.json).toMatchObject({ dry_run: true, replayed_accounts: 2 })
      expect(await footprint(img, a.id)).toEqual(before)
    })

    it('apply removes both deleted accounts completely (R8: every ledger table, login, identities) and nothing else', async () => {
      const liveBefore = await digest(img, live.id)
      const r = gate('apply', img, registryCopy)
      expect(r.code).toBe(0)
      expect(r.json).toMatchObject({ replayed_accounts: 2, verdict: 'clean' })
      for (const u of [a, d]) expect(present(await footprint(img, u.id))).toEqual([])
      const survivor = await footprint(img, live.id)
      expect(survivor['auth.users']).toBe(1)
      expect(survivor['public.holdings']).toBeGreaterThan(0)
      expect(await digest(img, live.id)).toBe(liveBefore)
      expect(liveBefore).toBe(liveDigestBefore)
    })

    it('R3 applying again is a no-op: success, nothing replayed, the live account byte-identical', async () => {
      const before = await digest(img, live.id)
      const r = gate('apply', img, registryCopy)
      expect(r.code).toBe(0)
      expect(r.json).toMatchObject({ replayed_accounts: 0, verdict: 'clean' })
      expect(await digest(img, live.id)).toBe(before)
    })

    it('postcheck stamps the image; promote-check then passes; a registry that grew afterwards invalidates the stamp', () => {
      expect(gate('promote-check', img, registryCopy).code).toBe(6) // no passing stamp yet
      const post = gate('postcheck', img, registryCopy)
      expect(post.code).toBe(0)
      expect(post.json).toMatchObject({ stamped: true })
      expect(gate('promote-check', img, registryCopy).code).toBe(0)

      const grown = join(dir, 'grown.ndjson')
      copyFileSync(registryCopy, grown)
      new RegistryStore(grown, parseRegistryKey(KEY_TEXT)).append({
        deletion_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        subject: hashAccountId('99999999-9999-4999-8999-999999999999'),
        deleted_at: '2026-10-02T12:00:00Z',
      })
      const stale = gate('promote-check', img, grown)
      expect(stale.code).toBe(6)
      expect(stale.json).toMatchObject({ reason: 'stamp_does_not_cover_registry' })
    })

    it('the receipts the live deployment wrote are mirrored in the replayed image and agree with the registry', async () => {
      const rows = await query<{ n: number }>(
        img,
        'select count(*)::int n from public.account_erasure_receipts',
      )
      const registry = parseRegistry(readFileSync(registryCopy, 'utf8'), parseRegistryKey(KEY_TEXT))
      expect(rows[0]!.n).toBeGreaterThanOrEqual(2)
      expect(registry.head.records).toBeGreaterThanOrEqual(2)
    })
  })

  describe('R2 backup AFTER (some or all) deletions → restore → gate', () => {
    it('a backup taken after A was deleted: A is still gone, D (deleted later) is replayed away', async () => {
      const img = restore(backupAfterA, 'p189_r2a')
      expect(present(await footprint(img, a.id))).toEqual([])
      expect((await footprint(img, d.id))['auth.users']).toBe(1)
      const r = gate('apply', img, registryCopy)
      expect(r.code).toBe(0)
      expect(r.json).toMatchObject({ replayed_accounts: 1, verdict: 'clean' })
      expect(present(await footprint(img, d.id))).toEqual([])
      expect((await footprint(img, live.id))['auth.users']).toBe(1)
    })

    it('a backup taken after every deletion is already clean: verify passes, apply replays nothing', () => {
      const img = restore(backupAfterAll, 'p189_r2b')
      expect(gate('verify', img, registryCopy).code).toBe(0)
      const r = gate('apply', img, registryCopy)
      expect(r.code).toBe(0)
      expect(r.json).toMatchObject({ replayed_accounts: 0 })
    })
  })

  describe('R5 / R6 the gate fails closed on a bad registry and never touches the image', () => {
    let img: string
    let before: Record<string, number>
    beforeAll(async () => {
      img = restore(backupBefore, 'p189_r5')
      before = await footprint(img, a.id)
    }, 300_000)

    it.each(['verify', 'apply', 'postcheck', 'promote-check'])(
      '%s with a MISSING registry exits 2',
      (command) => {
        expect(gate(command, img, join(dir, 'does-not-exist.ndjson')).code).toBe(2)
      },
    )

    it('an EMPTY registry is refused unless the operator says so on purpose', () => {
      const empty = join(dir, 'empty.ndjson')
      writeFileSync(empty, '')
      expect(gate('verify', img, empty).code).toBe(2)
      // Allowed on purpose, it is still never "clean" when the image holds receipts the empty registry
      // lacks. That state is built from this file's own deletions (the after-both-deletions dump
      // carries a receipt for each) rather than inherited from receipts earlier test files left behind.
      const withReceipts = restore(backupAfterAll, 'p189_r5_receipts')
      expect(sql(withReceipts, 'select count(*) from public.account_erasure_receipts')).not.toBe(
        '0',
      )
      expect(gate('verify', withReceipts, empty, ['--allow-empty-registry']).code).toBe(5)
    })

    it('R6 malformed, torn, tampered and wrongly keyed registries are refused (2)', () => {
      const text = readFileSync(registryCopy, 'utf8')
      const bad: Record<string, string> = {
        garbage: 'not a registry\n',
        torn: text.slice(0, -7),
        tampered: text.replace('"seq":1', '"seq":5'),
        wrongSchema: text.replaceAll('"v":2', '"v":3'),
      }
      for (const [name, content] of Object.entries(bad)) {
        const file = join(dir, `${name}.ndjson`)
        writeFileSync(file, content)
        expect(gate('apply', img, file).code, name).toBe(2)
      }
      expect(gate('apply', img, registryCopy, [], 'ab'.repeat(32)).code).toBe(2) // wrong key
      expect(gate('apply', img, registryCopy, [], '').code).toBe(2) // no key
    })

    it('after every refusal the image is exactly as it was', async () => {
      expect(await footprint(img, a.id)).toEqual(before)
    })

    it('an unreachable database is 4 and an image without the machinery is 3', () => {
      expect(gate('verify', 'database_that_does_not_exist', registryCopy).code).toBe(4)
      sql('postgres', 'drop database if exists p189_stale')
      docker(['createdb', '-U', 'supabase_admin', 'p189_stale'])
      dbs.push('p189_stale')
      expect(gate('verify', 'p189_stale', registryCopy).code).toBe(3)
    })
  })

  describe('R7 a registry entry for an account the image never had (or that is already gone) is harmless', () => {
    it('replays nothing, changes nothing, succeeds twice', async () => {
      const img = restore(backupAfterAll, 'p189_r7')
      const extra = join(dir, 'extra.ndjson')
      copyFileSync(registryCopy, extra)
      new RegistryStore(extra, parseRegistryKey(KEY_TEXT)).append({
        deletion_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        subject: hashAccountId('88888888-8888-4888-8888-888888888888'),
        deleted_at: '2026-10-02T12:00:00Z',
      })
      const before = await digest(img, live.id)
      for (let i = 0; i < 2; i++) {
        const r = gate('apply', img, extra)
        // The extra record is not in this image's receipts and is newer than them: fine. What is not
        // fine would be the reverse (a receipt the registry lacks), covered next.
        expect(r.code).toBe(0)
        expect(r.json).toMatchObject({ replayed_accounts: 0 })
      }
      expect(await digest(img, live.id)).toBe(before)
    })
  })

  describe('the registry is OLDER than the backup (the core point of keeping it separately)', () => {
    it('a registry cut off before the newest erasure is refused: the image holds a receipt the registry lacks', () => {
      const img = restore(backupAfterAll, 'p189_older')
      const all = readFileSync(registryCopy, 'utf8').trimEnd().split('\n')
      // Keep only the first record: the image's receipts for later erasures are now unknown to it.
      const short = join(dir, 'short.ndjson')
      writeFileSync(short, `${all[0]!}\n`)
      const r = gate('verify', img, short)
      expect(r.code).toBe(5)
      expect(r.json).toMatchObject({ verdict: 'registry_inconsistent' })
      expect(gate('apply', img, short).code).toBe(5)
    })

    it('an operator-pinned head catches a shortened registry even when the image has no receipts for it', () => {
      const img = restore(backupBefore, 'p189_pin')
      const r = gate('verify', img, registryCopy, ['--expect-head-seq', '999999'])
      expect(r.code).toBe(5)
      expect(r.json).toMatchObject({ verdict: 'head_behind_expected' })
    })
  })

  describe('the deletion workflow wrote what the gate relies on', () => {
    it('every deleted synthetic account is in the registry by hash only, and in the live database as a receipt', async () => {
      const registry = parseRegistry(readFileSync(REGISTRY!, 'utf8'), parseRegistryKey(KEY_TEXT))
      const subjects = new Set(registry.records.map((r) => r.subject))
      expect(subjects.has(hashAccountId(a.id))).toBe(true)
      expect(subjects.has(hashAccountId(d.id))).toBe(true)
      expect(subjects.has(hashAccountId(live.id))).toBe(false)
      expect(readFileSync(REGISTRY!, 'utf8')).not.toContain(a.id)
      const receipts = await query<{ subject_hash: string }>(
        'postgres',
        'select subject_hash from public.account_erasure_receipts',
      )
      expect(receipts.map((r) => r.subject_hash)).toEqual(
        expect.arrayContaining([hashAccountId(a.id), hashAccountId(d.id)]),
      )
    })
  })
})

/**
 * The REAL restore: `pnpm db:backup` (P131) of the running database, then scripts/p137/restore-drill.ts
 * (P137: a fresh disposable Postgres on an internal Docker network, the real GoTrue schema, roles →
 * schema → migration history → roll-forward → data → privilege baseline → grant audit → diagnostics)
 * with the erasure gate as a REQUIRED step. Slow (minutes), so it runs when P189_FULL_DRILL=1; the
 * disaster-recovery evidence in docs/security/RESTORE_RUNBOOK.md §9 comes from this block.
 */
describe.skipIf(!ENABLED || process.env.P189_FULL_DRILL !== '1')(
  'full disaster-recovery drill with the real backup and restore tooling (P189)',
  () => {
    let service: TestClient
    let out: string
    let backupDir = ''
    let a: SyntheticUser
    let live: SyntheticUser

    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [TSX, ...args], {
        encoding: 'utf8',
        env: { ...process.env, ERASURE_REGISTRY_KEY: KEY_TEXT ?? '', ...env },
        maxBuffer: 64 * 1024 * 1024,
      })

    beforeAll(async () => {
      service = createServiceClient()
      out = mkdtempSync(join(tmpdir(), 'p189-fulldr-'))
      a = await createSyntheticUser(service, 'fulldr-a')
      live = await createSyntheticUser(service, 'fulldr-live')
      await seedAccountLedger(service, a, await signInAs(a), 'fulldr-a')
      await seedAccountLedger(service, live, await signInAs(live), 'fulldr-live')

      // 1. the real backup, taken while A exists. The drill's cron check expects the ingest jobs to be
      // ACTIVE in the source (a production-shaped backup), whereas test runs deactivate them for
      // stability, so they are switched on only for the instant of the dump.
      sql('postgres', 'select cron.alter_job(jobid, active := true) from cron.job')
      const backup = run([
        'scripts/db-backup/run-backup.ts',
        '--db-url',
        process.env.DB_URL!,
        '--out-root',
        out,
      ])
      sql('postgres', 'select cron.alter_job(jobid, active := false) from cron.job')
      expect(backup.stdout).toContain('BACKUP COMPLETE')
      backupDir = /directory:\s+(.+)/.exec(backup.stdout)![1]!.trim()

      // 2. A is deleted for real afterwards
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
    }, 900_000)

    afterAll(async () => {
      rmSync(out, { recursive: true, force: true })
      await service.from('account_deletion_requests').delete().eq('user_id', live.id)
      await deleteSyntheticUser(service, live.id)
    }, 120_000)

    it('WITH the registry: the restored image passes the whole drill, including apply, postcheck and promote-check', () => {
      const r = run([
        'scripts/p137/restore-drill.ts',
        '--backup',
        backupDir,
        '--erasure-registry',
        REGISTRY!,
      ])
      const text = `${r.stdout}${r.stderr}`
      expect(text).toMatch(/PASS\s+ERASURE_GATE apply/)
      expect(text).toMatch(/PASS\s+ERASURE_GATE postcheck/)
      expect(text).toMatch(/PASS\s+ERASURE_GATE promote-check/)
      // Every check passes EXCEPT one pre-existing P137 limitation unrelated to deletion: cron.job is
      // not captured by a backup and is recreated only by replaying migrations the backup lacks, so a
      // backup that is already current restores with no ingest jobs and that single check fails (it
      // passes for a backup older than the newest migration). Recorded in docs/security/RESTORE_RUNBOOK.md §7.
      const failed = text.split('\n').filter((l) => /^FAIL\s/.test(l))
      expect(failed.length).toBeLessThanOrEqual(1)
      for (const line of failed) expect(line).toContain('POST_RESTORE_CRON_PRODUCTION_CALLS')
      expect(text).toMatch(/PASS\s+POST_RESTORE_GRANT_AUDIT/)
      expect(text).toMatch(/PASS\s+POST_RESTORE_FINANCE_DIAGNOSTICS/)
      expect(text).not.toContain(a.id)
    }, 1_200_000)

    it('WITHOUT the gate the drill FAILS and says the image is not safe to serve (bypass is loud)', () => {
      const r = run(['scripts/p137/restore-drill.ts', '--backup', backupDir, '--no-erasure-gate'])
      const text = `${r.stdout}${r.stderr}`
      expect(text).toMatch(/FAIL\s+ERASURE_GATE: NOT RUN/)
      expect(text).toContain('NOT SAFE TO SERVE')
      expect(r.status).toBe(1)
    }, 1_200_000)

    it('MUTATION F: skipping the replay but still asking for promotion is refused', () => {
      const r = run([
        'scripts/p137/restore-drill.ts',
        '--backup',
        backupDir,
        '--erasure-registry',
        REGISTRY!,
        '--mutation',
        'F',
      ])
      const text = `${r.stdout}${r.stderr}`
      expect(text).toMatch(/PASS\s+MUTATION_F: promotion WITHOUT the replay is REFUSED/)
      expect(text).toMatch(/PASS\s+MUTATION_F: promote-check refuses/)
    }, 1_200_000)
  },
)
