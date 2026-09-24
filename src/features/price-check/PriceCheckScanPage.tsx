import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useAuth } from '../../auth/useAuth'
import type { ScanCandidate, ScanOutcome } from '../../domain/price-check/scan'
import type { CapturedFrame } from '../scanner/capture'
import { CardImage } from '../catalog/CardImage'
import { describeCaptureError } from '../scanner/errors'
import { FormMessage } from '../../ui/form'
import { CameraIcon } from '../../ui/icons'
import { narrowScannerPort, PriceCheckScanSession } from './scan-session'

/**
 * Price Check → Scan (P153). The photo is recognised by the existing on-device scanner through the
 * narrow `PriceCheckScanSession` port; the scanner proposes a card IDENTITY and this page asks the
 * person to confirm it. It never chooses a variant, never fetches a price itself, and has no route
 * to the scanner's acquisition path — leaving, cancelling or failing simply ends the session.
 *
 * Capture is the device's own photo picker (`capture="environment"` opens the native camera on
 * phones), so no camera stream is ever held by this page. The scanner code is loaded only once
 * this page opens; the text search page never touches it.
 */

type Step =
  | { readonly kind: 'idle'; readonly notice: string | null }
  | { readonly kind: 'analyzing'; readonly previewUrl: string }
  | {
      readonly kind: 'confirm'
      readonly outcome: Extract<ScanOutcome, { kind: 'high' | 'review' }>
    }
  | { readonly kind: 'no_match' }

