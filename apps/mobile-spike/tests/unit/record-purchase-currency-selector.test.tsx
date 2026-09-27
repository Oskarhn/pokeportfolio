import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { RuntimeProvider } from '../../src/ui/runtime-context'
import { RecordPurchaseScreen } from '../../src/ui/screens/RecordPurchaseScreen'
import { flush, harness, session } from '../support/fakes'

/**
 * P178 §17: RecordPurchaseScreen used to hardcode `currency: 'NOK'` on its draft, so JPY (the
 * shared money domain's own zero-exponent proof) could never be exercised through the real app —
 * P177's device run found and disclosed this gap. This is the UI-level proof that the new currency
 * selector actually drives the exponent every money field below it uses, through the real
 * `write/money-input.ts` -> `@shared/domain/money` boundary, not a UI-only illusion.
 */

type TestStackParams = { P175RecordPurchase: { cardId: string; variantId: string } }
const Stack = createNativeStackNavigator<TestStackParams>()

async function mount() {
  const h = harness()
  h.auth.emit('SIGNED_IN', session('A'))
  await render(
    <SafeAreaProvider>
      <RuntimeProvider runtime={h.runtime}>
        <NavigationContainer>
          <Stack.Navigator>
            <Stack.Screen
              name="P175RecordPurchase"
              component={RecordPurchaseScreen}
              initialParams={{ cardId: 'v1', variantId: 'v1' }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </RuntimeProvider>
    </SafeAreaProvider>,
  )
  await screen.findByTestId('p175-record-purchase')
}

it('offers all five domain currencies and defaults to NOK', async () => {
  await mount()
  expect(screen.getByTestId('p178-purchase-currency').props.accessibilityLabel).toBe(
    'Currency: NOK',
  )
  await act(async () => {
    await fireEvent.press(screen.getByTestId('p178-purchase-currency'))
    await flush()
  })
  for (const code of ['NOK', 'EUR', 'USD', 'GBP', 'JPY']) {
    expect(screen.getByTestId(`p178-currency-option-${code}`)).toBeTruthy()
  }
})

it('choosing JPY changes the unit-price label and the exponent every field below uses', async () => {
  await mount()
  expect(screen.getByTestId('p175-purchase-unit-price').props.placeholder).toBe('0.00')

  await act(async () => {
    await fireEvent.press(screen.getByTestId('p178-purchase-currency'))
    await flush()
  })
  await act(async () => {
    await fireEvent.press(screen.getByTestId('p178-currency-option-JPY'))
    await flush()
  })

  expect(screen.getByTestId('p178-purchase-currency').props.accessibilityLabel).toBe(
    'Currency: JPY',
  )
  expect(screen.getByTestId('p175-purchase-unit-price').props.placeholder).toBe('0')
})

it('a fractional JPY amount is rejected (no minor unit exists), a whole JPY amount is accepted', async () => {
  await mount()
  await act(async () => {
    await fireEvent.press(screen.getByTestId('p178-purchase-currency'))
    await flush()
  })
  await act(async () => {
    await fireEvent.press(screen.getByTestId('p178-currency-option-JPY'))
    await flush()
  })

  await act(async () => {
    await fireEvent.changeText(screen.getByTestId('p175-purchase-unit-price'), '10.50')
    await flush()
  })
  // The preview total is absent (never a rounded/truncated guess) for an amount JPY cannot represent.
  expect(screen.getByTestId('p175-purchase-total').props.accessibilityLabel).toBe('No value')

  await act(async () => {
    await fireEvent.changeText(screen.getByTestId('p175-purchase-unit-price'), '1500')
    await flush()
  })
  const total = screen.getByTestId('p175-purchase-total')
  // JPY has no minor unit: the exact rendered total must contain no decimal point at all.
  expect(String(total.props.children)).not.toMatch(/\./)
  expect(String(total.props.children)).toBe('1,500 JPY')
})
