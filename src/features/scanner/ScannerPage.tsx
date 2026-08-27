import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import { useBlocker, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ScannerCandidate, ScannerDiagnostics } from './contract'
import { getScannerUiController } from './controller'
import { formatScannerDiagnostics } from './diagnostics-format'
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
import {
  SCANNER_ORIGINS,
  todayIso,
  type ScannerSessionDefaults,
  initialScannerDefaults,
  scannerSessionStore,
} from './session-store'
import {
  GUIDE_ASPECT_WIDTH,
  GUIDE_ASPECT_HEIGHT,
  GUIDE_HEIGHT_FRACTION,
  GUIDE_MAX_WIDTH_FRACTION,
} from './guide-geometry'
import { getMyProfile, type Profile } from '../../data/profile'
import { listStorageLocations } from '../../data/collection'
import { useAuth } from '../../auth/useAuth'
import { CardImage } from '../catalog/CardImage'
import { CONDITION_LABEL, ORIGIN_LABEL } from '../collection/labels'
import type { CardCondition } from '../../data/collection'
import { Button, ChoiceGroup, FormMessage, TextField } from '../../ui/form'
import { Sheet } from '../../ui/Sheet'
import { CheckIcon, CameraIcon, SearchIcon, XIcon } from '../../ui/icons'

/**
 * M15 scanner — camera capture and confirmation UX (P66) integrated with the REAL recognition
 * pipeline (P68): on-device Tesseract OCR through the controller seam, P67's deterministic
 * matcher, printing selection over the existing variants surface and batch commit through the
 * existing acquisition path.
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
 * hold identity + variant/quantity/condition, never image data. Leaving the route disposes the
 * OCR worker (controller.dispose) reliably (prompt §8).
 */

const CONDITIONS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'] as const

