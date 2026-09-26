#!/usr/bin/env node
/**
 * P166 Android runtime check: drives the INSTALLED release build on a real emulator or device over
 * adb and records what actually happened. LOCAL ONLY, synthetic users only.
 *
 *   node scripts/android-runtime-check.mjs
 *
 * Preconditions: `pnpm backend:start && pnpm backend:seed`, a release APK built with
 * EXPO_PUBLIC_RUNTIME_PROOF=1 installed (docs/mobile/P166_RUNTIME_AND_STITCH_REVIEW.md), one device
 * visible to adb. The script clears the app's data first. Credentials are read from the gitignored
 * .local-backend/fixture.json and passed to adb only; they are never printed or written.
 *
 * Output: .build/android-evidence/report.json + PNG screenshots (gitignored). Each step records
 * PASS/FAIL with the observed values; one failing step does not hide the others.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  ACTIVITY,
  PACKAGE,
  adb,
  byId,
  byIdPrefix,
  dump,
  screencap,
  shell,
  sleep,
  tap,
  typeText,
  waitFor,
} from './android-adb.mjs'
import { disableAutofill } from './android-p167-lib.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(appRoot, '.build', 'android-evidence')
mkdirSync(outDir, { recursive: true })
const fixture = JSON.parse(readFileSync(join(appRoot, '.local-backend', 'fixture.json'), 'utf8'))

const steps = []
const metrics = {}
function record(step, ok, detail) {
  steps.push({ step, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${detail ? `  ${JSON.stringify(detail)}` : ''}`)
}
// P166_STEPS=<regex> runs only the matching steps (e.g. to re-check the photo flow).
const only = process.env.P166_STEPS ? new RegExp(process.env.P166_STEPS, 'i') : null
async function run(step, fn) {
  if (only && !only.test(step)) return
  try {
    const detail = await fn()
    record(step, true, detail)
  } catch (e) {
    const name = `fail-${steps.length + 1}`
    try {
      shot(name)
    } catch {
      // screenshot is best effort; the failure itself is what gets recorded
    }
    record(step, false, { error: String(e.message ?? e).slice(0, 400), screenshot: `${name}.png` })
  }
}
/** Money text as it appears on screen, with every kind of space (NBSP, NNBSP) made plain. */
const plain = (s) => s.replace(/\s/g, ' ')
function shot(name) {
  writeFileSync(join(outDir, `${name}.png`), screencap())
}
const rows = (nodes) => byIdPrefix(nodes, 'row-')
/** Taps a node once it is in the view tree: a dump taken while the UI is not idle can be empty (P167). */
async function tapId(id) {
  tap((await waitFor((ns) => byId(ns, id), { label: id })).value)
}
const text = (nodes, id) => byId(nodes, id)?.text ?? null

function amStart() {
  const out = shell(`am start -W -n ${ACTIVITY}`)
  const total = /TotalTime: (\d+)/.exec(out)
  const kind = /LaunchState: (\w+)/.exec(out)
  return { totalTimeMs: total ? Number(total[1]) : null, launchState: kind ? kind[1] : null }
}
function pssKb() {
  const out = shell(`dumpsys meminfo ${PACKAGE}`)
  const m = /TOTAL PSS:\s+(\d+)/.exec(out) ?? /TOTAL\s+(\d+)/.exec(out)
  return m ? Number(m[1]) : null
}
function gfx() {
  const out = shell(`dumpsys gfxinfo ${PACKAGE}`)
  const num = (re) => {
    const m = re.exec(out)
    return m ? Number(m[1]) : null
  }
  return {
    framesRendered: num(/Total frames rendered: (\d+)/),
    jankyFrames: num(/Janky frames: (\d+)/),
    p50ms: num(/50th percentile: (\d+)ms/),
    p90ms: num(/90th percentile: (\d+)ms/),
    p99ms: num(/99th percentile: (\d+)ms/),
  }
}
/** A synthetic 5:7 gradient PNG (no card art), built with zlib only. */
function syntheticPng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = 40 + Math.round((180 * x) / w)
      raw[o + 1] = 60 + Math.round((120 * y) / h)
      raw[o + 2] = 140
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// The emulator's Gboard shows a "Try out your stylus" sheet over the app when injected events look
// like a stylus; taps and swipes are therefore sent as `input touchscreen ...` and stylus
// handwriting is switched off for the run (restored at the end). The keyboard stays enabled: the
// password field is submitted with the keyboard's action key, as a person would. (P166 found the
// Sign in button covered by the keyboard; P167 fixed that and android-p167-check.mjs taps the button.)
async function signIn(user) {
  const n = (await waitFor((ns) => byId(ns, 'login-email') && ns, { label: 'login form' })).value
  tap(byId(n, 'login-email'))
  typeText(user.email)
  // Since P167 the form moves up when the keyboard opens (F7), so positions read before it are stale.
  await sleep(500)
  tap((await waitFor((ns) => byId(ns, 'login-password'), { label: 'password field' })).value)
  typeText(user.password)
  shell('input keyevent 66') // IME action on the password field -> onSubmitEditing -> sign in
  const t0 = Date.now()
  const r = await waitFor((ns) => (rows(ns).length > 0 || byId(ns, 'login-error')) && ns, {
    timeoutMs: 60000,
    label: 'first collection page',
  })
  if (byId(r.value, 'login-error')) throw new Error(`login error: ${text(r.value, 'login-error')}`)
  return { firstPageVisibleMs: Date.now() - t0, nodes: r.value }
}

