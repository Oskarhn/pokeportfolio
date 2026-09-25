import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useStore } from '../../ui/runtime-context'
import { SPACE, usePalette } from '../../ui/theme'
import { languageLabel } from '../price-check/p165-domain/price-check/identity'
import { useP169, type P169StackParams } from '../navigation'
import { ActionButton, LiveStatus, TOUCH_48 } from '../ui/kit'
import { MIN_QUERY_LENGTH, type SearchHitView } from './catalog-search-store'

function printings(n: number): string {
  if (n === 0) return 'no active printing'
  return n === 1 ? '1 printing' : `${String(n)} printings`
}

function HitRow({ hit, onPress }: { hit: SearchHitView; onPress: () => void }) {
  const p = usePalette()
  const meta = `${hit.setName} · #${hit.collectorNumber} · ${languageLabel(hit.language)} · ${printings(hit.activeVariantCount)}`
  const label = `${hit.name}. ${hit.setName}, number ${hit.collectorNumber}, ${languageLabel(hit.language)}, ${printings(hit.activeVariantCount)}${hit.rarity !== null ? `, ${hit.rarity}` : ''}.${hit.sharesName ? ' Same name as another result: check the set and number.' : ''}`
  return (
    <Pressable
      testID={`p169-hit-${hit.cardId}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the card to choose the exact printing"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TOUCH_48 + 16,
        paddingVertical: SPACE.sm,
        justifyContent: 'center',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: p.border,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color: p.text, fontSize: 16, fontWeight: '600' }}>{hit.name}</Text>
      <Text style={{ color: p.muted, fontSize: 14 }}>{meta}</Text>
      {hit.rarity !== null ? (
        <Text style={{ color: p.muted, fontSize: 14 }}>{hit.rarity}</Text>
      ) : null}
      {hit.sharesName ? (
        <Text
          testID={`p169-hit-shared-${hit.cardId}`}
          style={{ color: p.warning, fontSize: 14, fontWeight: '600' }}
        >
          Same name as another result — check the set and number
        </Text>
      ) : null}
    </Pressable>
  )
}

export function CatalogSearchScreen({
  navigation,
}: NativeStackScreenProps<P169StackParams, 'P169Search'>) {
  const { feature } = useP169()
  const store = feature.search
  const state = useStore(store)
  const p = usePalette()

  const status = (() => {
    switch (state.status) {
      case 'idle':
        return `Type at least ${String(MIN_QUERY_LENGTH)} characters: a card name, a set name or a number (e.g. "Pikachu 25" or "4/102").`
      case 'pending':
      case 'loading':
        return 'Searching…'
      case 'empty':
        return `No cards match "${state.resultsFor ?? ''}".`
      case 'error':
        return state.failure?.message ?? 'Search failed.'
      case 'ready':
        return `${String(state.hits.length)} of ${String(state.totalCount)} matching cards. Nothing is selected until you choose one.`
    }
  })()

  return (
    <View style={{ flex: 1, backgroundColor: p.background }} testID="p169-search">
      <View style={{ padding: SPACE.lg, gap: SPACE.md }}>
        <TextInput
          testID="p169-search-input"
          accessibilityLabel="Card name, set or number"
          value={state.query}
          onChangeText={(text) => store.setQuery(text)}
          onSubmitEditing={() => void store.submit()}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Card name, set or number"
          placeholderTextColor={p.muted}
          style={{
            minHeight: TOUCH_48,
            borderWidth: 1,
            borderColor: p.border,
            borderRadius: 10,
            paddingHorizontal: SPACE.md,
            color: p.text,
            backgroundColor: p.surface,
            fontSize: 16,
          }}
        />
        <View
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm }}
          accessibilityRole="radiogroup"
          accessibilityLabel="Catalog language"
        >
          {([null, 'en', 'ja'] as const).map((lang) => (
            <ActionButton
              key={lang ?? 'all'}
              testID={`p169-lang-${lang ?? 'all'}`}
              variant="secondary"
              selected={state.language === lang}
              label={lang === null ? 'All languages' : languageLabel(lang)}
              onPress={() => store.setLanguage(lang)}
            />
          ))}
          <ActionButton
            testID="p169-open-photo"
            variant="secondary"
            label="From a photo"
            hint="Explains photo identification and returns to manual search"
            onPress={() => navigation.navigate('P169PhotoEntry')}
          />
        </View>
        <LiveStatus
          testID={`p169-search-status-${state.status}`}
          tone={state.status === 'error' ? 'danger' : 'muted'}
        >
          {status}
        </LiveStatus>
        {state.status === 'error' && state.failure?.retryable === true ? (
          <ActionButton
            testID="p169-search-retry"
            variant="secondary"
            label="Try again"
            onPress={() => void store.submit()}
          />
        ) : null}
      </View>
      <FlatList
        testID="p169-results"
        data={state.hits}
        keyExtractor={(hit) => hit.cardId}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.xl }}
        initialNumToRender={12}
        windowSize={7}
        onEndReachedThreshold={0.5}
        onEndReached={() => void store.loadMore()}
        renderItem={({ item }) => (
          <HitRow
            hit={item}
            onPress={() => navigation.navigate('P169Card', { cardId: item.cardId })}
          />
        )}
        ListFooterComponent={
          <View style={{ paddingVertical: SPACE.md, gap: SPACE.sm }}>
            {state.loadingMore ? <LiveStatus>Loading more…</LiveStatus> : null}
            {state.moreFailure !== null ? (
              <>
                <LiveStatus tone="danger">{state.moreFailure.message}</LiveStatus>
                <ActionButton
                  variant="secondary"
                  label="Load more again"
                  onPress={() => void store.loadMore()}
                />
              </>
            ) : null}
            {state.reachedLimit ? (
              <LiveStatus testID="p169-search-limit">
                Showing the first {String(state.hits.length)} matches. Add a set name or number to
                narrow the search.
              </LiveStatus>
            ) : null}
          </View>
        }
      />
    </View>
  )
}
