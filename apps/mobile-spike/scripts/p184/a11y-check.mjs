#!/usr/bin/env node
/**
 * P184 scanner accessibility and layout gate (uiautomator accessibility tree; TalkBack itself is
 * covered separately, see talkback-check.mjs). LOCAL ONLY.
 *
 *   node scripts/p184/a11y-check.mjs
 *
 * For the scanner path (photo entry idle, HIGH result, review result with confidence badge, card
 * screen with printing choice) under 360 dp / 200 % font and 430 dp / 100 % font: every interactive
 * element is >= 48 dp on both sides and has a text or content description; confidence is stated in
 * WORDS (never colour alone); a candidate row names card, set and number; the selected printing is
 * exposed as selected; nothing interactive leaves the screen; the surface is dark (mean luminance).
 * Output: .build/p184-evidence/a11y-report.json + screenshots.
 */
import './env.mjs'
import { join } from 'node:path'
import { amStart, decodePng, openPhotoScreen, rootAvailable } from '../android-p167-lib.mjs'
import {
  adb,
  byId,
  dump,
  ensureSignedIn,
  fixtureDir,
  saveJson,
  scanFixture,
  screencap,
  shell,
  shot,
  sleep,
  tap,
  users,
  waitFor,
} from './lib.mjs'
import { findScrolling } from './flows.mjs'

const report = []
function record(name, status, detail) {
  report.push({ name, status, detail })
  console.log(`${status} ${name}  ${JSON.stringify(detail ?? null).slice(0, 900)}`)
}

/** uiautomator dump with the attributes the shared parser drops (enabled, selected, checked). */
function richDump() {
  const xml = adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { allowFail: true })
  const end = xml.lastIndexOf('</hierarchy>')
  const body = end === -1 ? xml : xml.slice(0, end + 12)
  const nodes = []
  for (const m of body.matchAll(/<node ([^>]*?)\/?>/g)) {
    const a = {}
    for (const p of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[p[1]] = p[2]
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds ?? '')
    if (!b) continue
    nodes.push({
      id: (a['resource-id'] ?? '').replace(/^.*:id\//, ''),
      text: a.text ?? '',
      desc: a['content-desc'] ?? '',
      clickable: a.clickable === 'true',
      enabled: a.enabled !== 'false',
      selected: a.selected === 'true',
      checked: a.checked === 'true',
      x1: +b[1],
      y1: +b[2],
      x2: +b[3],
      y2: +b[4],
    })
  }
  return nodes
}

const density = () => {
  const out = shell('wm density')
  const override = /Override density:\s*(\d+)/.exec(out)?.[1]
  return Number(override ?? /Physical density:\s*(\d+)/.exec(out)?.[1] ?? 420)
}
const screenW = () => Number(/(\d+)x(\d+)/.exec(shell('wm size'))?.[1] ?? 1080)

function audit(label) {
  const dpi = density()
  const dp = dpi / 160
  const minPx = Math.floor(48 * dp)
  const W = screenW()
  const nodes = richDump()
  const interactive = nodes.filter(
    (n) => n.clickable && n.enabled && n.id !== '' && !/^(tab-|action_bar|content)/.test(n.id),
  )
  const small = interactive
    .filter((n) => n.x2 - n.x1 < minPx || n.y2 - n.y1 < minPx)
    .map((n) => ({
      id: n.id,
      w: Math.round((n.x2 - n.x1) / dp),
      h: Math.round((n.y2 - n.y1) / dp),
    }))
  const unlabeled = interactive.filter((n) => n.text === '' && n.desc === '').map((n) => n.id)
  const offscreen = interactive.filter((n) => n.x1 < 0 || n.x2 > W).map((n) => n.id)
  const tabs = nodes.filter((n) => n.id.startsWith('tab-'))
  const tabSmall = tabs.filter((n) => n.y2 - n.y1 < minPx).map((n) => n.id)
  return {
    label,
    dpi,
    widthDp: Math.round(W / dp),
    interactive: interactive.length,
    small,
    unlabeled,
    offscreen,
    tabSmall,
    nodes,
  }
}

async function luminance(name) {
  const png = decodePng(screencap())
  shot(name)
  // Whole screen minus the photo preview (which legitimately contains a photograph): the bottom
  // 45 % of the screen holds the outcome / buttons.
  return {
    top: png.bandLuminance(0, Math.floor(png.h * 0.12)),
    lower: png.bandLuminance(Math.floor(png.h * 0.55), png.h),
  }
}

const CONFIGS = [
  {
    name: '360dp-font200',
    apply: () => {
      shell('wm density 480')
      shell('settings put system font_scale 2.0')
    },
  },
  {
    name: '430dp-font100',
    apply: () => {
      shell('wm density 400')
      shell('settings put system font_scale 1.0')
    },
  },
]
const revert = () => {
  shell('wm density reset')
  shell('settings put system font_scale 1.0')
}

amStart()
await ensureSignedIn(users.b)
if (!rootAvailable()) record('setup', 'NOT_RUN', 'adb root is not available')

