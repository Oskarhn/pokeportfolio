import type { ScannerCandidateRecord } from '@shared/domain/scanner/types'

// The pipeline's native collaborators are injected (RecognitionPipelineDeps) so this file tests the
// DECISIONS — safety order, checkpoints, cancellation, fusion policy, privacy — with the real
// engine and the real header sniffer. The modules below are only imported for their types/defaults
// and are mocked so Jest never loads native code.
jest.mock('expo-file-system', () => ({ File: class {} }))
jest.mock('@shopify/react-native-skia/src/skia/NativeSetup', () => ({}))
jest.mock('@shopify/react-native-skia/src/skia/Skia', () => ({ Skia: {} }))
jest.mock('@shopify/react-native-skia/src/skia/types/Image/ImageFactory', () => ({
  AlphaType: { Unpremul: 3 },
}))
jest.mock('@shopify/react-native-skia/src/skia/types/Image/ColorType', () => ({
  ColorType: { RGBA_8888: 4 },
}))
jest.mock('@react-native-ml-kit/text-recognition', () => ({
  __esModule: true,
  default: { recognize: jest.fn() },
  TextRecognitionScript: { LATIN: 'latin' },
}))
jest.mock('onnxruntime-react-native', () => ({
  InferenceSession: { create: jest.fn() },
  Tensor: class {},
}))
jest.mock('../../src/features/scanner-native/visual-adapter', () => ({
  getVisualSession: jest.fn(),
}))
jest.mock('expo-asset', () => ({ Asset: { fromModule: jest.fn() } }))
jest.mock('expo-crypto', () => ({
  digest: jest.fn(),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}))

import {
  createNativeCardRecognitionPort,
  type RecognitionPipelineDeps,
} from '../../src/features/scanner-native/recognition-pipeline'
import { ImageDecodeError } from '../../src/features/scanner-native/image-decode'
import {
  resetScanTraceSink,
  setScanTraceSink,
  type NativeTraceEvent,
  type ScanTraceEvent,
} from '../../src/features/scanner-native/scan-trace'
import { deferred, flush } from '../support/fakes'

// ---------------------------------------------------------------------------------------------
// Fixtures: minimal but real image containers (only the header matters to the sniffer) and
// scripted collaborators.
// ---------------------------------------------------------------------------------------------

function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9,
  ])
}

function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33)
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(out.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return out
}

const CARD_W = 1000
const CARD_H = 1400

function card(
  id: string,
  name: string,
  localId: string,
  extra: Partial<ScannerCandidateRecord> = {},
): ScannerCandidateRecord {
  return {
    cardId: id,
    name,
    localId,
    rarity: null,
    category: 'Pokemon',
    illustrator: null,
    imageBaseUrl: null,
    language: 'en',
    setId: `set-${id}`,
    setName: `Set ${id}`,
    variantCount: 1,
    ...extra,
  }
}

interface Script {
  bytes: Uint8Array
  size?: number
  ocr: { name: string | null; number: string | null } | 'fail'
  visual: { cardId: string; similarity: number }[] | 'fail'
  catalog: ScannerCandidateRecord[]
  decodeError?: ImageDecodeError | Error
}

interface Calls {
  readBytes: number
  decode: number
  ocr: number
  session: number
  embed: number
  search: number
  retrieve: number
  retrieveArgs: unknown[]
}

