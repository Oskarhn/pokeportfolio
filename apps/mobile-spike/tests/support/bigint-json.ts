/**
 * TEST-ONLY. When an assertion involving a BigInt FAILS, Jest tries to JSON-serialise the failure
 * ("Do not know how to serialize a BigInt", jest#11617) and reports "Test suite failed to run"
 * instead of the real diff. This makes such failures readable. It is never loaded by the app.
 */
;(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString()
}
