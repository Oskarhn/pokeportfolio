import type { CardCondition } from '../../data/collection'
import type {
  BoughtAndOpenedInput,
  CreateOpeningInput,
  OpeningSource,
  TrackingCompleteness,
} from './contract'
import { openingCostPreview } from './copy'
import { localTodayIso } from '../../platform/local-date'

/**
 * The opening wizard's pure state machine (prompt §6/§24). No React, no routing, no network —
 * the wizard page dispatches actions and renders the result, and every gate the prompt demands
 * (quantity range, multi-lot choice, duplicate-pull merging, pairwise bulk estimate,
 * double-submit prevention, failure-retains-draft) is pinned here by tests/ui/opening-draft.test.ts.
 *
 * The draft lives in session memory only (prompt §23): `draftStore` below holds it across
 * unmount/remount so mobile back navigation during the flow never loses work. The store is
 * scoped by authenticated user id (P56 §9) so one account can never inherit another's draft.
 * Nothing is written to localStorage — a financial draft is not persisted without an explicit
 * project pattern for it.
 */

export const STEPS = ['source', 'quantity', 'pulls', 'review'] as const
export type OpeningStep = (typeof STEPS)[number]

/** The two entry modes (P53 §11): open something already owned, or record a buy-and-open. */
export type OpeningMode = 'existing_lot' | 'bought_now'

export interface PullDraft {
  key: string
  cardVariantId: string | null
  /** A real manual_card_definitions id once resolved at submission time; null while the pull is
   *  still only a draft (see manualIdentity below). */
  manualCardId: string | null
  /** Catalog-missing fallback (M6/D-037): identity as stated by the user, turned into a real
   *  manual-card definition by the wizard's submit step — never written earlier, so abandoning
   *  the flow leaves nothing behind. */
  manualIdentity: { name: string; setName?: string; collectorNumber?: string } | null
  displayName: string
  /** Set/set-number style subtitle for the review list; display only. */
  subtitle: string | null
  imageBaseUrl: string | null
  finishLabel: string | null
  condition: CardCondition
  quantity: number
}

export interface OpeningDraft {
  phase: 'editing' | 'submitting' | 'submitted'
  /**
   * The logical opening's submission identity (P59 / P58 F5): ONE key per logical opening draft,
   * persisted with the draft itself. It survives same-mount retries, wizard unmount/remount and
   * browser-back returns, so the server's idempotency arbiter always sees the SAME key for the
   * SAME logical attempt — a committed-but-unanswered submission can never be duplicated by a
   * remount minting a fresh key. It changes only when a new logical opening starts (RESET, or a
   * fresh draft after success cleared the store). Still memory-only; never localStorage (D-089
   * implementation detail, not a new decision).
   */
  idempotencyKey: string
  step: OpeningStep
  mode: OpeningMode
  holdingId: string | null
  lotId: string | null
  /** Bought-and-open product identity (curated or own sealed_products row). */
  productId: string | null
  productName: string | null
  /** Raw field inputs — parsed/clamped only on advance, so typing stays responsive. */
  quantityInput: string
  totalPaidInput: string
  purchasedOn: string
  openedOn: string
  pulls: PullDraft[]
  completeness: TrackingCompleteness
  bulkEstimateInput: string
  bulkCountInput: string
  notes: string
  /** Set on SUBMIT_FAILED; every other field is retained verbatim (prompt §23). */
  submitError: string | null
  submittedOpeningId: string | null
}

const todayIso = localTodayIso

export function initialDraft(
  preselect?: { holdingId?: string; lotId?: string },
  makeIdempotencyKey: () => string = () => crypto.randomUUID(),
): OpeningDraft {
  return {
    phase: 'editing',
    idempotencyKey: makeIdempotencyKey(),
    step: 'source',
    mode: 'existing_lot',
    // Arriving from Sealed Holding Detail preselects that holding (prompt §7); the actual lot is
    // still confirmed in step 1 unless exactly one eligible lot exists.
    holdingId: preselect?.holdingId ?? null,
    lotId: preselect?.lotId ?? null,
    productId: null,
    productName: null,
    quantityInput: '1',
    totalPaidInput: '',
    purchasedOn: todayIso(),
    openedOn: todayIso(),
    pulls: [],
    completeness: 'all_cards',
    bulkEstimateInput: '',
    bulkCountInput: '',
    notes: '',
    submitError: null,
    submittedOpeningId: null,
  }
}

