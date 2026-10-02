#!/usr/bin/env node
/**
 * P189 emulator journey: in-app account deletion on the RELEASE build, against the LOCAL stack.
 *
 *   P186_INSTANCE=p189 P186_EMULATOR_PORT=5570 node scripts/p189/delete-journey.mjs --install <release.apk> \
 *     --seed '<json from scripts/p189/seed-synthetic-account.ts>'
 *
 *   1 cold launch → signed out      2 sign in with the synthetic account, Collection shows the portfolio
 *   3 Profile → Delete account…: the sheet states what is / is not deleted; nothing is sent by opening it
 *   4 the confirm button stays disabled until password AND acknowledgement
 *   5 a WRONG password: fixed copy, still signed in, account intact in the database
 *   6 the right password: back on the SIGNED-OUT screen
 *   7 the account, its rows and its Auth user are gone; the erasure is in the registry (checked by the caller)
 *   8 the old credentials are refused in the app; the OLD access and refresh tokens are refused by Auth
 *   9 logcat: no fatal exception, ANR or crash from the app; no raw backend text on any screen seen
 *
 * Local only. Needs the stack from docs/TESTING.md §6g (the function and the registry sink running) and
 * an emulator started on the instance's port. Output: .build/p189-evidence/*.png, delete-journey-report.json
 */
import './../p186/env.mjs'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { amStart } from '../android-p167-lib.mjs'
import { establishIdentity } from '../android-adb.mjs'
import { PACKAGE, adb, byId, dump, outDir, shell, shot, sleep, waitFor } from '../p185/lib.mjs'
import {
  assertActivityAlive,
  clearAndType,
  findNode,
  tapNode,
  tapTestId,
  waitForNode,
} from '../p185/driver.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const apk = arg('install', null)
const seed = JSON.parse(arg('seed', 'null') ?? 'null')
if (seed === null) throw new Error('--seed <json> is required (scripts/p189/seed-synthetic-account.ts)')
const SUPABASE_URL = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_ANON_KEY
const DB_CONTAINER = process.env.P189_DB_CONTAINER ?? 'supabase_db_pokeportfolio-p189'
if (!SUPABASE_URL || !ANON) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY (local stack) are required')

mkdirSync(outDir, { recursive: true })
if (apk !== null) {
  adb(['uninstall', PACKAGE], { allowFail: true })
  adb(['install', '-r', '-g', apk])
}
establishIdentity()
adb(['logcat', '-G', '16M'], { allowFail: true })
adb(['logcat', '-c'], { allowFail: true })
adb(['logcat', '-b', 'crash', '-c'], { allowFail: true })

const psql = (sql) =>
  execFileSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', sql], {
    encoding: 'utf8',
  }).trim()
const ledgerRows = () =>
  Number(
    psql(
      `select (select count(*) from public.holdings where user_id = '${seed.id}') + (select count(*) from public.purchases where user_id = '${seed.id}') + (select count(*) from public.sales where user_id = '${seed.id}')`,
    ),
  )
const authUserExists = () => psql(`select count(*) from auth.users where id = '${seed.id}'`) === '1'

const report = []
const seenText = []
async function step(n, name, fn) {
  const t0 = Date.now()
  try {
    const detail = await fn()
    assertActivityAlive()
    report.push({ n, step: name, status: 'PASS', ms: Date.now() - t0, detail })
    console.log(`PASS ${String(n).padStart(2)} ${name}  ${JSON.stringify(detail ?? null).slice(0, 400)}`)
    return true
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    report.push({ n, step: name, status: 'FAIL', ms: Date.now() - t0, detail: message.slice(0, 900) })
    console.log(`FAIL ${String(n).padStart(2)} ${name}  ${message.slice(0, 600)}`)
    try {
      shot(`p189-fail-${String(n)}`)
    } catch {
      // the failure itself is what matters
    }
    return false
  }
}
const check = (cond, message) => {
  if (!cond) throw new Error(message)
}
const remember = () => {
  for (const n of dump()) if (n.text) seenText.push(n.text)
}

let before = 0

await step(1, 'cold launch lands on the signed-out screen', async () => {
  shell(`pm clear ${PACKAGE}`)
  await sleep(1500)
  amStart()
  await waitFor((ns) => byId(ns, 'login-email') || byId(ns, 'login-screen'), {
    timeoutMs: 40000,
    label: 'login screen',
  })
  shot('p189-01-signed-out')
  return { ok: true }
})

await step(2, 'sign in with the synthetic account; the portfolio is there', async () => {
  before = ledgerRows()
  check(before > 0, 'the seeded account has no ledger rows')
  await clearAndType('login-email', seed.email)
  await clearAndType('login-password', seed.password, { verify: false })
  await tapTestId('login-submit')
  await waitForNode('collection-list', { timeoutMs: 60000, label: 'collection list' })
  shot('p189-02-collection')
  return { ledgerRows: before }
})

