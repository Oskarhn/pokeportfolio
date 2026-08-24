/**
 * Platform file delivery for M13 export/backup — the "how does the file reach the user" layer,
 * deliberately separate from what generates the bytes (P35's engine) and from the UI.
 *
 * Dispatch order, all capability-detected (M13 prompt §7-9; research dossier §MOBILE/PWA):
 *
 *   1. Web Share Level 2 — `navigator.canShare({files})` then `navigator.share({files})`.
 *      The intended path inside an installed iOS PWA, where a blob-anchor download is
 *      intercepted by QuickLook fullscreen with no way back (WebKit 236943). Never sniffed
 *      from a UA string: if the platform can share these files, it shares them.
 *   2. File System Access save picker (`showSaveFilePicker`) for a single file — desktop-Chromium
 *      enhancement only, never a dependency; Safari/Firefox never see it and its failure falls
 *      through to (3).
 *   3. Blob + `<a download>` — the universal fallback (the same mechanism M7.1's Portfolio CSV
 *      already uses). Multiple artifacts are downloaded sequentially with a short gap so browsers
 *      register each one; every object URL is revoked after a bounded delay, and no hidden link
 *      outlives the click.
 *
 * User cancellation (AbortError from the share sheet or the save dialog) is a normal outcome,
 * not an error. A NotAllowedError from `share()` is SURFACED as an error, never silently
 * converted into a download (D-079): after the two-step ready→deliver flow there is no long
 * generation left to blame, so a refusal means Permissions Policy, an engine security rule or
 * a real activation problem — the user sees it and chooses "Download instead" explicitly.
 * Any other share failure also surfaces as an error so the UI can offer Retry.
 */

export interface DeliverableFile {
  filename: string
  blob: Blob
}

export type DeliveryOutcome =
  | { method: 'share'; filenames: string[] }
  | { method: 'save-picker'; filenames: string[] }
  /** One or more browser downloads were triggered via object URLs / anchors. */
  | { method: 'download'; filenames: string[] }
  /** The user dismissed the share sheet or save dialog. Nothing was saved or shared. */
  | { method: 'cancelled' }

/** Raised when delivery genuinely failed and the user should see it (with Retry in the UI). */
export class DeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DeliveryError'
  }
}

/** How long a revoked-pending object URL is kept alive after its anchor click, milliseconds.
 *  Revoking immediately after `click()` can race the download manager in some engines; a bounded
 *  delay is the safe pattern (FileSaver.js keeps blobs far longer). */
const OBJECT_URL_KEEP_ALIVE_MS = 10_000

/** Pause between sequential fallback downloads so each registers as its own download. */
const INTER_DOWNLOAD_DELAY_MS = 350

interface ShareCapableNavigator {
  share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>
  canShare?: (data: { files?: File[] }) => boolean
}

interface SavePickerHost {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>
      close: () => Promise<void>
    }>
  }>
}

function toFiles(files: readonly DeliverableFile[]): File[] {
  return files.map(
    ({ filename, blob }) =>
      new File([blob], filename, { type: blob.type || 'application/octet-stream' }),
  )
}

function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: unknown }).name)
    : undefined
}

function isAbortError(error: unknown): boolean {
  return errorName(error) === 'AbortError'
}

function canShareTheseFiles(asFiles: readonly File[]): boolean {
  const nav = navigator as ShareCapableNavigator
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false
  try {
    // Asked about the exact payload that would be shared — including the full array when there
    // are several files — because engines accept single-file shares they reject for arrays.
    return nav.canShare({ files: [...asFiles] })
  } catch {
    return false
  }
}

/** Whether this platform can open the Web Share sheet with these exact files. */
export function canShareFiles(files: readonly DeliverableFile[]): boolean {
  return canShareTheseFiles(toFiles(files))
}

async function shareTheseFiles(asFiles: readonly File[]): Promise<void> {
  const nav = navigator as ShareCapableNavigator
  // `share` is checked again defensively even though canShareTheseFiles gates the call.
  if (typeof nav.share !== 'function') throw new DeliveryError('Sharing is not available.')
  await nav.share({ files: [...asFiles] })
}