/** The restrained recovery message shown when a stored draft was caught mid-submission (P59 §7). */
export const INTERRUPTED_SUBMISSION_COPY = 'Previous submission was interrupted. You can try again.'

/**
 * Stale-'submitting' recovery (P59 §7 / P58 F4). A draft saved while its request was in flight,
 * whose component then unmounted before onError could run, must NOT brick the wizard forever:
 * on load it is treated as a RECOVERABLE interrupted submission — phase back to editing, every
 * field preserved (idempotency key, pulls, manual-card ids, dates, amounts), and the user may
 * press Retry. Failure vs success is deliberately NOT assumed: if the interrupted request
 * actually committed, the SAME persisted key replays the original opening; if it did not,
 * normal creation happens. This is exactly why the key must survive the remount.
 */
export function recoverInterruptedSubmission(stored: OpeningDraft): OpeningDraft {
  if (stored.phase !== 'submitting') return stored
  return { ...stored, phase: 'editing', submitError: INTERRUPTED_SUBMISSION_COPY }
}

/**
 * Route-scope reconciliation (P59 §19 / P58 F12). A draft may be started under one entry route's
 * scope and reopened under another; the EXPLICIT route wins without discarding unrelated work:
 *
 *   - generic `/openings/new` after a holding-scoped start → the stale holding scope is cleared
 *     (and the source selection re-resolved) so all eligible sources are visible instead of a
 *     false "Nothing to open yet"; entered pulls survive;
 *   - explicit `?holdingId=B` after a generic (or holding-A) start → the scope becomes B, with
 *     the source selection re-resolved inside B; entered pulls survive;
 *   - matching scope → unchanged; a submitted draft is never reusable.
 */
export function reconcileDraftScope(
  stored: OpeningDraft,
  requestedHoldingId: string | undefined,
): OpeningDraft | null {
  if (stored.phase === 'submitted') return null
  const requested = requestedHoldingId ?? null
  if (requested === stored.holdingId) return stored
  if (requested === null) {
    // Generic entry: drop the route-specific scope; bought-now drafts keep everything (their
    // flow never depended on the holding), existing-lot drafts re-pick their source.
    return stored.mode === 'bought_now'
      ? { ...stored, holdingId: null }
      : { ...stored, holdingId: null, lotId: null, step: 'source' }
  }
  // An explicit holding route wins over whatever scope the draft carried.
  return stored.mode === 'bought_now'
    ? { ...stored, holdingId: requested }
    : { ...stored, holdingId: requested, lotId: null, step: 'source' }
}

export type DraftAction =
  | { type: 'SELECT_SOURCE'; source: OpeningSource }
  | { type: 'SET_MODE'; mode: OpeningMode }
  | { type: 'SELECT_PRODUCT'; productId: string; productName: string }
  | { type: 'SET_TOTAL_PAID_INPUT'; value: string }
  | { type: 'SET_PURCHASED_ON'; value: string }
  | { type: 'SET_QUANTITY_INPUT'; value: string }
  | { type: 'SET_OPENED_ON'; value: string }
  | { type: 'GO_TO_STEP'; step: OpeningStep }
  | {
      type: 'ADD_PULL'
      pull: Omit<PullDraft, 'key' | 'quantity'>
      quantity: number
      makeKey: () => string
    }
  | { type: 'SET_PULL_QUANTITY'; key: string; quantity: number }
  | { type: 'REMOVE_PULL'; key: string }
  | { type: 'SET_COMPLETENESS'; value: TrackingCompleteness }
  | { type: 'SET_BULK_ESTIMATE_INPUT'; value: string }
  | { type: 'SET_BULK_COUNT_INPUT'; value: string }
  | { type: 'SET_NOTES'; value: string }
  /** Persists the manual-card definition ids created during a submission attempt back into the
   *  draft (P56 §10). Once createManualCard has succeeded for an identity, the resolved id lives
   *  in the stored draft, so ANY retry — same mount, route remount or browser-back return — reuses
   *  that exact row instead of inserting another identical definition. No heuristic identity
   *  merging: only ids this device actually created are persisted, keyed to the pull they were
   *  created for. */
  | { type: 'RESOLVE_MANUAL_CARDS'; idsByKey: ReadonlyMap<string, string> }
  | { type: 'BEGIN_SUBMIT' }
  | { type: 'SUBMIT_SUCCEEDED'; openingId: string }
  | { type: 'SUBMIT_FAILED'; message: string }
  | { type: 'RESET' }

