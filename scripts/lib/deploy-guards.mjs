/**
 * Pure gating logic for the CI-gated Production deploy job (P130-08, P142).
 *
 * WHY THIS EXISTS. `.github/workflows/ci.yml`'s `deploy-production` job runs only after
 * `build-and-test` and `db-tests` succeed on a push to `main` — but by the time that job's own
 * build finishes (several minutes later), `main` may have advanced again. A job that deploys
 * whatever SHA it was originally triggered for, without re-checking, can overwrite a newer,
 * already-in-flight deploy with an older one ("SHA A CI green, main advances to SHA B, deploy
 * job builds and ships A over B" — GIT_WORKFLOW.md §11's own race description, one level in from
 * the Cloudflare-vs-CI race that section already covers). These two checks are the two points in
 * the job where that can still go wrong: is the SHA this job was triggered for still what `main`
 * actually points at right now, and does the artifact this job is about to upload actually declare
 * that exact SHA (not a stale/dirty one)? Kept here as pure functions — no process/filesystem
 * access — so both are unit-testable independently of the workflow YAML that calls them
 * (scripts/release-guard.mjs is the thin I/O wrapper; tests/config/deploy-guards.test.ts is the
 * regression suite).
 */

/**
 * @param {string} remoteMainSha the SHA `git ls-remote origin refs/heads/main` reports right now
 * @param {string} githubSha the SHA this workflow run was triggered for (`github.sha`)
 * @returns {boolean} true only if `main` still points at exactly the SHA this run is deploying —
 *   false for a stale run (main advanced), a missing/empty remote read, or a missing `githubSha`
 */
export function isRemoteMainCurrent(remoteMainSha, githubSha) {
  const remote = (remoteMainSha ?? '').trim()
  const expected = (githubSha ?? '').trim()
  if (!remote || !expected) return false
  return remote === expected
}

/**
 * @param {string} buildMetaText the raw contents of the just-built `dist/build-meta.json`
 * @param {string} githubSha the SHA this workflow run was triggered for (`github.sha`)
 * @returns {boolean} true only if the build declares EXACTLY this SHA — false for malformed JSON,
 *   a missing `sha` field, a `+dirty`-suffixed value, or any other commit's SHA. Deliberately exact
 *   string equality (not `.includes()`): `vite.config.ts`'s `resolveBuildSha()` appends `+dirty`
 *   when the checkout that produced the build had uncommitted changes, and a clean 40-hex SHA is a
 *   literal substring of `"<sha>+dirty"` — the same false-pass class P130-27/P139 already closed
 *   for the bundle-text version of this check (scripts/lib/build-identity.mjs), applied here to the
 *   build-meta.json artifact this job reads directly rather than re-parsing the JS bundle for it.
 */
export function isBuildIdentityExact(buildMetaText, githubSha) {
  const expected = (githubSha ?? '').trim()
  if (!expected) return false
  let parsed
  try {
    parsed = JSON.parse(buildMetaText)
  } catch {
    return false
  }
  return typeof parsed?.sha === 'string' && parsed.sha === expected
}
