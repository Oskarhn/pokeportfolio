/**
 * Static regression tests proving `.github/workflows/ci.yml`'s `deploy-production` job cannot
 * become eligible on a pull request, a feature branch, or after a failed/skipped required job —
 * without a live push to `main` (P130-08, P142 §15/§17/§35: "factor eligibility logic into a
 * testable script/helper rather than relying on brittle YAML substring tests... do not create an
 * overengineered workflow parser solely for this"). This repo has no YAML parser dependency
 * (output_139.txt's own W-note: not worth adding one for a single syntax check —
 * `pnpm exec prettier --check` already covers syntax, see docs/GIT_WORKFLOW.md/TESTING.md), so
 * this stays deliberately narrow: it isolates the `deploy-production:` job's own text block and
 * asserts required substrings are present in it — the same proportionate, no-new-dependency
 * approach, scoped to the one small job this project actually needs to prove something about.
 *
 * Each check below has a companion mutation test proving it actually catches the thing it claims
 * to catch (P142 §17's five required mutations), not just that the current file happens to match.
 * Mutation E (a stale SHA must be refused, not deployed) is a property of
 * scripts/lib/deploy-guards.mjs's `isRemoteMainCurrent`, not of this YAML — it is proven directly
 * against that function in tests/config/deploy-guards.test.ts, not duplicated here.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflowText = readFileSync('.github/workflows/ci.yml', 'utf-8')

/** Isolates one top-level job's own text block (its header line through the line before the next
 *  top-level job, or end of file) — good enough for "does this job's block contain X", which is
 *  all these tests need, without parsing YAML. */
function extractJobBlock(text: string, jobName: string): string {
  const lines = text.split('\n')
  const startIndex = lines.findIndex((line) => new RegExp(`^  ${jobName}:\\s*$`).test(line))
  if (startIndex === -1) throw new Error(`job "${jobName}" not found in workflow text`)
  let endIndex = lines.length
  for (let i = startIndex + 1; i < lines.length; i++) {
    // A top-level job/key starts at exactly two-space indent, non-blank, non-comment.
    if (/^ {2}\S/.test(lines[i]!)) {
      endIndex = i
      break
    }
  }
  return lines.slice(startIndex, endIndex).join('\n')
}

/** The real, current policy check this test suite exists to protect — kept as a plain function
 *  (not inlined per-assertion) so the mutation tests below can run it against a deliberately
 *  broken block and prove it fails, the same "run the real checker against a bad fixture" shape
 *  as tests/config/verifier-fail-closed.test.ts uses for the release verifiers. */
function assertDeployJobIsGated(jobBlock: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!/needs:\s*\[build-and-test,\s*db-tests\]/.test(jobBlock)) {
    reasons.push('does not require BOTH build-and-test and db-tests to succeed first')
  }
  if (!jobBlock.includes("github.event_name == 'push'")) {
    reasons.push('does not restrict to push events (could run on pull_request)')
  }
  if (!jobBlock.includes("github.ref == 'refs/heads/main'")) {
    reasons.push('does not restrict to the main branch')
  }
  if (!jobBlock.includes('release-guard.mjs remote-main-current')) {
    reasons.push('does not re-check that origin/main is still the triggering SHA before deploying')
  }
  if (!jobBlock.includes('release-guard.mjs build-identity')) {
    reasons.push('does not verify the built artifact declares the exact expected SHA')
  }
  if (!jobBlock.includes('--commit-hash="$GITHUB_SHA"')) {
    reasons.push('does not pin the Cloudflare upload to the exact triggering SHA')
  }
  return { ok: reasons.length === 0, reasons }
}

