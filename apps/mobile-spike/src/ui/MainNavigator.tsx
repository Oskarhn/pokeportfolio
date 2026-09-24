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
 * schemes are untouched and unapproved. Text labels only; no icons (no icon direction is chosen).
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

export function MainNavigator({ backendHost }: { backendHost: string }) {
  return (
    <Tabs.Navigator
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        tabBarLabelStyle: { fontSize: 13 },
        tabBarStyle: { minHeight: 56 },
      }}
    >
      <Tabs.Screen
        name="CollectionTab"
        component={CollectionStackScreen}
        options={{ title: 'Collection', tabBarButtonTestID: 'tab-collection' }}
      />
      <Tabs.Screen
        name="SearchTab"
        component={SearchPlaceholderScreen}
        options={{ title: 'Search', headerShown: true, tabBarButtonTestID: 'tab-search' }}
      />
      <Tabs.Screen
        name="PriceCheckTab"
        component={PriceCheckStackScreen}
        options={{ title: 'Price Check', tabBarButtonTestID: 'tab-pricecheck' }}
      />
      <Tabs.Screen
        name="ProfileTab"
        options={{ title: 'Profile', headerShown: true, tabBarButtonTestID: 'tab-profile' }}
      >
        {() => <ProfileScreen backendHost={backendHost} />}
      </Tabs.Screen>
    </Tabs.Navigator>
  )
}
