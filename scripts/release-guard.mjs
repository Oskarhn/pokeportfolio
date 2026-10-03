#!/usr/bin/env node
/**
 * CI-only I/O wrapper around scripts/lib/deploy-guards.mjs (P130-08, P142). Two subcommands, each
 * used at a different point in `.github/workflows/ci.yml`'s `deploy-production` job:
 *
 *   node scripts/release-guard.mjs remote-main-current --github-sha <sha>
 *     Re-checks `git ls-remote origin refs/heads/main` against the SHA this job was triggered for.
 *     NEVER fails the job on a PROVEN mismatch — a stale run is an expected, benign outcome once a
 *     newer push has already taken over deployment (GIT_WORKFLOW.md §11's "latest eligible main
 *     wins"). Exits 0 then. An UNREADABLE origin is not a proven mismatch and exits 1 (P163): a
 *     green job that deployed nothing because it could not look is a false success. Writes `current=true`/`current=false` to $GITHUB_OUTPUT (or stdout outside
 *     CI) so the calling workflow can gate the remaining steps with
 *     `if: steps.<id>.outputs.current == 'true'` instead of failing red for a benign race.
 *
 *   node scripts/release-guard.mjs build-identity --github-sha <sha> --build-meta <path>
 *     Reads the just-built dist/build-meta.json and requires it to declare exactly this SHA.
 *     Exits 1 (hard failure — this is a real defect, never a benign race) on any mismatch, missing
 *     file, or malformed JSON. "Do not deploy" per GIT_WORKFLOW.md §11's build-identity clause.
 *
 *   node scripts/release-guard.mjs verify-release-sha --sha <40-hex> [--main-ref origin/main]
 *       [--repo owner/name] [--checks-file <json>]
 *     P193, used by `.github/workflows/deploy-production.yml` (manual dispatch only). Fails closed
 *     unless the SHA is a full 40-hex commit that exists, is an ancestor of (or equal to) the main
 *     ref, and build-and-test, db-tests and native-checks all succeeded on that exact SHA (GitHub
 *     check-runs API with GITHUB_TOKEN, or `--checks-file` offline). Writes `sha=<sha>` to
 *     $GITHUB_OUTPUT. `remote-main-current` above is the pre-P193 "latest main wins" guard and no
 *     workflow calls it any more.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, appendFileSync } from 'node:fs'
import { isRemoteMainCurrent, isBuildIdentityExact } from './lib/deploy-guards.mjs'
import { evaluateRequiredChecks, isFullSha } from './lib/release-verify.mjs'

const args = process.argv.slice(2)
const subcommand = args[0]

function argValue(name) {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}

function writeOutput(name, value) {
  const target = process.env.GITHUB_OUTPUT
  if (target) {
    appendFileSync(target, `${name}=${value}\n`)
  } else {
    console.log(`${name}=${value}`)
  }
}

if (subcommand === 'remote-main-current') {
  const githubSha = argValue('github-sha') ?? process.env.GITHUB_SHA
  let remoteMainSha = ''
  try {
    // `git ls-remote` output: "<sha>\trefs/heads/main\n"
    const raw = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
      encoding: 'utf-8',
    })
    remoteMainSha = raw.split(/\s+/)[0] ?? ''
  } catch (error) {
    console.error(`release-guard: could not read origin/main — ${String(error)}`)
  }
  if (!remoteMainSha) {
    // Unreadable is not stale: skipping here would end the job green having deployed nothing.
    console.error('release-guard: origin/main could not be read — failing instead of skipping')
    writeOutput('current', 'false')
    process.exit(1)
  }
  const current = isRemoteMainCurrent(remoteMainSha, githubSha)
  console.log(
    current
      ? `release-guard: main is still at ${githubSha} — proceeding`
      : `release-guard: STALE RUN — this job was triggered for ${githubSha ?? '(unknown)'} but ` +
          `origin/main is now at ${remoteMainSha || '(unreadable)'}; a newer push already owns ` +
          `deployment. Skipping the remaining steps successfully, not failing.`,
  )
  writeOutput('current', String(current))
  process.exit(0)
} else if (subcommand === 'build-identity') {
  const githubSha = argValue('github-sha') ?? process.env.GITHUB_SHA
  const buildMetaPath = argValue('build-meta')
  if (!buildMetaPath) {
    console.error('release-guard build-identity: --build-meta <path> is required')
    process.exit(1)
  }
  let text = ''
  try {
    text = readFileSync(buildMetaPath, 'utf-8')
  } catch (error) {
    console.error(`release-guard: could not read ${buildMetaPath} — ${String(error)}`)
    process.exit(1)
  }
  if (isBuildIdentityExact(text, githubSha)) {
    console.log(`release-guard: ${buildMetaPath} declares exactly ${githubSha} — build identity OK`)
    process.exit(0)
  }
  console.error(
    `release-guard: BUILD IDENTITY MISMATCH — expected exactly "${githubSha}" in ${buildMetaPath}, ` +
      `got: ${text.trim()}. Refusing to deploy an artifact that does not declare the SHA it was ` +
      `built from.`,
  )
  process.exit(1)
} else if (subcommand === 'verify-release-sha') {
  await verifyReleaseSha()
} else {
  console.error('       node scripts/release-guard.mjs verify-release-sha --sha <40-hex>')
  console.error('Usage: node scripts/release-guard.mjs remote-main-current --github-sha <sha>')
  console.error(
    '       node scripts/release-guard.mjs build-identity --github-sha <sha> --build-meta <path>',
  )
  process.exit(1)
}

function failVerify(message) {
  console.error(`release-guard verify-release-sha: ${message}`)
  process.exit(1)
}

async function verifyReleaseSha() {
  const sha = argValue('sha')
  const mainRef = argValue('main-ref') ?? 'origin/main'
  if (!isFullSha(sha)) {
    failVerify('--sha must be a full lowercase 40-hex commit SHA (no branch, tag or short SHA)')
  }
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' })
  } catch {
    failVerify(`commit ${sha} does not exist in this checkout`)
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, mainRef], { stdio: 'ignore' })
  } catch {
    failVerify(`commit ${sha} is not reachable from ${mainRef}`)
  }

  let checkRuns
  const checksFile = argValue('checks-file')
  if (checksFile) {
    try {
      checkRuns = JSON.parse(readFileSync(checksFile, 'utf-8')).check_runs
    } catch (error) {
      failVerify(`could not read --checks-file: ${String(error)}`)
    }
  } else {
    const repo = argValue('repo') ?? process.env.GITHUB_REPOSITORY
    const token = process.env.GITHUB_TOKEN
    if (!repo || !token) failVerify('--repo (or GITHUB_REPOSITORY) and GITHUB_TOKEN are required')
    const response = await fetch(
      `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )
    if (!response.ok) failVerify(`GitHub check-runs API answered HTTP ${String(response.status)}`)
    checkRuns = (await response.json()).check_runs
  }

  const verdict = evaluateRequiredChecks(checkRuns)
  if (!verdict.ok) {
    failVerify(
      `required CI is not green on ${sha} — missing: [${verdict.missing.join(', ')}], ` +
        `not successful: [${verdict.notGreen.join(', ')}]`,
    )
  }
  console.log(`release-guard: ${sha} is on ${mainRef} and all required checks succeeded`)
  writeOutput('sha', sha)
}
