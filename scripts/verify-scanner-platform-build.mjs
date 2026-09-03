/**
 * Post-build artefact gate for the M15 scanner platform delta — the local twin of the live checks
 * in `deployment-check.mjs`. Where that script verifies what Cloudflare actually serves, this one
 * verifies what `pnpm build` actually produced in `dist/`: the generated `_headers` and the
 * generated service worker. A configuration can be right in vite.config.ts and wrong in the
 * artefact (workbox version drift changes what gets serialized); only the artefact is shipped.
 *
 * Usage (PowerShell), after a production build:
 *
 *   node scripts/verify-scanner-platform-build.mjs
 *
 * Optional environment: SUPABASE_URL — when set, the generated connect-src must equal exactly
 * `self` + that project's origin + its realtime endpoint. Without it the connect-src shape is
 * still asserted structurally.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

const ASSET_FALLBACK_DIRECTORIES = ['assets', 'scanner-assets']

let headersFile
let swFile
let buildMetaFile
let assetNotFoundFiles
try {
  headersFile = readFileSync(join(dist, '_headers'), 'utf8')
  swFile = readFileSync(join(dist, 'sw.js'), 'utf8')
  buildMetaFile = readFileSync(join(dist, 'build-meta.json'), 'utf8')
  assetNotFoundFiles = ASSET_FALLBACK_DIRECTORIES.map((dir) =>
    readFileSync(join(dist, dir, '404.html'), 'utf8'),
  )
} catch {
  console.error(
    'dist/_headers, dist/sw.js, dist/build-meta.json, or one of dist/{assets,scanner-assets}/' +
      '404.html not found — run `pnpm build` first.',
  )
  process.exit(1)
}

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Token-level CSP parsing (see deployment-check.mjs — substring tests cannot distinguish
 * `'wasm-unsafe-eval'` from `'unsafe-eval'`). */
function cspDirectives(csp) {
  const directives = new Map()
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    directives.set(tokens[0], tokens.slice(1))
  }
  return directives
}

