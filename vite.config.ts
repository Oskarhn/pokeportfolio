/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

// Single source of truth for the app version shown in Profile's footer (M7.1 prompt §65) —
// package.json, not a hardcoded string that drifts from it.
const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { version: string }

/**
 * Immutable build identity (P83, D-100) — the owner's real-iPhone P82 report turned out to be a
 * STALE deployment silently running old JavaScript (old diagnostics schema, old capture
 * dimensions); nothing in the app could prove which commit was actually running. Cloudflare Pages
 * sets `CF_PAGES_COMMIT_SHA` for every Pages build; a local `pnpm build` (no Pages env) falls back
 * to the checked-out commit so the value is never fabricated either way.
 */
function resolveBuildSha(): string {
  const pagesSha = process.env.CF_PAGES_COMMIT_SHA
  if (pagesSha) return pagesSha
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}
const appBuildSha = resolveBuildSha()
const appBuildTime = new Date().toISOString()

/**
 * The Content-Security-Policy served by `_headers`, derived from the Supabase URL this bundle was
 * actually built against. Exported pure so tests/config/security-headers.test.ts can pin the
 * exact directives — this is the file a WASM-era regression would edit first.
 */
export function buildContentSecurityPolicy(supabaseUrl: string): string {
  const origin = new URL(supabaseUrl).origin
  const realtime = origin.replace(/^http/, 'ws')

  return [
    // Nothing loads from anywhere by default; every allowance below is deliberate.
    "default-src 'self'",
    // The build emits module scripts as files and no inline script — verified in dist. So this
    // still needs no 'unsafe-inline' and no nonce, which is what makes the rest of the policy
    // worth having. 'wasm-unsafe-eval' is the CSP3 source expression that permits WebAssembly
    // *compilation* — required by the M15 scanner's on-device OCR engine — while JavaScript
    // eval() remains refused; the two are distinct grants under CSP3 and only the former is
    // given.
    //
    // `blob:` (P78, D-097 addendum): onnxruntime-web 1.26.0-dev's WASM factory
    // (`web/lib/wasm/wasm-utils-import.ts`, confirmed by reading the installed package source)
    // dynamically `import()`s its own glue module, and its `preload()` path fetches that module
    // and re-imports it from a `blob:` object URL rather than the original same-origin URL. CSP3
    // governs dynamic-`import()` targets through script-src, so without `blob:` here that import
    // is refused — this was reproduced directly (real Chromium, both the `webgpu` and `wasm`
    // device paths, `crossOriginIsolated=false` throughout) as the actual cause of the real-iPhone
    // "VISUAL_MODEL_STATE=failed" report: identical on desktop with no COOP/COEP change, so it is
    // not a threading/cross-origin-isolation issue. Confirmed the SAME build succeeds once `blob:`
    // is granted here, nowhere else. This does not weaken the policy for anything else already
    // running: no inline script, no remote script host, and JavaScript `eval()` is still refused.
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    // 'unsafe-inline' is here for style *attributes*: AppShell sets safe-area padding with
    // `style={{ paddingTop: 'max(…, env(safe-area-inset-top))' }}`, which cannot be expressed
    // in a stylesheet. `style-src-attr` would express that precisely, but Safari support for it
    // is recent and iPhone is the primary platform — a policy that silently drops safe-area
    // padding on an older phone is worse than this allowance, which buys an attacker nothing
    // while script-src holds.
    "style-src 'self' 'unsafe-inline'",
    // M7 renders card artwork (search results, Portfolio grid tiles) from the TCGdex CDN
    // (docs/API_SOURCES.md) — named explicitly, not by loosening this to `https:`.
    "img-src 'self' data: blob: https://assets.tcgdex.net",
    "font-src 'self'",
    `connect-src 'self' ${origin} ${realtime}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ')
}

/**
 * Emits Cloudflare Pages' `_headers` file, with `connect-src` derived from the Supabase URL this
 * bundle was actually built against.
 *
 * Generated rather than checked in, for one reason: a hand-written CSP naming a project ref goes
 * stale the moment the app is pointed at a different Supabase project, and it goes stale silently
 * until someone opens the deployed app and finds every request blocked. M4 lost a day to exactly
 * that class of bug — configuration that was correct where it was written and wrong where it ran.
 * Deriving it from `VITE_SUPABASE_URL` means the policy and the client cannot disagree.
 *
 * `_headers` is ignored by `vite dev` and `vite preview`; only Cloudflare Pages reads it. So the
 * policy is exercised on the deployment and nowhere else, and has to be verified there.
 */
function cloudflareHeaders(): Plugin {
  return {
    name: 'pokeportfolio:cloudflare-headers',
    apply: 'build',
    generateBundle() {
      const supabaseUrl = process.env.VITE_SUPABASE_URL
      if (!supabaseUrl) {
        throw new Error(
          'VITE_SUPABASE_URL must be set at build time: the Content-Security-Policy in _headers ' +
            'is derived from it.',
        )
      }
      const csp = buildContentSecurityPolicy(supabaseUrl)

      const headers = `# Generated by vite.config.ts. Do not edit by hand — edit the plugin.
#
# Cloudflare Pages applies these to static asset responses. There are no Pages Functions in this
# project; if one is ever added, note that custom headers do not apply to its responses.

/*
  Content-Security-Policy: ${csp}
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: geolocation=(), microphone=(), payment=(), usb=()
  Strict-Transport-Security: max-age=31536000

# P81 §8/§9: without an explicit rule here, Cloudflare Pages' own default for these paths (files
# with no content-hashed filename) is "Cache-Control: public, max-age=0, must-revalidate" —
# confirmed by curling the live preview directly. That means even a browser that already has the
# 24MB DINO ONNX model or the 13-23MB ORT WASM binary in its plain HTTP cache still spends a full
# network round trip revalidating it on every visit, on top of whatever the Service Worker's own
# CacheFirst runtime-caching rule does (scannerAssetRuntimeCache/visualAssetRuntimeCache below) —
# and that SW rule is not guaranteed to even apply here, since fetches issued from inside the
# scanner's dedicated Workers are not guaranteed to be intercepted by the controlling Service
# Worker on every engine. Both asset families are safe to cache aggressively: each lives under a
# version-pinned path segment (v7, visual-v1) AND the visual worker additionally verifies
# EXPECTED_MODEL_REVISION before trusting anything it loads (visual-worker.ts) — a stale cached
# copy can never silently masquerade as a different model/index revision. This does not touch
# ordinary app files (JS/CSS/HTML), which keep Cloudflare's default hashed-asset behaviour.
/scanner-assets/*
  Cache-Control: public, max-age=31536000, immutable

# P83/D-100: this file exists ONLY so a running client can ask "does a newer deployment than mine
# exist?" (build-freshness-runtime.ts) without polling every few seconds — an explicit no-store
# means every check reaches the real edge response for THIS deployment, never a stale HTTP-cached
# copy answering with an old commit sha.
/build-meta.json
  Cache-Control: no-store
`
      this.emitFile({ type: 'asset', fileName: '_headers', source: headers })
    },
  }
}

/**
 * Tiny, stable-path, never-content-hashed JSON file a running client fetches (with `cache:
 * 'no-store'`, belt-and-suspenders against the `_headers` rule above) to learn the SHA of the
 * deployment CURRENTLY serving this hostname — compared against `__APP_BUILD_SHA__`
 * (build-info.ts) to answer "is a newer deployment already live?" (P83 §6, D-100). Deliberately
 * excluded from the Workbox precache glob (globPatterns below lists extensions, `.json` is not
 * one of them) so the Service Worker never hands back a cached answer for this specific request.
 */
function cloudflareBuildMeta(): Plugin {
  return {
    name: 'pokeportfolio:build-meta',
    apply: 'build',
    generateBundle() {
      const meta = JSON.stringify({ sha: appBuildSha, builtAt: appBuildTime })
      this.emitFile({ type: 'asset', fileName: 'build-meta.json', source: meta })
    },
  }
}

/**
 * File extensions a browser only ever requests as a same-origin build artifact (a lazy route
 * chunk, a stylesheet, a WASM/ONNX binary, a sourcemap) — never as a client-side navigation path,
 * which this app's router keeps extension-free throughout (router.tsx). Exported for
 * tests/config/asset-fallback-redirects.test.ts.
 */
export const ASSET_FALLBACK_EXTENSIONS = [
  'js',
  'mjs',
  'css',
  'wasm',
  'map',
  'json',
  'bin',
  'gz',
  'webmanifest',
]

/**
 * Emits Cloudflare Pages' `_redirects` file (P83, D-100).
 *
 * Root cause, reproduced directly against this project's own deployed preview: with no top-level
 * `404.html`, Cloudflare Pages treats ANY request that doesn't match a real file as SPA
 * navigation and rewrites it to `index.html` at `200 text/html` — including a content-hashed
 * chunk a redeploy has already removed (docs/ARCHITECTURE.md's "SPA routing needs no
 * configuration" note, and `deployment-check.mjs`'s own `/login`/`/invite/...`/`/admin/...`
 * checks, already documented exactly this — the dependency this session initially missed). A tab
 * still running an OLDER page's module graph then executes `import('/assets/OldChunk-<hash>.js')`
 * against that URL, receives HTML back, and the browser's module loader rejects with "'text/html'
 * is not a valid JavaScript MIME type" — exactly the real-iPhone failure the owner hit pressing
 * the scanner's X button (P83 §0/§3).
 *
 * These rules intercept every asset-shaped path FIRST, ahead of the trailing catch-all, so a
 * genuinely missing asset gets a real 404 (`public/missing-asset.html`, a plain error page — never
 * the app shell) instead of malformed module content. The catch-all after it preserves ordinary
 * SPA behaviour for real navigation paths (deep links, a hard refresh on any client-side route).
 * Cloudflare serves an EXISTING file at its own path before consulting `_redirects` at all, so a
 * currently-deployed chunk is unaffected.
 *
 * The error page is deliberately named `missing-asset.html`, NOT `404.html`: shipping a file
 * literally named `404.html` at the project root was tried first and broke EVERY real navigation
 * route (`/login`, `/invite/...`, `/admin/invitations` all started returning a bare 404 instead of
 * the app shell) — Cloudflare's own top-level-`404.html` detection is a project-wide switch that
 * disables the automatic SPA rewrite entirely, independent of and evaluated ahead of whatever
 * `_redirects` says. Caught by `deployment-check.mjs` against the live preview before this was
 * merged (output_83.txt); never reproduced by `pnpm build`/local tests, since `vite preview`
 * ignores `_redirects` entirely and never exhibits Cloudflare's specific 404.html-presence
 * behaviour either — this class of bug is only observable against a real deployment, which is
 * exactly why `deployment-check.mjs` exists and why this file's `docs/ARCHITECTURE.md` sentence
 * about "SPA routing needs no configuration" is now the load-bearing constraint to check FIRST
 * before ever placing a real `404.html` in `public/` again.
 */
export function buildAssetFallbackRedirects(): string {
  const assetRules = ASSET_FALLBACK_EXTENSIONS.map(
    (ext) => `/*.${ext}  /missing-asset.html  404`,
  ).join('\n')
  return `# Generated by vite.config.ts. Do not edit by hand — edit the plugin.
#
# P83/D-100: a request for a build artifact that no longer exists on this deployment (a stale
# client's OLD chunk hash after a redeploy) must return a real 404, never the app shell — see
# buildAssetFallbackRedirects's own comment in vite.config.ts for the full failure chain. The
# target is deliberately NOT named 404.html — see that same comment for why.
${assetRules}

# Everything else is a client-side route — TanStack Router owns it from here.
/*  /index.html  200
`
}

function cloudflareRedirects(): Plugin {
  return {
    name: 'pokeportfolio:cloudflare-redirects',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: '_redirects',
        source: buildAssetFallbackRedirects(),
      })
    },
  }
}