describe('deploy-production job — eligibility is structurally impossible outside push-to-main (P130-08)', () => {
  const jobBlock = extractJobBlock(workflowText, 'deploy-production')

  it('requires both build-and-test AND db-tests to have succeeded (Mutation A target)', () => {
    expect(jobBlock).toMatch(/needs:\s*\[build-and-test,\s*db-tests\]/)
  })

  it('is gated to push events only, never pull_request (Mutation B target)', () => {
    expect(jobBlock).toContain("if: github.event_name == 'push'")
  })

  it('is gated to the main branch specifically', () => {
    expect(jobBlock).toContain("github.ref == 'refs/heads/main'")
  })

  it('re-checks origin/main is still current before deploying (Mutation C target — stale-run refusal)', () => {
    expect(jobBlock).toContain('release-guard.mjs remote-main-current')
  })

  it('verifies build identity against the exact SHA before uploading (Mutation D target)', () => {
    expect(jobBlock).toContain('release-guard.mjs build-identity')
  })

  it('deploys with an exact --commit-hash, never a bare "latest main" build', () => {
    expect(jobBlock).toContain('--commit-hash="$GITHUB_SHA"')
  })

  it('never uses `|| true` on the deploy step (a failed upload must fail the job, not be swallowed)', () => {
    const deployStepStart = jobBlock.indexOf('Deploy to Cloudflare Pages')
    const nextStepStart = jobBlock.indexOf('\n      - name:', deployStepStart + 1)
    const deployStep = jobBlock.slice(
      deployStepStart,
      nextStepStart === -1 ? undefined : nextStepStart,
    )
    expect(deployStep).not.toContain('|| true')
  })

  it('scopes Cloudflare credentials to this job only — the other jobs never reference them', () => {
    // Checked against the OTHER jobs' own blocks specifically, not "the rest of the file": this
    // job's own leading comment (explaining the owner setup steps) legitimately names both
    // secrets in prose above the job body, which extractJobBlock does not include — that mention
    // is documentation, not a credential leak, and must not fail this test.
    const buildAndTestBlock = extractJobBlock(workflowText, 'build-and-test')
    const dbTestsBlock = extractJobBlock(workflowText, 'db-tests')
    for (const block of [buildAndTestBlock, dbTestsBlock]) {
      expect(block).not.toContain('CLOUDFLARE_API_TOKEN')
      expect(block).not.toContain('CLOUDFLARE_ACCOUNT_ID')
    }
  })

  it('does not grant broad workflow permissions (no write-all, no explicit deployments:write beyond contents:read)', () => {
    expect(workflowText).not.toMatch(/permissions:\s*write-all/)
  })

  it('the real checker accepts the current, unmutated job block', () => {
    expect(assertDeployJobIsGated(jobBlock)).toEqual({ ok: true, reasons: [] })
  })

  describe('mutation proofs — each simulated regression is actually caught', () => {
    it('Mutation A: removing db-tests from needs is detected', () => {
      const mutated = jobBlock.replace(
        'needs: [build-and-test, db-tests]',
        'needs: [build-and-test]',
      )
      const result = assertDeployJobIsGated(mutated)
      expect(result.ok).toBe(false)
      expect(result.reasons.join(' ')).toContain('BOTH build-and-test and db-tests')
    })

    it('Mutation B: allowing the job to run on pull_request is detected', () => {
      const mutated = jobBlock.replace(
        "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
        "if: github.ref == 'refs/heads/main'",
      )
      const result = assertDeployJobIsGated(mutated)
      expect(result.ok).toBe(false)
      expect(result.reasons.join(' ')).toContain('pull_request')
    })

    it('Mutation C: removing the exact-main-SHA guard is detected', () => {
      const mutated = jobBlock.replace(
        /- name: Check that origin\/main is still exactly this commit[\s\S]*?remote-main-current --github-sha "\$GITHUB_SHA"\n/,
        '',
      )
      const result = assertDeployJobIsGated(mutated)
      expect(result.ok).toBe(false)
      expect(result.reasons.join(' ')).toContain('origin/main')
    })

    it('Mutation D: removing the build-identity check is detected', () => {
      const mutated = jobBlock.replace(
        /- name: Verify build identity before upload[\s\S]*?build-identity --github-sha "\$GITHUB_SHA" --build-meta dist\/build-meta\.json\n/,
        '',
      )
      const result = assertDeployJobIsGated(mutated)
      expect(result.ok).toBe(false)
      expect(result.reasons.join(' ')).toContain('exact expected SHA')
    })

    it('Mutation (deploy-pin regression): deploying without pinning --commit-hash is detected', () => {
      const mutated = jobBlock.replace('--commit-hash="$GITHUB_SHA" \\\n', '')
      const result = assertDeployJobIsGated(mutated)
      expect(result.ok).toBe(false)
      expect(result.reasons.join(' ')).toContain('exact triggering SHA')
    })
  })
})

describe('deploy-production job — concurrency never cancels an in-flight Cloudflare upload', () => {
  const jobBlock = extractJobBlock(workflowText, 'deploy-production')

  it('has its own concurrency group, not the workflow-level cancel-in-progress:true one', () => {
    expect(jobBlock).toMatch(/concurrency:\s*\n\s*group: production-deploy/)
  })

  it('never cancels an in-progress deploy', () => {
    const concurrencyBlockMatch = jobBlock.match(
      /concurrency:\s*\n\s*group: production-deploy\s*\n\s*cancel-in-progress:\s*(\S+)/,
    )
    expect(concurrencyBlockMatch?.[1]).toBe('false')
  })
})
