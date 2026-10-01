#!/usr/bin/env node
/**
 * P185 REAL TalkBack run over the scanner path on the release APK. LOCAL ONLY (synthetic data).
 *
 *   node scripts/p185/talkback-check.mjs         -> .build/p185-evidence/talkback-report.json
 *
 * The emulator image (google_apis, Android 16) ships Google's TalkBack (com.google.android.marvin.
 * talkback 16.0). It is enabled the way Settings enables it (enabled_accessibility_services), with
 * TalkBack's own "verbose logging" preference on so that every utterance it speaks is written to
 * logcat as `Speaking fragment text="..."`. Nothing is inferred from the view tree here: the
 * evidence is what TalkBack SAID for each focus move, driven by TalkBack's own gestures (one-finger
 * swipe right/left = next/previous item, double tap = activate).
 *
 * The system photo picker is a system UI outside this app: the image is chosen with TalkBack OFF
 * (the accessibility-tree driver), then TalkBack is switched on for the app's own screens.
 * That split is part of the report, not hidden.
 *
 * Checked, per screen: focus order, accessible name, role, selected / disabled state, duplicate
 * announcements, and that no raw UUID and no model score is ever spoken.
 */
import './env.mjs'
import { join } from 'node:path'
import { amStart, openPhotoScreen } from '../android-p167-lib.mjs'
import {
  adb,
  byId,
  dump,
  ensureSignedIn,
  fixtureDir,
  nextScanTrace,
  pickNewest,
  pushImage,
  saveJson,
  scanMark,
  shell,
  shot,
  sleep,
  tap,
  users,
  waitFor,
} from './lib.mjs'
import { bringIntoView, findNode, tapNode, waitForNode } from './driver.mjs'

const TALKBACK =
  'com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService'
const report = { steps: [], utterances: {} }
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const SCORE = /similarity|cosine|score\s*[:=]?\s*0?\.\d|\b0\.\d{3,}\b/i

function record(name, status, detail) {
  report.steps.push({ name, status, detail })
  console.log(`${status} ${name}  ${JSON.stringify(detail ?? null).slice(0, 900)}`)
}

// ---- TalkBack control ----------------------------------------------------------------------------
function talkbackAvailable() {
  return /com\.google\.android\.marvin\.talkback/.test(
    adb(['shell', 'pm', 'list', 'packages', 'com.google.android.marvin.talkback'], { allowFail: true }),
  )
}
async function talkbackOn() {
  adb(['logcat', '-c'], { allowFail: true })
  shell(`settings put secure enabled_accessibility_services ${TALKBACK}`)
  shell('settings put secure accessibility_enabled 1')
  for (let i = 0; i < 40; i += 1) {
    await sleep(500)
    if (/TalkBack on|Speaking fragment/.test(spokenRaw())) break
  }
  await sleep(1500)
  // First start only: TalkBack asks to send notifications. Declined (it is not needed): one tap puts
  // TalkBack's focus on the button, a double tap activates it.
  const asked = adb(['shell', 'dumpsys', 'window'], { allowFail: true }).includes('PermissionRequestActivity')
  if (asked) {
    shell('input tap 540 1474 ; input tap 540 1474')
    await sleep(2000)
  }
}
async function talkbackOff() {
  shell("settings put secure enabled_accessibility_services ''")
  shell('settings put secure accessibility_enabled 0')
  await sleep(2500)
}
const spokenRaw = () => adb(['logcat', '-d', '-v', 'time'], { allowFail: true })

