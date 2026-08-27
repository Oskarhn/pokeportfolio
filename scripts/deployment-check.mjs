/**
 * What the deployed frontend actually serves — the Cloudflare half of the deployment gate
 * (docs/SECURITY.md §13). `remote-security-check.mjs` is the Supabase half; neither substitutes for
 * the other, because they check different machines.
 *
 * WHY IT EXISTS. The first deployment of this project went out with two transposed characters in
 * the Supabase project ref, baked into the bundle by an environment variable typed into a dashboard
 * field. Every request failed, the invite page said "Could not reach the server", and nothing
 * anywhere disagreed with anything: CI was green, the migrations were right, the Supabase project
 * was healthy. The only artefact that was wrong was the one no test had ever looked at — the
 * JavaScript actually being served to browsers.
 *
 * That is the same failure this whole checkpoint is about, one layer out. A build is not verified
 * by the fact that it built.
 *
 * Usage (PowerShell):
 *
 *   $env:DEPLOYMENT_URL = "https://pokeportfolio-dev.pages.dev"
 *   $env:SUPABASE_URL   = "https://<ref>.supabase.co"
 *   node scripts/deployment-check.mjs
 *
 * Reads nothing but public responses. No key, no session, no credential of any kind — so it can be
 * run against any environment by anyone, and there is no excuse for skipping it.
 */

const site = (process.env.DEPLOYMENT_URL ?? '').replace(/\/+$/, '')
const supabaseUrl = process.env.SUPABASE_URL
if (!site || !supabaseUrl) {
  throw new Error('DEPLOYMENT_URL and SUPABASE_URL must be set')
}
const supabaseOrigin = new URL(supabaseUrl).origin

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function get(path) {
  const response = await fetch(`${site}${path}`, { signal: AbortSignal.timeout(15000) })
  return { status: response.status, headers: response.headers, text: await response.text() }
}

/** Bounded-concurrency map (M11 harness hardening). M10's session found that bursting every
 *  precached JS chunk through one unbounded `Promise.all` (below) reliably hit a local Node/undici
 *  concurrent-connection limit against Cloudflare's edge on this machine (`ConnectTimeoutError`),
 *  even though the identical requests succeeded every time run sequentially with `curl`. A small
 *  worker pool keeps the same full coverage and the same "fetch everything, then check" shape, just
 *  never more than `limit` requests in flight at once — deterministic, no coverage reduction. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Parses a serialized Content-Security-Policy into directive-name → token arrays. Token-level,
 * because substring tests are meaningless here: `'wasm-unsafe-eval'` contains the substring
 * `unsafe-eval`, so "does NOT include 'unsafe-eval'" can only be asserted per whole token.
 */
function cspDirectives(csp) {
  const directives = new Map()
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    directives.set(tokens[0], tokens.slice(1))
  }
  return directives
}

console.log(`\n— ${site} —\n`)

// ── The shell, and the bundle it points at ───────────────────────────────────────────────────
const index = await get('/')
record('the site serves an application shell', index.status === 200, `HTTP ${index.status}`)

const bundlePath = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(index.text)?.[0]
record('index.html references a hashed bundle', Boolean(bundlePath), bundlePath ?? '(none found)')

let bundle = ''
if (bundlePath) {
  const asset = await get(`/${bundlePath}`)
  bundle = asset.text
  record('the bundle is served', asset.status === 200, `HTTP ${asset.status} · ${bundle.length} B`)
}

