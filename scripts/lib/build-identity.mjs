/**
 * Exact build-SHA identity checks against a served/built JS bundle (P130-27, P139 fail-closed
 * contract).
 *
 * WHY THIS EXISTS. `vite.config.ts`'s `resolveBuildSha()` embeds `__APP_BUILD_SHA__` as a JSON
 * string literal — a clean 40-hex commit SHA normally, or `"<sha>+dirty"` when the worktree that
 * produced the build had uncommitted changes (tests/config/build-sha.test.ts). A naive identity
 * check (`bundleText.includes(expectedSha)`) is a SUBSTRING test: the clean 40-hex expected SHA
 * is a literal substring of `"<sha>+dirty"`, so a dirty build — the exact case this check exists
 * to reject — passes it. The same substring shape also passes if the expected SHA is merely a
 * PREFIX of some unrelated longer hex run elsewhere in the bundle (source map hashes, chunk
 * hashes, package lockfile-derived strings all look like hex).
 *
 * The fix: require the SHA to appear as a complete quoted string value — bounded on both sides by
 * a quote character (double, single or backtick: the production minifier rewrites the `define`d
 * JSON literal into a template literal, measured on the live Production entry bundle at P150,
 * where a pattern accepting only double/single quotes rejected a correct build).
 * `"<sha>"` matches only the exact clean value; `"<sha>+dirty"` does
 * not match the pattern for `<sha>` because the character immediately after the SHA is `+`, not
 * a closing quote. This mirrors exactly how the value is actually embedded (`JSON.stringify()`
 * via esbuild `define`, vite.config.ts), so it accepts exactly what a correct build produces and
 * rejects exactly what a wrong one does — no dirty suffix, no prefix/suffix contamination, no
 * partial match against an unrelated hex string that merely starts or ends the same way.
 */

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * @param {string} bundleText the built/served JS to search
 * @param {string} sha the exact expected value (a 40-hex commit SHA, or that plus "+dirty")
 * @returns {boolean} true only if `sha` appears as a complete quoted string value, not merely
 *   as a substring of a longer token
 */
export function bundleDeclaresExactSha(bundleText, sha) {
  if (!sha) return false
  // Opening and closing quote must be the SAME character (backreference), so a stray mixed-quote
  // fragment such as `"<sha>'` is not accepted as a declaration.
  const exactQuoted = new RegExp(`(["'\`])${escapeRegExp(sha)}\\1`)
  return exactQuoted.test(bundleText)
}
