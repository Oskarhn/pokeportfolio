#!/usr/bin/env node
/**
 * P187 mutation proofs: only for what P187 changed or pinned (iOS portability). Each mutant plants ONE
 * portability defect, runs the relevant tests, and must make them FAIL by an assertion. A run that
 * reports "Test suite failed to run" is INVALID, not killed. Every file is restored in a `finally`,
 * and the run ends by checking that `git diff` of every mutated file is empty (so commit first).
 *
 *   node scripts/p187/mutations.mjs [regex-of-mutant-ids]
 *
 * Result: .build/p187-mutations.json (gitignored) and stdout.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const only = process.argv[2] ? new RegExp(process.argv[2], 'i') : null

const CONFIG = ['tests/unit/p187-ios-config.test.ts']
const LAYOUT = ['tests/unit/p187-ios-layout-readiness.test.tsx']
const KEYBOARD = ['tests/unit/p187-keyboard-platform.test.tsx']
const IMAGE = ['tests/unit/p187-ios-image-pipeline.test.ts']
const GRAPH = ['tests/unit/p187-ios-graph.test.ts']
const PLATFORM = ['tests/unit/p187-platform-portability.test.ts']
const INTEGRITY = ['tests/unit/p184-native-asset-integrity.test.ts']

const KEYBOARD_SRC = 'src/ui/keyboard.ts'
const COMPONENTS = 'src/ui/components.tsx'
const OCR = 'src/features/scanner-native/ocr-adapter.ts'
const PHOTO_PORT = 'src/photo/expo-photo-port.ts'

/** @type {{id:string,name:string,file:string,from:string,to:string,tests:string[]}[]} */
const MUTANTS = [
  {
    id: 'I01',
    name: 'an Android config plugin mutates the iOS project (dangerous mod registered for ios)',
    file: 'plugins/with-local-cleartext.js',
    from: "    'android',\n    (cfg) => {\n      const dir",
    to: "    'ios',\n    (cfg) => {\n      const dir",
    tests: CONFIG,
  },
  {
    id: 'I02',
    name: 'a content:// URI (or any non-empty string) is accepted by the OCR adapter on iOS',
    file: OCR,
    from: '  return NATIVE_READABLE_FILE_URI.test(uri)',
    to: '  return uri.length > 0',
    tests: IMAGE,
  },
  {
    id: 'I03',
    name: 'the write-form footer ignores the iOS bottom safe-area inset (home indicator)',
    file: COMPONENTS,
    from: '<TaskFooter insetBottom={insets.bottom}>',
    to: '<TaskFooter insetBottom={0}>',
    tests: LAYOUT,
  },
  {
    id: 'I04',
    name: 'the bottom sheet ignores the iOS bottom safe-area inset',
    file: COMPONENTS,
    from: 'paddingBottom: SPACE.lg + insets.bottom,',
    to: 'paddingBottom: SPACE.lg,',
    tests: LAYOUT,
  },
  {
    id: 'I05',
    name: 'iOS keyboard offset ignores the native-stack header (the Android-only setting)',
    file: KEYBOARD_SRC,
    from: "  if (os !== 'ios') return 0",
    to: '  if (os !== null) return 0',
    tests: KEYBOARD,
  },
  {
    id: 'I06',
    name: 'Android gets the iOS header offset (an Android regression)',
    file: KEYBOARD_SRC,
    from: "  if (os !== 'ios') return 0",
    to: '  if (os === null) return 0',
    tests: KEYBOARD,
  },
  {
    id: 'I07',
    name: 'a non-finite header measurement reaches the KeyboardAvoidingView as NaN',
    file: KEYBOARD_SRC,
    from: 'headerHeight !== undefined && Number.isFinite(headerHeight) && headerHeight > 0',
    to: 'headerHeight !== undefined && headerHeight !== 0',
    tests: KEYBOARD,
  },
  {
    id: 'I08',
    name: 'TaskScreen stops using the platform keyboard props',
    file: COMPONENTS,
    from: 'const keyboardProps = useKeyboardAvoidingProps()',
    to: "const keyboardProps = { behavior: 'padding' as const }",
    tests: KEYBOARD,
  },
  {
    id: 'I09',
    name: 'the iOS graph check no longer treats an Android implementation as a violation',
    file: 'scripts/p187/ios-graph-lib.cjs',
    from: '  ios: /\\.(android|web)\\.[cm]?[jt]sx?$/,',
    to: '  ios: /\\.(web)\\.[cm]?[jt]sx?$/,',
    tests: GRAPH,
  },
  {
    id: 'I10',
    name: 'the iOS graph check no longer requires the scanner chain (OCR adapter missing is accepted)',
    file: 'scripts/p187/ios-graph-lib.cjs',
    from: "  '/src/features/scanner-native/ocr-adapter.ts',\n",
    to: '',
    tests: GRAPH,
  },
  {
    id: 'I11',
    name: 'the image privacy guard is removed: the picker returns EXIF (GPS) metadata',
    file: PHOTO_PORT,
    from: '        exif: false,',
    to: '        exif: true,',
    tests: IMAGE,
  },
  {
    id: 'I12',
    name: 'picker quality 1: iOS hands back the original HEIC instead of a JPEG',
    file: PHOTO_PORT,
    from: 'export const PICKER_QUALITY = 0.8',
    to: 'export const PICKER_QUALITY = 1',
    tests: IMAGE,
  },
  {
    id: 'I13',
    name: 'the model hash check is skipped (the same JS runs on iOS)',
    file: 'src/features/scanner-native/model-assets.ts',
    from: '  if (modelSha !== manifest.modelSha256) {',
    to: '  if (false as boolean) {',
    tests: INTEGRITY,
  },
  {
    id: 'I14',
    name: 'the microphone permission comes back (Info.plist + RECORD_AUDIO) for a feature the app does not have',
    file: 'app.json',
    from: ',\n          "microphonePermission": false',
    to: '',
    tests: CONFIG,
  },
  {
    id: 'I15',
    name: 'the Face ID usage text comes back for a store that is never biometric-gated',
    file: 'app.json',
    from: '["expo-secure-store", { "faceIDPermission": false }]',
    to: '"expo-secure-store"',
    tests: CONFIG,
  },
  {
    id: 'I16',
    name: 'the camera usage text stops saying recognition is local',
    file: 'app.json',
    from: 'Take a card photo to identify. The card is recognised on this device and the photo is never uploaded.',
    to: 'Take a card photo.',
    tests: CONFIG,
  },
  {
    id: 'I17',
    name: 'an Android-only API (BackHandler) is imported into shared app code',
    file: KEYBOARD_SRC,
    from: "import { useContext } from 'react'",
    to: "import { useContext } from 'react'\nimport { BackHandler } from 'react-native'\nvoid BackHandler",
    tests: PLATFORM,
  },
  {
    id: 'I18',
    name: 'the dark-first native root view is dropped (expo-system-ui removed from the dependencies)',
    file: 'package.json',
    from: '    "expo-system-ui": "~57.0.4",\n',
    to: '',
    tests: CONFIG,
  },
]