export function ScannerPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { session } = useAuth()
  const userId = session?.user.id ?? null
  const controller = useMemo(() => getScannerUiController(userId), [userId])
  const [state, dispatch] = useReducer(scannerReducer, initialScannerState)
  const [searchName, setSearchName] = useState('')
  const [searchCollectorNumber, setSearchCollectorNumber] = useState('')
  // Render-time mirror of the capture store's preview URL. The store itself is the memory
  // owner (revokes on every replacement/clear); this state only decides what to draw.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  // Honest first-use copy (prompt §9): the FIRST analysis includes engine preparation, later
  // ones do not. Derived from completed analyses, never fabricated progress percentages.
  const [hasCompletedAnalysis, setHasCompletedAnalysis] = useState(false)
  // Debug-only surface (P77 prompt §13): explicit, preview-only, user-invoked via a query
  // param — never shown by default, never gated behind anything a real user could stumble into.
  const debugEnabled = useMemo(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('scannerDebug') === '1',
    [],
  )
  const [diagnostics, setDiagnostics] = useState<ScannerDiagnostics | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sessionRef = useRef<ManagedCameraSession | null>(null)
  const captureStoreRef = useRef<CaptureStore>(new CaptureStore())
  // Bumped whenever the desire to hold a live stream ends; an in-flight getUserMedia whose
  // generation went stale stops its stream on arrival instead of leaking it.
  const cameraGenerationRef = useRef(0)
  // Guards double variant fetches for the same candidate across StrictMode-style re-runs.
  const variantsInFlightRef = useRef<string | null>(null)

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
    void openEnvironmentCamera(video, undefined, () => {
      // L1 (P70): track ended unexpectedly — clean up and return to start screen.
      if (cancelled || generation !== cameraGenerationRef.current) return
      sessionRef.current = null
      dispatch({ type: 'CAMERA_EXITED' })
    })
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

  // Leaving the route releases EVERYTHING: every track stopped, object URL revoked, OCR worker
  // terminated and canvases dropped (prompt §8/I16/I17).
  useEffect(
    () => () => {
      cameraGenerationRef.current += 1
      stopActiveScannerCamera()
      captureStoreRef.current.clear()
      controller.dispose()
    },
    [controller],
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

  // M4 (P70): Warn before navigating away when unsaved batch items exist.
  useEffect(() => {
    if (state.batch.length === 0) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [state.batch.length])

  // SPA navigation blocker: intercepts TanStack Router back/swipe navigation when
  // an unsaved batch exists. The same discard-confirmation sheet handles both the
  // X-button exit and SPA navigation — one consistent UX for "leave with unsaved work".
  const navigationBlocker = useBlocker({
    shouldBlockFn: () => state.batch.length > 0 && !state.exitRequested,
    withResolver: true,
  })
  // Store the blocker resolver in a ref so we can call proceed()/reset() from event
  // handlers without triggering cascading renders from a setState-in-effect.
  const blockedNavigationRef = useRef(navigationBlocker)
  useEffect(() => {
    blockedNavigationRef.current = navigationBlocker
  }, [navigationBlocker])
  useEffect(() => {
    if (navigationBlocker.status === 'blocked' && !state.exitWarningOpen) {
      dispatch({ type: 'EXIT_PRESSED' })
    }
  }, [navigationBlocker.status, state.exitWarningOpen])

  useEffect(() => {
    if (!state.exitRequested) return
    captureStoreRef.current.clear()
    stopActiveScannerCamera()
    void navigate({ to: '/portfolio' })
    // previewUrl state needs no manual reset here: navigating away unmounts the page.
  }, [state.exitRequested, navigate])

  // Printing choices load ONLY now that the user chose a candidate (prompt §22/I6): the effect
  // runs exclusively while the confirm step is live for a specific candidate.
  useEffect(() => {
    if (state.step !== 'confirm') return
    if (!state.confirmVariantsPending) return
    const candidateId = state.selectedCandidate?.candidateId
    if (candidateId === undefined || variantsInFlightRef.current === candidateId) return
    variantsInFlightRef.current = candidateId
    void controller
      .listVariantChoices(candidateId)
      .then((variants) => {
        dispatch({ type: 'CONFIRM_VARIANTS_LOADED', variants })
      })
      .catch(() => {
        dispatch({
          type: 'CONFIRM_VARIANTS_FAILED',
          error: {
            title: 'Versions could not load',
            message: 'Check your connection and try again.',
          },
        })
      })
      .finally(() => {
        if (variantsInFlightRef.current === candidateId) variantsInFlightRef.current = null
      })
  }, [state.step, state.confirmVariantsPending, state.selectedCandidate?.candidateId, controller])

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
    const payload = {
      blob: stored.blob,
      width: stored.width,
      height: stored.height,
      cardRect: stored.cardRect,
    }
    dispatch({ type: 'USE_PHOTO_PRESSED' })
    // One explicit capture leads to exactly one analysis request — never a continuous loop
    // while the user is framing (prompt §12).
    void controller
      .analyzeCapture(payload)
      .then((analysis) => {
        setHasCompletedAnalysis(true)
        if (debugEnabled) setDiagnostics(controller.getLastDiagnostics?.() ?? null)
        // The photo has served its purpose; candidates carry the identity from here.
        captureStoreRef.current.clear()
        setPreviewUrl(null)
        dispatch({ type: 'ANALYSIS_COMPLETED', analysis })
      })
      .catch((error: unknown) => {
        dispatch({ type: 'ANALYSIS_FAILED', error: describeAnalysisError(error) })
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
          variantId: item.variantId,
          quantity: item.quantity,
          condition: item.condition,
          requestKey: item.requestKey,
        })),
      )
      .then((result) => {
        // Same targeted invalidation family every other acquisition consumer uses (prompt §31):
        // portfolio, counts, dashboard summary, history feed and Home's recent activity.
        void queryClient.invalidateQueries({ queryKey: ['portfolio'] })
        void queryClient.invalidateQueries({ queryKey: ['portfolio-counts'] })
        void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] })
        void queryClient.invalidateQueries({ queryKey: ['history-events'] })
        void queryClient.invalidateQueries({ queryKey: ['recent-activity'] })
        dispatch({
          type: 'COMMIT_SUCCEEDED',
          addedCount: result.addedCount,
          outcomes: result.outcomes,
        })
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
        <SessionDefaultsGate userId={userId}>
          {({ defaults, locations, onPatch, japaneseNotice }) => (
            <IntroView
              state={state}
              defaults={defaults}
              locations={locations}
              japaneseNotice={japaneseNotice}
              onStartCamera={() => {
                dispatch({ type: 'START_CAMERA_PRESSED' })
              }}
              onChoosePhoto={() => {
                fileInputRef.current?.click()
              }}
              onDefaultsPatch={onPatch}
            />
          )}
        </SessionDefaultsGate>
      ) : state.step === 'starting-camera' || state.step === 'camera' ? (
        <>
          <div className="relative flex-1 overflow-hidden">
            <video
              ref={videoRef}
              {...CAMERA_VIDEO_PROPS}
              className="absolute inset-0 size-full object-cover"
            />
            {/* Card-shaped guide: Pokémon cards are 63×88 mm ≈ 5:7. Geometry constants are imported
                from guide-geometry.ts and applied via inline styles so there is exactly ONE source
                of truth — the JS computation (computeGuideRect) and this visual overlay always
                agree. Tailwind handles only pure visual utilities (rounded, border, shadow). */}
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <div
                className="rounded-xl border-2 border-white/85 shadow-[0_0_0_9999px_rgba(2,6,15,0.55)]"
                style={{
                  aspectRatio: `${GUIDE_ASPECT_WIDTH} / ${GUIDE_ASPECT_HEIGHT}`,
                  height: `${GUIDE_HEIGHT_FRACTION * 100}%`,
                  maxWidth: `${GUIDE_MAX_WIDTH_FRACTION * 100}%`,
                }}
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
          firstUse={!hasCompletedAnalysis}
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
          variants={state.confirmVariants}
          variantsPending={state.confirmVariantsPending}
          variantsError={state.confirmVariantsError}
          selectedVariantId={state.confirmVariantId}
          quantity={state.confirmQuantity}
          condition={state.confirmCondition}
          validationError={state.confirmValidationError}
          onQuantityChange={(value) => {
            dispatch({ type: 'CONFIRM_QUANTITY_CHANGED', value })
          }}
          onConditionChange={(condition) => {
            dispatch({ type: 'CONFIRM_CONDITION_CHANGED', condition })
          }}
          onVariantSelect={(variantId) => {
            dispatch({ type: 'CONFIRM_VARIANT_CHANGED', variantId })
          }}
          onRetryVariants={() => {
            dispatch({ type: 'CONFIRM_VARIANTS_PENDING' })
          }}
          onAddToBatch={() => {
            dispatch({ type: 'CARD_CONFIRMED' })
          }}
          onCancel={() => {
            dispatch({ type: 'CONFIRM_CANCELLED' })
          }}
        />
      ) : state.step === 'scanned' ? (
        <SessionDefaultsGate userId={userId}>
          {({ defaults, locations, onPatch }) => (
            <ScannedSummaryView
              batchLength={state.batch.length}
              scannedCount={scannedCount}
              defaults={defaults}
              locations={locations}
              onDefaultsPatch={onPatch}
              onScanNext={() => {
                dispatch({ type: 'SCAN_NEXT_PRESSED' })
              }}
              onReviewBatch={() => {
                dispatch({ type: 'REVIEW_BATCH_PRESSED' })
              }}
            />
          )}
        </SessionDefaultsGate>
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
          attentionCount={state.attentionCount}
          remainingCount={state.batch.length}
          onDone={() => {
            dispatch({ type: 'COMMITTED_DONE_PRESSED' })
          }}
          onReviewRemaining={() => {
            dispatch({ type: 'REVIEW_BATCH_PRESSED' })
          }}
        />
      ) : null}

      {debugEnabled ? <ScannerDebugPanel diagnostics={diagnostics} /> : null}

      <Sheet
        open={state.exitWarningOpen}
        onClose={() => {
          // Reset the SPA navigation blocker if the user dismisses the sheet.
          if (blockedNavigationRef.current.status === 'blocked') {
            blockedNavigationRef.current.reset()
          }
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
                // Keep scanning: cancel both the X-button exit and any SPA navigation blocker.
                if (blockedNavigationRef.current.status === 'blocked') {
                  blockedNavigationRef.current.reset()
                }
                dispatch({ type: 'EXIT_CANCELLED' })
              }}
            >
              Keep scanning
            </Button>
            <Button
              type="button"
              variant="quiet"
              onClick={() => {
                // Discard: clear scanner state and proceed with the originally blocked navigation
                // (if any), or the X-button's default exit to /portfolio.
                captureStoreRef.current.clear()
                stopActiveScannerCamera()
                dispatch({ type: 'DISCARD_CONFIRMED' })
                if (blockedNavigationRef.current.status === 'blocked') {
                  blockedNavigationRef.current.proceed()
                }
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

/**
 * Loads and scopes the session defaults (§25/§27) exactly once per user, then hands them to the
 * wrapped view. Profile capture-defaults seed the INITIAL condition/storage; everything lives in
 * scannerSessionStore memory afterwards. Render-prop keeps the data flow explicit and testable.
 */
function SessionDefaultsGate({
  userId,
  children,
}: {
  userId: string | null
  children: (args: {
    defaults: ScannerSessionDefaults
    locations: { id: string; label: string }[]
    onPatch: (patch: Partial<ScannerSessionDefaults>) => void
    japaneseNotice: boolean
  }) => ReactNode
}) {
  const profileQuery = useQuery({
    queryKey: ['my-profile'],
    queryFn: getMyProfile,
    staleTime: Infinity,
  })
  const locationsQuery = useQuery({
    queryKey: ['storage-locations'],
    queryFn: listStorageLocations,
    staleTime: Infinity,
  })

  useEffect(() => {
    if (userId === null) return
    if (scannerSessionStore.load(userId) !== null) return
    const profile: Profile | undefined = profileQuery.data
    scannerSessionStore.save(
      userId,
      initialScannerDefaults({
        condition: profile?.defaultCondition ?? undefined,
        storageLocationId: profile?.defaultStorageLocationId ?? undefined,
      }),
    )
  }, [userId, profileQuery.data])

  const stored = userId !== null ? scannerSessionStore.load(userId) : null
  if (stored === null) {
    // One render while the profile read lands; nothing below pretends defaults are chosen.
    return <div className="flex-1" />
  }

  return children({
    defaults: stored,
    locations: (locationsQuery.data ?? []).map((location) => ({
      id: location.id,
      label: location.name,
    })),
    onPatch: (patch) => {
      if (userId === null) return
      const current = scannerSessionStore.load(userId)
      if (current === null) return
      scannerSessionStore.save(userId, { ...current, ...patch })
    },
    japaneseNotice: profileQuery.data?.defaultLanguage === 'ja',
  })
}

function ErrorAlert({ title, message }: { title: string; message: string }) {
  return <FormMessage tone="error">{`${title}. ${message}`}</FormMessage>
}

/**
 * Debug-only recognition diagnostics panel (P77 prompt §13/§14) — reachable ONLY via an explicit
 * `?scannerDebug=1` query param, never shown by default. Shows the most recent scan's pipeline
 * state so a real-device failure is diagnosable instead of opaque. Every value here is already
 * on {@link ScannerDiagnostics}: no photo, no secrets, no auth identifiers, no persistence beyond
 * this component's own render lifetime.
 */
function ScannerDebugPanel({ diagnostics }: { diagnostics: ScannerDiagnostics | null }) {
  const [open, setOpen] = useState(true)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function handleCopy(): Promise<void> {
    if (diagnostics === null) return
    try {
      await navigator.clipboard.writeText(formatScannerDiagnostics(diagnostics))
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
    setTimeout(() => {
      setCopyStatus('idle')
    }, 2000)
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] max-h-[45svh] overflow-y-auto border-t border-amber-700/60 bg-slate-950/95 px-3 py-2 text-[11px] text-amber-100">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold uppercase tracking-wide text-amber-300">Scanner debug</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={diagnostics === null}
            onClick={() => {
              void handleCopy()
            }}
            className="rounded border border-amber-700/60 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-900/40 disabled:opacity-40"
          >
            {copyStatus === 'copied'
              ? 'Copied'
              : copyStatus === 'failed'
                ? 'Copy failed'
                : 'Copy diagnostics'}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen((v) => !v)
            }}
            className="rounded border border-amber-700/60 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-900/40"
          >
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {open ? (
        diagnostics === null ? (
          <p className="pt-2 text-amber-300/70">No scan analyzed yet this session.</p>
        ) : (
          <pre className="whitespace-pre-wrap break-words pt-2 font-mono leading-relaxed">
            {formatScannerDiagnostics(diagnostics)}
          </pre>
        )
      ) : null}
    </div>
  )
}

