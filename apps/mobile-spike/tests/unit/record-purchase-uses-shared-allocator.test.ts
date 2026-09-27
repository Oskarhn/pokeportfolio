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
