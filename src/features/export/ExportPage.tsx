import { useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Button, FormMessage } from '../../ui/form'
import { ArchiveIcon, CheckIcon, DownloadIcon } from '../../ui/icons'
import { getExportController } from './controller'
import type { ExportController, ExportKind, ExportProgressPhase } from './contract'
import { deliverFiles, type DeliveryOutcome } from './fileDelivery'

/**
 * Profile › Export & backup (M13; UX_FLOWS.md F11's Settings › Export home).
 *
 * Two actions, two different artifacts: CSV files for spreadsheets and analysis, and one
 * versioned JSON backup of the canonical data. Everything is generated on this device under the
 * signed-in account and delivered straight to the user — nothing is uploaded anywhere.
 *
 * The engine behind the actions arrives through `ExportController` (contract.ts); this screen has
 * no idea how rows are fetched or serialized. Restore/import does not exist yet and the copy says
 * so plainly.
 */

type RunState =
  | { phase: 'idle' }
  | { phase: 'running'; kind: ExportKind; label: string }
  | { phase: 'done'; kind: ExportKind; outcome: Exclude<DeliveryOutcome, { method: 'cancelled' }> }
  | { phase: 'cancelled'; kind: ExportKind }
  | { phase: 'error'; kind: ExportKind; message: string }

type DeliveredOutcome = Exclude<DeliveryOutcome, { method: 'cancelled' }>['method']

const DONE_VERB: Record<DeliveredOutcome, string> = {
  share: 'Shared',
  'save-picker': 'Saved',
  download: 'Downloaded',
}

export function ExportPage({
  controller = getExportController(),
}: {
  controller?: ExportController
}) {
  const [run, setRun] = useState<RunState>({ phase: 'idle' })
  const runningRef = useRef(false)

  async function runExport(kind: ExportKind) {
    if (runningRef.current) return // double-tap while running is one operation (prompt §12)
    runningRef.current = true
    setRun({ phase: 'running', kind, label: 'Preparing…' })
    try {
      const onProgress = (phase: ExportProgressPhase) => {
        if (phase === 'creating-files') {
          setRun({ phase: 'running', kind, label: 'Creating files…' })
        }
      }
      const artifacts =
        kind === 'backup'
          ? await controller.createBackup(onProgress)
          : await controller.createCsvExport(onProgress)
      const outcome = await deliverFiles(artifacts)
      if (outcome.method === 'cancelled') {
        setRun({ phase: 'cancelled', kind })
      } else {
        setRun({ phase: 'done', kind, outcome })
      }
    } catch (error) {
      setRun({
        phase: 'error',
        kind,
        message:
          error instanceof Error && error.message
            ? error.message
            : 'Something went wrong while creating your export.',
      })
    } finally {
      runningRef.current = false
    }
  }

  const busy = run.phase === 'running'

  return (
    <div className="mx-auto w-full max-w-md space-y-5 py-2 pb-24">
      <Link to="/profile" className="text-sm text-sky-400 underline-offset-4 hover:underline">
        ← Back to Profile
      </Link>

      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">Export &amp; backup</h1>
        <p className="mt-1 text-sm text-slate-400">
          Files are created on this device from your own account. Nothing is uploaded anywhere.
        </p>
      </div>

      <section className="space-y-3 rounded-2xl border border-slate-800 p-4">
        <div className="flex items-start gap-3">
          <DownloadIcon className="mt-0.5 size-5 shrink-0 text-slate-400" />
          <div className="min-w-0 space-y-1">
            <h2 className="text-sm font-semibold text-slate-200">CSV export</h2>
            <p className="text-sm text-slate-400">
              Spreadsheet-readable files covering your collection, purchases and sales — for
              analysis, records or tax work.
            </p>
          </div>
        </div>
        <Button
          type="button"
          onClick={() => {
            void runExport('csv')
          }}
          disabled={busy}
          aria-label="Export CSV files"
        >
          Export CSV
        </Button>
      </section>

      <section className="space-y-3 rounded-2xl border border-slate-800 p-4">
        <div className="flex items-start gap-3">
          <ArchiveIcon className="mt-0.5 size-5 shrink-0 text-slate-400" />
          <div className="min-w-0 space-y-1">
            <h2 className="text-sm font-semibold text-slate-200">Backup</h2>
            <p className="text-sm text-slate-400">
              One versioned JSON file containing your full Portfolio data. Keep it somewhere safe —
              restore isn&apos;t built yet, but a backup made now can be imported by that future
              capability.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            void runExport('backup')
          }}
          disabled={busy}
          aria-label="Create backup file"
        >
          Create backup
        </Button>
      </section>

      <p className="rounded-xl border border-dashed border-slate-800 p-3 text-xs text-slate-500">
        These files can contain your collection and purchase/sales history. Store them somewhere you
        trust.
      </p>

      {/* One live region for every outcome so screen readers hear progress, success, cancellation
          and failure alike — none of which rely on colour alone. */}
      <div aria-live="polite" aria-busy={busy}>
        {run.phase === 'running' ? (
          <p role="status" className="text-sm text-slate-300">
            {run.label}
          </p>
        ) : null}
        {run.phase === 'done' ? (
          <div className="space-y-1 rounded-lg border border-emerald-900/60 bg-emerald-950/40 p-3 text-sm text-emerald-100">
            <p className="flex items-center gap-2 font-medium">
              <CheckIcon className="size-4 shrink-0" />
              {DONE_VERB[run.outcome.method]}
              {run.outcome.filenames.length > 1 ? ` ${run.outcome.filenames.length} files` : ''}
            </p>
            {run.outcome.filenames.map((filename) => (
              <p key={filename} className="break-all font-mono text-xs text-emerald-200/90">
                {filename}
              </p>
            ))}
            {run.outcome.method === 'share' ? (
              <p className="text-xs text-emerald-200/80">
                Choose where to keep it — for example Save to Files.
              </p>
            ) : null}
          </div>
        ) : null}
        {run.phase === 'cancelled' ? (
          <p role="status" className="text-sm text-slate-400">
            Cancelled — nothing was saved or shared.
          </p>
        ) : null}
        {run.phase === 'error' ? (
          <div className="space-y-2">
            <FormMessage tone="error">{run.message}</FormMessage>
            <Button
              type="button"
              variant="quiet"
              onClick={() => {
                void runExport(run.kind)
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