/**
 * M15 scanner platform: the vendored OCR engine (worker JS, WASM cores, traineddata) lives under
 * a versioned same-origin prefix, `/scanner-assets/<version>/`. Several MB per version — users
 * who never open the Scanner must never download it, so it is kept out of the install-time
 * precache and served through the runtime rule below instead. Ordinary shell globs are untouched;
 * asserted in tests/config/security-headers.test.ts.
 */
export const scannerAssetGlobIgnores = [
  'scanner-assets/**',
  // The visual-recognition worker (P76, D-097) bundles @huggingface/transformers into its OWN
  // Vite-emitted chunk under assets/ (it is a `new Worker(new URL(...))` entry, not staged
  // under /scanner-assets/ like the model/index binaries). At ~500KB it must stay lazy — a user
  // who never opens the scanner must not download it at install time. Verified by inspecting a
  // real production build's precache manifest before this ignore existed (it was present).
  'assets/visual-worker-*.js',
]

export const scannerAssetsNavigateFallbackDenylist = [/^\/scanner-assets\//]

/**
 * CacheFirst, same-origin only, for the immutable files of ONE engine version.
 *
 * Why unanchored: Workbox's RegExpRoute tests the pattern against the request's full href and,
 * for cross-origin URLs, requires the match to start at index 0 — impossible for a pattern whose
 * first character is `/`, since every absolute href starts with a scheme. A path-leading pattern
 * therefore structurally cannot serve a cross-origin response (no opaque model caching from
 * foreign origins), while still matching same-origin pathnames; verified against
 * workbox-routing 7.4.1's implementation. The `$` end-anchor plus the explicit extension set
 * keeps HTML/API responses out by construction.
 *
 * Why a dedicated versioned cache name: an engine update ships as a NEW prefix (`/v8/`) with its
 * own cache name, never by mutating v7's contents invisibly. Entries expire through the built-in
 * ExpirationPlugin (size- and age-bounded, quota-safe) rather than custom cleanup code; an
 * abandoned old version simply ages out on devices.
 */
export const scannerAssetRuntimeCache = {
  urlPattern: /\/scanner-assets\/v7\/.+\.(?:js|wasm|gz)(?:[?#].*)?$/,
  // Literal-annotated so this stays assignable to workbox-build's RuntimeCaching (StrategyName).
  handler: 'CacheFirst' as const,
  options: {
    cacheName: 'scanner-assets-v7',
    expiration: {
      maxEntries: 16,
      maxAgeSeconds: 60 * 60 * 24 * 90,
      purgeOnQuotaError: true,
    },
    cacheableResponse: { statuses: [200] },
  },
}

/**
 * Same CacheFirst/same-origin-only shape as scannerAssetRuntimeCache, for the M15b visual
 * recognition model + reference index (D-097, prompt §38): a NEW explicit namespace
 * (`visual-v1`, not reused v7) because it is a functionally distinct asset family (ONNX model,
 * onnxruntime-web WASM, and the binary index), not another OCR engine version. `.onnx`/`.bin` are
 * scoped to this one versioned path — never a generic `*.onnx`/`*.bin` rule anywhere else in the
 * app, which could otherwise opaquely cache an unrelated future asset under the same extension.
 */
export const visualAssetRuntimeCache = {
  urlPattern: /\/scanner-assets\/visual-v1\/.+\.(?:onnx|wasm|mjs|json|bin)(?:[?#].*)?$/,
  handler: 'CacheFirst' as const,
  options: {
    cacheName: 'scanner-assets-visual-v1',
    expiration: {
      maxEntries: 16,
      maxAgeSeconds: 60 * 60 * 24 * 90,
      purgeOnQuotaError: true,
    },
    cacheableResponse: { statuses: [200] },
  },
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_BUILD_SHA__: JSON.stringify(appBuildSha),
    __APP_BUILD_TIME__: JSON.stringify(appBuildTime),
  },
  plugins: [
    react(),
    tailwindcss(),
    cloudflareHeaders(),
    cloudflareRedirects(),
    cloudflareBuildMeta(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'PokePortfolio',
        short_name: 'PokePortfolio',
        description: 'A private Pokémon TCG collection and financial tracker.',
        theme_color: '#101113',
        background_color: '#101113',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache the app shell only. Financial and auth data must never be
        // cached by the service worker — see docs/ARCHITECTURE.md §6. The
        // scanner's multi-MB OCR engine assets are deliberately NOT precached;
        // scannerAssetRuntimeCache below serves them on first Scanner use.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        globIgnores: scannerAssetGlobIgnores,
        navigateFallbackDenylist: [/^\/api\//, ...scannerAssetsNavigateFallbackDenylist],
        runtimeCaching: [scannerAssetRuntimeCache, visualAssetRuntimeCache],
      },
    }),
  ],
  test: {
    environment: 'node',
    // Infrastructure-free suites only. Database and authorization tests need a live Supabase
    // stack and run separately via `pnpm test:db` (vitest.db.config.ts) — see docs/TESTING.md §1.
    // tests/ui/ covers browser-platform logic that is pure enough to verify without a DOM
    // renderer (M13's file-delivery dispatch), with platform globals stubbed.
    include: [
      'tests/domain/**/*.test.ts',
      'tests/financial/**/*.test.ts',
      'tests/data/**/*.test.ts',
      'tests/ui/**/*.test.ts',
      // Build/platform security configuration (M15): CSP policy shape and scanner asset
      // caching rules, asserted at config level; dist artefacts are checked separately by
      // scripts/verify-scanner-platform-build.mjs after a real build.
      'tests/config/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/domain/**/*.ts'],
    },
  },
})