function IntroView({
  state,
  defaults,
  locations,
  japaneseNotice,
  onStartCamera,
  onChoosePhoto,
  onDefaultsPatch,
}: {
  state: { cameraError: { title: string; message: string } | null }
  defaults: ScannerSessionDefaults
  locations: { id: string; label: string }[]
  japaneseNotice: boolean
  onStartCamera: () => void
  onChoosePhoto: () => void
  onDefaultsPatch: (patch: Partial<ScannerSessionDefaults>) => void
}) {
  const cameraSupported = hasMediaDevicesSupport(navigator)
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 overflow-y-auto px-5 pb-8">
      <h1 className="text-2xl font-semibold tracking-tight">Scan cards</h1>
      <p className="text-sm text-slate-400">
        Use your camera or a photo to identify cards, then confirm before adding them.
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
      <SessionDefaultsBar defaults={defaults} locations={locations} onPatch={onDefaultsPatch} />
      {japaneseNotice ? (
        <p className="text-xs leading-relaxed text-slate-500">
          Card reading currently recognises English cards. Japanese recognition is not supported yet
          — you can still add Japanese cards through manual search.
        </p>
      ) : null}
      <p className="text-xs leading-relaxed text-slate-500">
        Card photos are processed on this device and aren't uploaded or saved.
      </p>
    </div>
  )
}

