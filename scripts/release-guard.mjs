#!/usr/bin/env node
/**
 * CI-only I/O wrapper around scripts/lib/deploy-guards.mjs (P130-08, P142). Two subcommands, each
 * used at a different point in `.github/workflows/ci.yml`'s `deploy-production` job:
 *
 *   node scripts/release-guard.mjs remote-main-current --github-sha <sha>
 *     Re-checks `git ls-remote origin refs/heads/main` against the SHA this job was triggered for.
 *     NEVER fails the job on a mismatch — a stale run is an expected, benign outcome once a newer
 *     push has already taken over deployment (GIT_WORKFLOW.md §11's "latest eligible main wins").
 *     Always exits 0; writes `current=true`/`current=false` to $GITHUB_OUTPUT (or stdout outside
 *     CI) so the calling workflow can gate the remaining steps with
 *     `if: steps.<id>.outputs.current == 'true'` instead of failing red for a benign race.
 *
 *   node scripts/release-guard.mjs build-identity --github-sha <sha> --build-meta <path>
 *     Reads the just-built dist/build-meta.json and requires it to declare exactly this SHA.
 *     Exits 1 (hard failure — this is a real defect, never a benign race) on any mismatch, missing
 *     file, or malformed JSON. "Do not deploy" per GIT_WORKFLOW.md §11's build-identity clause.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, appendFileSync } from 'node:fs'
import { isRemoteMainCurrent, isBuildIdentityExact } from './lib/deploy-guards.mjs'

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
} else {
  console.error('Usage: node scripts/release-guard.mjs remote-main-current --github-sha <sha>')
  console.error(
    '       node scripts/release-guard.mjs build-identity --github-sha <sha> --build-meta <path>',
  )
  process.exit(1)
}
