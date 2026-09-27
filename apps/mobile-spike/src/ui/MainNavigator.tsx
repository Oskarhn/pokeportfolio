import { Text, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from '@react-navigation/native-stack'
import { P169_SCREENS } from '../features/screens'
import { IconButton } from './components'
import { AddAcquisitionScreen } from './screens/AddAcquisitionScreen'
import { AddIntentScreen } from './screens/AddIntentScreen'
import { CardDetailScreen } from './screens/CardDetailScreen'
import { CollectionScreen } from './screens/CollectionScreen'
import { ManualValuationScreen } from './screens/ManualValuationScreen'
import { PriceCheckHomeScreen } from './screens/PriceCheckHomeScreen'
import { ProfileScreen } from './screens/ProfileScreen'
import { RecordOpeningScreen } from './screens/RecordOpeningScreen'
import { RecordPurchaseScreen } from './screens/RecordPurchaseScreen'
import { RecordSaleScreen } from './screens/RecordSaleScreen'
import { VariantEntryScreen } from './screens/VariantEntryScreen'
import { useTheme } from './theme'
import type {
  CollectionStackParams,
  PriceCheckStackParams,
  SearchStackParams,
  TabParams,
} from './navigation-types'

/** Shared native-stack header styling — dark surface, hairline shadow off (Foil: no shadows), a
 *  screen title in the section type role. Applied per-navigator via `screenOptions`. */
function useStackScreenOptions(): NativeStackNavigationOptions {
  const t = useTheme()
  return {
    headerStyle: { backgroundColor: t.surface },
    headerTintColor: t.textPrimary,
    headerTitleStyle: { fontSize: 16, fontWeight: '600', color: t.textPrimary },
    headerShadowVisible: false,
    contentStyle: { backgroundColor: t.background },
  }
}

/** A close (×) instead of a back arrow for the financial write-form screens (P178 §15/fixtures §7):
 *  these are single-purpose task screens the person dismisses, not a place they browse forward from. */
function CloseHeaderLeft({ onPress }: { onPress: () => void }) {
  return <IconButton glyph="×" accessibilityLabel="Close" onPress={onPress} />
}

/**
 * PROVISIONAL navigation: Collection / Search / Price Check / Profile as bottom tabs, each tab with
 * its own native stack (Fragment-backed via react-native-screens). This is a neutral scaffold, NOT
 * the owner's navigation choice: P154's proposed schemes are untouched and unapproved. Text labels
 * only; no icons (no icon direction is chosen; see `tabOptions`).
 *
 * The Search stack holds every screen that reads a card: catalog search, the card + printing + price
 * screen, the photo entry (all from the Search / Price Check feature), a resolver for a holding's
 * "Check price", and the Add-to-collection intent. They live in ONE stack because they share ONE
 * card store: a second card screen elsewhere could show a card the store no longer holds. The Price
 * Check tab is a read-only landing that opens that stack.
 *
 * Back semantics: each stack pops natively; `backBehavior="history"` returns from another tab to the
 * one the person came from (e.g. Card detail -> Check price -> Back lands on Card detail again).
 */

const Tabs = createBottomTabNavigator<TabParams>()
const CollectionStack = createNativeStackNavigator<CollectionStackParams>()
const SearchStack = createNativeStackNavigator<SearchStackParams>()
const PriceCheckStack = createNativeStackNavigator<PriceCheckStackParams>()

function CollectionStackScreen() {
  const screenOptions = useStackScreenOptions()
  return (
    <CollectionStack.Navigator screenOptions={screenOptions}>
      <CollectionStack.Screen
        name="CollectionList"
        component={CollectionScreen}
        options={{ title: 'Collection' }}
      />
      <CollectionStack.Screen
        name="CardDetail"
        component={CardDetailScreen}
        options={{ title: 'Card', headerBackTitle: 'Back' }}
      />
      <CollectionStack.Screen
        name="RecordSale"
        component={RecordSaleScreen}
        options={({ navigation }) => ({
          title: 'Record sale',
          headerLeft: () => <CloseHeaderLeft onPress={() => navigation.goBack()} />,
        })}
      />
      <CollectionStack.Screen
        name="ManualValuation"
        component={ManualValuationScreen}
        options={({ navigation }) => ({
          title: 'Manual valuation',
          headerLeft: () => <CloseHeaderLeft onPress={() => navigation.goBack()} />,
        })}
      />
      <CollectionStack.Screen
        name="RecordOpening"
        component={RecordOpeningScreen}
        options={({ navigation }) => ({
          title: 'Record opening',
          headerLeft: () => <CloseHeaderLeft onPress={() => navigation.goBack()} />,
        })}
      />
    </CollectionStack.Navigator>
  )
}

function SearchStackScreen() {
  const screenOptions = useStackScreenOptions()
  return (
    <SearchStack.Navigator screenOptions={screenOptions}>
      {P169_SCREENS.map((screen) => (
        <SearchStack.Screen
          key={screen.name}
          name={screen.name}
          component={screen.component}
          options={{ title: screen.title, headerBackTitle: 'Back' }}
        />
      ))}
      <SearchStack.Screen
        name="P170VariantEntry"
        component={VariantEntryScreen}
        options={{ title: 'Price Check', headerBackTitle: 'Back' }}
      />
      <SearchStack.Screen
        name="P170AddIntent"
        component={AddIntentScreen}
        options={{ title: 'Add to collection', headerBackTitle: 'Back' }}
      />
      <SearchStack.Screen
        name="P175AddAcquisition"
        component={AddAcquisitionScreen}
        options={({ navigation }) => ({
          title: 'Add to collection',
          headerLeft: () => <CloseHeaderLeft onPress={() => navigation.goBack()} />,
        })}
      />
      <SearchStack.Screen
        name="P175RecordPurchase"
        component={RecordPurchaseScreen}
        options={({ navigation }) => ({
          title: 'Record purchase',
          headerLeft: () => <CloseHeaderLeft onPress={() => navigation.goBack()} />,
        })}
      />
    </SearchStack.Navigator>
  )
}

function PriceCheckStackScreen() {
  const screenOptions = useStackScreenOptions()
  return (
    <PriceCheckStack.Navigator screenOptions={screenOptions}>
      <PriceCheckStack.Screen
        name="PriceCheckHome"
        component={PriceCheckHomeScreen}
        options={{ title: 'Price Check' }}
      />
    </PriceCheckStack.Navigator>
  )
}

/**
 * Text-only tabs (P167 F3). Without `tabBarIcon`, bottom-tabs renders its fallback glyph, which Android
 * draws as a missing-glyph box and TalkBack announced as "⏷, Collection". No icon set is chosen (owner
 * pending), so the icon slot is removed rather than filled.
 */
const TAB_LABEL_MAX_SCALE = 1.5

export function tabOptions(title: string, testID: string) {
  return {
    title,
    tabBarButtonTestID: testID,
    tabBarAccessibilityLabel: title,
    tabBarIcon: () => null,
    tabBarLabel: ({ color }: { color: string }) => <TabLabel title={title} color={color} />,
  }
}

function TabLabel({ title, color }: { title: string; color: string }) {
  return (
    <Text
      numberOfLines={2}
      maxFontSizeMultiplier={TAB_LABEL_MAX_SCALE}
      style={{ color, fontSize: 13, fontWeight: '600', textAlign: 'center' }}
    >
      {title}
    </Text>
  )
}

/** Tab bar height: one label line at normal text size, room for two scaled lines above it, plus the
 *  system gesture/navigation bar inset (the library pads by the inset inside a custom height). */
export function tabBarHeight(fontScale: number, bottomInset: number): number {
  return (Math.min(fontScale, TAB_LABEL_MAX_SCALE) > 1.15 ? 68 : 56) + bottomInset
}

export function MainNavigator({ backendHost }: { backendHost: string }) {
  const insets = useSafeAreaInsets()
  const { fontScale } = useWindowDimensions()
  const t = useTheme()
  return (
    <Tabs.Navigator
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        tabBarLabelPosition: 'beside-icon',
        tabBarIconStyle: { display: 'none' },
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.textMuted,
        tabBarStyle: {
          height: tabBarHeight(fontScale, insets.bottom),
          backgroundColor: t.surface,
          borderTopColor: t.borderSubtle,
        },
      }}
    >
      <Tabs.Screen
        name="CollectionTab"
        component={CollectionStackScreen}
        options={tabOptions('Collection', 'tab-collection')}
      />
      <Tabs.Screen
        name="SearchTab"
        component={SearchStackScreen}
        options={tabOptions('Search', 'tab-search')}
      />
      <Tabs.Screen
        name="PriceCheckTab"
        component={PriceCheckStackScreen}
        options={tabOptions('Price Check', 'tab-pricecheck')}
      />
      <Tabs.Screen
        name="ProfileTab"
        options={{ ...tabOptions('Profile', 'tab-profile'), headerShown: true }}
      >
        {() => <ProfileScreen backendHost={backendHost} />}
      </Tabs.Screen>
    </Tabs.Navigator>
  )
}
