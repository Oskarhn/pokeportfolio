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

let headersFile
let swFile
let redirectsFile
let buildMetaFile
let notFoundFile
try {
  headersFile = readFileSync(join(dist, '_headers'), 'utf8')
  swFile = readFileSync(join(dist, 'sw.js'), 'utf8')
  redirectsFile = readFileSync(join(dist, '_redirects'), 'utf8')
  buildMetaFile = readFileSync(join(dist, 'build-meta.json'), 'utf8')
  notFoundFile = readFileSync(join(dist, 'missing-asset.html'), 'utf8')
} catch {
  console.error(
    'dist/_headers, dist/sw.js, dist/_redirects, dist/build-meta.json or ' +
      'dist/missing-asset.html not found — run `pnpm build` first.',
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

  // Shape check always; exact-value check when the expected project is known.
  const connectShapeOk =
    connectSrc.length === 3 &&
    connectSrc[0] === "'self'" &&
    /^https:\/\/.+\.supabase\.co$/.test(connectSrc[1] ?? '') &&
    connectSrc[2] === (connectSrc[1] ?? '').replace(/^http/, 'ws')
  record(
    'connect-src keeps the exact three-token shape (self + project + realtime)',
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

  // P81 §8/§9: scanner assets are version-pinned (v7, visual-v1) and the visual worker verifies
  // EXPECTED_MODEL_REVISION on top of that — safe to cache aggressively, and Cloudflare Pages'
  // own default for non-content-hashed filenames (max-age=0, must-revalidate, confirmed live) is
  // NOT that, so this must be an explicit rule, not an assumption.
  const scannerAssetsBlockIndex = headersFile.indexOf('/scanner-assets/*')
  const scannerAssetsCacheControl =
    scannerAssetsBlockIndex === -1
      ? null
      : /Cache-Control:\s*(.+)/.exec(headersFile.slice(scannerAssetsBlockIndex))?.[1]?.trim()
  record(
    'a dedicated /scanner-assets/* block sets a long-lived immutable Cache-Control',
    scannerAssetsCacheControl !== null &&
      scannerAssetsCacheControl !== undefined &&
      /max-age=31536000/.test(scannerAssetsCacheControl) &&
      /immutable/.test(scannerAssetsCacheControl),
    scannerAssetsCacheControl ?? '(no /scanner-assets/* block found)',
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
}

// ── dist/_redirects, dist/build-meta.json, dist/missing-asset.html (P83, D-100) ──────────────────
{
  const lines = redirectsFile
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
  const assetDirectories = ['/assets/*', '/scanner-assets/*']
  const assetLines = lines.filter((line) =>
    assetDirectories.some((dir) => line.startsWith(`${dir}  `)),
  )
  const catchAllIndex = lines.findIndex((line) => line.startsWith('/*  '))

  record(
    // A real dist/404.html regressed EVERY navigation route to a bare 404 on the live preview
    // (deployment-check.mjs's /login|/invite|/admin checks caught it) — Cloudflare's own
    // top-level-404.html detection disables the automatic SPA rewrite project-wide, ahead of and
    // independent of whatever _redirects says. Pinned here so this exact regression cannot ship
    // again without a fast local failure.
    'dist/404.html does NOT exist (it would disable the SPA fallback for every real route)',
    !existsSync(join(dist, '404.html')),
    existsSync(join(dist, '404.html')) ? 'dist/404.html is present' : 'absent, as required',
  )
  record(
    // A mid-pattern splat (`/*.js`) was tried first — accepted by the file-format parser but
    // never actually matched anything on Cloudflare (splats only work at the end of a path,
    // "/blog/*"-style); a missing chunk kept falling through to the plain SPA catch-all exactly
    // like before this file existed. Directory-prefix rules avoid that failure mode entirely.
    '_redirects defines a real-404 rule for both build-artifact directories, trailing-splat style',
    assetDirectories.every((dir) => assetLines.some((line) => line.startsWith(`${dir}  `))),
    assetLines.join(' | ') || '(none)',
  )
  record(
    'every asset-directory rule in _redirects targets missing-asset.html at 404, before the SPA catch-all',
    catchAllIndex > -1 &&
      assetLines.every((line) => /\/missing-asset\.html\s+404\s*$/.test(line)) &&
      assetLines.every((line) => lines.indexOf(line) < catchAllIndex),
    `catch-all at line ${String(catchAllIndex)}`,
  )
  record(
    '_redirects still falls back real navigation paths to index.html at 200',
    catchAllIndex > -1 && /\/index\.html\s+200\s*$/.test(lines[catchAllIndex] ?? ''),
    lines[catchAllIndex] ?? '(no catch-all found)',
  )

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
  record(
    'missing-asset.html exists as a real (non-app-shell) error page — never the SPA index.html content',
    notFoundFile.length > 0 && !notFoundFile.includes('id="root"'),
    `${String(notFoundFile.length)} bytes`,
  )
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log(`FAILED: ${failed.map((r) => r.name).join(', ')}`)
  process.exitCode = 1
}