const results = []
const touched = new Set()
for (const m of MUTANTS) {
  if (only && !only.test(m.id)) continue
  const path = join(appRoot, m.file)
  touched.add(path)
  const original = readFileSync(path, 'utf8')
  const occurrences = original.split(m.from).length - 1
  if (occurrences !== 1) {
    results.push({
      id: m.id,
      name: m.name,
      verdict: 'INVALID',
      detail: `anchor occurs ${String(occurrences)} times`,
    })
    console.log(`${m.id} INVALID (anchor occurs ${String(occurrences)}x): ${m.name}`)
    continue
  }
  try {
    writeFileSync(
      path,
      original.replace(m.from, () => m.to),
    )
    const r = spawnSync(
      'pnpm',
      ['exec', 'jest', '--selectProjects', 'unit', '--runTestsByPath', ...m.tests],
      { cwd: appRoot, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 },
    )
    const out = `${r.stdout}\n${r.stderr}`
    const failedTests = Number(/Tests:\s+(?:\d+ skipped, )?(\d+) failed/.exec(out)?.[1] ?? 0)
    const suiteFailed = /Test suite failed to run/.test(out)
    let verdict
    if (suiteFailed) verdict = 'INVALID'
    else if (failedTests > 0) verdict = 'KILLED'
    else verdict = 'SURVIVED'
    const firstFail = /●\s+([^\n]+)/.exec(out)?.[1]?.trim().slice(0, 140) ?? null
    results.push({ id: m.id, name: m.name, verdict, failedTests, killedBy: firstFail })
    console.log(
      `${m.id} ${verdict}${verdict === 'KILLED' ? ` (${String(failedTests)} failing) by: ${String(firstFail)}` : ''}: ${m.name}`,
    )
  } finally {
    writeFileSync(path, original)
  }
}

const dirty = spawnSync('git', ['-C', appRoot, 'diff', '--stat', '--', ...[...touched]], {
  encoding: 'utf8',
}).stdout.trim()
const summary = {
  total: results.length,
  killed: results.filter((r) => r.verdict === 'KILLED').length,
  survived: results.filter((r) => r.verdict === 'SURVIVED').length,
  invalid: results.filter((r) => r.verdict === 'INVALID').length,
  restored: dirty === '',
}
mkdirSync(join(appRoot, '.build'), { recursive: true })
writeFileSync(
  join(appRoot, '.build', 'p187-mutations.json'),
  `${JSON.stringify({ summary, results }, null, 2)}\n`,
)
console.log(JSON.stringify(summary))
if (!summary.restored) console.error(`WORKING TREE NOT RESTORED:\n${dirty}`)
process.exit(summary.survived + summary.invalid > 0 || !summary.restored ? 1 : 0)
