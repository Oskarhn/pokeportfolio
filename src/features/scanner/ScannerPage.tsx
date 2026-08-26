import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
} from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ScannerCandidate } from './contract'
import { getScannerUiController } from './controller'
import {
  CAMERA_VIDEO_PROPS,
  openEnvironmentCamera,
  stopActiveScannerCamera,
  visibilityChangeAction,
  type ManagedCameraSession,
} from './camera-session'
import { CaptureStore, captureVideoFrame, decodeImageFile } from './capture'
import {
  describeAnalysisError,
  describeCameraError,
  describeCaptureError,
  describeCommitError,
  describeSearchError,
  hasMediaDevicesSupport,
} from './errors'
import { initialScannerState, scannerReducer } from './state'
import { CardImage } from '../catalog/CardImage'
import { CONDITION_LABEL } from '../collection/labels'
import type { CardCondition } from '../../data/collection'
import { Button, ChoiceGroup, FormMessage, TextField } from '../../ui/form'
import { Sheet } from '../../ui/Sheet'
import { CheckIcon, CameraIcon, SearchIcon, XIcon } from '../../ui/icons'

/**
 * M15 scanner — camera capture and confirmation UX (P66). UI only: recognition runs through the
 * {@link ScannerUiController} seam (placeholder adapter until P68 wires the real engine), and no
 * Portfolio mutation happens anywhere in this file — commitBatch is the integration point.
 *
 * Layout: a fixed full-viewport overlay (z-[45]) that covers the app shell including the bottom
 * navigation while scanning. D-006 governs the whole route — one MediaStream for the session,
 * and nothing here navigates or touches the URL while a stream is live; exit stops the tracks
 * first and only then leaves the route.
 *
 * Memory ownership (prompt §21/§28): the live camera stream exists ONLY during the preview
 * steps; it is stopped the moment a frame is captured. The captured still lives solely in a
 * CaptureStore which revokes its object URL on every replacement/clear; after analysis answers
 * — and certainly once a card is confirmed into the batch — the photo is disposed. Batch items
 * hold identity + quantity/condition, never image data.
 */

const CONDITIONS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'] as const

