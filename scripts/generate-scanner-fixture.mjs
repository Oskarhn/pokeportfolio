#!/usr/bin/env node
/**
 * Generates NON-COPYRIGHTED synthetic card-like test imagery for scanner OCR work
 * (M15 prompt section 36, extended P88 §23/F-34): flat-colour 5:7 rectangles with invented text
 * laid out where real cards print the name strip and collector-number strip, for EVERY layout
 * family roi.ts's adaptive-ROI candidates target — not just the original vintage-only render
 * (F-34: the only prior fixture encoded exclusively the layout that was already proven wrong for
 * modern cards before this session, so a regression in the modern/Energy branch had no
 * image-based automated test to catch it). No real Pokémon artwork, photography or scans are
 * reproduced or committed — these are programmatic renders used only to exercise OCR end-to-end.
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

/**
 * `layout` positions text at the SAME fractional coordinates as the real roi.ts candidate it is
 * meant to exercise, so a real-OCR test can assert the matching layout candidate wins:
 * - 'vintage': name top-left (NAME_ROI_FRACTIONS), number bottom-right (NUMBER_ROI_FRACTIONS).
 * - 'modern': name top-full-width (MODERN_NAME_ROI_FRACTIONS), number bottom-left
 *   (MODERN_NUMBER_ROI_FRACTIONS) — also stands in for a Trainer-card layout, which shares this
 *   same top-name convention.
 * - 'energy': name bottom band (ENERGY_NAME_ROI_FRACTIONS, P88 F-17), no collector-number text
 *   (many real Basic Energy printings carry none legible at this scale).
 */
function cardHtml({ background, ink, banner, layout, name, number }) {
  const nameStyle =
    layout === 'vintage'
      ? { x: 36, y: 24, font: 'bold 34px sans-serif', align: 'left' }
      : layout === 'modern'
        ? { x: 24, y: 34, font: 'bold 38px sans-serif', align: 'left' }
        : { x: WIDTH / 2, y: 560, font: 'bold 40px sans-serif', align: 'center' }
  const numberStyle =
    layout === 'vintage'
      ? { x: WIDTH - 36, y: HEIGHT - 56, font: 'bold 30px sans-serif', align: 'right' }
      : { x: 24, y: 646, font: 'bold 28px sans-serif', align: 'left' }

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
  ctx.fillStyle = '${ink}'
  ctx.textBaseline = 'top'
  if (${name ? 'true' : 'false'}) {
    ctx.font = '${nameStyle.font}'
    ctx.textAlign = '${nameStyle.align}'
    ctx.fillText(${JSON.stringify(name ?? '')}, ${nameStyle.x}, ${nameStyle.y})
  }
  if (${number ? 'true' : 'false'}) {
    ctx.font = '${numberStyle.font}'
    ctx.textAlign = '${numberStyle.align}'
    ctx.fillText(${JSON.stringify(number ?? '')}, ${numberStyle.x}, ${numberStyle.y})
  }
}
</script></body></html>`
}

const variants = [
  {
    file: 'synthetic-card.png',
    background: '#e8e0cc',
    ink: '#111111',
    banner: '#4a6d8c',
    layout: 'vintage',
    name: 'TESTASAURUS',
    number: '049/102',
  },
  {
    // Low-contrast/glare-ish variant: same content, washed-out rendering.
    file: 'synthetic-card-lowcontrast.png',
    background: '#f4f2ea',
    ink: '#7a7a72',
    banner: '#93a5b5',
    layout: 'vintage',
    name: 'TESTASAURUS',
    number: '049/102',
  },
  {
    // F-34/P88 §23: real SM/SWSH/SV-era layout — top-full-width name, bottom-left number.
    file: 'synthetic-card-modern.png',
    background: '#e6e9f0',
    ink: '#101014',
    banner: '#5b6ea8',
    layout: 'modern',
    name: 'FAUXOSAUR EX',
    number: '049/197',
  },
  {
    // F-34/P88 §23: Trainer cards share the modern top-name convention (a different text shape —
    // no digits, an apostrophe — than a Pokémon name, exercising the same candidate honestly).
    file: 'synthetic-card-trainer.png',
    background: '#f0ead6',
    ink: '#161616',
    banner: '#b08d3f',
    layout: 'modern',
    name: "PROFEXOR'S ORDERS",
    number: '178/197',
  },
  {
    // F-17/F-34/P88 §14/§23: Basic Energy — name in a bottom band, no legible number.
    file: 'synthetic-card-energy.png',
    background: '#f6efe0',
    ink: '#1a1208',
    banner: '#c94f3d',
    layout: 'energy',
    name: 'FAUX ENERGY',
    number: null,
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
