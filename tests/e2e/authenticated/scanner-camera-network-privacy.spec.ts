import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'

/**
 * P112 §10/§C.3 — a real, live-camera-capture network-privacy trace against the actual scanner
 * pipeline (camera -> capture -> crop/rectify -> OCR -> visual worker), not merely a `/scan` page
 * load. Every prior session's proof of "the scanner never uploads image bytes" was either static
 * (`tests/ui/scanner-network-audit.test.ts` greps the source tree for fetch/XHR/upload call
 * sites) or an ad-hoc, uncommitted spot-check (P111's own disclosed gap). This is the first
 * committed, repeatable version that actually drives a synthetic MediaStream through
 * `getUserMedia`, presses the real shutter button, and lets the real OCR + visual-worker pipeline
 * run to completion while recording every network request the page makes.
 *
 * `navigator.mediaDevices.getUserMedia` is overridden (via `addInitScript`, so it is in place
 * before ANY page script runs) to return a `canvas.captureStream()` fed by the committed synthetic
 * card fixture (`tests/fixtures/scanner/synthetic-card.png` — non-copyrighted, programmatically
 * generated) instead of real camera hardware. This exercises the exact same
 * `openEnvironmentCamera` -> `<video>` -> shutter -> `analyzeCapture` code path a real device
 * would use; only the pixel SOURCE is synthetic.
 */

const SYNTHETIC_CARD_PATH = fileURLToPath(
  new URL('../../fixtures/scanner/synthetic-card.png', import.meta.url),
)
const SYNTHETIC_CARD_DATA_URL = `data:image/png;base64,${readFileSync(SYNTHETIC_CARD_PATH).toString('base64')}`

// Same-origin static asset prefixes the scanner is allowed to GET (model weights, ORT WASM, OCR
// data, the visual index, and PostgREST catalog/API reads it may fall back to for a name search).
// Anything outside this allowlist during the capture/analyze window is suspicious and fails the
// test loudly rather than being silently ignored.
const ALLOWED_GET_PATH_FRAGMENTS = [
  '/scanner-assets/',
  '/assets/', // built JS/CSS/worker chunks
  '/@fs/', // dev-server module graph (this project runs against the vite dev server on 4174)
  '/@vite/',
  '/@react-refresh', // dev-server HMR client, not present in a production build
  '/node_modules/.vite/', // dev-server-resolved deps
  '/node_modules/.pnpm/', // dev-server-resolved deps (Vite's own client/env module etc.)
  '/src/', // dev-server source modules
  '/rest/v1/', // PostgREST reads (catalog lookups), never card image bytes
  '/auth/v1/', // session/token refresh
  '/build-meta.json', // same-origin build identity, no card data
]

