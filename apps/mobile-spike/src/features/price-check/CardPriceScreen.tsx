import { useEffect } from 'react'
import { View } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import {
  AppScreen,
  Badge,
  FilterChip,
  FreshnessBadge,
  Heading,
  InlineNotice,
  Loading,
  ProviderBadge,
  RadioRow,
  SegmentedControl,
} from '../../ui/components'
import { useStore } from '../../ui/runtime-context'
import { SPACE } from '../../ui/theme'
import { useP169, type P169StackParams } from '../navigation'
import { ActionButton, ExactMoney, Label, LiveStatus, Section } from '../ui/kit'
import type { ObservationRow, PriceCheckResult, SnapshotHeadline } from './model'
import { languageLabel, variantLabel } from './p165-domain/price-check/identity'
import type { VariantIdentity } from './p165-domain/price-check/types'
import {
  CONTRACT_COPY,
  FAILURE_COPY,
  FRESHNESS_COPY,
  KIND_COPY,
  UNAVAILABLE_COPY,
  ageText,
  droppedText,
  fetchedText,
  nokText,
  observationLabel,
  observedText,
} from './price-copy'

function printingLabel(v: VariantIdentity): string {
  return `${variantLabel(v)}${v.isActive ? '' : ' (no longer active in the catalog)'}`
}

function ObservationCard({ row }: { row: ObservationRow }) {
  const o = row.observation
  const id = `p169-obs-${o.provider}`
  return (
    <Section testID={id}>
      <View accessible accessibilityLabel={observationLabel(row)} style={{ gap: SPACE.xs }}>
        {o.synthetic ? <Badge label="SYNTHETIC — not market data" /> : null}
        <View style={{ flexDirection: 'row', gap: SPACE.xs, flexWrap: 'wrap' }}>
          <ProviderBadge label={o.providerLabel} />
          <FreshnessBadge label={FRESHNESS_COPY[row.freshness]} freshness={row.freshness} />
        </View>
        <Label muted>
          {o.metricLabel} · {KIND_COPY[o.kind]}
        </Label>
        <ExactMoney testID={`${id}-source`} value={o.price} size="headline" />
        {row.nok.status === 'converted' ? (
          <ExactMoney testID={`${id}-nok`} value={row.nok.nok} />
        ) : null}
        <Label muted testID={`${id}-nok-note`}>
          {nokText(row)}
        </Label>
        <Label muted testID={`${id}-observed`}>
          {observedText(o.observedAt, row.ageDays, row.freshness)}
        </Label>
        <Label muted>Condition: {o.condition ?? 'not specified by the source'}</Label>
        <Label muted>{o.basisNote}</Label>
      </View>
    </Section>
  )
}

function SnapshotCard({ h }: { h: SnapshotHeadline }) {
  const id = `p169-snap-${h.provider}`
  return (
    <Section testID={id}>
      <View style={{ flexDirection: 'row', gap: SPACE.xs, flexWrap: 'wrap' }}>
        <ProviderBadge label={h.providerLabel} />
        <FreshnessBadge label={FRESHNESS_COPY[h.freshness]} freshness={h.freshness} />
      </View>
      <Label muted>Stored snapshot in NOK (converted by the server)</Label>
      <ExactMoney testID={`${id}-nok`} value={h.nok} size="headline" />
      <Label muted testID={`${id}-date`}>
        Snapshot {h.snapshotDate}
        {h.ageDays === null ? '' : ` (${ageText(h.ageDays)})`} · {FRESHNESS_COPY[h.freshness]}
      </Label>
      <Label muted>Original currency, amount and metric: not reported by this source</Label>
    </Section>
  )
}

