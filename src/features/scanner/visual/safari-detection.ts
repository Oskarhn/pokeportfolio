/**
 * F-35 (P89): extracted from visual-worker.ts into its own module so it can be unit-tested
 * directly (tests/ui/safari-detection.test.ts) without importing the whole worker file, which
 * has top-level `self.addEventListener(...)` side effects that require a real Worker global
 * scope. Zero behavioural change — same function, same logic, just testable in isolation.
 *
 * `@huggingface/transformers` v4.2.0 does not re-export its internal `apis` feature-detection
 * object from the package root (confirmed by inspecting the actual runtime module — only `env`
 * is exported), so this replicates its exact Safari check (same source) rather than depending on
 * an unavailable import.
 *
 * Why this matters enough to test directly: 6 of the 12 real confirmed scanner bugs this
 * milestone fixed were found only via real iPhone/Safari testing, and this is the one function
 * that explicitly branches behavior on Safari detection (visual-worker.ts's WASM binary choice —
 * threaded vs. asyncify — depends on it).
 */
export function detectIsSafariUserAgent(
  navigatorLike: { userAgent: string; vendor?: string } | undefined = typeof navigator ===
  'undefined'
    ? undefined
    : navigator,
): boolean {
  if (navigatorLike === undefined) return false
  const userAgent = navigatorLike.userAgent
  const vendor = navigatorLike.vendor ?? ''
  const isAppleVendor = vendor.indexOf('Apple') > -1
  const notOtherBrowser =
    !userAgent.match(/CriOS|FxiOS|EdgiOS|OPiOS|mercury|brave/i) &&
    !userAgent.includes('Chrome') &&
    !userAgent.includes('Android')
  return isAppleVendor && notOtherBrowser
}
