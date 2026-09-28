#!/usr/bin/env node
/**
 * P184 write-reliability and date-boundary gates on the installed release build: the pending-write
 * journal under a LOST RESPONSE (the server committed, the answer never arrived), PROCESS DEATH
 * after the commit and BACKGROUNDING during a submit — none may produce a second transaction — and
 * the Europe/Oslo local-calendar-date boundary (local 00:30 while UTC is still the previous day).
 * LOCAL ONLY, synthetic user only.
 *
 *   node scripts/p184/writes-check.mjs         (P184_STEPS=<regex> runs a subset)
 *
 * Needs the capture proxy (55781: drop / hold), the mock TCGdex and adb root. Output:
 * .build/p184-evidence/writes-report.json
 */
import './env.mjs'
import { amStart, appPid, rootAvailable } from '../android-p167-lib.mjs'
import {
  byId,
  dump,
  ensureSignedIn,
  proxy,
  psql,
  saveJson,
  shell,
  shot,
  sleep,
  tap,
  users,
  waitFor,
} from './lib.mjs'
import { findScrolling, tapScrolling, typeInto } from './flows.mjs'
import { B, choosePrinting, counts, diff, scanToCard } from './journeys.mjs'

const only = process.env.P184_STEPS ? new RegExp(process.env.P184_STEPS, 'i') : null
const report = []
async function step(name, fn) {
  if (only && !only.test(name)) return
  const t0 = Date.now()
  try {
    const detail = await fn()
    report.push({ step: name, status: 'PASS', ms: Date.now() - t0, detail })
    console.log(`PASS ${name}  ${JSON.stringify(detail ?? null).slice(0, 900)}`)
  } catch (e) {
    report.push({
      step: name,
      status: 'FAIL',
      ms: Date.now() - t0,
      detail: String(e.message ?? e).slice(0, 900),
    })
    console.log(`FAIL ${name}  ${String(e.message ?? e).slice(0, 700)}`)
    try {
      shot(`writes-fail-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`)
    } catch {
      // The failure itself is what matters.
    }
  }
}

/** Scanner -> printing -> Record purchase form (NOK), ready to type into. */
async function openPurchaseForm(label) {
  const { cardId } = await scanToCard('f17-p169-charizard.jpg', label, 'P169 Charizard')
  const printing = await choosePrinting(cardId, 'holo')
  const { node } = await findScrolling('p169-add-to-collection')
  tap(node)
  await waitFor((ns) => byId(ns, 'p170-add-intent'), { label: 'add intent screen' })
  await tapScrolling('p175-go-record-purchase')
  await waitFor((ns) => byId(ns, 'p175-record-purchase'), { label: 'record purchase screen' })
  return { cardId, printing }
}

const purchaseRows = (since) =>
  psql(
    `select id||'|'||total_minor||'|'||purchased_on||'|'||coalesce(idempotency_key::text,'-') from purchases where user_id='${B.id}' and created_at >= '${since}' order by created_at`,
  )
    .split('\n')
    .filter(Boolean)
const dbNow = () => psql('select now()')

amStart()
await ensureSignedIn(B)
const haveRoot = rootAvailable()

// ------------------------------------------------------------------------------------------------
await step(
  'lost response: the server commits, the answer is lost, the retry creates no second purchase',
  async () => {
    const since = dbNow()
    const before = counts()
    await openPurchaseForm('w1')
    await typeInto('p175-purchase-unit-price', '7.00')
    await proxy('drop?match=create_purchase', 'POST')
    await tapScrolling('p175-confirm-purchase')
    const uncertain = await waitFor(
      (ns) => byId(ns, 'p180-purchase-uncertain') || byId(ns, 'p175-purchase-success'),
      { timeoutMs: 60000, label: 'uncertain notice' },
    )
    const shownUncertain = byId(uncertain.value, 'p180-purchase-uncertain') !== undefined
    shot('w1-uncertain')
    const afterLoss = counts()
    const committed = diff(before, afterLoss)
    // The person retries (the notice tells them to check first; a retry is what a hurried user does).
    await tapScrolling('p175-confirm-purchase')
    await waitFor(
      (ns) =>
        byId(ns, 'collection-list') ||
        byId(ns, 'p175-purchase-success') ||
        byId(ns, 'p180-purchase-uncertain'),
      { timeoutMs: 60000, label: 'retry outcome' },
    )
    await sleep(2000)
    const afterRetry = counts()
    const rows = purchaseRows(since)
    const dropped = (await proxy('log')).requests.filter((r) => r.dropped)
    if (dropped.length !== 1)
      throw new Error(`expected one dropped response, saw ${dropped.length}`)
    if (committed.purchases !== 1)
      throw new Error(`the first request did not commit: ${JSON.stringify(committed)}`)
    if (afterRetry[2] - before[2] !== 1)
      throw new Error(`a retry created a second purchase: ${rows.join(' ; ')}`)
    return {
      shownUncertain,
      committedDespiteLostResponse: committed,
      purchasesAfterRetry: afterRetry[2] - before[2],
      rows: rows.length,
    }
  },
)

