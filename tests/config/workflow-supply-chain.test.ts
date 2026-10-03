/**
 * Supply-chain pins for `.github/workflows/*.yml` (P130-29, P190). The repository is public, so a
 * mutable action tag or container tag is a way for a third party to change what runs with this
 * repository's CI token. Every `uses:` must name a full 40-hex commit SHA, and no `docker run`
 * image may use `:latest` or a digest-less tag. Static text checks only (no YAML parser dependency,
 * same approach as workflow-deploy-gate.test.ts), each with a mutation proving it can fail.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const WORKFLOW_DIR = '.github/workflows'
const SHA256_PIN = /@sha256:[0-9a-f]{64}$/

/** `uses:` references that are not pinned to a full commit SHA (local `./` actions are fine). */
function unpinnedActionRefs(text: string): string[] {
  const bad: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line)
    if (!m) continue
    const ref = m[1]!
    if (ref.startsWith('./')) continue
    if (!/@[0-9a-f]{40}$/.test(ref)) bad.push(ref)
  }
  return bad
}

/** Every container image named by a `docker run ... \` line: the first token on the next line. */
function dockerImages(text: string): string[] {
  const images: string[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/docker run\b/.test(lines[i]!) || !lines[i]!.trimEnd().endsWith('\\')) continue
    const next = lines[i + 1]?.trim().split(/\s+/)[0]
    if (next) images.push(next)
  }
  return images
}

/** Images that use `:latest` or carry no digest pin. */
function unpinnedDockerImages(text: string): string[] {
  return dockerImages(text).filter((image) => !SHA256_PIN.test(image) || /:latest@/.test(image))
}

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ file: f, text: readFileSync(`${WORKFLOW_DIR}/${f}`, 'utf-8') }))

describe('workflow supply chain', () => {
  it('judges at least one workflow, and the extractor sees the pinned secret-scan image', () => {
    expect(workflows.length).toBeGreaterThan(0)
    const ci = workflows.find((w) => w.file === 'ci.yml')!
    expect(dockerImages(ci.text).some((i) => i.startsWith('zricethezav/gitleaks:v'))).toBe(true)
  })

  for (const { file, text } of workflows) {
    it(`${file}: every action is pinned to a full commit SHA`, () => {
      expect(unpinnedActionRefs(text)).toEqual([])
    })

    it(`${file}: no docker image is mutable (:latest or digest-less)`, () => {
      expect(unpinnedDockerImages(text)).toEqual([])
      expect(text).not.toMatch(/gitleaks:latest/)
    })
  }

  it('mutation: a tag-pinned action is detected, a SHA-pinned one is not', () => {
    expect(unpinnedActionRefs('      - uses: actions/checkout@v5\n')).toEqual([
      'actions/checkout@v5',
    ])
    expect(
      unpinnedActionRefs(
        '      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0\n',
      ),
    ).toEqual([])
  })

  it('mutation: a :latest or digest-less docker image is detected, a digest-pinned one is not', () => {
    const run = (image: string) =>
      `          docker run --rm -v "$PWD:/repo" \\\n            ${image} detect --source=/repo\n`
    expect(unpinnedDockerImages(run('zricethezav/gitleaks:latest'))).toEqual([
      'zricethezav/gitleaks:latest',
    ])
    expect(unpinnedDockerImages(run('zricethezav/gitleaks:v8.30.1'))).toEqual([
      'zricethezav/gitleaks:v8.30.1',
    ])
    expect(
      unpinnedDockerImages(run(`zricethezav/gitleaks:v8.30.1@sha256:${'a'.repeat(64)}`)),
    ).toEqual([])
  })
})

/**
 * P191 (P130-29) — the remaining mutable build inputs, closed or classified.
 *
 *   IMMUTABLY_PINNED  actions (commit SHA), the gitleaks image (digest), pnpm (corepack sha512)
 *   VERSION_PINNED    Node (.nvmrc exact), Playwright + browsers, Supabase CLI and the container
 *                     images it starts, wrangler — all by the locked package version, not a hash
 *   MUTABLE_TAG       none left that this repository selects (the Supabase stack images are chosen
 *                     by the CLI version, not by a tag in this repository)
 *   runner            `ubuntu-24.04`, never `*-latest` (the image a job runs on is a build input)
 * docs/security/P191_SECURITY_BOUNDARY_CLOSURE.md records each with its update mechanism.
 */
describe('workflow supply chain — P191 additions', () => {
  for (const { file, text } of workflows) {
    it(`${file}: runners are a named image, not *-latest`, () => {
      expect(text).not.toMatch(/runs-on:\s*\S*-latest/)
    })

    it(`${file}: no remote script is piped into a shell and nothing is fetched ad hoc`, () => {
      expect(text).not.toMatch(/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/)
      expect(text).not.toMatch(/\b(?:npx|pnpm dlx|bunx)\b/)
    })

    it(`${file}: every dependency install honours the lockfile`, () => {
      const installs = text
        .split('\n')
        .filter((l) => /\bpnpm(?:\s+--dir\s+\S+)?\s+install\b/.test(l))
      expect(installs.length).toBeGreaterThan(0)
      for (const line of installs) expect(line).toMatch(/--frozen-lockfile/)
      expect(text).not.toMatch(/\bpnpm\s+(?:add|update|up)\b/)
    })

    it(`${file}: no action or image is selected by a floating ref`, () => {
      expect(text).not.toMatch(/uses:\s*\S+@(?:main|master|latest|v\d+(?:\.\d+)*)\s*$/m)
      expect(text).not.toMatch(/:latest\b/)
    })
  }

  it('pnpm is pinned with a content hash that corepack verifies', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as { packageManager: string }
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/)
  })

  it('Node is pinned to an exact version', () => {
    expect(readFileSync('.nvmrc', 'utf-8').trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('mutation: floating runners, piped installers and unfrozen installs are detected', () => {
    expect('runs-on: ubuntu-latest').toMatch(/runs-on:\s*\S*-latest/)
    expect('curl -fsSL https://x.sh | sh').toMatch(
      /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/,
    )
    expect('run: npx something').toMatch(/\b(?:npx|pnpm dlx|bunx)\b/)
    expect('uses: actions/checkout@main').toMatch(
      /uses:\s*\S+@(?:main|master|latest|v\d+(?:\.\d+)*)\s*$/m,
    )
  })
})
