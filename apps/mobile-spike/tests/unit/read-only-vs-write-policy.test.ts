import { READ_ONLY_RPCS } from '../../src/net/spike-fetch'
import { WRITE_RPCS } from '../../src/write/write-policy'

/**
 * The two wire policies must never overlap: the shared reading client (Price Check, catalog
 * search, collection browsing) stays exactly as read-only as P173 left it, and the finance write
 * seam's own client is the ONLY thing that may call a write RPC. Mutation #18 in output_175.txt
 * ("Price Check itself writes") is this: if a write RPC were ever added to `READ_ONLY_RPCS`, this
 * test fails before any screen could reach it.
 */
it('READ_ONLY_RPCS and WRITE_RPCS share no RPC name', () => {
  const overlap = [...READ_ONLY_RPCS].filter((name) => WRITE_RPCS.has(name))
  expect(overlap).toEqual([])
})
