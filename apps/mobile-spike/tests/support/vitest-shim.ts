// The web suite's test files import { describe, expect, it } from 'vitest'. Under Jest those names
// already exist as globals; this module re-exports them so the files run byte-for-byte unchanged.
const g = globalThis as unknown as {
  describe: typeof describe
  expect: typeof expect
  it: typeof it
  test: typeof test
  beforeEach: typeof beforeEach
  afterEach: typeof afterEach
}
export const describe_ = g.describe
export { describe_ as describe }
export const expect_ = g.expect
export { expect_ as expect }
export const it_ = g.it
export { it_ as it }
export const test_ = g.test
export { test_ as test }
export const beforeEach_ = g.beforeEach
export { beforeEach_ as beforeEach }
export const afterEach_ = g.afterEach
export { afterEach_ as afterEach }