// ---------------------------------------------------------------------------------------------
const device = {
  model: shell('getprop ro.product.model').trim(),
  android: shell('getprop ro.build.version.release').trim(),
  sdk: shell('getprop ro.build.version.sdk').trim(),
  abi: shell('getprop ro.product.cpu.abi').trim(),
  emulator:
    shell('getprop ro.kernel.qemu').trim() === '1' ||
    /sdk|emu/i.test(shell('getprop ro.product.model')),
}
metrics.device = device

// Dump latency: every "visible after" figure below includes polling; this is its granularity.
{
  const t = Date.now()
  for (let i = 0; i < 3; i++) dump()
  metrics.uiDumpLatencyMs = Math.round((Date.now() - t) / 3)
}

shell(`am force-stop ${PACKAGE}`)
shell(`pm clear ${PACKAGE}`)
const stylusBefore = shell('settings get secure stylus_handwriting_enabled').trim()
shell('settings put secure stylus_handwriting_enabled 0')
const restoreAutofill = disableAutofill() // P167: autofill put the previous account into the form
shell('settings put system font_scale 1.0')
shell('cmd uimode night no')
adb(['logcat', '-c'])

await run('cold start to first frame (clean data)', async () => {
  const s = amStart()
  metrics.coldStart = s
  const r = await waitFor((ns) => byId(ns, 'login-screen'), { label: 'login screen' })
  shot('01-login')
  return { ...s, loginVisibleAfterFirstFrameMs: r.ms }
})

await run('Hermes exact-money proof on device', async () => {
  const log = adb(['logcat', '-d', '-v', 'brief', 'ReactNativeJS:V', '*:S'])
  const verdict = log.split('\n').find((l) => l.includes('P166_PROOF RESULT'))
  const fails = log.split('\n').filter((l) => l.includes('P166_PROOF FAIL'))
  writeFileSync(
    join(outDir, 'hermes-proof.log'),
    log
      .split('\n')
      .filter((l) => l.includes('P166_PROOF'))
      .join('\n'),
  )
  if (!verdict)
    throw new Error('no P166_PROOF RESULT line (bundle built without EXPO_PUBLIC_RUNTIME_PROOF=1?)')
  const m = /pass=(\d+) fail=(\d+) engine=(.+)$/.exec(verdict.trim())
  metrics.hermesProof = m ? { pass: +m[1], fail: +m[2], engine: m[3] } : verdict
  if (!m || m[2] !== '0' || !m[3].startsWith('hermes'))
    throw new Error(`verdict: ${verdict} ${fails.join(' | ')}`)
  return metrics.hermesProof
})

await run('sign in as synthetic user A via 10.0.2.2 -> local GoTrue', async () => {
  const r = await signIn(fixture.users.a)
  metrics.firstPageVisibleMs = r.firstPageVisibleMs
  shot('02-collection-A')
  const total = text(r.nodes, 'collection-total') ?? text(r.nodes, 'collection-total-unavailable')
  return { firstPageVisibleMs: r.firstPageVisibleMs, visibleRows: rows(r.nodes).length, total }
})

