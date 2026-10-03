/** Controllable fake of onnxruntime-react-native for the P186 session-lifecycle test. */
export const ctl: {
  /** Chronological log of "create:<n>" / "release:<n>" so ordering can be asserted. */
  log: string[]
  created: number
  alive: number
  maxAlive: number
  /** When set, the next release() waits for this promise (a slow native release). */
  holdRelease: Promise<void> | null
  /** When set, the next create() waits for this promise (a slow native create). */
  holdCreate: Promise<void> | null
} = { log: [], created: 0, alive: 0, maxAlive: 0, holdRelease: null, holdCreate: null }

export function resetCtl(): void {
  ctl.log = []
  ctl.created = 0
  ctl.alive = 0
  ctl.maxAlive = 0
  ctl.holdRelease = null
  ctl.holdCreate = null
}