// ── dist/_headers ──────────────────────────────────────────────────────────────────────────────
{
  const cspLine = headersFile
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('Content-Security-Policy:'))
  const csp = cspLine?.slice('Content-Security-Policy:'.length).trim() ?? ''
  const directives = cspDirectives(csp)
  const scriptSrc = directives.get('script-src') ?? []
  const workerSrc = directives.get('worker-src') ?? []
  const connectSrc = directives.get('connect-src') ?? []

  record(
    "_headers carries a Content-Security-Policy granting 'wasm-unsafe-eval'",
    scriptSrc.includes("'wasm-unsafe-eval'"),
    scriptSrc.join(' ') || '(none)',
  )
  record(
    'and never grants JavaScript eval, inline script or data: in script-src',
    !scriptSrc.some((t) => ["'unsafe-eval'", "'unsafe-inline'", 'data:'].includes(t)),
    scriptSrc.join(' ') || '(none)',
  )
  record(
    // P78, D-097 addendum: onnxruntime-web's WASM factory dynamically imports its own glue
    // module from a blob: object URL — without this token the visual model fails to load on
    // every browser, confirmed by direct reproduction (not a threading/cross-origin-isolation
    // issue).
    "grants 'blob:' for onnxruntime-web's dynamic-import WASM loader",
    scriptSrc.includes('blob:'),
    scriptSrc.join(' ') || '(none)',
  )
  record(
    "worker-src remains exactly 'self'",
    JSON.stringify(workerSrc) === JSON.stringify(["'self'"]),
    workerSrc.join(' ') || '(none)',
  )

  // P90 §14: LOCAL/CI PLACEHOLDER MODE vs HOSTED BUILD MODE — mirrors
  // src/domain/scanner/checkpoint-identity.ts's own LOCAL_SUPABASE_URL constant (duplicated here
  // deliberately, same precedent as visual-worker.ts's EXPECTED_MODEL_REVISION: this script has no
  // TS import machinery for src/). A build made against the well-known local/CI placeholder origin
  // (every `pnpm build`/CI `build-and-test` run that never exported a real SUPABASE_URL) has no
  // real hosted project to enforce HTTPS/*.supabase.co against — treating that as a security
  // FAILURE was never correct (P87 disclosed this exact false failure: "23/24 ... requires a real
  // https://*.supabase.co URL"). A HOSTED build (anything else) still enforces the real shape in
  // full, with no local exception.
  const LOCAL_SUPABASE_ORIGIN = 'http://127.0.0.1:54321'
  const connectOrigin = connectSrc[1] ?? ''
  const isLocalOrPlaceholderBuild = connectOrigin === LOCAL_SUPABASE_ORIGIN
  const buildMode = isLocalOrPlaceholderBuild ? 'LOCAL/CI PLACEHOLDER' : 'HOSTED'
  console.log(`\nPlatform verifier build mode: ${buildMode} (connect-src origin: ${connectOrigin || '(none)'})\n`)

  const connectShapeOk = isLocalOrPlaceholderBuild
    ? // Local mode: still require the real 3-token self+project+realtime SHAPE (never a missing or
      // malformed connect-src) — just not the HTTPS/*.supabase.co project-origin requirement,
      // which a local Supabase stack genuinely cannot satisfy.
      connectSrc.length === 3 &&
      connectSrc[0] === "'self'" &&
      connectOrigin === LOCAL_SUPABASE_ORIGIN &&
      connectSrc[2] === connectOrigin.replace(/^http/, 'ws')
    : connectSrc.length === 3 &&
      connectSrc[0] === "'self'" &&
      /^https:\/\/.+\.supabase\.co$/.test(connectOrigin) &&
      connectSrc[2] === connectOrigin.replace(/^http/, 'ws')
  record(
    `connect-src keeps the exact three-token shape (self + project + realtime) [${buildMode} mode]`,
    connectShapeOk,
    connectSrc.join(' ') || '(none)',
  )

  const supabaseUrl = process.env.SUPABASE_URL
  if (supabaseUrl) {
    const expected = JSON.stringify([
      "'self'",
      new URL(supabaseUrl).origin,
      new URL(supabaseUrl).origin.replace(/^http/, 'ws'),
    ])
    record(
      'connect-src names exactly the expected Supabase project',
      JSON.stringify(connectSrc) === expected,
      `${connectSrc.join(' ') || '(none)'}`,
    )
  }

  record(
    'Permissions-Policy does not weaken camera access (camera stays unrestricted)',
    !/camera\s*=/.test(headersFile),
    /Permissions-Policy:.*/.exec(headersFile)?.[0] ?? '(none)',
  )

  // P81 §8/§9: scanner ENGINE assets (OCR v7, the pinned DINOv2 model + onnxruntime-web WASM) are
  // version-pinned and content-stable — safe to cache aggressively, and Cloudflare Pages' own
  // default for non-content-hashed filenames (max-age=0, must-revalidate, confirmed live) is NOT
  // that, so each must be an explicit rule.
  function cacheControlFor(blockPath) {
    const blockIndex = headersFile.indexOf(blockPath)
    return blockIndex === -1
      ? null
      : /Cache-Control:\s*(.+)/.exec(headersFile.slice(blockIndex))?.[1]?.trim()
  }
  const immutable = (cc) =>
    cc !== null && cc !== undefined && /max-age=31536000/.test(cc) && /immutable/.test(cc)

  for (const enginePath of [
    '/scanner-assets/v7/*',
    '/scanner-assets/visual-v1/model/*',
    '/scanner-assets/visual-v1/ort/*',
  ]) {
    record(
      `a dedicated ${enginePath} block sets a long-lived immutable Cache-Control`,
      immutable(cacheControlFor(enginePath)),
      cacheControlFor(enginePath) ?? `(no ${enginePath} block found)`,
    )
  }

  // P87 F-01: the visual INDEX (data, rebuilt independently of the model) is now published
  // content-addressed under .../index/generations/<contentId>/ — genuinely safe to be immutable,
  // since a new generation is a new URL rather than mutated content at a fixed one.
  record(
    'a dedicated /scanner-assets/visual-v1/index/generations/* block sets a long-lived immutable Cache-Control',
    immutable(cacheControlFor('/scanner-assets/visual-v1/index/generations/*')),
    cacheControlFor('/scanner-assets/visual-v1/index/generations/*') ?? '(no block found)',
  )
  // The bootstrap pointer must revalidate, never be cached immutably — this is the exact bug
  // (F-01) this whole restructure fixes, so it is pinned here as a build-artifact-level gate, not
  // just a source-level test.
  const currentJsonCacheControl = cacheControlFor('/scanner-assets/visual-v1/index/current.json')
  record(
    '/scanner-assets/visual-v1/index/current.json revalidates (no-cache), never immutable',
    currentJsonCacheControl !== null &&
      currentJsonCacheControl !== undefined &&
      /no-cache/.test(currentJsonCacheControl) &&
      !/immutable/.test(currentJsonCacheControl),
    currentJsonCacheControl ?? '(no current.json block found)',
  )
}

