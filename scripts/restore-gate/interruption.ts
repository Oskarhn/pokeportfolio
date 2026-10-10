/**
 * Interruption handling for the owner-operated deletion proof (P200, P206).
 *
 * Split out of owner-deletion-proof.ts so the part that matters can be exercised as a real process
 * without a Supabase project, a registry or a backup: this module has no network, registry or
 * Supabase access of its own. It only turns "how far did the run get" (describeInterruption) into
 * a fixed message on stderr, a summary file, and an exit.
 *
 * Signals on Windows (Node documents this): Ctrl+C is delivered as SIGINT, Ctrl+Break as SIGBREAK
 * and closing the console window as SIGHUP; a SIGTERM listener is accepted but nothing ever raises
 * it, and `process.kill(pid, 'SIGTERM')` terminates the process without running any handler. A kill
 * from Task Manager or `Stop-Process` is therefore unobservable from inside the process on Windows -
 * the operator-facing rule is the same everywhere: if the request may have left, do not re-run.
 */
import {
  describeInterruption,
  type InterruptionFacts,
  type InterruptionReport,
} from './deletion-proof-core'

/** Every signal an operator can plausibly use to stop the tool on Linux, macOS or Windows. */
export const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const

export interface InterruptionDeps {
  /** How far the run got. Read when the signal arrives, not when the handler is created. */
  facts: () => InterruptionFacts
  /** Where the fixed message goes (stderr). */
  writeStderr: (text: string) => void
  /** Records the report next to the other results. A failure here is swallowed: stderr is the record. */
  persist: (report: InterruptionReport) => void
  exit: (code: number) => never
}

/**
 * Returns the one handler for every signal and for the Ctrl+C read from a raw-mode prompt.
 * Idempotent: a second signal while the report is being written exits at once with the same code
 * and writes nothing twice.
 */
export function createInterruptionHandler(deps: InterruptionDeps): () => never {
  let reported: InterruptionReport | null = null
  return (): never => {
    if (reported === null) {
      reported = describeInterruption(deps.facts())
      deps.writeStderr(`\n${reported.lines.join('\n')}\n`)
      try {
        deps.persist(reported)
      } catch {
        // the console output above is the record
      }
    }
    return deps.exit(reported.exitCode)
  }
}

export function installInterruptionHandlers(
  handler: () => never,
  proc: Pick<NodeJS.Process, 'on'> = process,
  signals: readonly NodeJS.Signals[] = INTERRUPT_SIGNALS,
): void {
  for (const signal of signals) proc.on(signal, handler)
}

/** The record written next to the other results when a run is interrupted. Fixed fields only. */
export function interruptionSummary(
  facts: InterruptionFacts,
  report: InterruptionReport,
  results: readonly unknown[],
): Record<string, unknown> {
  return {
    stopped: true,
    interrupted: report.phase,
    deletionRequestSent: facts.requestSent,
    deleted: facts.deleted,
    results,
  }
}
