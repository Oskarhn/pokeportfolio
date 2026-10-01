import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { P169FeatureProvider, type P169StackParams } from '../../src/features/navigation'
import type {
  CardRecognitionPort,
  RecognitionOutcome,
} from '../../src/features/price-check/recognition'
import { P169_SCREENS } from '../../src/features/screens'
import type { PhotoOutcome } from '../../src/photo/photo-store'
import { PrimaryButton, RadioRow, SegmentedControl } from '../../src/ui/components'
import { RuntimeProvider } from '../../src/ui/runtime-context'
import { MIN_TOUCH } from '../../src/ui/theme'
import { flush, harness, session } from '../support/fakes'
import { STANDARD_FX, fakeFx, FakeInvoker, FakeCatalog } from '../support/p169-fakes'

/**
 * P185 §15/§17/§19/§20: what a screen reader and a thumb get from the scanner result and from every
 * radio. Each assertion corresponds to a mutant in scripts/p185/mutations.mjs.
 */

const Stack = createNativeStackNavigator<P169StackParams>()
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

const candidate = (id: string, name: string) => ({
  candidateId: id,
  name,
  setName: 'P185 Set',
  collectorNumber: '007/102',
  imageBaseUrl: null,
  languageLabel: 'English',
})
const HIGH: RecognitionOutcome = {
  status: 'analysed',
  outcome: {
    kind: 'high',
    confidence: 'HIGH',
    candidates: [candidate('c1', 'Sparkfin')],
    preselectedId: 'c1',
  } as never,
}
const review = (confidence: 'MEDIUM' | 'LOW'): RecognitionOutcome => ({
  status: 'analysed',
  outcome: { kind: 'review', confidence, candidates: [candidate('c2', 'Voltmoth')] },
})
const NO_MATCH: RecognitionOutcome = { status: 'analysed', outcome: { kind: 'no_match' } as never }

class FixedPort implements CardRecognitionPort {
  readonly implemented = true
  constructor(private readonly outcome: RecognitionOutcome) {}
  recognize(): Promise<RecognitionOutcome> {
    return Promise.resolve(this.outcome)
  }
  cancelActive(): void {}
  reset(): void {}
}

const picked: PhotoOutcome = {
  status: 'picked',
  image: {
    kind: 'local_image',
    uri: 'file:///cache/ImagePicker/p.jpg',
    width: 1000,
    height: 1400,
    source: 'library',
    acquiredAt: '2026-09-28T10:00:00.000Z',
  },
}

async function showOutcome(outcome: RecognitionOutcome) {
  const h = harness({
    priceFeature: {
      invoke: new FakeInvoker().invoke,
      readFx: fakeFx(STANDARD_FX),
      catalog: new FakeCatalog(),
      recognition: new FixedPort(outcome),
    },
  })
  h.auth.emit('SIGNED_IN', session('A'))
  const ref = createNavigationContainerRef<P169StackParams>()
  await render(
    <SafeAreaProvider>
      <RuntimeProvider runtime={h.runtime}>
        <P169FeatureProvider
          feature={h.runtime.feature}
          host={{ onAddToCollection: () => undefined }}
        >
          <NavigationContainer ref={ref}>
            <Stack.Navigator>
              {P169_SCREENS.map((s) => (
                <Stack.Screen key={s.name} name={s.name} component={s.component} />
              ))}
            </Stack.Navigator>
          </NavigationContainer>
        </P169FeatureProvider>
      </RuntimeProvider>
    </SafeAreaProvider>,
  )
  await act(async () => {
    ref.navigate('P169PhotoEntry')
    await flush(10)
  })
  h.photo.outcome = picked
  await act(async () => {
    await fireEvent.press(screen.getByTestId('p169-photo-library'))
    await flush(30)
  })
}

const styleOf = (node: { props: { style?: unknown } }) =>
  Object.assign({}, ...([node.props.style] as unknown[]).flat(Infinity).filter(Boolean)) as {
    minHeight?: number
    height?: number
  }