// ── dist/sw.js ─────────────────────────────────────────────────────────────────────────────────
{
  const precacheEntries = swFile.match(/\{url:"[^"]+"/g) ?? []
  const entryUrls = precacheEntries.map((entry) => entry.slice('{url:"'.length, -1))

  record(
    'scanner assets are absent from the precache manifest',
    !entryUrls.some((url) => url.includes('scanner-assets')),
    `${entryUrls.filter((url) => url.includes('scanner-assets')).length} scanner entries`,
  )
  record(
    'the app shell is still precached (index.html plus hashed JS chunks)',
    entryUrls.some((url) => url === 'index.html') &&
      entryUrls.some((url) => /^assets\/.+\.js$/.test(url)),
    `${entryUrls.length} entries`,
  )

  // The generated route source embeds the escaped path (`scanner-assets\/v7`); accept either
  // spelling so a workbox serialization change cannot silently void the check.
  const scannerRoutePresent =
    (swFile.includes('scanner-assets\\/v7') || swFile.includes('/scanner-assets/v7/')) &&
    /CacheFirst/.test(swFile)
  record(
    'a CacheFirst runtime rule exists for /scanner-assets/v7/',
    scannerRoutePresent,
    /registerRoute\([^)]*scanner-assets[^)]*\)/.exec(swFile)?.[0]?.slice(0, 120) ??
      (swFile.includes('CacheFirst') ? 'CacheFirst without scanner scope' : '(no CacheFirst)'),
  )
  record(
    "the v7 cache is named 'scanner-assets-v7'",
    swFile.includes('scanner-assets-v7'),
    '(cacheName)',
  )

  const dangerousStrategies = ['NetworkFirst', 'StaleWhileRevalidate', 'CacheOnly'].filter((s) =>
    swFile.includes(s),
  )
  record(
    'no network-first style runtime strategy exists in the worker',
    dangerousStrategies.length === 0,
    dangerousStrategies.length ? dangerousStrategies.join(', ') : 'none',
  )

  // P87 F-01/F-42: the visual model/engine runtime cache and the content-addressed index-
  // generation runtime cache are separate named caches — an index-generation rebuild must never
  // require bumping the model cache's name, and vice versa.
  record(
    "the visual model/engine cache is named 'scanner-assets-visual-v1'",
    swFile.includes('scanner-assets-visual-v1'),
    '(cacheName)',
  )
  record(
    "the visual index-generation cache is named 'scanner-assets-visual-v1-index'",
    swFile.includes('scanner-assets-visual-v1-index'),
    '(cacheName)',
  )
  // The bootstrap pointer (current.json) must never be interceptable by a CacheFirst Workbox
  // route — the whole point of F-01's fix is that it always reaches the network/HTTP-cache layer
  // (governed by its own no-cache header + the worker's `cache: 'no-store'` fetch) rather than
  // being answered from Cache Storage by a route that can never learn about a newer generation.
  record(
    'no runtime-caching route pattern in the worker matches .../index/current.json',
    !swFile.includes('current\\\\.json') && !/index\/current\.json/.test(swFile),
    '(current.json must be absent from every registerRoute pattern)',
  )
}

// ── dist/{assets,scanner-assets}/404.html, dist/build-meta.json (P83, D-100) ──────────────────────
{
  record(
    // A real TOP-LEVEL dist/404.html regressed EVERY navigation route to a bare 404 on the live
    // preview (deployment-check.mjs's /login|/invite|/admin checks caught it) — Cloudflare's own
    // top-level-404.html detection disables the automatic SPA rewrite project-wide. A NESTED
    // 404.html (dist/assets/404.html etc, Cloudflare's own documented directory-tree 404 lookup)
    // does not have this problem. Pinned here so this exact regression cannot ship again.
    'dist/404.html does NOT exist at the project ROOT (only nested, per-directory copies)',
    !existsSync(join(dist, '404.html')),
    existsSync(join(dist, '404.html')) ? 'dist/404.html is present' : 'absent, as required',
  )
  ASSET_FALLBACK_DIRECTORIES.forEach((dir, i) => {
    record(
      // A `_redirects` rule targeting status 404 was tried first — Cloudflare Pages' `_redirects`
      // does not support arbitrary rewrite status codes at all (only 200 and the 30x redirect
      // codes), so every such rule was silently skipped as malformed. A nested 404.html is
      // Cloudflare's own genuinely-supported mechanism for a real, directory-scoped 404.
      `dist/${dir}/404.html exists as a real (non-app-shell) error page`,
      assetNotFoundFiles[i].length > 0 && !assetNotFoundFiles[i].includes('id="root"'),
      `${String(assetNotFoundFiles[i].length)} bytes`,
    )
  })

  let buildMeta = null
  try {
    buildMeta = JSON.parse(buildMetaFile)
  } catch {
    buildMeta = null
  }
  record(
    'build-meta.json is valid JSON carrying a non-empty commit sha',
    buildMeta !== null && typeof buildMeta.sha === 'string' && buildMeta.sha.length > 0,
    buildMeta ? JSON.stringify(buildMeta) : '(invalid JSON)',
  )
  record(
    '/build-meta.json is marked no-store in _headers, never HTTP-cached',
    /\/build-meta\.json\s*\n\s*Cache-Control:\s*no-store/.test(headersFile),
    /\/build-meta\.json[\s\S]{0,60}/.exec(headersFile)?.[0] ?? '(no rule found)',
  )
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log(`FAILED: ${failed.map((r) => r.name).join(', ')}`)
  process.exitCode = 1
}
