/**
 * restore-gate — the operator CLI for restore-safe account deletion (P189).
 *
 *   tsx scripts/restore-gate/restore-gate.ts verify        --db-url <restored db> --registry <file>
 *   tsx scripts/restore-gate/restore-gate.ts apply         --db-url <restored db> --registry <file> [--dry-run]
 *   tsx scripts/restore-gate/restore-gate.ts postcheck     --db-url <restored db> --registry <file>
 *   tsx scripts/restore-gate/restore-gate.ts promote-check --db-url <restored db> --registry <file>
 *   tsx scripts/restore-gate/restore-gate.ts find          --registry <file> --id <account uuid>
 *   tsx scripts/restore-gate/restore-gate.ts add           --registry <file> --id <account uuid>     (operator, manual)
 *   tsx scripts/restore-gate/restore-gate.ts keygen
 *
 * Options: --json (one machine-readable object on stdout), --allow-empty-registry (say on purpose
 * that no account has ever been deleted), --expect-head-seq <n> (refuse a registry shorter than the
 * head you recorded elsewhere), --db-url-env <NAME> (read the URL from an environment variable).
 * The registry key is read from the environment variable ERASURE_REGISTRY_KEY (or the name given
 * with --key-env), never from the command line.
 *
 * Run it against the RESTORED, ISOLATED database. NEVER PROMOTE A RESTORED DATABASE BEFORE THE
 * ERASURE GATE PASSES: until `postcheck` and `promote-check` both exit 0, the image is NOT SAFE TO
 * SERVE. The order and the reasons are in docs/security/RESTORE_RUNBOOK.md.
 *
 * Exit codes: 0 ok · 1 an erased account is present / replay did not converge · 2 registry refused
 * (missing, empty, malformed, wrong key, failed integrity) · 3 the image lacks the machinery (roll
 * migrations forward) · 4 database unreadable · 5 registry and image disagree (stale/foreign
 * registry) · 6 not promotable · 64 usage.
 *
 * Output: counts and relation names only. It never prints an account id, address, token or row.
 */
import pg from 'pg'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  generateRegistryKey,
  hashAccountId,
  parseRegistryKey,
  readRegistryFile,
  RegistryError,
  RegistryStore,
  type ParsedRegistry,
} from './erasure-registry'
import {
  apply,
  checkMachinery,
  EXIT,
  postcheck,
  promoteCheck,
  verify,
  type ExitCode,
  type SqlRunner,
} from './gate'
import { randomUUID } from 'node:crypto'

interface Args {
  command: string
  dbUrl?: string
  registry?: string
  id?: string
  keyEnv: string
  json: boolean
  dryRun: boolean
  allowEmpty: boolean
  expectHeadSeq?: number
}

function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv
  if (!command) throw new Error('a command is required')
  const args: Args = {
    command,
    keyEnv: 'ERASURE_REGISTRY_KEY',
    json: false,
    dryRun: false,
    allowEmpty: false,
  }
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    const value = (): string => {
      const next = rest[i + 1]
      if (next === undefined || next.startsWith('--'))
        throw new Error(`${String(flag)} needs a value`)
      i += 1
      return next
    }
    switch (flag) {
      case '--db-url':
        args.dbUrl = value()
        break
      case '--db-url-env':
        args.dbUrl = process.env[value()]
        break
      case '--registry':
        args.registry = value()
        break
      case '--id':
        args.id = value()
        break
      case '--key-env':
        args.keyEnv = value()
        break
      case '--json':
        args.json = true
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--allow-empty-registry':
        args.allowEmpty = true
        break
      case '--expect-head-seq': {
        const n = Number(value())
        if (!Number.isInteger(n) || n < 0) throw new Error('--expect-head-seq must be an integer')
        args.expectHeadSeq = n
        break
      }
      default:
        throw new Error(`unknown argument ${String(flag)}`)
    }
  }
  return args
}

function pgRunner(client: pg.Client): SqlRunner {
  return {
    async json(sql) {
      const res = await client.query<{ r: unknown }>(sql)
      return res.rows[0]?.r
    },
  }
}

function emit(args: Args, body: Record<string, unknown>, lines: string[]): void {
  if (args.json) console.log(JSON.stringify(body))
  else for (const line of lines) console.log(line)
}

function loadRegistry(args: Args): ParsedRegistry {
  if (!args.registry) throw new RegistryError('unreadable', '--registry is required')
  const key = parseRegistryKey(process.env[args.keyEnv])
  return readRegistryFile(args.registry, key)
}

