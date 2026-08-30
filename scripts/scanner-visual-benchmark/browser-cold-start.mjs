#!/usr/bin/env node
/**
 * P81 §16: a REAL-BROWSER cold/warm-start benchmark over the visual worker's ACTUAL production
 * code path — the built `dist/assets/visual-worker-*.js` chunk, not a mock and not the Node-based
 * `embed.mjs` harness P76/P79 used (that measures embedding QUALITY over a corpus; this measures
 * INITIALIZATION LATENCY, a different axis this repository had never measured in a real browser
 * before this session).
 *
 * What this can and cannot prove: it drives Chromium/WebKit on THIS machine over `localhost` —
 * desktop hardware, desktop network stack (effectively zero latency to `pnpm preview`). It is NOT
 * an iPhone measurement and every number this script prints is explicitly labeled DESKTOP. Its
 * purpose is to isolate compile/instantiate/decode cost from network transfer time under
 * controlled, reproducible conditions — the real-device retest (owner, real iPhone, real cellular/
 * WiFi) is what confirms whether the fixes here also fix the 388s/6-7-minute real-device reports.
 *
 * Prerequisites: `pnpm build` has already produced `dist/` with `VITE_SUPABASE_URL`/
 * `VITE_SUPABASE_PUBLISHABLE_KEY` set (any placeholder value works — this harness never reaches
 * Supabase). This script starts and stops its own `vite preview` instance.
 *
 * Usage:
 *   pnpm build
 *   node scripts/scanner-visual-benchmark/browser-cold-start.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from '@playwright/test'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const distAssets = fileURLToPath(new URL('../../dist/assets/', import.meta.url))
const PORT = 4174
// `localhost`, not a literal 127.0.0.1: on this machine `vite preview` binds the IPv6 loopback
// (`::1`) by default, and a literal IPv4 address would never connect to it.
const BASE_URL = `http://localhost:${PORT}`

function findVisualWorkerChunk() {
  if (!existsSync(distAssets)) {
    throw new Error('dist/assets not found — run `pnpm build` before this script.')
  }
  const match = readdirSync(distAssets).find(
    (name) => name.startsWith('visual-worker-') && name.endsWith('.js'),
  )
  if (!match) {
    throw new Error(
      'No visual-worker-*.js chunk found in dist/assets — did the scanner visual worker fail to build as a lazy chunk?',
    )
  }
  return `/assets/${match}`
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`Preview server at ${url} did not become ready within ${String(timeoutMs)}ms.`)
}

/** Runs entirely inside the page — constructs the REAL worker chunk directly (no React app, no
 *  routing, no authentication boundary: this is a static asset any origin visitor can fetch). */
async function runInPage(page, workerPath, { forceWasm }) {
  return page.evaluate(
    async ([workerPath, forceWasm]) => {
      function timedResult(startedAt) {
        return Math.round(performance.now() - startedAt)
      }
      const constructedAtMs = performance.timeOrigin + performance.now()
      const worker = new Worker(workerPath, { type: 'module' })
      const readyInfo = await new Promise((resolve) => {
        worker.addEventListener('message', (event) => {
          if (event.data?.type === 'ready' || event.data?.type === 'unavailable') {
            resolve(event.data)
          }
        })
        worker.addEventListener('error', (event) => {
          resolve({
            type: 'unavailable',
            reason: `worker error: ${event.message}`,
            phaseTimings: null,
          })
        })
        worker.postMessage({
          type: 'init',
          backendOverride: forceWasm ? 'wasm' : 'auto',
          constructedAtMs,
        })
      })

      async function embedOnce(requestId) {
        const canvas = document.createElement('canvas')
        canvas.width = 224
        canvas.height = 224
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = `rgb(${String((requestId * 37) % 255)},120,200)`
        ctx.fillRect(0, 0, 224, 224)
        const bitmap = await createImageBitmap(canvas)
        const start = performance.now()
        const result = await new Promise((resolve) => {
          worker.addEventListener('message', function handler(event) {
            if (event.data?.requestId === requestId) {
              worker.removeEventListener('message', handler)
              resolve(event.data)
            }
          })
          worker.postMessage({ type: 'embed-and-search', requestId, bitmap, topK: 5 }, [bitmap])
        })
        return { ms: timedResult(start), ok: result.type === 'result' }
      }

      let firstEmbedMs = null
      let secondEmbedMs = null
      if (readyInfo.type === 'ready' && readyInfo.indexAvailable) {
        const first = await embedOnce(1)
        firstEmbedMs = first.ok ? first.ms : null
        const second = await embedOnce(2)
        secondEmbedMs = second.ok ? second.ms : null
      }

      worker.terminate()
      return { readyInfo, firstEmbedMs, secondEmbedMs }
    },
    [workerPath, forceWasm],
  )
}