await run(
  'exact money visible in the list (2^58+1 x3, 2^53+1 x3, manual 0, no price)',
  async () => {
    const want = {
      'S03 3 x (2^58+1)': '8 646 911 284 551 352,35 kr',
      'S05 3 x (2^53+1)': '270 215 977 642 229,79 kr',
    }
    const seen = {}
    let n = dump()
    for (let i = 0; i < 6; i++) {
      const texts = n.map((x) => plain(x.text))
      for (const [k, v] of Object.entries(want)) if (texts.some((t) => t.includes(v))) seen[k] = v
      if (Object.keys(seen).length === Object.keys(want).length) break
      shell('input touchscreen swipe 540 1700 540 900 300')
      await sleep(600)
      n = dump()
    }
    shot('03-exact-money-rows')
    const missing = Object.keys(want).filter((k) => !(k in seen))
    if (missing.length) throw new Error(`not found on screen: ${missing.join(', ')}`)
    return seen
  },
)

await run('card detail from the list', async () => {
  let n = dump()
  const first = rows(n)[0]
  if (!first) throw new Error('no row to open')
  tap(first)
  const r = await waitFor((ns) => byId(ns, 'card-detail') && ns, { label: 'card detail' })
  shot('04-card-detail')
  const detail = {
    openedMs: r.ms,
    holdingValue: text(r.value, 'detail-holding-value'),
    priceState: text(r.value, 'detail-price-state'),
    hasProvenance: Boolean(byId(r.value, 'detail-provenance')),
  }
  shell('input keyevent 4')
  await waitFor((ns) => byId(ns, 'collection-list'), { label: 'back to list' })
  return detail
})

await run('collection pagination + scroll on 10 006 holdings', async () => {
  // Back to the top, then fling repeatedly; count distinct row ids. More than one page (100)
  // of distinct ids is only possible if later keyset pages were fetched and rendered.
  shell(`dumpsys gfxinfo ${PACKAGE} reset`)
  const pssBefore = pssKb()
  const ids = new Set()
  let blankDumps = 0
  const t0 = Date.now()
  for (let i = 0; i < 45; i++) {
    shell('input touchscreen swipe 540 1900 540 500 250')
    await sleep(350)
    const n = dump()
    const r = rows(n)
    if (r.length === 0 && !byId(n, 'loading')) blankDumps += 1
    for (const x of r) ids.add(x.id)
  }
  const elapsed = Date.now() - t0
  const frames = gfx()
  const pssAfter = pssKb()
  metrics.scroll = {
    swipes: 45,
    elapsedMs: elapsed,
    distinctRows: ids.size,
    blankDumps,
    frames,
    pssBeforeKb: pssBefore,
    pssAfterKb: pssAfter,
  }
  shot('05-after-scroll')
  if (ids.size <= 100) throw new Error(`only ${ids.size} distinct rows: no second page observed`)
  if (blankDumps > 0) throw new Error(`${blankDumps} dumps showed an empty list mid-scroll`)
  return metrics.scroll
})

await run('return from background keeps session and rows', async () => {
  shell('input keyevent 3') // HOME
  await sleep(8000)
  const s = amStart()
  const r = await waitFor((ns) => (rows(ns).length > 0 || byId(ns, 'login-screen')) && ns, {
    label: 'resume',
  })
  if (byId(r.value, 'login-screen')) throw new Error('resumed to the login screen')
  metrics.resume = { ...s, rowsVisibleMs: r.ms }
  return metrics.resume
})

await run('process restart restores the session from SecureStore (no login)', async () => {
  shell(`am force-stop ${PACKAGE}`)
  const s = amStart()
  const t0 = Date.now()
  const r = await waitFor((ns) => (rows(ns).length > 0 || byId(ns, 'login-screen')) && ns, {
    timeoutMs: 60000,
    label: 'restored collection',
  })
  if (byId(r.value, 'login-screen')) throw new Error('restart showed the login screen')
  metrics.restartRestore = { ...s, rowsVisibleAfterStartMs: Date.now() - t0 }
  return metrics.restartRestore
})

