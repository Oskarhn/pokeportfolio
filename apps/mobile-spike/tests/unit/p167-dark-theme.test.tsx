import { act, render, screen } from '@testing-library/react-native'
import { StyleSheet, type StyleProp, type TextStyle } from 'react-native'
import { AppRoot } from '../../src/ui/AppRoot'
import { navigationTheme } from '../../src/ui/theme'
import { flush, harness, row, session } from '../support/fakes'

/**
 * P166 F5: in dark mode the content turned dark while React Navigation's header and tab bar stayed
 * light (no theme passed), and the "auto" status bar icons turned light: white on white. The device
 * check (scripts/android-p167-check.mjs) measures the bars; this pins the wiring. UNIT_TESTED.
 */
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => 'dark',
}))

it('the navigation chrome follows the system scheme (no light header or tab bar in dark mode)', async () => {
  const h = harness()
  h.collection.pages.push({ rows: [row('a1')], nextCursor: null })
  await render(<AppRoot runtime={h.runtime} backendHost="127.0.0.1" />)
  await act(async () => {
    h.auth.emit('SIGNED_IN', session('A'))
    await flush()
  })
  await screen.findByTestId('row-a1')
  const dark = navigationTheme('dark')
  expect(dark.dark).toBe(true)
  // P178: dark moved from the neutral placeholder palette to the Foil-derived graphite ground —
  // rows sit directly on the ground (no separate "card" surface colour), per the design system.
  expect(dark.colors.card).toBe('#0F0F11')
  // The active tab label is tinted with the theme's primary colour: the dark accent. Without a theme
  // React Navigation uses its light default.
  const label = screen.getAllByText('Collection').find((t) => t.props.numberOfLines === 2)
  expect(StyleSheet.flatten(label?.props.style as StyleProp<TextStyle>).color).toBe(
    dark.colors.primary,
  )
})