function CandidateChoice({
  candidates,
  selectedId,
  onSelect,
}: {
  candidates: readonly ScanCandidate[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div role="radiogroup" aria-label="Scanned card candidates" className="space-y-2">
      {candidates.map((candidate) => {
        const selected = candidate.candidateId === selectedId
        return (
          <button
            key={candidate.candidateId}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid="scan-candidate"
            onClick={() => {
              onSelect(candidate.candidateId)
            }}
            className={`flex min-h-16 w-full items-center gap-3 rounded-xl border p-2 text-left focus-visible:outline-2 focus-visible:outline-sky-500 ${
              selected ? 'border-sky-500 bg-sky-600/20' : 'border-slate-700 hover:bg-slate-800'
            }`}
          >
            <CardImage
              imageBaseUrl={candidate.imageBaseUrl}
              alt=""
              quality="low"
              className="h-20 w-14 shrink-0"
            />
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm font-medium text-slate-100">
                {candidate.name}
              </span>
              <span className="block break-words text-xs text-slate-300">
                {candidate.setName ?? 'Unknown set'}
                {candidate.collectorNumber ? ` · #${candidate.collectorNumber}` : ''}
              </span>
              {candidate.languageLabel ? (
                <span className="block text-xs text-slate-400">{candidate.languageLabel}</span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function PriceCheckScanPage() {
  const { session: authSession } = useAuth()
  const userId = authSession?.user.id ?? null
  const navigate = useNavigate()
  const scanSessionRef = useRef<PriceCheckScanSession | null>(null)
  // Resolves to the session once the scanner has loaded (null if it could not be). A photo chosen
  // before that simply waits for it instead of failing.
  const sessionReadyRef = useRef<Promise<PriceCheckScanSession | null>>(Promise.resolve(null))
  const mountedRef = useRef(false)
  const [step, setStep] = useState<Step>({ kind: 'idle', notice: null })
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Set (not just cleared) on every mount so it survives StrictMode's mount/unmount/mount probe.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // One scanner session per mounted page and identity. Cleanup disposes it: an in-flight scan is
  // abandoned (its result is never delivered) and the OCR worker is released.
  useEffect(() => {
    let cancelled = false
    let created: PriceCheckScanSession | null = null
    sessionReadyRef.current = import('../scanner/controller')
      .then(({ getScannerUiController }) => {
        if (cancelled) return null
        const controller = getScannerUiController(userId)
        controller.prewarm?.()
        created = new PriceCheckScanSession(narrowScannerPort(controller))
        scanSessionRef.current = created
        return created
      })
      .catch(() => {
        if (!cancelled) {
          setStep({
            kind: 'idle',
            notice: 'The scanner could not be loaded. Search by name instead.',
          })
        }
        return null
      })
    return () => {
      cancelled = true
      created?.dispose()
      if (scanSessionRef.current === created) scanSessionRef.current = null
    }
  }, [userId])

  // The photo preview is an object URL over an in-memory blob; release it whenever it goes away.
  const previewUrl = step.kind === 'analyzing' ? step.previewUrl : null
  useEffect(() => {
    return () => {
      if (previewUrl !== null) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  // A function, not an inline `.current` test: the flag flips across awaits, which the compiler
  // would otherwise narrow away.
  function isMounted(): boolean {
    return mountedRef.current
  }

  function reset(notice: string | null): void {
    scanSessionRef.current?.cancel()
    setSelectedId(null)
    setStep({ kind: 'idle', notice })
  }

  function handleFilePicked(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    void (async () => {
      let frame: CapturedFrame
      try {
        const { decodeImageFile } = await import('../scanner/capture')
        frame = await decodeImageFile(file)
      } catch (error) {
        setStep({ kind: 'idle', notice: describeCaptureError(error).message })
        return
      }
      // Left the page while the photo was decoding: create nothing that would need releasing.
      if (!isMounted()) return
      const session = await sessionReadyRef.current
      if (session === null || !isMounted()) return
      const url = URL.createObjectURL(frame.blob)
      setSelectedId(null)
      setStep({ kind: 'analyzing', previewUrl: url })
      const result = await session.analyze({
        blob: frame.blob,
        width: frame.width,
        height: frame.height,
        cardRect: frame.cardRect,
      })
      // Cancelled / superseded / left the page: nothing to show, nothing to do.
      if (result.status === 'abandoned') return
      if (result.status === 'error') {
        setStep({ kind: 'idle', notice: result.message })
        return
      }
      const { outcome } = result
      if (outcome.kind === 'no_match') {
        setStep({ kind: 'no_match' })
        return
      }
      setSelectedId(outcome.kind === 'high' ? outcome.preselectedId : null)
      setStep({ kind: 'confirm', outcome })
    })()
  }

  function confirm(): void {
    if (selectedId === null) return
    // Identity only — the result page asks for the variant. Leaving unmounts this page, which
    // disposes the scanner session.
    void navigate({ to: '/price-check/$cardId', params: { cardId: selectedId } })
  }

  const pickerLabel =
    'inline-flex min-h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 text-sm font-semibold text-accent-foreground hover:bg-sky-500 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-sky-500'

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 py-2">
      <Link
        to="/price-check"
        className="inline-flex min-h-11 items-center text-sm text-sky-400 underline-offset-4 hover:underline"
      >
        ← Back to price check
      </Link>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">Scan a card</h1>
        <p className="text-sm text-slate-400">
          Photograph one card on a plain surface. You confirm which card it is before any price is
          shown — nothing is added to your collection.
        </p>
      </header>

      {step.kind === 'idle' ? (
        <div className="space-y-3">
          {step.notice !== null ? <FormMessage tone="error">{step.notice}</FormMessage> : null}
          <label className={pickerLabel}>
            <CameraIcon className="size-5" />
            Take or choose a photo
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={handleFilePicked}
            />
          </label>
          <p className="text-center text-sm">
            <Link to="/price-check" className="text-sky-400 underline-offset-4 hover:underline">
              Search by name instead
            </Link>
          </p>
        </div>
      ) : null}

      {step.kind === 'analyzing' ? (
        <div role="status" aria-live="polite" className="space-y-3">
          <img
            src={step.previewUrl}
            alt="Card being scanned"
            className="mx-auto max-h-72 rounded-lg border border-slate-700"
          />
          <p className="text-center text-sm text-slate-300">Recognising the card…</p>
          <button
            type="button"
            onClick={() => {
              reset(null)
            }}
            className="min-h-11 w-full rounded-lg border border-slate-700 px-4 text-sm font-medium text-slate-200 hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {step.kind === 'confirm' ? (
        <section aria-labelledby="scan-confirm-heading" className="space-y-3">
          <h2 id="scan-confirm-heading" className="text-sm font-semibold text-slate-300">
            {step.outcome.kind === 'high'
              ? 'Is this your card?'
              : 'Not sure — choose the right card'}
          </h2>
          {step.outcome.kind === 'review' ? (
            <p data-testid="scan-uncertain" className="text-sm text-slate-300">
              The scan could not identify this card with confidence. Nothing is selected for you.
            </p>
          ) : null}
          <CandidateChoice
            candidates={step.outcome.candidates}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          <button
            type="button"
            disabled={selectedId === null}
            onClick={confirm}
            className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-sky-600 px-4 text-sm font-semibold text-accent-foreground hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Check price
          </button>
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <button
              type="button"
              onClick={() => {
                reset(null)
              }}
              className="min-h-11 text-sky-400 underline-offset-4 hover:underline"
            >
              Scan another photo
            </button>
            <Link
              to="/price-check"
              className="inline-flex min-h-11 items-center text-sky-400 underline-offset-4 hover:underline"
            >
              None of these — search by name
            </Link>
          </div>
        </section>
      ) : null}

      {step.kind === 'no_match' ? (
        <section role="status" aria-live="polite" className="space-y-3">
          <p data-testid="scan-no-match" className="text-sm text-slate-300">
            This card was not recognised. Try a sharper, well-lit photo, or search by name.
          </p>
          <button
            type="button"
            onClick={() => {
              reset(null)
            }}
            className="min-h-11 w-full rounded-lg border border-slate-700 px-4 text-sm font-medium text-slate-200 hover:bg-slate-800"
          >
            Try another photo
          </button>
          <p className="text-center text-sm">
            <Link to="/price-check" className="text-sky-400 underline-offset-4 hover:underline">
              Search by name instead
            </Link>
          </p>
        </section>
      ) : null}
    </div>
  )
}
