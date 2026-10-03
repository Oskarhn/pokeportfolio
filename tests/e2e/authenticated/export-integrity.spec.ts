import { createClient } from '@supabase/supabase-js'
import { test, expect, type Download, type Page } from '@playwright/test'
import { EXPORT_CSV_FILENAMES } from '../../../src/domain/export/csv-projections'
import { parseCsvRfc } from '../../data/csv-rfc-parser'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  type SyntheticUser,
  type TestClient,
} from '../../db/setup'

/**
 * P157 — the official Export & backup UI and the Portfolio Quick CSV, driven in a real browser
 * against the local stack, with the downloaded FILES read back from disk.
 *
 * The delivery path is forced to the universal anchor-download fallback (Web Share and the save
 * picker are removed in an init script) so Playwright receives real `download` events; the
 * share/picker branches are covered by tests/ui/export-file-delivery.test.ts. Blob type and size
 * are captured at `URL.createObjectURL`, which is where the MIME type the user's file will carry
 * is decided.
 *
 * LOCAL ONLY (needs the local Supabase stack, like every authenticated spec). Every account is
 * synthetic and disposable.
 */

test.use({ storageState: { cookies: [], origins: [] } })
test.describe.configure({ mode: 'serial' })

const NOTE_RAW = ' =1+1\r\nsecond line, "quoted"'
const B_MARKER = 'B-PRIVATE-MARKER-e2e-77c1'
const HUGE = '9007199254740993' // 2^53 + 1

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser

interface BlobInfo {
  type: string
  size: number
}

declare global {
  interface Window {
    __exportBlobs?: BlobInfo[]
  }
}

async function nodeClient(user: SyntheticUser) {
  const url = process.env['SUPABASE_URL']
  const anonKey = process.env['SUPABASE_ANON_KEY']
  if (!url || !anonKey) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not set')
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (error) throw new Error(`sign-in failed: ${error.message}`)
  return { client, session: data.session }
}

test.beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p157-e2e-a')
  userB = await createSyntheticUser(service, 'p157-e2e-b')
  const { client } = await nodeClient(userA)
  const today = new Date().toISOString().slice(0, 10)

  const { data: retailer } = await service
    .from('retailers')
    .insert({ user_id: userA.id, name: '-Local Store' })
    .select('id')
    .single<{ id: string }>()
  const { data: purchase, error } = await client
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_retailer_id: retailer?.id ?? null,
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.charizardVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 10000,
        },
      ],
    })
    .single<{ id: string }>()
  if (error) throw new Error(`create_purchase failed: ${error.message}`)
  const { data: line } = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase.id)
    .single<{ id: string }>()
  const { data: lot } = await service
    .from('acquisition_lots')
    .select('id, holding_id')
    .eq('purchase_line_id', line?.id)
    .single<{ id: string; holding_id: string }>()
  await service.from('holdings').update({ notes: NOTE_RAW }).eq('id', lot?.holding_id)
  // A resolved current value beyond 2^53 — it must reach the Quick CSV digit for digit.
  const { error: valError } = await client.rpc('set_manual_valuation', {
    p_holding_id: lot?.holding_id,
    p_value_minor: HUGE,
    p_note: '@inert note',
    p_effective_from: today,
  })
  if (valError) throw new Error(`set_manual_valuation failed: ${valError.message}`)

  // Account B owns data with a recognisable marker that must never surface for A.
  const b = await nodeClient(userB)
  await service.from('retailers').insert({ user_id: userB.id, name: B_MARKER })
  await b.client.rpc('create_purchase', {
    p_purchased_on: today,
    p_currency: 'NOK',
    p_notes: B_MARKER,
    p_lines: [
      {
        line_type: 'card',
        card_variant_id: seedCatalog.pikachuVariantId,
        condition: 'NM',
        quantity: 1,
        unit_price_minor: 777,
      },
    ],
  })
})

