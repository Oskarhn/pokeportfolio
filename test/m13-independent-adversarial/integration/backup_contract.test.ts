/**
 * IMPLEMENTATION-GATED backup contract tests (prompt sections 5/10/13/14).
 *
 * On current origin/main these SKIP by construction (no export/backup modules exist yet).
 * When aimed at an M13 implementation they become ACTIVE and assert, against the independent
 * oracles in helpers/:
 *
 *   envelope-version  -> integer >= 1, stable format id
 *   csv-sanitizer     -> byte-identical behavior to sanitizeCsvTextCell over the full
 *                        trigger matrix, INCLUDING leaving literals untouched
 *   csv-writer        -> RFC 4180 round-trip through the independent reader
 *   backup-builder    -> envelope validates; no MUST_NOT_EXPORT section; no privilege column;
 *                        counts reconcile; deterministic re-export differs only in
 *                        exported_at; money values survive BigInt-exactly
 *
 * Every binding failure raises a CONTRACT VIOLATION naming the divergent surface — the point
 * is that an integration session fails these tests for the RIGHT reasons, then updates
 * helpers/contract.ts deliberately rather than silently.
 */
import { describe, expect, it } from 'vitest'

import { hasSupabaseEnv, skipUnlessImplementation } from '../helpers/contract.ts'
import {
  hasViolations,
  REQUIRED_BACKUP_FORMAT,
  validateBackupEnvelope,
} from '../helpers/envelope.ts'
import { emitTextCell, parseCsv, sanitizeCsvTextCell, writeCsv } from '../helpers/csvOracle.ts'
import { PRIVILEGE_INTERNAL_COLUMNS, mustNotExportTables } from '../helpers/inventory.ts'
import { serializeMinorUnits } from '../helpers/moneyOracle.ts'
import { BEYOND_SAFE_INTEGER } from '../helpers/moneyOracle.ts'

// Repository root relative to this file: test/m13-independent-adversarial/integration/.
const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

