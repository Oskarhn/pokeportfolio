import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAMERA_VIDEO_PROPS,
  openEnvironmentCamera,
  stopActiveScannerCamera,
  visibilityChangeAction,
} from '../../src/features/scanner/camera-session'
import { describeCameraError, hasMediaDevicesSupport } from '../../src/features/scanner/errors'

/**
 * Camera lifecycle rules (prompt §7/§8) verified with fake tracks and an injectable acquire
 * function in a plain Node environment — the same platform-stub discipline as the M13
 * file-delivery tests. The DOMException-name → friendly-copy mapping (§24) is pinned here too,
 * including that camera-denied copy points at "Choose photo", the only remaining path.
 */

type StopFn = ReturnType<typeof vi.fn>

function fakeVideoElement(): { video: HTMLVideoElement; play: StopFn } {
  const play = vi.fn(() => Promise.resolve())
  const video = {
    srcObject: null,
    play,
  } as unknown as HTMLVideoElement
  return { video, play }
}

function fakeStream(trackCount = 1): { stream: MediaStream; stops: StopFn[] } {
  const stops = Array.from({ length: trackCount }, () => vi.fn())
  const tracks = stops.map((stop, index) => ({
    kind: index === 0 ? 'video' : 'audio',
    stop,
  }))
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, stops }
}

afterEach(() => {
  // Never let a fake session leak between tests via the module-level active-session slot.
  stopActiveScannerCamera()
})

describe('camera start semantics', () => {
  it('the preview video carries autoplay + muted + playsInline (iOS-safe inline playback)', () => {
    expect(CAMERA_VIDEO_PROPS.autoPlay).toBe(true)
    expect(CAMERA_VIDEO_PROPS.muted).toBe(true)
    expect(CAMERA_VIDEO_PROPS.playsInline).toBe(true)
  })

  it('requests the environment-facing camera with audio disabled', async () => {
    const acquire = vi.fn(() => Promise.resolve(fakeStream().stream))
    const { video } = fakeVideoElement()
    await openEnvironmentCamera(video, acquire)
    expect(acquire).toHaveBeenCalledWith({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    })
  })

  it('attaches the live stream to the video element and awaits play', async () => {
    const { stream } = fakeStream()
    const { video, play } = fakeVideoElement()
    await openEnvironmentCamera(video, () => Promise.resolve(stream))
    expect(video.srcObject).toBe(stream)
    expect(play).toHaveBeenCalledOnce()
  })

  it('a rejected play() never fails the start — the stream is live regardless', async () => {
    const { video, play } = fakeVideoElement()
    play.mockReturnValueOnce(Promise.reject(new Error('autoplay policy')))
    const session = await openEnvironmentCamera(video, () => Promise.resolve(fakeStream().stream))
    expect(video.srcObject).not.toBeNull()
    session.stop()
  })

  it('with no mediaDevices surface at all, the unsupported error is thrown for friendly mapping', async () => {
    vi.stubGlobal('navigator', {})
    try {
      const { video } = fakeVideoElement()
      await expect(openEnvironmentCamera(video)).rejects.toMatchObject({
        name: 'ScannerCameraUnsupportedError',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the default acquire path calls getUserMedia through navigator.mediaDevices', async () => {
    const { stream } = fakeStream()
    const getUserMedia = vi.fn(() => Promise.resolve(stream))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    try {
      const { video } = fakeVideoElement()
      const session = await openEnvironmentCamera(video)
      expect(getUserMedia).toHaveBeenCalledWith({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      })
      session.stop()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('camera teardown guarantees', () => {
  it('stop() stops EVERY track, detaches the stream, and is idempotent', async () => {
    const { stream, stops } = fakeStream(2)
    const { video } = fakeVideoElement()
    const session = await openEnvironmentCamera(video, () => Promise.resolve(stream))
    session.stop()
    session.stop()
    expect(stops[0]).toHaveBeenCalledTimes(1)
    expect(stops[1]).toHaveBeenCalledTimes(1)
    expect(video.srcObject).toBeNull()
  })

  it('opening a new session while one is live stops the old one first — never two streams', async () => {
    const first = fakeStream(1)
    const second = fakeStream(1)
    const { video } = fakeVideoElement()
    const firstSession = await openEnvironmentCamera(video, () => Promise.resolve(first.stream))
    const secondSession = await openEnvironmentCamera(video, () => Promise.resolve(second.stream))
    expect(first.stops[0]).toHaveBeenCalledTimes(1)
    expect(second.stops[0]).not.toHaveBeenCalled()
    secondSession.stop()
    void firstSession
  })

  it('the safety valve used on unmount/visibility stops whatever session exists', async () => {
    const { stream, stops } = fakeStream(1)
    const { video } = fakeVideoElement()
    await openEnvironmentCamera(video, () => Promise.resolve(stream))
    stopActiveScannerCamera()
    expect(stops[0]).toHaveBeenCalledTimes(1)
    expect(video.srcObject).toBeNull()
  })
})

describe('visibility policy', () => {
  it('releases the hardware when the page hides; keeps it while visible', () => {
    expect(visibilityChangeAction('hidden')).toBe('stop')
    expect(visibilityChangeAction('visible')).toBe('keep')
  })
})

describe('support detection and error mapping', () => {
  it('detects a usable mediaDevices surface precisely', () => {
    expect(hasMediaDevicesSupport(undefined)).toBe(false)
    expect(hasMediaDevicesSupport({})).toBe(false)
    expect(hasMediaDevicesSupport({ mediaDevices: {} })).toBe(false)
    expect(hasMediaDevicesSupport({ mediaDevices: { getUserMedia: () => undefined } })).toBe(true)
  })

  it('permission denied maps to copy that names the Choose-photo fallback', () => {
    const info = describeCameraError(new DOMException('denied', 'NotAllowedError'))
    expect(info.title).toBe('Camera access was blocked')
    expect(info.message).toContain('Choose photo')
    expect(info.message).not.toMatch(/DOMException|NotAllowedError/)
  })

  it('a missing camera maps to honest unavailable copy, not raw internals', () => {
    const info = describeCameraError(new DOMException('none', 'NotFoundError'))
    expect(info.title).toBe('No camera found')
    expect(info.message).toContain('Choose photo')
  })

  it('a busy camera gets its own cause-and-fix message', () => {
    const info = describeCameraError(new DOMException('busy', 'NotReadableError'))
    expect(info.title).toBe('Camera is in use')
  })

  it('an unknown failure stays generic and internal-free', () => {
    const weird = Object.assign(new Error('totally unexpected'), { name: 'WeirdError' })
    const info = describeCameraError(weird)
    expect(info.title).toBe('Camera could not start')
    expect(info.message).not.toContain('WeirdError')
  })

  it('the unsupported-browser class explains itself without jargon', () => {
    const unsupported = Object.assign(new Error('no camera scanning'), {
      name: 'ScannerCameraUnsupportedError',
    })
    const info = describeCameraError(unsupported)
    expect(info.title).toBe('Camera not supported')
    expect(info.message).toContain('Choose photo')
  })
})
