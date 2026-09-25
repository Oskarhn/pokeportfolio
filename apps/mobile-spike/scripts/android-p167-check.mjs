#!/usr/bin/env node
/**
 * P167 Android runtime check: the defects P166 found (F1 photo picker after an Activity recreation,
 * F3 tab glyph, F4 large text, F5 dark mode, F6 touch targets, F7 keyboard) and the photo lifecycle
 * cases around them, driven on the INSTALLED release build over adb. LOCAL ONLY, synthetic users only.
 *
 *   ANDROID_SERIAL=emulator-5554 node scripts/android-p167-check.mjs      (P167_STEPS=<regex> subset)
 *
 * Preconditions as for android-runtime-check.mjs (local stack started and seeded, release APK with
 * EXPO_PUBLIC_RUNTIME_PROOF=1 installed). The app's data is cleared first. Needs `adb root` (google_apis
 * image) for the cache-file and process-kill steps. Credentials come from the gitignored
 * .local-backend/fixture.json and go to adb only.
 *
 * Output: .build/p167-evidence/report.json + PNGs (gitignored). Each step is PASS, FAIL or NOT_RUN
 * (with the reason); a failing step never hides the others.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACTIVITY,
  PACKAGE,
  adb,
  byId,
  dump,
  screencap,
  shell,
  sleep,
  tap,
  waitFor,
} from './android-adb.mjs'
import {
  amStart,
  appPid,
  chooseNewestInPicker,
  ensureApp,
  clearEvents,
  crashCount,
  decodePng,
  focusedWindow,
  imeFrame,
  lifecycleEvents,
  localActivityId,
  openPhotoScreen,
  pickerCacheFiles,
  plain,
  pushSyntheticImage,
  pxPerDp,
  rootAvailable,
  rows,
  signIn,
  text,
  waitForPickerOrState,
} from './android-p167-lib.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(appRoot, '.build', 'p167-evidence')
mkdirSync(outDir, { recursive: true })
const fixture = JSON.parse(readFileSync(join(appRoot, '.local-backend', 'fixture.json'), 'utf8'))

const steps = []
const only = process.env.P167_STEPS ? new RegExp(process.env.P167_STEPS, 'i') : null
class NotRun extends Error {}
function record(step, status, detail) {
  steps.push({ step, status, detail })
  console.log(`${status} ${step}${detail ? `  ${JSON.stringify(detail).slice(0, 700)}` : ''}`)
}
async function run(step, fn) {
  if (only && !only.test(step)) return
  try {
    record(step, 'PASS', await fn())
  } catch (e) {
    if (e instanceof NotRun) {
      record(step, 'NOT_RUN', { reason: e.message })
      return
    }
    const name = `fail-${steps.length + 1}`
    try {
      shot(name)
    } catch {
      // best effort; the failure itself is what gets recorded
    }
    record(step, 'FAIL', { error: String(e.message ?? e).slice(0, 600), screenshot: `${name}.png` })
  }
}
function shot(name) {
  const png = screencap()
  writeFileSync(join(outDir, `${name}.png`), png)
  return png
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}
const pickerLog = () =>
  adb(['logcat', '-d', '-v', 'raw', 'ReactNativeJS:V', '*:S'], { allowFail: true })
    .split('\n')
    .filter((l) => /photo (library|camera) failed|unregistered ActivityResultLauncher/.test(l))
    .join(' | ')
    .slice(0, 400)

// ---------------------------------------------------------------------------------------------
const dp = pxPerDp()
const MIN_PX = Math.floor(48 * dp)
const root = rootAvailable()
await sleep(1500)
const stylusBefore = shell('settings get secure stylus_handwriting_enabled').trim()
function resetDevice() {
  shell('settings put system font_scale 1.0')
  shell('wm density reset')
  shell(`cmd locale set-app-locales ${PACKAGE} --locales ""`, { allowFail: true })
  shell('cmd uimode night no')
}
shell(`am force-stop ${PACKAGE}`)
shell(`pm clear ${PACKAGE}`)
shell('settings put secure stylus_handwriting_enabled 0')
resetDevice()
adb(['logcat', '-c'])
adb(['logcat', '-b', 'crash', '-c'], { allowFail: true })
await pushSyntheticImage(join(outDir, 'p167-synthetic-card.png'), 'p167-synthetic-card.png')
amStart()
await waitFor((ns) => byId(ns, 'login-screen'), { label: 'login screen' })

// ---- F7 keyboard ------------------------------------------------------------------------------
await run(
  'F7 keyboard: Sign in stays reachable with the keyboard open (button, not IME)',
  async () => {
    const n = (await waitFor((ns) => byId(ns, 'login-email') && ns, { label: 'login form' })).value
    tap(byId(n, 'login-email'))
    adb(['shell', 'input', 'text', fixture.users.a.email])
    shell('input keyevent 66') // IME "next" -> focus moves to the password field
    await sleep(600)
    let m = dump()
    assert(byId(m, 'login-password')?.focusable, 'password field missing')
    adb(['shell', 'input', 'text', fixture.users.a.password])
    await sleep(800)
    const ime = imeFrame()
    m = dump()
    const submit = byId(m, 'login-submit')
    shot('f7-keyboard-open') // shows no secret: the password field is masked, the email is synthetic
    assert(ime !== null, 'keyboard not shown after focusing the password field')
    assert(submit?.bounds, 'Sign in button not in the view tree with the keyboard open')
    const covered = submit.bounds.y2 > ime.y1
    assert(
      !covered,
      `Sign in button (bottom ${submit.bounds.y2}px) is under the keyboard (top ${ime.y1}px)`,
    )
    tap(submit) // the BUTTON, not the IME action
    const t0 = Date.now()
    const r = await waitFor((ns) => (rows(ns).length > 0 || byId(ns, 'login-error')) && ns, {
      timeoutMs: 60000,
      label: 'first page after tapping Sign in',
    })
    assert(!byId(r.value, 'login-error'), `login error: ${text(r.value, 'login-error')}`)
    return { imeTopPx: ime.y1, submitBottomPx: submit.bounds.y2, firstPageMs: Date.now() - t0 }
  },
)
if (rows(dump()).length === 0) {
  // The keyboard step did not end signed in (e.g. its FAIL): start clean so the fields are empty.
  shell(`am force-stop ${PACKAGE}`)
  shell(`pm clear ${PACKAGE}`)
  amStart()
  await signIn(fixture.users.a)
}

// ---- F3 tabs + F6 touch targets ----------------------------------------------------------------
function tabReport(nodes) {
  const ids = ['tab-collection', 'tab-search', 'tab-pricecheck', 'tab-profile']
  const want = {
    'tab-collection': 'Collection',
    'tab-search': 'Search',
    'tab-pricecheck': 'Price Check',
    'tab-profile': 'Profile',
  }
  return ids.map((id) => {
    const n = byId(nodes, id)
    const inside = n?.bounds
      ? nodes.filter(
          (c) =>
            c !== n &&
            c.text &&
            c.bounds &&
            c.bounds.x1 >= n.bounds.x1 &&
            c.bounds.x2 <= n.bounds.x2 &&
            c.bounds.y1 >= n.bounds.y1 &&
            c.bounds.y2 <= n.bounds.y2,
        )
      : []
    return {
      id,
      desc: n?.desc ?? null,
      visibleText: inside.map((c) => c.text),
      heightDp: n?.bounds ? Math.round((n.bounds.y2 - n.bounds.y1) / dp) : null,
      widthDp: n?.bounds ? Math.round((n.bounds.x2 - n.bounds.x1) / dp) : null,
      expected: want[id],
    }
  })
}
await run('F3 tabs: text labels, clean accessible names, no fallback glyph', async () => {
  const tabs = tabReport(dump())
  shot('f3-tabs')
  for (const t of tabs) {
    assert(
      t.desc === t.expected,
      `${t.id} accessible name ${JSON.stringify(t.desc)} != ${t.expected}`,
    )
    assert(
      t.visibleText.includes(t.expected),
      `${t.id} does not show its label (${JSON.stringify(t.visibleText)})`,
    )
    assert(
      t.visibleText.every((s) => /^[A-Za-z ]+$/.test(s)),
      `${t.id} shows a non-text glyph ${JSON.stringify(t.visibleText)}`,
    )
  }
  return tabs
})

function smallTargets(nodes) {
  const list = byId(nodes, 'collection-list')?.bounds
  return nodes
    .filter((x) => x.clickable && x.pkg === PACKAGE && x.bounds)
    .filter((x) => {
      const b = x.bounds
      // a list row cut off by the list's own edge is partly scrolled out, not undersized
      if (list && /row-/.test(x.id) && (b.y1 <= list.y1 || b.y2 >= list.y2)) return false
      return b.y2 - b.y1 < MIN_PX || b.x2 - b.x1 < MIN_PX
    })
    .map((x) => ({
      id: x.id || x.desc || x.text,
      hDp: Math.round((x.bounds.y2 - x.bounds.y1) / dp),
      wDp: Math.round((x.bounds.x2 - x.bounds.x1) / dp),
    }))
}
await run(
  'F6 touch targets >= 48 dp on Collection, Price Check, Photo, Profile, Card detail',
  async () => {
    const out = {}
    out.collection = smallTargets(dump())
    tap(rows(dump())[0])
    await waitFor((ns) => byId(ns, 'card-detail'), { label: 'card detail' })
    out.cardDetail = smallTargets(dump())
    shell('input keyevent 4')
    await waitFor((ns) => byId(ns, 'collection-list'), { label: 'list' })
    tap(byId(dump(), 'tab-pricecheck'))
    await waitFor((ns) => byId(ns, 'price-check-home'), { label: 'price check' })
    out.priceCheck = smallTargets(dump())
    await openPhotoScreen()
    out.photo = smallTargets(dump())
    shell('input keyevent 4')
    tap((await waitFor((ns) => byId(ns, 'tab-profile'), { label: 'profile tab' })).value)
    await waitFor((ns) => byId(ns, 'profile'), { label: 'profile' })
    out.profile = smallTargets(dump())
    tap(byId(dump(), 'tab-collection'))
    const bad = Object.entries(out).filter(([, v]) => v.length > 0)
    assert(bad.length === 0, `under 48 dp: ${JSON.stringify(bad)}`)
    return { minPx: MIN_PX, pxPerDp: dp, screens: Object.keys(out) }
  },
)

// ---- F1 picker after a genuine Activity recreation ----------------------------------------------
const CONFIG_CHANGES = [
  {
    name: 'fontScale 1.3',
    apply: () => shell('settings put system font_scale 1.3'),
    revert: () => shell('settings put system font_scale 1.0'),
  },
  {
    name: 'display density 480',
    apply: () => shell('wm density 480'),
    revert: () => shell('wm density reset'),
  },
  {
    name: 'app locale nb-NO',
    apply: () => shell(`cmd locale set-app-locales ${PACKAGE} --locales nb-NO`),
    revert: () => shell(`cmd locale set-app-locales ${PACKAGE} --locales ""`, { allowFail: true }),
  },
]
for (const change of CONFIG_CHANGES) {
  await run(
    `F1 picker after Activity recreation (${change.name}): pick, owned copy, cleanup`,
    async () => {
      if (!root) throw new NotRun('adb root unavailable: the owned cache copy cannot be observed')
      await openPhotoScreen()
      const before = localActivityId()
      clearEvents()
      adb(['logcat', '-c'])
      change.apply()
      await sleep(3500)
      const after = localActivityId()
      const events = lifecycleEvents()
      const recreated =
        before !== null &&
        after !== null &&
        before !== after &&
        events.some((l) => l.includes('wm_on_destroy_called')) &&
        events.some((l) => l.includes('wm_on_create_called'))
      assert(
        recreated,
        `Activity was not recreated (before ${before}, after ${after}, events ${events.length})`,
      )
      await waitFor((ns) => byId(ns, 'photo-library') || rows(ns).length > 0, {
        label: 'app after recreation',
      })
      const navigation = byId(dump(), 'photo-library') ? 'kept on the photo screen' : 'reset'
      const n = await openPhotoScreen()
      const cacheBefore = pickerCacheFiles()
      tap(byId(n, 'photo-library'))
      const opened = await waitForPickerOrState()
      shot(`f1-${change.name.split(' ')[0]}-picker`)
      assert(opened.picker, `picker did not open (state ${opened.state}; ${pickerLog()})`)
      await sleep(1200)
      const how = await chooseNewestInPicker()
      const ready = await waitFor((ns) => byId(ns, 'photo-ready') && ns, {
        timeoutMs: 20000,
        label: 'photo ready',
      })
      shot(`f1-${change.name.split(' ')[0]}-ready`)
      const during = pickerCacheFiles().filter((f) => !cacheBefore.includes(f))
      assert(during.length === 1, `expected one owned copy while shown, found ${during.length}`)
      shell('input keyevent 4') // leave the photo screen -> release()
      await sleep(1500)
      const leftover = pickerCacheFiles().filter((f) => during.includes(f))
      change.revert()
      await sleep(3000)
      assert(leftover.length === 0, `owned copy not deleted on exit: ${leftover.join(',')}`)
      assert(
        !/unregistered ActivityResultLauncher/.test(pickerLog()),
        `launcher error logged: ${pickerLog()}`,
      )
      return {
        activityBefore: before,
        activityAfter: after,
        navigation,
        lifecycle: events.map((l) => l.replace(/^.*?(wm_\w+).*?\[(.*)\]$/, '$1 [$2]')).slice(-4),
        picked: how,
        meta: text(ready.value, 'photo-meta'),
        ownedCopies: during.length,
        remainingAfterExit: 0,
      }
    },
  )
}

await run(
  'Activity recreation keeps the screen the person was on (card detail, font scale)',
  async () => {
    await ensureApp()
    tap((await waitFor((ns) => byId(ns, 'tab-collection'), { label: 'collection tab' })).value)
    const n = (await waitFor((ns) => rows(ns).length > 0 && ns, { label: 'rows' })).value
    tap(rows(n)[0])
    const d = (await waitFor((ns) => byId(ns, 'card-detail') && ns, { label: 'detail' })).value
    const value = text(d, 'detail-holding-value')
    const before = localActivityId()
    shell('settings put system font_scale 1.3')
    await sleep(3500)
    const after = localActivityId()
    assert(before !== after, 'Activity was not recreated')
    const r = await waitFor((ns) => (byId(ns, 'card-detail') || rows(ns).length > 0) && ns, {
      label: 'after recreation',
    })
    shell('settings put system font_scale 1.0')
    await sleep(3000)
    assert(byId(r.value, 'card-detail'), 'navigation was reset to the collection list')
    assert(text(r.value, 'detail-holding-value') === value, 'a different holding is shown')
    shell('input keyevent 4')
    return { activityBefore: before, activityAfter: after, stillOnDetail: true }
  },
)

// ---- photo lifecycle ----------------------------------------------------------------------------
await run('photo: library picker cancel -> "No photo chosen", then reopen works', async () => {
  const n = await openPhotoScreen()
  tap(byId(n, 'photo-library'))
  let o = await waitForPickerOrState()
  assert(o.picker, `picker did not open (${o.state})`)
  shell('input keyevent 4')
  const r = await waitFor(
    (ns) => (byId(ns, 'photo-cancelled') || byId(ns, 'photo-unavailable')) && ns,
    { label: 'cancelled' },
  )
  assert(byId(r.value, 'photo-cancelled'), 'cancel reported as unavailable')
  tap(byId(dump(), 'photo-library'))
  o = await waitForPickerOrState()
  assert(o.picker, 'picker did not reopen after a cancel')
  shell('input keyevent 4')
  await waitFor((ns) => byId(ns, 'photo-cancelled'), { label: 'cancelled again' })
  return { cancelled: text(r.value, 'photo-cancelled'), reopened: true }
})

await run('photo: rapid double tap opens one picker, no error state', async () => {
  const n = await openPhotoScreen()
  const b = byId(n, 'photo-library').bounds
  const [x, y] = [Math.round((b.x1 + b.x2) / 2), Math.round((b.y1 + b.y2) / 2)]
  shell(`input touchscreen tap ${x} ${y}; input touchscreen tap ${x} ${y}`)
  const o = await waitForPickerOrState()
  assert(o.picker, `picker did not open (${o.state}; ${pickerLog()})`)
  shell('input keyevent 4')
  const r = await waitFor(
    (ns) => (byId(ns, 'photo-cancelled') || byId(ns, 'photo-unavailable')) && ns,
    { label: 'state' },
  )
  assert(!byId(r.value, 'photo-unavailable'), `double tap produced "unavailable" (${pickerLog()})`)
  await sleep(800)
  assert(!/photopicker|PhotoPicker/i.test(focusedWindow()), 'a second picker stayed open')
  return { state: 'cancelled', secondPicker: false }
})

await run('photo: camera permission denied -> denied card', async () => {
  shell(`pm revoke ${PACKAGE} android.permission.CAMERA`)
  shell(`pm clear-permission-flags ${PACKAGE} android.permission.CAMERA user-set user-fixed`)
  const n = await openPhotoScreen()
  tap(byId(n, 'photo-camera'))
  const dlg = await waitFor((ns) => ns.find((x) => /permission_deny_button/.test(x.id)) && ns, {
    timeoutMs: 15000,
    label: 'permission dialog',
  })
  tap(dlg.value.find((x) => /permission_deny_button/.test(x.id)))
  await waitFor((ns) => byId(ns, 'photo-denied'), { label: 'denied state' })
  shot('photo-camera-denied')
  return { deniedCard: true }
})

await run('photo: camera "only this time" -> system camera -> back = cancelled', async () => {
  shell(`pm revoke ${PACKAGE} android.permission.CAMERA`)
  shell(`pm clear-permission-flags ${PACKAGE} android.permission.CAMERA user-set user-fixed`)
  const n = await openPhotoScreen()
  tap(byId(n, 'photo-camera'))
  const dlg = await waitFor(
    (ns) => ns.find((x) => /permission_allow_one_time_button/.test(x.id)) && ns,
    { timeoutMs: 15000, label: 'permission dialog' },
  )
  tap(dlg.value.find((x) => /permission_allow_one_time_button/.test(x.id)))
  let cam = ''
  for (let i = 0; i < 20 && !/camera/i.test(cam); i++) {
    await sleep(500)
    cam = focusedWindow()
  }
  shot('photo-camera-open')
  assert(/camera/i.test(cam), `system camera did not open (focus ${cam})`)
  shell('input keyevent 4')
  const r = await waitFor(
    (ns) => (byId(ns, 'photo-cancelled') || byId(ns, 'photo-unavailable')) && ns,
    { timeoutMs: 20000, label: 'state after camera' },
  )
  assert(byId(r.value, 'photo-cancelled'), 'leaving the camera was not reported as cancelled')
  shell(`pm revoke ${PACKAGE} android.permission.CAMERA`) // kills the app: it held the grant
  await ensureApp()
  return { cameraActivity: cam, state: 'cancelled' }
})

await run(
  'photo: process killed while the picker is open -> no crash, no orphan copy',
  async () => {
    if (!root) throw new NotRun('adb root unavailable')
    const n = await openPhotoScreen()
    const before = pickerCacheFiles()
    const crashesBefore = crashCount()
    tap(byId(n, 'photo-library'))
    const o = await waitForPickerOrState()
    assert(o.picker, `picker did not open (${o.state})`)
    const pid = appPid()
    shell(`kill -9 ${pid}`) // what the low-memory killer does to a background app
    await sleep(1500)
    assert(appPid() !== pid, 'app process survived kill -9')
    await chooseNewestInPicker()
    // What Android does with the result of a picker whose caller died is the system's choice; record it.
    await sleep(4000)
    const afterPick = focusedWindow()
    shot('photo-kill-while-picker')
    const systemRelaunched = afterPick.includes(PACKAGE)
    // Then open the app as a person would.
    await ensureApp()
    const r = await waitFor(
      (ns) => (rows(ns).length > 0 || byId(ns, 'login-screen') || byId(ns, 'photo-library')) && ns,
      { timeoutMs: 60000, label: 'app after restart' },
    )
    await sleep(2000)
    const created = pickerCacheFiles().filter((f) => !before.includes(f))
    assert(crashCount() === crashesBefore, 'a crash was logged')
    assert(created.length === 0, `orphan picker copy after the restart: ${created.join(',')}`)
    assert(!byId(r.value, 'photo-ready'), 'a photo from the killed process was shown')
    return {
      afterPickFocus: systemRelaunched ? 'app relaunched by the system' : afterPick,
      reopenedTo:
        rows(r.value).length > 0
          ? 'collection (session restored)'
          : byId(r.value, 'login-screen')
            ? 'login'
            : 'photo screen, empty',
      orphanCopies: 0,
      crashes: 0,
    }
  },
)

await run('photo: process killed while a photo is shown -> copy purged on next start', async () => {
  if (!root) throw new NotRun('adb root unavailable')
  const n = await openPhotoScreen()
  tap(byId(n, 'photo-library'))
  const o = await waitForPickerOrState()
  assert(o.picker, `picker did not open (${o.state})`)
  await sleep(1000)
  await chooseNewestInPicker()
  await waitFor((ns) => byId(ns, 'photo-ready'), { timeoutMs: 20000, label: 'photo ready' })
  const shown = pickerCacheFiles()
  assert(shown.length >= 1, 'no owned copy while shown')
  shell(`kill -9 ${appPid()}`)
  await sleep(1500)
  assert(
    pickerCacheFiles().length >= 1,
    'copy vanished without a restart (test cannot distinguish)',
  )
  amStart()
  await waitFor((ns) => rows(ns).length > 0 || byId(ns, 'login-screen'), {
    timeoutMs: 60000,
    label: 'restart',
  })
  await sleep(1500)
  const left = pickerCacheFiles()
  assert(left.length === 0, `orphaned copy survived the restart: ${left.join(',')}`)
  return { copiesWhileShown: shown.length, afterRestart: 0 }
})

await run(
  'photo A -> B: after sign-out and B sign-in no A photo, file or row is reachable',
  async () => {
    if (!root) throw new NotRun('adb root unavailable')
    const n = await openPhotoScreen()
    tap(byId(n, 'photo-library'))
    assert((await waitForPickerOrState()).picker, 'picker did not open')
    await sleep(1000)
    await chooseNewestInPicker()
    await waitFor((ns) => byId(ns, 'photo-ready'), { timeoutMs: 20000, label: 'A photo ready' })
    const aCopies = pickerCacheFiles()
    shell('input keyevent 4')
    tap((await waitFor((ns) => byId(ns, 'tab-profile'), { label: 'profile tab' })).value)
    tap((await waitFor((ns) => byId(ns, 'sign-out'), { label: 'sign out' })).value)
    await waitFor((ns) => byId(ns, 'login-screen'), { label: 'login after sign-out' })
    const r = await signIn(fixture.users.b)
    const labels = rows(r.nodes).map((x) => x.desc)
    const leaked = labels.filter((l) =>
      /Astronomical|Above Safe Integer|Twin Finish|No Prices|Manual Zero|Priced Both/.test(l),
    )
    assert(leaked.length === 0, `A rows visible for B: ${leaked.join('; ')}`)
    assert(
      text(r.nodes, 'collection-total') === '—',
      `B total ${text(r.nodes, 'collection-total')}`,
    )
    const p = await openPhotoScreen()
    shot('photo-a-to-b')
    assert(!byId(p, 'photo-ready') && !byId(p, 'photo-meta'), 'a photo is shown to B')
    const left = pickerCacheFiles().filter((f) => aCopies.includes(f))
    assert(left.length === 0, `A copy still on disk under B: ${left.join(',')}`)
    shell('input keyevent 4')
    // back to A for the remaining steps
    tap((await waitFor((ns) => byId(ns, 'tab-profile'), { label: 'profile tab' })).value)
    tap((await waitFor((ns) => byId(ns, 'sign-out'), { label: 'sign out' })).value)
    await waitFor((ns) => byId(ns, 'login-screen'), { label: 'login after sign-out' })
    await signIn(fixture.users.a)
    return {
      aCopiesWhileShown: aCopies.length,
      aCopiesUnderB: 0,
      bRowsVisible: labels.length,
      bTotal: '—',
    }
  },
)

// ---- F5 dark mode -------------------------------------------------------------------------------
function barsReport(name) {
  const png = decodePng(shot(name))
  const appearance = /mLastAppearance=([^\n]*)/.exec(shell('dumpsys window'))?.[1]?.trim() ?? ''
  const statusBand = png.bandLuminance(0, Math.round(24 * dp))
  const header = png.bandLuminance(Math.round(30 * dp), Math.round(80 * dp))
  const content = png.bandLuminance(Math.round(300 * dp), Math.round(500 * dp))
  const tabBar = png.bandLuminance(png.h - Math.round(80 * dp), png.h - Math.round(30 * dp))
  const lightIcons = !/LIGHT_STATUS_BARS/.test(appearance)
  return {
    appearance,
    statusBand,
    header,
    content,
    tabBar,
    statusIcons: lightIcons ? 'light' : 'dark',
  }
}
function assertLegible(r, scheme) {
  const dark = scheme === 'dark'
  for (const [k, v] of Object.entries({
    statusBand: r.statusBand,
    header: r.header,
    content: r.content,
    tabBar: r.tabBar,
  })) {
    assert(dark ? v < 0.35 : v > 0.65, `${scheme}: ${k} luminance ${v}`)
  }
  assert(
    r.statusIcons === (dark ? 'light' : 'dark'),
    `${scheme}: status bar icons ${r.statusIcons} on a ${dark ? 'dark' : 'light'} bar`,
  )
}
await run(
  'F5 dark mode switched in the foreground: header, content, tab bar and status bar agree',
  async () => {
    await ensureApp()
    if (rows(dump()).length === 0) tap(byId(dump(), 'tab-collection'))
    await waitFor((ns) => rows(ns).length > 0, { label: 'rows' })
    const light = barsReport('f5-light')
    assertLegible(light, 'light')
    shell('cmd uimode night yes')
    await sleep(2500)
    const dark = barsReport('f5-dark-foreground')
    assertLegible(dark, 'dark')
    return { light, dark }
  },
)
await run('F5 dark mode switched while backgrounded, then resumed', async () => {
  shell('cmd uimode night no')
  await sleep(1500)
  shell('input keyevent 3')
  await sleep(1000)
  shell('cmd uimode night yes')
  await sleep(1500)
  amStart()
  await waitFor((ns) => rows(ns).length > 0, { label: 'rows after resume' })
  await sleep(1000)
  const dark = barsReport('f5-dark-resumed')
  assertLegible(dark, 'dark')
  tap(rows(dump())[0])
  await waitFor((ns) => byId(ns, 'card-detail'), { label: 'detail' })
  const detail = barsReport('f5-dark-detail')
  assert(
    detail.header < 0.35 && detail.statusIcons === 'light',
    `detail header ${detail.header} icons ${detail.statusIcons}`,
  )
  shell('input keyevent 4')
  shell('cmd uimode night no')
  await sleep(1500)
  return { dark, detail }
})

await run('F5 3-button navigation: the navigation bar follows a live dark switch', async () => {
  await ensureApp()
  shell('cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton')
  try {
    shell('cmd uimode night no')
    await sleep(2500)
    shell('cmd uimode night yes')
    await sleep(2500)
    const png = decodePng(shot('f5-dark-3button'))
    const appearance = /mLastAppearance=([^\n]*)/.exec(shell('dumpsys window'))?.[1]?.trim() ?? ''
    const navBar = png.bandLuminance(png.h - Math.round(40 * dp), png.h)
    const tabBar = png.bandLuminance(png.h - Math.round(110 * dp), png.h - Math.round(60 * dp))
    assert(
      !/LIGHT_NAVIGATION_BARS/.test(appearance),
      `dark mode still requests dark navigation icons (${appearance})`,
    )
    assert(navBar < 0.35, `navigation bar luminance ${navBar} under a dark app (tab bar ${tabBar})`)
    return { appearance, navBar, tabBar }
  } finally {
    shell('cmd uimode night no')
    shell('cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.gestural')
    await sleep(2000)
  }
})

// ---- F4 font scale 2.0 --------------------------------------------------------------------------
await run(
  'F4 font scale 2.0: exact amounts, labels and tabs present (screenshots for visual review)',
  async () => {
    shell('settings put system font_scale 2.0')
    await sleep(3000)
    let n = (await waitFor((ns) => rows(ns).length > 0 && ns, { label: 'rows at 2.0' })).value
    shot('f4-font2-collection')
    const total = plain(text(n, 'collection-total') ?? '')
    assert(total === '8 917 127 262 195 456,87 kr', `total at 2.0 is ${JSON.stringify(total)}`)
    const tabs = tabReport(n)
    for (const t of tabs) assert(t.visibleText.includes(t.expected), `${t.id} label missing at 2.0`)
    tap(rows(n)[0])
    n = (await waitFor((ns) => byId(ns, 'card-detail') && ns, { label: 'detail at 2.0' })).value
    shot('f4-font2-detail')
    const value = plain(text(n, 'detail-holding-value') ?? '')
    shell('input keyevent 4')
    shell('settings put system font_scale 1.0')
    await sleep(3000)
    return { total, detailValue: value, tabHeightsDp: tabs.map((t) => t.heightDp) }
  },
)

// ---- collection: scroll > 100 items and back to top ----------------------------------------------
await run('collection: > 100 rows scrolled, stable keys, no blank samples', async () => {
  if (rows(dump()).length === 0) tap(byId(dump(), 'tab-collection'))
  await waitFor((ns) => rows(ns).length > 0, { label: 'rows' })
  const ids = new Set()
  let blank = 0
  for (let i = 0; i < 25; i++) {
    shell('input touchscreen swipe 540 1900 540 500 150')
    await sleep(300)
    const n = dump()
    const r = rows(n)
    if (r.length === 0 && !byId(n, 'loading')) blank += 1
    for (const x of r) ids.add(x.id)
  }
  assert(ids.size > 100, `only ${ids.size} distinct rows`)
  assert(blank === 0, `${blank} blank samples`)
  return { distinctRows: ids.size, blankSamples: blank }
})

resetDevice()
shell(
  stylusBefore === 'null'
    ? 'settings delete secure stylus_handwriting_enabled'
    : `settings put secure stylus_handwriting_enabled ${stylusBefore}`,
)
const apk = shell(`pm path ${PACKAGE}`).trim()
writeFileSync(
  join(outDir, 'report.json'),
  JSON.stringify(
    { when: new Date().toISOString(), activity: ACTIVITY, apk, pxPerDp: dp, steps },
    null,
    2,
  ),
)
const count = (s) => steps.filter((x) => x.status === s).length
console.log(
  `\nRESULT pass=${count('PASS')} fail=${count('FAIL')} not_run=${count('NOT_RUN')} -> ${join(outDir, 'report.json')}`,
)
process.exit(count('FAIL') > 0 ? 1 : 0)
