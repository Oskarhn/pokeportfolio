/**
 * P151 real-browser scanner benchmark — run it against ANY built copy of the app (`pnpm build &&
 * pnpm preview --port N`), so the same script measures the baseline and the hardened build.
 *
 *   pnpm exec tsx scripts/scanner-p151/browser-bench.mjs --url http://localhost:4391 --label after \
 *        [--cold 5] [--scans 10] [--cancel 6] [--cpu 1] [--out result.json]
 *
 * WHAT IT IS: headless desktop Chromium driving the real `/scan` UI (real Web Workers, real
 * Tesseract + DINOv2 assets, real React), synthetic fixtures only (tests/fixtures/scanner), a fake
 * signed-in session, and a stubbed catalog RPC that answers "no rows" so every scan runs the FULL
 * pipeline (decode -> rectify -> OCR passes -> visual embed + search -> ranking) and ends on the
 * no-match screen, from which the next scan starts inside the same mounted scanner.
 *
 * WHAT IT IS NOT: an iPhone. Absolute numbers are this machine's CPU (--cpu N applies Chromium CPU
 * throttling as a crude stand-in for slower hardware) and say nothing about Safari, iOS memory
 * pressure or a cellular network. Timings are wall-clock from the driver (rAF-polled, ~16 ms
 * resolution). Memory figures are PROXIES: main-thread JS heap after a forced GC; worker heaps and
 * WASM memory are not observable from here and are NOT included. Compare label-to-label on the same
 * machine in the same run window; do not quote them as device numbers.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '@playwright/test'
import sharp from 'sharp'
import { installFakeSession } from '../../tests/e2e/support/fake-session.ts'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const URL_BASE = opt('url', 'http://localhost:4391')
const LABEL = opt('label', 'run')
const COLD_RUNS = Number(opt('cold', '5'))
const WARM_SCANS = Number(opt('scans', '10'))
const CANCEL_RUNS = Number(opt('cancel', '6'))
const CPU = Number(opt('cpu', '1'))
const OUT = opt('out', '')

const CARD = readFileSync(path.resolve('tests/fixtures/scanner/synthetic-card.png'))
/** Worst case for the OCR stage: nothing readable anywhere, so every ROI layout, every preprocessing
 *  pass and the full-card fallback all run. Seeded noise, deterministic. */
async function noiseCard() {
  const width = 500
  const height = 700
  const raw = Buffer.alloc(width * height * 3)
  let seed = 151
  for (let i = 0; i < raw.length; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    raw[i] = 90 + ((seed >>> 24) % 70)
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer()
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)]
}
const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? null : s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]
}
const round = (x) => (x === null ? null : Math.round(x))

const browser = await chromium.launch()

async function newSession() {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 430, height: 900 },
  })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })
  const failures = []
  page.on('pageerror', (e) => failures.push(`pageerror: ${e.message.slice(0, 120)}`))
  await installFakeSession(page)
  // Stub the catalog so a scan completes: no rows -> NO_MATCH, i.e. the whole pipeline ran.
  await page.route('**/rest/v1/rpc/search_cards*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  )
  await page.route('**/rest/v1/cards*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  )
  const workers = new Set()
  page.on('worker', (w) => {
    workers.add(w)
    w.on('close', () => workers.delete(w))
  })
  return { context, page, cdp, failures, workers }
}

const analyzing = (page) => page.getByText(/Preparing scanner…|Analyzing card…/)

async function chooseFile(page, buffer, name = 'card.png') {
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: 'image/png', buffer })
  await page.getByRole('button', { name: 'Use photo' }).waitFor({ timeout: 30_000 })
}

/** Click "Use photo" and return ms until the analysis has finished (analysing view gone). */
async function timeScan(page) {
  const t0 = performance.now()
  await page.getByRole('button', { name: 'Use photo' }).click()
  await analyzing(page).waitFor({ state: 'visible', timeout: 10_000 })
  const uiMs = performance.now() - t0
  await analyzing(page).waitFor({ state: 'hidden', timeout: 180_000 })
  return { totalMs: performance.now() - t0, uiMs }
}

async function heapMb(cdp) {
  await cdp.send('HeapProfiler.collectGarbage')
  const { usedSize } = await cdp.send('Runtime.getHeapUsage')
  return usedSize / 1024 / 1024
}

const result = {
  label: LABEL,
  url: URL_BASE,
  environment: {
    date: new Date().toISOString(),
    platform: `${os.platform()} ${os.release()}`,
    cpu: `${os.cpus()[0]?.model ?? '?'} x${os.cpus().length}`,
    chromium: browser.version(),
    cpuThrottle: CPU,
    note: 'headless desktop Chromium, synthetic fixtures, stubbed catalog; NOT an iPhone',
  },
  failures: [],
}

