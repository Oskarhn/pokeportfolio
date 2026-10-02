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
