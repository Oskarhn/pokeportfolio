import { useEffect } from 'react'
import { ScrollView, View } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { Money } from '@shared/domain/money'
import { asCurrencyCode } from '../../price-check/observation-wire'
import { nokMoney, type PriceState } from '../../collection/types'
import {
  Body,
  Button,
  Card,
  EmptyView,
  FailureView,
  Heading,
  Loading,
  MoneyText,
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

  useEffect(() => {
    void holdingDetail.load(holdingId)
  }, [holdingDetail, holdingId])

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
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg }} testID="card-detail">
      <View style={{ gap: SPACE.xs }}>
        <Heading>{d.title}</Heading>
        <Body muted>{d.subtitle}</Body>
      </View>
      <Card>
        <Body muted>Value of this holding</Body>
        <MoneyText testID="detail-holding-value" emphasis value={nokMoney(d.holdingValueMinor)} />
        <Body muted testID="detail-price-state">
          {PRICE_STATE_LABEL[d.priceState]}
        </Body>
        {d.unitValueMinor !== null ? (
          <>
            <Body muted>Per card</Body>
            <MoneyText testID="detail-unit-value" value={nokMoney(d.unitValueMinor)} />
          </>
        ) : null}
      </Card>
      {d.provider !== null ? (
        <Card testID="detail-provenance">
          <Body muted>Where this number comes from</Body>
          <Body>
            {d.provider === 'tcgdex_cardmarket'
              ? 'Cardmarket via TCGdex'
              : d.provider === 'tcgdex_tcgplayer'
                ? 'TCGplayer via TCGdex'
                : d.provider}
          </Body>
          {source !== null ? <MoneyText testID="detail-source-value" value={source} /> : null}
          {d.snapshotDate !== null ? <Body muted>Snapshot {d.snapshotDate}</Body> : null}
        </Card>
      ) : null}
      <Card>
        <Body>
          {d.quantity} owned {'·'} {d.lotCount} {d.lotCount === 1 ? 'lot' : 'lots'}
          {d.condition !== null ? ` · ${d.condition}` : ''}
          {d.finish !== null ? ` · ${d.finish}` : ''}
        </Body>
      </Card>
      <Button
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
      <Button
        testID="record-sale"
        label="Record sale"
        variant="secondary"
        onPress={() => navigation.navigate('RecordSale', { holdingId })}
      />
      <Button
        testID="record-opening"
        label="Record opening"
        variant="secondary"
        onPress={() => navigation.navigate('RecordOpening', { holdingId })}
      />
      <Button
        testID="manual-valuation"
        label="Manual valuation"
        variant="secondary"
        onPress={() => navigation.navigate('ManualValuation', { holdingId })}
      />
    </ScrollView>
  )
}