/** Two drafts are the same pull when they name the same physical printing in the same condition —
 *  adding it again merges into the existing line instead of creating a confusing near-duplicate
 *  (prompt §24's "duplicate card quantity behavior"). */
function samePullIdentity(a: PullDraft, b: Omit<PullDraft, 'key' | 'quantity'>): boolean {
  if (a.condition !== b.condition) return false
  if (a.cardVariantId !== null && b.cardVariantId !== null) {
    return a.cardVariantId === b.cardVariantId
  }
  if (a.manualIdentity !== null && b.manualIdentity !== null) {
    const keyOf = (m: NonNullable<PullDraft['manualIdentity']>) =>
      `${m.name}|${m.setName ?? ''}|${m.collectorNumber ?? ''}`
    return keyOf(a.manualIdentity) === keyOf(b.manualIdentity)
  }
  if (a.manualCardId !== null && b.manualCardId !== null) {
    return a.manualCardId === b.manualCardId
  }
  return false
}

export function reduceDraft(state: OpeningDraft, action: DraftAction): OpeningDraft {
  switch (action.type) {
    case 'RESET':
      return initialDraft()
    case 'SELECT_SOURCE':
      return {
        ...state,
        holdingId: action.source.holdingId,
        lotId: action.source.lotId,
        // Keep any previously typed quantity inside the new lot's bounds rather than silently
        // carrying an impossible number forward.
        quantityInput: clampQuantityInput(state.quantityInput, action.source.quantityAvailable),
        submitError: null,
      }
    case 'SET_MODE':
      if (action.mode === state.mode) return state
      return {
        // Switching modes clears the other mode's selection so a stale lot can never ride along
        // with a bought-and-open submission (or vice versa). Entered pulls survive — they are
        // mode-independent facts about what was pulled.
        ...state,
        mode: action.mode,
        lotId: null,
        productId: null,
        productName: null,
        submitError: null,
      }
    case 'SELECT_PRODUCT':
      return { ...state, productId: action.productId, productName: action.productName }
    case 'SET_TOTAL_PAID_INPUT':
      return { ...state, totalPaidInput: action.value }
    case 'SET_PURCHASED_ON':
      return { ...state, purchasedOn: action.value }
    case 'SET_QUANTITY_INPUT':
      return { ...state, quantityInput: action.value }
    case 'SET_OPENED_ON':
      return { ...state, openedOn: action.value }
    case 'GO_TO_STEP':
      return { ...state, step: action.step, submitError: null }
    case 'ADD_PULL': {
      const incoming = { ...action.pull, key: '', quantity: action.quantity }
      const existing = state.pulls.find((pull) => samePullIdentity(pull, incoming))
      if (existing) {
        return {
          ...state,
          pulls: state.pulls.map((pull) =>
            pull.key === existing.key
              ? { ...pull, quantity: pull.quantity + action.quantity }
              : pull,
          ),
        }
      }
      return {
        ...state,
        pulls: [...state.pulls, { ...incoming, key: action.makeKey() }],
      }
    }
    case 'SET_PULL_QUANTITY': {
      const quantity = Math.max(1, Math.floor(action.quantity) || 1)
      return {
        ...state,
        pulls: state.pulls.map((pull) => (pull.key === action.key ? { ...pull, quantity } : pull)),
      }
    }
    case 'REMOVE_PULL':
      return { ...state, pulls: state.pulls.filter((pull) => pull.key !== action.key) }
    case 'SET_COMPLETENESS':
      return { ...state, completeness: action.value }
    case 'SET_BULK_ESTIMATE_INPUT':
      return { ...state, bulkEstimateInput: action.value }
    case 'SET_BULK_COUNT_INPUT':
      return { ...state, bulkCountInput: action.value }
    case 'SET_NOTES':
      return { ...state, notes: action.value }
    case 'RESOLVE_MANUAL_CARDS': {
      if (action.idsByKey.size === 0) return state
      return {
        ...state,
        pulls: state.pulls.map((pull) => {
          const manualCardId = action.idsByKey.get(pull.key)
          return manualCardId ? { ...pull, manualCardId } : pull
        }),
      }
    }
    case 'BEGIN_SUBMIT':
      // The double-submit guard: a submission already in flight swallows further BEGINs, so a
      // double-tap on "Finish opening" cannot create two openings even before the backend's own
      // idempotency key answers.
      if (state.phase !== 'editing') return state
      return { ...state, phase: 'submitting', submitError: null }
    case 'SUBMIT_SUCCEEDED':
      if (state.phase !== 'submitting') return state
      return { ...state, phase: 'submitted', submittedOpeningId: action.openingId }
    case 'SUBMIT_FAILED':
      // Every drafted field survives untouched — retry needs nothing re-typed (prompt §23).
      if (state.phase !== 'submitting') return state
      return { ...state, phase: 'editing', submitError: action.message }
    default:
      return state
  }
}

