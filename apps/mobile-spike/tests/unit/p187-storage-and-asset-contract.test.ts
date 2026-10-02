/**
 * @jest-environment node
 */
// P187: three source-level contracts the iOS (and Android) builds share.
//   1. persistence: the app stores nothing on the device except through expo-secure-store (the
//      Keychain / Keystore) and the OS cache directory, so no platform backup or iCloud/Auto Backup
//      path can carry session, journal or financial state to another install;
//   2. SecureStore keeps `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and the Android backup rules stay on;
//   3. the scanner uses ONE model and ONE index generation on every platform: no platform branch in
//      the scanner source, the staged assets are pinned by the committed generation manifest.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const appRoot = join(__dirname, '..', '..')
const repoRoot = join(appRoot, '..', '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(name) ? [full] : []
  })
}

const appSources = sourceFiles(join(appRoot, 'src'))
const read = (file: string): string => readFileSync(file, 'utf8')
const rel = (file: string): string => relative(appRoot, file).split(sep).join('/')

describe('device persistence is SecureStore + cache only (backup / reinstall surface)', () => {
  // Any of these would put app data into a location Auto Backup, iCloud backup or a device transfer
  // can copy (documents, shared prefs, databases) or into one that survives differently per platform.
  const FORBIDDEN =
    /AsyncStorage|MMKV|localStorage|window\.sessionStorage|globalThis\.sessionStorage|expo-sqlite|openDatabase|Paths\.document|documentDirectory|Paths\.appleSharedContainers|NSUserDefaults|SharedPreferences/

  it('no source file uses another persistence store', () => {
    const withoutComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const offenders = appSources
      .filter((file) => FORBIDDEN.test(withoutComments(read(file))))
      .map(rel)
    expect(offenders).toEqual([])
  })

  it('only the secure-store adapter imports expo-secure-store', () => {
    const importers = appSources.filter((file) => /from 'expo-secure-store'/.test(read(file)))
    expect(importers.map(rel)).toEqual(['src/auth/secure-store-adapter.ts'])
  })

  it('the Keychain/Keystore accessibility class is this-device-only and unlock-gated', () => {
    expect(read(join(appRoot, 'src/auth/secure-store-adapter.ts'))).toMatch(
      /keychainAccessible: SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/,
    )
  })

  it('the pending-write journal and the session share that one adapter', () => {
    const app = read(join(appRoot, 'App.tsx'))
    expect(app).toMatch(/new PendingWriteJournal\(secureStoreAdapter\)/)
  })

  it('the journal entry type carries identifiers only: no amounts, card data or credentials', () => {
    const journal = read(join(appRoot, 'src/write/pending-write-journal.ts'))
    const entry = journal.slice(
      journal.indexOf('export interface PendingWriteEntry'),
      journal.indexOf('}', journal.indexOf('export interface PendingWriteEntry')),
    )
    const fields = [...entry.matchAll(/readonly (\w+):/g)].map((m) => m[1])
    expect(fields).toEqual([
      'idempotencyKey',
      'operationKind',
      'payloadHash',
      'userId',
      'createdAt',
    ])
  })

  it('the Android backup rules the secure-store plugin installs are not switched off', () => {
    const appJson = JSON.parse(read(join(appRoot, 'app.json'))) as {
      expo: { plugins: unknown[] }
    }
    const entry = appJson.expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-secure-store')
    const options = (entry as [string, Record<string, unknown>]).at(1) as Record<string, unknown>
    expect(options.configureAndroidBackup).not.toBe(false)
    // and the rules exclude exactly the SecureStore preference file from cloud backup and transfer
    const rules = read(
      join(
        appRoot,
        'node_modules/expo-secure-store/android/src/main/res/xml/secure_store_data_extraction_rules.xml',
      ),
    )
    expect(rules.match(/<exclude domain="sharedpref" path="SecureStore"\/>/g)).toHaveLength(2)
  })
})

describe('one scanner asset contract for every platform', () => {
  const generationRoot = join(repoRoot, 'scripts/scanner-visual-index/generated/visual-v1')
  const current = JSON.parse(read(join(generationRoot, 'current.json'))) as {
    contentId: string
    manifestPath: string
  }
  const manifest = JSON.parse(read(join(generationRoot, current.manifestPath))) as {
    modelSha256: string
    embeddingsSha256: string
    modelRevision: string
  }

  it('the generation, the model hash and the index hash are the ones P182-P186 shipped', () => {
    expect(current.contentId).toBe('f25fc05d569b7cca')
    expect(manifest.modelSha256).toBe(
      '3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917',
    )
    expect(manifest.embeddingsSha256).toBe(
      'eaec748d2713cd2b2a1f4a900b7bdeeb06435b8d15d28869a9dbd163f9a5540e',
    )
    expect(manifest.modelRevision).toBe('c2bb04a51fab207c420665f1946016107bffc701')
  })

  it('no scanner source branches on the platform (the same model, index and hash check run on iOS)', () => {
    const scanner = appSources.filter((file) =>
      rel(file).startsWith('src/features/scanner-native/'),
    )
    expect(scanner.length).toBeGreaterThan(5)
    const offenders = scanner.filter((file) =>
      /Platform\.(OS|select)|\.ios\.|\.android\./.test(read(file)),
    )
    expect(offenders.map(rel)).toEqual([])
  })

  it('there are no platform-suffixed scanner or asset modules (an iOS-only index would hide here)', () => {
    const suffixed = appSources.filter((file) => /\.(ios|android)\.(ts|tsx)$/.test(file))
    expect(suffixed.map(rel)).toEqual([])
  })

  it('the hash of the staged bytes is verified at load, on every platform, before use', () => {
    const loader = read(join(appRoot, 'src/features/scanner-native/model-assets.ts'))
    expect(loader).toMatch(/manifest\.modelSha256/)
    expect(loader).toMatch(/manifest\.embeddingsSha256/)
    expect(loader).toMatch(/AssetIntegrityError/)
  })

  it('Metro bundles the model and the index as binary assets for both platforms', () => {
    const metro = read(join(appRoot, 'metro.config.js'))
    expect(metro).toMatch(/assetExts, 'onnx', 'bin'/)
    expect(metro).not.toMatch(/platform === 'ios'|platform === 'android'/)
  })
})