export function ScannerPage() {
  const navigate = useNavigate()
  const controller = getScannerUiController()
  const [state, dispatch] = useReducer(scannerReducer, initialScannerState)
  const [searchName, setSearchName] = useState('')
  const [searchCollectorNumber, setSearchCollectorNumber] = useState('')
  // Render-time mirror of the capture store's preview URL. The store itself is the memory
  // owner (revokes on every replacement/clear); this state only decides what to draw.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sessionRef = useRef<ManagedCameraSession | null>(null)
  const captureStoreRef = useRef<CaptureStore>(new CaptureStore())
  // Bumped whenever the desire to hold a live stream ends; an in-flight getUserMedia whose
  // generation went stale stops its stream on arrival instead of leaking it.
  const cameraGenerationRef = useRef(0)

  const cameraWanted = state.step === 'starting-camera' || state.step === 'camera'

  // Open/close the single MediaStream as the machine enters/leaves the preview steps.
  useEffect(() => {
    if (!cameraWanted) {
      cameraGenerationRef.current += 1
      stopActiveScannerCamera()
      sessionRef.current = null
      return
    }
    const video = videoRef.current
    if (video === null || sessionRef.current !== null) return
    const generation = ++cameraGenerationRef.current
    let cancelled = false
    void openEnvironmentCamera(video)
      .then((session) => {
        if (cancelled || generation !== cameraGenerationRef.current) {
          session.stop()
          return
        }
        sessionRef.current = session
        dispatch({ type: 'CAMERA_STARTED' })
      })
      .catch((error: unknown) => {
        if (cancelled || generation !== cameraGenerationRef.current) return
        dispatch({ type: 'CAMERA_FAILED', error: describeCameraError(error) })
      })
    return () => {
      cancelled = true
    }
  }, [cameraWanted])

  // Leaving the route releases everything: every track stopped, object URL revoked.
  useEffect(
    () => () => {
      cameraGenerationRef.current += 1
      stopActiveScannerCamera()
      captureStoreRef.current.clear()
    },
    [],
  )

  // Tab hidden ⇒ release the hardware immediately. Returning lands on the start screen with the
  // batch intact; "Start camera" re-opens without a new permission prompt.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (
        visibilityChangeAction(document.visibilityState) === 'stop' &&
        (state.step === 'starting-camera' || state.step === 'camera')
      ) {
        dispatch({ type: 'CAMERA_EXITED' })
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [state.step])

  useEffect(() => {
    if (!state.exitRequested) return
    captureStoreRef.current.clear()
    stopActiveScannerCamera()
    void navigate({ to: '/portfolio' })
    // previewUrl state needs no manual reset here: navigating away unmounts the page.
  }, [state.exitRequested, navigate])

  function handleShutter(): void {
    const video = videoRef.current
    if (video === null) return
    void captureVideoFrame(video)
      .then((frame) => {
        // Stop the stream as soon as a frame is held — shortest possible camera lifetime.
        cameraGenerationRef.current += 1
        stopActiveScannerCamera()
        sessionRef.current = null
        const stored = captureStoreRef.current.set(frame)
        setPreviewUrl(stored.previewUrl)
        dispatch({ type: 'CAPTURE_SUCCEEDED' })
      })
      .catch((error: unknown) => {
        dispatch({ type: 'CAPTURE_FAILED', error: describeCaptureError(error) })
      })
  }

  function handleRetake(): void {
    captureStoreRef.current.clear()
    setPreviewUrl(null)
    dispatch({ type: 'RETAKE_PRESSED' })
  }

  function handleFilePicked(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    void decodeImageFile(file)
      .then((frame) => {
        cameraGenerationRef.current += 1
        stopActiveScannerCamera()
        sessionRef.current = null
        const stored = captureStoreRef.current.set(frame)
        setPreviewUrl(stored.previewUrl)
        dispatch({ type: 'CAPTURE_SUCCEEDED' })
      })
      .catch((error: unknown) => {
        dispatch({ type: 'CAPTURE_FAILED', error: describeCaptureError(error) })
      })
  }

  function handleUsePhoto(): void {
    const stored = captureStoreRef.current.get()
    if (stored === null) return
    const payload = { blob: stored.blob, width: stored.width, height: stored.height }
    dispatch({ type: 'USE_PHOTO_PRESSED' })
    // One explicit capture leads to exactly one analysis request — never a continuous loop
    // while the user is framing (prompt §12).
    void controller
      .analyzeCapture(payload)
      .then((analysis) => {
        // The photo has served its purpose; candidates carry the identity from here.
        captureStoreRef.current.clear()
        setPreviewUrl(null)
        dispatch({ type: 'ANALYSIS_COMPLETED', analysis })
      })
      .catch(() => {
        dispatch({ type: 'ANALYSIS_FAILED', error: describeAnalysisError() })
      })
  }

  function handleSearchSubmit(event?: SyntheticEvent): void {
    event?.preventDefault()
    const name = searchName.trim()
    if (name === '') return
    const collectorNumber = searchCollectorNumber.trim()
    dispatch({ type: 'SEARCH_PENDING' })
    void controller
      .searchFallback({
        name,
        collectorNumber: collectorNumber !== '' ? collectorNumber : undefined,
      })
      .then((candidates) => {
        dispatch({ type: 'SEARCH_RESULTS', candidates })
      })
      .catch((error: unknown) => {
        dispatch({ type: 'SEARCH_FAILED', error: describeSearchError(error) })
      })
  }

  function handleCommit(): void {
    if (state.batch.length === 0) return
    dispatch({ type: 'ADD_CARDS_PRESSED' })
    void controller
      .commitBatch(
        state.batch.map((item) => ({
          candidateId: item.candidate.candidateId,
          quantity: item.quantity,
          condition: item.condition,
        })),
      )
      .then((result) => {
        dispatch({ type: 'COMMIT_SUCCEEDED', addedCount: result.addedCount })
      })
      .catch((error: unknown) => {
        dispatch({ type: 'COMMIT_FAILED', error: describeCommitError(error) })
      })
  }

  const scannedCount = state.batch.reduce((total, item) => total + item.quantity, 0)
  // Narrowed once here: the render chain is too long for TS to carry property narrowing through
  // every ternary arm, and ResultView must never receive a NO_MATCH analysis.
  const resultAnalysis =
    state.analysis !== null &&
    state.analysis.confidence !== 'NO_MATCH' &&
    state.analysis.candidates.length > 0
      ? { confidence: state.analysis.confidence, candidates: state.analysis.candidates }
      : null

  return (
    <div
      className="fixed inset-0 z-[45] flex flex-col bg-slate-950 text-slate-100"
      style={{ paddingTop: 'max(0rem, env(safe-area-inset-top))' }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleFilePicked}
      />

      {/* Header: exit left, running batch count right. Exit always asks when work would be lost. */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={() => {
            dispatch({ type: 'EXIT_PRESSED' })
          }}
          aria-label="Close scanner"
          className="flex size-11 items-center justify-center rounded-full text-slate-300 hover:bg-slate-800"
        >
          <XIcon className="size-5" />
        </button>
        {state.batch.length > 0 ? (
          <span className="rounded-full border border-slate-700 px-3 py-1 text-xs font-medium tabular-nums text-slate-300">
            {state.batch.length} scanned
          </span>
        ) : null}
      </div>

      {state.step === 'intro' ? (
        <IntroView
          state={state}
          onStartCamera={() => {
            dispatch({ type: 'START_CAMERA_PRESSED' })
          }}
          onChoosePhoto={() => {
            fileInputRef.current?.click()
          }}
        />
      ) : state.step === 'starting-camera' || state.step === 'camera' ? (
        <>
          <div className="relative flex-1 overflow-hidden">
            <video
              ref={videoRef}
              {...CAMERA_VIDEO_PROPS}
              className="absolute inset-0 size-full object-cover"
            />
            {/* Card-shaped guide: Pokémon cards are 63×88 mm ≈ 5:7. The dimmed surround gives
                margin for perspective correction later; the thin border never sits over the
                card's bottom-right collector number because the caption and controls stay below
                the frame, not on top of it. */}
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <div
                className="aspect-[5/7] h-[58%] max-w-[86%] rounded-xl border-2 border-white/85 shadow-[0_0_0_9999px_rgba(2,6,15,0.55)]"
                aria-hidden="true"
              />
              <p className="mt-4 rounded-full bg-slate-950/70 px-3 py-1.5 text-xs font-medium text-slate-200">
                Fit the whole card inside the frame
              </p>
            </div>
          </div>
          <div
            className="flex items-center justify-center py-5"
            style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
          >
            <button
              type="button"
              onClick={handleShutter}
              disabled={state.step !== 'camera'}
              aria-label="Capture card"
              className="flex size-16 items-center justify-center rounded-full border-4 border-slate-950 bg-white shadow-lg transition-transform active:scale-95 motion-reduce:transition-none disabled:opacity-50"
            >
              <span className="sr-only">Capture</span>
            </button>
          </div>
          {state.captureError ? (
            <div
              className="px-4 pb-4"
              style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
            >
              <FormMessage tone="error">{`${state.captureError.title}. ${state.captureError.message}`}</FormMessage>
            </div>
          ) : null}
        </>
      ) : state.step === 'review' ? (
        <ReviewView
          previewUrl={previewUrl}
          analysisError={state.analysisError}
          onUsePhoto={handleUsePhoto}
          onRetake={handleRetake}
        />
      ) : state.step === 'analyzing' ? (
        <AnalyzingView
          onCancel={() => {
            dispatch({ type: 'ANALYSIS_CANCELLED' })
          }}
        />
      ) : state.step === 'result' && resultAnalysis !== null ? (
        <ResultView
          analysis={resultAnalysis}
          selectedCandidate={state.selectedCandidate}
          onSelect={(candidate) => {
            dispatch({ type: 'CANDIDATE_SELECTED', candidate })
          }}
          onConfirm={(candidate) => {
            dispatch({ type: 'CONFIRM_CARD_PRESSED', candidate })
          }}
          onSearchManually={() => {
            dispatch({ type: 'SEARCH_OPENED', from: 'result' })
          }}
        />
      ) : state.step === 'no-match' ? (
        <NoMatchView
          onSearchManually={() => {
            dispatch({ type: 'SEARCH_OPENED', from: 'no-match' })
          }}
          onRetake={handleRetake}
          onChoosePhoto={() => {
            fileInputRef.current?.click()
          }}
        />
      ) : state.step === 'manual-search' ? (
        <ManualSearchView
          searchName={searchName}
          searchCollectorNumber={searchCollectorNumber}
          results={state.searchResults}
          pending={state.searchPending}
          error={state.searchError}
          onNameChange={setSearchName}
          onCollectorNumberChange={setSearchCollectorNumber}
          onSubmit={() => {
            handleSearchSubmit()
          }}
          onSelect={(candidate) => {
            dispatch({ type: 'SEARCH_RESULT_SELECTED', candidate })
          }}
          onClose={() => {
            dispatch({ type: 'SEARCH_CLOSED' })
          }}
        />
      ) : state.step === 'confirm' && state.selectedCandidate !== null ? (
        <ConfirmView
          candidate={state.selectedCandidate}
          quantity={state.confirmQuantity}
          condition={state.confirmCondition}
          validationError={state.confirmValidationError}
          onQuantityChange={(value) => {
            dispatch({ type: 'CONFIRM_QUANTITY_CHANGED', value })
          }}
          onConditionChange={(condition) => {
            dispatch({ type: 'CONFIRM_CONDITION_CHANGED', condition })
          }}
          onAddToBatch={() => {
            dispatch({ type: 'CARD_CONFIRMED' })
          }}
          onCancel={() => {
            dispatch({ type: 'CONFIRM_CANCELLED' })
          }}
        />
      ) : state.step === 'scanned' ? (
        <ScannedSummaryView
          batchLength={state.batch.length}
          scannedCount={scannedCount}
          onScanNext={() => {
            dispatch({ type: 'SCAN_NEXT_PRESSED' })
          }}
          onReviewBatch={() => {
            dispatch({ type: 'REVIEW_BATCH_PRESSED' })
          }}
        />
      ) : state.step === 'batch-review' || state.step === 'committing' ? (
        <BatchReviewView
          batch={state.batch}
          committing={state.step === 'committing'}
          commitError={state.commitError}
          onQuantityChange={(index, value) => {
            dispatch({ type: 'BATCH_ITEM_QUANTITY_CHANGED', index, value })
          }}
          onConditionChange={(index, condition) => {
            dispatch({ type: 'BATCH_ITEM_CONDITION_CHANGED', index, condition })
          }}
          onRemove={(index) => {
            dispatch({ type: 'BATCH_ITEM_REMOVED', index })
          }}
          onCommit={handleCommit}
        />
      ) : state.step === 'committed' ? (
        <CommittedView
          addedCount={state.addedCount ?? 0}
          onDone={() => {
            dispatch({ type: 'COMMITTED_DONE_PRESSED' })
          }}
        />
      ) : null}

      <Sheet
        open={state.exitWarningOpen}
        onClose={() => {
          dispatch({ type: 'EXIT_CANCELLED' })
        }}
        title="Discard scanned cards?"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-300">
            Nothing has been added to your portfolio yet. Discarding clears this scanning session.
          </p>
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              onClick={() => {
                dispatch({ type: 'EXIT_CANCELLED' })
              }}
            >
              Keep scanning
            </Button>
            <Button
              type="button"
              variant="quiet"
              onClick={() => {
                dispatch({ type: 'DISCARD_CONFIRMED' })
              }}
            >
              Discard and exit
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  )
}