test.afterAll(async () => {
  await deleteSyntheticUser(service, userB.id)
  await deleteSyntheticUser(service, userA.id)
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Force the anchor-download fallback and record every Blob a delivery hands to the browser.
    for (const key of ['share', 'canShare']) {
      try {
        Object.defineProperty(navigator, key, { value: undefined, configurable: true })
      } catch {
        /* property already locked — the fallback is still selected by the missing function */
      }
    }
    ;(window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined
    window.__exportBlobs = []
    const original = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (object: Blob | MediaSource) => {
      if (object instanceof Blob)
        window.__exportBlobs?.push({ type: object.type, size: object.size })
      return original(object)
    }
  })
  await page.goto('/login')
  await page.getByLabel('Email').fill(userA.email)
  await page.getByLabel('Password').fill(userA.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
})

async function readDownload(download: Download, testInfoDir: string): Promise<string> {
  const target = `${testInfoDir}/${download.suggestedFilename()}`
  await download.saveAs(target)
  const { readFile } = await import('node:fs/promises')
  return readFile(target, 'utf-8')
}

async function collectDownloads(page: Page, expected: number, action: () => Promise<void>) {
  const downloads: Download[] = []
  page.on('download', (d) => downloads.push(d))
  await action()
  await expect.poll(() => downloads.length, { timeout: 30_000 }).toBe(expected)
  return downloads
}

test('CSV suite: 11 real files, correct names, MIME, BOM, and safe, exact content', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  await page.goto('/profile/export')
  await page.getByRole('button', { name: 'Prepare CSV export' }).click()
  await expect(page.getByText(/Ready — CSV export, 11 files/)).toBeVisible({ timeout: 60_000 })
  const downloads = await collectDownloads(page, 11, async () => {
    await page.getByRole('button', { name: /Save \/ Share CSV export/ }).click()
  })
  await expect(page.getByText(/Downloaded 11 files/)).toBeVisible()

  const texts = new Map<string, string>()
  for (const d of downloads)
    texts.set(d.suggestedFilename(), await readDownload(d, testInfo.outputDir))
  expect([...texts.keys()].sort()).toEqual([...EXPORT_CSV_FILENAMES].sort())

  const blobs = (await page.evaluate(() => window.__exportBlobs)) ?? []
  expect(blobs).toHaveLength(11)
  for (const blob of blobs) expect(blob.type).toBe('text/csv;charset=utf-8')

  for (const [name, text] of texts) {
    const parsed = parseCsvRfc(text)
    expect(parsed.hadBom, name).toBe(true)
    expect(parsed.endsWithCrlf, name).toBe(true)
    for (const record of parsed.records)
      expect(record, name).toHaveLength(parsed.records[0]!.length)
  }
  const holdings = parseCsvRfc(texts.get('holdings.csv') ?? '').records
  const notesIndex = holdings[0]!.indexOf('Notes')
  expect(holdings[1]?.[notesIndex]).toBe(`'${NOTE_RAW}`) // formula-safe, CRLF and quote intact
  const purchases = parseCsvRfc(texts.get('purchases.csv') ?? '').records
  expect(purchases[1]?.[purchases[0]!.indexOf('Retailer')]).toBe("'-Local Store")
  const valuations = parseCsvRfc(texts.get('manual_valuations.csv') ?? '').records
  expect(valuations[1]?.[valuations[0]!.indexOf('Value')]).toBe('90071992547409.93')
  for (const text of texts.values()) {
    expect(text).not.toContain(B_MARKER)
    expect(text).not.toContain(userB.id)
  }
})

