/**
 * Erasure registry and the pure decision of the restore promotion gate (P156).
 *
 * The problem this exists for: deleting an account removes it from the LIVE database, and nothing in
 * a backup taken BEFORE the deletion can know that it happened. Restoring such a backup resurrects
 * the person — their login, their ledger, their invitation — and a restored database that is then
 * promoted to be the live one quietly undoes an erasure the person was told had happened.
 *
 * A record that could prevent that has to live OUTSIDE the backups it guards. This is that record,
 * kept as small as it can be:
 *
 *   - one line per erased account: a SHA-256 of a namespaced, lower-cased account id, and a date;
 *   - no email, no name, no row content. The id is a random UUID, so its hash cannot be enumerated
 *     back to a person, and it is only ever compared against ids found inside a restored image.
 *
 * Who appends to it is an operational process (docs/RESTORE_RUNBOOK.md §12), not something the
 * deletion function can do: a function with no durable store of its own cannot write off-platform
 * without a paid or externally hosted service, and the project's cost policy rules that out.
 * That makes the completeness of the registry an OWNER responsibility, which is why an empty or
 * unreadable registry is a refusal and never a pass.
 */
import { createHash } from 'node:crypto'

export const REGISTRY_HEADER = '# erasure-registry/v1'

const HEX64 = /^[0-9a-f]{64}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class RegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegistryError'
  }
}

/** The registry's stand-in for an account id. Namespaced so it is not a bare hash of a UUID. */
export function hashAccountId(id: string): string {
  if (!UUID.test(id)) throw new RegistryError('not an account id (expected a UUID)')
  return createHash('sha256')
    .update(`pokeportfolio:erased-account:${id.toLowerCase()}`)
    .digest('hex')
}

export interface RegistryEntry {
  hash: string
  erasedOn: string
}

/** Strict parse: an unrecognised line is an error, not something to skip past. */
export function parseRegistry(text: string): RegistryEntry[] {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== REGISTRY_HEADER) {
    throw new RegistryError(`registry must start with "${REGISTRY_HEADER}"`)
  }
  const entries: RegistryEntry[] = []
  for (const [index, raw] of lines.slice(1).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const [hash, erasedOn, ...rest] = line.split(/\s+/)
    if (rest.length > 0 || !hash || !erasedOn || !HEX64.test(hash) || !DATE.test(erasedOn)) {
      throw new RegistryError(`registry line ${String(index + 2)} is not "<sha256> <YYYY-MM-DD>"`)
    }
    entries.push({ hash, erasedOn })
  }
  return entries
}

export function appendEntry(text: string | null, id: string, erasedOn: string): string {
  if (!DATE.test(erasedOn)) throw new RegistryError('date must be YYYY-MM-DD')
  const base = text === null || text.trim() === '' ? `${REGISTRY_HEADER}\n` : text
  const existing = parseRegistry(base)
  const hash = hashAccountId(id)
  if (existing.some((e) => e.hash === hash)) return base.endsWith('\n') ? base : `${base}\n`
  return `${base.endsWith('\n') ? base : `${base}\n`}${hash} ${erasedOn}\n`
}

export type GateStatus = 'clean' | 'resurrected' | 'registry_empty'

export interface GateVerdict {
  status: GateStatus
  registryEntries: number
  idsChecked: number
  matches: number
}

/**
 * The whole decision. `restoredIds` are every account id found in the restored image (auth users
 * and every owner column). Anything in the registry that is present there is a resurrected account.
 *
 * An EMPTY registry is not a pass: it means either nobody has ever been deleted (then the operator
 * says so with `allowEmpty`, on purpose) or the registry was lost or never maintained — which is
 * indistinguishable from the inside, so it must not read as "clean".
 */
export function evaluateRestore(input: {
  restoredIds: Iterable<string>
  registry: readonly RegistryEntry[]
  allowEmpty: boolean
}): GateVerdict {
  const erased = new Set(input.registry.map((e) => e.hash))
  const ids = new Set<string>()
  for (const id of input.restoredIds) ids.add(id.toLowerCase())
  let matches = 0
  for (const id of ids) if (erased.has(hashAccountId(id))) matches += 1
  const base = { registryEntries: erased.size, idsChecked: ids.size, matches }
  if (matches > 0) return { status: 'resurrected', ...base }
  if (erased.size === 0 && !input.allowEmpty) return { status: 'registry_empty', ...base }
  return { status: 'clean', ...base }
}