function clampQuantityInput(raw: string, max: number): string {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return '1'
  return String(Math.min(Math.max(parsed, 1), max))
}

/**
 * Step gates. Returns the blocking message or null. The backend stays authoritative — these are
 * UX guards so obvious mistakes never become a round trip (prompt §8).
 *
 * `ctx.selectedLotId` is the EFFECTIVE selection (explicit pick or the single-lot auto-select);
 * the wizard derives it, so these gates never re-derive financial meaning.
 */
export function stepError(
  step: OpeningStep,
  draft: OpeningDraft,
  ctx: { availableSources: OpeningSource[]; selectedLotId: string | null },
): string | null {
  switch (step) {
    case 'source': {
      if (draft.mode === 'bought_now') {
        return draft.productId ? null : 'Choose the sealed product you bought and opened.'
      }
      if (ctx.availableSources.length === 0) {
        return 'You have no sealed products with unopened units to record.'
      }
      const source = ctx.availableSources.find((s) => s.lotId === ctx.selectedLotId)
      if (!source) {
        return 'Choose which acquisition lot you opened from.'
      }
      return null
    }
    case 'quantity': {
      const parsed = Number.parseInt(draft.quantityInput, 10)
      if (!Number.isFinite(parsed) || parsed < 1) {
        return 'Open at least 1.'
      }
      if (draft.mode === 'bought_now') {
        const total = draft.totalPaidInput.trim()
        if (total === '') {
          return 'Enter the total you paid — it is what makes this a real purchase record.'
        }
        if (!/^\d+([.,]\d{1,2})?$/.test(total)) {
          return 'Enter the total paid as a NOK amount, e.g. 299 or 299,95.'
        }
        if (!dateIsValidAndNotFuture(draft.purchasedOn)) {
          return 'Enter the purchase date — today or earlier.'
        }
      } else {
        const source = ctx.availableSources.find((s) => s.lotId === ctx.selectedLotId)
        if (!source) return 'Choose which acquisition lot you opened from.'
        if (parsed > source.quantityAvailable) {
          return `Only ${source.quantityAvailable} available in this lot.`
        }
      }
      if (!dateIsValidAndNotFuture(draft.openedOn)) {
        return 'Enter the date you opened it — today or earlier.'
      }
      return null
    }
    case 'pulls':
      // Pulls may be empty at this point only when the user will declare incomplete tracking on
      // the review step; the review gate below enforces that pairing.
      return null
    case 'review':
      return reviewError(draft)
  }
}

