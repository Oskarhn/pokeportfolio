/**
 * @jest-environment node
 */
// P187: no Android-only assumption may creep into code that also ships on iPhone. Every identifier or
// string literal in the app's own source that names an Android-only API or location is classified
// below (comments are skipped: the AST has none). A new hit fails this test until it is classified,
// which forces the question "does this run on iOS?" at the moment someone writes it.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'

const appRoot = join(__dirname, '..', '..')

/** Identifiers that name a platform switch or an Android-only API. */
const PLATFORM_IDENTIFIERS = new Set([
  'Platform',
  'BackHandler',
  'PermissionsAndroid',
  'ToastAndroid',
  'DrawerLayoutAndroid',
  'NavigationBar',
  'StatusBar',
  'MediaStore',
])
const PLATFORM_STRINGS = [/content:\/\//, /MediaStore/, /android/i, /NavigationBar/]
const PLATFORM_IDENTIFIER_PARTS = /android/i

type Classification = 'INTENTIONAL_PLATFORM_BRANCH'
const CLASSIFIED: Record<string, { class: Classification; why: string }> = {
  'src/seam/supabase-client.ts': {
    class: 'INTENTIONAL_PLATFORM_BRANCH',
    why: 'passes Platform.OS to the backend-config guard; only the Android emulator alias differs',
  },
  'src/config/backend-config.ts': {
    class: 'INTENTIONAL_PLATFORM_BRANCH',
    why: 'rewrites a host-loopback URL to 10.0.2.2 for the Android emulator only; iOS is unchanged',
  },
  'src/ui/keyboard.ts': {
    class: 'INTENTIONAL_PLATFORM_BRANCH',
    why: 'iOS needs the header height as a keyboard offset; Android uses 0',
  },
  'src/ui/theme.ts': {
    class: 'INTENTIONAL_PLATFORM_BRANCH',
    why: 'expo-status-bar StatusBar (cross-platform) styled from the active scheme',
  },
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

export function platformHits(text: string, fileName = 'x.tsx'): string[] {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (PLATFORM_IDENTIFIERS.has(node.text) || PLATFORM_IDENTIFIER_PARTS.test(node.text)) {
        hits.push(node.text)
      }
    } else if (ts.isStringLiteralLike(node)) {
      if (PLATFORM_STRINGS.some((re) => re.test(node.text))) hits.push(JSON.stringify(node.text))
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return hits
}

describe('platform-specific code in the shipped app source (P187)', () => {
  const files = [
    ...sourceFiles(join(appRoot, 'src')),
    join(appRoot, 'App.tsx'),
    join(appRoot, 'index.ts'),
  ]
  const hitsByFile = new Map<string, string[]>()
  for (const file of files) {
    const hits = platformHits(readFileSync(file, 'utf8'), file)
    if (hits.length > 0) hitsByFile.set(relative(appRoot, file).split(sep).join('/'), hits)
  }

  it('every file that names an Android-only API or location is classified, and nothing else is', () => {
    expect([...hitsByFile.keys()].sort()).toEqual(Object.keys(CLASSIFIED).sort())
  })

  it('no Android-only API (BackHandler, PermissionsAndroid, MediaStore, content://) is used anywhere', () => {
    const forbidden =
      /^(BackHandler|PermissionsAndroid|ToastAndroid|DrawerLayoutAndroid|MediaStore|NavigationBar|"content:\/\/.*")$/
    const offending = [...hitsByFile.entries()].filter(([, hits]) =>
      hits.some((h) => forbidden.test(h)),
    )
    expect(offending).toEqual([])
  })

  it('the detector sees what it is meant to see (a mutation here would let a hit through)', () => {
    expect(platformHits("import { BackHandler } from 'react-native'")).toContain('BackHandler')
    expect(platformHits("const u = 'content://media/external/images/1'")).toHaveLength(1)
    expect(platformHits('if (Platform.OS === "android") {}')).toEqual(
      expect.arrayContaining(['Platform', '"android"']),
    )
    expect(platformHits('// BackHandler is only mentioned in a comment')).toEqual([])
    expect(platformHits('const x = androidEmulatorHost')).toEqual(['androidEmulatorHost'])
  })
})
