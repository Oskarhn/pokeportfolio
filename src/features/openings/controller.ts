import type { OpeningController } from './contract'

/**
 * The P53 integration point. The opening UI (wizard, detail, entries, History row) is complete
 * against the {@link OpeningController} contract; the backend adapter — Supabase RPC bindings over
 * P50's `src/data/opening` + `src/domain/opening` work — lands in the integration session and
 * replaces `notIntegratedController` here. This is the only file that has to change.
 *
 * Until then every call fails with an honest, typed "not connected yet" error that the screens
 * render as such. No demo data, no fake successes: an opening this build cannot record is exactly
 * what it says (DESIGN_SYSTEM.md §7's states rule).
 */
export class OpeningsNotIntegratedError extends Error {
  constructor() {
    super(
      'Openings are not connected to your account yet — this screen arrives with the M16 integration.',
    )
    this.name = 'OpeningsNotIntegratedError'
  }
}

// A rejected promise rather than a synchronous throw: callers await this interface, so failures
// flow through react-query's normal error state exactly like a real backend failure will after
// P53.
const notIntegrated = (): Promise<never> => Promise.reject(new OpeningsNotIntegratedError())

const notIntegratedController: OpeningController = {
  getEligibleSealedSources: notIntegrated,
  createOpening: notIntegrated,
  getOpening: notIntegrated,
  voidOpening: notIntegrated,
}

export function getOpeningController(): OpeningController {
  return notIntegratedController
}
