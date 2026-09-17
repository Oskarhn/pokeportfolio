/**
 * Reads the Cache-Control value declared inside ONE path block of a Cloudflare Pages `_headers`
 * file (P130-27, P139 fail-closed contract).
 *
 * WHY THIS EXISTS. The `_headers` file is a flat list of path blocks:
 *
 *   /scanner-assets/v7/*
 *     Cache-Control: public, max-age=31536000, immutable
 *
 *   /scanner-assets/visual-v1/index/current.json
 *     Cache-Control: no-cache
 *
 * The naive lookup `headersFile.slice(headersFile.indexOf(blockPath))` finds where a block
 * STARTS but never bounds where it ENDS, so a regex search for the next `Cache-Control:` line
 * happily walks past the current block's own (missing) directive and returns a LATER block's
 * value instead — a block with no Cache-Control rule at all would incorrectly report whatever
 * the next block down the file declares. That is a false PASS: the check "does this path have
 * an explicit immutable rule" can succeed on a `_headers` file where it has none, simply
 * because some other, unrelated path further down happens to declare one.
 *
 * This function bounds the search to the current block: from just after `blockPath` to the
 * next line that starts a new block (a line beginning with `/`), or end of file if this is the
 * last block. Every block path in this file's generator (vite.config.ts) starts at column 0
 * with `/`, and no Cache-Control value or comment line does, so `\n/` unambiguously marks the
 * next block boundary.
 */

/**
 * @param {string} headersText the full contents of dist/_headers
 * @param {string} blockPath the exact path pattern line to look up, e.g. "/scanner-assets/v7/*"
 * @returns {string | null} the trimmed Cache-Control value, or null if this block has none
 */
export function cacheControlForBlock(headersText, blockPath) {
  const blockIndex = headersText.indexOf(blockPath)
  if (blockIndex === -1) return null

  const searchStart = blockIndex + blockPath.length
  const nextBlockStart = headersText.indexOf('\n/', searchStart)
  const blockEnd = nextBlockStart === -1 ? headersText.length : nextBlockStart
  const scoped = headersText.slice(searchStart, blockEnd)

  const match = /Cache-Control:\s*(.+)/.exec(scoped)
  return match?.[1]?.trim() ?? null
}
