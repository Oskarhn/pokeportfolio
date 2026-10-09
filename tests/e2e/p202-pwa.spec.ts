import { test, expect } from '@playwright/test'
import { installBackend } from './support/generic-backend'

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'Viewports are set per cell; the WebKit/iPhone project is not part of this matrix (see docs/TESTING.md §6i).',
)

/**
 * P202: deterministic checks on the installable-app contract and on the service worker's
 * offline-shell behaviour. Private-data caching is covered by cachestorage-privacy.spec.ts; this
 * file covers installability and what a user sees on a refresh with no network.
 */

interface Manifest {
  id?: string
  name: string
  short_name: string
  start_url: string
  scope: string
  display: string
  theme_color: string
  background_color: string
  icons: { src: string; sizes: string; type: string; purpose?: string }[]
}

test('manifest declares a stable identity and installable icons that really exist', async ({
  page,
  request,
}) => {
  await page.goto('/login')
  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(href).toBeTruthy()
  const res = await request.get(href as string)
  expect(res.ok()).toBe(true)
  const manifest = (await res.json()) as Manifest

  expect(manifest.id).toBe('/')
  expect(manifest.start_url).toBe('/')
  expect(manifest.scope).toBe('/')
  expect(manifest.display).toBe('standalone')
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i)

  const purposes = manifest.icons.map((i) => `${i.sizes}:${i.purpose ?? 'any'}`)
  expect(purposes).toEqual(
    expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']),
  )

  for (const icon of manifest.icons) {
    const r = await request.get(icon.src)
    expect(r.status(), icon.src).toBe(200)
    expect(r.headers()['content-type']).toContain('image/png')
    // PNG IHDR holds the real pixel size: the manifest must not claim a size the file lacks.
    const body = await r.body()
    const w = body.readUInt32BE(16)
    const h = body.readUInt32BE(20)
    expect(`${w}x${h}`, icon.src).toBe(icon.sizes)
  }
})

test('with the shell precached, a refresh offline still opens the app shell', async ({
  page,
  context,
}) => {
  await installBackend(page, 'empty')
  await page.goto('/portfolio')
  await expect(page.getByRole('heading', { name: 'Portfolio', level: 1 })).toBeAttached()

  // Wait until the service worker is active, controlling this page, and has finished precaching.
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    if (navigator.serviceWorker.controller === null) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          resolve()
        })
        void reg.active
      })
    }
  })
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const names = await caches.keys()
        return names.some((n) => n.includes('precache'))
      }),
    )
    .toBe(true)

  await context.setOffline(true)
  await page.reload()
  // The shell comes from the precache and renders; no private data is shown because none was ever
  // cached. (navigator.onLine is deliberately not asserted here: Chromium keeps reporting true on
  // a page loaded under emulated offline, so the live offline/online events — covered in
  // p202-shell-dialog.spec.ts — are the reliable signal, and 'true' never proves connectivity.)
  await expect(page.getByRole('heading', { name: 'Portfolio', level: 1 })).toBeAttached()
  await expect(page.locator('main')).toBeVisible()
  await context.setOffline(false)
})
