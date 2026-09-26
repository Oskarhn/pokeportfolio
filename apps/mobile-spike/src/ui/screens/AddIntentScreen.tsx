import { ScrollView } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import {
  languageLabel,
  variantLabel,
} from '../../features/price-check/p165-domain/price-check/identity'
import { Label, LiveStatus, Section } from '../../features/ui/kit'
import { Heading } from '../components'
import type { SearchStackParams } from '../navigation-types'
import { useRuntime, useStore } from '../runtime-context'
import { SPACE, usePalette } from '../theme'

/**
 * "Add to collection" from a price check is an INTENT: it names the card and the printing the person
 * confirmed and hands over to the collection flow, which must ask for its own explicit confirmation
 * before anything is written. The native app has no such flow yet, so this screen says so and
 * changes nothing: Price Check's client refuses every write request at the wire (net/spike-fetch.ts).
 */
export function AddIntentScreen({
  route,
}: NativeStackScreenProps<SearchStackParams, 'P170AddIntent'>) {
  const { cardId, variantId } = route.params
  const { feature } = useRuntime()
  const flow = useStore(feature.priceCheck)
  const p = usePalette()
  const data =
    flow.card.data !== null && flow.card.data.card.cardId === cardId ? flow.card.data : null
  const printing = data?.variants.find((v) => v.variantId === variantId) ?? null
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
        Adding cards to your collection is not available in the app yet, so nothing was saved. The
        price check did not change your collection.
      </LiveStatus>
    </ScrollView>
  )
}
