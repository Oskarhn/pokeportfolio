import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deliverFiles,
  DeliveryError,
  type DeliverableFile,
} from '../../src/features/export/fileDelivery'

/**
 * The M13 file-delivery dispatch matrix (prompt §15), verified with mocked platform surfaces in a
 * plain Node environment: which path fires for which capability set, how cancellation and real
 * errors differ, and the object-URL lifecycle of the anchor fallback. No export content is ever
 * logged — the mocks assert on filenames/URLs only.
 */

interface ShareMock {
  files?: File[]
  title?: string
  text?: string
}

interface WritableHandle {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>
    close: () => Promise<void>
  }>
}

type PickerFn = (options?: { suggestedName?: string }) => Promise<WritableHandle>
type ShareFn = (data: ShareMock) => Promise<void>
type CanShareFn = (data: ShareMock) => boolean

function file(filename: string): DeliverableFile {
  return { filename, blob: new Blob(['synthetic payload'], { type: 'text/csv' }) }
}

let createObjectURL: ReturnType<typeof vi.fn<() => string>>
let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>
const anchors: {
  href: string
  download: string
  click: ReturnType<typeof vi.fn<() => void>>
}[] = []
let appendChild: ReturnType<typeof vi.fn<(node: unknown) => void>>
let removeChild: ReturnType<typeof vi.fn<(node: unknown) => void>>

beforeEach(() => {
  vi.useFakeTimers()
  delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker
  let urlCounter = 0
  createObjectURL = vi.fn(() => `blob:mock-${++urlCounter}`)
  revokeObjectURL = vi.fn()
  // Node's URL has neither method; patch rather than replace the constructor so unrelated URL
  // use inside the runner keeps working.
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })

  appendChild = vi.fn()
  removeChild = vi.fn()
  const documentStub = {
    createElement: vi.fn(() => {
      const anchor = { href: '', download: '', click: vi.fn() }
      anchors.push(anchor)
      return anchor
    }),
    body: { appendChild, removeChild },
  }
  vi.stubGlobal('document', documentStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker
  const hadCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  if (hadCreate?.configurable) delete (URL as unknown as Record<string, unknown>).createObjectURL
  const hadRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  if (hadRevoke?.configurable) delete (URL as unknown as Record<string, unknown>).revokeObjectURL
  anchors.length = 0
  vi.useRealTimers()
})

function stubNavigator(overrides: { share?: ShareFn | null; canShare?: CanShareFn | null }) {
  vi.stubGlobal('navigator', {
    share: overrides.share ?? undefined,
    canShare: overrides.canShare ?? undefined,
  })
}

