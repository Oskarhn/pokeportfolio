#!/usr/bin/env node
/**
 * P186 Android App Bundle analysis with the official bundletool (LOCAL ONLY; nothing is published).
 *
 *   BUNDLETOOL_JAR=<path to bundletool-all-<version>.jar> node scripts/p186/aab-analysis.mjs \
 *       <app.aab> [--out .build/p186-artifacts/<tag>-analysis.json] [--keep-apks]
 *
 * It reports, from the bundle itself and never from a guess:
 *   - the manifest identity (package, versionCode, versionName, minSdk/targetSdk) and whether the
 *     bundle holds native libraries per ABI (the static packaging gate: PACKAGE_PRESENT, never a
 *     runtime claim);
 *   - the universal APK bytes (what an "install everything" APK would weigh);
 *   - for each device spec in scripts/p186/device-specs/: the split APKs Play would deliver, their
 *     raw bytes, and bundletool's compressed download-size estimate (get-size total).
 * The keystore is bundletool's default (the local debug keystore): these .apks are analysis
 * artefacts, not signed for any store.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readZipEntries, summarise } from './package-inventory.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const jar = process.env.BUNDLETOOL_JAR
const javaHome = process.env.P186_JAVA_HOME ?? process.env.JAVA_HOME
if (jar === undefined || !existsSync(jar))
  throw new Error('set BUNDLETOOL_JAR to bundletool-all-*.jar')
const java = javaHome
  ? join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  : 'java'

const args = process.argv.slice(2)
const aab = args.find((a) => !a.startsWith('--') && a.endsWith('.aab'))
if (aab === undefined)
  throw new Error('usage: aab-analysis.mjs <app.aab> [--out file.json] [--keep-apks]')
const outIdx = args.indexOf('--out')
const outFile = outIdx === -1 ? aab.replace(/\.aab$/, '-analysis.json') : args[outIdx + 1]
const keep = args.includes('--keep-apks')

function bundletool(btArgs) {
  const r = spawnSync(java, ['-jar', jar, ...btArgs], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`bundletool ${btArgs[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return r.stdout
}

const work = join(tmpdir(), `p186-aab-${String(process.pid)}`)
mkdirSync(work, { recursive: true })
const report = { aab, aabBytes: statSync(aab).size, bundletool: bundletool(['version']).trim() }

// ---- manifest identity ---------------------------------------------------------------------------
const manifest = bundletool(['dump', 'manifest', `--bundle=${aab}`])
const pick = (re) => re.exec(manifest)?.[1] ?? null
report.manifest = {
  package: pick(/package="([^"]+)"/),
  versionCode: pick(/android:versionCode="(\d+)"/),
  versionName: pick(/android:versionName="([^"]+)"/),
  minSdkVersion: pick(/android:minSdkVersion="(\d+)"/),
  targetSdkVersion: pick(/android:targetSdkVersion="(\d+)"/),
  debuggable: /android:debuggable="true"/.test(manifest),
  usesCleartextTraffic: pick(/android:usesCleartextTraffic="(true|false)"/),
}

// ---- the bundle's own content (static packaging gate) ----------------------------------------------
const entries = readZipEntries(readFileSync(aab))
report.inventory = summarise(entries)
report.abisPackaged = report.inventory.perAbi.map((a) => a.abi).sort()
report.sourceMapsInBundle = entries.filter((e) => /\.map$/.test(e.name)).map((e) => e.name)
report.debugSymbolFiles = entries
  .filter((e) => /\.(dbg|sym|so\.dbg)$/.test(e.name))
  .map((e) => e.name)

// ---- universal APK ----------------------------------------------------------------------------------
const universal = join(work, 'universal.apks')
bundletool([
  'build-apks',
  `--bundle=${aab}`,
  `--output=${universal}`,
  '--mode=universal',
  '--overwrite',
])
const uEntries = readZipEntries(readFileSync(universal))
const uApk = uEntries.find((e) => e.name === 'universal.apk')
report.universalApkBytes = uApk?.uncompressed ?? null

// ---- per-device split delivery -----------------------------------------------------------------------
const apks = join(work, 'device.apks')
bundletool(['build-apks', `--bundle=${aab}`, `--output=${apks}`, '--overwrite'])
report.devices = {}
const specDir = join(here, 'device-specs')
for (const name of readdirSync(specDir)
  .filter((f) => f.endsWith('.json'))
  .sort()) {
  const spec = join(specDir, name)
  const sizeOut = bundletool(['get-size', 'total', `--apks=${apks}`, `--device-spec=${spec}`])
  const [min, max] = sizeOut
    .trim()
    .split('\n')
    .pop()
    .split(',')
    .map((v) => Number(v.replace(/\D/g, '')))
  const extractDir = join(work, `extract-${name}`)
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  const listed = bundletool([
    'extract-apks',
    `--apks=${apks}`,
    `--device-spec=${spec}`,
    `--output-dir=${extractDir}`,
  ])
  const splits = readdirSync(extractDir)
    .filter((f) => f.endsWith('.apk'))
    .map((f) => ({
      name: f,
      bytes: statSync(join(extractDir, f)).size,
    }))
  report.devices[name.replace(/\.json$/, '')] = {
    spec: JSON.parse(readFileSync(spec, 'utf8')),
    downloadSizeEstimateBytes: { min, max },
    splitApks: splits,
    splitApkBytesTotal: splits.reduce((a, s) => a + s.bytes, 0),
    note: listed.trim().split('\n').slice(0, 1).join(''),
  }
}

mkdirSync(dirname(resolve(outFile)), { recursive: true })
writeFileSync(outFile, JSON.stringify(report, null, 2))
if (keep) console.log(`kept: ${work}`)
else rmSync(work, { recursive: true, force: true })
console.log(JSON.stringify({ ...report, inventory: undefined }, null, 2))