function makeDeps(
  script: Script,
  hooks: Partial<Record<'afterDecode' | 'ocr' | 'embed' | 'retrieve', () => Promise<void>>> = {},
) {
  const calls: Calls = {
    readBytes: 0,
    decode: 0,
    ocr: 0,
    session: 0,
    embed: 0,
    search: 0,
    retrieve: 0,
    retrieveArgs: [],
  }
  const deps: RecognitionPipelineDeps = {
    readFile: () =>
      Promise.resolve({
        size: script.size ?? script.bytes.length,
        bytes: () => {
          calls.readBytes += 1
          return Promise.resolve(script.bytes)
        },
      }),
    decode: () => {
      calls.decode += 1
      if (script.decodeError) throw script.decodeError
      return {
        data: new Uint8ClampedArray(4),
        width: 1000,
        height: 1400,
        originalWidth: CARD_W,
        originalHeight: CARD_H,
      }
    },
    ocr: async () => {
      calls.ocr += 1
      if (hooks.ocr) await hooks.ocr()
      if (script.ocr === 'fail') throw new Error('ocr failed')
      return {
        fullText: '',
        rawNameText: script.ocr.name,
        rawCollectorNumberText: script.ocr.number,
        nameOcrConfidence: null,
        collectorOcrConfidence: null,
      }
    },
    visualSession: () => {
      calls.session += 1
      return Promise.resolve({
        embed: () => Promise.resolve(new Float32Array(1)),
        embedTimed: async () => {
          calls.embed += 1
          if (hooks.embed) await hooks.embed()
          if (script.visual === 'fail') throw new Error('onnx failed')
          return { vector: new Float32Array(1), preprocessMs: 1, onnxMs: 2 }
        },
        search: () => {
          calls.search += 1
          return script.visual === 'fail' ? [] : script.visual
        },
        dispose: () => Promise.resolve(),
      })
    },
    retrieve: async (input) => {
      calls.retrieve += 1
      calls.retrieveArgs.push(input)
      if (hooks.retrieve) await hooks.retrieve()
      const wanted = new Set(input.visualCardIds)
      // Text retrieval finds rows by what OCR read; the visual channel adds its ids. Both are
      // served from the same scripted catalog here.
      return script.catalog.filter(
        (row) =>
          wanted.has(row.cardId) ||
          (input.ocrName !== null &&
            row.name.toLowerCase().includes(input.ocrName.toLowerCase().slice(0, 4))) ||
          (input.ocrCollectorNumber !== null &&
            input.ocrCollectorNumber.startsWith(row.localId.replace(/^0+/, ''))),
      )
    },
  }
  return { deps, calls }
}

const IMAGE = { uri: 'file:///cache/ImagePicker/secret-card-photo.jpg', width: 1000, height: 1400 }

function traceCollector() {
  const events: NativeTraceEvent[] = []
  setScanTraceSink((event) => events.push(event))
  return events
}
const scans = (events: NativeTraceEvent[]): ScanTraceEvent[] =>
  events.filter((e): e is ScanTraceEvent => e.kind === 'scan')

afterEach(() => resetScanTraceSink())

