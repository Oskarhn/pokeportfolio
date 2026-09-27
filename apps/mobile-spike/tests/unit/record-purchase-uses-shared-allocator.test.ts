import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Structural proof (mutation #15 in output_175.txt, "purchase discount misallocation"): the
 * purchase-record screen must compute its preview total through the SAME pure allocator the server
 * uses (`@shared/domain/allocation`'s `allocatePurchaseCharges`, unchanged since P144), never by
 * re-deriving the discount split with its own arithmetic — the two would silently drift apart for
 * any receipt whose discount exceeds the goods subtotal (P130-16).
 */
it('RecordPurchaseScreen computes its preview through allocatePurchaseCharges, not its own arithmetic', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', 'src', 'ui', 'screens', 'RecordPurchaseScreen.tsx'),
    'utf8',
  )
  expect(source).toMatch(
    /import\s*\{[^}]*allocatePurchaseCharges[^}]*\}\s*from\s*'@shared\/domain\/allocation'/,
  )
  expect(source).toMatch(/allocatePurchaseCharges\(/)
})

/**
 * Regression guard (P177 device run): `create_purchase` requires a `condition` for a raw card
 * line ("condition is required for a raw card") — RecordPurchaseScreen never sent one, so every
 * purchase submitted through the real app was rejected server-side. Structural, not a value check
 * (the exact default is a UX choice), because the wire-shape unit test hand-supplies a condition
 * and would not have caught the screen itself omitting it.
 */
it('RecordPurchaseScreen sends a condition for its card line (create_purchase requires one for a raw card)', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', 'src', 'ui', 'screens', 'RecordPurchaseScreen.tsx'),
    'utf8',
  )
  expect(source).toMatch(/condition:\s*['"]/)
})
