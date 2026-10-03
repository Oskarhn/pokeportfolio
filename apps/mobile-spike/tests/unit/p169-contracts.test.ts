import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { runP169Proof } from '../../src/diagnostics/price-check-proof'
import {
  NATIVE_RECOGNITION_UNAVAILABLE,
  toRecognitionOutcome,
} from '../../src/features/price-check/recognition'
import { assertReadOnlyRequest } from '../../src/net/spike-fetch'

/**
 * Structural guarantees of the P169 feature that a behaviour test could miss:
 *   1. the vendored P165 domain is BYTE-IDENTICAL to the P165 candidate (git blob ids), so it is
 *      reuse, not a parallel fork;
 *   2. the feature can only read (static import/call scan + the wire policy);
 *   3. text-only search/price code never loads the scanner or photo recognition;
 *   4. the in-app proof passes on the Node engine (the device run is the Hermes evidence).
 */

const appRoot = join(__dirname, '..', '..')
const features = join(appRoot, 'src', 'features')
const vendored = join(features, 'price-check', 'p165-domain')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? files(full) : /\.tsx?$/.test(name) ? [full] : []
  })
}

const gitBlobId = (text: string): string => {
  const bytes = Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex')
}

describe('vendored P165 domain is byte-identical', () => {
  const provenance = JSON.parse(readFileSync(join(vendored, 'PROVENANCE.json'), 'utf8')) as {
    sourceCommit: string
    sourceRepoPath: string
    gitBlobIds: Record<string, string>
  }

  it('every vendored file hashes to the P165 blob id, and no file is missing or extra', () => {
    const present = readdirSync(join(vendored, 'price-check')).sort()
    expect(present).toEqual(Object.keys(provenance.gitBlobIds).sort())
    for (const [name, id] of Object.entries(provenance.gitBlobIds)) {
      expect([name, gitBlobId(readFileSync(join(vendored, 'price-check', name), 'utf8'))]).toEqual([
        name,
        id,
      ])
    }
  })

  it('the pinned ids are the ids in the P165 commit (checked when that commit is available locally)', () => {
    const r = spawnSync(
      'git',
      ['ls-tree', provenance.sourceCommit, `${provenance.sourceRepoPath}/`],
      {
        cwd: join(appRoot, '..', '..'),
        encoding: 'utf8',
      },
    )
    if (r.status !== 0 || r.stdout.trim() === '') {
      console.warn(
        `P165 commit ${provenance.sourceCommit} not in this clone: pin checked against PROVENANCE.json only`,
      )
      return
    }
    const fromGit = Object.fromEntries(
      r.stdout
        .trim()
        .split('\n')
        .map((line) => {
          const [meta, path] = line.split('\t') as [string, string]
          return [path.split('/').pop() as string, meta.split(' ')[2] as string]
        }),
    )
    expect(fromGit).toEqual(provenance.gitBlobIds)
  })

  it('the shims only re-export the shared domain (no second money/currency/FX implementation)', () => {
    for (const shim of ['money.ts', 'currency.ts', 'fx.ts']) {
      const code = readFileSync(join(vendored, shim), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim()
      expect(code).toBe(`export * from '@shared/domain/${shim.replace('.ts', '')}'`)
    }
  })
})

describe('read-only by construction', () => {
  const source = files(features)
    .filter((f) => !f.includes(`${join('features', 'harness')}`))
    .map((f) => ({ file: relative(appRoot, f), code: readFileSync(f, 'utf8') }))

  it('no feature file imports a ledger/write data module or calls a write API', () => {
    const LEDGER =
      /@shared\/data\/(purchases|sales|opening|reset|sealedProducts|customCollections|profile|portfolio|collection|history|dashboard|retailers|portfolioExport)\b/
    // Supabase write builders; `.delete()` takes no argument there (Map#delete does, and is fine).
    const WRITE = /\.(insert|upsert|update)\(|\.delete\(\)|\.rpc\(/
    const offenders = source
      .filter((s) => LEDGER.test(s.code) || WRITE.test(s.code))
      .map((s) => s.file)
    expect(offenders).toEqual([])
    // The only table read directly is the fx_rates market-data table (a GET).
    const tables = source.flatMap((s) =>
      [...s.code.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]),
    )
    expect([...new Set(tables)]).toEqual(['fx_rates'])
  })

  it('the wire policy lets exactly the read-only function through and refuses every write', () => {
    const base = 'http://10.0.2.2:55921'
    expect(() => assertReadOnlyRequest('POST', `${base}/functions/v1/search-prices`)).not.toThrow()
    expect(() => assertReadOnlyRequest('GET', `${base}/rest/v1/fx_rates?select=rate`)).not.toThrow()
    for (const path of [
      '/functions/v1/ingest-prices',
      '/functions/v1/ingest-fx',
      '/functions/v1/sync-catalog',
      '/functions/v1/redeem-invitation',
      '/functions/v1/search-prices-released',
      '/rest/v1/rpc/create_purchase',
      '/rest/v1/rpc/add_card_acquisition',
      '/rest/v1/holdings',
    ]) {
      expect(() => assertReadOnlyRequest('POST', `${base}${path}`)).toThrow(/read-only/)
    }
    expect(() => assertReadOnlyRequest('PATCH', `${base}/rest/v1/profiles`)).toThrow(/read-only/)
  })

  it('text-only search / price code never imports the scanner, the photo picker or a model', () => {
    // P182: scanner-native/ IS the real recognizer (OCR + visual model), so its own files are
    // legitimately excluded here exactly like PhotoEntryScreen/recognition.ts/feature.ts already
    // were — this test's job is keeping the OTHER Price Check code (search, price lookup, the
    // catalog card screen) free of scanner/photo/model imports, not banning the recognizer itself.
    const textOnly = source.filter(
      (s) => !/PhotoEntryScreen|recognition\.ts|feature\.ts|scanner-native[\\/]/.test(s.file),
    )
    const offenders = textOnly
      .filter((s) =>
        /(from|require\()\s*'[^']*(scanner|expo-image-picker|photo\/expo-photo-port|onnx|tflite|tesseract)[^']*'/i.test(
          s.code,
        ),
      )
      .map((s) => s.file)
    expect(offenders).toEqual([])
  })
})

describe('recognition seam', () => {
  it('the native app has no recognizer and says so (not_available is not no_match)', async () => {
    expect(NATIVE_RECOGNITION_UNAVAILABLE.implemented).toBe(false)
    await expect(
      NATIVE_RECOGNITION_UNAVAILABLE.recognize({ uri: 'file:///x.jpg', width: 1, height: 1 }),
    ).resolves.toEqual({
      status: 'not_available',
      reason: 'no_native_recognizer',
    })
  })

  it('a future analysis goes through P165 interpretScan: HIGH preselects, MEDIUM never does', () => {
    const c = {
      candidateId: 'c1',
      name: 'X',
      setName: null,
      collectorNumber: null,
      imageBaseUrl: null,
      languageLabel: null,
    }
    expect(toRecognitionOutcome({ confidence: 'HIGH', candidates: [c] })).toEqual({
      status: 'analysed',
      outcome: { kind: 'high', candidates: [c], preselectedId: 'c1' },
    })
    expect(toRecognitionOutcome({ confidence: 'MEDIUM', candidates: [c] }).status).toBe('analysed')
  })
})

describe('in-app proof (Node engine)', () => {
  it('every P169 proof check passes', () => {
    const result = runP169Proof()
    expect(result.lines.filter((l) => l.startsWith('FAIL'))).toEqual([])
    expect(result.pass).toBeGreaterThanOrEqual(25)
  })
})