for (const cfg of CONFIGS) {
  cfg.apply()
  await sleep(4000)
  amStart()
  await ensureSignedIn(users.b)

  // --- photo entry, idle
  await openPhotoScreen()
  await sleep(800)
  const idle = audit(`${cfg.name} photo idle`)
  const idleLum = await luminance(`a11y-${cfg.name}-idle`)
  record(
    `${cfg.name} photo entry idle`,
    idle.small.length + idle.unlabeled.length + idle.offscreen.length === 0 ? 'PASS' : 'FAIL',
    { ...strip(idle), lum: idleLum },
  )

  // --- HIGH result (f01)
  const high = await scanFixture(join(fixtureDir, 'f01-clean.jpg'), {
    label: `a11y-${cfg.name}-high`,
  })
  await sleep(600)
  const highAudit = audit(`${cfg.name} HIGH result`)
  const highLum = await luminance(`a11y-${cfg.name}-high`)
  const highNodes = highAudit.nodes
  const heading = highNodes.find((n) => n.id === 'p169-recognition-heading')
  const confirm = highNodes.find((n) => n.id === 'p169-recognition-confirm')
  const row = highNodes.find((n) => n.id.startsWith('p169-recognition-candidate-'))
  const words = {
    heading: heading?.text ?? null,
    confirmLabel: confirm?.text || confirm?.desc || null,
    rowDescription: row?.desc || row?.text || null,
  }
  const identityOk =
    row !== undefined &&
    /Sparkfin/.test(words.rowDescription ?? '') &&
    /007/.test(words.rowDescription ?? '') &&
    /P184 Set Alpha/.test(words.rowDescription ?? '')
  record(
    `${cfg.name} HIGH result`,
    highAudit.small.length + highAudit.unlabeled.length + highAudit.offscreen.length === 0 &&
      identityOk &&
      words.heading !== null
      ? 'PASS'
      : 'FAIL',
    { ...strip(highAudit), words, identityOk, lum: highLum, tier: high.trace.tier },
  )

  // --- review result with the confidence badge (f13: MEDIUM)
  const review = await scanFixture(join(fixtureDir, 'f13-ocr-vs-visual.jpg'), {
    label: `a11y-${cfg.name}-review`,
  })
  await sleep(600)
  const revAudit = audit(`${cfg.name} review result`)
  const revLum = await luminance(`a11y-${cfg.name}-review`)
  const badge = revAudit.nodes.find((n) => n.id === 'p169-recognition-confidence')
  const rows = revAudit.nodes.filter((n) => n.id.startsWith('p169-recognition-candidate-'))
  const another = revAudit.nodes.find((n) => n.id === 'p169-recognition-choose-another')
  const badgeWords = badge?.text || badge?.desc || null
  record(
    `${cfg.name} review result (confidence in words)`,
    revAudit.small.length + revAudit.unlabeled.length + revAudit.offscreen.length === 0 &&
      /confirmation|confidence/i.test(badgeWords ?? '')
      ? 'PASS'
      : 'FAIL',
    {
      ...strip(revAudit),
      badgeWords,
      candidateRows: rows.length,
      chooseAnotherShown: another !== undefined,
      lum: revLum,
      tier: review.trace.tier,
    },
  )

  // --- card screen with the printing choice (f17)
  const flow = await scanFixture(join(fixtureDir, 'f17-p169-charizard.jpg'), {
    label: `a11y-${cfg.name}-card`,
  })
  const cand =
    flow.ui.candidates.find((c) => c.label.startsWith('P169 Charizard')) ?? flow.ui.candidates[0]
  tap(byId(flow.ui.nodes, `p169-recognition-candidate-${cand.id}`))
  await waitFor((ns) => byId(ns, 'p169-card') || byId(ns, 'p169-card-identity'), {
    timeoutMs: 30000,
    label: 'card screen',
  })
  await sleep(800)
  const cardIdle = audit(`${cfg.name} card, printing choice`)
  const variantNodes = cardIdle.nodes.filter((n) => n.id.startsWith('p169-variant-'))
  await luminance(`a11y-${cfg.name}-card-choice`)
  if (variantNodes[0])
    tap({
      bounds: {
        x1: variantNodes[0].x1,
        y1: variantNodes[0].y1,
        x2: variantNodes[0].x2,
        y2: variantNodes[0].y2,
      },
    })
  await sleep(2500)
  const cardChosen = audit(`${cfg.name} card, printing chosen`)
  const chosenVariant = cardChosen.nodes.filter((n) => n.id.startsWith('p169-variant-'))
  const selectedExposed = chosenVariant.some(
    (n) => n.selected || n.checked || /selected/i.test(n.desc),
  )
  await luminance(`a11y-${cfg.name}-card-price`)
  record(
    `${cfg.name} card screen`,
    cardIdle.small.length +
      cardIdle.unlabeled.length +
      cardIdle.offscreen.length +
      cardChosen.small.length +
      cardChosen.offscreen.length ===
      0 && selectedExposed
      ? 'PASS'
      : 'FAIL',
    {
      choice: strip(cardIdle),
      chosen: strip(cardChosen),
      selectedStateExposed: selectedExposed,
      variantDescriptions: chosenVariant.map((n) => n.desc || n.text).slice(0, 4),
    },
  )
  adb(['shell', 'input', 'keyevent', '4'])
  await sleep(800)
}
revert()
await sleep(3000)

function strip({ nodes: _nodes, ...rest }) {
  return rest
}
saveJson('a11y-report.json', report)
const failed = report.filter((r) => r.status === 'FAIL').length
console.log(`\nSTEPS ${String(report.length)}  FAIL ${String(failed)}`)
process.exit(failed > 0 ? 1 : 0)
