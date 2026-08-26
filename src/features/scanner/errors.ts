/**
 * Friendly scanner error mapping (prompt §24). Browser internals — DOMException names, stack
 * traces, media error codes — never reach the screen; each failure class maps to one message
 * that names the cause and the way out. The camera-denied copy must point at the file fallback,
 * because on a denied permission that fallback is the only remaining path.
 */

export interface ScannerErrorInfo {
  title: string
  message: string
}

export function hasMediaDevicesSupport(
  nav: { mediaDevices?: { getUserMedia?: unknown } } | undefined,
): boolean {
  return typeof nav?.mediaDevices?.getUserMedia === 'function'
}

export function describeCameraError(error: unknown): ScannerErrorInfo {
  const name = error instanceof Error ? error.name : ''
  if (name === 'ScannerCameraUnsupportedError') {
    return {
      title: 'Camera not supported',
      message: 'This browser cannot open the camera here. Use "Choose photo" instead.',
    }
  }
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        title: 'Camera access was blocked',
        message:
          'Allow camera access for this site in your browser settings, or use "Choose photo" to scan from an existing photo instead.',
      }
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        title: 'No camera found',
        message:
          'No camera is available on this device. Use "Choose photo" to scan from an existing photo instead.',
      }
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        title: 'Camera is in use',
        message: 'Another app or tab seems to be using the camera. Close it and try again.',
      }
    default:
      return {
        title: 'Camera could not start',
        message: 'Something went wrong opening the camera. Try again, or use "Choose photo".',
      }
  }
}

export function describeCaptureError(error: unknown): ScannerErrorInfo {
  switch (error instanceof Error ? error.name : '') {
    case 'ScannerDecodeError':
      return {
        title: 'Photo could not be read',
        message: 'That image could not be decoded. Choose a different photo.',
      }
    case 'ScannerFileTooLargeError':
      return {
        title: 'Photo is too large',
        message: 'That image is too large to scan. Choose a smaller photo.',
      }
    default:
      return {
        title: 'Capture failed',
        message: 'The photo could not be captured. Try again.',
      }
  }
}

/**
 * Analysis failure mapping. Known scanner-typed errors carry PRE-SANITIZED user-ready messages
 * (engine start failures, catalog unavailability); anything else — an unexpected engine crash,
 * a decode problem — maps to the honest generic that invites retrying the same photo. Raw
 * underlying detail never reaches the copy either way.
 */
export function describeAnalysisError(error?: unknown): ScannerErrorInfo {
  if (
    error instanceof Error &&
    (error.name === 'ScannerEngineError' ||
      error.name === 'ScannerEngineDisposedError' ||
      error.name === 'ScannerCatalogUnavailableError') &&
    error.message !== ''
  ) {
    return { title: 'Scan did not go through', message: error.message }
  }
  return {
    title: 'Scan did not go through',
    message: 'The card could not be analysed just now. You can try the same photo again.',
  }
}

export function describeSearchError(error: unknown): ScannerErrorInfo {
  if (isOffline()) return OFFLINE_ERROR
  return {
    title: 'Search failed',
    message:
      error instanceof Error && error.message !== ''
        ? error.message
        : 'The manual search did not go through. Try again.',
  }
}

export function describeCommitError(error: unknown): ScannerErrorInfo {
  // Controllers produce user-ready messages by contract; anything else maps to a generic,
  // honest failure that makes clear nothing was changed.
  if (error instanceof Error && error.message !== '') {
    return { title: 'Cards were not added', message: error.message }
  }
  return {
    title: 'Cards were not added',
    message: 'Adding the scanned cards failed. Nothing was changed — try again.',
  }
}

const OFFLINE_ERROR: ScannerErrorInfo = {
  title: 'You appear to be offline',
  message: 'Reconnect to search for cards. Photos you already scanned are kept.',
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && !navigator.onLine
}
