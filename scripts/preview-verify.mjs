#!/usr/bin/env node
/**
 * P118 §21 — a single command that verifies a real deployment (a Cloudflare Pages PREVIEW build,
 * once preview deployments are turned on — see docs/DEVELOPMENT.md for current status — or
 * production) against an expected git SHA, and exits non-zero if any required gate fails.
 *
 * This is deliberately NOT a rewrite of `deployment-check.mjs` (which already owns CSP/security-
 * header/PWA/secret-leak checks and stays the authoritative source for those — this script does
 * not duplicate them). This script owns the checks that script does not: build-identity-vs-an-
 * EXPECTED-SHA, the scanner visual index's live content-addressed shape, model/OCR asset
 * reachability, static-vs-navigation fallback behavior, and a light analytics/third-party-endpoint
 * sweep. Run both for full coverage.
 *
 * Usage (PowerShell):
 *
 *   node scripts/preview-verify.mjs --url https://<preview-id>.pokeportfolio-dev.pages.dev --sha <40-char-sha>
 *
 * Optional:
 *   --content-id <hex>      expected scanner index content id (default: the id shipped as of
 *                            P118, f25fc05d569b7cca — pass the current one once the index rotates)
 *   --json <path>            also write the machine-readable result to this file
 *   --timeout-ms <n>         per-request timeout (default 15000)
 *   --skip <name,name,...>   skip named checks (comma-separated group names, see GROUPS below)
 *
 * Every network call is timed out (AbortSignal.timeout) so this never hangs — a check that can't
 * complete is recorded FAIL with the timeout reason, not left spinning.
 *
 * No credential of any kind is used — public HTTP responses only, exactly like
 * deployment-check.mjs/remote-security-check.mjs, so this can run from anywhere against any URL.
 */
import { writeFileSync } from 'node:fs'
import { verifyLiveCspHash } from './lib/live-csp-hash-verify.mjs'

const args = process.argv.slice(2)
function argValue(name) {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
function hasFlag(name) {
  return args.includes(`--${name}`)
}

const site = (argValue('url') ?? process.env.DEPLOYMENT_URL ?? '').replace(/\/+$/, '')
const expectedSha = argValue('sha') ?? process.env.EXPECTED_SHA
const expectedContentId = argValue('content-id') ?? 'f25fc05d569b7cca'
const timeoutMs = Number(argValue('timeout-ms') ?? 15000)
const jsonOutPath = argValue('json')
const skipGroups = new Set((argValue('skip') ?? '').split(',').filter(Boolean))

if (hasFlag('help') || !site) {
  console.log(
    'Usage: node scripts/preview-verify.mjs --url <deployment-url> --sha <expected-git-sha> ' +
      '[--content-id <hex>] [--json <path>] [--timeout-ms <n>] [--skip <group,group>]',
  )
  process.exit(site ? 0 : 1)
}

/** @type {{ group: string, name: string, pass: boolean, detail: string }[]} */
const results = []
function record(group, name, pass, detail = '') {
  results.push({ group, name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail ? ` — ${detail}` : ''}`)
}
function skipRecord(group, name, reason) {
  results.push({ group, name, pass: true, detail: `SKIPPED — ${reason}`, skipped: true })
  console.log(`SKIP  [${group}] ${name} — ${reason}`)
}

async function get(path, opts = {}) {
  try {
    const response = await fetch(`${site}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      ...opts,
    })
    const text = opts.noBody ? '' : await response.text()
    return { ok: true, status: response.status, headers: response.headers, text }
  } catch (error) {
    return { ok: false, status: 0, headers: new Headers(), text: '', error: String(error) }
  }
}

