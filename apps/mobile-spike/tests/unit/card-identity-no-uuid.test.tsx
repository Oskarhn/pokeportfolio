import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { render, screen } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { cardIdentityLine } from '../../src/ui/card-display-text'
import type { CardDisplaySummary } from '../../src/ui/navigation-types'
import { RuntimeProvider } from '../../src/ui/runtime-context'
import { AddAcquisitionScreen } from '../../src/ui/screens/AddAcquisitionScreen'
import { RecordPurchaseScreen } from '../../src/ui/screens/RecordPurchaseScreen'
import { harness, session } from '../support/fakes'

/**
 * P180 §8: RecordPurchaseScreen (and, identically, AddAcquisitionScreen) used to render
 * `Card variant <uuid> · <uuid>` — internal identifiers leaking into normal product UI. This is
 * the regression guard the mission asks for: no UUID-shaped string may appear in the card-identity
 * line, on either screen, with or without a supplied display summary.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const RAW_CARD_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'
const RAW_VARIANT_ID = 'f0e1d2c3-b4a5-4678-9012-cdef01234567'

const DISPLAY: CardDisplaySummary = {
  name: 'Pikachu',
  setName: 'Base Set',
  collectorNumber: '25',
  languageLabel: 'English',
  printingLabel: 'Holo',
}

describe('cardIdentityLine', () => {
  it('never produces a UUID-shaped string, with a display summary', () => {
    expect(cardIdentityLine(DISPLAY)).not.toMatch(UUID)
    expect(cardIdentityLine(DISPLAY)).toContain('Pikachu')
  })

  it('never produces a UUID-shaped string when no display summary is given', () => {
    expect(cardIdentityLine(undefined)).not.toMatch(UUID)
  })
})

type PurchaseStackParams = {
  P175RecordPurchase: { cardId: string; variantId: string; cardDisplay?: CardDisplaySummary }
}
const PurchaseStack = createNativeStackNavigator<PurchaseStackParams>()

async function mountPurchase(cardDisplay: CardDisplaySummary | undefined) {
  const h = harness()
  h.auth.emit('SIGNED_IN', session('A'))
  await render(
    <SafeAreaProvider>
      <RuntimeProvider runtime={h.runtime}>
        <NavigationContainer>
          <PurchaseStack.Navigator>
            <PurchaseStack.Screen
              name="P175RecordPurchase"
              component={RecordPurchaseScreen}
              initialParams={{ cardId: RAW_CARD_ID, variantId: RAW_VARIANT_ID, cardDisplay }}
            />
          </PurchaseStack.Navigator>
        </NavigationContainer>
      </RuntimeProvider>
    </SafeAreaProvider>,
  )
  await screen.findByTestId('p175-record-purchase')
}

type AcquisitionStackParams = {
  P175AddAcquisition: { cardId: string; variantId: string; cardDisplay?: CardDisplaySummary }
}
const AcquisitionStack = createNativeStackNavigator<AcquisitionStackParams>()

async function mountAcquisition(cardDisplay: CardDisplaySummary | undefined) {
  const h = harness()
  h.auth.emit('SIGNED_IN', session('A'))
  await render(
    <SafeAreaProvider>
      <RuntimeProvider runtime={h.runtime}>
        <NavigationContainer>
          <AcquisitionStack.Navigator>
            <AcquisitionStack.Screen
              name="P175AddAcquisition"
              component={AddAcquisitionScreen}
              initialParams={{ cardId: RAW_CARD_ID, variantId: RAW_VARIANT_ID, cardDisplay }}
            />
          </AcquisitionStack.Navigator>
        </NavigationContainer>
      </RuntimeProvider>
    </SafeAreaProvider>,
  )
  await screen.findByTestId('p175-add-acquisition')
}

describe('RecordPurchaseScreen card identity', () => {
  it('shows the card name, never the raw variant UUID pair', async () => {
    await mountPurchase(DISPLAY)
    const text = String(screen.getByTestId('p180-purchase-card-identity').props.children)
    expect(text).not.toMatch(UUID)
    expect(text).not.toContain(RAW_CARD_ID)
    expect(text).not.toContain(RAW_VARIANT_ID)
    expect(text).toContain('Pikachu')
  })

  it('falls back to a UUID-free sentence when no display summary was passed', async () => {
    await mountPurchase(undefined)
    const text = String(screen.getByTestId('p180-purchase-card-identity').props.children)
    expect(text).not.toMatch(UUID)
    expect(text).not.toContain(RAW_CARD_ID)
    expect(text).not.toContain(RAW_VARIANT_ID)
  })
})

describe('AddAcquisitionScreen card identity', () => {
  it('shows the card name, never the raw variant UUID pair', async () => {
    await mountAcquisition(DISPLAY)
    const text = String(screen.getByTestId('p180-acquisition-card-identity').props.children)
    expect(text).not.toMatch(UUID)
    expect(text).not.toContain(RAW_CARD_ID)
    expect(text).not.toContain(RAW_VARIANT_ID)
    expect(text).toContain('Pikachu')
  })

  it('falls back to a UUID-free sentence when no display summary was passed', async () => {
    await mountAcquisition(undefined)
    const text = String(screen.getByTestId('p180-acquisition-card-identity').props.children)
    expect(text).not.toMatch(UUID)
  })
})
