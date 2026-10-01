#!/usr/bin/env node
/**
 * P186 Android build driver (LOCAL ONLY): one deterministic recipe for the proof APK the device
 * drivers use, the production-shaped release APK, and the Android App Bundle (.aab).
 *
 *   node scripts/p186/build.mjs --variant proof   --task apk --abis x86_64
 *   node scripts/p186/build.mjs --variant release --task aab --abis arm64-v8a,x86_64
 *   node scripts/p186/build.mjs --variant release --task both --abis arm64-v8a,x86_64 --no-clean
 *
 *   --variant  proof    EXPO_PUBLIC_RUNTIME_PROOF=1 (proof panel + P184_TRACE; what the drivers need)
 *              release  no proof flag (what a user would install)
 *   --task     apk | aab | both
 *   --abis     comma list passed to -PreactNativeArchitectures (default x86_64)
 *   --no-clean keep an existing android/ (faster rebuild; Metro cache is still cleared)
 *   --env K=V  an extra EXPO_PUBLIC_* line for .env.local (repeatable; experiments only)
 *   --tag      suffix for the copied artifacts in .build/p186-artifacts (default <variant>)
 *
 * Requirements: the scanner assets staged (`pnpm assets:scanner`), `pnpm install --frozen-lockfile`,
 * a JDK 17+ (P186_JAVA_HOME or JAVA_HOME), the Android SDK (ANDROID_HOME or the default location).
 * Nothing machine-specific is committed: every path comes from the environment or os.homedir().
 * The step-by-step Windows notes live in docs/mobile/P186_ANDROID_PACKAGING_PERFORMANCE.md.
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import './env.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..', '..')
const repoRoot = resolve(appRoot, '..', '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const variant = arg('variant', 'release')
const task = arg('task', 'apk')
const abis = arg('abis', 'x86_64')
const tag = arg('tag', variant)
const clean = !process.argv.includes('--no-clean')
const extraEnv = process.argv.flatMap((a, i) => (a === '--env' ? [process.argv[i + 1]] : []))
for (const line of extraEnv)
  if (!/^EXPO_PUBLIC_[A-Z0-9_]+=[A-Za-z0-9_.:-]*$/.test(line))
    throw new Error(`refusing --env ${line}`)
if (!['proof', 'release'].includes(variant)) throw new Error(`unknown --variant ${variant}`)
if (!['apk', 'aab', 'both'].includes(task)) throw new Error(`unknown --task ${task}`)
if (!/^(x86_64|arm64-v8a|x86|armeabi-v7a)(,(x86_64|arm64-v8a|x86|armeabi-v7a))*$/.test(abis))
  throw new Error(`unknown --abis ${abis}`)

const JAVA_HOME = process.env.P186_JAVA_HOME ?? process.env.JAVA_HOME
const ANDROID_HOME =
  process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
if (JAVA_HOME === undefined) throw new Error('set P186_JAVA_HOME (JDK 17+) or JAVA_HOME')
const DRIVE = process.env.P186_SUBST_DRIVE ?? 'V:'
const APPLICATION_ID = process.env.SPIKE_PACKAGE ?? 'invalid.pokeportfolio.spike.p186'

function run(cmd, cmdArgs, cwd, { allowFail = false } = {}) {
  console.log(`\n$ (${cwd}) ${cmd} ${cmdArgs.join(' ')}`)
  const r = spawnSync(cmd, cmdArgs, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, JAVA_HOME, ANDROID_HOME, NODE_ENV: 'production', CI: '1' },
  })
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} failed (${String(r.status)})`)
  return r.status
}

function writeEnvLocal() {
  const stack = process.env.P185_STACK ?? 'p186'
  const env = JSON.parse(
    readFileSync(join(appRoot, '.local-backend', stack, 'public-env.json'), 'utf8'),
  )
  const appUrl = env.appUrl ?? env.apiUrl
  const local = /^http:\/\/127\.0\.0\.1:\d+$/
  if (!local.test(appUrl) || !local.test(env.apiUrl)) throw new Error('refusing: not a local URL')
  if (/^sb_secret_/.test(env.publishableKey)) throw new Error('refusing: secret key')
  const lines = [
    `EXPO_PUBLIC_SUPABASE_URL=${appUrl}`,
    `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${env.publishableKey}`,
  ]
  if (variant === 'proof') lines.push('EXPO_PUBLIC_RUNTIME_PROOF=1')
  lines.push(...extraEnv)
  writeFileSync(join(appRoot, '.env.local'), `${lines.join('\n')}\n`)
}

function patchApplicationId() {
  const file = join(appRoot, 'android', 'app', 'build.gradle')
  const text = readFileSync(file, 'utf8')
  const next = text.replace(/applicationId\s+['"][^'"]+['"]/, `applicationId '${APPLICATION_ID}'`)
  if (next === text && !text.includes(`applicationId '${APPLICATION_ID}'`))
    throw new Error('could not set applicationId in the generated build.gradle')
  writeFileSync(file, next)
}

function gradle(tasks) {
  const args = [...tasks, `-PreactNativeArchitectures=${abis}`]
  const gradlew = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew'
  const pass1 = run(gradlew, args, join(appRoot, 'android'), { allowFail: true })
  if (pass1 === 0) return 'single pass, real path'
  // Fallback kept from P182-P185: a session-only `subst` drive for CMake's MAX_PATH guard.
  if (process.platform !== 'win32') throw new Error('Gradle failed')
  if (existsSync(`${DRIVE}/`)) throw new Error(`${DRIVE} is in use; set P186_SUBST_DRIVE`)
  run('subst', [DRIVE, repoRoot], appRoot)
  try {
    const pass2 = run(gradlew, args, `${DRIVE}\\apps\\mobile-spike\\android`, { allowFail: true })
    if (pass2 !== 0) throw new Error('Gradle failed on the subst drive as well')
  } finally {
    run('subst', [DRIVE, '/d'], appRoot, { allowFail: true })
  }
  return 'second pass on a subst drive (the first failed)'
}

writeEnvLocal()
rmSync(join(tmpdir(), 'metro-cache'), { recursive: true, force: true })
rmSync(join(appRoot, 'android', 'app', 'build', 'generated', 'assets'), {
  recursive: true,
  force: true,
})
const started = Date.now()
if (clean) {
  const dir = join(appRoot, 'android')
  if (existsSync(dir)) {
    if (process.platform === 'win32')
      spawnSync('cmd', ['/c', 'rd', '/s', '/q', '\\\\?\\' + dir], { stdio: 'inherit' })
    else rmSync(dir, { recursive: true, force: true })
  }
  run('npx', ['expo', 'prebuild', '--clean', '--platform', 'android', '--no-install'], appRoot)
}
patchApplicationId()
const tasks = {
  apk: ['assembleRelease'],
  aab: ['bundleRelease'],
  both: ['assembleRelease', 'bundleRelease'],
}[task]
const mode = gradle(tasks)

const out = join(appRoot, '.build', 'p186-artifacts')
mkdirSync(out, { recursive: true })
const report = {
  variant,
  task,
  abis,
  tag,
  mode,
  clean,
  buildSeconds: Math.round((Date.now() - started) / 1000),
  artifacts: {},
}
const apk = join(appRoot, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
const aab = join(
  appRoot,
  'android',
  'app',
  'build',
  'outputs',
  'bundle',
  'release',
  'app-release.aab',
)
for (const [kind, src, ext] of [
  ['apk', apk, 'apk'],
  ['aab', aab, 'aab'],
]) {
  if (!tasks.includes(kind === 'apk' ? 'assembleRelease' : 'bundleRelease')) continue
  if (!existsSync(src)) throw new Error(`${kind} was not produced`)
  const dest = join(out, `${tag}.${ext}`)
  copyFileSync(src, dest)
  report.artifacts[kind] = {
    path: dest,
    bytes: statSync(dest).size,
    sha256: createHash('sha256').update(readFileSync(dest)).digest('hex'),
  }
}
writeFileSync(join(out, `${tag}.build.json`), JSON.stringify(report, null, 2))
console.log(`\n${JSON.stringify(report, null, 2)}`)
