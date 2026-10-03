import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { P169_SCREENS } from '../../src/features/screens'

/**
 * One navigation tree (P173): the Search / Price Check screens are registered INTO the shell's
 * navigators, not into a container of their own. Static checks over the source, so a second
 * NavigationContainer, a duplicated route registration or a shell route that shadows a feature route
 * fails a test instead of showing up as two histories or a wrong Back.
 */
const src = join(__dirname, '..', '..', 'src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

const files = sources(src).map((path) => ({
  path: path.split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}))
const count = (text: string, needle: string) => text.split(needle).length - 1

describe('one navigation tree', () => {
  it('has exactly one NavigationContainer, in the shell', () => {
    const owners = files.filter((f) => count(f.text, '<NavigationContainer') > 0)
    expect(owners.map((f) => f.path.replaceAll('\\', '/').split('/src/')[1])).toEqual([
      'ui/AppRoot.tsx',
    ])
    expect(count(owners[0]?.text ?? '', '<NavigationContainer')).toBe(1)
  })

  it('registers each feature screen once, and none under a shell route name', () => {
    const names = P169_SCREENS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
    const navigator = files.find((f) => f.path.endsWith('MainNavigator.tsx'))?.text ?? ''
    const shellRoutes = [...navigator.matchAll(/<\w+\.Screen[^>]*?\sname="(\w+)"/gs)].map(
      (m) => m[1],
    )
    for (const name of names) expect(shellRoutes).not.toContain(name)
    expect(new Set(shellRoutes).size).toBe(shellRoutes.length)
    // the feature screens come from the one registration list, mapped exactly once
    expect(count(navigator, 'P169_SCREENS.map')).toBe(1)
  })

  it('has the four tabs, each registered once', () => {
    const navigator = files.find((f) => f.path.endsWith('MainNavigator.tsx'))?.text ?? ''
    for (const tab of ['CollectionTab', 'SearchTab', 'PriceCheckTab', 'ProfileTab'])
      expect(count(navigator, `name="${tab}"`)).toBe(1)
  })

  it('creates the Supabase client in exactly one module', () => {
    const creators = files.filter((f) => /\bcreateClient\(|\bcreateNativeClient\(/.test(f.text))
    expect(creators.map((f) => f.path.replaceAll('\\', '/').split('/src/')[1]).sort()).toEqual([
      'auth/create-client.ts',
      'seam/supabase-client.ts',
    ])
    expect(
      count(
        files.find((f) => f.path.endsWith('seam/supabase-client.ts'))?.text ?? '',
        'createNativeClient(',
      ),
    ).toBe(1)
  })
})