await run('accessibility tree: every clickable node has a name', async () => {
  // Proxy for a screen reader: what TalkBack would announce is the node's text/content-desc.
  const screens = {}
  const check = (name, nodes) => {
    const unnamed = nodes.filter(
      (x) =>
        x.clickable &&
        !x.text &&
        !x.desc &&
        !nodes.some(
          (c) =>
            c !== x &&
            c.text &&
            c.bounds &&
            x.bounds &&
            c.bounds.x1 >= x.bounds.x1 &&
            c.bounds.x2 <= x.bounds.x2 &&
            c.bounds.y1 >= x.bounds.y1 &&
            c.bounds.y2 <= x.bounds.y2,
        ),
    )
    const small = nodes.filter(
      (x) =>
        x.clickable &&
        x.bounds &&
        (x.bounds.y2 - x.bounds.y1 < 132 || x.bounds.x2 - x.bounds.x1 < 132),
    )
    screens[name] = {
      clickable: nodes.filter((x) => x.clickable).length,
      unnamed: unnamed.map((x) => x.id || x.cls),
      under48dp: small.map((x) => x.id || x.desc || x.text).slice(0, 10),
    }
  }
  check('collection', dump())
  await tapId('tab-pricecheck')
  await waitFor((ns) => byId(ns, 'price-check-home'), { label: 'price check home' })
  check('price-check', dump())
  await tapId('tab-profile')
  await waitFor((ns) => byId(ns, 'profile'), { label: 'profile' })
  check('profile', dump())
  await tapId('tab-collection')
  const bad = Object.entries(screens).filter(([, v]) => v.unnamed.length > 0)
  metrics.a11y = screens
  if (bad.length) throw new Error(`unnamed clickable nodes: ${JSON.stringify(bad)}`)
  return screens
})

await run('Price Check (read-only): search, result, graded unavailable', async () => {
  await tapId('tab-pricecheck')
  let n = (await waitFor((ns) => byId(ns, 'pc-query') && ns, { label: 'query field' })).value
  tap(byId(n, 'pc-query'))
  typeText('Twin')
  tap((await waitFor((ns) => byId(ns, 'pc-search'), { label: 'search button' })).value)
  n = (
    await waitFor((ns) => byIdPrefix(ns, 'hit-')[0] && ns, {
      timeoutMs: 30000,
      label: 'search hit',
    })
  ).value
  shot('08-price-check-search')
  tap(byIdPrefix(n, 'hit-')[0])
  n = (
    await waitFor(
      (ns) =>
        byId(ns, 'price-check-result') &&
        (byId(ns, 'graded-unavailable') || byId(ns, 'variant-choice')) &&
        ns,
      {
        timeoutMs: 30000,
        label: 'price check result',
      },
    )
  ).value
  const choiceRequired = Boolean(byId(n, 'variant-choice'))
  const priceBeforeChoice = byIdPrefix(n, 'obs-').length
  shot('09a-price-check-variant-choice')
  if (choiceRequired) {
    const variants = byIdPrefix(n, 'variant-').filter(
      (x) => x.id !== 'variant-choice' && x.id !== 'variant-confirmed',
    )
    tap(variants.find((x) => /holo/i.test(x.desc)) ?? variants[variants.length - 1])
    n = (
      await waitFor(
        (ns) => (byIdPrefix(ns, 'obs-').length > 0 || byId(ns, 'price-unavailable')) && ns,
        { timeoutMs: 30000, label: 'price after variant choice' },
      )
    ).value
  }
  shot('09-price-check-result')
  const out = {
    choiceRequired,
    priceShownBeforeChoice: priceBeforeChoice > 0,
    graded: text(n, 'graded-unavailable'),
    unavailable: Boolean(byId(n, 'price-unavailable')),
    observations: [...new Set(byIdPrefix(n, 'obs-').map((x) => x.id))],
    values: byIdPrefix(n, 'obs-')
      .filter((x) => x.text)
      .map((x) => plain(x.text)),
  }
  if (priceBeforeChoice > 0) throw new Error('a price was shown before the variant was chosen')
  if (!out.graded || !/Not available/.test(out.graded)) throw new Error('graded state not shown')
  // scroll to the graded section if needed
  shell('input touchscreen swipe 540 1700 540 700 300')
  await sleep(500)
  shot('10-price-check-graded')
  shell('input keyevent 4')
  return out
})

