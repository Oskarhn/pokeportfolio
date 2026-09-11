import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import {
  buildIndexContentPayload,
  truncateDigestHex,
} from '../../src/domain/scanner/index-content-id'

/**
 * P113 §4 — index pointer/generation fault matrix, driven against the REAL built visual-worker
 * chunk (same technique as `visual-worker-real-browser.spec.ts`, F-31), not a mock. Every scenario
 * below serves a synthetic, tiny, byte-consistent index generation through route interception and
 * asserts the worker's own production `loadIndex()` (visual-worker.ts) reaches a well-formed
 * terminal state — the worker's `ready` message with `indexAvailable:false` and a specific,
 * attributable `indexUnavailableReason` — never a crash, a hang, or `indexAvailable:true` against
 * mismatched/corrupt data. Model/processor loading (slow, real WASM+DINOv2) is unaffected by any
 * of these faults by design (`loadIndex()` runs strictly after model load in `init()`), so every
 * scenario here is a real index-layer fault, isolated from backend selection.
 *
 * P113 real finding, load-bearing for this whole file: routes are registered via
 * `page.context().route()`, never bare `page.route()`. `loadIndex()` runs entirely inside a
 * dedicated module Worker (`visual-worker.ts`), issuing four SEQUENTIAL fetches (pointer, then
 * manifest, then card-ids+embeddings). Empirically reproduced against this exact Playwright/
 * Chromium build (a minimal repro with only two routes registered, isolated from every other
 * moving part in this file): `page.route()` reliably intercepts only the FIRST fetch a dedicated
 * Worker issues — every subsequent fetch from that SAME worker silently bypasses page-level
 * routing and reaches the real `vite preview` server, which SPA-fallback-rewrites the unknown
 * path to `index.html` (200, `text/html`) — surfacing as a confusing "unexpected token '<' ...
 * not valid JSON" error with no indication the interception itself was the problem. Context-level
 * routing (`page.context().route()`) does not share this gap and intercepts every worker fetch
 * correctly. `tests/e2e/scanner-index-cache-coherence.spec.ts` (P87) never hit this because it
 * only ever drives `fetch()` from the main page via `page.evaluate()`, never a real Worker.
 *
 * The fixture builder computes REAL SHA-256 content-ids/checksums via the exact same
 * `buildIndexContentPayload` production module the worker itself verifies against — so a fixture
 * is either genuinely self-consistent (passes every earlier gate, isolating the ONE fault under
 * test) or deliberately inconsistent in exactly the one dimension a scenario names.
 */

const EXPECTED_MODEL_REVISION = 'c2bb04a51fab207c420665f1946016107bffc701'
const EMBEDDING_DIM = 384
const POINTER_PATH = '**/scanner-assets/visual-v1/index/current.json'

