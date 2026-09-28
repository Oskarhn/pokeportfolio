import type { RecognitionOutcome } from './recognition'

/**
 * When the app returns to the foreground, should the photo on screen be analysed again?
 *
 * Only when there is a photo, nothing is running for it, and it has no answer the person could be
 * looking at: a finished result (candidates, no-match, quality refusal, error) is kept, and a
 * recognition that is still in flight is left alone so a return from the system photo picker or
 * camera (which also cycles the app through the background) never starts a second one.
 */
export function shouldResumeRecognition(state: {
  readonly photoReady: boolean
  readonly outcomeStatus: RecognitionOutcome['status'] | null
  readonly inFlight: boolean
}): boolean {
  if (!state.photoReady || state.inFlight) return false
  return state.outcomeStatus === null || state.outcomeStatus === 'cancelled'
}
