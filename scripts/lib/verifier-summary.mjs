/**
 * Shared pass/fail aggregation contract for every release verifier script
 * (deployment-check.mjs, preview-verify.mjs, verify-scanner-platform-build.mjs,
 * check-links.mjs).
 *
 * FAILS CLOSED (P130-27, P139): a run that skipped every check group (all `--skip` flags
 * combined, or any future code path that records nothing) proves nothing about the thing it
 * was supposed to verify. Before this module existed, each verifier computed its own exit
 * code from `failed.length ? 1 : 0` — an empty `failed` array from zero executed checks is
 * indistinguishable from an empty `failed` array from every check actually passing, so
 * `--skip <every group>` silently exited 0. A release gate that can be made to pass by
 * skipping everything is not a gate.
 *
 * One shared implementation so this contract only has to be right once, not independently
 * re-derived (and re-broken) in every verifier script.
 */

/**
 * @param {{ pass: boolean, skipped?: boolean }[]} results
 * @returns {{
 *   total: number,
 *   meaningfulCount: number,
 *   skippedCount: number,
 *   passedCount: number,
 *   failed: { pass: boolean, skipped?: boolean }[],
 *   ranNothing: boolean,
 *   ok: boolean,
 * }}
 */
export function summarizeResults(results) {
  const meaningful = results.filter((r) => !r.skipped)
  const failed = meaningful.filter((r) => !r.pass)
  const ranNothing = meaningful.length === 0
  return {
    total: results.length,
    meaningfulCount: meaningful.length,
    skippedCount: results.length - meaningful.length,
    passedCount: meaningful.length - failed.length,
    failed,
    ranNothing,
    ok: !ranNothing && failed.length === 0,
  }
}

/** Renders the final summary lines + sets the correct process exit code. Pure w.r.t. its
 *  `exit` callback (defaults to setting `process.exitCode`, injectable for tests). */
export function reportAndExit(results, { log = console.log, exit } = {}) {
  const summary = summarizeResults(results)
  if (summary.ranNothing) {
    log(
      '\nFAIL: every check was skipped — a verifier run that skipped everything proves nothing ' +
        'and can never report success (P130-27 fail-closed contract).',
    )
  } else {
    log(
      `\n${String(summary.passedCount)}/${String(summary.meaningfulCount)} checks passed` +
        (summary.skippedCount > 0 ? ` (${String(summary.skippedCount)} skipped)` : ''),
    )
    if (summary.failed.length) {
      log(`FAILED: ${summary.failed.length} check(s) did not pass`)
    }
  }
  const exitCode = summary.ok ? 0 : 1
  if (exit) {
    exit(exitCode)
  } else {
    process.exitCode = exitCode
  }
  return summary
}