function baseScript(overrides: Partial<Script> = {}): Script {
  return {
    bytes: jpeg(CARD_W, CARD_H),
    ocr: { name: 'P184 Alpha', number: '007/999' },
    visual: [{ cardId: 'alpha', similarity: 0.9 }],
    catalog: [card('alpha', 'P184 Alpha', '007')],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------------------------
// Image safety: refused BEFORE any decode / OCR / model work.
// ---------------------------------------------------------------------------------------------

describe('image safety runs on the container header, before decode/OCR/model', () => {
  const stopped = (calls: Calls): void => {
    expect(calls.decode).toBe(0)
    expect(calls.ocr).toBe(0)
    expect(calls.session).toBe(0)
    expect(calls.embed).toBe(0)
    expect(calls.retrieve).toBe(0)
  }

  it.each([
    ['huge JPEG (30000x30000, a few bytes on disk)', jpeg(30000, 30000)],
    ['huge PNG (65535x65535 pixel bomb)', png(65535, 65535)],
    ['zero-dimension JPEG', jpeg(0, 0)],
    ['zero-width PNG', png(0, 1400)],
    ['extreme aspect ratio', jpeg(8000, 100)],
    ['tiny image', jpeg(16, 16)],
  ])('%s -> abstain_quality, nothing downstream ran', async (_label, bytes) => {
    const events = traceCollector()
    const { deps, calls } = makeDeps(baseScript({ bytes }))
    const outcome = await createNativeCardRecognitionPort(deps).recognize(IMAGE)
    expect(outcome.status).toBe('abstain_quality')
    stopped(calls)
    expect(scans(events)[0]?.outcome).toBe('abstain_quality')
  })

  it('an oversized file is refused before its bytes are even read', async () => {
    const { deps, calls } = makeDeps(baseScript({ size: 11 * 1024 * 1024 }))
    const outcome = await createNativeCardRecognitionPort(deps).recognize(IMAGE)
    expect(outcome.status).toBe('abstain_quality')
    expect(calls.readBytes).toBe(0)
    stopped(calls)
  })

  it.each([
    ['PDF masquerading as an image', new TextEncoder().encode('%PDF-1.7 not a picture at all....')],
    ['plain text', new TextEncoder().encode('hello this is definitely not an image file')],
    ['empty file', new Uint8Array(0)],
    [
      'truncated JPEG (no frame header)',
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
    ],
    [
      'HEIC (unsupported container)',
      new Uint8Array([
        0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
      ]),
    ],
  ])('%s -> abstain_quality (unsupported), nothing downstream ran', async (_label, bytes) => {
    const { deps, calls } = makeDeps(baseScript({ bytes }))
    const outcome = await createNativeCardRecognitionPort(deps).recognize(IMAGE)
    expect(outcome).toEqual({ status: 'abstain_quality', reason: 'This photo could not be read.' })
    stopped(calls)
  })

  it('a corrupt image that passes the header check but fails the decoder abstains and skips OCR', async () => {
    const { deps, calls } = makeDeps(
      baseScript({ decodeError: new ImageDecodeError('bad', 'corrupt') }),
    )
    const outcome = await createNativeCardRecognitionPort(deps).recognize(IMAGE)
    expect(outcome.status).toBe('abstain_quality')
    expect(calls.decode).toBe(1)
    expect(calls.ocr).toBe(0)
    expect(calls.session).toBe(0)
  })

  it('an unexpected decoder crash is an error, never a silent success', async () => {
    const { deps } = makeDeps(baseScript({ decodeError: new Error('native crash') }))
    const outcome = await createNativeCardRecognitionPort(deps).recognize(IMAGE)
    expect(outcome.status).toBe('error')
  })
})

// ---------------------------------------------------------------------------------------------
// Fusion policy through the REAL engine + P165 interpretScan.
// ---------------------------------------------------------------------------------------------

async function scanWith(script: Script) {
  const events = traceCollector()
  const { deps, calls } = makeDeps(script)
  const outcome = await createNativeCardRecognitionPort(deps).recognize(IMAGE)
  return { outcome, trace: scans(events)[0] as ScanTraceEvent, calls }
}

function kindOf(
  outcome: Awaited<ReturnType<ReturnType<typeof createNativeCardRecognitionPort>['recognize']>>,
) {
  return outcome.status === 'analysed' ? outcome.outcome.kind : outcome.status
}

describe('confidence policy: never a false HIGH', () => {
  it.each([0.05, 0.3, 0.5, 0.6, 0.67])(
    'weak visual-only (similarity %s, OCR read nothing) is never HIGH and never pre-selects',
    async (similarity) => {
      const { outcome, trace } = await scanWith(
        baseScript({
          ocr: { name: null, number: null },
          visual: [{ cardId: 'alpha', similarity }],
        }),
      )
      expect(kindOf(outcome)).not.toBe('high')
      expect(trace.preselectedId).toBeNull()
    },
  )

  it('moderate visual-only (0.72) is never HIGH', async () => {
    const { outcome } = await scanWith(
      baseScript({
        ocr: { name: null, number: null },
        visual: [{ cardId: 'alpha', similarity: 0.72 }],
      }),
    )
    expect(kindOf(outcome)).not.toBe('high')
  })

  it('OCR names card A exactly while the visual channel strongly says B: no HIGH, no pre-selection', async () => {
    const { outcome, trace } = await scanWith(
      baseScript({
        ocr: { name: 'P184 Bravo', number: '012/999' },
        visual: [
          { cardId: 'other', similarity: 0.93 },
          { cardId: 'bravo', similarity: 0.4 },
        ],
        catalog: [card('bravo', 'P184 Bravo', '012'), card('other', 'P184 Other', '088')],
      }),
    )
    expect(kindOf(outcome)).not.toBe('high')
    expect(trace.preselectedId).toBeNull()
  })

  it('visual says A while the printed number says B: no HIGH for either', async () => {
    const { outcome } = await scanWith(
      baseScript({
        ocr: { name: 'P184 Charlie', number: '044/999' },
        visual: [{ cardId: 'c21', similarity: 0.92 }],
        catalog: [card('c21', 'P184 Charlie', '021'), card('c44', 'P184 Charlie', '044')],
      }),
    )
    expect(kindOf(outcome)).not.toBe('high')
  })

  it('same-art reprints (two near-identical visual hits, same name, no readable number) never auto-confirm', async () => {
    const { outcome } = await scanWith(
      baseScript({
        ocr: { name: 'P184 Delta', number: null },
        visual: [
          { cardId: 'delta-a', similarity: 0.931 },
          { cardId: 'delta-b', similarity: 0.929 },
        ],
        catalog: [
          card('delta-a', 'P184 Delta', '015'),
          card('delta-b', 'P184 Delta', '015', { setId: 'reprint' }),
        ],
      }),
    )
    expect(kindOf(outcome)).not.toBe('high')
  })

  it('same collector number in two sets, name unreadable: ambiguity is not HIGH', async () => {
    const { outcome } = await scanWith(
      baseScript({
        ocr: { name: null, number: '023/999' },
        visual: [],
        catalog: [card('n1', 'P184 Echo', '023'), card('n2', 'P184 Foxtrot', '023')],
      }),
    )
    expect(kindOf(outcome)).not.toBe('high')
  })

  it('a photo with nothing usable is no_match with NO candidates — the first retrieved row is never promoted', async () => {
    const { outcome, trace } = await scanWith(
      baseScript({
        ocr: { name: null, number: null },
        visual: [{ cardId: 'alpha', similarity: 0.2 }],
        catalog: [card('alpha', 'P184 Alpha', '007')],
      }),
    )
    expect(kindOf(outcome)).toBe('no_match')
    expect(trace.topCandidateIds).toEqual([])
  })

  it('a controlled positive (exact name + number, visual agrees) reaches HIGH and only pre-selects', async () => {
    const { outcome, trace } = await scanWith(baseScript())
    expect(outcome.status).toBe('analysed')
    if (outcome.status !== 'analysed' || outcome.outcome.kind !== 'high') {
      throw new Error(`expected HIGH, got ${JSON.stringify(outcome)}`)
    }
    expect(outcome.outcome.preselectedId).toBe('alpha')
    expect(trace.tier).toBe('HIGH')
    // The outcome carries card identity only: no printing, finish, condition, grade or price.
    const keys = new Set(
      outcome.outcome.candidates.flatMap((c) =>
        Object.keys(c as unknown as Record<string, unknown>),
      ),
    )
    for (const forbidden of [
      'variantId',
      'printingId',
      'finish',
      'condition',
      'grade',
      'price',
      'quantity',
    ]) {
      expect(keys.has(forbidden)).toBe(false)
    }
    expect(Object.keys(outcome.outcome).sort()).toEqual(['candidates', 'kind', 'preselectedId'])
  })

  it('the HIGH pre-selection is the card the engine ranked first, even after catalog filtering', async () => {
    const { outcome } = await scanWith(baseScript())
    if (outcome.status !== 'analysed' || outcome.outcome.kind !== 'high')
      throw new Error('expected HIGH')
    expect(outcome.outcome.candidates[0]?.candidateId).toBe(outcome.outcome.preselectedId)
  })

  it('OCR failure with a weak visual read degrades, it does not throw or invent a card', async () => {
    const { outcome, trace } = await scanWith(
      baseScript({ ocr: 'fail', visual: [{ cardId: 'alpha', similarity: 0.3 }] }),
    )
    expect(trace.ocr?.failed).toBe(true)
    expect(kindOf(outcome)).not.toBe('high')
  })

  it('a failed visual channel falls back to OCR-only and is recorded', async () => {
    const { trace } = await scanWith(baseScript({ visual: 'fail' }))
    expect(trace.visualFailed).toBe(true)
    expect(trace.outcome).toBe('analysed')
  })
})

// ---------------------------------------------------------------------------------------------
// Latest capture wins, cancellation, identity.
// ---------------------------------------------------------------------------------------------

describe('latest capture wins and cancellation', () => {
  it('A is slow, B finishes first, A finishes later: only B publishes and A never reaches retrieval', async () => {
    const gate = deferred<void>()
    let ocrCall = 0
    const events = traceCollector()
    const { deps, calls } = makeDeps(baseScript(), {
      ocr: () => {
        ocrCall += 1
        return ocrCall === 1 ? gate.promise : Promise.resolve()
      },
    })
    const port = createNativeCardRecognitionPort(deps)
    const a = port.recognize(IMAGE)
    await flush(20)
    const b = port.recognize(IMAGE)
    const bOutcome = await b
    expect(bOutcome.status).toBe('analysed')
    gate.resolve()
    expect(await a).toEqual({ status: 'cancelled' })
    expect(calls.retrieve).toBe(1)
    expect(scans(events).map((e) => e.outcome)).toEqual(['analysed', 'cancelled'])
  })

  it('rapid captures: only the last of ten publishes', async () => {
    const gates = Array.from({ length: 10 }, () => deferred<void>())
    let n = 0
    const { deps } = makeDeps(baseScript(), {
      ocr: () => (gates[n++] as ReturnType<typeof deferred<void>>).promise,
    })
    const port = createNativeCardRecognitionPort(deps)
    const runs = gates.map(() => port.recognize(IMAGE))
    await flush(30)
    // Release in reverse so the newest finishes first and the oldest last.
    for (let i = gates.length - 1; i >= 0; i -= 1) gates[i]?.resolve()
    const results = await Promise.all(runs)
    expect(results.filter((r) => r.status === 'analysed')).toHaveLength(1)
    expect(results[9]?.status).toBe('analysed')
    expect(results.slice(0, 9).every((r) => r.status === 'cancelled')).toBe(true)
  })

  it('cancelActive() (app backgrounded) stops the scan at the next checkpoint: no model run, no network', async () => {
    const gate = deferred<void>()
    const { deps, calls } = makeDeps(baseScript(), { ocr: () => gate.promise })
    const port = createNativeCardRecognitionPort(deps)
    const scan = port.recognize(IMAGE)
    await flush(20)
    port.cancelActive?.()
    gate.resolve()
    expect(await scan).toEqual({ status: 'cancelled' })
    expect(calls.embed).toBe(0)
    expect(calls.retrieve).toBe(0)
  })

  it('cancellation between embed and retrieval prevents the catalog query', async () => {
    const gate = deferred<void>()
    const { deps, calls } = makeDeps(baseScript(), { embed: () => gate.promise })
    const port = createNativeCardRecognitionPort(deps)
    const scan = port.recognize(IMAGE)
    await flush(30)
    port.cancelActive?.()
    gate.resolve()
    expect(await scan).toEqual({ status: 'cancelled' })
    expect(calls.retrieve).toBe(0)
  })

  it('a cancelled scan whose stage later throws is still reported as cancelled, not as an error', async () => {
    const gate = deferred<void>()
    const { deps } = makeDeps(baseScript({ visual: 'fail' }), { embed: () => gate.promise })
    const port = createNativeCardRecognitionPort(deps)
    const scan = port.recognize(IMAGE)
    await flush(30)
    port.reset?.()
    gate.resolve()
    expect((await scan).status).toBe('cancelled')
  })
})

describe('identity boundary', () => {
  it('a scan started as A never publishes after the identity was reset to B, and B works', async () => {
    const gate = deferred<void>()
    let first = true
    const { deps } = makeDeps(baseScript(), {
      retrieve: () => {
        if (first) {
          first = false
          return gate.promise
        }
        return Promise.resolve()
      },
    })
    const port = createNativeCardRecognitionPort(deps)
    const aScan = port.recognize(IMAGE)
    await flush(30)
    port.reset?.() // A -> B
    gate.resolve()
    expect(await aScan).toEqual({ status: 'cancelled' })
    expect((await port.recognize(IMAGE)).status).toBe('analysed')
  })

  it('A -> B -> A: the old A scan stays invalid after the identity returns to A', async () => {
    const gate = deferred<void>()
    let first = true
    const { deps } = makeDeps(baseScript(), {
      ocr: () => {
        if (first) {
          first = false
          return gate.promise
        }
        return Promise.resolve()
      },
    })
    const port = createNativeCardRecognitionPort(deps)
    const oldA = port.recognize(IMAGE)
    await flush(30)
    port.reset?.() // A -> B
    port.reset?.() // B -> A
    gate.resolve()
    expect(await oldA).toEqual({ status: 'cancelled' })
  })

  it('a token refresh of the SAME user is not an identity change: the scan in flight completes', async () => {
    const gate = deferred<void>()
    const { deps } = makeDeps(baseScript(), { ocr: () => gate.promise })
    const port = createNativeCardRecognitionPort(deps)
    const scan = port.recognize(IMAGE)
    await flush(20)
    // A refresh emits no reset (only an identity change does); nothing is called on the port.
    gate.resolve()
    expect((await scan).status).toBe('analysed')
  })
})

// ---------------------------------------------------------------------------------------------
// Privacy: the image never leaves the device.
// ---------------------------------------------------------------------------------------------

describe('image privacy', () => {
  it('no network primitive is touched during a full scan, and retrieval only receives text and card ids', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network used')
    })
    const xhrSpy = jest.fn()
    const realXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest
    ;(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = xhrSpy
    try {
      const { deps, calls } = makeDeps(baseScript())
      const outcome = await createNativeCardRecognitionPort(deps).recognize(IMAGE)
      expect(outcome.status).toBe('analysed')
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(xhrSpy).not.toHaveBeenCalled()
      const arg = JSON.stringify(calls.retrieveArgs)
      expect(arg).not.toContain('file://')
      expect(arg).not.toContain('secret-card-photo')
      expect(Object.keys(calls.retrieveArgs[0] as object).sort()).toEqual([
        'ocrCollectorNumber',
        'ocrName',
        'visualCardIds',
      ])
    } finally {
      fetchSpy.mockRestore()
      ;(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = realXhr
    }
  })

  it('the trace never carries the image URI, file name or pixels', async () => {
    const events = traceCollector()
    const { deps } = makeDeps(baseScript())
    await createNativeCardRecognitionPort(deps).recognize(IMAGE)
    const serialised = JSON.stringify(events)
    expect(serialised).not.toContain('file://')
    expect(serialised).not.toContain('secret-card-photo')
    expect(serialised).not.toContain('ImagePicker')
  })

  it('recognition is read-only: the pipeline module graph imports no write path', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path')
    const dir = path.resolve(__dirname, '../../src/features/scanner-native')
    const forbidden = [
      /\/write\//,
      /purchase/i,
      /sale/i,
      /\.insert\(/,
      /\.upsert\(/,
      /\.delete\(/,
      /\.rpc\(/,
      /fetch\(/,
      /XMLHttpRequest/,
      /upload/i,
    ]
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      // Comments explain the privacy contract in words ("never uploaded"); only code counts.
      const source = fs
        .readFileSync(path.join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      for (const pattern of forbidden) {
        expect({ file, pattern: String(pattern), hit: pattern.test(source) }).toEqual({
          file,
          pattern: String(pattern),
          hit: false,
        })
      }
    }
  })
})

describe('trace', () => {
  it('records stage timings and the decision trail of a scan', async () => {
    const { trace } = await scanWith(baseScript())
    expect(trace.stages.totalMs).toBeGreaterThanOrEqual(0)
    for (const stage of [
      'readMs',
      'headerMs',
      'decodeMs',
      'ocrMs',
      'onnxMs',
      'preprocessMs',
      'searchMs',
      'retrievalMs',
      'fusionMs',
    ] as const) {
      expect(trace.stages[stage]).toEqual(expect.any(Number))
    }
    expect(trace.ocr).toEqual({ name: 'P184 Alpha', number: '007/999', failed: false })
    expect(trace.visualTop[0]?.cardId).toBe('alpha')
    expect(trace.topCandidateIds).toEqual(['alpha'])
  })
})
