#!/usr/bin/env node
/**
 * Generates NON-COPYRIGHTED synthetic card-like test imagery for scanner OCR work
 * (M15 prompt section 36): a flat-colour 5:7 rectangle with invented text ("TESTASAURUS",
 * "049/102") laid out where real cards print the name strip and collector-number strip. No real
 * Pokémon artwork, photography or scans are reproduced or committed - these are programmatic
 * renders used only to exercise OCR end-to-end.
 *
 * Run manually once per fixture change:  node scripts/generate-scanner-fixture.mjs
 * Requires Playwright's chromium (`pnpm exec playwright install chromium` if missing).
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'tests', 'fixtures', 'scanner')
mkdirSync(outDir, { recursive: true })

const WIDTH = 500
const HEIGHT = 700

function cardHtml({ background, ink, banner }) {
  return `<!doctype html>
<html><body style="margin:0">
<canvas id="c" width="${WIDTH}" height="${HEIGHT}"></canvas>
<script>
{
  const c = document.getElementById('c')
  const ctx = c.getContext('2d')
  // Flat card body (no artwork - invented, copyright-free geometry only)
  ctx.fillStyle = '${background}'
  ctx.fillRect(0, 0, ${WIDTH}, ${HEIGHT})
  ctx.strokeStyle = '#222222'
  ctx.lineWidth = 6
  ctx.strokeRect(3, 3, ${WIDTH - 6}, ${HEIGHT - 6})
  // Faux "art window": plain rectangles, nothing resembling any real card
  ctx.fillStyle = '${banner}'
  ctx.fillRect(40, 150, 420, 300)
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  for (let i = 0; i < 5; i++) ctx.fillRect(60 + i * 80, 170, 50, 260)
  // Name strip: top-left, matching the researched ROI layout
  ctx.fillStyle = '${ink}'
  ctx.font = 'bold 44px sans-serif'
  ctx.textBaseline = 'top'
  ctx.fillText('TESTASAURUS', 36, 24)
  // Collector-number strip: bottom-right, "NNN/TOTAL"
  ctx.font = 'bold 30px sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText('049/102', ${WIDTH - 36}, ${HEIGHT - 56})
}
</script></body></html>`
}

const variants = [
  { file: 'synthetic-card.png', background: '#e8e0cc', ink: '#111111', banner: '#4a6d8c' },
  {
    // Low-contrast/glare-ish variant: same content, washed-out rendering.
    file: 'synthetic-card-lowcontrast.png',
    background: '#f4f2ea',
    ink: '#7a7a72',
    banner: '#93a5b5',
  },
]

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
  for (const variant of variants) {
    await page.setContent(cardHtml(variant))
    const canvas = page.locator('#c')
    await canvas.screenshot({ path: join(outDir, variant.file), type: 'png' })
    console.log(`wrote ${variant.file}`)
  }
} finally {
  await browser.close()
}