test('JSON backup: one real .json file with RAW text and exact wire money', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  await page.goto('/profile/export')
  await page.getByRole('button', { name: 'Create backup file' }).click()
  await expect(page.getByText(/Ready — backup/)).toBeVisible({ timeout: 60_000 })
  const downloads = await collectDownloads(page, 1, async () => {
    await page.getByRole('button', { name: /Save \/ Share backup/ }).click()
  })
  const [download] = downloads
  expect(download?.suggestedFilename()).toMatch(/^pokeportfolio-backup-\d{4}-\d{2}-\d{2}\.json$/)
  const text = await readDownload(download!, testInfo.outputDir)
  const blobs = (await page.evaluate(() => window.__exportBlobs)) ?? []
  expect(blobs).toHaveLength(1)
  expect(blobs[0]?.type).toBe('application/json')

  const envelope = JSON.parse(text) as {
    format: string
    data: { holdings: { notes: string | null }[]; manual_valuations: { value_minor: string }[] }
  }
  expect(envelope.format).toBe('pokeportfolio-backup')
  expect(envelope.data.holdings.some((h) => h.notes === NOTE_RAW)).toBe(true) // raw, no apostrophe
  expect(envelope.data.manual_valuations.map((v) => v.value_minor)).toContain(HUGE) // a string, exact
  expect(text).not.toContain(B_MARKER)
  expect(text).not.toContain(userA.email)
})

test('Quick CSV: real file, BOM, honest header, value past 2^53 written exactly', async ({
  page,
}, testInfo) => {
  await page.goto('/portfolio')
  const [download] = await collectDownloads(page, 1, async () => {
    await page.getByRole('button', { name: /Quick CSV/ }).click()
  }).then((d) => d)
  expect(download?.suggestedFilename()).toMatch(/^portfolio-export-\d{4}-\d{2}-\d{2}\.csv$/)
  const text = await readDownload(download!, testInfo.outputDir)
  const parsed = parseCsvRfc(text)
  expect(parsed.hadBom).toBe(true)
  expect(parsed.records[0]).toContain('Value status')
  expect(parsed.records[0]).not.toContain('Cost basis state')
  const valueIndex = parsed.records[0]!.indexOf('Current value (NOK)')
  expect(parsed.records[1]?.[valueIndex]).toBe('90071992547409.93')
  expect(text).not.toContain(B_MARKER)
})

test('an account switched in another tab mid-export fails the export and keeps nothing', async ({
  page,
}) => {
  test.setTimeout(120_000)
  // Slow every data request so the export is reliably still running when the switch lands.
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200))
    await route.continue()
  })
  const downloads: Download[] = []
  page.on('download', (d) => downloads.push(d))
  await page.goto('/profile/export')
  await page.getByRole('button', { name: 'Prepare CSV export' }).click()
  await expect(page.getByText('Preparing…')).toBeVisible()

  // What a second tab does: the shared session storage now holds B's session.
  const b = await nodeClient(userB)
  await page.evaluate((session) => {
    const key = Object.keys(localStorage).find((k) => k.endsWith('-auth-token'))
    if (!key) throw new Error('no supabase auth-token key in localStorage')
    localStorage.setItem(key, JSON.stringify(session))
  }, b.session)

  await expect(page.getByRole('alert')).toContainText(/account changed/i, { timeout: 60_000 })
  await expect(page.getByText(/Ready —/)).toHaveCount(0)
  expect(downloads).toHaveLength(0)
  await expect(page.locator('body')).not.toContainText(B_MARKER)
})

test('Cancel stops the export: no further requests, no files, no error', async ({ page }) => {
  test.setTimeout(120_000)
  let restRequests = 0
  await page.route('**/rest/v1/**', async (route) => {
    restRequests++
    await new Promise((resolve) => setTimeout(resolve, 250))
    await route.continue()
  })
  const downloads: Download[] = []
  page.on('download', (d) => downloads.push(d))
  await page.goto('/profile/export')
  await page.getByRole('button', { name: 'Prepare CSV export' }).click()
  await expect(page.getByText('Preparing…')).toBeVisible()
  await expect.poll(() => restRequests).toBeGreaterThan(2)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Preparing…')).toHaveCount(0)
  const atCancel = restRequests
  await page.waitForTimeout(1500)
  // At most the one request that was already in flight may still land.
  expect(restRequests - atCancel).toBeLessThanOrEqual(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText(/Ready —/)).toHaveCount(0)
  expect(downloads).toHaveLength(0)
})