await run('photo: library picker cancelled -> cancelled state', async () => {
  if (!byId(dump(), 'pc-photo')) await tapId('tab-pricecheck')
  let n = (await waitFor((ns) => byId(ns, 'pc-photo') && ns, { label: 'photo entry' })).value
  tap(byId(n, 'pc-photo'))
  n = (await waitFor((ns) => byId(ns, 'photo-library') && ns, { label: 'photo spike' })).value
  shot('11-photo-spike')
  tap(byId(n, 'photo-library'))
  await sleep(2500)
  const picker = dump()
  const pickerPkg =
    picker.find((x) => /photopicker|documentsui|mediaprovider/.test(x.id))?.id ?? 'unknown'
  shot('12-system-photo-picker')
  // A picker that failed to open has already produced a state; BACK would then leave the screen.
  const early = ['photo-unavailable', 'photo-cancelled'].find((id) => byId(dump(), id))
  if (early === 'photo-unavailable') throw new Error('library picker did not open: "unavailable"')
  if (early === undefined) shell('input keyevent 4')
  const r = await waitFor(
    (ns) => (byId(ns, 'photo-cancelled') || byId(ns, 'photo-unavailable')) && ns,
    { label: 'cancelled state' },
  )
  if (byId(r.value, 'photo-unavailable')) throw new Error('picker cancel reported "unavailable"')
  return { pickerNode: pickerPkg, cancelledText: text(r.value, 'photo-cancelled') }
})

await run('photo: camera permission denied -> denied state', async () => {
  shell(`pm revoke ${PACKAGE} android.permission.CAMERA`)
  shell(`pm clear-permission-flags ${PACKAGE} android.permission.CAMERA user-set user-fixed`)
  let n = dump()
  tap(byId(n, 'photo-camera'))
  const dlg = await waitFor(
    (ns) =>
      ns.find((x) => /permission_deny_button|Don.t allow|Deny/i.test(x.id + ' ' + x.text)) && ns,
    { timeoutMs: 15000, label: 'system permission dialog' },
  )
  shot('13-camera-permission-dialog')
  const deny =
    dlg.value.find((x) => /permission_deny_button/.test(x.id)) ??
    dlg.value.find((x) => /Don.t allow|Deny/i.test(x.text))
  tap(deny)
  n = (await waitFor((ns) => byId(ns, 'photo-denied') && ns, { label: 'denied state' })).value
  shot('14-camera-denied')
  return { dialog: 'system runtime permission dialog shown', deniedCard: true }
})

await run('photo: owned cache copy deleted on screen exit (needs adb root)', async () => {
  // Push a synthetic image into the gallery, pick it, then leave the screen and look in the app cache.
  const rootOk = /restarting|already running/.test(adb(['root'], { allowFail: true }))
  await sleep(1500)
  if (!rootOk) throw new Error('adb root unavailable on this image; cache cleanup not observable')
  const listCache = () =>
    adb(['shell', `find /data/data/${PACKAGE}/cache -type f 2>/dev/null`], { allowFail: true })
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /\.(jpe?g|png|webp|heic)$/i.test(l))
  const before = listCache()
  const png = join(outDir, 'p166-synthetic-card.png')
  writeFileSync(png, syntheticPng(500, 700))
  shell('mkdir -p /sdcard/Pictures')
  adb(['push', png, '/sdcard/Pictures/p166-synthetic-card.png'])
  shell(
    'am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/p166-synthetic-card.png',
  )
  await sleep(2000)
  let n = dump()
  tap(byId(n, 'photo-library'))
  await sleep(3000)
  n = dump()
  const thumb = n.find((x) => x.clickable && /Photo taken|p166|Image|photo/i.test(x.desc))
  // The system photo picker's window is often not in the uiautomator dump; its grid starts with
  // the newest item (the pushed synthetic image) at the top-left, below the privacy banner.
  if (thumb) tap(thumb)
  else shell('input touchscreen tap 179 1404')
  const ready = await waitFor((ns) => byId(ns, 'photo-ready') && ns, {
    timeoutMs: 20000,
    label: 'photo ready',
  })
  shot('15-photo-ready')
  const during = listCache()
  shell('input keyevent 4')
  await sleep(1500)
  const after = listCache()
  const created = during.filter((f) => !before.includes(f))
  const leftover = created.filter((f) => after.includes(f))
  if (created.length === 0) throw new Error('no app-cache copy observed while the photo was shown')
  if (leftover.length) throw new Error(`owned cache file not deleted: ${leftover.join(',')}`)
  return {
    meta: text(ready.value, 'photo-meta'),
    cacheFilesWhileShown: created.length,
    remainingAfterExit: 0,
  }
})

