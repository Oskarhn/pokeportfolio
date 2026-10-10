/**
 * P206: a stand-in process for the owner deletion proof, used by tests/ops/deletion-proof-
 * interruption.test.ts to deliver REAL signals / console control events.
 *
 *   node --import tsx tests/ops/fixtures/interruption-child.ts <before-send|outcome-unknown|after-answer> <outDir>
 *
 * It installs the same handler, with the same summary builder, as scripts/restore-gate/
 * owner-deletion-proof.ts and then idles. It has no Supabase, registry or backup access at all, and
 * it replaces `fetch` with a tripwire that records any use, so a test can prove an interruption
 * performs no request and no retry. Secret-looking environment variables are present on purpose:
 * the test asserts none of their values ever reaches an output or the summary file.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InterruptionFacts } from '../../../scripts/restore-gate/deletion-proof-core'
import {
  createInterruptionHandler,
  installInterruptionHandlers,
  interruptionSummary,
} from '../../../scripts/restore-gate/interruption'

const [phase, outDir] = process.argv.slice(2)
if (!phase || !outDir) {
  process.stderr.write('usage: interruption-child.ts <phase> <outDir>\n')
  process.exit(64)
}

const FACTS: Record<string, InterruptionFacts> = {
  'before-send': { requestSent: false, requestAnswered: false, deleted: false },
  'outcome-unknown': { requestSent: true, requestAnswered: false, deleted: false },
  'after-answer': { requestSent: true, requestAnswered: true, deleted: true },
}
const facts = FACTS[phase]
if (!facts) {
  process.stderr.write('unknown phase\n')
  process.exit(64)
}

mkdirSync(outDir, { recursive: true })

// Tripwire: an interruption must never reach the network (no request, no retry).
globalThis.fetch = (): never => {
  writeFileSync(join(outDir, 'NETWORK_USED'), 'fetch was called')
  throw new Error('network is not available in this fixture')
}

// A registry file the fixture creates and never touches again: the test compares its hash.
const registryFile = join(outDir, 'registry.ndjson')
writeFileSync(registryFile, '{"seq":1}\n')
writeFileSync(
  join(outDir, 'registry.sha256'),
  createHash('sha256').update('{"seq":1}\n').digest('hex'),
)

const results = [{ gate: 'synthetic earlier gate', pass: true }]
const handler = createInterruptionHandler({
  facts: () => facts,
  writeStderr: (text) => process.stderr.write(text),
  persist: (report) => {
    writeFileSync(
      join(outDir, 'p197b-result.json'),
      JSON.stringify(interruptionSummary(facts, report, results), null, 2),
      { mode: 0o600 },
    )
  },
  exit: (code) => {
    // Recorded so a test that cannot observe the exit status of a console-attached process can.
    writeFileSync(join(outDir, 'exit-code.txt'), String(code))
    return process.exit(code)
  },
})
installInterruptionHandlers(handler)

process.stdout.write('READY\n')
// Keep the event loop alive until a signal arrives.
setInterval(() => undefined, 1000)
