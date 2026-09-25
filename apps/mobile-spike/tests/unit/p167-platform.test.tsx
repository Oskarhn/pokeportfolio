import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, render, screen } from '@testing-library/react-native'
import { AppRoot } from '../../src/ui/AppRoot'
import { breakableMoneyText } from '../../src/ui/components'
import { tabBarHeight } from '../../src/ui/MainNavigator'
import { KEYBOARD_BEHAVIOR } from '../../src/ui/screens/LoginScreen'
import { flush, harness, row, session } from '../support/fakes'

/**
 * Regression tests for the Android defects P166 found and P167 fixed. UNIT_TESTED in the RN jest
 * preset; the same behaviour is checked on the emulator by scripts/android-p167-check.mjs.
 */
const appRoot = join(__dirname, '..', '..')

async function signedIn() {
  const h = harness()
  h.collection.pages.push({ rows: [row('a1')], nextCursor: null })
  await render(<AppRoot runtime={h.runtime} backendHost="127.0.0.1" />)
  await act(async () => {
    h.auth.emit('SIGNED_IN', session('A'))
    await flush()
  })
  await screen.findByTestId('row-a1')
  return h
}

describe('F7 keyboard', () => {
  it('the login form moves above the keyboard on Android too (padding, not undefined)', async () => {
    expect(KEYBOARD_BEHAVIOR).toBe('padding')
    const h = harness()
    await render(<AppRoot runtime={h.runtime} backendHost="127.0.0.1" />)
    await act(async () => {
      h.auth.emit('INITIAL_SESSION', null)
      await new Promise((r) => setTimeout(r, 5))
    })
    await screen.findByTestId('login-screen')
    // RNTL queries see host views only; the prop wiring is pinned in the source instead
    const source = readFileSync(join(appRoot, 'src/ui/screens/LoginScreen.tsx'), 'utf8')
    expect(source).toMatch(/<KeyboardAvoidingView[^>]*behavior={KEYBOARD_BEHAVIOR}/)
    expect(screen.getByTestId('login-email').props.returnKeyType).toBe('next')
    expect(screen.getByTestId('login-password').props.returnKeyType).toBe('go')
  })
})

describe('F3 tabs', () => {
  it('each tab is announced by its name alone and shows its text label; no fallback glyph', async () => {
    await signedIn()
    const tabs: [string, string][] = [
      ['tab-collection', 'Collection'],
      ['tab-search', 'Search'],
      ['tab-pricecheck', 'Price Check'],
      ['tab-profile', 'Profile'],
    ]
    for (const [id, name] of tabs) {
      const tab = screen.getByTestId(id)
      expect(tab.props.accessibilityLabel ?? tab.props['aria-label']).toBe(name)
      expect(screen.getAllByText(name).length).toBeGreaterThan(0)
    }
    // bottom-tabs' MissingIcon draws this glyph when no tabBarIcon is set
    expect(screen.queryByText('⏷')).toBeNull()
  })

  it('the tab bar grows with large text and always clears the gesture bar', () => {
    expect(tabBarHeight(1, 24)).toBe(80)
    expect(tabBarHeight(2, 24)).toBe(92)
    expect(tabBarHeight(1, 0)).toBeGreaterThanOrEqual(48)
  })
})

describe('F4 large text', () => {
  it('a wrapping amount may break only between whole digit groups; digits are unchanged', () => {
    const exact = '8\u00A0917\u00A0127\u00A0262\u00A0195\u00A0456,87\u00A0kr'
    const shown = breakableMoneyText(exact)
    expect(shown).toBe('8 917 127 262 195 456,87 kr')
    expect(shown.replace(/ /g, '')).toBe(exact.replace(/\u00A0/g, ''))
    expect(breakableMoneyText('—')).toBe('—')
  })
})

describe('F1 expo-modules-core patch (Activity-result launcher re-registration)', () => {
  it('is registered with pnpm, contains the upstream fix, and is applied to the installed module', () => {
    const workspace = readFileSync(join(appRoot, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace).toMatch(
      /expo-modules-core@57\.0\.18: patches\/expo-modules-core@57\.0\.18\.patch/,
    )
    const patch = readFileSync(join(appRoot, 'patches', 'expo-modules-core@57.0.18.patch'), 'utf8')
    expect(patch).toContain('?: reregister(key, contract, fallbackCallback)')
    const installed = join(appRoot, 'node_modules', 'expo-modules-core')
    // The patch is written for exactly this version; an upgrade must re-evaluate it (upstream
    // expo/expo#49634 may then already contain the fix).
    expect(
      (JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as { version: string })
        .version,
    ).toBe('57.0.18')
    const source = join(
      installed,
      'android/src/main/java/expo/modules/kotlin/activityresult/AppContextActivityResultRegistry.kt',
    )
    expect(existsSync(source)).toBe(true)
    expect(readFileSync(source, 'utf8')).toContain('private fun <I : Serializable, O> reregister(')
  })
})