function RawSection({ result }: { result: PriceCheckResult }) {
  const raw = result.raw
  const dropped = raw.status === 'snapshot' ? null : droppedText(raw.dropped)
  return (
    <View style={{ gap: SPACE.md }} testID={`p169-raw-${raw.status}`}>
      <LiveStatus testID={`p169-contract-${raw.contract}`}>
        {CONTRACT_COPY[raw.contract]}
      </LiveStatus>
      <Label muted testID="p169-fetched">
        {fetchedText(raw.fetchedAt, raw.fromCache)}
      </Label>
      {raw.status === 'unavailable' ? (
        <Section testID={`p169-unavailable-${raw.reason}`}>
          <LiveStatus>{UNAVAILABLE_COPY[raw.reason]}</LiveStatus>
        </Section>
      ) : null}
      {raw.status === 'observations'
        ? raw.rows.map((row) => (
            <ObservationCard
              key={`${row.observation.provider}:${row.observation.metric}`}
              row={row}
            />
          ))
        : null}
      {raw.status === 'snapshot'
        ? raw.headlines.map((h) => <SnapshotCard key={h.provider} h={h} />)
        : null}
      {dropped !== null ? (
        <Label muted testID="p169-dropped">
          {dropped}
        </Label>
      ) : null}
    </View>
  )
}