function findVisualWorkerChunk(): string {
  const distAssets = fileURLToPath(new URL('../../dist/assets/', import.meta.url))
  if (!existsSync(distAssets)) {
    throw new Error('dist/assets not found — the e2e webServer should have run `pnpm build` first.')
  }
  const match = readdirSync(distAssets).find(
    (name) => name.startsWith('visual-worker-') && name.endsWith('.js'),
  )
  if (!match) throw new Error('No visual-worker-*.js chunk found in dist/assets.')
  return `/assets/${match}`
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface CoverageOverride {
  totalCanonicalCards?: number
  cardsWithUsableImage?: number
  cardsIndexed?: number
  failures?: number
}

interface FixtureOptions {
  cardCount?: number
  embeddingDim?: number
  modelRevision?: string
  quantization?: string
  schemaVersion?: number
  payloadFormat?: string
  prototypesPerCard?: number
  prototypeStrategy?: string
  prototypeStrategyVersion?: string
  /** Served embeddingsSha256 differs from the actual bytes' real hash — isolates the runtime
   *  checksum gate (excluded from the content-id hash by design, so this alone cannot also break
   *  the content-id check). */
  wrongDeclaredChecksum?: boolean
  /** Extra bytes appended to embeddings.bin AFTER content-id/checksum were computed against the
   *  original bytes — simulates a generation whose served files disagree with what they hashed to
   *  at publish time (independent of any manifest field mutation). */
  corruptServedEmbeddingsAfterHashing?: boolean
  coverageOverride?: CoverageOverride
  /** P115 §7 — the ACTUAL number of embedding rows generated/served/hashed, when it must differ
   *  from the manifest's own `cardCount * (prototypesPerCard ?? 1)` implication (a self-consistent
   *  fixture whose declared shape and served bytes disagree — the real-world "truncated/odd row
   *  count" fault, distinct from `corruptServedEmbeddingsAfterHashing`'s post-hash byte flip which
   *  never changes length). Defaults to the natural `cardCount * (prototypesPerCard ?? 1)`. */
  embeddingsRowCountOverride?: number
  /** P115 §7 — sets the manifest's own optional `rowCount` field directly, independent of the
   *  actual served embeddings length, isolating decodeVisualIndex's dedicated
   *  `rowCount !== cardCount * prototypesPerCard` cross-check (this field is excluded from the
   *  content-id hash, so setting it alone cannot also trip the content-id/checksum gates). */
  manifestRowCountOverride?: number
}

interface Fixture {
  pointerBody: string
  manifestBody: string
  cardIdsText: string
  embeddingsBuffer: Buffer
  contentId: string
}

function buildFixture(opts: FixtureOptions = {}): Fixture {
  const cardCount = opts.cardCount ?? 3
  const embeddingDim = opts.embeddingDim ?? EMBEDDING_DIM
  const prototypesPerCard = opts.prototypesPerCard
  const rowCount = opts.embeddingsRowCountOverride ?? cardCount * (prototypesPerCard ?? 1)

  const cardIds = Array.from({ length: cardCount }, (_, i) => `p113-synthetic-card-${String(i)}`)
  const cardIdsText = JSON.stringify(cardIds)
  const cardIdsBytes = new TextEncoder().encode(cardIdsText)

  const embeddingsArray = new Int8Array(rowCount * embeddingDim)
  for (let i = 0; i < embeddingsArray.length; i += 1) {
    embeddingsArray[i] = ((i * 7) % 255) - 127
  }
  const embeddingsBuffer = Buffer.from(embeddingsArray.buffer)
  const actualEmbeddingsSha256 = sha256Hex(new Uint8Array(embeddingsArray.buffer))

  const coverage = {
    totalCanonicalCards: opts.coverageOverride?.totalCanonicalCards ?? cardCount,
    cardsWithUsableImage: opts.coverageOverride?.cardsWithUsableImage ?? cardCount,
    cardsIndexed: opts.coverageOverride?.cardsIndexed ?? cardCount,
    failures: opts.coverageOverride?.failures ?? 0,
  }

  const manifestFieldsForHash = {
    version: 'visual-v1',
    modelId: 'Xenova/dinov2-small',
    modelRevision: opts.modelRevision ?? EXPECTED_MODEL_REVISION,
    modelSha256: 'p113-synthetic-model-sha',
    embeddingDim,
    quantization: opts.quantization ?? 'int8',
    cardCount,
    coverage,
    sourceProjectRef: undefined,
    sourceEnglishActiveCount: undefined,
    schemaVersion: opts.schemaVersion,
    payloadFormat: opts.payloadFormat,
    prototypesPerCard: opts.prototypesPerCard,
    prototypeStrategy: opts.prototypeStrategy,
    prototypeStrategyVersion: opts.prototypeStrategyVersion,
  }

  const contentPayload = buildIndexContentPayload(
    manifestFieldsForHash,
    cardIdsBytes,
    new Uint8Array(embeddingsArray.buffer),
  )
  const contentId = truncateDigestHex(sha256Hex(contentPayload))

  const manifest = {
    ...manifestFieldsForHash,
    embeddingsSha256: opts.wrongDeclaredChecksum ? 'f'.repeat(64) : actualEmbeddingsSha256,
    generatedAt: '2026-01-01T00:00:00.000Z',
    // Excluded from the content-id hash by production design (index-content-id.ts's
    // IndexContentIdManifestFields carries no rowCount) — added here, after hashing, so setting it
    // cannot also perturb the content-id/checksum gates under test elsewhere in this file.
    ...(opts.manifestRowCountOverride === undefined
      ? {}
      : { rowCount: opts.manifestRowCountOverride }),
  }

  const pointerBody = JSON.stringify({
    indexVersion: 'visual-v1',
    contentId,
    manifestPath: `generations/${contentId}/manifest.json`,
  })

  let finalEmbeddingsBuffer = embeddingsBuffer
  if (opts.corruptServedEmbeddingsAfterHashing) {
    const mutated = Buffer.from(embeddingsBuffer)
    mutated[0] = ((mutated[0] ?? 0) + 1) % 256
    finalEmbeddingsBuffer = mutated
  }

  return {
    pointerBody,
    manifestBody: JSON.stringify(manifest),
    cardIdsText,
    embeddingsBuffer: finalEmbeddingsBuffer,
    contentId,
  }
}

interface ReadyResult {
  type: 'ready' | 'unavailable' | 'worker-error'
  indexAvailable?: boolean
  indexLoad?: string
  indexUnavailableReason?: string | null
  cardCount?: number
  reason?: string
  message?: string
  /** P115 §7 — exposed so the v2 control case can confirm the schema actually loaded is v2/dual-
   *  prototype, not merely that SOME index loaded (mirrors visual-worker.ts's own `ready` message
   *  fields verbatim). */
  indexSchemaVersion?: number | null
  indexPayloadFormat?: string | null
  indexPrototypesPerCard?: number | null
  indexRowCount?: number | null
}

/** Serves a fixture's four files through realistic route interception, drives the REAL worker
 *  chunk through `init`, and returns its `ready`/`unavailable` message. Faults NOT covered by the
 *  fixture (e.g. a 404 override) are layered on top via `routeOverrides`. */
async function loadWorkerAgainstFixture(
  page: Page,
  fixture: Fixture | null,
  routeOverrides: {
    pointer?: (route: import('@playwright/test').Route) => Promise<void>
    manifest?: (route: import('@playwright/test').Route) => Promise<void>
    cardIds?: (route: import('@playwright/test').Route) => Promise<void>
    embeddings?: (route: import('@playwright/test').Route) => Promise<void>
  } = {},
): Promise<ReadyResult> {
  if (routeOverrides.pointer) {
    await page.context().route(POINTER_PATH, routeOverrides.pointer)
  } else if (fixture) {
    await page.context().route(POINTER_PATH, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-cache' },
        body: fixture.pointerBody,
      })
    })
  }

  if (fixture) {
    const genBase = `**/scanner-assets/visual-v1/index/generations/${fixture.contentId}`
    if (routeOverrides.manifest) {
      await page.context().route(`${genBase}/manifest.json`, routeOverrides.manifest)
    } else {
      await page.context().route(`${genBase}/manifest.json`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
          body: fixture.manifestBody,
        })
      })
    }
    if (routeOverrides.cardIds) {
      await page.context().route(`${genBase}/card-ids.json`, routeOverrides.cardIds)
    } else {
      await page.context().route(`${genBase}/card-ids.json`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
          body: fixture.cardIdsText,
        })
      })
    }
    if (routeOverrides.embeddings) {
      await page.context().route(`${genBase}/embeddings.bin`, routeOverrides.embeddings)
    } else {
      await page.context().route(`${genBase}/embeddings.bin`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/octet-stream',
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
          body: fixture.embeddingsBuffer,
        })
      })
    }
  }

  const workerPath = findVisualWorkerChunk()
  await page.goto('/')

  return page.evaluate(async (wp: string) => {
    const constructedAtMs = performance.timeOrigin + performance.now()
    const worker = new Worker(wp, { type: 'module' })
    return new Promise<ReadyResult>((resolve) => {
      worker.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { type?: string } | undefined
        if (data?.type === 'ready' || data?.type === 'unavailable') {
          resolve(data as ReadyResult)
          worker.terminate()
        }
      })
      worker.addEventListener('error', (event: ErrorEvent) => {
        resolve({ type: 'worker-error', message: event.message })
        worker.terminate()
      })
      worker.postMessage({ type: 'init', backendOverride: 'wasm', constructedAtMs })
    })
  }, workerPath)
}

