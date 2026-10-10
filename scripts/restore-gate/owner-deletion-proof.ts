/**
 * owner-deletion-proof - owner-operated proof of restore-safe account deletion (P197B).
 *
 *   pnpm exec tsx scripts/restore-gate/owner-deletion-proof.ts \
 *     --backup <verified pre-deletion backup dir> --out-dir <private dir outside every checkout> \
 *     --expect-user-id <full UUID of the synthetic account> --publishable-key <sb_publishable_...>
 *
 * Optional: --skip-drill (do not run the Docker restore drill), --supabase-url / --registry-url
 * (default: Production; only Production+Production or loopback+loopback are accepted).
 *
 * It deletes exactly ONE account: the one whose e-mail and password the operator types, and only if
 * that account is the UUID named on the command line, is not an administrator, and is in the
 * backup. The Edge Function derives its target from the bearer token; this tool only refuses to
 * send the request unless every gate below has passed. A failed gate stops the run - nothing is
 * retried, and after a failed deletion request nothing is re-sent.
 *
 * Secrets: the registry operator token, the registry HMAC key, the account password are read from
 * the TTY with echo off (the two registry values may instead come from ERASURE_OPERATOR_TOKEN /
 * ERASURE_REGISTRY_KEY). Access/refresh tokens exist only in this process's memory. Nothing secret
 * is logged, written or put on a command line (the publishable key is public by design). The
 * registry key reaches the restore drill as a child-process environment variable only. Output is
 * PASS/FAIL lines and counts.
 *
 * Gates, in order:
 *   1 target is Production (or a loopback rehearsal); backup integrity; the backup is OF this
 *     project, finished after the account existed, holds its live purchase and lot, and names the
 *     administrator(s)
 *   2 registry reachable, key valid, chain verified
 *   3 sign-in; id == --expect-user-id; e-mail identity and no verified second factor (otherwise the
 *     Edge Function would refuse); profile is_admin == false (read through RLS with its own session)
 *   4 the account's own holding exists
 *   5 read-only authenticated smoke: Search, CORS preflight and call of search-prices, finance reads
 *   6 registry head BEFORE; explicit confirmation typed
 *   7 POST /functions/v1/delete-account {expectedUserId, password, confirm:true} -> 200 {status:deleted}
 *   8 stale access token, stale refresh token and password sign-in all refused
 *   9 registry head AFTER: exactly one new record (this account), earlier records byte-identical
 *  10 restore drill of the pre-deletion backup with the live registry, judged by content
 *
 * Exit codes: 0 all gates passed - 1 a gate failed - 64 usage.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { verifyBackupDirectory } from '../db-backup/backup-core'
import { REPO_ROOT } from '../db-backup/supabase-cli'
import {
  backupFingerprintForRef,
  backupUnfitReasons,
  cleanSecret,
  evaluateDrillLog,
  explainExportRefusal,
  matchesTestRegistryCredential,
  inspectBackupAccount,
  operatorTokenProblem,
  PRODUCTION_FRONTEND_ORIGIN,
  PRODUCTION_PROJECT_REF,
  PRODUCTION_REGISTRY_URL,
  PRODUCTION_SUPABASE_URL,
  registryExtendsByOne,
  resolveTarget,
} from './deletion-proof-core'
import { hashAccountId, parseRegistryKey, RegistryError } from './erasure-registry'
import {
  createInterruptionHandler,
  installInterruptionHandlers,
  interruptionSummary,
} from './interruption'
import { exportRegistry } from './registry-export'

const MIN_MIGRATION_ROWS = 114
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DELETE_TIMEOUT_MS = 150_000

interface Args {
  backup: string
  outDir: string
  expectUserId: string
  publishableKey: string
  supabaseUrl: string
  registryUrl: string
  skipDrill: boolean
}

class GateFailure extends Error {}

/** What the final handler must know to describe an interrupted run truthfully. */
interface RunState {
  requestSent: boolean
  /** A response (any status) to the delete request was received. */
  requestAnswered: boolean
  deleted: boolean
  outDir: string | null
}
const state = {
  requestSent: false,
  requestAnswered: false,
  deleted: false,
  outDir: null,
} as RunState

