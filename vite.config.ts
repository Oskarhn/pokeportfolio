/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Single source of truth for the app version shown in Profile's footer (M7.1 prompt §65) —
// package.json, not a hardcoded string that drifts from it.
const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { version: string }

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
`
      this.emitFile({ type: 'asset', fileName: '_headers', source: headers })
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
  },
  plugins: [
    react(),
    tailwindcss(),
    cloudflareHeaders(),
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
