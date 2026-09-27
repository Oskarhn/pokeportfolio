import { memo, useCallback, useEffect, useState } from 'react'
import { FlatList, View, type LayoutChangeEvent, type ListRenderItem } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { nokMoney, type CollectionRow } from '../../collection/types'
import {
  Body,
  CardRow,
  EmptyView,
  FailureView,
  InlineNotice,
  Loading,
  MoneyText,
} from '../components'
import type { CollectionStackParams } from '../navigation-types'
import { useRuntime, useStore } from '../runtime-context'
import { SPACE, useTheme } from '../theme'

/** Fixed row height: lets the list compute offsets without measuring (`getItemLayout`). */
export const ROW_HEIGHT = 76

type Props = NativeStackScreenProps<CollectionStackParams, 'CollectionList'>

/**
 * Memoised: a row re-renders only when its own data (or the theme) changes. Before P167 every
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
  return (
    <CardRow
      testID={`row-${row.holdingId}`}
      accessibilityLabel={`${row.title}, ${row.quantity} owned`}
      title={row.title}
      subtitle={`${row.subtitle} · ×${row.quantity}`}
      value={nokMoney(row.holdingValueMinor)}
      valueState={row.priceState}
      height={ROW_HEIGHT}
      onPress={() => onOpen(row.holdingId)}
    />
  )
})

export function CollectionScreen({ navigation }: Props) {
  const { collection } = useRuntime()
  const state = useStore(collection)
  const t = useTheme()

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
      style={{ padding: SPACE.lg, gap: SPACE.sm, backgroundColor: t.background }}
      testID="collection-summary"
      onLayout={onHeaderLayout}
    >
      {state.counts !== null ? (
        <>
          <Body muted>Collection value</Body>
          {/* No priced holding means the total is missing, not zero (FINANCIAL_MODEL F14): the
              server's sum over an empty set is 0, and the web app shows it as missing too. */}
          <MoneyText
            testID="collection-total"
            size="display"
            value={
              state.counts.pricedHoldingCount > 0
                ? nokMoney(state.counts.portfolioValueMinor)
                : null
            }
          />
          <Body muted>
            {state.counts.uniqueHoldingCount} holdings {'·'} {state.counts.physicalCardCount} cards{' '}
            {'·'} {state.counts.unpricedHoldingCount} without a value
          </Body>
          {state.counts.unpricedHoldingCount > 0 ? (
            <InlineNotice tone="warning">
              {state.counts.unpricedHoldingCount}{' '}
              {state.counts.unpricedHoldingCount === 1 ? 'holding has' : 'holdings have'} no price
              and {state.counts.unpricedHoldingCount === 1 ? 'is' : 'are'} not counted as 0 in the
              total above.
            </InlineNotice>
          ) : null}
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
      contentContainerStyle={{ backgroundColor: t.background }}
      style={{ backgroundColor: t.background }}
    />
  )
}