// M7.1 introduced route-level code splitting (React.lazy) — Search, Portfolio, holding detail
// etc. now ship as separate chunks the entry bundle never references directly, and the bundler
// also hoists shared dependencies (notably the Supabase client) into their own chunk when both an
// eager and a lazy importer use them. So "the bundle" for the checks below has to mean every JS
// asset actually shipped, not just the one entry file index.html links to — otherwise a secret or
// a wrong project id in a lazy chunk would sail through unchecked, which is a worse gap than the
// one this whole script exists to close. The service worker's precache manifest (fetched early,
// not just where the PWA checks read it below) is the one place that already lists every such
// asset, because `vite-plugin-pwa`'s `globPatterns` sweeps the whole build output.
const swForAssetList = await get('/sw.js')
const precachedJsPaths = [
  ...new Set(
    (swForAssetList.text.match(/\{url:"(assets\/[^"]+\.js)"/g) ?? []).map((m) => m.slice(6, -1)),
  ),
]
if (bundlePath && !precachedJsPaths.includes(bundlePath)) precachedJsPaths.push(bundlePath)

const allAssets = await mapWithConcurrency(precachedJsPaths, 5, async (path) => ({
  path,
  text: (await get(`/${path}`)).text,
}))
const allJs = allAssets.map((a) => a.text).join('\n')
record(
  'every shipped JS chunk was fetched for the checks below',
  allAssets.length > 0,
  `${allAssets.length} chunk(s): ${precachedJsPaths.join(', ')}`,
)

// The check that would have caught the original defect. Asserted on the built artefact, because
// the dashboard field and the artefact are different things and only one of them reaches a browser.
// Scanned across every chunk (see above) — the Supabase client (and therefore its baked-in URL)
// can legitimately live in a shared chunk rather than the entry file.
{
  const found = [...new Set(allJs.match(/https:\/\/[a-z0-9-]+\.supabase\.co/g) ?? [])]
  record(
    'the deployed JS points at exactly the expected Supabase project',
    found.length === 1 && found[0] === supabaseOrigin,
    found.length ? found.join(', ') : '(no Supabase origin in any shipped chunk)',
  )

  // Resolve the origin the *bundle* names, not the one that was expected. A well-formed URL for a
  // project that does not exist looks exactly like a correct one until something asks DNS, and
  // probing the expected value would have answered cheerfully while browsers got nothing.
  const deployed = found[0]
  if (deployed) {
    try {
      const probe = await fetch(`${deployed}/rest/v1/`)
      record('  …and that project resolves', probe.status > 0, `${deployed} → HTTP ${probe.status}`)
    } catch (error) {
      record(
        '  …and that project resolves',
        false,
        `${deployed} → ${String(error.cause?.code ?? error.message)}`,
      )
    }
  }
}

record(
  'no source map is shipped alongside any chunk',
  !/sourceMappingURL/.test(allJs),
  /sourceMappingURL/.test(allJs) ? 'a chunk references a .map' : 'none',
)

// A secret key is `sb_secret_<token>`, or in the legacy form a JWT whose payload claims
// service_role. Neither may be here.
//
// Matched on the *shape of a key*, not on the prefix: `@supabase/supabase-js` carries the literal
// string `sb_secret_` in its own source, to detect and refuse a secret key handed to a browser
// client. Grepping for the prefix therefore fails on every correct bundle, which is worse than not
// checking — a check that always fails gets ignored, and then it is not there on the day it matters.
{
  const modernKey = /sb_secret_[A-Za-z0-9_-]{16,}/.exec(allJs)?.[0]

  let serviceRoleJwt = null
  for (const jwt of allJs.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./g) ?? []) {
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
      if (payload.role === 'service_role') serviceRoleJwt = payload.role
    } catch {
      // Not a JWT after all. A bundle is full of base64-shaped strings that are not tokens.
    }
  }

  record(
    'no secret key of either generation is in any shipped chunk',
    !modernKey && !serviceRoleJwt,
    modernKey ? 'sb_secret_ key present' : serviceRoleJwt ? 'service_role JWT present' : 'none',
  )
}

// ── Client-side routing without a _redirects file ────────────────────────────────────────────
// Pages serves index.html for unmatched paths when the output has no top-level 404.html. An
// invitation link is a deep link on a cold load, so this is load-bearing, not cosmetic.
for (const path of ['/login', '/invite/a-token-that-does-not-exist', '/admin/invitations']) {
  const r = await get(path)
  record(`${path} resolves to the application shell`, r.status === 200, `HTTP ${r.status}`)
}

// ── Security headers ─────────────────────────────────────────────────────────────────────────
// The service worker already fetched above doubles as the capability probe: a deployment is
// scanner-enabled exactly when its live SW registers the same-origin /scanner-assets/v7/
// CacheFirst rule. That keeps the WASM requirement version-aware without extra plumbing —
// current production (no scanner rule) is not failed for lacking the grant it does not need,
// while any deployment that ships the scanner route MUST also carry the CSP grant that lets its
// OCR engine compile. The generated route source embeds the escaped path `scanner-assets\/v7`,
// hence the two spellings. Declared at module scope — both check blocks below read it.
const swText = swForAssetList.text
const scannerCapable =
  (swText.includes('scanner-assets\\/v7') || swText.includes('/scanner-assets/v7/')) &&
  swText.includes('CacheFirst')