export function CardPriceScreen({
  route,
  navigation,
}: NativeStackScreenProps<P169StackParams, 'P169Card'>) {
  const { cardId, variantId } = route.params
  const { feature, host } = useP169()
  const store = feature.priceCheck
  const state = useStore(store)

  useEffect(() => {
    // Idempotent: a new root after an Activity recreation adopts what the store already holds.
    void store.enter(cardId, variantId)
  }, [store, cardId, variantId])

  useEffect(
    // Leaving for real (pop / replaced stack) cancels the price request, drops any late answer and
    // forgets the printing choice. Unmounting alone (an Activity recreation) must not: it would
    // cancel a request the person is still waiting for.
    () => navigation.addListener('beforeRemove', () => store.leave()),
    [navigation, store],
  )

  if (
    state.card.status === 'idle' ||
    state.card.status === 'loading' ||
    state.card.cardId !== cardId
  ) {
    return <Loading label="Loading card" />
  }
  if (state.card.status === 'error') {
    return (
      <View style={{ padding: SPACE.lg, gap: SPACE.md }} testID="p169-card-error">
        <LiveStatus tone="danger">
          {state.card.failure?.message ?? 'The card could not be loaded.'}
        </LiveStatus>
        <ActionButton
          label="Try again"
          variant="secondary"
          onPress={() => void store.openCard(cardId, variantId)}
        />
      </View>
    )
  }
  if (state.card.status === 'not_found' || state.card.data === null) {
    return (
      <View style={{ padding: SPACE.lg }} testID="p169-card-not-found">
        <LiveStatus>This card is not in the catalog.</LiveStatus>
      </View>
    )
  }

  const { card, variants } = state.card.data
  const resolution = state.resolution
  const lookup = state.lookup
  const intent = store.addToCollectionIntent()

  return (
    <AppScreen testID="p169-card">
      <InlineNotice testID="p169-read-only-notice">
        Checking a price never adds, buys or sells anything.
      </InlineNotice>
      <View style={{ gap: SPACE.xs }}>
        <Heading>{card.name}</Heading>
        <Label muted testID="p169-card-identity">
          {card.setName} · #{card.collectorNumber} · {languageLabel(card.language)}
          {card.rarity !== null ? ` · ${card.rarity}` : ''}
        </Label>
        {card.illustrator !== null ? <Label muted>Illustrator: {card.illustrator}</Label> : null}
      </View>

      {resolution?.status === 'confirmed' ? (
        <Section testID="p169-printing-confirmed">
          <Label muted>
            {resolution.basis === 'only_variant'
              ? 'The only active printing'
              : 'Printing you chose'}
          </Label>
          <Label bold testID="p169-printing-label">
            {printingLabel(resolution.variant)}
          </Label>
          {variants.length > 1 ? (
            <View style={{ gap: SPACE.sm }}>
              <Label muted>Other printings</Label>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs }}>
                {variants
                  .filter((v) => v.variantId !== resolution.variant.variantId)
                  .map((v) => (
                    <FilterChip
                      key={v.variantId}
                      testID={`p169-variant-${v.variantId}`}
                      selected={false}
                      label={printingLabel(v)}
                      onPress={() => void store.chooseVariant(v.variantId)}
                    />
                  ))}
              </View>
            </View>
          ) : null}
        </Section>
      ) : null}

      {resolution?.status === 'choice_required' || resolution?.status === 'mismatch' ? (
        <Section testID="p169-printing-choice">
          <Heading>Choose the printing</Heading>
          <LiveStatus>
            {resolution.status === 'mismatch'
              ? 'The requested printing does not belong to this card. Nothing is guessed: choose one.'
              : 'This card has several printings, and their prices differ. No price is shown until you choose one.'}
          </LiveStatus>
          <View style={{ gap: SPACE.sm }} accessibilityRole="radiogroup">
            {resolution.variants.map((v) => (
              <RadioRow
                key={v.variantId}
                testID={`p169-variant-${v.variantId}`}
                selected={false}
                label={printingLabel(v)}
                onPress={() => void store.chooseVariant(v.variantId)}
              />
            ))}
          </View>
        </Section>
      ) : null}

      {resolution?.status === 'no_variants' ? (
        <Section testID="p169-no-variants">
          <LiveStatus>This card has no printing in the catalog, so it cannot be priced.</LiveStatus>
        </Section>
      ) : null}

      {resolution?.status === 'confirmed' ? (
        <View style={{ gap: SPACE.md }}>
          <SegmentedControl
            testID="p169-source-toggle"
            value={state.source}
            onChange={(value) => void store.setSource(value)}
            options={[
              {
                value: 'search_prices',
                label: 'Provider prices',
                testID: 'p169-source-search_prices',
              },
              {
                value: 'snapshot_rpc',
                label: 'Stored snapshot',
                testID: 'p169-source-snapshot_rpc',
              },
            ]}
          />
          {lookup.status === 'loading' ? <Loading label="Looking up prices" /> : null}
          {lookup.status === 'error' && lookup.failure !== null ? (
            <Section testID={`p169-lookup-error-${lookup.failure}`}>
              <LiveStatus tone="danger">{FAILURE_COPY[lookup.failure]}</LiveStatus>
              {lookup.retryable ? (
                <ActionButton
                  testID="p169-lookup-retry"
                  variant="secondary"
                  label="Try again"
                  onPress={() => void store.retry()}
                />
              ) : null}
              {state.source === 'search_prices' ? (
                <ActionButton
                  testID="p169-fallback-snapshot"
                  variant="secondary"
                  label="Show the stored snapshot instead"
                  hint="A different, labelled source for the same printing"
                  onPress={() => void store.setSource('snapshot_rpc')}
                />
              ) : null}
            </Section>
          ) : null}
          {lookup.status === 'ready' && lookup.result !== null ? (
            <RawSection result={lookup.result} />
          ) : null}
        </View>
      ) : null}

      <Section testID="p169-graded">
        <Label bold>Graded prices (PSA, BGS, CGC …)</Label>
        <Label muted testID="p169-graded-status">
          {UNAVAILABLE_COPY[lookup.result?.graded.unavailable ?? 'graded_source_not_configured']} No
          authorized graded price source is connected, and a graded price is never derived from a
          raw one.
        </Label>
      </Section>

      {intent !== null ? (
        <ActionButton
          testID="p169-add-to-collection"
          variant="secondary"
          label="Add to collection…"
          hint="Opens the collection flow for this printing. Nothing is added until you confirm there."
          onPress={() => host.onAddToCollection(intent)}
        />
      ) : null}
      <ActionButton
        testID="p169-search-again"
        variant="secondary"
        label="Search again"
        onPress={() => navigation.popToTop()}
      />
    </AppScreen>
  )
}
