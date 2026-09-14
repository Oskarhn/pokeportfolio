/**
 * `pnpm db:backup` — full private backup of the linked Supabase project (P131). See
 * backup-core.ts for the file set and fail-closed rules, docs/DEVELOPMENT.md §4 "Backups" for the
 * operator procedure.
 *
 *   pnpm db:backup                              linked project → default private root
 *   pnpm db:backup --out-root <dir>             linked project → <dir>/<UTC stamp>/
 *   pnpm db:backup --expect-migrations 97       additionally require exactly 97 history rows
 *   pnpm db:backup --verify <backup dir>        re-verify an existing backup (sizes, hashes, content)
 *
 * Local/test only: `--db-url <postgres url>` dumps another database instead of the linked project.
 * Never pass a hosted connection string with a password on the command line — use the linked
 * project, which authenticates through the CLI's own login role.
 *
 * Exit 0 only for a complete, re-verified backup. Anything else exits 1.
 */
import { join } from 'node:path'
import { type BackupTarget, redactSecrets, runBackup, verifyBackupDirectory } from './backup-core'
import {
  countLocalMigrationFiles,
  createCliDumpRunner,
  gitLocationProbe,
  isGitIgnored,
  mainCheckoutRoot,
  readLinkedProjectRef,
  supabaseCliVersion,
} from './supabase-cli'

interface Args {
  outRoot?: string
  dbUrl?: string
  verify?: string
  expectMigrations?: number
  allowIgnoredInsideGit: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { allowIgnoredInsideGit: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = (): string => {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`)
      i += 1
      return next
    }
    switch (flag) {
      case '--out-root':
        args.outRoot = value()
        break
      case '--db-url':
        args.dbUrl = value()
        break
      case '--verify':
        args.verify = value()
        break
      case '--expect-migrations': {
        const n = Number(value())
        if (!Number.isInteger(n) || n < 1)
          throw new Error('--expect-migrations must be a positive integer')
        args.expectMigrations = n
        break
      }
      case '--allow-ignored-inside-git':
        args.allowIgnoredInsideGit = true
        break
      case '--':
        break
      default:
        throw new Error(`unknown argument: ${flag ?? ''}`)
    }
  }
  return args
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))

  if (args.verify !== undefined) {
    const manifest = await verifyBackupDirectory(args.verify)
    console.log(`VERIFIED: ${args.verify}`)
    for (const artifact of manifest.artifacts) {
      console.log(
        `  ${artifact.file.padEnd(30)} ${String(artifact.bytes).padStart(12)} B  ${artifact.sha256}`,
      )
    }
    return 0
  }

  const target: BackupTarget =
    args.dbUrl !== undefined
      ? { kind: 'db-url', dbUrl: args.dbUrl }
      : { kind: 'linked', projectRef: readLinkedProjectRef() }
  const outRoot =
    args.outRoot ??
    process.env.PP_BACKUP_ROOT ??
    join(await mainCheckoutRoot(), '..', 'pokeportfolio-private-backups', 'supabase')

  const outcome = await runBackup({
    outRoot,
    target,
    runDump: createCliDumpRunner(),
    supabaseCliVersion: await supabaseCliVersion(),
    location: {
      probe: gitLocationProbe,
      allowIgnoredInsideGit: args.allowIgnoredInsideGit,
      isGitIgnored,
    },
    localMigrationFiles: countLocalMigrationFiles(),
    ...(args.expectMigrations !== undefined
      ? { expectMigrationHistoryRows: args.expectMigrations }
      : {}),
    log: (line) => {
      console.log(line)
    },
  })

  if (!outcome.ok || outcome.manifest === null) {
    console.error(
      `BACKUP FAILED — no usable backup was produced: ${outcome.error ?? 'unknown error'}`,
    )
    if (outcome.directory !== null)
      console.error(`partial files kept for diagnosis: ${outcome.directory}`)
    return 1
  }
  console.log('BACKUP COMPLETE (verified from disk)')
  console.log(`  directory: ${outcome.directory ?? ''}`)
  console.log(`  target:    ${outcome.manifest.target.label}`)
  console.log(`  migration history rows: ${String(outcome.manifest.migrationHistoryRows)}`)
  for (const artifact of outcome.manifest.artifacts) {
    console.log(
      `  ${artifact.file.padEnd(30)} ${String(artifact.bytes).padStart(12)} B  ${artifact.sha256}`,
    )
  }
  console.log('Restore is NOT covered by this tool: see the restore warning in README.txt.')
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(
      `BACKUP FAILED: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    )
    process.exitCode = 1
  },
)
