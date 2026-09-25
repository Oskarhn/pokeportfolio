import { Text, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { CardDetailScreen } from './screens/CardDetailScreen'
import { CollectionScreen } from './screens/CollectionScreen'
import { PhotoSpikeScreen } from './screens/PhotoSpikeScreen'
import { PriceCheckHomeScreen, PriceCheckResultScreen } from './screens/PriceCheckScreens'
import { ProfileScreen } from './screens/ProfileScreen'
import { SearchPlaceholderScreen } from './screens/SearchPlaceholderScreen'
import type { CollectionStackParams, PriceCheckStackParams, TabParams } from './navigation-types'

/**
 * PROVISIONAL navigation: Collection / Search / Price Check / Profile as bottom tabs, each tab with
 * its own native stack (UINavigationController / Fragment-backed via react-native-screens). This is
 * a neutral scaffold for the feasibility spike, NOT the owner's navigation choice: P154's proposed
 * schemes are untouched and unapproved. Text labels only; no icons (no icon direction is chosen; see
 * `tabOptions`).
 *
 * Back semantics: each stack pops natively; `backBehavior="history"` returns from Price Check to the
 * tab the person came from (e.g. Card detail -> Check price -> Back lands on Card detail again).
 */

const Tabs = createBottomTabNavigator<TabParams>()
const CollectionStack = createNativeStackNavigator<CollectionStackParams>()
const PriceCheckStack = createNativeStackNavigator<PriceCheckStackParams>()

function CollectionStackScreen() {
  return (
    <CollectionStack.Navigator>
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
    </CollectionStack.Navigator>
  )
}

function PriceCheckStackScreen() {
  return (
    <PriceCheckStack.Navigator>
      <PriceCheckStack.Screen
        name="PriceCheckHome"
        component={PriceCheckHomeScreen}
        options={{ title: 'Price Check' }}
      />
      <PriceCheckStack.Screen
        name="PriceCheckResult"
        component={PriceCheckResultScreen}
        options={{ title: 'Price' }}
      />
      <PriceCheckStack.Screen
        name="PhotoSpike"
        component={PhotoSpikeScreen}
        options={{ title: 'Photo' }}
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
  return (
    <Tabs.Navigator
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        tabBarLabelPosition: 'beside-icon',
        tabBarIconStyle: { display: 'none' },
        tabBarStyle: { height: tabBarHeight(fontScale, insets.bottom) },
      }}
    >
      <Tabs.Screen
        name="CollectionTab"
        component={CollectionStackScreen}
        options={tabOptions('Collection', 'tab-collection')}
      />
      <Tabs.Screen
        name="SearchTab"
        component={SearchPlaceholderScreen}
        options={{ ...tabOptions('Search', 'tab-search'), headerShown: true }}
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
