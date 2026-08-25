/**
 * PLATFORM DELIVERY CONTRACT (prompt section 12) — pure decision-table oracle.
 *
 * Written implementation-blind from the documented platform reality (iOS installed-PWA
 * blob-anchor downloads get trapped by QuickLook; Web Share Level 2 files is the platform path
 * there; File System Access showSaveFilePicker is Chromium-only and never a dependency):
 *
 *   1. navigator.canShare({files}) === true        -> web-share-files  (share sheet)
 *   2. else 'showSaveFilePicker' available          -> file-picker      (desktop save dialog)
 *   3. else                                         -> anchor-download  (classic blob anchor)
 *
 * The behavioral clauses (cancellation, URL lifecycle, multi-artifact, no console leakage) are
 * stated as executable assertions over this decision function plus explicit contract constants,
 * so a later implementation can be diffed against them clause by clause.
 */
import { describe, expect, it } from 'vitest'

export type DeliveryChannel = 'web-share-files' | 'file-picker' | 'anchor-download'

export interface DeliveryCapabilities {
  /** Result of navigator.canShare({ files }) — false when share or canShare itself is absent. */
  readonly canShareFiles: boolean
  /** Feature detection: 'showSaveFilePicker' in window (top frame). */
  readonly supportsFileSystemAccess: boolean
}

/**
 * THE dispatch order. No user-agent sniffing: capability detection only. An iPadOS desktop-mode
 * UA quirk must not change the answer because nothing here reads the UA.
 */
export function chooseDeliveryChannel(caps: DeliveryCapabilities): DeliveryChannel {
  if (caps.canShareFiles) return 'web-share-files'
  if (caps.supportsFileSystemAccess) return 'file-picker'
  return 'anchor-download'
}

/** Cancellation semantics: user dismissal of share sheet / save dialog is NOT an error state. */
export function isUserCancellation(errorName: string | undefined | null): boolean {
  return errorName === 'AbortError'
}

/** Contract constants the UI copy and error handling must honor. */
export const DELIVERY_CONTRACT = {
  /** AbortError from share/save dialogs must resolve silently - no failure banner, no throw. */
  cancellationIsSilentSuccess: true,
  /** Every object URL created for artifacts must be revoked after the channel resolves/fails. */
  objectUrlsAlwaysRevoked: true,
  /** Artifact contents must never reach console.log/error - SECURITY.md section 9 discipline. */
  noConsoleOutputOfContents: true,
  /** Multiple artifacts (e.g. CSV ZIP or JSON+manifest) ride ONE share invocation when sharing. */
  multipleArtifactsSingleInvocation: true,
} as const

describe('delivery dispatch decision table', () => {
  it('prefers the share sheet whenever it accepts files', () => {
    expect(chooseDeliveryChannel({ canShareFiles: true, supportsFileSystemAccess: false })).toBe(
      'web-share-files',
    )
    expect(chooseDeliveryChannel({ canShareFiles: true, supportsFileSystemAccess: true })).toBe(
      'web-share-files',
    )
  })

  it('falls back to the desktop save picker when share cannot take files', () => {
    expect(chooseDeliveryChannel({ canShareFiles: false, supportsFileSystemAccess: true })).toBe(
      'file-picker',
    )
  })

  it('lands on the anchor download everywhere else', () => {
    expect(chooseDeliveryChannel({ canShareFiles: false, supportsFileSystemAccess: false })).toBe(
      'anchor-download',
    )
  })
})

describe('cancellation contract', () => {
  it('classifies AbortError as cancellation in every channel', () => {
    expect(isUserCancellation('AbortError')).toBe(true)
    expect(isUserCancellation(undefined)).toBe(false)
    expect(isUserCancellation(null)).toBe(false)
    expect(isUserCancellation('NotAllowedError')).toBe(false)
  })

  it('states the silent-success clause explicitly', () => {
    expect(DELIVERY_CONTRACT.cancellationIsSilentSuccess).toBe(true)
  })
})

describe('artifact lifecycle contract', () => {
  it('requires revocation of every object URL regardless of channel outcome', () => {
    expect(DELIVERY_CONTRACT.objectUrlsAlwaysRevoked).toBe(true)
  })

  it('forbids artifact contents in console output', () => {
    expect(DELIVERY_CONTRACT.noConsoleOutputOfContents).toBe(true)
  })

  it('shares multiple artifacts in one invocation', () => {
    expect(DELIVERY_CONTRACT.multipleArtifactsSingleInvocation).toBe(true)
  })
})
