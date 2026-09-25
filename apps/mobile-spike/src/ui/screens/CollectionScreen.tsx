import { memo, useCallback, useEffect, useState } from 'react'
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type ListRenderItem,
} from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { nokMoney, type CollectionRow } from '../../collection/types'
import { Body, EmptyView, FailureView, Loading, MoneyText } from '../components'
import type { CollectionStackParams } from '../navigation-types'
import { useRuntime, useStore } from '../runtime-context'
import { MIN_TOUCH, SPACE, usePalette } from '../theme'

/** Fixed row height: lets the list compute offsets without measuring (`getItemLayout`). */
export const ROW_HEIGHT = 72

type Props = NativeStackScreenProps<CollectionStackParams, 'CollectionList'>

/**
 * Memoised: a row re-renders only when its own data (or the colour scheme) changes. Before P167 every
 * appended page re-rendered every mounted row, because each render built a new `renderItem` and a new
 * `onPress` closure per row (tests/unit/collection-render.test.tsx counts this).
 */
const Row = memo(function Row({
  row,
  onOpen,
}: {
  row: CollectionRow
  onOpen: (holdingId: string) => void
}) {
  const p = usePalette()
  const value = nokMoney(row.holdingValueMinor)
  return (
    <Pressable
      testID={`row-${row.holdingId}`}
      accessibilityRole="button"
      accessibilityLabel={`${row.title}, ${row.quantity} owned`}
      onPress={() => onOpen(row.holdingId)}
      style={{
        height: ROW_HEIGHT,
        minHeight: MIN_TOUCH,
        paddingHorizontal: SPACE.lg,
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACE.md,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: p.border,
        backgroundColor: p.surface,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={1.4}
          style={{ color: p.text, fontSize: 16, fontWeight: '600' }}
        >
          {row.title}
        </Text>
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={1.4}
          style={{ color: p.muted, fontSize: 13 }}
        >
          {row.subtitle} {'·'} {'×'}
          {row.quantity}
        </Text>
      </View>
      {/* The amount may take at most 60 % of the row and shrinks to one line rather than pushing the
          title out entirely or cutting digits off (P166 F4, large text). */}
      <View style={{ maxWidth: '60%', flexShrink: 1, alignItems: 'flex-end' }}>
        <MoneyText value={value} fit="shrink" />
      </View>
    </Pressable>
  )
})

export function CollectionScreen({ navigation }: Props) {
  const { collection } = useRuntime()
  const state = useStore(collection)
  const p = usePalette()

  useEffect(() => {
    if (collection.getSnapshot().status === 'idle') void collection.load()
  }, [collection])

  const openHolding = useCallback(
    (holdingId: string) => navigation.navigate('CardDetail', { holdingId }),
    [navigation],
  )
  const renderItem = useCallback<ListRenderItem<CollectionRow>>(
    ({ item }) => <Row row={item} onOpen={openHolding} />,
    [openHolding],
  )
  // Row offsets start below the header; getItemLayout must include its (text-size dependent) height,
  // or the list windows the wrong rows for positions it has not measured yet.
  const [headerHeight, setHeaderHeight] = useState(0)
  const onHeaderLayout = useCallback(
    (e: LayoutChangeEvent) => setHeaderHeight(Math.round(e.nativeEvent.layout.height)),
    [],
  )
  const getItemLayout = useCallback(
    (_data: ArrayLike<CollectionRow> | null | undefined, index: number) => ({
      length: ROW_HEIGHT,
      offset: headerHeight + ROW_HEIGHT * index,
      index,
    }),
    [headerHeight],
  )

  const header = (
    <View
      style={{ padding: SPACE.lg, gap: SPACE.xs }}
      testID="collection-summary"
      onLayout={onHeaderLayout}
    >
      {state.counts !== null ? (
        <>
          <Body muted>
            {state.counts.uniqueHoldingCount} holdings {'·'} {state.counts.physicalCardCount} cards{' '}
            {'·'} {state.counts.unpricedHoldingCount} without a value
          </Body>
          {/* No priced holding means the total is missing, not zero (FINANCIAL_MODEL F14): the
              server's sum over an empty set is 0, and the web app shows it as missing too. */}
          <MoneyText
            testID="collection-total"
            emphasis
            value={
              state.counts.pricedHoldingCount > 0
                ? nokMoney(state.counts.portfolioValueMinor)
                : null
            }
          />
        </>
      ) : state.countsFailure !== null ? (
        <Body muted testID="collection-total-unavailable">
          Total value unavailable (
          {state.countsFailure.kind === 'unsafe_numeric'
            ? 'not readable exactly'
            : 'could not be loaded'}
          ).
        </Body>
      ) : null}
    </View>
  )

  if (state.status === 'loading' && state.rows.length === 0)
    return <Loading label="Loading your collection" />
  if (state.status === 'error' && state.failure !== null) {
    return <FailureView failure={state.failure} onRetry={() => void collection.load()} />
  }
  if (state.status === 'empty') {
    return (
      <EmptyView title="No cards yet" detail="Cards you add to your collection will appear here." />
    )
  }

  return (
    <FlatList
      testID="collection-list"
      data={state.rows}
      keyExtractor={(row) => row.holdingId}
      renderItem={renderItem}
      getItemLayout={getItemLayout}
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      windowSize={7}
      removeClippedSubviews
      onEndReached={() => void collection.loadMore()}
      onEndReachedThreshold={0.6}
      refreshing={state.status === 'loading'}
      onRefresh={() => void collection.load()}
      ListHeaderComponent={header}
      ListFooterComponent={
        state.loadingMore ? (
          <Loading label="Loading more" />
        ) : state.failure !== null ? (
          <FailureView failure={state.failure} onRetry={() => void collection.loadMore()} />
        ) : state.done ? (
          <View style={{ padding: SPACE.lg }}>
            <Body muted testID="collection-end">
              End of collection
            </Body>
          </View>
        ) : null
      }
      contentContainerStyle={{ backgroundColor: p.background }}
    />
  )
}