/**
 * The F12 session-defaults header (prompt §25): origin / condition / language / storage /
 * acquired date, applied to every committed item. Deliberately minimal — no collection/tag
 * field because the acquisition path behind commitBatch takes none, and NO opening origin
 * anywhere (M16 owns pulled provenance; prompt §26).
 */
function SessionDefaultsBar({
  defaults,
  locations,
  onPatch,
}: {
  defaults: ScannerSessionDefaults
  locations: { id: string; label: string }[]
  onPatch: (patch: Partial<ScannerSessionDefaults>) => void
}) {
  return (
    <section
      aria-label="Session settings applied to added cards"
      className="rounded-xl border border-slate-800 p-3"
    >
      <h2 className="pb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        Applied to added cards
      </h2>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-slate-400">
          Origin
          <select
            value={defaults.origin}
            onChange={(event) => {
              onPatch({ origin: event.target.value as ScannerSessionDefaults['origin'] })
            }}
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40"
          >
            {SCANNER_ORIGINS.map((origin) => (
              <option key={origin} value={origin}>
                {ORIGIN_LABEL[origin]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400">
          Condition
          <select
            value={defaults.condition}
            onChange={(event) => {
              onPatch({ condition: event.target.value as CardCondition })
            }}
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40"
          >
            {CONDITIONS.map((value) => (
              <option key={value} value={value}>
                {CONDITION_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400">
          Language
          <input
            value="English"
            readOnly
            aria-label="Recognition language: English"
            className="mt-1 min-h-11 w-full cursor-not-allowed rounded-lg border border-slate-800 bg-slate-900/60 px-3 text-sm text-slate-500"
          />
        </label>
        <label className="text-xs text-slate-400">
          Storage
          <select
            value={defaults.storageLocationId ?? ''}
            onChange={(event) => {
              onPatch({ storageLocationId: event.target.value === '' ? null : event.target.value })
            }}
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40"
          >
            <option value="">Not set</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.label}
              </option>
            ))}
          </select>
        </label>
        <label className="col-span-2 text-xs text-slate-400">
          Acquired date
          <input
            type="date"
            value={defaults.acquiredOn}
            max={todayIso()}
            onChange={(event) => {
              onPatch({ acquiredOn: event.target.value })
            }}
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/40"
          />
        </label>
      </div>
      {defaults.origin === 'purchase' ? (
        <p className="pt-2 text-xs text-amber-300/90">
          Cost isn't recorded here. Use Record purchase when you know the receipt price.
        </p>
      ) : null}
    </section>
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
        Card photos are processed on this device and aren't uploaded or saved.
      </p>
    </div>
  )
}

function AnalyzingView({ firstUse, onCancel }: { firstUse: boolean; onCancel: () => void }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-5 pb-8">
      <div
        aria-hidden="true"
        className="aspect-[5/7] w-44 animate-pulse rounded-xl bg-slate-800/60"
      />
      <div className="space-y-1 text-center">
        {/* Honest preparation copy (prompt §9): the first analysis may load several MB of local
            OCR assets; Tesseract reports no meaningful percentage for this, so none is shown. */}
        <p role="status" className="text-sm text-slate-300">
          {firstUse ? 'Preparing scanner…' : 'Analyzing card…'}
        </p>
        {firstUse ? <p className="text-xs text-slate-500">First use may take a moment.</p> : null}
      </div>
      <Button type="button" variant="quiet" className="w-auto px-6" onClick={onCancel}>
        Back
      </Button>
    </div>
  )
}

function confidenceBadge(confidence: 'HIGH' | 'MEDIUM' | 'LOW'): string {
  return confidence === 'HIGH'
    ? 'Strong match'
    : confidence === 'MEDIUM'
      ? 'Possible match'
      : 'Weak match'
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
          placeholder="e.g. 025 or SV049"
          inputMode="text"
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
  variants,
  variantsPending,
  variantsError,
  selectedVariantId,
  quantity,
  condition,
  validationError,
  onQuantityChange,
  onConditionChange,
  onVariantSelect,
  onRetryVariants,
  onAddToBatch,
  onCancel,
}: {
  candidate: ScannerCandidate
  variants: { id: string; label: string }[] | null
  variantsPending: boolean
  variantsError: { title: string; message: string } | null
  selectedVariantId: string | null
  quantity: string
  condition: CardCondition
  validationError: string | null
  onQuantityChange: (value: string) => void
  onConditionChange: (condition: CardCondition) => void
  onVariantSelect: (variantId: string) => void
  onRetryVariants: () => void
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
          <p className="truncate text-xs text-slate-500">{candidate.languageLabel ?? '—'}</p>
        </div>
      </div>
      {/* Printing choice (prompt §22): fetched only after this candidate was chosen, showing the
          card's ACTUAL finish/stamp/subtype/size attributes. Never inferred from the photo. */}
      {variantsPending ? (
        <div className="space-y-2" aria-busy="true">
          <p className="text-xs text-slate-500">Checking available versions…</p>
          <div className="h-11 animate-pulse rounded-lg bg-slate-800/60" />
        </div>
      ) : variantsError !== null ? (
        <div className="space-y-2">
          <ErrorAlert {...variantsError} />
          <Button type="button" variant="quiet" onClick={onRetryVariants}>
            Try again
          </Button>
        </div>
      ) : variants !== null && variants.length > 0 ? (
        variants.length === 1 ? (
          <p className="text-xs text-slate-400">Version: {variants[0]?.label}</p>
        ) : (
          <ChoiceGroup
            label="Version"
            value={selectedVariantId ?? ''}
            onChange={(value: string) => {
              onVariantSelect(value)
            }}
            options={variants.map((variant) => [variant.id, variant.label] as const)}
          />
        )
      ) : (
        <p className="text-xs text-slate-400">This card has no trackable version in the catalog.</p>
      )}
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
        <Button
          type="button"
          disabled={
            variantsPending ||
            variantsError !== null ||
            (variants !== null && variants.length === 0)
          }
          onClick={onAddToBatch}
        >
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
  defaults,
  locations,
  onDefaultsPatch,
  onScanNext,
  onReviewBatch,
}: {
  batchLength: number
  scannedCount: number
  defaults: ScannerSessionDefaults
  locations: { id: string; label: string }[]
  onDefaultsPatch: (patch: Partial<ScannerSessionDefaults>) => void
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
      <SessionDefaultsBar defaults={defaults} locations={locations} onPatch={onDefaultsPatch} />
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
  batch: {
    candidate: ScannerCandidate
    variantId: string
    variantLabel: string
    quantity: number
    condition: CardCondition
    needsVerification?: boolean
  }[]
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
            <li
              key={`${item.candidate.candidateId}-${item.variantId}-${index}`}
              className="space-y-2 p-3"
            >
              <div className="flex items-center gap-3">
                <CardImage
                  imageBaseUrl={item.candidate.imageBaseUrl ?? null}
                  alt={item.candidate.name}
                  quality="low"
                  className="h-14 w-10 shrink-0"
                />
                <div className="min-w-0">
                  <CandidateIdentity candidate={item.candidate} />
                  <p className="truncate text-xs text-slate-500">{item.variantLabel}</p>
                </div>
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
              {item.needsVerification ? (
                <p
                  role="status"
                  className="rounded-lg bg-amber-900/30 px-3 py-2 text-xs leading-relaxed text-amber-200"
                >
                  Connection was interrupted. This card may already have been added. Check Portfolio
                  before retrying.
                </p>
              ) : null}
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

function CommittedView({
  addedCount,
  attentionCount,
  remainingCount,
  onDone,
  onReviewRemaining,
}: {
  addedCount: number
  attentionCount: number | null
  remainingCount: number
  onDone: () => void
  onReviewRemaining: () => void
}) {
  const partial = attentionCount !== null && attentionCount > 0
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 overflow-y-auto px-5 pb-8">
      <p role="status" aria-live="polite" className="text-xl font-semibold tracking-tight">
        Added {addedCount} {addedCount === 1 ? 'card' : 'cards'}.
      </p>
      {partial ? (
        <p className="text-sm text-amber-200">
          Added {addedCount}. {attentionCount} {attentionCount === 1 ? 'needs' : 'need'} attention.
        </p>
      ) : null}
      <p className="text-sm text-slate-400">
        {partial
          ? 'The affected cards are still listed in this scan session.'
          : 'The scanned cards are now in your portfolio.'}
      </p>
      <div className="flex flex-col gap-2">
        {partial && remainingCount > 0 ? (
          <Button type="button" onClick={onReviewRemaining}>
            Review remaining
          </Button>
        ) : null}
        <Button type="button" variant={partial ? 'quiet' : 'primary'} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}
