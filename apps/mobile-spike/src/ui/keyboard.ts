import { useContext } from 'react'
import { Platform, type KeyboardAvoidingViewProps, type PlatformOSType } from 'react-native'
import { HeaderHeightContext } from '@react-navigation/elements'

/**
 * Keyboard avoidance, chosen per platform (P187).
 *
 * `padding` is right on both: Android 15+ draws edge-to-edge, so `adjustResize` no longer shrinks
 * the window and the view must pad itself (P166 F7); on iOS `padding` is React Native's documented
 * behaviour for a flexed column with a pinned footer.
 *
 * The offset is where they differ. A `KeyboardAvoidingView` measures its frame against the SCREEN,
 * so under a native-stack header iOS needs `keyboardVerticalOffset` = the header's height, or the
 * footer stops short of the keyboard by exactly that much and the keyboard covers it. Android keeps
 * 0: its edge-to-edge window already starts under the header and the offset there was verified on
 * a device in P167 without one. Outside a navigator (the login screen) there is no header.
 */
export const KEYBOARD_BEHAVIOR = 'padding' as const

export function keyboardVerticalOffset(
  os: PlatformOSType,
  headerHeight: number | undefined,
): number {
  if (os !== 'ios') return 0
  return headerHeight !== undefined && Number.isFinite(headerHeight) && headerHeight > 0
    ? headerHeight
    : 0
}

export function keyboardAvoidingProps(
  os: PlatformOSType,
  headerHeight: number | undefined,
): Pick<KeyboardAvoidingViewProps, 'behavior' | 'keyboardVerticalOffset'> {
  return {
    behavior: KEYBOARD_BEHAVIOR,
    keyboardVerticalOffset: keyboardVerticalOffset(os, headerHeight),
  }
}

/** Props for the `KeyboardAvoidingView` of the screen it is called from. */
export function useKeyboardAvoidingProps() {
  // `HeaderHeightContext` is undefined outside a navigator header, unlike `useHeaderHeight`, which throws.
  const headerHeight = useContext(HeaderHeightContext)
  return keyboardAvoidingProps(Platform.OS, headerHeight)
}