function ErrorAlert({ title, message }: { title: string; message: string }) {
  return <FormMessage tone="error">{`${title}. ${message}`}</FormMessage>
}

function IntroView({
  state,
  onStartCamera,
  onChoosePhoto,
}: {
  state: { cameraError: { title: string; message: string } | null }
  onStartCamera: () => void
  onChoosePhoto: () => void
}) {
  const cameraSupported = hasMediaDevicesSupport(navigator)
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 overflow-y-auto px-5 pb-8">
      <h1 className="text-2xl font-semibold tracking-tight">Scan cards</h1>
      <p className="text-sm text-slate-400">
        Use your camera to identify cards, then confirm before adding them.
      </p>
      {state.cameraError ? <ErrorAlert {...state.cameraError} /> : null}
      <div className="mt-2 flex flex-col gap-2">
        {cameraSupported ? (
          <Button type="button" onClick={onStartCamera}>
            Start camera
          </Button>
        ) : (
          <p className="text-sm text-slate-500">
            This browser cannot open the camera here. Choose an existing photo instead.
          </p>
        )}
        <Button type="button" variant="quiet" onClick={onChoosePhoto}>
          <span className="inline-flex items-center gap-2">
            <CameraIcon className="size-4" />
            Choose photo
          </span>
        </Button>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        Photos are processed for this scan and aren't saved to your portfolio.
      </p>
    </div>
  )
}

