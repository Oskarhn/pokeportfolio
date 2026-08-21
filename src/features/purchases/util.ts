/** Indexes an array with an explicit bounds check instead of a non-null assertion — used where a
 *  parallel array (e.g. `allocate()`'s output) is known by construction to match another array's
 *  length, but `noUncheckedIndexedAccess` still types the access as possibly `undefined`. */
export function at<T>(array: readonly T[], index: number): T {
  const value = array[index]
  if (value === undefined) {
    throw new Error(`index ${String(index)} out of range (length ${String(array.length)})`)
  }
  return value
}
