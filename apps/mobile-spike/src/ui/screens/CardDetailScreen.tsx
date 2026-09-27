import { useCallback } from 'react'
import { View } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { Money } from '@shared/domain/money'
import { asCurrencyCode } from '../../price-check/observation-wire'
import { nokMoney, type PriceState } from '../../collection/types'
import {
  AppScreen,
  Body,
  CardArtwork,
  EmptyView,
  FailureView,
  Heading,
  Loading,
  MoneyText,
  PriceBlock,
  ProviderBadge,
  SecondaryButton,
  Surface,
  providerLabelForCode,
} from '../components'
import type { CollectionStackParams } from '../navigation-types'
import { useRuntime, useStore } from '../runtime-context'
import { SPACE } from '../theme'

type Props = NativeStackScreenProps<CollectionStackParams, 'CardDetail'>

const PRICE_STATE_LABEL: Record<PriceState, string> = {
  manual: 'Manual valuation',
  fresh: 'Market price',
  stale: 'Market price (out of date)',
  missing: 'No value available',
}

function sourceMoney(currency: string | null, minor: bigint | null): Money | null {
  if (currency === null || minor === null) return null
  const code = asCurrencyCode(currency)
  return code === null ? null : { minorUnits: minor, currency: code }
}

export function CardDetailScreen({ route, navigation }: Props) {
  const { holdingId } = route.params
  const { holdingDetail } = useRuntime()
  const state = useStore(holdingDetail)

  // Reloads on every FOCUS, not just when holdingId changes: P175's Record sale / Record opening /
  // Manual valuation all write to this exact holding and navigate back here (same holdingId) — a
  // plain effect never re-ran, so this screen kept showing the value/price-state from before the
  // write (found by P177's device driver: manual value written and readable in the database, but
  // still "No value available" on screen after Confirm -> Back).
  useFocusEffect(
    useCallback(() => {
      void holdingDetail.load(holdingId)
    }, [holdingDetail, holdingId]),
  )

  if (state.holdingId !== holdingId || state.status === 'loading' || state.status === 'idle') {
    return <Loading label="Loading card" />
  }
  if (state.status === 'error' && state.failure !== null) {
    return (
      <FailureView failure={state.failure} onRetry={() => void holdingDetail.load(holdingId)} />
    )
  }
  if (state.status === 'not_found' || state.detail === null) {
    return <EmptyView title="Not found" detail="This holding is not in your collection." />
  }

  const d = state.detail
  const source = sourceMoney(d.sourceCurrency, d.sourceValueMinor)
  return (
    <AppScreen testID="card-detail">
      <View style={{ flexDirection: 'row', gap: SPACE.md, alignItems: 'flex-start' }}>
        <CardArtwork size="lg" finish={d.finish} />
        <View style={{ flex: 1, gap: SPACE.xs }}>
          <Heading>{d.title}</Heading>
          <Body muted>{d.subtitle}</Body>
        </View>
      </View>
      <Surface>
        <PriceBlock
          label="Value of this holding"
          value={nokMoney(d.holdingValueMinor)}
          state={d.priceState}
          stateLabel={PRICE_STATE_LABEL[d.priceState]}
          unitValue={d.unitValueMinor !== null ? nokMoney(d.unitValueMinor) : undefined}
          testID="detail-holding-value"
          stateTestID="detail-price-state"
          unitTestID="detail-unit-value"
        />
      </Surface>
      {d.provider !== null ? (
        <Surface testID="detail-provenance">
          <Body muted>Where this number comes from</Body>
          <ProviderBadge label={providerLabelForCode(d.provider)} />
          {source !== null ? <MoneyText testID="detail-source-value" value={source} /> : null}
          {d.snapshotDate !== null ? <Body muted>Snapshot {d.snapshotDate}</Body> : null}
        </Surface>
      ) : null}
      <Surface>
        <Body>
          {d.quantity} owned {'·'} {d.lotCount} {d.lotCount === 1 ? 'lot' : 'lots'}
          {d.condition !== null ? ` · ${d.condition}` : ''}
          {d.finish !== null ? ` · ${d.finish}` : ''}
        </Body>
      </Surface>
      <View style={{ flexDirection: 'row', gap: SPACE.md }}>
        <View style={{ flex: 1 }}>
          <SecondaryButton
            testID="check-price"
            label="Check price"
            disabled={d.cardVariantId === null}
            accessibilityHint="Looks up the current price of this exact card variant. Read-only."
            onPress={() => {
              if (d.cardVariantId === null) return
              // Reset the Search stack to the resolver so Back leaves for the tab this came from
              // (Card detail) instead of stepping through whatever the Search stack held.
              navigation.getParent()?.navigate('SearchTab', {
                state: {
                  index: 0,
                  routes: [{ name: 'P170VariantEntry', params: { variantId: d.cardVariantId } }],
                },
              })
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <SecondaryButton
            testID="record-sale"
            label="Record a sale"
            onPress={() => navigation.navigate('RecordSale', { holdingId })}
          />
        </View>
      </View>
      <SecondaryButton
        testID="record-opening"
        label="Record opening"
        onPress={() => navigation.navigate('RecordOpening', { holdingId })}
      />
      <SecondaryButton
        testID="manual-valuation"
        label="Manual valuation"
        onPress={() => navigation.navigate('ManualValuation', { holdingId })}
      />
    </AppScreen>
  )
}