// --- 1. COLD: fresh profile, wait for the OCR runtime ("Preparing card recognition…") to clear ----
{
  const readyMs = []
  const firstScanMs = []
  for (let run = 0; run < COLD_RUNS; run += 1) {
    const s = await newSession()
    const t0 = performance.now()
    await s.page.goto(`${URL_BASE}/scan`)
    await s.page.getByRole('heading', { name: 'Scan cards' }).waitFor()
    await s.page
      .getByText('Preparing card recognition…')
      .waitFor({ state: 'hidden', timeout: 180_000 })
      .catch(() => s.failures.push('ocr never became ready'))
    readyMs.push(performance.now() - t0)
    await s.context.close()
    result.failures.push(...s.failures)

    // First scan in a fresh profile WITHOUT waiting for readiness: includes OCR init and the
    // bounded (8 s) wait for the still-cold visual channel.
    const c = await newSession()
    await c.page.goto(`${URL_BASE}/scan`)
    await c.page.getByRole('heading', { name: 'Scan cards' }).waitFor()
    await chooseFile(c.page, CARD)
    const { totalMs } = await timeScan(c.page)
    firstScanMs.push(totalMs)
    await c.context.close()
    result.failures.push(...c.failures)
  }
  result.cold = {
    runs: COLD_RUNS,
    ocrReadyMs: {
      median: round(median(readyMs)),
      p95: round(p95(readyMs)),
      samples: readyMs.map(round),
    },
    firstScanImmediatelyMs: {
      median: round(median(firstScanMs)),
      p95: round(p95(firstScanMs)),
      samples: firstScanMs.map(round),
    },
  }
}

// --- 2. WARM: one mounted scanner, repeated full scans; memory proxy + resource counts -----------
{
  const s = await newSession()
  const { page, cdp } = s
  await page.goto(`${URL_BASE}/scan`)
  await page.getByRole('heading', { name: 'Scan cards' }).waitFor()
  await chooseFile(page, CARD)
  // Warm-up: the first scans absorb OCR init + visual model/index load + JIT.
  for (let i = 0; i < 2; i += 1) {
    await timeScan(page)
    await page.getByRole('button', { name: 'Choose another photo' }).waitFor()
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: CARD })
    await page.getByRole('button', { name: 'Use photo' }).waitFor()
  }
  const heapBefore = await heapMb(cdp)
  const totals = []
  const uis = []
  let completed = 0
  for (let i = 0; i < WARM_SCANS; i += 1) {
    try {
      const { totalMs, uiMs } = await timeScan(page)
      totals.push(totalMs)
      uis.push(uiMs)
      completed += 1
    } catch (error) {
      s.failures.push(`warm scan ${i}: ${String(error).slice(0, 100)}`)
      break
    }
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: CARD })
    await page.getByRole('button', { name: 'Use photo' }).waitFor({ timeout: 30_000 })
  }
  const heapAfter = await heapMb(cdp)
  const decode = await page.evaluate(
    async (bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      const times = []
      for (let i = 0; i < 30; i += 1) {
        const t = performance.now()
        const bitmap = await createImageBitmap(blob)
        times.push(performance.now() - t)
        bitmap.close()
      }
      times.sort((a, b) => a - b)
      return times[Math.floor((times.length - 1) / 2)]
    },
    [...CARD],
  )
  result.warm = {
    scans: WARM_SCANS,
    completed,
    scanTotalMs: {
      median: round(median(totals)),
      p95: round(p95(totals)),
      samples: totals.map(round),
    },
    clickToAnalyzingViewMs: { median: round(median(uis)) },
    decode500x700PngMs: Math.round(decode * 10) / 10,
    mainThreadJsHeapMb: {
      beforeScans: Math.round(heapBefore * 10) / 10,
      afterScans: Math.round(heapAfter * 10) / 10,
    },
    liveWorkers: s.workers.size,
  }
  result.failures.push(...s.failures)
  await s.context.close()
}

// --- 3. CANCEL -> RESTART with the worst-case (nothing readable) image ---------------------------
{
  const s = await newSession()
  const { page } = s
  const noise = await noiseCard()
  await page.goto(`${URL_BASE}/scan`)
  await page.getByRole('heading', { name: 'Scan cards' }).waitFor()
  await chooseFile(page, noise, 'noise.png')
  await timeScan(page) // warm-up (init + JIT)
  await page
    .getByRole('button', { name: 'Choose another photo' })
    .click({ trial: true })
    .catch(() => undefined)
  const solo = []
  const restart = []
  const restartBeforeAbortMs = 250
  for (let run = 0; run < CANCEL_RUNS; run += 1) {
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'noise.png', mimeType: 'image/png', buffer: noise })
    await page.getByRole('button', { name: 'Use photo' }).waitFor({ timeout: 30_000 })
    solo.push((await timeScan(page)).totalMs)

    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'noise.png', mimeType: 'image/png', buffer: noise })
    await page.getByRole('button', { name: 'Use photo' }).waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Use photo' }).click()
    await analyzing(page).waitFor({ state: 'visible' })
    await page.waitForTimeout(restartBeforeAbortMs)
    await page.getByRole('button', { name: 'Back' }).click() // cancel
    await page.getByRole('button', { name: 'Use photo' }).waitFor({ timeout: 30_000 })
    restart.push((await timeScan(page)).totalMs)
  }
  result.cancelRestart = {
    runs: CANCEL_RUNS,
    abandonedAfterMs: restartBeforeAbortMs,
    soloWorstCaseScanMs: { median: round(median(solo)), samples: solo.map(round) },
    scanStartedRightAfterCancelMs: {
      median: round(median(restart)),
      p95: round(p95(restart)),
      samples: restart.map(round),
    },
    extraLatencyAfterCancelMs: round(median(restart) - median(solo)),
  }
  result.failures.push(...s.failures)
  await s.context.close()
}

await browser.close()
if (OUT !== '') writeFileSync(OUT, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
