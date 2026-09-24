import { useEffect } from 'react'
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { resolveVariant, variantLabel } from '../../price-check/resolve-variant'
import type { PriceLookup, PriceObservationView, UnavailableReason } from '../../price-check/types'
import { MIN_QUERY_LENGTH } from '../../state/price-check-store'
import {
  Badge,
  Body,
  Button,
  Card,
  EmptyView,
  FailureView,
  Heading,
  Loading,
  MoneyText,
} from '../components'
import type { PriceCheckStackParams } from '../navigation-types'
import { useRuntime, useStore } from '../runtime-context'
import { MIN_TOUCH, SPACE, usePalette } from '../theme'

const UNAVAILABLE_TEXT: Record<UnavailableReason, string> = {
  no_variant_price: 'No price is available for this variant.',
  provider_error: 'The price provider had a problem. Try again later.',
  rate_limited: 'The price provider is limiting requests. Try again later.',
  not_found: 'This card or variant could not be found.',
  graded_source_not_configured: 'Graded prices are not available.',
}

function SourceBanner() {
  const { priceCheck } = useRuntime()
  useStore(priceCheck)
  const synthetic = priceCheck.sourceKind === 'p153_fixture'
  return (
    <View style={{ gap: SPACE.xs }} testID="source-banner">
      {synthetic ? <Badge label="SYNTHETIC FIXTURE — not market data" /> : null}
      <Body muted>
        {synthetic
          ? 'Price source: synthetic fixture shaped like the P153 response.'
          : 'Price source: price snapshots stored in the local database.'}
      </Body>
    </View>
  )
}