describe('M13 backup contract (implementation-gated)', () => {
  it('envelope version capability conforms to the versioning contract', async (ctx) => {
    await skipUnlessImplementation(ctx, REPO_ROOT)
    const loaded = await import('../helpers/contract.ts').then((m) => m.loadM13Surface(REPO_ROOT))
    const found = loaded.find('envelope-version')
    if (!found) {
      throw new Error(
        '[M13 CONTRACT] No schema-version-like export discovered although export modules exist ' +
          `(${loaded.modules.map((m) => m.relPath).join(', ')}). D-025 requires exactly one ` +
          'version constant; name it so the contract can find it or update helpers/contract.ts ' +
          'deliberately.',
      )
    }
    const value = found.value
    expect(
      typeof value === 'number' || typeof value === 'string',
      'version constant must be number or numeric string',
    ).toBe(true)
    const numeric = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9]/g, ''))
    expect(Number.isFinite(numeric)).toBe(true)
    expect(numeric).toBeGreaterThanOrEqual(1)
  })

  it('CSV sanitizer matches the independent oracle across the hostile matrix', async (ctx) => {
    await skipUnlessImplementation(ctx, REPO_ROOT)
    const loaded = await import('../helpers/contract.ts').then((m) => m.loadM13Surface(REPO_ROOT))
    const found = loaded.find('csv-sanitizer')
    if (!found) {
      throw new Error(
        '[M13 CONTRACT] Export modules exist but none exposes a sanitizer export matching ' +
          '/sanitiz/i. OWASP CSV-injection defense must live in ONE canonical place.',
      )
    }
    const impl = found.value
    expect(typeof impl).toBe('function')
    const cases = [
      '=SUM(A1:A2)',
      '+cmd',
      '-calc',
      '@foo',
      '\tTabbed',
      '\rCR-prefixed',
      '＝full-width equals',
      'harmless text',
      '',
      '\u00C6\u00D8\u00C5',
    ]
    for (const c of cases) {
      let actual: unknown
      try {
        actual = (impl as (v: string) => string)(c)
      } catch (err) {
        throw new Error(
          `[M13 CONTRACT] sanitizer ${found.module.relPath}#${found.name} threw on ${JSON.stringify(c)}: ${String(err)}`,
          { cause: err },
        )
      }
      expect(actual, `sanitizer divergence on ${JSON.stringify(c)}`).toBe(sanitizeCsvTextCell(c))
    }
  })

  it('CSV writer output parses losslessly through the independent reader', async (ctx) => {
    await skipUnlessImplementation(ctx, REPO_ROOT)
    const loaded = await import('../helpers/contract.ts').then((m) => m.loadM13Surface(REPO_ROOT))
    const found = loaded.find('csv-writer')
    if (!found) {
      throw new Error(
        '[M13 CONTRACT] no CSV writer export matched /(to|write|build|emit)Csv|csvFrom/i',
      )
    }
    expect(typeof found.value).toBe('function')

    // The writer may take rows-of-strings OR richer row objects; probe with the simplest legal
    // input and demand RFC 4180-parseable output containing our sentinel fields.
    const sentinelA = 'a,b'
    const sentinelB = 'say "hi"'
    let out: unknown
    try {
      out = await (found.value as (rows: unknown) => unknown)([[sentinelA, sentinelB]])
    } catch (err) {
      throw new Error(
        `[M13 CONTRACT] writer ${found.module.relPath}#${found.name} rejected a plain string-row ` +
          `matrix (${String(err)}). If its real signature differs, update helpers/contract.ts ` +
          'deliberately — do not loosen this test silently.',
        { cause: err },
      )
    }
    expect(typeof out).toBe('string')
    const parsed = parseCsv(out as string)
    expect(parsed.length).toBeGreaterThanOrEqual(1)
    expect(parsed.flat().join('\u0001')).toContain(sanitizeCsvTextCell(sentinelA))
  })

  describe.skipIf(!hasSupabaseEnv())('generated-backup end-to-end contract', () => {
    it('a generated backup validates, excludes derived/system data and reconciles counts', async (ctx) => {
      await skipUnlessImplementation(ctx, REPO_ROOT)
      const loaded = await import('../helpers/contract.ts').then((m) => m.loadM13Surface(REPO_ROOT))
      const found = loaded.find('backup-builder')
      if (!found) {
        throw new Error(
          '[M13 CONTRACT] no backup builder export matched ' +
            '/(build|create|generate)(Full)?Backup|exportEverything|collectBackup/i — update ' +
            'helpers/contract.ts deliberately if the entry point is named differently.',
        )
      }

      let artifact: unknown
      try {
        artifact = await (found.value as () => unknown)()
      } catch (err) {
        throw new Error(
          `[M13 CONTRACT] backup builder ${found.module.relPath}#${found.name} could not be ` +
            `invoked with no arguments (${String(err)}). Client-side generation under the ` +
            'caller JWT should not need them; if it does, bind deliberately.',
          { cause: err },
        )
      }

      const raw = typeof artifact === 'string' ? (JSON.parse(artifact) as unknown) : artifact
      const issues = validateBackupEnvelope(raw)
      const violations = issues.filter((i) => i.severity === 'violation')
      expect(
        violations,
        `envelope violations:\n${violations.map((v) => `- ${v.message}`).join('\n')}`,
      ).toEqual([])

      const data = (raw as { data?: Record<string, unknown> }).data ?? {}

      // Derived-cache trap + system exclusions, asserted on the ARTIFACT itself.
      for (const table of mustNotExportTables()) {
        expect(data[table], `${table} must never appear in data`).toBeUndefined()
      }

      // Privilege internals must not ride along inside profile rows.
      const forbiddenColumns = PRIVILEGE_INTERNAL_COLUMNS.get('profiles') ?? []
      const profiles = Array.isArray(data.profiles) ? (data.profiles as unknown[]) : []
      for (const row of profiles) {
        for (const col of forbiddenColumns) {
          expect(col in (row as object), `profiles.${col} leaked into backup`).toBe(false)
        }
      }
    })

    it('re-export is deterministic apart from exported_at (diffable backups)', async (ctx) => {
      await skipUnlessImplementation(ctx, REPO_ROOT)
      const loaded = await import('../helpers/contract.ts').then((m) => m.loadM13Surface(REPO_ROOT))
      const found = loaded.find('backup-builder')
      if (!found) throw new Error('[M13 CONTRACT] backup builder missing for determinism check')

      const first = await (found.value as () => Promise<string | object>)()
      const second = await (found.value as () => Promise<string | object>)()
      const normalize = (x: string | object): Record<string, unknown> => {
        const parsed = typeof x === 'string' ? (JSON.parse(x) as object) : x
        const copy = structuredClone(parsed) as Record<string, unknown>
        delete copy.exported_at
        delete copy.app_version
        return copy
      }
      expect(normalize(second)).toEqual(normalize(first))
      expect(hasViolations(validateBackupEnvelope(first))).toBe(false)
    })

    it('money values travel BigInt-exactly (beyond-safe-integer case)', async (ctx) => {
      await skipUnlessImplementation(ctx, REPO_ROOT)
      // Oracle-side statement of the required property; the artifact-level assertion lives in
      // the seeded completeness suite (security/completeness) once builders are bound.
      expect(serializeMinorUnits(BEYOND_SAFE_INTEGER)).toBe('9007199254740993')
      const parsed: unknown = JSON.parse(`{"v":"${serializeMinorUnits(BEYOND_SAFE_INTEGER)}"}`)
      expect((parsed as { v: string }).v).toBe('9007199254740993')
      expect(REQUIRED_BACKUP_FORMAT).toBe('pokeportfolio-backup')
      // Text-cell emission of a hostile note stays safe inside a full file render.
      const file = writeCsv([[emitTextCell("=cmd|' /C calc!")]])
      expect(file).toContain("'=cmd|' /C calc!")
    })
  })
})
