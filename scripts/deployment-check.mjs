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
  const response = await fetch(`${site}${path}`)
  return { status: response.status, headers: response.headers, text: await response.text() }
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

const allAssets = await Promise.all(
  precachedJsPaths.map(async (path) => ({ path, text: (await get(`/${path}`)).text })),
)
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
{
  const h = index.headers
  const csp = h.get('content-security-policy') ?? ''

  record(
    'a Content-Security-Policy is served',
    csp.length > 0,
    csp ? `${csp.length} chars` : '(none)',
  )
  record(
    "script-src is 'self' with no inline allowance",
    /script-src 'self'(;|$)/.test(csp),
    /script-src[^;]*/.exec(csp)?.[0] ?? '(none)',
  )
  record(
    'connect-src names this deployment’s Supabase project',
    csp.includes(supabaseOrigin),
    /connect-src[^;]*/.exec(csp)?.[0] ?? '(none)',
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
  record(
    'the service worker holds no runtime caching rule',
    !/NetworkFirst|StaleWhileRevalidate|CacheFirst|runtimeCaching/.test(sw.text),
    'checked for workbox runtime strategies',
  )
  record(
    'and does not reference the Supabase host at all',
    !sw.text.includes(new URL(supabaseOrigin).hostname),
    new URL(supabaseOrigin).hostname,
  )
  record(
    'precaches only static shell assets',
    (sw.text.match(/\{url:"[^"]+"/g) ?? []).every((entry) =>
      /\.(js|css|html|png|svg|ico|woff2|webmanifest)"/.test(entry),
    ),
    `${(sw.text.match(/\{url:"[^"]+"/g) ?? []).length} entries`,
  )
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log(`FAILED: ${failed.map((r) => r.name).join(', ')}`)
  process.exitCode = 1
}
