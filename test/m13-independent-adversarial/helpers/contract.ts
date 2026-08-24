/**
 * Runtime discovery of the M13 implementation surface, and the gates built on it.
 *
 * This package was written WITHOUT reading any implementation branch. It therefore never
 * hard-codes an import of a module that may not exist: it probes the filesystem for plausible
 * export/backup modules under src/, dynamically imports what it finds (vitest can import TS
 * directly), and classifies each module by the CAPABILITIES its exports match:
 *
 *   envelope/version  — the schema_version constant + envelope builder
 *   sanitizer         — CSV injection sanitization
 *   csv writer        — RFC 4180 emission
 *   backup builder    — end-to-end backup generation
 *
 * On current origin/main nothing is found → every integration test SKIPS with that exact
 * reason. Against a branch claiming M13, "found but capability missing / oracle disagreement"
 * is a loud contract violation — precisely the failures these tests exist to produce.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export type M13Capability = 'envelope-version' | 'csv-sanitizer' | 'csv-writer' | 'backup-builder'

const EXPORT_NAME_PATTERNS: readonly { capability: M13Capability; pattern: RegExp }[] = [
  {
    capability: 'envelope-version',
    pattern: /^(schema_?version|backup_?format|format_?version|current_?schema_?version)$/i,
  },
  { capability: 'csv-sanitizer', pattern: /sanitiz/i },
  { capability: 'csv-writer', pattern: /(to|write|build|emit)Csv|csvFrom/i },
  {
    capability: 'backup-builder',
    pattern: /(build|create|generate)(Full)?Backup|exportEverything|collectBackup/i,
  },
]

export interface DiscoveredModule {
  /** Path relative to the repository root. */
  readonly relPath: string
  readonly exports: ReadonlyMap<string, unknown>
  readonly capabilities: readonly M13Capability[]
}

export interface M13Surface {
  readonly modules: readonly DiscoveredModule[]
  readonly found: boolean
  find(capability: M13Capability): { module: DiscoveredModule; name: string; value: unknown } | null
}

/** Candidate directories scanned for export/backup modules (implementation naming unknown). */
function candidateDirectories(repoRoot: string): string[] {
  const candidates = ['src/domain/export', 'src/data/export', 'src/domain', 'src/data']
  const found: string[] = []
  for (const dir of candidates) {
    const abs = join(repoRoot, dir)
    if (!existsSync(abs)) continue
    let entries: string[]
    try {
      entries = readdirSync(abs)
    } catch {
      continue
    }
    for (const entry of entries) {
      // Plausible module names only — do not sweep unrelated domain files into dynamic imports.
      if (!/\.(ts)$/.test(entry)) continue
      if (!/export|backup|csv/i.test(entry)) continue
      if (/\.test\.ts$/.test(entry)) continue
      found.push(join(dir, entry))
    }
  }
  return [...new Set(found)]
}

let surfaceCache: M13Surface | null = null

/** Cached async discovery (module graph does not change mid-run). */
export async function loadM13Surface(repoRoot: string): Promise<M13Surface> {
  if (surfaceCache) return surfaceCache
  surfaceCache = await discover(repoRoot)
  return surfaceCache
}

async function discover(repoRoot: string): Promise<M13Surface> {
  const modules: DiscoveredModule[] = []

  for (const relPath of candidateDirectories(repoRoot)) {
    const abs = join(repoRoot, relPath)
    let imported: Record<string, unknown>
    try {
      imported = (await import(pathToFileURL(abs).href)) as Record<string, unknown>
    } catch {
      // A file that exists but does not import standalone (e.g. it needs bundler aliases or
      // React context) still counts as DISCOVERED — record it with no capabilities so the
      // "surface found" signal fires and mismatch tests can name the file.
      modules.push({ relPath, exports: new Map(), capabilities: [] })
      continue
    }
    const exports = new Map(Object.entries(imported))
    const capabilities: M13Capability[] = []
    for (const { capability, pattern } of EXPORT_NAME_PATTERNS) {
      for (const name of exports.keys()) {
        if (pattern.test(name)) {
          capabilities.push(capability)
          break
        }
      }
    }
    modules.push({ relPath, exports, capabilities })
  }

  const index = new Map<M13Capability, { module: DiscoveredModule; name: string; value: unknown }>()
  for (const mod of modules) {
    for (const { capability, pattern } of EXPORT_NAME_PATTERNS) {
      if (mod.capabilities.includes(capability) && !index.has(capability)) {
        for (const [name, value] of mod.exports) {
          if (pattern.test(name)) {
            index.set(capability, { module: mod, name, value })
            break
          }
        }
      }
    }
  }

  return {
    modules,
    found: modules.length > 0,
    find(capability: M13Capability) {
      return index.get(capability) ?? null
    },
  }
}

export function hasSupabaseEnv(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

export interface SkipContext {
  skip: (note?: string) => void
}

/**
 * Gate for DB-backed suites. Skips when no ephemeral stack is configured. Unlike the M12
 * predecessor this suite's DB-backed cases run against CURRENT MAIN tables only (RLS on the
 * canonical user tables), so there is no further schema gate — they are ACTIVE whenever a stack
 * exists, not implementation-gated.
 */
export async function requireSupabaseStack(ctx: SkipContext): Promise<void> {
  if (!hasSupabaseEnv()) {
    ctx.skip(
      'No Supabase ephemeral stack configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset). ' +
        'Run `pnpm db:start`, export the values from `pnpm exec supabase status -o env`, or use CI.',
    )
  }
}

/**
 * Gate for implementation-gated suites: skips on current main (no export/backup modules yet),
 * which keeps main green by construction. The skip message tells an integrator exactly what to
 * expect once an implementation exists.
 */
export async function skipUnlessImplementation(
  ctx: SkipContext,
  repoRoot: string,
): Promise<M13Surface> {
  await requireSupabaseStack(ctx)
  const surface = await loadM13Surface(repoRoot)
  if (!surface.found) {
    ctx.skip(
      'No M13 export/backup implementation discovered under src/ (probed src/domain/export*, ' +
        'src/data/export* for export/backup/csv-named modules). These tests assert the backup ' +
        'CONTRACT against a real implementation and stay skipped until one exists.',
    )
  }
  return surface
}