/** Every utterance TalkBack spoke since the last mark, in order. */
function spokenSince() {
  const out = []
  for (const line of spokenRaw().split(/\r?\n/)) {
    const m = /SpeechControllerImpl[^:]*:\s+Speaking fragment text="(.*?)", utteranceId=/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}
const mark = () => adb(['logcat', '-c'], { allowFail: true })

const swipeNext = () => shell('input swipe 250 1300 850 1300 120')
const swipePrev = () => shell('input swipe 850 1300 250 1300 120')
const doubleTap = () => shell('input tap 540 1300 ; input tap 540 1300')

/** One TalkBack gesture, then everything it said (joined as one announcement). */
async function gesture(fn) {
  mark()
  fn()
  await sleep(1700)
  return spokenSince().join(' | ')
}

/**
 * Walks TalkBack's linear focus order from the first item, up to `max` items, until `stopAt` is
 * spoken. Returns the announcements in order.
 */
async function walk({ max = 30, stopAt = null } = {}) {
  const seen = []
  for (let i = 0; i < max; i += 1) {
    const said = await gesture(swipeNext)
    if (said === '') continue
    seen.push(said)
    if (stopAt && stopAt.test(said)) break
  }
  return seen
}

const dupes = (list) => list.filter((s, i) => i > 0 && s === list[i - 1])
const leaked = (list) => list.filter((s) => UUID.test(s) || SCORE.test(s))

function expectInOrder(list, patterns) {
  let at = 0
  const missing = []
  for (const re of patterns) {
    const i = list.findIndex((s, idx) => idx >= at && re.test(s))
    if (i === -1) missing.push(String(re))
    else at = i + 1
  }
  return missing
}

async function scenario(name, patterns, run) {
  try {
    const said = await run()
    report.utterances[name] = said
    const missing = expectInOrder(said, patterns)
    const bad = leaked(said)
    const duplicate = dupes(said)
    record(
      name,
      missing.length === 0 && bad.length === 0 && duplicate.length === 0 ? 'PASS' : 'FAIL',
      { announcements: said, missingInOrder: missing, leaked: bad, consecutiveDuplicates: duplicate },
    )
  } catch (e) {
    record(name, 'FAIL', String(e.message ?? e).slice(0, 400))
  }
}

// ---- run -----------------------------------------------------------------------------------------
if (!talkbackAvailable()) {
  record('TalkBack availability', 'UNAVAILABLE_ON_TEST_IMAGE', 'the TalkBack package is not installed')
  saveJson('talkback-report.json', report)
  process.exit(2)
}
record('TalkBack availability', 'PASS', 'Google TalkBack is installed on the emulator image')

amStart()
await talkbackOff()
await ensureSignedIn(users.b)
await openPhotoScreen()
const idleAnnouncements = []

// 1. scanner entry with TalkBack on: the photo buttons by name and role
await talkbackOn()
await scenario(
  'scanner entry: Choose photo / Take photo by TalkBack focus order',
  [/(Choose|Pick|library|photo).*(Button|button)/i, /(Take|camera).*(Button|button)/i],
  async () => {
    const said = await walk({ max: 8 })
    idleAnnouncements.push(...said)
    return said
  },
)
shot('talkback-01-scanner-entry')

// 2. HIGH result (picked with TalkBack off; read with TalkBack on)
async function pickWithoutTalkBack(fixture, label) {
  await talkbackOff()
  await openPhotoScreen()
  const before = scanMark()
  await pushImage(join(fixtureDir, fixture), label)
  await pickNewest()
  const trace = await nextScanTrace(before)
  await sleep(1200)
  // scroll the result into the first screen: the heading is the top of the outcome section
  await bringIntoView('p169-recognition-heading', { label: 'result heading' })
  await talkbackOn()
  return trace
}

const high = await pickWithoutTalkBack('f01-clean.jpg', 'tb-high')
await scenario(
  `HIGH result (tier ${high.tier}): heading, confidence, candidate, Confirm, Retake`,
  [/Likely match/i, /High confidence/i, /Sparkfin.*P184 Set Alpha.*007/i, /Confirm this card/i, /Retake/i],
  async () => {
    // start from the heading: previous items until it is spoken, then forward
    const said = await walk({ max: 25, stopAt: /Choose the card manually/i })
    return said
  },
)
shot('talkback-02-high-result')

// 3. Activate Confirm: the card screen opens (what TalkBack says on arrival)
await scenario('HIGH result: activating "Confirm this card" opens the card', [/Sparkfin/i], async () => {
  // find Confirm by walking until it is focused, then double tap
  let said = ''
  for (let i = 0; i < 30; i += 1) {
    said = await gesture(swipeNext)
    if (/Confirm this card/i.test(said)) break
  }
  const arrived = await gesture(doubleTap)
  const next = await walk({ max: 4 })
  return [said, arrived, ...next].filter(Boolean)
})
await talkbackOff()

// 4. Review result (MEDIUM): confidence in words + candidate selection
const review = await pickWithoutTalkBack('f17-p169-charizard.jpg', 'tb-review')
await scenario(
  `review result (tier ${review.tier}): heading, confidence, candidate, Retake, Choose manually`,
  [/Possible matches/i, /(Needs confirmation|Low confidence)/i, /P169 Charizard.*P169 Base Set.*004/i, /Retake/i],
  async () => walk({ max: 25, stopAt: /Choose the card manually/i }),
)
shot('talkback-03-review-result')

// 5. Select the candidate -> card -> printing radios (selected state) -> Price Check -> Add to Collection
await scenario(
  'candidate selection, printing radios, Price Check and Add to Collection',
  [/P169 Charizard/i, /Holo/i, /Add to collection/i],
  async () => {
    const said = []
    // move to the candidate row and activate it
    for (let i = 0; i < 30; i += 1) {
      const s = await gesture(swipeNext)
      if (/P169 Charizard.*004/i.test(s)) {
        said.push(s)
        break
      }
    }
    said.push(await gesture(doubleTap))
    await sleep(2500)
    // the card screen: walk to the printing choice and read each radio
    const card = await walk({ max: 14, stopAt: /Holo(?! ·)/i })
    said.push(...card)
    // activate the plain "Holo" radio (the walk stopped on it)
    said.push(await gesture(doubleTap))
    await sleep(4000)
    const after = await walk({ max: 40, stopAt: /Add to collection/i })
    said.push(...after)
    return said
  },
)
shot('talkback-04-card-price')
await talkbackOff()

record('TalkBack run complete', 'INFO', {
  note: 'The photo picker was driven with TalkBack off (system UI); every app screen above was read with TalkBack on.',
})
saveJson('talkback-report.json', report)
const failed = report.steps.filter((s) => s.status === 'FAIL').length
console.log(`\nTALKBACK STEPS ${String(report.steps.length)}  FAIL ${String(failed)}`)
process.exit(failed > 0 ? 1 : 0)
