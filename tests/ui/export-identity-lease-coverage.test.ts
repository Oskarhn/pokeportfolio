import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P162 — where the export's identity guarantees come from, kept as a test so they cannot rot.
 * Same technique as identity-lease-coverage.test.ts: read the source and fail with the offender's
 * name. The behaviour itself is proven by the unit, database and browser suites; this only pins
 * the wiring a behavioural test cannot see (a NEW export path that never asks for a lease).
 */

const ROOT = join(__dirname, '..', '..')
const rel = (path: string) => relative(ROOT, path).replaceAll('\\', '/')
const read = (path: string) => readFileSync(path, 'utf8')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

const SRC = join(ROOT, 'src')
const EXPORT_DATA = join(SRC, 'data', 'export')

/** Code without comments, so a rule's own explanation cannot satisfy or violate it. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('exports never use the shared Supabase client', () => {
  it('no module of the export data layer or the Quick CSV imports the shared client', () => {
    const offenders = [...sourceFiles(EXPORT_DATA), join(SRC, 'data', 'portfolioExport.ts')].filter(
      (file) => /from\s+['"](\.\.?\/)+(data\/)?supabase-client['"]/.test(code(file)),
    )
    expect(offenders.map(rel)).toEqual([])
  })

  it('the artifact builders and the Quick CSV take a LeasedDb, so the compiler refuses the shared client', () => {
    const artifacts = code(join(EXPORT_DATA, 'artifacts.ts'))
    expect(artifacts).toMatch(/exportJsonBackup\(\s*options: ExportOptions,\s*db: LeasedDb/)
    expect(artifacts).toMatch(/exportCsvArtifacts\(\s*options: ExportOptions,\s*db: LeasedDb/)
    expect(code(join(SRC, 'data', 'portfolioExport.ts'))).toMatch(/db: LeasedDb/)
  })

  it('only the wired controller and the Portfolio action call the export functions', () => {
    const callers = sourceFiles(SRC)
      .filter((file) => !rel(file).startsWith('src/data/export/'))
      .filter((file) =>
        /\b(exportJsonBackup|exportCsvArtifacts|fetchExportSnapshot|buildPortfolioCsv)\s*\(/.test(
          code(file),
        ),
      )
      .map(rel)
      .sort()
    expect(callers).toEqual([
      'src/data/portfolioExport.ts', // (declares buildPortfolioCsv)
      'src/features/export/controller.ts',
      'src/features/portfolio/PortfolioActionShortcuts.tsx',
    ])
  })
})

describe('the run belongs to a lease from the button press to the last byte', () => {
  it('the wired controller requires a lease, builds the leased client from it and runs under it', () => {
    const controller = code(join(SRC, 'features', 'export', 'controller.ts'))
    expect(controller).toContain('requireLease(options?.lease)')
    expect((controller.match(/leasedDb\(lease\)/g) ?? []).length).toBe(2)
    expect((controller.match(/runWithLease\(lease,/g) ?? []).length).toBe(2)
    expect(controller).not.toMatch(/supabase-client/)
  })

  it('the guard of a leased client IS the lease, and it is evaluated around every request', () => {
    const guard = code(join(EXPORT_DATA, 'identity-guard.ts'))
    expect(guard).toMatch(/assertUnchanged\(\)\s*\{\s*lease\.assertCurrent\(\)/)
    const fetcher = code(join(EXPORT_DATA, 'fetch-snapshot.ts'))
    // before+after each page walk (2), each COUNT (2), three manifest walks (6) and one final gate
    expect((fetcher.match(/await assertIdentity\(options\)/g) ?? []).length).toBe(11)
    const quick = code(join(SRC, 'data', 'portfolioExport.ts'))
    expect(
      (quick.match(/await identity\.assertUnchanged\(\)/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3)
  })

  it('the Export page ties its files to the lease and gates every hand-over on it', () => {
    const page = code(join(SRC, 'features', 'export', 'ExportPage.tsx'))
    expect(page).toContain('identity.begin(userId)')
    expect(page).toContain('artifactsLeaseRef')
    expect(page).toContain('isCurrent()')
    expect(page).toMatch(/deliverFiles\(files, \{ canDeliver: deliverableNow \}\)/)
    expect(page).toMatch(/downloadOnly\(files, \{ canDeliver: deliverableNow \}\)/)
    // A user-id comparison is not an identity check (it cannot see A -> B -> A).
    expect(page).not.toMatch(/userIdRef|artifactsOwnerRef/)
  })

  it('the delivery layer asks the gate before each file and after the save dialog', () => {
    const delivery = code(join(SRC, 'features', 'export', 'fileDelivery.ts'))
    expect((delivery.match(/requireDeliverable\(options\)/g) ?? []).length).toBeGreaterThanOrEqual(
      3,
    )
    expect(delivery).toContain('if (error instanceof DeliveryRefusedError) throw error')
  })

  it('the Quick CSV action is a leased action and checks the lease before delivering', () => {
    const action = code(join(SRC, 'features', 'portfolio', 'PortfolioActionShortcuts.tsx'))
    expect(action).toContain('useLeasedAction')
    expect(action).toMatch(/lease\.assertCurrent\(\)\s*\n\s*await downloadOnly/)
    expect(action).toContain('canDeliver: () => lease.isCurrent()')
  })
})

describe('financial exports are kept out of every persistent client store', () => {
  const exportUi = [
    join(SRC, 'features', 'export', 'ExportPage.tsx'),
    join(SRC, 'features', 'export', 'fileDelivery.ts'),
    join(SRC, 'features', 'export', 'controller.ts'),
    join(SRC, 'features', 'export', 'exportFlow.ts'),
    join(SRC, 'data', 'portfolioExport.ts'),
    ...sourceFiles(EXPORT_DATA),
    ...sourceFiles(join(SRC, 'domain', 'export')),
  ]

  it('no export module writes to localStorage, sessionStorage, IndexedDB or the Cache API', () => {
    const offenders: string[] = []
    for (const file of exportUi) {
      const text = code(file)
      const uses = /\b(sessionStorage|indexedDB|caches\.|CacheStorage|openDB)\b/.test(text)
      // ExportPage's one localStorage use is the "you exported recently" reminder timestamp, which
      // stores no export content: it passes the storage into markReminderSatisfied.
      const local = [...text.matchAll(/localStorage/g)].length
      const allowedLocal = file.endsWith('ExportPage.tsx') ? 2 : 0
      if (uses || local > allowedLocal) offenders.push(rel(file))
    }
    expect(offenders).toEqual([])
    expect(code(join(SRC, 'features', 'export', 'ExportPage.tsx'))).toMatch(
      /markReminderSatisfied\(window\.localStorage, session\.user\.id\)/,
    )
  })

  it('the service worker precaches only the app shell and runtime-caches only scanner assets', () => {
    const config = read(join(ROOT, 'vite.config.ts'))
    expect(config).toMatch(/globPatterns:\s*\['\*\*\/\*\.\{js,css,html,svg,png,ico,woff2\}'\]/)
    const runtime = /runtimeCaching:\s*\[([\s\S]*?)\]/.exec(config)?.[1] ?? ''
    expect(
      runtime
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ).toEqual(['scannerAssetRuntimeCache', 'visualAssetRuntimeCache', 'visualIndexRuntimeCache'])
  })

  it('there is no analytics or telemetry client anywhere in the application', () => {
    const manifest = JSON.parse(read(join(ROOT, 'package.json'))) as {
      dependencies?: Record<string, string>
    }
    const names = Object.keys(manifest.dependencies ?? {})
    const telemetry = names.filter((name) =>
      /sentry|posthog|mixpanel|amplitude|segment|datadog|logrocket|fullstory|gtag|analytics/i.test(
        name,
      ),
    )
    expect(telemetry).toEqual([])
  })
})