async function benchmarkEngine(engineName, launcher, workerPath) {
  let browser
  try {
    browser = await launcher.launch()
  } catch (error) {
    console.log(`\n=== ${engineName}: NOT AVAILABLE (${error.message.split('\n')[0]}) ===`)
    return null
  }

  console.log(`\n=== ${engineName} (DESKTOP — local machine, localhost network) ===`)

  // Scenario A: fresh context, HTTP cache disabled, fresh Cache Storage — the closest local
  // proxy to a genuine first-ever visit (P81 §16 "cold-ish load with browser cache disabled").
  const coldContext = await browser.newContext()
  const coldPage = await coldContext.newPage()
  const cdp = engineName === 'chromium-desktop' ? await coldContext.newCDPSession(coldPage) : null
  if (cdp) await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await coldPage.goto(BASE_URL)
  const coldStart = performance.now()
  const cold = await runInPage(coldPage, workerPath, { forceWasm: true })
  const coldWallMs = Math.round(performance.now() - coldStart)
  await coldPage.close()

  console.log(
    `COLD (cache disabled): ready=${cold.readyInfo.type} totalMs=${String(coldWallMs)} ` +
      `modelColdLoadMs=${String(cold.readyInfo.modelColdLoadMs ?? 'n/a')} ` +
      `firstEmbedMs=${String(cold.firstEmbedMs)} secondEmbedMs=${String(cold.secondEmbedMs)}`,
  )
  if (cold.readyInfo.phaseTimings) {
    console.log('  phaseTimings:', JSON.stringify(cold.readyInfo.phaseTimings))
  } else {
    console.log(`  unavailable reason: ${cold.readyInfo.reason}`)
  }

  // Scenario B: SAME context, reload — HTTP cache + this worker's own Cache Storage layer
  // (P81 §8) are now warm (P81 §16 "warm load with cache enabled").
  const warmPage = await coldContext.newPage()
  await warmPage.goto(BASE_URL)
  const warmStart = performance.now()
  const warm = await runInPage(warmPage, workerPath, { forceWasm: true })
  const warmWallMs = Math.round(performance.now() - warmStart)
  await warmPage.close()

  console.log(
    `WARM (same context, reloaded): ready=${warm.readyInfo.type} totalMs=${String(warmWallMs)} ` +
      `modelColdLoadMs=${String(warm.readyInfo.modelColdLoadMs ?? 'n/a')} ` +
      `firstEmbedMs=${String(warm.firstEmbedMs)} secondEmbedMs=${String(warm.secondEmbedMs)}`,
  )
  if (warm.readyInfo.phaseTimings) {
    console.log('  phaseTimings:', JSON.stringify(warm.readyInfo.phaseTimings))
  }

  await coldContext.close()
  await browser.close()
  return { cold: { wallMs: coldWallMs, ...cold }, warm: { wallMs: warmWallMs, ...warm } }
}

async function main() {
  const workerPath = findVisualWorkerChunk()
  console.log(`Visual worker chunk: ${workerPath}`)

  const preview = spawn('pnpm', ['preview', '--port', String(PORT), '--strictPort'], {
    cwd: repoRoot,
    stdio: 'pipe',
    shell: true,
  })
  let previewOutput = ''
  preview.stdout.on('data', (chunk) => {
    previewOutput += String(chunk)
  })
  preview.stderr.on('data', (chunk) => {
    previewOutput += String(chunk)
  })

  try {
    try {
      await waitForServer(BASE_URL)
    } catch (error) {
      console.error(`--- preview process output ---\n${previewOutput}`)
      throw error
    }
    const results = {
      chromium: await benchmarkEngine('chromium-desktop', chromium, workerPath),
      webkit: await benchmarkEngine('webkit-desktop', webkit, workerPath),
    }
    console.log(
      '\n=== SUMMARY (all figures DESKTOP — see file header for what this can/cannot prove) ===',
    )
    console.log(JSON.stringify(results, null, 2))
  } finally {
    preview.kill()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
