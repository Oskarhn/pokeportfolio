#!/usr/bin/env node
/**
 * Builds the P185 integrated app as a release APK (Hermes bytecode, embedded bundle, real native
 * modules, x86_64) for the Android emulator. LOCAL ONLY. Same Windows recipe as
 * scripts/p180/build-apk.mjs (prebuild --clean, one Gradle pass from the real path, one from a
 * session-only `subst` drive for the CMake MAX_PATH limit), on this phase's own application id,
 * own stack, own subst drive letter (W:, clear of P167-P180's O/P/Q/R/S/T/U).
 *
 *   node scripts/p185/build-apk.mjs            prebuild --clean + both passes
 *   node scripts/p185/build-apk.mjs --no-clean keep an existing android/ (faster rebuild)
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
const JAVA_HOME = process.env.P185_JAVA_HOME ?? 'C:\\Program Files\\Java\\jdk-18.0.2.1'
const ANDROID_HOME =
  process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
const DRIVE = process.env.P185_SUBST_DRIVE ?? 'W:'

function run(cmd, args, cwd, { allowFail = false } = {}) {
  console.log(`\n$ (${cwd}) ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, JAVA_HOME, ANDROID_HOME, NODE_ENW: 'production', CI: '1' },
  })
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} failed (${String(r.status)})`)
  return r.status
}

function writeEnv() {
  const env = JSON.parse(
    readFileSync(
      join(appRoot, '.local-backend', process.env.P185_STACK ?? 'p185', 'public-env.json'),
      'utf8',
    ),
  )
  const appUrl = env.appUrl ?? env.apiUrl
  const local = /^http:\/\/127\.0\.0\.1:\d+$/
  if (!local.test(appUrl) || !local.test(env.apiUrl))
    throw new Error('refusing: not a local API URL')
  if (/^sb_secret_/.test(env.publishableKey)) throw new Error('refusing: secret key')
  writeFileSync(
    join(appRoot, '.env.local'),
    [
      `EXPO_PUBLIC_SUPABASE_URL=${appUrl}`,
      `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${env.publishableKey}`,
      'EXPO_PUBLIC_RUNTIME_PROOF=1',
      '',
    ].join('\n'),
  )
}

const APPLICATION_ID = process.env.SPIKE_PACKAGE ?? 'invalid.pokeportfolio.spike.p185'
function patchApplicationId() {
  const file = join(appRoot, 'android', 'app', 'build.gradle')
  const text = readFileSync(file, 'utf8')
  const next = text.replace(/applicationId\s+['"][^'"]+['"]/, `applicationId '${APPLICATION_ID}'`)
  if (next === text && !text.includes(`applicationId '${APPLICATION_ID}'`))
    throw new Error('could not set applicationId in the generated build.gradle')
  writeFileSync(file, next)
  console.log(`applicationId = ${APPLICATION_ID}`)
}

const clean = !process.argv.includes('--no-clean')
writeEnv()
rmSync(join(tmpdir(), 'metro-cache'), { recursive: true, force: true })
rmSync(join(appRoot, 'android', 'app', 'build', 'generated', 'assets'), {
  recursive: true,
  force: true,
})
if (clean) {
  if (process.platform === 'win32') {
    const target = '\\\\?\\' + join(appRoot, 'android')
    if (existsSync(join(appRoot, 'android')))
      spawnSync('cmd', ['/c', 'rd', '/s', '/q', target], { stdio: 'inherit' })
  } else rmSync(join(appRoot, 'android'), { recursive: true, force: true })
  run('npx', ['expo', 'prebuild', '--clean', '--platform', 'android', '--no-install'], appRoot)
}
patchApplicationId()
const gradleArgs = ['assembleRelease', '-PreactNativeArchitectures=x86_64']
const pass1 = run('.\\gradlew.bat', gradleArgs, join(appRoot, 'android'), { allowFail: true })
let status = pass1
if (pass1 !== 0) {
  if (existsSync(`${DRIVE}/`))
    throw new Error(`${DRIVE} is already in use; set P185_SUBST_DRIVE to a free letter`)
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
const wanted = readFileSync(join(appRoot, '.env.local'), 'utf8').match(/SUPABASE_URL=([^s]+)/)?.[1]
console.log(`expected backend URL in the bundle: ${wanted}`)
const sha = createHash('sha256').update(readFileSync(apk)).digest('hex')
console.log(`\nAPK ${apk}\nSHA-256 ${sha}`)
