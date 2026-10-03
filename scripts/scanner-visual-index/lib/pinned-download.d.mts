export const DEFAULT_TIMEOUT_MS: number
export const MAX_REDIRECTS: number
export const DEFAULT_MAX_BYTES: number
export const PINNED_SIZE_SLACK_BYTES: number
export function isAllowedDownloadUrl(url: string): boolean
export function byteCeiling(file: { bytes: number | null }, override?: number): number
export function downloadPinnedFile(options: {
  url: string
  dest: string
  expectedSha256: string
  file?: { bytes: number | null }
  maxBytes?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<string>
