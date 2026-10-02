/**
 * Records that an account has been erased, in the off-backup erasure registry (P156).
 *
 *   tsx scripts/restore-gate/erasure-registry-add.ts --registry <file> --id <account uuid> [--date YYYY-MM-DD]
 *
 * Keep the registry OUTSIDE every git checkout and outside every backup directory, and back it up
 * separately: its whole value is that a restored backup cannot contain it. Only the SHA-256 of the
 * id is stored (see erasure-registry.ts). Adding the same id twice is a no-op.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { appendEntry, RegistryError } from './erasure-registry'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const registry = arg('--registry')
const id = arg('--id')
const date = arg('--date') ?? new Date().toISOString().slice(0, 10)
if (!registry || !id) {
  console.error(
    'usage: erasure-registry-add.ts --registry <file> --id <account uuid> [--date YYYY-MM-DD]',
  )
  process.exitCode = 2
} else {
  try {
    const current = existsSync(registry) ? readFileSync(registry, 'utf8') : null
    writeFileSync(registry, appendEntry(current, id, date), 'utf8')
    console.log('recorded (hash only).')
  } catch (e) {
    console.error(e instanceof RegistryError ? e.message : 'could not update the registry')
    process.exitCode = 1
  }
}