/** Every scenario asserts the same shape: the worker must reach `ready` (model/backend load is
 *  never affected by an index fault) with `indexAvailable:false` and a non-empty reason mentioning
 *  the expected substring — never a crash, never a hang, never `indexAvailable:true`. */
function expectIndexUnavailable(result: ReadyResult, reasonSubstring: string): void {
  expect(result.type).toBe('ready')
  expect(result.indexAvailable).toBe(false)
  expect(result.indexLoad).toBe('failed')
  expect(result.cardCount).toBe(0)
  expect(typeof result.indexUnavailableReason).toBe('string')
  expect((result.indexUnavailableReason ?? '').toLowerCase()).toContain(
    reasonSubstring.toLowerCase(),
  )
}

// Generous per-test timeout: every scenario still pays the real cold model/WASM load cost before
// ever reaching the index-layer fault under test (same budget as F-31's own spec).
test.describe.configure({ mode: 'parallel', timeout: 150_000 })

test.describe('visual index fault matrix (P113 §4) — real worker, synthetic generations', () => {
  // Playwright requires this exact object-destructuring shape to recognize a fixtures-callback
  // signature (a plain unused identifier is rejected at test-collection time) — no fixture is
  // actually used here, only `testInfo`.
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    // P113 real finding: on this Playwright build's WebKit (`mobile-iphone`), only the FIRST
    // fetch a dedicated module Worker issues is ever visible to route interception — at BOTH
    // `page.route()` and `page.context().route()` — every subsequent worker fetch (manifest,
    // card-ids, embeddings) silently bypasses interception and reaches the REAL files already
    // staged in `dist/` (the committed 19,501-card index), not this file's synthetic fixtures.
    // Confirmed empirically: every scenario needing a SECOND intercepted fetch reported the real
    // index's data instead of the fixture's, on WebKit only — Chromium is unaffected. This is a
    // testing-tool limitation (matches `visual-worker-real-browser.spec.ts`'s own disclosed note
    // that Playwright's non-macOS WebKit build is for cross-engine CI coverage, not guaranteed
    // Apple-Safari fidelity), not a product defect — the production `loadIndex()` fail-closed
    // behavior this file verifies is engine-agnostic code with no WebKit-specific branch.
    //
    // P116 §23 hardening: the original check compared `testInfo.project.name` against the literal
    // string 'desktop-chromium' — a silent 100%-skip trap if that project were ever renamed
    // (flagged as an open fragility by both P115's self-review and the P116 brief). Selecting on
    // `testInfo.project.use.defaultBrowserType` instead derives the decision from the actual
    // browser engine a project resolves to (set by the `devices[...]` preset every project here is
    // built from — 'chromium' for Desktop Chrome, 'webkit' for iPhone 14), so a project rename
    // cannot silently defeat this gate. The companion meta-test below guards the remaining case a
    // per-project check cannot see itself: every chromium project being removed from the config
    // entirely.
    test.skip(
      testInfo.project.use.defaultBrowserType !== 'chromium',
      'Route interception for a SECOND+ dedicated-Worker fetch is unreliable on non-Chromium ' +
        'engines (see this describe block’s own comment) — Chromium projects only for this spec.',
    )
  })

  // P116 §23: a per-project `test.skip` can never detect "every project this could have run under
  // was removed" — that failure mode is invisible from inside the block it would silently empty
  // out. This meta-test runs unconditionally (no skip) in EVERY project and inspects the full,
  // static project list Playwright resolved the run from, so it fails loudly — in every project,
  // impossible to miss — the day no project resolves to Chromium any more.
  // Playwright requires this exact destructuring shape to recognize a fixtures-callback
  // signature; no fixture is actually used, only testInfo.
  // eslint-disable-next-line no-empty-pattern
  test('meta: at least one configured project resolves to Chromium (so this matrix cannot go silently skip-only)', ({}, testInfo) => {
    const chromiumProjects = testInfo.config.projects.filter(
      (project) => project.use.defaultBrowserType === 'chromium',
    )
    expect(
      chromiumProjects.length,
      `expected at least one Chromium-engine project in playwright.config.ts; found: ${testInfo.config.projects.map((p) => `${p.name}(${String(p.use.defaultBrowserType)})`).join(', ')}`,
    ).toBeGreaterThan(0)
  })

  test('current.json 404 — pointer missing entirely', async ({ page }) => {
    const result = await loadWorkerAgainstFixture(page, null, {
      pointer: async (route) => {
        await route.fulfill({ status: 404, body: 'not found' })
      },
    })
    expectIndexUnavailable(result, 'current.json fetch failed')
  })

  test('current.json malformed JSON', async ({ page }) => {
    const result = await loadWorkerAgainstFixture(page, null, {
      pointer: async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{not json' })
      },
    })
    // Corrected expectation (P113 finding): init()'s own call site wraps loadIndex() in a
    // .catch() (visual-worker.ts), so a JSON.parse failure surfaces as a normal `ready` message
    // with a specific indexUnavailableReason — it never escapes as an uncaught worker error.
    expectIndexUnavailable(result, 'index load threw')
  })

  test('current.json valid JSON but contentId is not well-formed', async ({ page }) => {
    const result = await loadWorkerAgainstFixture(page, null, {
      pointer: async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            indexVersion: 'visual-v1',
            contentId: 'NOT-HEX!!',
            manifestPath: 'x',
          }),
        })
      },
    })
    expectIndexUnavailable(result, 'not well-formed')
  })

  test('manifest.json 404 — pointer names a generation whose directory is missing', async ({
    page,
  }) => {
    const fixture = buildFixture()
    const result = await loadWorkerAgainstFixture(page, fixture, {
      manifest: async (route) => {
        await route.fulfill({ status: 404, body: 'not found' })
      },
    })
    expectIndexUnavailable(result, 'manifest.json fetch failed')
  })

  test('manifest embeddingDim mismatch', async ({ page }) => {
    const fixture = buildFixture({ embeddingDim: 128 })
    const result = await loadWorkerAgainstFixture(page, fixture)
    expectIndexUnavailable(result, 'embeddingdim')
  })

  test('manifest modelRevision mismatch', async ({ page }) => {
    const fixture = buildFixture({ modelRevision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
    const result = await loadWorkerAgainstFixture(page, fixture)
    expectIndexUnavailable(result, 'modelrevision')
  })

  test('manifest schemaVersion this build does not recognize', async ({ page }) => {
    const fixture = buildFixture({
      schemaVersion: 999,
      payloadFormat: 'from-the-future-v999',
      prototypesPerCard: 1,
    })
    const result = await loadWorkerAgainstFixture(page, fixture)
    expectIndexUnavailable(result, 'schemaversion')
  })

  test('manifest cardCount is not positive', async ({ page }) => {
    const fixture = buildFixture({
      cardCount: 0,
      coverageOverride: { totalCanonicalCards: 0, cardsWithUsableImage: 0, cardsIndexed: 0 },
    })
    const result = await loadWorkerAgainstFixture(page, fixture)
    expectIndexUnavailable(result, 'cardcount is not positive')
  })

  test('card-ids.json fetch fails (embeddings.bin fine) — partially available generation', async ({
    page,
  }) => {
    const fixture = buildFixture()
    const result = await loadWorkerAgainstFixture(page, fixture, {
      cardIds: async (route) => {
        await route.fulfill({ status: 404, body: 'not found' })
      },
    })
    expectIndexUnavailable(result, 'card-ids.json or embeddings.bin fetch failed')
  })

  test('embeddings.bin fetch fails (card-ids.json fine) — partially available generation', async ({
    page,
  }) => {
    const fixture = buildFixture()
    const result = await loadWorkerAgainstFixture(page, fixture, {
      embeddings: async (route) => {
        await route.fulfill({ status: 500, body: 'server error' })
      },
    })
    expectIndexUnavailable(result, 'card-ids.json or embeddings.bin fetch failed')
  })

  test('content-id mismatch — served bytes do not hash to the URL they were published under', async ({
    page,
  }) => {
    const fixture = buildFixture({ corruptServedEmbeddingsAfterHashing: true })
    const result = await loadWorkerAgainstFixture(page, fixture)
    expectIndexUnavailable(result, 'content id mismatch')
  })

  test('embeddings.bin runtime checksum mismatch (manifest declares a wrong embeddingsSha256, content-id otherwise consistent)', async ({
    page,
  }) => {
    const fixture = buildFixture({ wrongDeclaredChecksum: true })
    const result = await loadWorkerAgainstFixture(page, fixture)
    expectIndexUnavailable(result, 'runtime checksum mismatch')
  })

  test('explicit schema partially declared — schemaVersion present without payloadFormat/prototypesPerCard', async ({
    page,
  }) => {
    const fixture = buildFixture({ schemaVersion: 2 })
    const result = await loadWorkerAgainstFixture(page, fixture)
    expectIndexUnavailable(result, 'not all three')
  })

  test('prototypesPerCard > 1 declared without prototypeStrategy/prototypeStrategyVersion', async ({
    page,
  }) => {
    const fixture = buildFixture({
      schemaVersion: 2,
      payloadFormat: 'multi-prototype-v2',
      prototypesPerCard: 2,
    })
    const result = await loadWorkerAgainstFixture(page, fixture)
    expectIndexUnavailable(result, 'prototypestrategy')
  })

  test('coverage invariant violation — cardsIndexed exceeds totalCanonicalCards (the historical 1224/1000 shape)', async ({
    page,
  }) => {
    const fixture = buildFixture({
      cardCount: 5,
      coverageOverride: { totalCanonicalCards: 3, cardsWithUsableImage: 5, cardsIndexed: 5 },
    })
    const result = await loadWorkerAgainstFixture(page, fixture)
    expectIndexUnavailable(result, 'impossible coverage')
  })

  test('a genuinely valid LEGACY_V1 synthetic generation loads successfully end to end (legacy control case)', async ({
    page,
  }) => {
    const fixture = buildFixture({ cardCount: 4 })
    const result = await loadWorkerAgainstFixture(page, fixture)
    expect(result.type).toBe('ready')
    expect(result.indexAvailable).toBe(true)
    expect(result.indexLoad).toBe('success')
    expect(result.cardCount).toBe(4)
    expect(result.indexUnavailableReason ?? null).toBeNull()
    expect(result.indexSchemaVersion).toBe(1)
    expect(result.indexPrototypesPerCard).toBe(1)
  })

  // P115 §7 — this file was originally written against P113's own base checkpoint, before the
  // hosted-final P112 dual-prototype (schemaVersion=2/multi-prototype-v2/prototypesPerCard=2)
  // index shipped. The scenarios above already exercise several v2-shaped manifests (partial
  // schema, missing prototypeStrategy) but the file had NO fault case isolating a bad
  // prototypesPerCard value or a declared-vs-served row-count disagreement, and no control case
  // proving a genuinely valid v2/dual-prototype generation (matching the real shipped shape, not
  // just LEGACY_V1) loads successfully. Both matrices now exist side by side so this file cannot
  // regress into legacy-only coverage as the shipped index format moves on.
  test.describe('v2 (multi-prototype) fault matrix — same real worker, current shipped schema shape', () => {
    test('missing prototypesPerCard — schemaVersion/payloadFormat present, prototypesPerCard absent', async ({
      page,
    }) => {
      const fixture = buildFixture({ schemaVersion: 2, payloadFormat: 'multi-prototype-v2' })
      const result = await loadWorkerAgainstFixture(page, fixture)
      expectIndexUnavailable(result, 'not all three')
    })

    test('wrong prototypesPerCard — declared as a non-positive value', async ({ page }) => {
      const fixture = buildFixture({
        schemaVersion: 2,
        payloadFormat: 'multi-prototype-v2',
        prototypesPerCard: 0,
      })
      const result = await loadWorkerAgainstFixture(page, fixture)
      expectIndexUnavailable(result, 'invalid prototypesPerCard')
    })

    test('wrong payloadFormat — recognized schemaVersion, unrecognized payloadFormat string', async ({
      page,
    }) => {
      const fixture = buildFixture({
        schemaVersion: 2,
        payloadFormat: 'from-a-different-future-v3',
        prototypesPerCard: 1,
      })
      const result = await loadWorkerAgainstFixture(page, fixture)
      expectIndexUnavailable(result, 'unrecognized payloadformat')
    })

    test('odd prototype row count — embeddings.bin has one row fewer than cardCount x prototypesPerCard implies', async ({
      page,
    }) => {
      const fixture = buildFixture({
        cardCount: 3,
        schemaVersion: 2,
        payloadFormat: 'multi-prototype-v2',
        prototypesPerCard: 2,
        prototypeStrategy: 'pristinePlus1Aux',
        prototypeStrategyVersion: 'v1',
        embeddingsRowCountOverride: 5, // natural = 3 * 2 = 6
      })
      const result = await loadWorkerAgainstFixture(page, fixture)
      expectIndexUnavailable(result, 'embeddings buffer has')
    })

    test('card count vs prototype count mismatch — manifest.rowCount disagrees with cardCount x prototypesPerCard', async ({
      page,
    }) => {
      const fixture = buildFixture({
        cardCount: 4,
        schemaVersion: 2,
        payloadFormat: 'multi-prototype-v2',
        prototypesPerCard: 2,
        prototypeStrategy: 'pristinePlus1Aux',
        prototypeStrategyVersion: 'v1',
        manifestRowCountOverride: 7, // natural = 4 * 2 = 8, embeddings buffer itself IS 8 rows
      })
      const result = await loadWorkerAgainstFixture(page, fixture)
      expectIndexUnavailable(result, 'declares rowcount=7')
    })

    test('truncated second prototype — a genuinely dual-prototype generation missing exactly one card worth of trailing rows', async ({
      page,
    }) => {
      const fixture = buildFixture({
        cardCount: 2,
        schemaVersion: 2,
        payloadFormat: 'multi-prototype-v2',
        prototypesPerCard: 2,
        prototypeStrategy: 'pristinePlus1Aux',
        prototypeStrategyVersion: 'v1',
        embeddingsRowCountOverride: 3, // natural = 2 * 2 = 4 — second card's aux prototype missing
      })
      const result = await loadWorkerAgainstFixture(page, fixture)
      expectIndexUnavailable(result, 'embeddings buffer has')
    })

    test('a genuinely valid v2/dual-prototype synthetic generation loads successfully end to end (v2 control case, matches the real shipped shape)', async ({
      page,
    }) => {
      const fixture = buildFixture({
        cardCount: 5,
        schemaVersion: 2,
        payloadFormat: 'multi-prototype-v2',
        prototypesPerCard: 2,
        prototypeStrategy: 'pristinePlus1Aux',
        prototypeStrategyVersion: 'v1',
      })
      const result = await loadWorkerAgainstFixture(page, fixture)
      expect(result.type).toBe('ready')
      expect(result.indexAvailable).toBe(true)
      expect(result.indexLoad).toBe('success')
      expect(result.cardCount).toBe(5)
      expect(result.indexUnavailableReason ?? null).toBeNull()
      expect(result.indexSchemaVersion).toBe(2)
      expect(result.indexPayloadFormat).toBe('multi-prototype-v2')
      expect(result.indexPrototypesPerCard).toBe(2)
      expect(result.indexRowCount).toBe(10)
    })
  })
})
