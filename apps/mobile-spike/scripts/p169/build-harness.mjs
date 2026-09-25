#!/usr/bin/env node
/**
 * Builds the P169 HARNESS as a release APK (Hermes bytecode, embedded bundle, x86_64) for the
 * Android emulator. LOCAL ONLY. Windows recipe from P166 (docs/mobile/P166_RUNTIME_AND_STITCH_REVIEW.md
 * §"Windows build problems"): prebuild + one Gradle pass from the real path (codegen), then a pass
 * from a session-only `subst` drive (CMake MAX_PATH). The drive is removed afterwards.
 *
 * No TRACKED file is modified. The harness differs from the P166 app only in GENERATED, gitignored
 * files under android/:
 *   - app/build.gradle  entryFile -> src/features/harness/index.ts (instead of package.json main)
 *                       applicationId -> invalid.pokeportfolio.spike.p169 (so it installs NEXT TO
 *                       the P166/P167 app instead of replacing it)
 *   - res/values/strings.xml  app_name -> "P169 Harness"
 * and .env.local (gitignored) is written from the P169 stack's PUBLIC values (URL + publishable key)
 * with EXPO_PUBLIC_RUNTIME_PROOF=1. A secret key is refused by the app's own backend guard anyway.
 *
 *   node scripts/p169/build-harness.mjs            prebuild + both passes
 *   node scripts/p169/build-harness.mjs --no-clean keep an existing android/ (faster rebuild)
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..', '..')
const repoRoot = resolve(appRoot, '..', '..')
export const HARNESS_PACKAGE = 'invalid.pokeportfolio.spike.p169'
const JAVA_HOME = process.env.P169_JAVA_HOME ?? 'C:\\Program Files\\Java\\jdk-21.0.10'
const ANDROID_HOME =
  process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
// Q: and R: are used by the parallel P167/P168 sessions; P169 uses its own letter and removes only
// a drive it created itself.
const DRIVE = process.env.P169_SUBST_DRIVE ?? 'P:'

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

function patch(file, from, to) {
  const text = readFileSync(file, 'utf8')
  if (text.includes(to)) return
  if (!text.includes(from)) throw new Error(`${file}: expected text not found: ${from}`)
  writeFileSync(file, text.replace(from, to))
}

function writeEnv() {
  const env = JSON.parse(
    readFileSync(join(appRoot, '.local-backend', 'p169', 'public-env.json'), 'utf8'),
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

function patchGenerated() {
  const gradle = join(appRoot, 'android', 'app', 'build.gradle')
  patch(
    gradle,
    `    entryFile = file(["node", "-e", "require('expo/scripts/resolveAppEntry')", projectRoot, "android", "absolute"].execute(null, rootDir).text.trim())`,
    '    entryFile = file("../../src/features/harness/index.ts")',
  )
  patch(gradle, "applicationId 'invalid.pokeportfolio.spike'", `applicationId '${HARNESS_PACKAGE}'`)
  const strings = join(appRoot, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml')
  patch(
    strings,
    '<string name="app_name">PokePortfolio Spike</string>',
    '<string name="app_name">P169 Harness</string>',
  )
}

const clean = !process.argv.includes('--no-clean')
writeEnv()
if (clean) {
  rmSync(join(appRoot, 'android'), { recursive: true, force: true })
  run('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], appRoot)
}
patchGenerated()
const gradleArgs = ['assembleRelease', '-PreactNativeArchitectures=x86_64']
// Pass 1 (real path): codegen succeeds; CMake may fail on path length, which pass 2 fixes.
const pass1 = run('.\\gradlew.bat', gradleArgs, join(appRoot, 'android'), { allowFail: true })
let status = pass1
if (pass1 !== 0) {
  if (existsSync(`${DRIVE}/`))
    throw new Error(`${DRIVE} is already in use; set P169_SUBST_DRIVE to a free letter`)
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
if (status !== 0 || !existsSync(apk)) throw new Error('harness build failed')
const sha = createHash('sha256').update(readFileSync(apk)).digest('hex')
console.log(`\nHARNESS APK ${apk}\nSHA-256 ${sha}\npackage ${HARNESS_PACKAGE}`)
