#!/usr/bin/env node
/**
 * Generates the P184 adversarial scanner fixtures: NON-COPYRIGHTED, programmatic card-like
 * imagery (invented names, procedural "art" made of seeded gradients and shapes, no Pokémon
 * artwork or scan is reproduced or committed). Each image is a 1200x1600 (3:4, phone-photo shaped)
 * JPEG rendered by Chromium from generated HTML, so every distortion — perspective, blur, glare,
 * crop, rotation, distant card, no card — is a real render, not a mock.
 *
 *   node scripts/p184/generate-fixtures.mjs        writes tests/fixtures/scanner-p184/*.jpg + manifest.json
 *
 * The manifest records, per fixture, what the printed card says and which policy the fixture
 * exercises; it never records an expected card id — the catalog rows and the visual neighbours the
 * scenarios need are derived from a DEVICE calibration run (scripts/p184/scenario-catalog.mjs).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', '..', 'tests', 'fixtures', 'scanner-p184')
mkdirSync(outDir, { recursive: true })

const W = 1200
const H = 1600

/** Small seeded PRNG so the procedural art is identical on every machine. */
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function artSvg(seed) {
  const r = rng(seed)
  const hue = Math.floor(r() * 360)
  const shapes = []
  for (let i = 0; i < 9; i += 1) {
    const h = (hue + Math.floor(r() * 140)) % 360
    const kind = r()
    const x = Math.floor(r() * 520)
    const y = Math.floor(r() * 330)
    const size = 40 + Math.floor(r() * 170)
    shapes.push(
      kind < 0.5
        ? `<circle cx="${x}" cy="${y}" r="${size}" fill="hsl(${h} 70% ${35 + Math.floor(r() * 35)}%)" opacity="0.85"/>`
        : `<polygon points="${x},${y} ${x + size * 2},${y + size / 2} ${x + size / 2},${y + size * 2}" fill="hsl(${h} 75% ${30 + Math.floor(r() * 40)}%)" opacity="0.8"/>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="340" viewBox="0 0 540 340">
    <defs><linearGradient id="g${seed}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 60% 22%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 65% 48%)"/>
    </linearGradient></defs>
    <rect width="540" height="340" fill="url(#g${seed})"/>${shapes.join('')}</svg>`
}

/** One card, 630x880 CSS px (5:7). Layout: name top-left, art, text, then illustrator, then the
 *  collector number on its own line bottom-left (kept on separate rows so an OCR line never merges
 *  the number with the illustrator credit). */
function cardHtml({ name, number, seed }) {
  return `<div class="card">
    <div class="name">${name}</div>
    <div class="art">${artSvg(seed)}</div>
    <div class="text">Invented ability text for a synthetic test card. It describes nothing real.</div>
    <div class="illus">Illus. Synthetic Studio</div>
    <div class="num">${number}</div>
  </div>`
}

const CARD_CSS = `
  .card{width:630px;height:880px;box-sizing:border-box;border:22px solid #d9b83a;border-radius:26px;background:#f3ecd2;position:relative;font-family:Arial,Helvetica,sans-serif;color:#151515;overflow:hidden}
  .name{position:absolute;left:34px;top:26px;font-size:54px;font-weight:700;letter-spacing:1px}
  .art{position:absolute;left:34px;top:120px;width:540px;height:340px;border:4px solid #444}
  .art svg{display:block}
  .text{position:absolute;left:34px;top:490px;width:540px;font-size:26px;line-height:34px;color:#333}
  .illus{position:absolute;left:34px;top:730px;font-size:20px;color:#555}
  .num{position:absolute;left:34px;top:764px;font-size:34px;font-weight:700}
`

function sceneHtml({ body, canvasBg = '#2b2118' }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:${canvasBg}}
    #scene{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:${canvasBg}}
    .table{position:absolute;inset:0;background:
      radial-gradient(ellipse at 30% 20%, #5a4530 0%, #2b2118 65%),
      repeating-linear-gradient(95deg, rgba(255,255,255,0.03) 0 6px, rgba(0,0,0,0.05) 6px 14px)}
    ${CARD_CSS}
    .holder{position:absolute;left:0;top:0;width:${W}px;height:${H}px;display:flex;align-items:center;justify-content:center}
    .fit{transform-origin:center center}
  </style></head><body><div id="scene"><div class="table"></div>${body}</div></body></html>`
}

// The card is 630x880 (+border box already inside); scale so it fills ~92% of the frame height.
const FILL = 1480 / 880

const CARDS = {
  sparkfin: { name: 'Sparkfin', number: '007/999', seed: 1101 },
  voltmoth: { name: 'Voltmoth', number: '012/999', seed: 2202 },
  emberlyn: { name: 'Emberlyn', number: '044/999', seed: 3303 },
  glimmerfox: { name: 'Glimmerfox', number: '015/999', seed: 4404 },
  duskwing: { name: 'Duskwing', number: '023/999', seed: 5505 },
  zzyzx: { name: 'Zzyzx Quorble', number: '555/999', seed: 6606 },
  // Named after the P169 catalog fixture cards (supabase stack, scripts/p169/catalog-fixture.mjs) so
  // the printed text finds real rows WITH printings and mock prices: the scanner -> Price Check ->
  // Add flows run on them.
  p169zard: { name: 'P169 Charizard', number: '004/102', seed: 7707 },
  p169pika: { name: 'P169 Pikachu', number: '025/102', seed: 8808 },
}

function placed(card, css) {
  return `<div class="holder"><div class="fit" style="${css}">${cardHtml(card)}</div></div>`
}

const fill = `transform:scale(${FILL});`

/** Every fixture: id, what it exercises, the printed text, and the HTML that renders it. */
const FIXTURES = [
  {
    id: 'f01-clean',
    scenario: 'clean',
    card: CARDS.sparkfin,
    html: sceneHtml({ body: placed(CARDS.sparkfin, fill) }),
  },
  {
    id: 'f02-perspective',
    scenario: 'perspective',
    card: CARDS.sparkfin,
    html: sceneHtml({
      body: `<div class="holder" style="perspective:1400px"><div class="fit" style="transform:scale(${FILL * 0.92}) rotateY(26deg) rotateX(10deg) rotateZ(-3deg)">${cardHtml(CARDS.sparkfin)}</div></div>`,
    }),
  },
  {
    id: 'f03-blur-moderate',
    scenario: 'moderate blur',
    card: CARDS.sparkfin,
    html: sceneHtml({
      body: `<div style="filter:blur(3.2px)">${placed(CARDS.sparkfin, fill)}</div>`,
    }),
  },
  {
    id: 'f04-blur-severe',
    scenario: 'severe blur',
    card: CARDS.sparkfin,
    html: sceneHtml({
      body: `<div style="filter:blur(16px)">${placed(CARDS.sparkfin, fill)}</div>`,
    }),
  },
  {
    id: 'f05-glare',
    scenario: 'glare across name and number',
    card: CARDS.sparkfin,
    html: sceneHtml({
      body:
        placed(CARDS.sparkfin, fill) +
        `<div style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;background:
          radial-gradient(ellipse 520px 300px at 45% 22%, rgba(255,255,255,0.97) 0%, rgba(255,255,255,0.75) 45%, rgba(255,255,255,0) 100%),
          radial-gradient(ellipse 560px 260px at 40% 88%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.7) 45%, rgba(255,255,255,0) 100%)"></div>`,
    }),
  },
  {
    id: 'f06-cropped-top',
    scenario: 'top of the card cut off (no name)',
    card: CARDS.sparkfin,
    html: sceneHtml({
      body: placed(CARDS.sparkfin, `transform:translateY(-330px) scale(${FILL});`),
    }),
  },
  {
    id: 'f07-cropped-bottom',
    scenario: 'bottom of the card cut off (no number)',
    card: CARDS.sparkfin,
    html: sceneHtml({
      body: placed(CARDS.sparkfin, `transform:translateY(330px) scale(${FILL});`),
    }),
  },
  {
    id: 'f08-upside-down',
    scenario: 'card upside-down',
    card: CARDS.sparkfin,
    html: sceneHtml({ body: placed(CARDS.sparkfin, `transform:scale(${FILL}) rotate(180deg);`) }),
  },
  {
    id: 'f09-rotated-90',
    scenario: 'card rotated 90 degrees',
    card: CARDS.sparkfin,
    html: sceneHtml({ body: placed(CARDS.sparkfin, `transform:scale(${1.12}) rotate(90deg);`) }),
  },
  {
    id: 'f10-tiny-in-background',
    scenario: 'small card far away among clutter',
    card: CARDS.sparkfin,
    html: sceneHtml({
      body:
        Array.from({ length: 26 }, (_, i) => {
          const r = rng(900 + i)
          const w = 120 + Math.floor(r() * 300)
          return `<div style="position:absolute;left:${Math.floor(r() * (W - w))}px;top:${Math.floor(r() * (H - 90))}px;width:${w}px;height:${50 + Math.floor(r() * 130)}px;background:hsl(${Math.floor(r() * 360)} 45% ${25 + Math.floor(r() * 35)}%);border-radius:${Math.floor(r() * 30)}px;transform:rotate(${Math.floor(r() * 90) - 45}deg)"></div>`
        }).join('') +
        `<div style="position:absolute;left:760px;top:1040px;transform:scale(0.24);transform-origin:top left">${cardHtml(CARDS.sparkfin)}</div>`,
    }),
  },
  {
    id: 'f11-non-card',
    scenario: 'not a card at all',
    card: null,
    html: sceneHtml({
      canvasBg: '#c8d6d0',
      body: `<div style="position:absolute;inset:0;background:linear-gradient(160deg,#9db8ad,#e7e0c9 55%,#b4a58a);font-family:Arial;color:#233">
        <div style="position:absolute;left:120px;top:160px;font-size:64px;font-weight:700">Grocery list</div>
        <div style="position:absolute;left:120px;top:280px;font-size:44px;line-height:78px">Milk<br>Bread<br>Coffee beans<br>Apples</div>
        <div style="position:absolute;left:640px;top:820px;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle,#e8c26a,#b3742f)"></div></div>`,
    }),
  },
  {
    id: 'f12-unknown-card',
    scenario: 'a card that exists in no catalog',
    card: CARDS.zzyzx,
    html: sceneHtml({ body: placed(CARDS.zzyzx, fill) }),
  },
  {
    id: 'f13-ocr-vs-visual',
    scenario: 'OCR says one card, the artwork resembles another',
    card: CARDS.voltmoth,
    html: sceneHtml({ body: placed(CARDS.voltmoth, fill) }),
  },
  {
    id: 'f14-visual-vs-number',
    scenario: 'artwork resembles one card, the printed number belongs to another',
    card: CARDS.emberlyn,
    html: sceneHtml({ body: placed(CARDS.emberlyn, fill) }),
  },
  {
    id: 'f15-same-art-reprint',
    scenario: 'two catalog printings share this artwork',
    card: CARDS.glimmerfox,
    html: sceneHtml({ body: placed(CARDS.glimmerfox, fill) }),
  },
  {
    id: 'f16-duplicate-number',
    scenario: 'same collector number exists in two sets',
    card: CARDS.duskwing,
    html: sceneHtml({ body: placed(CARDS.duskwing, fill) }),
  },
  {
    id: 'f17-p169-charizard',
    scenario: 'text names a seeded card with two printings (flow fixture)',
    card: CARDS.p169zard,
    html: sceneHtml({ body: placed(CARDS.p169zard, fill) }),
  },
  {
    id: 'f18-p169-pikachu',
    scenario: 'same name and number in two sets with different printings (flow fixture)',
    card: CARDS.p169pika,
    html: sceneHtml({ body: placed(CARDS.p169pika, fill) }),
  },
]

const browser = await chromium.launch()
const manifest = []
try {
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  for (const f of FIXTURES) {
    await page.setContent(f.html, { waitUntil: 'load' })
    const file = `${f.id}.jpg`
    await page.screenshot({
      path: join(outDir, file),
      type: 'jpeg',
      quality: 88,
      clip: { x: 0, y: 0, width: W, height: H },
    })
    manifest.push({
      id: f.id,
      file,
      scenario: f.scenario,
      printed: f.card === null ? null : { name: f.card.name, number: f.card.number },
      artSeed: f.card === null ? null : f.card.seed,
    })
  }
} finally {
  await browser.close()
}
writeFileSync(
  join(outDir, 'manifest.json'),
  `${JSON.stringify({ generator: 'scripts/p184/generate-fixtures.mjs', size: { width: W, height: H }, fixtures: manifest }, null, 2)}\n`,
)
console.log(`wrote ${String(manifest.length)} fixtures to ${outDir}`)