/**
 * Ctrl+C at a prompt, SIGINT/SIGTERM/SIGHUP/SIGBREAK at any other time. This used to be a bare
 * process exit (or the default signal action): no output at all, so once the delete request had
 * left the operator could not tell "cancelled, nothing happened" from "cancelled, outcome unknown".
 * Both now say which one it is (describeInterruption) and the summary file records it. The handler
 * lives in ./interruption.ts so it can be exercised as a real process without any backend.
 */
const handleInterruption = createInterruptionHandler({
  facts: () => state,
  writeStderr: (text) => process.stderr.write(text),
  persist: (report) => {
    if (!state.outDir) return
    writeSummary(state.outDir, interruptionSummary(state, report, results))
  },
  exit: (code) => process.exit(code),
})
installInterruptionHandlers(handleInterruption)

function outsideRepository(path: string): boolean {
  return !resolve(path).toLowerCase().startsWith(resolve(REPO_ROOT).toLowerCase())
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): Args | null {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const backup = get('--backup')
  const outDir = get('--out-dir')
  const expectUserId = get('--expect-user-id')?.toLowerCase()
  const publishableKey = get('--publishable-key') ?? env.PP_SUPABASE_PUBLISHABLE_KEY
  if (!backup || !outDir || !expectUserId || !publishableKey) return null
  if (!UUID.test(expectUserId)) return null
  return {
    backup: resolve(backup),
    outDir: resolve(outDir),
    expectUserId,
    publishableKey,
    supabaseUrl: get('--supabase-url') ?? PRODUCTION_SUPABASE_URL,
    registryUrl: get('--registry-url') ?? PRODUCTION_REGISTRY_URL,
    skipDrill: argv.includes('--skip-drill'),
  }
}

/** Reads one line from the TTY. With `hidden`, nothing is echoed. */
function prompt(label: string, hidden: boolean): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    return Promise.reject(new GateFailure('an interactive terminal is required'))
  }
  return new Promise((resolvePrompt) => {
    process.stdout.write(`${label}: `)
    let buffer = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          resolvePrompt(buffer)
          return
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false)
          process.stdout.write('\n')
          handleInterruption()
        }
        if (ch === '\u007f' || ch === '\b') {
          buffer = buffer.slice(0, -1)
        } else {
          buffer += ch
          if (!hidden) process.stdout.write(ch)
        }
      }
    }
    stdin.on('data', onData)
  })
}

const results: { gate: string; pass: boolean; detail?: string }[] = []