async function saveWithPicker(file: DeliverableFile): Promise<void> {
  const host = globalThis as SavePickerHost
  const handle = await host.showSaveFilePicker?.({ suggestedName: file.filename })
  if (!handle) throw new DeliveryError('Saving is not available.')
  const writable = await handle.createWritable()
  try {
    await writable.write(file.blob)
  } catch (writeError) {
    // A close() rejection here must not MASK the original write failure — surface the write.
    try {
      await writable.close()
    } catch {
      /* the stream is already failing; the original error is the diagnostic one */
    }
    throw writeError
  }
  await writable.close()
}

async function downloadViaAnchors(files: readonly DeliverableFile[]): Promise<void> {
  for (const [index, file] of files.entries()) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, INTER_DOWNLOAD_DELAY_MS))
    }
    const url = URL.createObjectURL(file.blob)
    // The revocation timer is scheduled BEFORE the click so that even a throwing click path
    // cannot strand an object URL until document death (P40 F5).
    try {
      setTimeout(() => {
        URL.revokeObjectURL(url)
      }, OBJECT_URL_KEEP_ALIVE_MS)
      const link = document.createElement('a')
      link.href = url
      link.download = file.filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }
  }
}

/**
 * Deliver generated artifacts to the user by the best path the current platform offers.
 * Call this from a fresh user-activation event handler (the Save/Share button) with
 * already-generated files — never across an awaited generation (D-078).
 *
 * Throws `DeliveryError` when delivery genuinely failed — including the honest empty case
 * (zero files is a core defect, never "nothing to export") and including NotAllowedError,
 * which after D-078 can no longer be blamed on generation time and is surfaced for the user
 * to answer with the explicit "Download instead" path (`downloadOnly`).
 */
export async function deliverFiles(files: readonly DeliverableFile[]): Promise<DeliveryOutcome> {
  if (files.length === 0) {
    throw new DeliveryError('No files came back from the export. Nothing was saved.')
  }
  const filenames = files.map((file) => file.filename)
  // Built ONCE and reused by the capability probe and the share call (P40 F5).
  const asFiles = toFiles(files)

  if (canShareTheseFiles(asFiles)) {
    try {
      await shareTheseFiles(asFiles)
      return { method: 'share', filenames }
    } catch (error) {
      if (isAbortError(error)) return { method: 'cancelled' }
      if (errorName(error) === 'NotAllowedError') {
        // Permissions Policy, engine security refusal or a real activation problem. Surfaced —
        // the UI keeps the artifacts ready and offers "Download instead" explicitly (D-079).
        throw new DeliveryError('Your browser refused to open sharing for these files.', {
          cause: error,
        })
      }
      throw new DeliveryError('Sharing did not complete.', { cause: error })
    }
  }

  const first = files[0]
  if (files.length === 1 && first !== undefined) {
    const host = globalThis as SavePickerHost
    if (typeof host.showSaveFilePicker === 'function') {
      try {
        await saveWithPicker(first)
        return { method: 'save-picker', filenames }
      } catch (error) {
        if (isAbortError(error)) return { method: 'cancelled' }
        // The picker is an enhancement; if writing through it fails, the ordinary download
        // still works, so fall through instead of failing the whole action.
      }
    }
  }

  await downloadViaAnchors(files)
  return { method: 'download', filenames }
}

/**
 * The explicit download fallback behind the UI's "Download instead" action. Same anchor
 * mechanics as the internal fallback; exists as a named export because choosing it is a user
 * decision, not a silent downgrade (D-079).
 */
export async function downloadOnly(files: readonly DeliverableFile[]): Promise<DeliveryOutcome> {
  if (files.length === 0) {
    throw new DeliveryError('No files came back from the export. Nothing was saved.')
  }
  const filenames = files.map((file) => file.filename)
  await downloadViaAnchors(files)
  return { method: 'download', filenames }
}