async function head(path) {
  try {
    const response = await fetch(`${site}${path}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { ok: true, status: response.status, headers: response.headers }
  } catch (error) {
    // Some CDNs/dev servers reject HEAD outright — fall back to a byte-range GET rather than
    // failing a reachability check over an unrelated HTTP-method quirk.
    try {
      const response = await fetch(`${site}${path}`, {
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      return { ok: true, status: response.status, headers: response.headers }
    } catch (error2) {
      return { ok: false, status: 0, headers: new Headers(), error: String(error2 ?? error) }
    }
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

console.log(`\n— preview-verify: ${site} —`)
if (expectedSha) console.log(`expected SHA: ${expectedSha}`)
console.log(`expected scanner index content id: ${expectedContentId}\n`)

// ── 1. Build identity ────────────────────────────────────────────────────────────────────────
let bundleText = ''
if (!skipGroups.has('build-identity')) {
  const index = await get('/')
  record(
    'build-identity',
    'the site serves an application shell',
    index.status === 200,
    `HTTP ${index.status}`,
  )

  const bundlePath = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(index.text)?.[0]
  record(
    'build-identity',
    'index.html references a hashed entry bundle',
    Boolean(bundlePath),
    bundlePath ?? '(none)',
  )

  if (bundlePath) {
    const asset = await get(`/${bundlePath}`)
    bundleText = asset.text
    record(
      'build-identity',
      'the entry bundle is served',
      asset.status === 200,
      `HTTP ${asset.status}`,
    )

    if (expectedSha) {
      const found = bundleText.includes(expectedSha)
      record(
        'build-identity',
        'APP_BUILD_SHA embedded in the entry bundle matches --sha',
        found,
        found ? 'match' : `expected SHA not found in bundle`,
      )
    } else {
      skipRecord('build-identity', 'APP_BUILD_SHA matches --sha', 'no --sha given')
    }
  }

  const buildMeta = await get('/build-meta.json')
  record(
    'build-identity',
    'build-meta.json is served',
    buildMeta.status === 200,
    `HTTP ${buildMeta.status}`,
  )
  if (buildMeta.status === 200) {
    let parsed = null
    try {
      parsed = JSON.parse(buildMeta.text)
    } catch {
      parsed = null
    }
    record(
      'build-identity',
      'build-meta.json is valid JSON with a sha field',
      Boolean(parsed?.sha),
      JSON.stringify(parsed),
    )
    if (expectedSha && parsed) {
      record(
        'build-identity',
        'build-meta.json sha matches --sha',
        parsed.sha === expectedSha,
        `got ${parsed.sha}`,
      )
      if (bundleText && typeof parsed.sha === 'string') {
        // The two independent build-identity mechanisms (P83's baked-in __APP_BUILD_SHA__ and the
        // separately-emitted build-meta.json) must never disagree with each other, regardless of
        // whether either matches --sha — a real desync here would mean this deployment's own two
        // sources of truth about its own identity contradict each other. Plain substring search
        // (never a RegExp built from `parsed.sha`) — the value can legitimately contain a literal
        // `+dirty` suffix, which is regex-metacharacter-shaped and must be matched literally.
        const agree = bundleText.includes(parsed.sha)
        record(
          'build-identity',
          'baked-in APP_BUILD_SHA and build-meta.json sha agree with each other',
          agree,
          agree ? 'agree' : "the bundle does not contain build-meta.json's own sha",
        )
      }
    } else if (!expectedSha) {
      skipRecord('build-identity', 'build-meta.json sha matches --sha', 'no --sha given')
    }
  }
} else {
  skipRecord('build-identity', 'all build-identity checks', '--skip build-identity')
}

// ── 2. Scanner visual index (content-addressed) ──────────────────────────────────────────────
if (!skipGroups.has('scanner-index')) {
  const current = await get('/scanner-assets/visual-v1/index/current.json')
  record(
    'scanner-index',
    'current.json (pointer) is served',
    current.status === 200,
    `HTTP ${current.status}`,
  )

  const cacheControl = (current.headers.get('cache-control') ?? '').toLowerCase()
  record(
    'scanner-index',
    'current.json revalidates (no-cache/must-revalidate/max-age=0), never long-lived-cached',
    /no-cache|must-revalidate|max-age=0/.test(cacheControl),
    cacheControl || '(no cache-control header)',
  )

  let pointer = null
  try {
    pointer = JSON.parse(current.text)
  } catch {
    pointer = null
  }
  record(
    'scanner-index',
    'current.json parses and names a contentId',
    Boolean(pointer?.contentId),
    JSON.stringify(pointer),
  )
  if (pointer?.contentId) {
    record(
      'scanner-index',
      `content id matches expected (${expectedContentId})`,
      pointer.contentId === expectedContentId,
      `got ${pointer.contentId}`,
    )
  }

  const genPath = pointer?.contentId
    ? `/scanner-assets/visual-v1/index/generations/${pointer.contentId}`
    : `/scanner-assets/visual-v1/index/generations/${expectedContentId}`

  const manifest = await get(`${genPath}/manifest.json`)
  record(
    'scanner-index',
    'manifest.json is served',
    manifest.status === 200,
    `HTTP ${manifest.status}`,
  )
  let manifestJson = null
  try {
    manifestJson = JSON.parse(manifest.text)
  } catch {
    manifestJson = null
  }
  record(
    'scanner-index',
    'manifest schemaVersion is 2',
    manifestJson?.schemaVersion === 2,
    `got ${manifestJson?.schemaVersion}`,
  )
  record(
    'scanner-index',
    'manifest payloadFormat is multi-prototype-v2',
    manifestJson?.payloadFormat === 'multi-prototype-v2',
    `got ${manifestJson?.payloadFormat}`,
  )
  record(
    'scanner-index',
    'manifest prototypesPerCard is 2',
    manifestJson?.prototypesPerCard === 2,
    `got ${manifestJson?.prototypesPerCard}`,
  )

  const cardIds = await head(`${genPath}/card-ids.json`)
  record(
    'scanner-index',
    'card-ids.json is reachable',
    cardIds.status === 200,
    `HTTP ${cardIds.status}`,
  )
  const embeddings = await head(`${genPath}/embeddings.bin`)
  record(
    'scanner-index',
    'embeddings.bin is reachable',
    embeddings.status === 200,
    `HTTP ${embeddings.status}`,
  )
} else {
  skipRecord('scanner-index', 'all scanner-index checks', '--skip scanner-index')
}

// ── 3. Model/OCR asset reachability ──────────────────────────────────────────────────────────
if (!skipGroups.has('model-assets')) {
  const dinoAssets = [
    '/scanner-assets/visual-v1/model/config.json',
    '/scanner-assets/visual-v1/model/preprocessor_config.json',
    '/scanner-assets/visual-v1/model/onnx/model_quantized.onnx',
  ]
  for (const path of dinoAssets) {
    const r = await head(path)
    record('model-assets', `DINO asset reachable: ${path}`, r.status === 200, `HTTP ${r.status}`)
  }

  const safariOrt = [
    '/scanner-assets/visual-v1/ort/ort-wasm-simd-threaded.mjs',
    '/scanner-assets/visual-v1/ort/ort-wasm-simd-threaded.wasm',
  ]
  for (const path of safariOrt) {
    const r = await head(path)
    record(
      'model-assets',
      `Safari ORT WASM asset reachable: ${path}`,
      r.status === 200,
      `HTTP ${r.status}`,
    )
  }

  const nonSafariOrt = [
    '/scanner-assets/visual-v1/ort/ort-wasm-simd-threaded.asyncify.mjs',
    '/scanner-assets/visual-v1/ort/ort-wasm-simd-threaded.asyncify.wasm',
  ]
  for (const path of nonSafariOrt) {
    const r = await head(path)
    record(
      'model-assets',
      `non-Safari ORT WASM asset reachable: ${path}`,
      r.status === 200,
      `HTTP ${r.status}`,
    )
  }

  const tesseractAssets = [
    '/scanner-assets/v7/worker.min.js',
    '/scanner-assets/v7/tesseract-core-simd-lstm.wasm',
    '/scanner-assets/v7/tesseract-core-simd-lstm.wasm.js',
    '/scanner-assets/v7/eng.traineddata.gz',
  ]
  for (const path of tesseractAssets) {
    const r = await head(path)
    record(
      'model-assets',
      `Tesseract asset reachable: ${path}`,
      r.status === 200,
      `HTTP ${r.status}`,
    )
  }
} else {
  skipRecord('model-assets', 'all model-assets checks', '--skip model-assets')
}

// ── 4. Service worker ─────────────────────────────────────────────────────────────────────────
let swText = ''
if (!skipGroups.has('service-worker')) {
  const sw = await get('/sw.js')
  swText = sw.text
  record('service-worker', 'sw.js is served', sw.status === 200, `HTTP ${sw.status}`)
  const contentType = (sw.headers.get('content-type') ?? '').toLowerCase()
  record(
    'service-worker',
    'sw.js is served as JavaScript, not HTML (the historical Safari MIME bug shape)',
    /javascript/.test(contentType),
    contentType || '(none)',
  )
  const scope = sw.headers.get('service-worker-allowed')
  record(
    'service-worker',
    'scope is root ("/") — either the default (no header) or an explicit Service-Worker-Allowed: /',
    scope === null || scope === '/',
    scope ?? '(default /, no header)',
  )
} else {
  skipRecord('service-worker', 'all service-worker checks', '--skip service-worker')
}

// ── 5. CSP: header exists AND the live inline-script hash actually matches ──────────────────────
if (!skipGroups.has('csp')) {
  const index = await get('/')
  const csp = index.headers.get('content-security-policy') ?? ''
  record(
    'csp',
    'a Content-Security-Policy header is served',
    csp.length > 0,
    csp ? `${csp.length} chars` : '(none)',
  )
  if (csp) {
    const liveCsp = verifyLiveCspHash({ html: index.text, cspHeader: csp })
    record(
      'csp',
      "the served inline bootstrap script's hash matches a source actually present in the served CSP",
      liveCsp.pass,
      liveCsp.reason,
    )
  }
} else {
  skipRecord('csp', 'all csp checks', '--skip csp')
}

// ── 6. Static asset fallback — an intentionally missing static path must be a REAL failure ───────
if (!skipGroups.has('static-fallback')) {
  const missingPaths = [
    '/assets/DefinitelyMissingChunk-preview-verify-9f3a2c.js',
    '/scanner-assets/v7/DefinitelyMissingAsset-preview-verify.wasm',
  ]
  for (const path of missingPaths) {
    const r = await get(path)
    const contentType = (r.headers.get('content-type') ?? '').toLowerCase()
    const isHtmlFallback = r.status === 200 && contentType.includes('html')
    record(
      'static-fallback',
      `missing static asset ${path} is a real failure, never a 200 text/html SPA fallback`,
      !isHtmlFallback,
      `HTTP ${r.status} · ${contentType || '(no content-type)'}`,
    )
  }
} else {
  skipRecord('static-fallback', 'all static-fallback checks', '--skip static-fallback')
}

// ── 7. Navigation fallback — an ordinary unknown APP route still gets the SPA shell ──────────────
if (!skipGroups.has('navigation-fallback')) {
  const r = await get('/this-route-does-not-exist-preview-verify')
  const contentType = (r.headers.get('content-type') ?? '').toLowerCase()
  record(
    'navigation-fallback',
    'an unknown app-level route still resolves to the SPA shell (client-side routing)',
    r.status === 200 && contentType.includes('html'),
    `HTTP ${r.status} · ${contentType || '(none)'}`,
  )
} else {
  skipRecord('navigation-fallback', 'all navigation-fallback checks', '--skip navigation-fallback')
}

// ── 8. Analytics / third-party endpoint sweep ────────────────────────────────────────────────
if (!skipGroups.has('analytics')) {
  // Fetch every same-origin JS chunk the service worker's own precache manifest names (mirrors
  // deployment-check.mjs's own asset-discovery approach) so the sweep covers lazy chunks too, not
  // just the entry bundle.
  const precachedJsPaths = [
    ...new Set((swText.match(/\{url:"(assets\/[^"]+\.js)"/g) ?? []).map((m) => m.slice(6, -1))),
  ]
  const chunks = await mapWithConcurrency(
    precachedJsPaths,
    5,
    async (path) => (await get(`/${path}`)).text,
  )
  const allJs = `${bundleText}\n${chunks.join('\n')}`

  // Denylist-based, not allowlist-based: a bundle legitimately contains many URL-shaped strings
  // that are never network endpoints at all (the SVG/XML namespace `w3.org`, React's own error
  // doc links, this project's required TradingView attribution link — D-066, license/funding
  // URLs pulled in from dependency metadata). Flagging every URL literal as "unexpected" produced
  // exactly that noise when first tried against a real build (react.dev, www.w3.org, github.com,
  // opencollective.com, cdn.jsdelivr.net, rolldown.rs — none of them a real runtime request this
  // app makes). What actually matters per this project's own privacy bar (ARCHITECTURE.md §6,
  // D-118/D-119) is that no KNOWN analytics/tracking vendor is referenced at all.
  const KNOWN_ANALYTICS_VENDORS = [
    'google-analytics.com',
    'googletagmanager.com',
    'analytics.google.com',
    'segment.io',
    'segment.com',
    'mixpanel.com',
    'amplitude.com',
    'sentry.io',
    'posthog.com',
    'hotjar.com',
    'fullstory.com',
    'doubleclick.net',
    'facebook.net',
    'connect.facebook.net',
    'clarity.ms',
    'plausible.io',
    'matomo.org',
  ]
  const urls = [...new Set(allJs.match(/https?:\/\/[a-z0-9.-]+/gi) ?? [])].map((u) =>
    u.toLowerCase(),
  )
  const analyticsHits = urls.filter((u) =>
    KNOWN_ANALYTICS_VENDORS.some((vendor) => u.includes(vendor)),
  )
  record(
    'analytics',
    'no known analytics/tracking vendor domain is referenced in any shipped chunk',
    analyticsHits.length === 0,
    analyticsHits.length ? analyticsHits.join(', ') : 'none found',
  )
  // Cloudflare Web Analytics is the one opt-in exception (off by default, gated by
  // VITE_CF_ANALYTICS_TOKEN) — informational only, never fails the check either way, since its
  // presence/absence is a deliberate owner setting, not a defect.
  const cfAnalyticsPresent = urls.some((u) => u.includes('cloudflareinsights.com'))
  console.log(
    `INFO  [analytics] Cloudflare Web Analytics beacon ${cfAnalyticsPresent ? 'IS' : 'is NOT'} referenced (opt-in, off by default)`,
  )
  console.log(
    `INFO  [analytics] all external URL-shaped strings found (informational, not asserted): ${urls.join(', ') || '(none)'}`,
  )
} else {
  skipRecord('analytics', 'all analytics checks', '--skip analytics')
}

// ── Summary ───────────────────────────────────────────────────────────────────────────────────
const meaningful = results.filter((r) => !r.skipped)
const failed = meaningful.filter((r) => !r.pass)
console.log(
  `\n${meaningful.length - failed.length}/${meaningful.length} checks passed` +
    (results.length > meaningful.length ? ` (${results.length - meaningful.length} skipped)` : ''),
)
if (failed.length) {
  console.log(`FAILED: ${failed.map((r) => `[${r.group}] ${r.name}`).join('; ')}`)
}

const summary = {
  url: site,
  expectedSha: expectedSha ?? null,
  expectedContentId,
  total: meaningful.length,
  passed: meaningful.length - failed.length,
  failed: failed.length,
  skipped: results.length - meaningful.length,
  results,
  ok: failed.length === 0,
}
console.log(`RESULT_JSON:${JSON.stringify(summary)}`)
if (jsonOutPath) {
  writeFileSync(jsonOutPath, JSON.stringify(summary, null, 2))
}

process.exitCode = failed.length ? 1 : 0