await step(3, 'Profile → Delete account…: the sheet says what is and is not deleted, and opening it sends nothing', async () => {
  await tapTestId('tab-profile')
  await waitForNode('delete-account', { timeoutMs: 20000, label: 'delete account section' })
  await tapTestId('delete-account-open')
  const { nodes } = await waitForNode('delete-account-covers', { timeoutMs: 20000 })
  remember()
  const text = nodes.map((n) => n.text).join(' ')
  check(/Deleted right away/.test(text), 'the sheet does not list what is deleted')
  check(/not rewritten/.test(text), 'the sheet does not state that backups are not rewritten')
  check(!/\b\d+\s*(days?|weeks?|months?)\b/i.test(text), 'the sheet states a retention period')
  check(authUserExists() && ledgerRows() === before, 'opening the sheet changed the account')
  shot('p189-03-sheet')
  return { sheet: true }
})

await step(4, 'the confirm button is disabled until the password AND the acknowledgement are given', async () => {
  const disabled = () => findNode(dump(), 'delete-account-confirm')?.enabled === false
  check(disabled(), 'confirm is enabled with nothing entered')
  await clearAndType('delete-account-password', 'definitely-not-my-password', { verify: false })
  check(disabled(), 'confirm is enabled with a password but no acknowledgement')
  await tapTestId('delete-account-ack')
  await sleep(400)
  check(!disabled(), 'confirm is still disabled with a password and the acknowledgement')
  return { gated: true }
})

await step(5, 'a WRONG password is refused with fixed copy; still signed in; nothing deleted', async () => {
  await tapTestId('delete-account-confirm')
  await waitFor((ns) => ns.some((n) => /not correct/.test(n.text)), { timeoutMs: 45000, label: 'wrong-password message' })
  remember()
  shot('p189-05-wrong-password')
  check(authUserExists() && ledgerRows() === before, 'a wrong password changed the account')
  return { refused: true }
})

await step(6, 'the right password deletes the account and returns to the SIGNED-OUT screen', async () => {
  await clearAndType('delete-account-password', seed.password, { verify: false })
  await tapTestId('delete-account-confirm')
  await waitFor((ns) => byId(ns, 'login-email') || byId(ns, 'login-screen'), {
    timeoutMs: 120000,
    label: 'signed-out screen after deletion',
  })
  remember()
  shot('p189-06-signed-out-after-delete')
  return { signedOut: true }
})

await step(7, 'the account is gone from the database: login, ledger rows', async () => {
  check(!authUserExists(), 'the Auth user still exists')
  check(ledgerRows() === 0, 'ledger rows remain')
  const owned = Number(
    psql(
      `select count(*) from public.profiles where id = '${seed.id}'`,
    ),
  )
  check(owned === 0, 'the profile remains')
  return { ledgerRowsAfter: 0 }
})

await step(8, 'the old credentials and the OLD tokens are refused', async () => {
  // In the app:
  await clearAndType('login-email', seed.email)
  await clearAndType('login-password', seed.password, { verify: false })
  await tapTestId('login-submit')
  await waitFor((ns) => ns.some((n) => /not correct/i.test(n.text)) || byId(ns, 'login-error'), {
    timeoutMs: 30000,
    label: 'sign-in refused',
  })
  shot('p189-08-old-credentials-refused')
  // At Auth, with the tokens the account held BEFORE it was deleted:
  const user = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: `Bearer ${seed.accessToken}` },
  })
  const refresh = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: seed.refreshToken }),
  })
  check(user.status >= 400, `the old access token is still accepted (HTTP ${String(user.status)})`)
  check(refresh.status >= 400, `the old refresh token is still accepted (HTTP ${String(refresh.status)})`)
  return { accessTokenHttp: user.status, refreshTokenHttp: refresh.status }
})

await step(9, 'logcat clean; no raw backend text on any screen seen', async () => {
  const log = adb(['logcat', '-d', '-b', 'all'], { allowFail: true }) ?? ''
  const mine = log.split('\n').filter((l) => l.includes(PACKAGE) || /FATAL EXCEPTION|ANR in/.test(l))
  const fatal = mine.filter((l) => /FATAL EXCEPTION|ANR in|Process: .*died|SIGSEGV/.test(l))
  check(fatal.length === 0, `fatal lines: ${fatal.slice(0, 3).join(' | ')}`)
  const raw = seenText.filter((t) => /PGRST|violates|purge_account_data|account_deletion|duplicate key|supabase/i.test(t))
  check(raw.length === 0, `raw backend text on screen: ${raw.slice(0, 3).join(' | ')}`)
  return { fatal: 0, rawTextOnScreen: 0 }
})

const failed = report.filter((r) => r.status !== 'PASS')
writeFileSync(join(outDir, 'delete-journey-report.json'), `${JSON.stringify({ report, failed: failed.length }, null, 2)}\n`)
console.log(failed.length === 0 ? `\nP189 DELETE JOURNEY: PASS (${String(report.length)}/${String(report.length)})` : `\nP189 DELETE JOURNEY: FAIL (${String(failed.length)})`)
process.exitCode = failed.length === 0 ? 0 : 1
void tapNode