function ReviewView({
  previewUrl,
  analysisError,
  onUsePhoto,
  onRetake,
}: {
  previewUrl: string | null
  analysisError: { title: string; message: string } | null
  onUsePhoto: () => void
  onRetake: () => void
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 overflow-y-auto px-5 pb-6">
      <h1 className="text-lg font-semibold tracking-tight">Check your photo</h1>
      {previewUrl !== null ? (
        <img
          src={previewUrl}
          alt="Captured card photo"
          className="mx-auto max-h-[52svh] w-auto rounded-xl border border-slate-700"
        />
      ) : null}
      {analysisError ? <ErrorAlert {...analysisError} /> : null}
      <div className="mt-auto flex flex-col gap-2 pt-2">
        <Button type="button" onClick={onUsePhoto}>
          Use photo
        </Button>
        <Button type="button" variant="quiet" onClick={onRetake}>
          Retake
        </Button>
      </div>
      <p className="text-xs text-slate-500">
        Photos are processed for this scan and aren't saved to your portfolio.
      </p>
    </div>
  )
}

function AnalyzingView({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-5 pb-8">
      <div
        aria-hidden="true"
        className="aspect-[5/7] w-44 animate-pulse rounded-xl bg-slate-800/60"
      />
      <p role="status" className="text-sm text-slate-300">
        Analyzing card…
      </p>
      <Button type="button" variant="quiet" className="w-auto px-6" onClick={onCancel}>
        Back
      </Button>
    </div>
  )
}

