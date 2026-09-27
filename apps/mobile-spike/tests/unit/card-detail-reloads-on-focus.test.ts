import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression guard (P177 device run): CardDetailScreen used to reload `holdingDetail` only when
 * `holdingId` changed. Record sale / Record opening / Manual valuation all write to this exact
 * holding and navigate back here with the SAME holdingId, so a plain `useEffect` never re-ran —
 * the screen kept showing the value/price-state from before the write (found live: a manual
 * valuation stored and readable in the database, but still "No value available" on screen after
 * Confirm -> Back). Structural, since the bug is about WHEN it reloads, not what it renders.
 */
it('CardDetailScreen reloads holdingDetail on FOCUS, not only when holdingId changes', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', 'src', 'ui', 'screens', 'CardDetailScreen.tsx'),
    'utf8',
  )
  expect(source).toMatch(/useFocusEffect/)
  expect(source).toMatch(/from\s*'@react-navigation\/native'/)
})