describe('deliverFiles', () => {
  it('shares through the Web Share API when the platform accepts files', async () => {
    const share = vi.fn<ShareFn>().mockResolvedValue(undefined)
    stubNavigator({ share, canShare: () => true })

    const outcome = await deliverFiles([file('pokeportfolio-backup-2026-08-24.json')])

    expect(outcome).toEqual({
      method: 'share',
      filenames: ['pokeportfolio-backup-2026-08-24.json'],
    })
    expect(share).toHaveBeenCalledTimes(1)
    expect(share.mock.calls[0]?.[0]?.files?.[0]?.name).toBe('pokeportfolio-backup-2026-08-24.json')
    // Nothing fell through to downloads.
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('shares multiple artifacts in one call when the engine accepts the array', async () => {
    const share = vi.fn<ShareFn>().mockResolvedValue(undefined)
    stubNavigator({ share, canShare: () => true })

    const outcome = await deliverFiles([file('a.csv'), file('b.csv')])

    expect(outcome).toEqual({ method: 'share', filenames: ['a.csv', 'b.csv'] })
    expect(share.mock.calls[0]?.[0]?.files).toHaveLength(2)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('falls back to download when sharing exists but file sharing is unsupported', async () => {
    const share = vi.fn<ShareFn>()
    stubNavigator({ share, canShare: () => false })

    const pending = deliverFiles([file('pokeportfolio-portfolio-2026-08-24.csv')])
    await vi.runAllTimersAsync()

    expect(await pending).toEqual({
      method: 'download',
      filenames: ['pokeportfolio-portfolio-2026-08-24.csv'],
    })
    expect(share).not.toHaveBeenCalled()
  })

  it('treats a dismissed share sheet as cancellation, not an error', async () => {
    const share = vi.fn<ShareFn>().mockRejectedValue(new DOMException('aborted', 'AbortError'))
    stubNavigator({ share, canShare: () => true })

    const outcome = await deliverFiles([file('backup.json')])

    expect(outcome).toEqual({ method: 'cancelled' })
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('falls back to download when share cannot open (transient activation expired)', async () => {
    const share = vi.fn<ShareFn>().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    stubNavigator({ share, canShare: () => true })

    const pending = deliverFiles([file('backup.json')])
    await vi.runAllTimersAsync()

    expect(await pending).toEqual({ method: 'download', filenames: ['backup.json'] })
  })

  it('surfaces a real share failure as an error instead of silently downloading', async () => {
    const share = vi.fn<ShareFn>().mockRejectedValue(new TypeError('bad arguments'))
    stubNavigator({ share, canShare: () => true })

    await expect(deliverFiles([file('backup.json')])).rejects.toThrow(DeliveryError)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('uses the save picker for one file where sharing is unavailable', async () => {
    stubNavigator({ share: null, canShare: null })
    const write = vi.fn<(data: Blob) => Promise<void>>().mockResolvedValue(undefined)
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const picker = vi.fn<PickerFn>().mockResolvedValue({
      createWritable: () => Promise.resolve({ write, close }),
    })
    ;(globalThis as { showSaveFilePicker?: PickerFn }).showSaveFilePicker = picker

    const filename = 'pokeportfolio-backup-2026-08-24.json'
    const outcome = await deliverFiles([file(filename)])

    expect(outcome).toEqual({ method: 'save-picker', filenames: [filename] })
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: filename }))
    expect(write).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('treats a cancelled save dialog as cancellation', async () => {
    stubNavigator({ share: null, canShare: null })
    ;(globalThis as { showSaveFilePicker?: PickerFn }).showSaveFilePicker = vi
      .fn<PickerFn>()
      .mockRejectedValue(new DOMException('user cancelled', 'AbortError'))

    const outcome = await deliverFiles([file('backup.json')])

    expect(outcome).toEqual({ method: 'cancelled' })
  })

  it('falls back to download when the picker fails mid-write', async () => {
    stubNavigator({ share: null, canShare: null })
    ;(globalThis as { showSaveFilePicker?: PickerFn }).showSaveFilePicker = vi
      .fn<PickerFn>()
      .mockResolvedValue({
        createWritable: () =>
          Promise.resolve({
            write: () => Promise.reject(new Error('disk full')),
            close: () => Promise.resolve(undefined),
          }),
      })

    const pending = deliverFiles([file('backup.json')])
    await vi.runAllTimersAsync()

    expect(await pending).toEqual({ method: 'download', filenames: ['backup.json'] })
  })

  it('downloads via an object URL and revokes it after the click', async () => {
    stubNavigator({ share: null, canShare: null })

    const filename = 'pokeportfolio-portfolio-2026-08-24.csv'
    const pending = deliverFiles([file(filename)])
    await vi.runAllTimersAsync()

    expect(await pending).toEqual({ method: 'download', filenames: [filename] })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]?.href).toBe('blob:mock-1')
    expect(anchors[0]?.download).toBe(filename)
    expect(anchors[0]?.click).toHaveBeenCalledTimes(1)
    expect(appendChild).toHaveBeenCalledTimes(1)
    expect(removeChild).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
  })

  it('delivers several artifacts as sequential downloads, every URL revoked', async () => {
    stubNavigator({ share: null, canShare: null })

    const names = ['holdings.csv', 'purchases.csv', 'sales.csv']
    const pending = deliverFiles(names.map((name) => file(name)))
    await vi.runAllTimersAsync()

    expect(await pending).toEqual({ method: 'download', filenames: names })
    expect(anchors.map((anchor) => anchor.download)).toEqual(names)
    expect(createObjectURL).toHaveBeenCalledTimes(3)
    expect(revokeObjectURL).toHaveBeenCalledTimes(3)
    for (const anchor of anchors) expect(anchor.click).toHaveBeenCalledTimes(1)
  })

  it('rejects an empty artifact response honestly instead of delivering nothing quietly', async () => {
    stubNavigator({ share: () => Promise.resolve(undefined), canShare: () => true })

    await expect(deliverFiles([])).rejects.toThrow(DeliveryError)
    await expect(deliverFiles([])).rejects.toThrow(/No files came back/)
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})