{
  const h = index.headers
  const csp = h.get('content-security-policy') ?? ''

  record(
    'a Content-Security-Policy is served',
    csp.length > 0,
    csp ? `${csp.length} chars` : '(none)',
  )

  const directives = cspDirectives(csp)
  const scriptSrc = directives.get('script-src') ?? []
  const workerSrc = directives.get('worker-src') ?? []
  const connectSrc = directives.get('connect-src') ?? []

  // Regressions that are wrong on EVERY deployment, scanner or not.
  record(
    'script-src grants no JavaScript eval, inline script or data: source',
    !scriptSrc.some((t) => ["'unsafe-eval'", "'unsafe-inline'", 'data:'].includes(t)),
    scriptSrc.join(' ') || '(none)',
  )

  if (scannerCapable) {
    record(
      "script-src grants 'wasm-unsafe-eval' so the deployed OCR engine can compile",
      scriptSrc.includes("'wasm-unsafe-eval'"),
      scriptSrc.join(' ') || '(none)',
    )
    record(
      // P78, D-097 addendum: onnxruntime-web's WASM factory dynamically imports its own glue
      // module from a blob: object URL — without this the visual model fails to load on every
      // browser (confirmed by direct reproduction, not a threading/cross-origin-isolation issue).
      "script-src grants 'blob:' for onnxruntime-web's dynamic-import WASM loader",
      scriptSrc.includes('blob:'),
      scriptSrc.join(' ') || '(none)',
    )
  } else {
    console.log(
      'INFO  deployment has no scanner runtime rule in its service worker; ' +
        "'wasm-unsafe-eval' presence not required yet",
    )
  }

  record(
    "worker-src remains exactly 'self'",
    workerSrc.length === 1 && workerSrc[0] === "'self'",
    workerSrc.join(' ') || '(none)',
  )
  record(
    'connect-src is unchanged: self plus this deployment’s Supabase project and its realtime endpoint',
    JSON.stringify(connectSrc) ===
      JSON.stringify(["'self'", supabaseOrigin, supabaseOrigin.replace(/^http/, 'ws')]),
    connectSrc.join(' ') || '(none)',
  )
  record("frame-ancestors is 'none'", /frame-ancestors 'none'/.test(csp))
  record(
    'Referrer-Policy is no-referrer, so an invitation path never leaves the origin',
    (h.get('referrer-policy') ?? '').toLowerCase() === 'no-referrer',
    h.get('referrer-policy') ?? '(none)',
  )
  record(
    'X-Content-Type-Options is nosniff',
    (h.get('x-content-type-options') ?? '').toLowerCase() === 'nosniff',
    h.get('x-content-type-options') ?? '(none)',
  )
}

// ── PWA, and what the service worker is allowed to keep ──────────────────────────────────────
{
  const manifest = await get('/manifest.webmanifest')
  let parsed = {}
  try {
    parsed = JSON.parse(manifest.text)
  } catch {
    parsed = {}
  }
  record('the web app manifest is served', manifest.status === 200, `HTTP ${manifest.status}`)
  record(
    'it declares standalone display and a scope',
    parsed.display === 'standalone' && Boolean(parsed.scope),
    `${parsed.display} · ${parsed.scope}`,
  )
  record(
    'it declares 192px, 512px and maskable icons',
    ['192x192', '512x512'].every((size) =>
      (parsed.icons ?? []).some((icon) => icon.sizes === size),
    ) && (parsed.icons ?? []).some((icon) => icon.purpose === 'maskable'),
    `${(parsed.icons ?? []).length} icons`,
  )

  for (const icon of parsed.icons ?? []) {
    const r = await get(icon.src)
    record(
      `  icon ${icon.sizes} ${icon.purpose} is reachable`,
      r.status === 200,
      `HTTP ${r.status}`,
    )
  }

  const sw = swForAssetList // already fetched above, to build the full JS asset list
  record('the service worker is served', sw.status === 200, `HTTP ${sw.status}`)
  record(
    'it must revalidate rather than being cached for a day',
    /max-age=0|no-cache|must-revalidate/.test(sw.headers.get('cache-control') ?? ''),
    sw.headers.get('cache-control') ?? '(none)',
  )

  // The property that matters, stated as an absence: nothing in the worker knows how to store a
  // Supabase response. Precaching the static shell is fine; a runtime cache over the Data API
  // would put someone's financial records on disk, and offline private data is not in scope
  // (ARCHITECTURE.md §6).
  //
  // M15 narrows this from "no runtime caching at all" to exactly one permitted rule: CacheFirst,
  // scoped in the generated source to the same-origin /scanner-assets/v7/ engine prefix. The
  // network-dependent strategies are still forbidden outright — they exist only to serve stale
  // HTML/API responses, which is precisely what must never be cached here.
  const dangerousStrategies = ['NetworkFirst', 'StaleWhileRevalidate', 'CacheOnly'].filter((s) =>
    sw.text.includes(s),
  )
  record(
    'no network-first style runtime caching exists anywhere in the worker',
    dangerousStrategies.length === 0,
    dangerousStrategies.length ? dangerousStrategies.join(', ') : 'none',
  )
  record(
    'the only CacheFirst rule is scoped to the same-origin /scanner-assets/v7/ engine assets',
    !sw.text.includes('CacheFirst') || scannerCapable,
    scannerCapable
      ? '/scanner-assets/v7/ CacheFirst present'
      : sw.text.includes('CacheFirst')
        ? 'CacheFirst without scanner scope'
        : 'no CacheFirst',
  )
  record(
    'and does not reference the Supabase host at all',
    !sw.text.includes(new URL(supabaseOrigin).hostname),
    new URL(supabaseOrigin).hostname,
  )

  const precacheEntries = sw.text.match(/\{url:"[^"]+"/g) ?? []
  record(
    'precaches only static shell assets',
    precacheEntries.every((entry) => /\.(js|css|html|png|svg|ico|woff2|webmanifest)"/.test(entry)),
    `${precacheEntries.length} entries`,
  )
  record(
    'scanner OCR assets stay out of the precache manifest entirely',
    !precacheEntries.some((entry) => entry.includes('scanner-assets')),
    `${precacheEntries.filter((entry) => entry.includes('scanner-assets')).length} scanner entries`,
  )
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log(`FAILED: ${failed.map((r) => r.name).join(', ')}`)
  process.exitCode = 1
}
