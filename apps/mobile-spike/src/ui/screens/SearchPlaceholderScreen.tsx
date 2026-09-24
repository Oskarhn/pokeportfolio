import { View } from 'react-native'
import { Badge, Body, Heading } from '../components'
import { SPACE } from '../theme'

/** Placeholder: collection-wide search is outside the spike (P154 roadmap allows placeholders here). */
export function SearchPlaceholderScreen() {
  return (
    <View style={{ padding: SPACE.xl, gap: SPACE.md }} testID="search-placeholder">
      <Heading>Search</Heading>
      <Badge label="NOT BUILT IN THIS SPIKE" />
      <Body muted>
        Searching your own collection is not part of this feasibility build. To look up a card{"'"}s
        price, use the Price Check tab.
      </Body>
    </View>
  )
}