/** Review-step validation: bulk estimate fields are optional but strictly paired (both or neither,
 *  DATA_MODEL §5.8's shape), amounts must be plain NOK decimals, and a completely empty pull list
 *  must be declared honestly as selected-pulls/not-sure rather than slipping through as
 *  "all cards". */
export function reviewError(draft: OpeningDraft): string | null {
  const hasEstimate = draft.bulkEstimateInput.trim() !== ''
  const hasCount = draft.bulkCountInput.trim() !== ''
  if (hasEstimate !== hasCount) {
    return 'Fill in both the estimated value and roughly how many cards, or leave both empty.'
  }
  if (hasEstimate) {
    if (!/^\d+([.,]\d{1,2})?$/.test(draft.bulkEstimateInput.trim())) {
      return 'Enter the estimated value as a NOK amount, e.g. 240 or 240,50.'
    }
    const count = Number.parseInt(draft.bulkCountInput, 10)
    if (!Number.isFinite(count) || count < 1) {
      return 'Enter roughly how many untracked cards there were.'
    }
  }
  if (draft.pulls.length === 0 && draft.completeness === 'all_cards') {
    return 'No pulls are recorded yet. Add them, or declare that you recorded only selected pulls.'
  }
  return null
}

/** Dates default to today and allow any past date (UX_FLOWS cross-cutting rules); a future
 *  opening date would move inventory the user does not have yet, so it is refused. */
export function dateIsValidAndNotFuture(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return false
  return value <= todayIso()
}

/** Assemble the controller call from the draft. `sourceLotId` comes from the wizard's EFFECTIVE
 *  selection (explicit pick or single-lot auto-select). Manual-card identities must already be
 *  resolved to real ids by the caller (the wizard creates them at submission time); an unresolved
 *  one here is a programming error, not a user-facing state. Money strings are parsed at this
 *  boundary, quantities are integers, and the optional estimate travels only when its pair is
 *  present. */
export function buildCreateOpeningInput(
  draft: OpeningDraft,
  sourceLotId: string,
  idempotencyKey: string,
  parseNokMinor: (raw: string) => bigint,
): CreateOpeningInput {
  const unresolved = draft.pulls.find(
    (pull) => pull.cardVariantId === null && pull.manualCardId === null,
  )
  if (unresolved) {
    throw new Error('A pulled card has no resolved identity yet.')
  }
  const hasEstimate = draft.bulkEstimateInput.trim() !== ''
  const input: CreateOpeningInput = {
    idempotencyKey,
    sourceLotId,
    quantity: Number.parseInt(draft.quantityInput, 10),
    openedOn: draft.openedOn,
    pulls: draft.pulls.map((pull) => ({
      cardVariantId: pull.cardVariantId ?? undefined,
      manualCardId: pull.manualCardId ?? undefined,
      condition: pull.condition,
      quantity: pull.quantity,
    })),
    trackingCompleteness: draft.completeness,
  }
  if (hasEstimate && draft.bulkCountInput.trim() !== '') {
    input.bulkRemainderEstimateMinor = parseNokMinor(draft.bulkEstimateInput)
    input.bulkRemainderCount = Number.parseInt(draft.bulkCountInput, 10)
  }
  if (draft.notes.trim() !== '') input.notes = draft.notes.trim()
  return input
}

/** Buy-and-open assembly (P53 §11). The owner states the receipt TOTAL — it travels verbatim as
 *  an exact integer amount; nobody divides it to enter it (P53 §12). The backend performs the
 *  largest-remainder split. */