await step(
  'process death after the commit: restart finds the purchase, nothing is recorded twice',
  async () => {
    if (!haveRoot) throw new Error('adb root is not available')
    const since = dbNow()
    const before = counts()
    await openPurchaseForm('w2')
    await typeInto('p175-purchase-unit-price', '8.00')
    await proxy('drop?match=create_purchase', 'POST')
    await tapScrolling('p175-confirm-purchase')
    // The request is forwarded at once; give the server the moment it needs to commit, then kill the app
    // before it can do anything with the (lost) answer.
    const started = Date.now()
    for (;;) {
      if (counts()[2] - before[2] === 1) break
      if (Date.now() - started > 20000) throw new Error('the purchase never committed')
      await sleep(150)
    }
    const pid = appPid()
    shell(`kill -9 ${pid}`)
    await sleep(1500)
    if (appPid() === pid) throw new Error('the app process was not killed')
    amStart()
    await ensureSignedIn(B)
    await sleep(6000)
    const afterRestart = counts()
    // Open the same form again: the journal entry (if unresolved) must be shown, not silently repeated.
    await openPurchaseForm('w2b')
    const unresolved = byId(dump(), 'p180-purchase-unresolved-notice') !== undefined
    shot('w2-after-restart')
    const rows = purchaseRows(since)
    if (afterRestart[2] - before[2] !== 1)
      throw new Error(
        `the restart changed the purchase count: ${JSON.stringify(diff(before, afterRestart))}`,
      )
    return {
      committedBeforeKill: 1,
      purchasesAfterRestart: afterRestart[2] - before[2],
      unresolvedNoticeShown: unresolved,
      rows: rows.length,
    }
  },
)

await step(
  'background during submit: the answer arrives while backgrounded, one purchase, consistent screen',
  async () => {
    const since = dbNow()
    const before = counts()
    await proxy('release', 'POST')
    await openPurchaseForm('w3')
    await typeInto('p175-purchase-unit-price', '9.00')
    await proxy('hold?match=create_purchase', 'POST')
    await tapScrolling('p175-confirm-purchase')
    await sleep(1200)
    shell('input keyevent 3') // HOME while the request is in flight
    await sleep(6000)
    await proxy('release', 'POST')
    await sleep(3000)
    amStart()
    await waitFor(
      (ns) =>
        byId(ns, 'collection-list') ||
        byId(ns, 'p175-purchase-success') ||
        byId(ns, 'p180-purchase-uncertain') ||
        byId(ns, 'p175-record-purchase'),
      { timeoutMs: 40000, label: 'screen after resume' },
    )
    await sleep(2000)
    const after = counts()
    const screen = [
      'collection-list',
      'p175-purchase-success',
      'p180-purchase-uncertain',
      'p175-record-purchase',
    ].find((id) => byId(dump(), id))
    const rows = purchaseRows(since)
    shot('w3-after-resume')
    if (after[2] - before[2] !== 1)
      throw new Error(`expected one purchase, saw ${after[2] - before[2]}: ${rows.join(' ; ')}`)
    return { purchases: after[2] - before[2], screenAfterResume: screen, rows: rows.length }
  },
)