await run('font scale 2.0: collection and detail still render', async () => {
  if (rows(dump()).length === 0) await tapId('tab-collection')
  shell('settings put system font_scale 2.0')
  await sleep(1500)
  let n = (await waitFor((ns) => rows(ns).length > 0 && ns, { label: 'rows at 2.0' })).value
  shot('06-font-2.0-collection')
  const total = text(n, 'collection-total')
  tap(rows(n)[0])
  n = (await waitFor((ns) => byId(ns, 'card-detail') && ns, { label: 'detail at 2.0' })).value
  shot('07-font-2.0-detail')
  const value = text(n, 'detail-holding-value')
  shell('input keyevent 4')
  shell('settings put system font_scale 1.0')
  await sleep(1500)
  return { total, detailValue: value }
})

await run('photo picker after a configuration change (font scale) still opens', async () => {
  // A system font-size change recreates the Activity (fontScale is not in configChanges). The
  // image picker's ActivityResultLauncher must survive that; P166 observed it does not.
  if (!byId(dump(), 'photo-library')) {
    if (!byId(dump(), 'pc-photo')) await tapId('tab-pricecheck')
    tap((await waitFor((ns) => byId(ns, 'pc-photo'), { label: 'photo entry' })).value)
  }
  const n = (await waitFor((ns) => byId(ns, 'photo-library') && ns, { label: 'photo spike' })).value
  adb(['logcat', '-c'])
  tap(byId(n, 'photo-library'))
  await sleep(3000)
  const failed = byId(dump(), 'photo-unavailable')
  const cause = adb(['logcat', '-d', '-v', 'raw', 'ReactNativeJS:V', '*:S'])
    .split('\n')
    .filter((l) => /photo library failed|Caused by/.test(l))
    .join(' ')
    .slice(0, 300)
  shot('18-picker-after-config-change')
  if (failed) throw new Error(`picker rejected after config change: ${cause}`)
  shell('input keyevent 4')
  return { opened: true }
})

await run('sign out removes the session (restart shows login)', async () => {
  await tapId('tab-profile')
  const n = (await waitFor((ns) => byId(ns, 'sign-out') && ns, { label: 'sign out' })).value
  tap(byId(n, 'sign-out'))
  await waitFor((ns) => byId(ns, 'login-screen'), { label: 'login after sign-out' })
  shell(`am force-stop ${PACKAGE}`)
  amStart()
  const r = await waitFor((ns) => (byId(ns, 'login-screen') || rows(ns).length > 0) && ns, {
    timeoutMs: 30000,
    label: 'post-restart',
  })
  if (!byId(r.value, 'login-screen')) throw new Error('session survived sign-out')
  return { restartAfterSignOut: 'login screen' }
})

await run('identity switch A -> B: only B rows, B total', async () => {
  const r = await signIn(fixture.users.b)
  shot('16-collection-B')
  const n = r.nodes
  const labels = rows(n).map((x) => x.desc)
  const leaked = labels.filter((l) =>
    /Astronomical|Above Safe Integer|Twin Finish|No Prices|Manual Zero|Priced Both/.test(l),
  )
  if (leaked.length) throw new Error(`A rows visible for B: ${leaked.join('; ')}`)
  // B owns 40 holdings and none has a value: the total is missing, never "0,00 kr" (F14).
  if (text(n, 'collection-total') !== '—') {
    throw new Error(`B total should be missing, got ${text(n, 'collection-total')}`)
  }
  return {
    firstPageVisibleMs: r.firstPageVisibleMs,
    visibleRows: labels.length,
    total: text(n, 'collection-total'),
  }
})

await run('dark mode renders', async () => {
  shell('cmd uimode night yes')
  await sleep(2000)
  shot('17-dark-collection')
  shell('cmd uimode night no')
  return { screenshot: '17-dark-collection.png' }
})

restoreAutofill()
shell(
  stylusBefore === 'null'
    ? 'settings delete secure stylus_handwriting_enabled'
    : `settings put secure stylus_handwriting_enabled ${stylusBefore}`,
)
writeFileSync(
  join(outDir, 'report.json'),
  JSON.stringify({ when: new Date().toISOString(), steps, metrics }, null, 2),
)
const failed = steps.filter((s) => s.status === 'FAIL').length
console.log(
  `\nRESULT pass=${steps.length - failed} fail=${failed} -> ${join(outDir, 'report.json')}`,
)
process.exit(failed > 0 ? 1 : 0)