/** ---- Home: search ---- */
export function PriceCheckHomeScreen({
  navigation,
}: NativeStackScreenProps<PriceCheckStackParams, 'PriceCheckHome'>) {
  const { priceCheck, ports } = useRuntime()
  const state = useStore(priceCheck)
  const p = usePalette()
  const canSearch = state.query.trim().length >= MIN_QUERY_LENGTH

  return (
    <View style={{ flex: 1, padding: SPACE.lg, gap: SPACE.md }} testID="price-check-home">
      <Body muted>Read-only. Checking a price never adds anything to your collection.</Body>
      <SourceBanner />
      <TextInput
        testID="pc-query"
        accessibilityLabel="Search cards"
        value={state.query}
        onChangeText={(text) => priceCheck.setQuery(text)}
        onSubmitEditing={() => void priceCheck.search()}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Card name"
        placeholderTextColor={p.muted}
        style={{
          minHeight: MIN_TOUCH,
          borderWidth: 1,
          borderColor: p.border,
          borderRadius: 10,
          paddingHorizontal: SPACE.md,
          color: p.text,
          backgroundColor: p.surface,
          fontSize: 16,
        }}
      />
      <View style={{ flexDirection: 'row', gap: SPACE.sm, flexWrap: 'wrap' }}>
        <Button
          testID="pc-search"
          label="Search"
          disabled={!canSearch}
          onPress={() => void priceCheck.search()}
        />
        <Button
          testID="pc-toggle-source"
          variant="secondary"
          label={
            priceCheck.sourceKind === 'p153_fixture'
              ? 'Use local snapshots'
              : 'Use synthetic fixture'
          }
          onPress={() =>
            priceCheck.useSource(
              priceCheck.sourceKind === 'p153_fixture' ? ports.released : ports.fixture,
            )
          }
        />
        <Button
          testID="pc-photo"
          variant="secondary"
          label="Photo (spike)"
          onPress={() => navigation.navigate('PhotoSpike')}
        />
      </View>
      {state.search.status === 'loading' ? <Loading label="Searching" /> : null}
      {state.search.status === 'error' && state.search.failure !== null ? (
        <FailureView failure={state.search.failure} onRetry={() => void priceCheck.search()} />
      ) : null}
      {state.search.status === 'empty' ? <EmptyView title="No matching cards" /> : null}
      <FlatList
        data={state.search.hits}
        keyExtractor={(hit) => hit.cardId}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <Pressable
            testID={`hit-${item.cardId}`}
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${item.setName}, number ${item.collectorNumber}`}
            onPress={() => navigation.navigate('PriceCheckResult', { cardId: item.cardId })}
            style={{
              minHeight: MIN_TOUCH + 12,
              justifyContent: 'center',
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: p.border,
              paddingVertical: SPACE.sm,
            }}
          >
            <Text style={{ color: p.text, fontSize: 16, fontWeight: '600' }}>{item.name}</Text>
            <Text style={{ color: p.muted, fontSize: 13 }}>
              {item.setName} {'·'} #{item.collectorNumber} {'·'} {item.language.toUpperCase()} {'·'}{' '}
              {item.variantCount} {item.variantCount === 1 ? 'variant' : 'variants'}
            </Text>
          </Pressable>
        )}
      />
    </View>
  )
}

/** ---- Result ---- */
function ObservationCard({ o }: { o: PriceObservationView }) {
  return (
    <Card testID={`obs-${o.provider}`}>
      {o.synthetic ? <Badge label="SYNTHETIC" /> : null}
      <Body>{o.providerLabel}</Body>
      <Body muted>{o.metricLabel}</Body>
      {o.source !== null ? (
        <MoneyText testID={`obs-${o.provider}-source`} emphasis value={o.source} />
      ) : null}
      {o.nok !== null ? (
        <View>
          <Body muted>
            {o.source !== null ? 'NOK reference' : 'In NOK (converted by the server)'}
          </Body>
          <MoneyText testID={`obs-${o.provider}-nok`} emphasis={o.source === null} value={o.nok} />
        </View>
      ) : null}
      <Body muted>
        {o.observedAt !== null ? `Observed ${o.observedAt}` : 'Observation time not provided'}
      </Body>
      <Body muted>Condition: {o.condition ?? 'not specified by the source'}</Body>
      <Body muted>{o.basisNote}</Body>
    </Card>
  )
}

function PriceSection({ lookup }: { lookup: PriceLookup }) {
  if (lookup.status === 'unavailable') {
    return (
      <Card testID="price-unavailable">
        <Body>{UNAVAILABLE_TEXT[lookup.reason]}</Body>
      </Card>
    )
  }
  return (
    <View style={{ gap: SPACE.md }} testID="price-observations">
      {lookup.observations.map((o) => (
        <ObservationCard key={`${o.provider}:${o.metric ?? 'none'}`} o={o} />
      ))}
    </View>
  )
}

export function PriceCheckResultScreen({
  route,
}: NativeStackScreenProps<PriceCheckStackParams, 'PriceCheckResult'>) {
  const { cardId, variantId } = route.params
  const { priceCheck } = useRuntime()
  const state = useStore(priceCheck)

  useEffect(() => {
    if (cardId !== undefined) void priceCheck.openCard(cardId, variantId)
    else if (variantId !== undefined) void priceCheck.openVariant(variantId)
  }, [priceCheck, cardId, variantId])

  if (state.card.status === 'idle' || state.card.status === 'loading')
    return <Loading label="Loading card" />
  if (state.card.status === 'error' && state.card.failure !== null) {
    return (
      <FailureView
        failure={state.card.failure}
        onRetry={() => {
          if (cardId !== undefined) void priceCheck.openCard(cardId, variantId)
          else if (variantId !== undefined) void priceCheck.openVariant(variantId)
        }}
      />
    )
  }
  if (state.card.status === 'not_found' || state.card.data === null) {
    return <EmptyView title="Card not found" detail="It may have been removed from the catalog." />
  }

  const { card, variants } = state.card.data
  const resolution = state.resolution ?? resolveVariant(variants, undefined)
  return (
    <ScrollView
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg }}
      testID="price-check-result"
    >
      <View style={{ gap: SPACE.xs }}>
        <Heading>{card.name}</Heading>
        <Body muted>
          {card.setName} {'·'} #{card.collectorNumber} {'·'} {card.language.toUpperCase()}
        </Body>
      </View>
      <SourceBanner />

      {resolution.status === 'confirmed' ? (
        <>
          <Card testID="variant-confirmed">
            <Body muted>{resolution.basis === 'only_variant' ? 'Only variant' : 'Variant'}</Body>
            <Body>{variantLabel(resolution.variant)}</Body>
          </Card>
          {state.lookup.status === 'loading' ? <Loading label="Looking up the price" /> : null}
          {state.lookup.status === 'error' && state.lookup.failure !== null ? (
            <FailureView
              failure={state.lookup.failure}
              onRetry={() => void priceCheck.retryLookup()}
            />
          ) : null}
          {state.lookup.status === 'ready' && state.lookup.result !== null ? (
            <PriceSection lookup={state.lookup.result} />
          ) : null}
          {variants.length > 1 ? (
            <View style={{ gap: SPACE.sm }}>
              <Body muted>Other variants</Body>
              {variants
                .filter((v) => v.variantId !== resolution.variant.variantId)
                .map((v) => (
                  <Button
                    key={v.variantId}
                    testID={`variant-${v.variantId}`}
                    variant="secondary"
                    label={variantLabel(v)}
                    onPress={() => void priceCheck.chooseVariant(v.variantId)}
                  />
                ))}
            </View>
          ) : null}
        </>
      ) : null}

      {resolution.status === 'choice_required' || resolution.status === 'mismatch' ? (
        <Card testID="variant-choice">
          <Heading>Choose the variant</Heading>
          <Body muted>
            {resolution.status === 'mismatch'
              ? 'The requested variant does not belong to this card. Nothing is guessed: pick one.'
              : 'This card has several variants with different prices. No price is shown until you choose one.'}
          </Body>
          {resolution.variants.map((v) => (
            <Button
              key={v.variantId}
              testID={`variant-${v.variantId}`}
              variant="secondary"
              label={variantLabel(v)}
              onPress={() => void priceCheck.chooseVariant(v.variantId)}
            />
          ))}
        </Card>
      ) : null}

      {resolution.status === 'no_variants' ? (
        <EmptyView title="No variants" detail="This card has no variant to price." />
      ) : null}

      <Card testID="graded-section">
        <Body>Graded prices</Body>
        <Body muted testID="graded-unavailable">
          Not available. No authorized graded price source is connected, and a graded price is never
          derived from a raw one.
        </Body>
      </Card>
    </ScrollView>
  )
}
