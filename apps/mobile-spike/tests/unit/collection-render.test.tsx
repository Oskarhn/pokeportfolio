import { act, render, screen } from '@testing-library/react-native'
import { AppRoot } from '../../src/ui/AppRoot'
import { flush, harness, row, session } from '../support/fakes'

/**
 * How much React work a new page costs (P167 collection performance). Every list row renders exactly
 * one `CardRow` (P178: the shared row primitive `CollectionScreen`'s memoised `Row` wraps), so
 * counting those renders counts row renders. UNIT_TESTED in the RN jest preset; frame timing on a
 * device is measured separately (scripts/android-collection-perf.mjs).
 */
const mockCounter = { rowRenders: 0 }
jest.mock('../../src/ui/components', () => {
  const actual =
    jest.requireActual<typeof import('../../src/ui/components')>('../../src/ui/components')
  return {
    ...actual,
    CardRow: (props: Parameters<typeof actual.CardRow>[0]) => {
      mockCounter.rowRenders += 1
      return actual.CardRow(props)
    },
  }
})

it('appending a page renders only the new rows, never the rows already on screen', async () => {
  const h = harness()
  const page = (prefix: string) =>
    Array.from({ length: 5 }, (_, i) => row(`${prefix}${String(i)}`, { holdingValueMinor: 100n }))
  h.collection.pages.push({ rows: page('a'), nextCursor: { id: 'a4' } })
  h.collection.pages.push({ rows: page('b'), nextCursor: null })
  await render(<AppRoot runtime={h.runtime} backendHost="127.0.0.1" />)
  await act(async () => {
    h.auth.emit('SIGNED_IN', session('A'))
    await flush()
  })
  expect(await screen.findByTestId('row-a4')).toBeTruthy()

  mockCounter.rowRenders = 0
  await act(async () => {
    await h.runtime.collection.loadMore()
    await flush()
  })
  expect(await screen.findByTestId('row-b4')).toBeTruthy()
  // 5 new rows, each rendered once. Unmemoised rows re-rendered the first page on the
  // "loading more" state and again on the append (5 + 5 + 5 + 5 = 20 before P167).
  expect(mockCounter.rowRenders).toBe(5)
})