function confidenceBadge(confidence: 'HIGH' | 'MEDIUM' | 'LOW'): string {
  return confidence === 'HIGH' ? 'Strong match' : 'Possible match'
}

function CandidateIdentity({ candidate }: { candidate: ScannerCandidate }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium">{candidate.name}</p>
      <p className="truncate text-xs text-slate-400">
        {[
          candidate.setName,
          candidate.collectorNumber !== undefined && candidate.collectorNumber !== null
            ? `#${candidate.collectorNumber}`
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || '—'}
      </p>
      <p className="truncate text-xs text-slate-500">
        {[candidate.finishLabel, candidate.languageLabel].filter(Boolean).join(' · ') || '—'}
      </p>
    </div>
  )
}

function ResultView({
  analysis,
  selectedCandidate,
  onSelect,
  onConfirm,
  onSearchManually,
}: {
  analysis: { confidence: 'HIGH' | 'MEDIUM' | 'LOW'; candidates: ScannerCandidate[] }
  selectedCandidate: ScannerCandidate | null
  onSelect: (candidate: ScannerCandidate) => void
  onConfirm: (candidate: ScannerCandidate) => void
  onSearchManually: () => void
}) {
  const multiple = analysis.candidates.length > 1
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 overflow-y-auto px-5 pb-6">
      <p role="status" aria-live="polite" className="text-sm text-slate-400">
        {multiple ? 'Choose the card that matches' : 'Is this the card?'}
      </p>
      {multiple ? (
        <ul className="flex flex-col divide-y divide-slate-800 rounded-xl border border-slate-800">
          {analysis.candidates.map((candidate) => {
            const selected =
              selectedCandidate !== null && selectedCandidate.candidateId === candidate.candidateId
            return (
              <li key={candidate.candidateId}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    onSelect(candidate)
                  }}
                  className={`flex w-full min-h-16 items-center gap-3 p-3 text-left hover:bg-slate-800/60 focus-visible:bg-slate-800/60 focus-visible:outline-none ${
                    selected ? 'bg-sky-600/10' : ''
                  }`}
                >
                  <CardImage
                    imageBaseUrl={candidate.imageBaseUrl ?? null}
                    alt={candidate.name}
                    quality="low"
                    className="h-14 w-10 shrink-0"
                  />
                  <CandidateIdentity candidate={candidate} />
                  {selected ? <CheckIcon className="ml-auto size-5 shrink-0 text-sky-400" /> : null}
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="flex items-start gap-4 rounded-xl border border-slate-800 p-3">
          <CardImage
            imageBaseUrl={analysis.candidates[0]?.imageBaseUrl ?? null}
            alt={analysis.candidates[0]?.name ?? ''}
            quality="high"
            className="h-36 w-[6.2rem] shrink-0"
          />
          <div className="min-w-0 space-y-1">
            <span
              className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                analysis.confidence === 'HIGH'
                  ? 'border-emerald-800 text-emerald-300'
                  : 'border-amber-700/70 text-amber-300'
              }`}
            >
              {confidenceBadge(analysis.confidence)}
            </span>
            {analysis.candidates[0] !== undefined ? (
              <CandidateIdentity candidate={analysis.candidates[0]} />
            ) : null}
          </div>
        </div>
      )}
      <div className="mt-auto flex flex-col gap-2 pt-2">
        <Button
          type="button"
          disabled={selectedCandidate === null}
          onClick={() => {
            if (selectedCandidate !== null) onConfirm(selectedCandidate)
          }}
        >
          Confirm card
        </Button>
        <button
          type="button"
          onClick={onSearchManually}
          className="mx-auto inline-flex min-h-11 items-center gap-2 text-sm text-sky-400 underline-offset-4 hover:underline"
        >
          <SearchIcon className="size-4" />
          Not right? Search manually
        </button>
      </div>
    </div>
  )
}

function NoMatchView({
  onSearchManually,
  onRetake,
  onChoosePhoto,
}: {
  onSearchManually: () => void
  onRetake: () => void
  onChoosePhoto: () => void
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 overflow-y-auto px-5 pb-8">
      <div role="status" aria-live="polite">
        <h1 className="text-xl font-semibold tracking-tight">Couldn't identify this card.</h1>
      </div>
      <p className="text-sm text-slate-400">
        Try another photo with the whole card inside the frame, or find it by name instead.
      </p>
      <div className="mt-2 flex flex-col gap-2">
        <Button type="button" variant="quiet" onClick={onSearchManually}>
          <span className="inline-flex items-center gap-2">
            <SearchIcon className="size-4" />
            Search manually
          </span>
        </Button>
        <Button type="button" variant="quiet" onClick={onRetake}>
          Retake
        </Button>
        <Button type="button" variant="quiet" onClick={onChoosePhoto}>
          Choose another photo
        </Button>
      </div>
    </div>
  )
}

function ManualSearchView({
  searchName,
  searchCollectorNumber,
  results,
  pending,
  error,
  onNameChange,
  onCollectorNumberChange,
  onSubmit,
  onSelect,
  onClose,
}: {
  searchName: string
  searchCollectorNumber: string
  results: ScannerCandidate[]
  pending: boolean
  error: { title: string; message: string } | null
  onNameChange: (value: string) => void
  onCollectorNumberChange: (value: string) => void
  onSubmit: () => void
  onSelect: (candidate: ScannerCandidate) => void
  onClose: () => void
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 overflow-y-auto px-5 pb-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Search manually</h1>
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 rounded-lg px-3 text-sm text-slate-300 hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
        noValidate
      >
        <TextField
          label="Card name"
          value={searchName}
          onChange={(event) => {
            onNameChange(event.target.value)
          }}
          placeholder="e.g. Pikachu"
          autoComplete="off"
        />
        <TextField
          label="Collector number"
          hint="Optional"
          value={searchCollectorNumber}
          onChange={(event) => {
            onCollectorNumberChange(event.target.value)
          }}
          placeholder="e.g. 025"
          inputMode="numeric"
          autoComplete="off"
        />
        <Button type="submit" disabled={searchName.trim() === '' || pending}>
          {pending ? 'Searching…' : 'Search'}
        </Button>
      </form>
      {error ? <ErrorAlert {...error} /> : null}
      {!pending && results.length > 0 ? (
        <p id="scanner-search-results-label" className="pt-2 text-xs text-slate-500">
          Tap a card to confirm it
        </p>
      ) : null}
      {pending ? (
        <ul className="space-y-2" aria-busy="true">
          {Array.from({ length: 4 }, (_, index) => (
            <li key={index} className="h-16 animate-pulse rounded-xl bg-slate-800/60" />
          ))}
        </ul>
      ) : results.length > 0 ? (
        <ul className="flex flex-col divide-y divide-slate-800 rounded-xl border border-slate-800">
          {results.map((candidate) => (
            <li key={candidate.candidateId}>
              <button
                type="button"
                onClick={() => {
                  onSelect(candidate)
                }}
                className="flex w-full min-h-16 items-center gap-3 p-3 text-left hover:bg-slate-800/60 focus-visible:bg-slate-800/60 focus-visible:outline-none"
              >
                <CardImage
                  imageBaseUrl={candidate.imageBaseUrl ?? null}
                  alt={candidate.name}
                  quality="low"
                  className="h-14 w-10 shrink-0"
                />
                <CandidateIdentity candidate={candidate} />
              </button>
            </li>
          ))}
        </ul>
      ) : !error ? (
        <p className="pt-2 text-center text-sm text-slate-500">No cards match yet.</p>
      ) : null}
    </div>
  )
}

function ConfirmView({
  candidate,
  quantity,
  condition,
  validationError,
  onQuantityChange,
  onConditionChange,
  onAddToBatch,
  onCancel,
}: {
  candidate: ScannerCandidate
  quantity: string
  condition: CardCondition
  validationError: string | null
  onQuantityChange: (value: string) => void
  onConditionChange: (condition: CardCondition) => void
  onAddToBatch: () => void
  onCancel: () => void
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 overflow-y-auto px-5 pb-6">
      <h1 className="text-lg font-semibold tracking-tight">Confirm card</h1>
      <div className="flex items-start gap-4 rounded-xl border border-slate-800 p-3">
        <CardImage
          imageBaseUrl={candidate.imageBaseUrl ?? null}
          alt={candidate.name}
          quality="high"
          className="h-28 w-20 shrink-0"
        />
        <div className="min-w-0 space-y-1">
          <p className="truncate text-sm font-medium">{candidate.name}</p>
          <p className="truncate text-xs text-slate-400">
            {[
              candidate.setName,
              candidate.collectorNumber !== undefined && candidate.collectorNumber !== null
                ? `#${candidate.collectorNumber}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ') || '—'}
          </p>
          <p className="truncate text-xs text-slate-500">
            {[candidate.finishLabel, candidate.languageLabel].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
      </div>
      <TextField
        label="Quantity"
        type="number"
        inputMode="numeric"
        min={1}
        value={quantity}
        onChange={(event) => {
          onQuantityChange(event.target.value)
        }}
      />
      <ChoiceGroup
        label="Condition"
        value={condition}
        onChange={onConditionChange}
        options={CONDITIONS.map((value) => [value, CONDITION_LABEL[value]] as const)}
      />
      {validationError !== null ? (
        <p role="alert" className="text-sm text-rose-300">
          {validationError}
        </p>
      ) : null}
      <div className="mt-auto flex flex-col gap-2 pt-2">
        <Button type="button" onClick={onAddToBatch}>
          Add to batch
        </Button>
        <Button type="button" variant="quiet" onClick={onCancel}>
          Back
        </Button>
      </div>
    </div>
  )
}

function ScannedSummaryView({
  batchLength,
  scannedCount,
  onScanNext,
  onReviewBatch,
}: {
  batchLength: number
  scannedCount: number
  onScanNext: () => void
  onReviewBatch: () => void
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 overflow-y-auto px-5 pb-8">
      <p role="status" aria-live="polite" className="text-xl font-semibold tracking-tight">
        {batchLength === 1 ? '1 card scanned' : `${batchLength} cards scanned`}
      </p>
      {scannedCount !== batchLength ? (
        <p className="text-sm text-slate-400">
          {scannedCount} {scannedCount === 1 ? 'card' : 'cards'} in total.
        </p>
      ) : null}
      <p className="text-sm text-slate-400">
        Cards wait in this scanning session until you add them from the batch review.
      </p>
      <div className="mt-2 flex flex-col gap-2">
        <Button type="button" onClick={onScanNext}>
          Scan next
        </Button>
        <Button type="button" variant="quiet" onClick={onReviewBatch}>
          Review batch
        </Button>
      </div>
    </div>
  )
}

function BatchReviewView({
  batch,
  committing,
  commitError,
  onQuantityChange,
  onConditionChange,
  onRemove,
  onCommit,
}: {
  batch: { candidate: ScannerCandidate; quantity: number; condition: CardCondition }[]
  committing: boolean
  commitError: { title: string; message: string } | null
  onQuantityChange: (index: number, value: string) => void
  onConditionChange: (index: number, condition: CardCondition) => void
  onRemove: (index: number) => void
  onCommit: () => void
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 overflow-y-auto px-5 pb-6">
      <h1 className="text-lg font-semibold tracking-tight">Review batch</h1>
      {batch.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">
          Nothing scanned yet. Go back and scan a card first.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-slate-800 rounded-xl border border-slate-800">
          {batch.map((item, index) => (
            <li key={`${item.candidate.candidateId}-${index}`} className="space-y-2 p-3">
              <div className="flex items-center gap-3">
                <CardImage
                  imageBaseUrl={item.candidate.imageBaseUrl ?? null}
                  alt={item.candidate.name}
                  quality="low"
                  className="h-14 w-10 shrink-0"
                />
                <CandidateIdentity candidate={item.candidate} />
                <button
                  type="button"
                  onClick={() => {
                    onRemove(index)
                  }}
                  aria-label={`Remove ${item.candidate.name}`}
                  className="ml-auto flex size-11 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                >
                  <XIcon className="size-4" />
                </button>
              </div>
              <div className="flex items-end gap-2">
                <label className="w-24 text-xs text-slate-400">
                  Qty
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={item.quantity}
                    onChange={(event) => {
                      onQuantityChange(index, event.target.value)
                    }}
                    className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base tabular-nums text-slate-100 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40"
                  />
                </label>
                <label className="min-w-0 flex-1 text-xs text-slate-400">
                  Condition
                  <select
                    value={item.condition}
                    onChange={(event) => {
                      onConditionChange(index, event.target.value as CardCondition)
                    }}
                    className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-base text-slate-100 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40"
                  >
                    {CONDITIONS.map((value) => (
                      <option key={value} value={value}>
                        {CONDITION_LABEL[value]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm font-medium tabular-nums text-slate-300">
        Total: {batch.length} {batch.length === 1 ? 'card' : 'cards'}
      </p>
      {commitError ? <ErrorAlert {...commitError} /> : null}
      <div className="mt-auto pt-2">
        <Button type="button" disabled={batch.length === 0 || committing} onClick={onCommit}>
          {committing ? 'Adding…' : 'Add cards'}
        </Button>
      </div>
    </div>
  )
}

function CommittedView({ addedCount, onDone }: { addedCount: number; onDone: () => void }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 overflow-y-auto px-5 pb-8">
      <p role="status" aria-live="polite" className="text-xl font-semibold tracking-tight">
        Added {addedCount} {addedCount === 1 ? 'card' : 'cards'}.
      </p>
      <p className="text-sm text-slate-400">The scanned cards are now in your portfolio.</p>
      <Button type="button" onClick={onDone}>
        Done
      </Button>
    </div>
  )
}