test.describe('Scanner real-capture network privacy (P112)', () => {
  test('a live synthetic camera capture never uploads image bytes and never fires analytics on /scan', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['camera'])

    await context.addInitScript((dataUrl: string) => {
      const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        if (!constraints?.video) return nativeGetUserMedia(constraints)
        const img = new Image()
        img.src = dataUrl
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('fixture image failed to decode'))
        })
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')!
        let stopped = false
        const draw = () => {
          if (stopped) return
          ctx.drawImage(img, 0, 0)
          requestAnimationFrame(draw)
        }
        draw()
        const stream: MediaStream = canvas.captureStream(15)
        const track = stream.getVideoTracks()[0]
        if (track) {
          const originalStop = track.stop.bind(track)
          track.stop = () => {
            stopped = true
            originalStop()
          }
        }
        return stream
      }
    }, SYNTHETIC_CARD_DATA_URL)

    const requests: {
      url: string
      method: string
      resourceType: string
      postDataLength: number
      contentType: string | null
    }[] = []
    page.on('request', (request) => {
      requests.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        postDataLength: request.postDataBuffer()?.byteLength ?? 0,
        contentType: request.headers()['content-type'] ?? null,
      })
    })

    await page.goto('/scan')
    await page.getByRole('button', { name: 'Start camera' }).click()

    const shutter = page.getByRole('button', { name: 'Capture card' })
    await expect(shutter).toBeEnabled({ timeout: 15_000 })
    await shutter.click()

    await page.getByRole('button', { name: 'Use photo' }).click()

    // Real OCR + visual-worker analysis. A cold model/WASM/index load can genuinely take well
    // past Playwright's default timeout on CI-class hardware (matches visual-worker-real-browser
    // .spec.ts's own generous budget) — the terminal state is either "no match" (very likely for
    // a synthetic, non-catalog fixture) or a real candidate result.
    await expect(
      page
        .getByRole('heading', { name: "Couldn't identify this card." })
        .or(page.getByRole('heading', { name: 'Confirm card' }))
        .or(page.locator('h1', { hasText: /./ }).filter({ hasText: /result|candidate/i })),
    ).toBeVisible({ timeout: 90_000 })

    // ── The actual privacy assertions ──────────────────────────────────────────────────────────
    // PostgREST calls every RPC (reads included, e.g. the OCR-fallback `search_cards` text lookup)
    // via POST with a small JSON body — that is normal and not an upload. What must never happen
    // is a request shaped like an image: multipart/form-data or image/* content-type, or a body
    // large enough to plausibly be an encoded card photo (a real rectified-crop PNG/JPEG, even
    // base64'd, is at minimum tens of KB — 4KB is a generous, still-far-too-small ceiling for one).
    const IMAGE_LIKE_BODY_BYTES = 4096
    const imageBearing = requests.filter((r) => {
      if (r.postDataLength === 0) return false
      const ct = r.contentType ?? ''
      if (ct.includes('multipart/form-data') || ct.startsWith('image/')) return true
      return r.postDataLength > IMAGE_LIKE_BODY_BYTES
    })
    expect(
      imageBearing,
      `Found ${imageBearing.length} image-shaped request(s) during scanner capture: ` +
        JSON.stringify(imageBearing),
    ).toHaveLength(0)

    // Every other body-bearing request is expected to be a small JSON RPC/API call — assert that
    // explicitly too, so a regression that adds a NEW mutating endpoint doesn't slip through
    // silently just because its body happens to be small.
    const otherBodyBearing = requests.filter((r) => r.postDataLength > 0 && !imageBearing.includes(r))
    for (const r of otherBodyBearing) {
      expect(
        r.url,
        `Unexpected body-bearing request during scanner capture: ${JSON.stringify(r)}`,
      ).toMatch(/\/rest\/v1\/rpc\/search_cards$|\/auth\/v1\//)
    }

    const analytics = requests.filter((r) => r.url.includes('cloudflareinsights.com'))
    expect(analytics, 'Analytics must never fire on /scan').toHaveLength(0)

    const unexpectedGets = requests.filter(
      (r) =>
        (r.method === 'GET' || r.method === 'HEAD') &&
        !r.url.startsWith('blob:') && // client-local object URL (the on-device photo preview) —
        // never leaves the page process, not a network request to any server at all
        !ALLOWED_GET_PATH_FRAGMENTS.some((fragment) => r.url.includes(fragment)) &&
        !r.url.startsWith('http://localhost:4174/scan'), // the route document itself / HMR ping
    )
    expect(
      unexpectedGets,
      `Found GET(s) outside the allowed static-asset/API surface: ${JSON.stringify(unexpectedGets)}`,
    ).toHaveLength(0)

    const nonGet = requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD')
    // eslint-disable-next-line no-console -- diagnostic summary, useful when re-running this by hand
    console.log(
      `SCANNER_CAPTURE_NETWORK_TRACE: ${requests.length} total requests, ` +
        `${nonGet.length} non-GET/HEAD, ${imageBearing.length} image-shaped, ${analytics.length} analytics`,
    )
  })
})