async function main(): Promise<ExitCode> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`usage error: ${(e as Error).message}`)
    return EXIT.USAGE
  }

  if (args.command === 'keygen') {
    // The key is the one secret of the registry. Printed once to the terminal that asked for it.
    console.log(generateRegistryKey())
    return EXIT.OK
  }

  if (args.command === 'find' || args.command === 'add') {
    if (!args.registry || !args.id) {
      console.error('usage error: --registry and --id are required')
      return EXIT.USAGE
    }
    try {
      const key = parseRegistryKey(process.env[args.keyEnv])
      const subject = hashAccountId(args.id)
      if (args.command === 'find') {
        const hit = existsSync(args.registry)
          ? readRegistryFile(args.registry, key).records.find((r) => r.subject === subject)
          : undefined
        emit(args, { recorded: hit !== undefined, seq: hit?.seq ?? null }, [
          hit ? `recorded (seq ${String(hit.seq)})` : 'not recorded',
        ])
        return hit ? EXIT.OK : EXIT.REGISTRY_REFUSED
      }
      mkdirSync(dirname(args.registry), { recursive: true })
      const lock = `${args.registry}.lock`
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      try {
        const r = new RegistryStore(args.registry, key).append({
          deletion_id: randomUUID(),
          subject,
          deleted_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        })
        emit(args, { recorded: true, created: r.created, seq: r.record.seq }, [
          `recorded (seq ${String(r.record.seq)}${r.created ? '' : ', already present'}; hash only)`,
        ])
      } finally {
        rmSync(lock, { force: true })
      }
      return EXIT.OK
    } catch (e) {
      console.error(
        e instanceof RegistryError
          ? `REGISTRY REFUSED: ${e.message}`
          : 'could not update the registry',
      )
      return EXIT.REGISTRY_REFUSED
    }
  }

  if (!['verify', 'apply', 'postcheck', 'promote-check'].includes(args.command)) {
    console.error(`usage error: unknown command ${args.command}`)
    return EXIT.USAGE
  }
  if (!args.dbUrl) {
    console.error('usage error: --db-url (or --db-url-env) is required')
    return EXIT.USAGE
  }

  let registry: ParsedRegistry
  try {
    registry = loadRegistry(args)
  } catch (e) {
    const detail =
      e instanceof RegistryError ? `${e.code}: ${e.message}` : 'the registry could not be read'
    emit(args, { status: 'registry_refused', detail }, [`REGISTRY REFUSED — ${detail}`])
    return EXIT.REGISTRY_REFUSED
  }

  const client = new pg.Client({ connectionString: args.dbUrl })
  try {
    await client.connect()
  } catch {
    emit(args, { status: 'db_unreadable' }, ['could not connect to the database'])
    return EXIT.DB_UNREADABLE
  }
  try {
    const db = pgRunner(client)
    const machinery = await checkMachinery(db)
    if (!machinery.present) {
      emit(args, { status: 'no_machinery', missing: machinery.missing }, [
        'NOT SAFE TO SERVE: the image lacks the erasure machinery (roll the migrations forward first):',
        ...machinery.missing.map((m) => `  - ${m}`),
      ])
      return EXIT.NO_MACHINERY
    }
    const options = { allowEmpty: args.allowEmpty, expectHeadSeq: args.expectHeadSeq }

    if (args.command === 'verify') {
      const v = await verify(db, registry, options)
      emit(
        args,
        { command: 'verify', verdict: v.verdict, exit: v.exit, ...v.report, registry: v.registry },
        [
          `registry records: ${String(v.registry.records)} (head seq ${String(v.registry.head_seq)}); erased accounts present in the image: ${String(v.report.present_accounts)}`,
          ...Object.entries(v.report.tables).map(
            ([t, n]) => `  ${t}: ${String(n)} row(s) of erased account(s)`,
          ),
          v.exit === EXIT.OK
            ? 'VERIFY: no erased account is present and the registry is consistent with the image.'
            : `NOT SAFE TO SERVE (${v.verdict}).`,
        ],
      )
      return v.exit
    }
    if (args.command === 'apply') {
      const r = await apply(db, registry, { ...options, dryRun: args.dryRun })
      emit(
        args,
        {
          command: 'apply',
          dry_run: r.dry_run,
          replayed_accounts: r.replayed_accounts,
          exit: r.exit,
          verdict: r.after?.verdict ?? null,
        },
        [
          r.dry_run
            ? `DRY RUN: ${String(r.replayed_accounts)} erased account(s) would be replayed; nothing was changed.`
            : `replayed ${String(r.replayed_accounts)} erased account(s); post-replay verdict: ${r.after?.verdict ?? '?'}`,
          ...(r.exit === EXIT.OK ? [] : ['NOT SAFE TO SERVE.']),
        ],
      )
      return r.exit
    }
    if (args.command === 'postcheck') {
      const r = await postcheck(db, registry, options)
      emit(
        args,
        { command: 'postcheck', stamped: r.stamped, exit: r.exit, verdict: r.verify.verdict },
        [
          r.exit === EXIT.OK
            ? 'POSTCHECK PASSED: the image is stamped. Run promote-check immediately before promotion.'
            : `POSTCHECK FAILED (${r.verify.verdict}): NOT SAFE TO SERVE.`,
        ],
      )
      return r.exit
    }
    const p = await promoteCheck(db, registry, options)
    emit(args, { command: 'promote-check', reason: p.reason, exit: p.exit }, [
      p.exit === EXIT.OK
        ? 'PROMOTABLE: the erasure gate passed for the current registry.'
        : `NOT PROMOTABLE (${p.reason}). NOT SAFE TO SERVE.`,
    ])
    return p.exit
  } catch {
    emit(args, { status: 'db_unreadable' }, ['could not read the database'])
    return EXIT.DB_UNREADABLE
  } finally {
    await client.end().catch(() => undefined)
  }
}

process.exitCode = await main()