// ------------------------------------------------------------------------------------------------
const tz0 = shell('getprop persist.sys.timezone', { allowFail: true }).trim()
async function setLocalTime(oslo, epochMs) {
  // Order matters: zone first, then the wall clock (interpreted in the zone just set).
  shell('settings put global auto_time 0')
  shell('settings put global auto_time_zone 0')
  shell(`setprop persist.sys.timezone ${oslo}`)
  shell(`service call alarm 3 s16 ${oslo}`, { allowFail: true })
  await sleep(1000)
  const d = new Date(epochMs)
  const p = (n) => String(n).padStart(2, '0')
  shell(
    `date -u ${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${d.getUTCFullYear()}.00`,
  )
  await sleep(1500)
}
async function restoreClock() {
  shell('settings put global auto_time 1')
  shell('settings put global auto_time_zone 1')
  if (tz0) {
    shell(`setprop persist.sys.timezone ${tz0}`)
    shell(`service call alarm 3 s16 ${tz0}`, { allowFail: true })
  }
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  shell(
    `date -u ${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${d.getUTCFullYear()}.00`,
  )
  await sleep(1500)
}

for (const cfg of [
  {
    label: 'Oslo 00:30 local (UTC 22:30 the previous day)',
    utc: Date.UTC(2026, 8, 28, 22, 30, 0),
    expectLocal: '2026-09-29',
    expectUtcDate: '2026-09-28',
  },
  {
    label: 'Oslo 01:30 local (UTC 23:30 the previous day)',
    utc: Date.UTC(2026, 8, 28, 23, 30, 0),
    expectLocal: '2026-09-29',
    expectUtcDate: '2026-09-28',
  },
]) {
  await step(`Oslo midnight boundary: ${cfg.label}`, async () => {
    if (!haveRoot) throw new Error('adb root is not available')
    const before = counts()
    try {
      await setLocalTime('Europe/Oslo', cfg.utc)
      const deviceLocal = shell('date "+%Y-%m-%d %H:%M %Z"').trim()
      const deviceUtc = shell('date -u "+%Y-%m-%d %H:%M"').trim()
      amStart()
      await ensureSignedIn(B)
      await sleep(3000)
      await openPurchaseForm(`oslo${cfg.utc}`)
      await typeInto('p175-purchase-unit-price', '5.00')
      const dateField = byId(dump(), 'p175-purchase-date')
      const defaultDate = dateField?.text ?? null
      await tapScrolling('p175-confirm-purchase')
      await waitFor(
        (ns) =>
          byId(ns, 'collection-list') ||
          byId(ns, 'p175-purchase-success') ||
          byId(ns, 'p180-purchase-uncertain'),
        { timeoutMs: 40000, label: 'purchase result' },
      )
      await sleep(1500)
      const stored = psql(
        `select purchased_on from purchases where user_id='${B.id}' order by created_at desc limit 1`,
      )
      const after = counts()
      if (after[2] - before[2] !== 1)
        throw new Error(`expected one purchase: ${JSON.stringify(diff(before, after))}`)
      if (stored !== cfg.expectLocal)
        throw new Error(
          `purchased_on is ${stored}, the local calendar date is ${cfg.expectLocal} (UTC date ${cfg.expectUtcDate})`,
        )
      return {
        deviceLocal,
        deviceUtc,
        defaultDateField: defaultDate,
        storedPurchasedOn: stored,
        expectLocal: cfg.expectLocal,
      }
    } finally {
      await restoreClock()
    }
  })
}

// After the run the clock is real again and auto time/zone are back on.
report.push({
  step: 'clock restored',
  status: 'INFO',
  detail: {
    tzBefore: tz0,
    deviceDate: shell('date').trim(),
    autoTime: shell('settings get global auto_time').trim(),
    autoZone: shell('settings get global auto_time_zone').trim(),
  },
})
saveJson('writes-report.json', { report, proxyLog: await proxy('audit') })
const failed = report.filter((r) => r.status === 'FAIL').length
console.log(
  `\nSTEPS ${String(report.length)}  PASS ${String(report.filter((r) => r.status === 'PASS').length)}  FAIL ${String(failed)}`,
)
process.exit(failed > 0 ? 1 : 0)
