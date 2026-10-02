// P187: keyboard avoidance is chosen per platform. iOS needs the native-stack header height as the
// keyboard offset (the KeyboardAvoidingView measures against the screen); Android keeps 0, the value
// verified on a device in P167. Platform selection is a pure function so both branches are testable
// on any host; the hook is checked under a real navigator header context with Platform.OS replaced.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import { Platform } from 'react-native'
import { HeaderHeightContext } from '@react-navigation/elements'
import { renderHook } from '@testing-library/react-native'
import {
  KEYBOARD_BEHAVIOR,
  keyboardAvoidingProps,
  keyboardVerticalOffset,
  useKeyboardAvoidingProps,
} from '../../src/ui/keyboard'

const appRoot = join(__dirname, '..', '..')

describe('keyboardVerticalOffset', () => {
  it('iOS uses the header height', () => {
    expect(keyboardVerticalOffset('ios', 96)).toBe(96)
    expect(keyboardVerticalOffset('ios', 44.5)).toBe(44.5)
  })
  it('iOS without a header (login) or with a bad measurement uses 0, never NaN', () => {
    expect(keyboardVerticalOffset('ios', undefined)).toBe(0)
    expect(keyboardVerticalOffset('ios', 0)).toBe(0)
    expect(keyboardVerticalOffset('ios', -5)).toBe(0)
    expect(keyboardVerticalOffset('ios', Number.NaN)).toBe(0)
    expect(keyboardVerticalOffset('ios', Number.POSITIVE_INFINITY)).toBe(0)
  })
  it('Android never gets an offset, whatever the header is (its edge-to-edge window starts under it)', () => {
    expect(keyboardVerticalOffset('android', 96)).toBe(0)
    expect(keyboardVerticalOffset('android', undefined)).toBe(0)
  })
  it('web and other hosts are unaffected', () => {
    expect(keyboardVerticalOffset('web', 96)).toBe(0)
  })
})

describe('keyboardAvoidingProps', () => {
  it('is `padding` on both platforms (an undefined behavior is the P166 F7 defect)', () => {
    expect(KEYBOARD_BEHAVIOR).toBe('padding')
    expect(keyboardAvoidingProps('ios', 96)).toEqual({
      behavior: 'padding',
      keyboardVerticalOffset: 96,
    })
    expect(keyboardAvoidingProps('android', 96)).toEqual({
      behavior: 'padding',
      keyboardVerticalOffset: 0,
    })
  })
})

describe('useKeyboardAvoidingProps', () => {
  const withHeader = (height: number | undefined) =>
    function Wrapper({ children }: { children: ReactNode }) {
      return <HeaderHeightContext.Provider value={height}>{children}</HeaderHeightContext.Provider>
    }
  afterEach(() => jest.restoreAllMocks())

  it('on iOS reads the enclosing header height', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios')
    const { result } = await renderHook(() => useKeyboardAvoidingProps(), {
      wrapper: withHeader(88),
    })
    expect(result.current).toEqual({ behavior: 'padding', keyboardVerticalOffset: 88 })
  })

  it('on Android ignores it', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    const { result } = await renderHook(() => useKeyboardAvoidingProps(), {
      wrapper: withHeader(88),
    })
    expect(result.current.keyboardVerticalOffset).toBe(0)
  })

  it('outside any navigator (the login screen) does not throw and gives 0', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios')
    const { result } = await renderHook(() => useKeyboardAvoidingProps())
    expect(result.current.keyboardVerticalOffset).toBe(0)
  })
})

describe('wiring', () => {
  it('TaskScreen (every financial write form) spreads the platform props into its KeyboardAvoidingView', () => {
    const text = readFileSync(join(appRoot, 'src/ui/components.tsx'), 'utf8')
    const start = text.indexOf('export function TaskScreen')
    const taskScreen = text.slice(start, text.indexOf('// ---', start))
    expect(taskScreen).toMatch(/useKeyboardAvoidingProps\(\)/)
    expect(taskScreen).toMatch(/<KeyboardAvoidingView[^>]*\{\.\.\.keyboardProps\}/)
    expect(taskScreen).not.toMatch(/behavior=['"{]/) // no hard-coded behavior beside the shared props
  })
})
