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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

let headersFile
let swFile
try {
  headersFile = readFileSync(join(dist, '_headers'), 'utf8')
  swFile = readFileSync(join(dist, 'sw.js'), 'utf8')
} catch {
  console.error('dist/_headers or dist/sw.js not found — run `pnpm build` first.')
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

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log(`FAILED: ${failed.map((r) => r.name).join(', ')}`)
  process.exitCode = 1
}
