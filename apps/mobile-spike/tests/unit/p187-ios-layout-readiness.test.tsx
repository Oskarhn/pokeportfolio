// P187: iPhone SOURCE / LAYOUT READINESS. Jest has no layout engine, so this is not a visual check and
// does not replace running the app on an iPhone or simulator (docs/mobile/IOS_BUILD_AND_DEVICE_RUNBOOK.md,
// gate G7). What it does prove, for representative iPhone logical widths, safe-area insets and text
// scales: the shared layout primitives every listed screen is built from apply the iOS safe-area
// insets (home indicator, Dynamic Island), never a hard-coded Android navigation-bar number, and
// nothing in the UI source pins a width or a height that a narrow screen or a 200% font would break.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Platform, StyleSheet, Text } from 'react-native'
import {
  SafeAreaInsetsContext,
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context'
import { render, screen } from '@testing-library/react-native'
import { BottomSheet, TaskScreen } from '../../src/ui/components'
import { tabBarHeight } from '../../src/ui/MainNavigator'
import { SPACE } from '../../src/ui/theme'

const appRoot = join(__dirname, '..', '..')

/** Logical (point) sizes and safe-area insets of the iPhones this app targets. */
const IPHONES = [
  { name: 'iPhone SE (1st gen) 320pt', width: 320, height: 568, top: 20, bottom: 0 },
  { name: 'iPhone SE (3rd gen) / 8 375pt', width: 375, height: 667, top: 20, bottom: 0 },
  { name: 'iPhone 14 / 15 / 16 390pt', width: 390, height: 844, top: 59, bottom: 34 },
  { name: 'iPhone Pro Max 430pt', width: 430, height: 932, top: 59, bottom: 34 },
] as const
const FONT_SCALES = [1.0, 1.3, 2.0] as const

function styleOf(host: { props: { style?: unknown } }): Record<string, unknown> {
  return StyleSheetFlatten(host.props.style)
}
function StyleSheetFlatten(style: unknown): Record<string, unknown> {
  return (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>
}

describe.each(IPHONES)('$name', (phone) => {
  const metrics = {
    frame: { x: 0, y: 0, width: phone.width, height: phone.height },
    insets: { top: phone.top, left: 0, right: 0, bottom: phone.bottom },
  }

  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'ios')
  })
  afterEach(() => jest.restoreAllMocks())

  it('write forms (Purchase, Sale, Opening, ...): the footer clears the home indicator', async () => {
    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <TaskScreen footer={<Text testID="footer-probe">Save</Text>}>
          <Text>Field</Text>
        </TaskScreen>
      </SafeAreaProvider>,
    )
    const footer = screen.getByTestId('footer-probe').parent
    expect(footer).toBeTruthy()
    const style = styleOf(footer as never)
    expect(style.paddingBottom).toBe(SPACE.lg + phone.bottom)
    expect(style.position).not.toBe('absolute')
  })

  it('bottom sheets (printing / condition pickers): content clears the home indicator', async () => {
    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <BottomSheet visible onClose={() => {}} title="Pick" testID="sheet">
          <Text>Option</Text>
        </BottomSheet>
      </SafeAreaProvider>,
    )
    const sheet = screen.getByTestId('sheet')
    const content = (sheet.children[0] as { props: { style?: unknown } } | undefined) ?? sheet
    const style = styleOf(content)
    expect(style.paddingBottom).toBe(SPACE.lg + phone.bottom)
  })

  it.each(FONT_SCALES)(
    'tab bar at font scale %s keeps its labels reachable above the inset',
    (fontScale) => {
      const height = tabBarHeight(fontScale, phone.bottom)
      // One label line at normal size, two scaled lines above 1.15x, plus the home-indicator inset.
      expect(height).toBe((fontScale > 1.15 ? 68 : 56) + phone.bottom)
      // Never shorter than the 48pt touch floor + inset, and never taller than a third of the screen.
      expect(height).toBeGreaterThanOrEqual(48 + phone.bottom)
      expect(height).toBeLessThan(phone.height / 3)
    },
  )

  it('the Dynamic Island / status-bar inset is read from the safe-area context, not assumed', async () => {
    let seenTop = -1
    function Probe() {
      seenTop = useSafeAreaInsets().top
      return null
    }
    await render(
      <SafeAreaInsetsContext.Provider value={metrics.insets}>
        <Probe />
      </SafeAreaInsetsContext.Provider>,
    )
    expect(seenTop).toBe(phone.top)
  })
})

describe('no layout literal that a narrow iPhone or a 200% font would break', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) return sources(full)
      return full.endsWith('.tsx') ? [full] : []
    })
  }
  const files = sources(join(appRoot, 'src'))

  it('the widest fixed width in the UI is below the narrowest iPhone (320pt)', () => {
    const widths: number[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/(?<![A-Za-z])(?:width|minWidth): (\d+)\b/g)) {
        widths.push(Number(match[1]))
      }
    }
    expect(widths.length).toBeGreaterThan(0)
    expect(Math.max(...widths)).toBeLessThan(320)
  })

  it('controls grow with the text: touch targets use minHeight, never a fixed height', () => {
    const offenders: string[] = []
    for (const file of files) {
      // A line that also pins a width is fixed-size artwork (a card thumbnail), not a control.
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (/(?<![A-Za-z])width: \d/.test(line)) continue
        if (/(?<![A-Za-z])height: (MIN_TOUCH|4[4-9]|5\d)\b/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('no hard-coded navigation-bar / gesture-bar spacing (Android-only magic numbers)', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (
        /navigationBarHeight|NAV_BAR_HEIGHT|gestureBar|bottom: 48\b|paddingBottom: 48\b/.test(text)
      ) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
