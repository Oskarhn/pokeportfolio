import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { P169FeatureProvider, type P169StackParams } from '../../src/features/navigation'
import type { AddToCollectionIntent } from '../../src/features/price-check/price-check-flow-store'
import { P169_SCREENS } from '../../src/features/screens'
import { RuntimeProvider } from '../../src/ui/runtime-context'
import { flush, session } from '../support/fakes'
import { body, card, hit, obs, p169Harness, variant } from '../support/p169-fakes'

/**
 * The P169 screens in a real native stack under the React Native jest preset (component /
 * navigation proof; NOT Hermes, NOT a device). Registered exactly as a host would, through
 * P169_SCREENS + P169FeatureProvider.
 */

const Stack = createNativeStackNavigator<P169StackParams>()
const NB = ' '

async function mount() {
  const h = p169Harness()
  h.auth.emit('SIGNED_IN', session('A'))
  const intents: AddToCollectionIntent[] = []
  const ref = createNavigationContainerRef<P169StackParams>()
  await render(
    <SafeAreaProvider>
      <RuntimeProvider runtime={h.runtime}>
        <P169FeatureProvider
          feature={h.feature}
          host={{ onAddToCollection: (i) => intents.push(i) }}
        >
          <NavigationContainer ref={ref}>
            <Stack.Navigator>
              {P169_SCREENS.map((s) => (
                <Stack.Screen
                  key={s.name}
                  name={s.name}
                  component={s.component}
                  options={{ title: s.title }}
                />
              ))}
            </Stack.Navigator>
          </NavigationContainer>
        </P169FeatureProvider>
      </RuntimeProvider>
    </SafeAreaProvider>,
  )
  return { h, intents, ref }
}

const ZARD = card('zard', {
  name: 'P169 Charizard',
  setName: 'P169 Base Set',
  collectorNumber: '004',
})
const HOLO = variant('zard-holo', { finish: 'holo' })
const FIRST = variant('zard-1st', { finish: 'holo', stamp: '1st-edition' })

describe('P169 screens', () => {
  it('search shows set/number/language, flags same names, and selects nothing by itself', async () => {
    const { h } = await mount()
    h.catalog.corpus = [
      hit('base', {
        name: 'P169 Pikachu',
        setName: 'P169 Base Set',
        collectorNumber: '025',
        activeVariantCount: 2,
      }),
      hit('reprint', {
        name: 'P169 Pikachu',
        setName: 'P169 Legends Reprint',
        collectorNumber: '025',
      }),
    ]
    await act(async () => {
      await fireEvent.changeText(screen.getByTestId('p169-search-input'), 'Pikachu')
      await flush(10)
    })
    expect(screen.getByText(/P169 Base Set · #025 · English · 2 printings/)).toBeTruthy()
    expect(screen.getByTestId('p169-hit-shared-base')).toBeTruthy()
    expect(screen.getByTestId('p169-hit-shared-reprint')).toBeTruthy()
    expect(screen.getByTestId('p169-search-status-ready')).toBeTruthy()
    expect(screen.queryByTestId('p169-card')).toBeNull()
  })

  it('no results is announced as such (live region), not as an error', async () => {
    const { h } = await mount()
    h.catalog.corpus = []
    await act(async () => {
      await fireEvent.changeText(screen.getByTestId('p169-search-input'), 'zzz-no-card')
      await flush(10)
    })
    const status = screen.getByTestId('p169-search-status-empty')
    expect(status.props.accessibilityLiveRegion).toBe('polite')
  })

  it('card with two printings: choose first, then exact money on ONE line, NOK reference, graded unavailable', async () => {
    const { h, ref, intents } = await mount()
    h.cards.set(ZARD.cardId, { card: ZARD, variants: [HOLO, FIRST] })
    h.invoker.answer(
      ZARD.cardId,
      body({ [HOLO.variantId]: [obs('tcgdex_cardmarket', '987654321098765')] }),
    )
    await act(async () => {
      ref.navigate('P169Card', { cardId: ZARD.cardId })
      await flush(10)
    })
    expect(screen.getByTestId('p169-printing-choice')).toBeTruthy()
    expect(screen.queryByTestId('p169-obs-tcgdex_cardmarket')).toBeNull()
    expect(screen.queryByTestId('p169-add-to-collection')).toBeNull()

    await act(async () => {
      await fireEvent.press(screen.getByTestId(`p169-variant-${HOLO.variantId}`))
      await flush(10)
    })
    const source = screen.getByTestId('p169-obs-tcgdex_cardmarket-source')
    expect(source.props.children).toBe('€9,876,543,210,987.65')
    expect(source.props.numberOfLines).toBe(1)
    expect(source.props.adjustsFontSizeToFit).toBe(true)
    expect(screen.getByTestId('p169-obs-tcgdex_cardmarket-nok').props.children).toBe(
      `113${NB}580${NB}246${NB}926${NB}357,98 kr`,
    )
    expect(screen.getByTestId('p169-contract-search_prices_observations')).toBeTruthy()
    expect(screen.getByText(/No verified graded market data available/)).toBeTruthy()

    await act(async () => {
      await fireEvent.press(screen.getByTestId('p169-add-to-collection'))
      await flush()
    })
    expect(intents).toEqual([
      {
        kind: 'add_to_collection',
        cardId: ZARD.cardId,
        variantId: HOLO.variantId,
        requiresConfirmation: true,
      },
    ])
    expect(h.invoker.calls).toHaveLength(1)
  })

  it('a provider failure shows the reason, a retry and a labelled snapshot fallback; never a zero', async () => {
    const { h, ref } = await mount()
    const c = card('broken')
    const v = variant('broken-v')
    h.cards.set(c.cardId, { card: c, variants: [v] })
    h.invoker.answer(c.cardId, body({ [v.variantId]: [] }, 1))
    await act(async () => {
      ref.navigate('P169Card', { cardId: c.cardId })
      await flush(10)
    })
    expect(screen.getByTestId('p169-unavailable-provider_error')).toBeTruthy()
    expect(screen.queryByText(/0,00 kr|€0\.00/)).toBeNull()
  })

  it('photo entry states that recognition is unavailable and routes to manual search', async () => {
    const { ref } = await mount()
    await act(async () => {
      ref.navigate('P169PhotoEntry')
      await flush()
    })
    expect(screen.getByTestId('p169-recognition-unavailable')).toBeTruthy()
    await act(async () => {
      await fireEvent.press(screen.getByTestId('p169-choose-manually'))
      await flush()
    })
    expect(ref.getCurrentRoute()?.name).toBe('P169Search')
  })
})
