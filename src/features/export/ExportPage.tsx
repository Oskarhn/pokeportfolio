import { useEffect, useReducer, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Button, FormMessage } from '../../ui/form'
import { ArchiveIcon, CheckIcon, DownloadIcon } from '../../ui/icons'
import { getExportController } from './controller'
import type { ExportArtifact, ExportController, ExportKind } from './contract'
import { reduceExportFlow, describeReady, type ExportFlowState } from './exportFlow'
import { canShareFiles, deliverFiles, downloadOnly, type DeliveryOutcome } from './fileDelivery'
import { markReminderSatisfied } from '../../domain/export/export-reminder'

/**
 * Profile › Export & backup (M13; UX_FLOWS.md F11's Settings › Export home).
 *
 * TWO-STEP FLOW (D-078): step 1 generates the artifacts completely ("Create backup" /
 * "Prepare CSV export"); the READY state then offers a fresh "Save / Share" button whose tap
 * calls navigator.share() / the download path immediately under a new transient user
 * activation. Sharing across an awaited generation is what threw NotAllowedError on installed
 * iOS PWAs; this split removes that failure mode instead of catching it.
 *
 * Generated artifacts live in component state only — never localStorage or IndexedDB — and are
 * dropped on discard, replacement or unmount. Nothing about their contents is ever logged.
 */