function report(gate: string, pass: boolean, detail?: string): void {
  results.push({ gate, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${gate}${detail ? ` - ${detail}` : ''}`)
}

function must(condition: boolean, gate: string, detail?: string): void {
  report(gate, condition, detail)
  if (!condition) throw new GateFailure(gate)
}

function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.on('error', () => {
      resolveRun(127)
    })
    child.on('close', (code) => {
      resolveRun(code ?? 1)
    })
  })
}

/** Child environment for the drill: nothing but what it needs. No operator token, no Supabase key. */
function drillEnv(registryKeyText: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ERASURE_REGISTRY_KEY: registryKeyText }
  delete env.ERASURE_OPERATOR_TOKEN
  delete env.PP_SUPABASE_PUBLISHABLE_KEY
  return env
}

function runDrill(args: Args, registryFile: string, registryKeyText: string): Promise<string> {
  return new Promise((resolveDrill) => {
    const child = spawn(
      process.execPath,
      [
        resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'),
        'scripts/p137/restore-drill.ts',
        '--backup',
        args.backup,
        '--erasure-registry',
        registryFile,
        '--expect-erased-present',
      ],
      { cwd: REPO_ROOT, env: drillEnv(registryKeyText), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const chunks: string[] = []
    const sink = (d: Buffer): void => {
      chunks.push(d.toString('utf8'))
    }
    child.stdout.on('data', sink)
    child.stderr.on('data', sink)
    child.on('error', () => {
      chunks.push('P137 RESTORE DRILL: ERROR - could not start\n')
      resolveDrill(chunks.join(''))
    })
    child.on('close', () => {
      resolveDrill(chunks.join(''))
    })
  })
}

async function readOnlySmoke(
  client: SupabaseClient,
  args: Args,
  accessToken: string,
  frontendOrigin: string,
): Promise<void> {
  const search = await client.rpc('search_cards', { p_query: 'pikachu', p_limit: 5, p_offset: 0 })
  const rows = (search.data ?? []) as { card_id?: string }[]
  const firstCard = rows[0]?.card_id
  must(
    !search.error && rows.length > 0 && !!firstCard,
    'authenticated Search returns cards',
    `${String(rows.length)} rows`,
  )

  const fn = `${args.supabaseUrl}/functions/v1/search-prices`
  const preflight = await fetch(fn, {
    method: 'OPTIONS',
    headers: {
      Origin: frontendOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,apikey,x-client-info',
    },
    signal: AbortSignal.timeout(30_000),
  })
  must(
    preflight.status >= 200 &&
      preflight.status < 300 &&
      preflight.headers.get('access-control-allow-origin') === frontendOrigin,
    'search-prices answers the browser CORS preflight for the frontend origin',
    `http ${String(preflight.status)}`,
  )
  const priced = await fetch(fn, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: args.publishableKey,
      'Content-Type': 'application/json',
      Origin: frontendOrigin,
    },
    body: JSON.stringify({ cardIds: [firstCard] }),
    signal: AbortSignal.timeout(60_000),
  })
  let pricedJson = true
  try {
    await priced.json()
  } catch {
    pricedJson = false
  }
  must(
    priced.status === 200 &&
      pricedJson &&
      priced.headers.get('access-control-allow-origin') === frontendOrigin,
    'search-prices answers an authenticated call (200, JSON, CORS header)',
    `http ${String(priced.status)}`,
  )

  const reads: [string, Record<string, unknown>][] = [
    ['get_dashboard_summary', {}],
    ['portfolio_counts', {}],
    ['purchase_spending_summary', {}],
  ]
  for (const [name, params] of reads) {
    const r = await client.rpc(name, params)
    must(!r.error, `finance read RPC ${name} succeeds`)
  }
  const holding = await client.from('holdings').select('id').limit(1)
  const holdingId = (holding.data as { id?: string }[] | null)?.[0]?.id
  if (holdingId) {
    const provenance = await client.rpc('get_holding_value_provenance', { p_holding_id: holdingId })
    must(!provenance.error, 'finance read RPC get_holding_value_provenance succeeds')
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env)
  if (!args) {
    console.error(
      'usage: owner-deletion-proof.ts --backup <dir> --out-dir <dir> --expect-user-id <uuid> ' +
        '--publishable-key <key> [--skip-drill] [--supabase-url <url> --registry-url <url>]',
    )
    process.exitCode = 64
    return
  }
  let target: ReturnType<typeof resolveTarget>
  try {
    target = resolveTarget(args.supabaseUrl, args.registryUrl)
  } catch (e) {
    throw new GateFailure(e instanceof Error ? e.message : 'invalid target')
  }
  console.log(
    `TARGET: ${target.kind === 'production' ? 'PRODUCTION' : 'LOCAL REHEARSAL (not Production)'}`,
  )
  must(
    outsideRepository(args.outDir) && outsideRepository(args.backup),
    'backup and output directories are outside the repository',
  )
  mkdirSync(args.outDir, { recursive: true })
  state.outDir = args.outDir
  if (!args.skipDrill) {
    must(
      (await run('docker', ['version', '--format', '{{.Server.Version}}'])) === 0,
      'Docker is running (needed for the restore drill after the deletion)',
    )
  }

  // 1 - the backup: intact, OF this project, and a pre-deletion image of exactly this account
  const manifest = await verifyBackupDirectory(args.backup)
  must(
    (manifest.migrationHistoryRows ?? 0) >= MIN_MIGRATION_ROWS,
    'backup verified from disk (manifest, hashes, marker), migration history >= 114',
    `${String(manifest.migrationHistoryRows)} history rows`,
  )
  if (target.kind === 'production') {
    must(
      manifest.target.fingerprint === backupFingerprintForRef(PRODUCTION_PROJECT_REF),
      'backup is of the Production project',
    )
  }
  const dataSql = readFileSync(join(args.backup, 'data.sql'), 'utf8')
  const facts = inspectBackupAccount(dataSql, args.expectUserId)
  const unfit = backupUnfitReasons(facts, args.expectUserId, manifest.finishedAtUtc)
  must(
    unfit.length === 0,
    'backup is a pre-deletion image of the account (user, non-admin profile, live purchase and lot)',
    unfit.length === 0
      ? `purchases ${String(facts.liveOwnedPurchases)}, lots ${String(facts.liveOwnedLots)}, administrators named ${String(facts.adminIds.length)}`
      : unfit.join('; '),
  )

  // 2 - registry secrets, reachability and chain integrity
  const registryToken = cleanSecret(
    process.env.ERASURE_OPERATOR_TOKEN ?? (await prompt('Registry operator token', true)),
  )
  const registryKeyText = cleanSecret(
    process.env.ERASURE_REGISTRY_KEY ?? (await prompt('Registry HMAC key', true)),
  )
  const registryKey = parseRegistryKey(registryKeyText)
  const tokenProblem = operatorTokenProblem(registryToken, registryKeyText)
  must(
    tokenProblem === null,
    'registry operator token has a plausible shape',
    tokenProblem ?? undefined,
  )
  const testEnvPath = join(homedir(), '.pokeportfolio-p195', 'registry-test.env')
  let testMatch: ReturnType<typeof matchesTestRegistryCredential> = null
  if (target.kind === 'production' && existsSync(testEnvPath)) {
    testMatch = matchesTestRegistryCredential(
      registryToken,
      registryKeyText,
      readFileSync(testEnvPath, 'utf8'),
    )
  }
  must(
    testMatch === null,
    'registry credentials are not those of the TEST registry',
    testMatch === null
      ? undefined
      : `the ${testMatch} entered is the test registry's, not Production's`,
  )
  const beforeFile = join(args.outDir, 'registry-before.ndjson')
  let probe: Awaited<ReturnType<typeof exportRegistry>>
  try {
    probe = await exportRegistry({
      url: target.registryUrl,
      token: registryToken,
      key: registryKey,
      out: beforeFile,
    })
  } catch (e) {
    const why = e instanceof RegistryError ? explainExportRefusal(e.message) : null
    if (why !== null) {
      report('registry reachable, key valid, chain verified', false, why)
      throw new GateFailure('registry credentials refused - nothing was deleted')
    }
    throw e
  }
  report(
    'registry reachable, key valid, chain verified',
    true,
    `seq ${String(probe.seq)}, ${String(probe.records)} records`,
  )

  // 3 - who is signed in
  const email = (await prompt('Synthetic test account e-mail', false)).trim()
  const password = await prompt('Synthetic test account password', true)
  const client = createClient(target.supabaseUrl, args.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
  const signedIn = await client.auth.signInWithPassword({ email, password })
  const session = signedIn.data.session
  const user = signedIn.data.user
  must(!signedIn.error && !!session && !!user, 'sign-in with the typed credentials')
  if (!session || !user) return
  const idPrefix = user.id.slice(0, 8).toLowerCase()
  must(
    user.id.toLowerCase() === args.expectUserId,
    'authenticated account is exactly the expected synthetic account',
    `id prefix ${idPrefix}`,
  )
  must(
    !facts.adminIds.includes(user.id.toLowerCase()),
    'authenticated account is not an administrator named in the backup',
  )
  const providers = new Set<string>(
    (user.identities ?? []).map((i) => i.provider).filter((p): p is string => !!p),
  )
  const listed = (user.app_metadata as { providers?: unknown }).providers
  if (Array.isArray(listed)) for (const p of listed) if (typeof p === 'string') providers.add(p)
  const verifiedFactors = (user.factors ?? []).filter((f) => f.status === 'verified').length
  must(
    providers.has('email') && verifiedFactors === 0,
    'account has an e-mail identity and no verified second factor (password re-authentication applies)',
  )
  const profile = await client.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
  must(
    !profile.error && (profile.data as { is_admin?: boolean } | null)?.is_admin === false,
    "live profile says is_admin = false (read through RLS with the account's own session)",
  )

  // 4 - its own holding
  const purchases = await client.from('purchases').select('id', { count: 'exact', head: true })
  const lots = await client.from('acquisition_lots').select('id', { count: 'exact', head: true })
  const purchaseCount = purchases.count ?? -1
  const lotCount = lots.count ?? -1
  must(
    purchaseCount >= 1 && lotCount >= 1,
    'account holding exists',
    `purchases ${String(purchaseCount)}, lots ${String(lotCount)}`,
  )

  // 5 - authenticated read-only smoke (a failure stops here, with the account intact)
  await readOnlySmoke(
    client,
    { ...args, supabaseUrl: target.supabaseUrl },
    session.access_token,
    target.kind === 'production' ? PRODUCTION_FRONTEND_ORIGIN : 'http://localhost:5173',
  )

  // 6 - registry head BEFORE (re-read now, so the delta is measured from the moment of deletion)
  const before = await exportRegistry({
    url: target.registryUrl,
    token: registryToken,
    key: registryKey,
    out: beforeFile,
  })
  const beforeText = readFileSync(beforeFile, 'utf8')
  console.log('\n--- ABOUT TO DELETE ONE ACCOUNT PERMANENTLY ---')
  console.log(`  target            : ${target.kind}`)
  console.log(`  account id prefix : ${idPrefix}   (administrator accounts are excluded)`)
  console.log(`  created           : ${user.created_at.slice(0, 10)}`)
  console.log(
    `  holding           : ${String(purchaseCount)} purchase(s), ${String(lotCount)} lot(s)`,
  )
  console.log(`  backup            : ${manifest.finishedAtUtc} (contains the account)`)
  console.log(`  registry          : seq ${String(before.seq)}, ${String(before.records)} records`)
  const typed = await prompt(`Type DELETE ${idPrefix} to proceed`, false)
  must(typed.trim() === `DELETE ${idPrefix}`, 'final confirmation typed')

  // 7 - the real endpoint. One request; never re-sent by this tool.
  let status = 0
  let body: { status?: string; error?: string; stage?: string; retryable?: boolean } = {}
  let requestCompleted = false
  state.requestSent = true
  try {
    const response = await fetch(`${target.supabaseUrl}/functions/v1/delete-account`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: args.publishableKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedUserId: user.id, password, confirm: true }),
      redirect: 'error',
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    })
    requestCompleted = true
    status = response.status
    try {
      body = (await response.json()) as typeof body
    } catch {
      // no body: reported through the status alone
    }
  } catch {
    // the outcome is UNKNOWN (network/timeout): the registry below tells what happened
  }
  const deleted = requestCompleted && status === 200 && body.status === 'deleted'
  state.deleted = deleted
  // Only now is the answer fully read: an interruption while the body was still arriving must keep
  // reporting the outcome as unknown.
  state.requestAnswered = requestCompleted
  report(
    'delete-account answered 200 {"status":"deleted"}',
    deleted,
    deleted
      ? undefined
      : requestCompleted
        ? `http ${String(status)} error=${body.error ?? '-'} stage=${body.stage ?? '-'} retryable=${String(body.retryable ?? '-')}`
        : 'no answer (network error or timeout): outcome unknown',
  )
  if (!deleted) {
    console.log(
      'Deletion did not report completion. NOTHING IS RETRIED. The account may be pending ' +
        '(writes blocked, data intact). Send the PASS/FAIL lines above to Claude; do not run this tool again until diagnosed.',
    )
  }

  // 8 - stale sessions (only meaningful after a completed deletion)
  if (deleted) {
    const bare = () =>
      createClient(target.supabaseUrl, args.publishableKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      })
    try {
      const probeUser = await fetch(`${target.supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: args.publishableKey },
        signal: AbortSignal.timeout(30_000),
      })
      report(
        'stale access token refused by Auth',
        probeUser.status >= 400 && probeUser.status < 500,
        `http ${String(probeUser.status)}`,
      )
    } catch {
      report('stale access token refused by Auth', false, 'no answer')
    }
    const refreshed = await bare().auth.refreshSession({ refresh_token: session.refresh_token })
    report(
      'stale refresh token refused',
      !!refreshed.error && !refreshed.data.session,
      `http ${String(refreshed.error?.status ?? '-')}`,
    )
    const relogin = await bare().auth.signInWithPassword({ email, password })
    const reloginStatus: number | undefined = relogin.error?.status
    report(
      'password sign-in refused after deletion',
      !relogin.data.session && reloginStatus !== undefined && reloginStatus >= 400,
      `http ${String(reloginStatus ?? '-')}`,
    )
  }

  // 9 - registry AFTER
  const afterFile = join(args.outDir, 'registry-after.ndjson')
  let after = before
  let afterText = ''
  let afterVerified = false
  try {
    after = await exportRegistry({
      url: target.registryUrl,
      token: registryToken,
      key: registryKey,
      out: afterFile,
    })
    afterText = readFileSync(afterFile, 'utf8')
    afterVerified = true
    report(
      'registry head AFTER read and chain verified with the operator key',
      true,
      `seq ${String(after.seq)}, ${String(after.records)} records`,
    )
  } catch {
    report('registry head AFTER read and chain verified with the operator key', false)
  }
  const delta = `delta seq ${String(after.seq - before.seq)}, delta records ${String(after.records - before.records)}`
  if (deleted) {
    const extension = registryExtendsByOne(beforeText, afterText, user.id, new Date())
    report(
      'registry gained exactly one record: this account, earlier records untouched',
      extension.ok && after.seq - before.seq === 1 && after.records - before.records === 1,
      `${delta}; ${extension.reason}`,
    )
  } else {
    report(
      'registry unchanged by the failed request (informational: a pending deletion may still exist)',
      after.seq === before.seq && after.records === before.records,
      delta,
    )
  }

  // 10 - the restore drill: the pre-deletion backup + the live registry
  let drillRan = false
  let drillPass = false
  let drillSummary: ReturnType<typeof evaluateDrillLog> | null = null
  if (deleted && afterVerified && !args.skipDrill) {
    drillRan = true
    console.log('\nRunning the restore drill (Docker, several minutes; counts only) ...')
    const log = await runDrill(args, afterFile, registryKeyText)
    writeFileSync(join(args.outDir, 'restore-drill.log'), log, { mode: 0o600 })
    drillSummary = evaluateDrillLog(log)
    drillPass = drillSummary.pass
    report(
      'restore drill: erased account replayed away, image promotable, other accounts untouched',
      drillPass,
      `${String(drillSummary.checksFailed)} of ${String(drillSummary.checksTotal)} checks failed` +
        (drillSummary.onlyKnownLimitationFailed ? ' (only the documented cron limitation)' : '') +
        `; replayed ${String(drillSummary.replayedAccounts)}` +
        (drillSummary.problems.length > 0 ? `; ${drillSummary.problems.join('; ')}` : ''),
    )
  }

  const summary = {
    target: target.kind,
    userIdPrefix: idPrefix,
    backupFinishedAtUtc: manifest.finishedAtUtc,
    backupManifestSha256: createHash('sha256')
      .update(readFileSync(join(args.backup, 'manifest.json')))
      .digest('hex'),
    registryBefore: before,
    registryAfter: after,
    deleted,
    drillRan,
    drillPass,
    drill: drillSummary,
    subjectHashPrefix: hashAccountId(user.id).slice(0, 8),
    results,
  }
  writeSummary(args.outDir, summary)
  const failed = results.filter((r) => !r.pass).length
  console.log(
    `\n${failed === 0 ? 'ALL GATES PASSED' : `${String(failed)} GATE(S) FAILED`} - result written to ${join(args.outDir, 'p197b-result.json')}`,
  )
  process.exitCode = failed === 0 ? 0 : 1
}

function writeSummary(outDir: string, summary: unknown): void {
  writeFileSync(join(outDir, 'p197b-result.json'), JSON.stringify(summary, null, 2), {
    mode: 0o600,
  })
}

try {
  await main()
} catch (e) {
  if (e instanceof GateFailure) {
    console.error(`STOPPED at gate: ${e.message}`)
  } else if (e instanceof RegistryError) {
    // RegistryError messages are written to be safe (a code and a reason, never a secret).
    console.error(`STOPPED: registry ${e.code} - ${e.message}`)
  } else {
    console.error(`STOPPED: ${e instanceof Error ? e.constructor.name : 'unexpected error'}`)
  }
  if (state.requestSent) {
    console.error(
      'THE DELETION REQUEST WAS ALREADY SENT. Do not run this tool again. Send the PASS/FAIL lines above to Claude;\n' +
        'the account and registry state will be read independently.',
    )
  }
  if (state.outDir) {
    try {
      writeSummary(state.outDir, {
        stopped: true,
        deletionRequestSent: state.requestSent,
        deleted: state.deleted,
        results,
      })
    } catch {
      // the console output above is the record
    }
  }
  process.exitCode = 1
}