export function buildBoughtAndOpenedInput(
  draft: OpeningDraft,
  idempotencyKey: string,
  parseNokMinor: (raw: string) => bigint,
): BoughtAndOpenedInput {
  if (!draft.productId) {
    throw new Error('Choose the sealed product you bought and opened.')
  }
  const unresolved = draft.pulls.find(
    (pull) => pull.cardVariantId === null && pull.manualCardId === null,
  )
  if (unresolved) {
    throw new Error('A pulled card has no resolved identity yet.')
  }
  const hasEstimate = draft.bulkEstimateInput.trim() !== ''
  const input: BoughtAndOpenedInput = {
    idempotencyKey,
    sealedProductId: draft.productId,
    quantity: Number.parseInt(draft.quantityInput, 10),
    // The exact entered total, parsed by the same boundary as every other NOK input.
    totalPaidNokMinor: parseNokMinor(draft.totalPaidInput),
    purchasedOn: draft.purchasedOn,
    openedOn: draft.openedOn,
    pulls: draft.pulls.map((pull) => ({
      cardVariantId: pull.cardVariantId ?? undefined,
      manualCardId: pull.manualCardId ?? undefined,
      condition: pull.condition,
      quantity: pull.quantity,
    })),
    trackingCompleteness: draft.completeness,
  }
  if (hasEstimate && draft.bulkCountInput.trim() !== '') {
    input.bulkRemainderEstimateMinor = parseNokMinor(draft.bulkEstimateInput)
    input.bulkRemainderCount = Number.parseInt(draft.bulkCountInput, 10)
  }
  if (draft.notes.trim() !== '') input.notes = draft.notes.trim()
  return input
}

/** Which lots should step 1 offer for a given set of eligible sources: when arriving from a
 *  holding with several lots, all of that holding's lots are listed and none is silently picked
 *  (prompt §7 — different lots can be financially different). */
export function sourcesForHolding(
  sources: OpeningSource[],
  holdingId: string | null,
): OpeningSource[] {
  if (holdingId === null) return sources
  const scoped = sources.filter((source) => source.holdingId === holdingId)
  return scoped.length > 0 ? scoped : []
}

/** True when step 1 can auto-confirm the lot without asking: exactly one candidate exists. A
 *  single-lot preselect is not a financial guess — there is nothing else it could be. */
export function singleSourceAutoSelect(sources: OpeningSource[]): OpeningSource | null {
  return sources.length === 1 ? (sources[0] ?? null) : null
}

/** Convenience for the review screen: the cost preview given the effective source selection. */
export function draftCostPreview(
  draft: OpeningDraft,
  selectedSource: OpeningSource | null,
): ReturnType<typeof openingCostPreview> {
  const quantity = Math.max(1, Number.parseInt(draft.quantityInput, 10) || 1)
  if (!selectedSource) return { kind: 'unknown' }
  return openingCostPreview(selectedSource, quantity)
}

/**
 * Session-memory draft holder, SCOPED BY AUTHENTICATED USER (P56 §9 — P55 finding: the module-
 * global draft let account B inherit account A's in-memory opening draft after a sign-out/
 * switch). Drafts contain private financial intent — sealed product choice, pull list, manual
 * card names, amounts — so:
 *
 *   - a signed-in user only ever loads/saves under their own id;
 *   - a null/anonymous owner loads and saves nothing;
 *   - `clearAll()` runs deterministically when authentication ends (AuthProvider.signOut), so no
 *     private draft lingers in memory after sign-out.
 *
 * Still memory-only and per browser tab: the same user's draft survives wizard unmount/remount
 * as intended; nothing is persisted to localStorage.
 */
const draftsByUser = new Map<string, OpeningDraft>()

export const draftStore = {
  load(userId: string | null): OpeningDraft | null {
    return userId === null ? null : (draftsByUser.get(userId) ?? null)
  },
  save(userId: string | null, draft: OpeningDraft): void {
    if (userId === null) return
    draftsByUser.set(userId, draft)
  },
  clear(userId: string | null): void {
    if (userId !== null) draftsByUser.delete(userId)
  },
  /** Drops EVERY user's in-memory draft — called when authentication ends. */
  clearAll(): void {
    draftsByUser.clear()
  },
}
