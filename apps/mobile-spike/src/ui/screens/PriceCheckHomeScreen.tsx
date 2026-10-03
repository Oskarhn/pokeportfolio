import { ScrollView } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { ActionButton, Label, LiveStatus, Section } from '../../features/ui/kit'
import { Heading, InlineNotice } from '../components'
import type { PriceCheckStackParams, TabParams } from '../navigation-types'
import { SPACE, useTheme } from '../theme'

/**
 * The Price Check tab: a read-only landing. The prices themselves are read on the card screen of the
 * Search stack (one card screen, one store), so this screen only says what Price Check is and opens
 * the two ways in. Nothing here can create or change anything in the collection.
 */
export function PriceCheckHomeScreen({
  navigation,
}: NativeStackScreenProps<PriceCheckStackParams, 'PriceCheckHome'>) {
  const t = useTheme()
  const tabs = navigation.getParent<{
    navigate: (name: 'SearchTab', params: TabParams['SearchTab']) => void
  }>()
  return (
    <ScrollView
      style={{ backgroundColor: t.background }}
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg }}
      testID="price-check-home"
    >
      <Heading>Check a card{"'"}s price</Heading>
      <Section>
        <Label>
          Find the card, choose the exact printing, then see the prices providers report for it.
        </Label>
      </Section>
      <InlineNotice testID="price-check-read-only">
        Read-only. Checking a price never adds anything to your collection.
      </InlineNotice>
      <ActionButton
        testID="pc-home-search"
        label="Search for a card"
        onPress={() => tabs?.navigate('SearchTab', { screen: 'P169Search' })}
      />
      <ActionButton
        testID="pc-home-photo"
        variant="secondary"
        label="From a photo"
        hint="Explains photo identification and returns to manual search"
        onPress={() => tabs?.navigate('SearchTab', { screen: 'P169PhotoEntry' })}
      />
      <LiveStatus testID="pc-home-photo-note">
        A photo does not currently identify the card automatically.
      </LiveStatus>
    </ScrollView>
  )
}
