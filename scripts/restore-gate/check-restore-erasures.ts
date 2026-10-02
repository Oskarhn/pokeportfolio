/**
 * Restore promotion gate: does a restored database bring back an account that was erased? (P156)
 *
 *   tsx scripts/restore-gate/check-restore-erasures.ts --db-url <restored db> --registry <file>
 *                                                     [--allow-empty-registry]
 *
 * Run it against the RESTORED, disposable database before it is promoted or re-pointed at by
 * anything (docs/RESTORE_RUNBOOK.md §12). It reads every account id present in the image — the
 * auth users and every owner column that references them, derived from pg_constraint so a table
 * added later is covered — and compares their hashes with the erasure registry.
 *
 * Exit codes:  0 clean   1 an erased account is present   2 registry missing/empty/malformed
 *              3 the image lacks the account-deletion machinery (roll migrations forward first)
 *              4 could not read the database
 *
 * Prints counts and table names only. It never prints an id, an email or a row.
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { evaluateRestore, hashAccountId, parseRegistry, RegistryError } from './erasure-registry'

interface Args {
  dbUrl: string
  registry: string
  allowEmpty: boolean
}

function parseArgs(argv: readonly string[]): Args {
  let dbUrl: string | undefined
  let registry: string | undefined
  let allowEmpty = false
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--allow-empty-registry') allowEmpty = true
    else if (flag === '--db-url' || flag === '--registry') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
      i += 1
      if (flag === '--db-url') dbUrl = value
      else registry = value
    } else throw new Error(`unknown argument ${String(flag)}`)
  }
  if (!dbUrl || !registry) throw new Error('--db-url and --registry are required')
  return { dbUrl, registry, allowEmpty }
}

/** Every (table, column) in public that references auth.users, plus auth.users itself. */
async function ownerColumns(client: pg.Client): Promise<{ table: string; column: string }[]> {
  const res = await client.query<{ relname: string; attname: string }>(`
    select rel.relname, att.attname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
     where con.contype = 'f' and con.confrelid = 'auth.users'::regclass
       and rel.relnamespace = 'public'::regnamespace and array_length(con.conkey, 1) = 1
     order by 1, 2`)
  return res.rows.map((r) => ({ table: r.relname, column: r.attname }))
}

async function main(): Promise<number> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`usage error: ${(e as Error).message}`)
    return 4
  }

  let registry
  try {
    registry = parseRegistry(readFileSync(args.registry, 'utf8'))
  } catch (e) {
    console.error(
      e instanceof RegistryError
        ? `REGISTRY REFUSED: ${e.message}`
        : 'REGISTRY REFUSED: the file could not be read',
    )
    return 2
  }

  const client = new pg.Client({ connectionString: args.dbUrl })
  try {
    await client.connect()
    const machinery = await client.query<{ requests: boolean; barriers: number }>(`
      select to_regclass('public.account_deletion_requests') is not null as requests,
             (select count(*)::int from pg_trigger where tgname = 'account_deletion_barrier') as barriers`)
    const m = machinery.rows[0]
    if (!m?.requests || m.barriers === 0) {
      console.error(
        'NOT PROMOTABLE: the image has no account-deletion machinery (roll the migrations forward first).',
      )
      return 3
    }

    const ids = new Set<string>()
    const perTable = new Map<string, Set<string>>()
    const sources = [{ table: 'auth.users', column: 'id', qualified: 'auth.users' }].concat(
      (await ownerColumns(client)).map((c) => ({ ...c, qualified: `public.${c.table}` })),
    )
    for (const source of sources) {
      const res = await client.query<{ id: string }>(
        `select distinct ${client.escapeIdentifier(source.column)}::text as id from ${source.qualified
          .split('.')
          .map((p) => client.escapeIdentifier(p))
          .join('.')} where ${client.escapeIdentifier(source.column)} is not null`,
      )
      const set = new Set<string>()
      for (const row of res.rows) {
        ids.add(row.id)
        set.add(row.id)
      }
      perTable.set(source.qualified, set)
    }

    const verdict = evaluateRestore({ restoredIds: ids, registry, allowEmpty: args.allowEmpty })
    console.log(
      `registry entries: ${String(verdict.registryEntries)}; account ids in image: ${String(verdict.idsChecked)}; erased accounts present: ${String(verdict.matches)}`,
    )
    if (verdict.status === 'registry_empty') {
      console.error(
        'REGISTRY REFUSED: it is empty. If no account has ever been deleted, say so with --allow-empty-registry; otherwise it was lost or never kept.',
      )
      return 2
    }
    if (verdict.status === 'resurrected') {
      const erased = new Set(registry.map((r) => r.hash))
      for (const [table, set] of perTable) {
        const n = [...set].filter((id) => erased.has(hashAccountId(id))).length
        if (n > 0) console.error(`  ${table}: ${String(n)} erased account(s) present`)
      }
      console.error('NOT PROMOTABLE: this image resurrects an account that was erased.')
      return 1
    }
    console.log('PROMOTION GATE: no erased account is present in this image.')
    return 0
  } catch {
    console.error('could not read the database')
    return 4
  } finally {
    await client.end().catch(() => undefined)
  }
}

process.exitCode = await main()