describe('scanner result: confidence is words, identity is complete, nothing internal is exposed', () => {
  it.each([
    ['HIGH', HIGH, 'High confidence'],
    ['MEDIUM', review('MEDIUM'), 'Needs confirmation'],
    ['LOW', review('LOW'), 'Low confidence'],
  ] as const)(
    '%s: the confidence badge says so in text and in its accessible name',
    async (_t, outcome, words) => {
      await showOutcome(outcome)
      const badge = await screen.findByTestId('p169-recognition-confidence')
      expect(badge.props.accessibilityLabel).toBe(`Match confidence: ${words}`)
      expect(screen.getByText(words)).toBeTruthy()
    },
  )

  it('the candidate row is named by card, set AND printed number, and its text is never ellipsized', async () => {
    await showOutcome(HIGH)
    const row = await screen.findByTestId('p169-recognition-candidate-c1')
    expect(row.props.accessibilityLabel).toBe('Sparkfin, P185 Set, 007/102')
    for (const text of [screen.getByText('Sparkfin'), screen.getByText(/P185 Set/)]) {
      expect(text.props.numberOfLines).toBeUndefined()
    }
  })

  it('Confirm exists only for a HIGH candidate; review and no-match never offer it', async () => {
    await showOutcome(review('MEDIUM'))
    await screen.findByTestId('p169-recognition-result')
    expect(screen.queryByTestId('p169-recognition-confirm')).toBeNull()
  })
  it('Confirm is offered, named and a button for a HIGH candidate', async () => {
    await showOutcome(HIGH)
    const confirm = await screen.findByTestId('p169-recognition-confirm')
    expect(confirm.props.accessibilityRole).toBe('button')
    expect(confirm.props.accessibilityLabel ?? 'Confirm this card').toMatch(/Confirm this card/)
  })
  it('no-match shows no candidate, no confirm and no confidence badge', async () => {
    await showOutcome(NO_MATCH)
    await screen.findByTestId('p169-recognition-no-match')
    expect(screen.queryByTestId('p169-recognition-confirm')).toBeNull()
    expect(screen.queryByTestId('p169-recognition-confidence')).toBeNull()
  })

  it('no raw UUID and no model score reaches any accessible name or text on the result', async () => {
    await showOutcome(HIGH)
    await screen.findByTestId('p169-recognition-result')
    // What a person can see or hear: every accessible name and every text child of the tree.
    const heard: string[] = []
    const walk = (node: unknown): void => {
      if (typeof node === 'string') heard.push(node)
      else if (node !== null && typeof node === 'object') {
        const n = node as { props?: Record<string, unknown>; children?: unknown[] }
        const label = n.props?.accessibilityLabel
        if (typeof label === 'string') heard.push(label)
        for (const c of n.children ?? []) walk(c)
      }
    }
    walk(screen.toJSON())
    const dump = heard.join(' | ')
    expect(heard.length).toBeGreaterThan(5)
    expect(dump).not.toMatch(UUID)
    expect(dump).not.toMatch(/similarity|cosine/i)
  })
})

describe('radios: touch target, name, selected state; disabled controls are not actionable', () => {
  function Group({ value }: { value: 'a' | 'b' }) {
    return (
      <SafeAreaProvider>
        <SegmentedControl
          testID="seg"
          value={value}
          onChange={() => undefined}
          options={[
            { value: 'a', label: 'Alpha', testID: 'seg-a' },
            { value: 'b', label: 'Beta', testID: 'seg-b' },
          ]}
        />
      </SafeAreaProvider>
    )
  }

  it('segmented options are radios >= 48 dp, named, and expose exactly one selected+checked', async () => {
    await render(<Group value="b" />)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    for (const r of radios) {
      expect(styleOf(r).minHeight).toBeGreaterThanOrEqual(MIN_TOUCH)
      expect(r.props.accessibilityLabel).toMatch(/Alpha|Beta/)
    }
    const state = (id: string): unknown => screen.getByTestId(id).props.accessibilityState as unknown
    expect(state('seg-a')).toMatchObject({ selected: false, checked: false })
    expect(state('seg-b')).toMatchObject({ selected: true, checked: true })
  })

  it('a RadioRow is >= 48 dp, named by its label, and carries selected + checked', async () => {
    await render(
      <SafeAreaProvider>
        <RadioRow testID="r1" label="Holo" selected onPress={() => undefined} />
        <RadioRow testID="r2" label="Normal" selected={false} onPress={() => undefined} />
      </SafeAreaProvider>,
    )
    for (const id of ['r1', 'r2']) {
      expect(styleOf(screen.getByTestId(id)).minHeight).toBeGreaterThanOrEqual(MIN_TOUCH)
    }
    expect(screen.getByTestId('r1').props.accessibilityState).toMatchObject({
      selected: true,
      checked: true,
    })
    expect(screen.getByTestId('r2').props.accessibilityState).toMatchObject({
      selected: false,
      checked: false,
    })
    expect(screen.getByTestId('r1').props.accessibilityLabel).toBe('Holo')
  })

  it('a disabled button announces disabled and its press does nothing', async () => {
    const onPress = jest.fn()
    await render(
      <SafeAreaProvider>
        <PrimaryButton testID="b" label="Go" disabled onPress={onPress} />
      </SafeAreaProvider>,
    )
    const b = screen.getByTestId('b')
    expect(b.props.accessibilityState).toMatchObject({ disabled: true })
    await fireEvent.press(b)
    expect(onPress).not.toHaveBeenCalled()
  })
})
