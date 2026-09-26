#!/usr/bin/env node
/**
 * Builds the P170 integrated app as a release APK (Hermes bytecode, embedded bundle, real native
 * modules, x86_64) for the Android emulator. LOCAL ONLY. Windows recipe from P166/P167: prebuild
 * --clean (so the config plugins run on a fresh android/), one Gradle pass from the real path
 * (codegen), then a pass from a session-only `subst` drive (CMake MAX_PATH). The drive is removed
 * afterwards, and only a drive this script created itself.
 *
 * No TRACKED file is modified: android/ and .env.local are gitignored. .env.local is written from the
 * P170 stack's PUBLIC values (URL + publishable key) with EXPO_PUBLIC_RUNTIME_PROOF=1 (the opt-in
 * in-app Hermes proofs and P169_PERF timing lines); a secret key is refused by the app's own backend
 * guard anyway.
 *
 *   node scripts/p170/build-apk.mjs            prebuild --clean + both passes
 *   node scripts/p170/build-apk.mjs --no-clean keep an existing android/ (faster rebuild)
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..', '..')
const repoRoot = resolve(appRoot, '..', '..')
const JAVA_HOME = process.env.P170_JAVA_HOME ?? 'C:\\Program Files\\Java\\jdk-21.0.10'
const ANDROID_HOME =
  process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
// Q:, R: and P: belonged to the P167/P168/P169 sessions; P170 uses its own letter.
const DRIVE = process.env.P170_SUBST_DRIVE ?? 'O:'

function run(cmd, args, cwd, { allowFail = false } = {}) {
  console.log(`\n$ (${cwd}) ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, JAVA_HOME, ANDROID_HOME, NODE_ENV: 'production', CI: '1' },
  })
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} failed (${String(r.status)})`)
  return r.status
}

function writeEnv() {
  const env = JSON.parse(
    readFileSync(join(appRoot, '.local-backend', 'p170', 'public-env.json'), 'utf8'),
  )
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(env.apiUrl))
    throw new Error('refusing: not a local API URL')
  if (/^sb_secret_/.test(env.publishableKey)) throw new Error('refusing: secret key')
  writeFileSync(
    join(appRoot, '.env.local'),
    [
      `EXPO_PUBLIC_SUPABASE_URL=${env.apiUrl}`,
      `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${env.publishableKey}`,
      'EXPO_PUBLIC_RUNTIME_PROOF=1',
      '',
    ].join('\n'),
  )
}

const clean = !process.argv.includes('--no-clean')
writeEnv()
// EXPO_PUBLIC_* values are inlined at transform time, but Metro's transform cache is keyed by file
// content, not by the environment: a cached supabase-client.ts from ANOTHER worktree's build (another
// stack's port) was baked into the first P170 APK, which then never reached this stack. Clear it, and
// the Gradle bundle output (its inputs do not include the environment either).
rmSync(join(tmpdir(), 'metro-cache'), { recursive: true, force: true })
rmSync(join(appRoot, 'android', 'app', 'build', 'generated', 'assets'), {
  recursive: true,
  force: true,
})
if (clean) {
  // Node's rmSync fails on the generated CMake trees (paths over 260 characters); rd accepts the
  // extended-length prefix.
  if (process.platform === 'win32') {
    const target = '\\\\?\\' + join(appRoot, 'android')
    if (existsSync(join(appRoot, 'android')))
      spawnSync('cmd', ['/c', 'rd', '/s', '/q', target], { stdio: 'inherit' })
  } else rmSync(join(appRoot, 'android'), { recursive: true, force: true })
  run('npx', ['expo', 'prebuild', '--clean', '--platform', 'android', '--no-install'], appRoot)
}
const gradleArgs = ['assembleRelease', '-PreactNativeArchitectures=x86_64']
// Pass 1 (real path): codegen succeeds; CMake fails on path length, which pass 2 fixes.
const pass1 = run('.\\gradlew.bat', gradleArgs, join(appRoot, 'android'), { allowFail: true })
let status = pass1
if (pass1 !== 0) {
  if (existsSync(`${DRIVE}/`))
    throw new Error(`${DRIVE} is already in use; set P170_SUBST_DRIVE to a free letter`)
  run('subst', [DRIVE, repoRoot], appRoot)
  try {
    status = run('.\\gradlew.bat', gradleArgs, `${DRIVE}\\apps\\mobile-spike\\android`, {
      allowFail: true,
    })
  } finally {
    run('subst', [DRIVE, '/d'], appRoot, { allowFail: true })
  }
}
const apk = join(appRoot, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
if (status !== 0 || !existsSync(apk)) throw new Error('APK build failed')
// The URL baked into the bundle must be the one just written to .env.local.
const wanted = readFileSync(join(appRoot, '.env.local'), 'utf8').match(/SUPABASE_URL=([^s]+)/)?.[1]
console.log(`expected backend URL in the bundle: ${wanted}`)
const sha = createHash('sha256').update(readFileSync(apk)).digest('hex')
console.log(`\nAPK ${apk}\nSHA-256 ${sha}`)
