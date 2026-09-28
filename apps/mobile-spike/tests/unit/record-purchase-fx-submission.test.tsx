import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import type { FxRateReader } from '../../src/features/price-check/fx-source'
import type { LeasedWriteDb } from '../../src/write/leased-write-client'
import { RuntimeProvider } from '../../src/ui/runtime-context'
import { RecordPurchaseScreen } from '../../src/ui/screens/RecordPurchaseScreen'
import { flush, harness, session } from '../support/fakes'

/**
 * P180 mission §4/§5: two guarantees no unit test elsewhere in this repo checks end to end through
 * a real screen submission —
 *   1. the ENTERED, source-currency amount reaches `create_purchase` unchanged; the NOK reference
 *      shown next to it is presentation-only and never overwrites what gets sent.
 *   2. a non-NOK purchase is fail-closed: the RPC is never even called while no usable FX rate is
 *      loaded, regardless of what the person typed.
 */

interface RpcCall {
  name: string
  params: Record<string, unknown>
}

function scriptedDb(): { db: () => LeasedWriteDb; calls: RpcCall[] } {
  const calls: RpcCall[] = []
  const builder = {
    select: () => builder,
    single: () => builder,
    overrideTypes: () => builder,
    then: (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve({
        data: {
          id: 'purchase-1',
          purchased_on: '2026-09-28',
          currency: 'EUR',
          subtotal_minor: '4500',
          shipping_minor: '0',
          customs_minor: '0',
          discount_minor: '0',
          total_minor: '4500',
          total_nok_minor: '51750',
          notes: null,
        },
        error: null,
      }).then(onFulfilled),
  }
  const db = {
    rpc: (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params })
      return builder
    },
  } as unknown as LeasedWriteDb
  return { db: () => db, calls }
}

type TestStackParams = { P175RecordPurchase: { cardId: string; variantId: string } }
const Stack = createNativeStackNavigator<TestStackParams>()

async function mount(readFx: FxRateReader, writeDb: () => LeasedWriteDb) {
  const h = harness({ readFx, writeDb })
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

function confirmDisabled(): boolean {
  const state = screen.getByTestId('p175-confirm-purchase').props as {
    accessibilityState?: { disabled?: boolean }
  }
  return state.accessibilityState?.disabled === true
}

async function chooseEur() {
  await act(async () => {
    await fireEvent.press(screen.getByTestId('p178-purchase-currency'))
    await flush()
  })
  await act(async () => {
    await fireEvent.press(screen.getByTestId('p178-currency-option-EUR'))
    await flush()
  })
}

it('sends the entered EUR amount to create_purchase — never the NOK reference', async () => {
  const { db, calls } = scriptedDb()
  await mount(
    () => Promise.resolve({ data: { rate: '11.5', rate_date: '2026-09-27' }, error: null }),
    db,
  )
  await chooseEur()
  await act(async () => {
    await fireEvent.changeText(screen.getByTestId('p175-purchase-unit-price'), '45.00')
    await flush()
  })
  await act(async () => {
    await fireEvent.changeText(screen.getByTestId('p175-purchase-quantity'), '1')
    await flush()
  })
  await act(async () => {
    await fireEvent.press(screen.getByTestId('p175-confirm-purchase'))
    await flush()
  })

  const call = calls.find((c) => c.name === 'create_purchase')
  expect(call).toBeDefined()
  expect(call?.params.p_currency).toBe('EUR')
  // The line's own unit price is the ENTERED 45.00 EUR (4500 minor units) — never the ~517.50 NOK
  // reference the screen shows next to it.
  const lines = call?.params.p_lines as { unit_price_minor: string }[]
  expect(lines[0]?.unit_price_minor).toBe('4500')
  expect(call?.params.p_fx_rate_to_nok).toBe('11.5')
  expect(call?.params.p_fx_source).toBe('norges_bank')
})

it('never calls create_purchase while the FX rate is missing — fails closed', async () => {
  const { db, calls } = scriptedDb()
  await mount(() => Promise.resolve({ data: null, error: null }), db)
  await chooseEur()
  await act(async () => {
    await fireEvent.changeText(screen.getByTestId('p175-purchase-unit-price'), '45.00')
    await flush()
  })
  expect(confirmDisabled()).toBe(true)
  await act(async () => {
    await fireEvent.press(screen.getByTestId('p175-confirm-purchase'))
    await flush()
  })
  expect(calls.find((c) => c.name === 'create_purchase')).toBeUndefined()
})

it('never calls create_purchase while the FX read failed — fails closed', async () => {
  const { db, calls } = scriptedDb()
  await mount(() => Promise.reject(new Error('network request failed')), db)
  await chooseEur()
  await act(async () => {
    await fireEvent.changeText(screen.getByTestId('p175-purchase-unit-price'), '45.00')
    await flush()
  })
  await act(async () => {
    await fireEvent.press(screen.getByTestId('p175-confirm-purchase'))
    await flush()
  })
  expect(calls.find((c) => c.name === 'create_purchase')).toBeUndefined()
})

it('NOK never waits on a rate: create_purchase is reachable immediately', async () => {
  const { db } = scriptedDb()
  await mount(() => Promise.reject(new Error('should never be called for NOK')), db)
  await act(async () => {
    await fireEvent.changeText(screen.getByTestId('p175-purchase-unit-price'), '45.00')
    await flush()
  })
  expect(confirmDisabled()).toBe(false)
})
