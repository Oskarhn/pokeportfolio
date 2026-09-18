/**
 * Launch-readiness link/route checker (P101, docs/LAUNCH_CHECKLIST.md item 19).
 *
 * WHY IT EXISTS. `public/robots.txt`'s `Allow:` list, `public/sitemap.xml`'s URLs and this script's
 * own `PUBLIC_ROUTES` are three hand-maintained lists that all have to name the exact same three
 * pages — the entire genuinely public surface of an otherwise invite-only app
 * (docs/PRODUCT_SPEC.md §1.1). Nothing enforces that automatically at the TypeScript level (they
 * live in a plain-text file, an XML file and a route table), so this is the thing that fails loudly
 * if a future session adds a fourth or lets one drift from the other two — including the case that
 * actually matters: a *private* route accidentally listed as public.
 *
 * Static mode (default) checks a local production build's `dist/` output — no network, safe to run
 * in CI or before ever deploying. Live mode additionally re-fetches the same URLs against a real
 * deployment; it is optional and manual, matching `deployment-check.mjs`/`remote-security-check.mjs`
 * (no remote credentials, so CI stays reproducible from Git alone).
 *
 * Usage (PowerShell):
 *
 *   pnpm build
 *   node scripts/check-links.mjs
 *
 *   # optional live mode, after a real deploy:
 *   $env:DEPLOYMENT_URL = "https://pokeportfolio-dev.pages.dev"
 *   node scripts/check-links.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { summarizeResults } from './lib/verifier-summary.mjs'

/** Kept in sync BY THIS CHECK with public/robots.txt's Allow list and public/sitemap.xml's URLs —
 *  see router.tsx's "Three route classes" comment for the authoritative route-class list this is
 *  drawn from. */
const PUBLIC_ROUTES = ['/privacy', '/terms', '/faq']

/** Mirrors vite.config.ts's `ASSET_FALLBACK_DIRECTORIES` (not imported directly: that file is
 *  TypeScript with real side effects at module load — a `git rev-parse` call and a full
 *  `defineConfig` evaluation — too heavy to pull in just for one constant array). If that list
 *  ever changes, update this one too; tests/config/asset-fallback-pages.test.ts pins the source. */
const ASSET_FALLBACK_DIRECTORIES = ['assets', 'scanner-assets']

const distDir = join(process.cwd(), 'dist')

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(distDir)) {
  throw new Error('dist/ not found — run `pnpm build` first.')
}

// ── robots.txt / sitemap.xml / PUBLIC_ROUTES three-way consistency ──────────────────────────────
const robotsPath = join(distDir, 'robots.txt')
const sitemapPath = join(distDir, 'sitemap.xml')
record('public/robots.txt is present in dist', existsSync(robotsPath))
record('public/sitemap.xml is present in dist', existsSync(sitemapPath))

if (existsSync(robotsPath) && existsSync(sitemapPath)) {
  const robotsText = readFileSync(robotsPath, 'utf-8')
  const allowed = [...robotsText.matchAll(/^Allow:\s*(\S+)/gm)].map((m) => m[1])
  const sitemapText = readFileSync(sitemapPath, 'utf-8')
  const sitemapPaths = [...sitemapText.matchAll(/<loc>(.*?)<\/loc>/g)].map(
    (m) => new URL(m[1]).pathname,
  )

  const sortedAllowed = [...allowed].sort()
  const sortedSitemap = [...sitemapPaths].sort()
  const sortedPublicRoutes = [...PUBLIC_ROUTES].sort()

  record(
    'robots.txt Allow list matches sitemap.xml exactly',
    JSON.stringify(sortedAllowed) === JSON.stringify(sortedSitemap),
    `robots: ${sortedAllowed.join(', ')} | sitemap: ${sortedSitemap.join(', ')}`,
  )
  record(
    "robots.txt/sitemap.xml match this script's known PUBLIC_ROUTES",
    JSON.stringify(sortedAllowed) === JSON.stringify(sortedPublicRoutes),
    sortedAllowed.join(', '),
  )
  record(
    'robots.txt never allows a route carrying a live token (/invite, /reset-password)',
    !allowed.some((p) => p.startsWith('/invite') || p.startsWith('/reset-password')),
  )
  record('robots.txt disallows everything by default', /^Disallow:\s*\/\s*$/m.test(robotsText))
}

// ── index.html's referenced assets actually exist ────────────────────────────────────────────────
const indexHtmlPath = join(distDir, 'index.html')
record('dist/index.html is present', existsSync(indexHtmlPath))
if (existsSync(indexHtmlPath)) {
  const html = readFileSync(indexHtmlPath, 'utf-8')
  const localRefs = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)]
    .map((m) => m[1])
    .filter((path) => !path.startsWith('//'))
  for (const path of localRefs) {
    record(`index.html reference resolves: ${path}`, existsSync(join(distDir, path)))
  }

  const ogImage = /property="og:image" content="([^"]+)"/.exec(html)?.[1]
  if (ogImage) {
    const ogImagePath = new URL(ogImage).pathname
    record(`og:image resolves locally: ${ogImagePath}`, existsSync(join(distDir, ogImagePath)))
  }
}

// ── PWA manifest and its icons ────────────────────────────────────────────────────────────────────
const manifestPath = join(distDir, 'manifest.webmanifest')
record('manifest.webmanifest is present', existsSync(manifestPath))
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  for (const icon of manifest.icons ?? []) {
    record(`manifest icon resolves: ${icon.src}`, existsSync(join(distDir, icon.src)))
  }
}

// ── the nested asset-directory 404 pages (P83/D-100) actually got emitted ──────────────────────────
for (const dir of ASSET_FALLBACK_DIRECTORIES) {
  record(`${dir}/404.html is present`, existsSync(join(distDir, dir, '404.html')))
}

// ── _headers (CSP etc.) got emitted ───────────────────────────────────────────────────────────────
record('_headers is present', existsSync(join(distDir, '_headers')))

// ── optional live mode ───────────────────────────────────────────────────────────────────────────
const site = (process.env.DEPLOYMENT_URL ?? '').replace(/\/+$/, '')
if (site) {
  console.log(`\n— live mode: ${site} —\n`)
  const livePaths = ['/robots.txt', '/sitemap.xml', ...PUBLIC_ROUTES]
  for (const path of livePaths) {
    const response = await fetch(`${site}${path}`, { signal: AbortSignal.timeout(15000) })
    record(`live ${path} responds 200`, response.status === 200, `HTTP ${response.status}`)
  }
} else {
  console.log('\n(DEPLOYMENT_URL not set — skipping live mode, static dist/ checks only)')
}

const summary = summarizeResults(results)
if (summary.ranNothing) {
  // P130-27/P139 fail-closed contract, applied uniformly across every verifier: zero recorded
  // checks must never look identical to zero failures.
  console.log('\nFAIL: no checks were recorded — this run proves nothing')
} else {
  console.log(`\n${String(summary.passedCount)}/${String(summary.meaningfulCount)} checks passed`)
  if (summary.failed.length) {
    console.log(
      `FAILED: ${results
        .filter((r) => !r.pass)
        .map((r) => r.name)
        .join(', ')}`,
    )
  }
}
process.exitCode = summary.ok ? 0 : 1