const DONE_VERB: Record<Exclude<DeliveryOutcome['method'], 'cancelled'>, string> = {
  share: 'Shared',
  'save-picker': 'Saved',
  download: 'Downloaded',
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function ExportPage({
  controller = getExportController(),
}: {
  controller?: ExportController
}) {
  const [flow, dispatch] = useReducer(reduceExportFlow, { phase: 'idle' } as ExportFlowState)
  const [shareAvailable, setShareAvailable] = useState(true)
  const runningRef = useRef(false)

  // Artifacts are memory-only for exactly as long as the flow needs them.
  useEffect(() => {
    return () => {
      dispatch({ type: 'DISCARD' })
    }
  }, [])

  async function prepare(kind: ExportKind) {
    if (runningRef.current) return
    runningRef.current = true
    dispatch({ type: 'PREPARE', kind })
    try {
      const artifacts =
        kind === 'backup' ? await controller.createBackup() : await controller.createCsvExport()
      setShareAvailable(canShareFiles(artifacts))
      dispatch({ type: 'PREPARED', kind, artifacts })
    } catch (error) {
      dispatch({
        type: 'PREPARE_FAILED',
        kind,
        message: errorMessage(error, 'Something went wrong while creating your export.'),
      })
    } finally {
      runningRef.current = false
    }
  }

  function readyArtifacts(flow: ExportFlowState): readonly ExportArtifact[] | null {
    return flow.phase === 'ready' || flow.phase === 'delivery-failed' || flow.phase === 'cancelled'
      ? flow.artifacts
      : null
  }

  const artifacts = readyArtifacts(flow)
  const readyKind =
    flow.phase === 'ready' || flow.phase === 'delivery-failed' || flow.phase === 'cancelled'
      ? flow.kind
      : null

  const busy = flow.phase === 'preparing' || flow.phase === 'delivering'

  async function deliver() {
    if (artifacts === null || readyKind === null || runningRef.current) return
    runningRef.current = true
    dispatch({ type: 'DELIVER' })
    try {
      const outcome = await deliverFiles(artifacts)
      if (outcome.method !== 'cancelled') markReminderSatisfied(window.localStorage)
      dispatch({ type: 'DELIVERED', outcome })
    } catch (error) {
      dispatch({
        type: 'DELIVERY_FAILED',
        message: errorMessage(error, 'Something went wrong while saving your export.'),
      })
    } finally {
      runningRef.current = false
    }
  }

  async function deliverAsDownload() {
    if (artifacts === null || readyKind === null || runningRef.current) return
    runningRef.current = true
    dispatch({ type: 'DELIVER' })
    try {
      const outcome = await downloadOnly(artifacts)
      markReminderSatisfied(window.localStorage)
      dispatch({ type: 'DELIVERED', outcome })
    } catch (error) {
      dispatch({
        type: 'DELIVERY_FAILED',
        message: errorMessage(error, 'Something went wrong while saving your export.'),
      })
    } finally {
      runningRef.current = false
    }
  }

  return (
    <div className="mx-auto w-full max-w-md space-y-5 py-2 pb-24">
      <Link to="/profile" className="text-sm text-sky-400 underline-offset-4 hover:underline">
        ← Back to Profile
      </Link>

      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">Export &amp; backup</h1>
        <p className="mt-1 text-sm text-slate-400">
          Your data is fetched from your account, then turned into these files on your device. The
          files themselves are never uploaded.
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
            void prepare('csv')
          }}
          disabled={busy}
          aria-label="Prepare CSV export"
        >
          Prepare CSV export
        </Button>
      </section>

      <section className="space-y-3 rounded-2xl border border-slate-800 p-4">
        <div className="flex items-start gap-3">
          <ArchiveIcon className="mt-0.5 size-5 shrink-0 text-slate-400" />
          <div className="min-w-0 space-y-1">
            <h2 className="text-sm font-semibold text-slate-200">Backup</h2>
            <p className="text-sm text-slate-400">
              One versioned JSON file containing your full Portfolio data. Keep it somewhere safe.
              Restore isn&apos;t built yet — backups carry a schema version so a future restore
              feature has what it needs, but compatibility isn&apos;t guaranteed in advance.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            void prepare('backup')
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

      {/* One live region for every phase so screen readers hear progress, readiness, success,
          cancellation and failure alike — none conveyed by colour alone. */}
      <div aria-live="polite" aria-busy={busy}>
        {flow.phase === 'preparing' ? (
          <p role="status" className="text-sm text-slate-300">
            Preparing…
          </p>
        ) : null}

        {flow.phase === 'delivering' ? (
          <p role="status" className="text-sm text-slate-300">
            Saving…
          </p>
        ) : null}

        {flow.phase === 'ready' ? (
          <ReadyPanel
            kind={describeReady(flow.kind)}
            artifacts={flow.artifacts}
            shareAvailable={shareAvailable}
            busy={busy}
            onDeliver={() => {
              void deliver()
            }}
            onDiscard={() => {
              dispatch({ type: 'DISCARD' })
            }}
          />
        ) : null}

        {flow.phase === 'success' ? (
          <div className="space-y-1 rounded-lg border border-emerald-900/60 bg-emerald-950/40 p-3 text-sm text-emerald-100">
            <p className="flex items-center gap-2 font-medium">
              <CheckIcon className="size-4 shrink-0" />
              {DONE_VERB[flow.outcome.method]}
              {flow.outcome.filenames.length > 1 ? ` ${flow.outcome.filenames.length} files` : ''}
            </p>
            {flow.outcome.filenames.map((filename) => (
              <p key={filename} className="break-all font-mono text-xs text-emerald-200/90">
                {filename}
              </p>
            ))}
            {flow.outcome.method === 'share' ? (
              <p className="text-xs text-emerald-200/80">
                Choose where to keep it — for example Save to Files.
              </p>
            ) : null}
          </div>
        ) : null}

        {flow.phase === 'cancelled' ? (
          <div className="space-y-2">
            <p role="status" className="text-sm text-slate-400">
              Cancelled — nothing was saved or shared. The files are still ready, so you can try
              again without regenerating.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => {
                  void deliver()
                }}
                disabled={busy}
              >
                Save / Share {describeReady(flow.kind)}
              </Button>
              <Button
                type="button"
                variant="quiet"
                onClick={() => {
                  void deliverAsDownload()
                }}
                disabled={busy}
              >
                Download instead
              </Button>
            </div>
          </div>
        ) : null}

        {flow.phase === 'prepare-failed' ? (
          <div className="space-y-2">
            <FormMessage tone="error">{flow.message}</FormMessage>
            <Button
              type="button"
              variant="quiet"
              onClick={() => {
                void prepare(flow.kind)
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {flow.phase === 'delivery-failed' ? (
          <div className="space-y-2">
            <FormMessage tone="error">{flow.message}</FormMessage>
            <Button
              type="button"
              onClick={() => {
                void deliver()
              }}
              disabled={busy}
            >
              Try sharing again
            </Button>
            <Button
              type="button"
              variant="quiet"
              onClick={() => {
                void deliverAsDownload()
              }}
              disabled={busy}
            >
              Download instead
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ReadyPanel({
  kind,
  artifacts,
  shareAvailable,
  busy,
  onDeliver,
  onDiscard,
}: {
  kind: string
  artifacts: readonly ExportArtifact[]
  shareAvailable: boolean
  busy: boolean
  onDeliver: () => void
  onDiscard: () => void
}) {
  return (
    <div className="space-y-3 rounded-lg border border-sky-900/60 bg-sky-950/30 p-3">
      <p role="status" className="text-sm font-medium text-slate-200">
        Ready — {kind}
        {artifacts.length > 1 ? `, ${String(artifacts.length)} files` : ''}
      </p>
      {artifacts.map((artifact) => (
        <p key={artifact.filename} className="break-all font-mono text-xs text-slate-300">
          {artifact.filename}
        </p>
      ))}
      {!shareAvailable && artifacts.length > 1 ? (
        <p className="text-xs text-slate-400">
          Your browser will download these one by one and may ask permission to download multiple
          files.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onDeliver} disabled={busy}>
          Save / Share {kind}
        </Button>
        <Button type="button" variant="quiet" onClick={onDiscard} disabled={busy}>
          Discard
        </Button>
      </div>
    </div>
  )
}
