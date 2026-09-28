import { ScrollView } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import {
  languageLabel,
  variantLabel,
} from '../../features/price-check/p165-domain/price-check/identity'
import { Label, LiveStatus, Section } from '../../features/ui/kit'
import { Button, Heading } from '../components'
import type { CardDisplaySummary, SearchStackParams } from '../navigation-types'
import { useRuntime, useStore } from '../runtime-context'
import { SPACE, usePalette } from '../theme'

/**
 * "Add to collection" from a price check is an INTENT: it names the card and the printing the
 * person confirmed and hands over to the collection flow, which asks for its own explicit
 * confirmation before anything is written. P175 replaces the P173 read-only stub with the two real
 * next steps: recording this card as an acquisition, or as a purchase receipt. Choosing either is
 * still just navigation — nothing is written until that screen's own explicit confirm.
 */
export function AddIntentScreen({
  route,
  navigation,
}: NativeStackScreenProps<SearchStackParams, 'P170AddIntent'>) {
  const { cardId, variantId } = route.params
  const { feature } = useRuntime()
  const flow = useStore(feature.priceCheck)
  const p = usePalette()
  const data =
    flow.card.data !== null && flow.card.data.card.cardId === cardId ? flow.card.data : null
  const printing = data?.variants.find((v) => v.variantId === variantId) ?? null
  // P180: built once, here, where the confirmed card identity is already known — the acquisition
  // and purchase screens carry this through navigation instead of showing the raw variant UUID.
  const cardDisplay: CardDisplaySummary | undefined =
    data !== null
      ? {
          name: data.card.name,
          setName: data.card.setName,
          collectorNumber: data.card.collectorNumber,
          languageLabel: languageLabel(data.card.language),
          printingLabel: printing !== null ? variantLabel(printing) : '',
        }
      : undefined
  return (
    <ScrollView
      style={{ backgroundColor: p.background }}
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg }}
      testID="p170-add-intent"
    >
      <Heading>Add to collection</Heading>
      {data !== null ? (
        <Section testID="p170-add-intent-card">
          <Label bold>{data.card.name}</Label>
          <Label muted>
            {data.card.setName} · #{data.card.collectorNumber} · {languageLabel(data.card.language)}
          </Label>
          {printing !== null ? <Label muted>{variantLabel(printing)}</Label> : null}
        </Section>
      ) : null}
      <LiveStatus testID="p170-add-intent-text">
        Choose how this card entered your collection. Nothing is saved until you confirm on the next
        screen.
      </LiveStatus>
      <Button
        testID="p175-go-add-acquisition"
        label="Add to collection"
        accessibilityHint="Record ownership of this card, with or without a known cost"
        onPress={() =>
          navigation.navigate('P175AddAcquisition', { cardId, variantId, cardDisplay })
        }
      />
      <Button
        testID="p175-go-record-purchase"
        label="Record as a purchase"
        variant="secondary"
        accessibilityHint="Record a purchase receipt for this card"
        onPress={() =>
          navigation.navigate('P175RecordPurchase', { cardId, variantId, cardDisplay })
        }
      />
    </ScrollView>
  )
}
