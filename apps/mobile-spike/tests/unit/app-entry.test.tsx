import { act, render, screen } from '@testing-library/react-native'
import { flush, session, FakeAuth, FakePhotoPort } from '../support/fakes'

/**
 * The real entry component (App.tsx), with only the seam to the outside world replaced (the native
 * Supabase client, the image picker). It proves the two properties of the shipped app that no other
 * test can, because every other test builds its own runtime:
 *
 *   - ONE app root: App renders the shell (AppRoot) and nothing else; there is no second entry point
 *     that mounts the Search / Price Check screens on their own.
 *   - ONE runtime per JS runtime: when Android recreates the Activity, React Native mounts App again
 *     in the SAME JS runtime. A runtime created per mount would carry a second set of stores and a
 *     second auth subscription (P167), and the person's screen and draft would be gone.
 */

const mockAuth = new FakeAuth()
const mockPhoto = new FakePhotoPort()
const mockCreateRuntimeCalls: number[] = []

jest.mock('../../src/seam/supabase-client', () => ({
  backendConfig: { ok: true, config: { host: '127.0.0.1' } },
  supabase: {
    get auth() {
      return Object.assign(mockAuth, {
        startAutoRefresh: () => Promise.resolve(),
        stopAutoRefresh: () => Promise.resolve(),
      })
    },
    functions: { invoke: () => Promise.reject(new Error('not used by this test')) },
    from: () => {
      throw new Error('not used by this test')
    },
  },
  clearStoredSession: () => Promise.resolve(),
}))

jest.mock('../../src/photo/expo-photo-port', () => ({
  createExpoPhotoPort: () => mockPhoto,
}))

// P182: the real recognizer transitively imports native-only modules (Skia, onnxruntime-react-
// native, ML Kit) that have no JS implementation for Jest to parse. This test's own job (one app
// root, one runtime per JS runtime) has nothing to do with recognition, so the module is replaced
// wholesale rather than mocking each native dependency it happens to use.
jest.mock('../../src/features/scanner-native/recognition-pipeline', () => ({
  createNativeCardRecognitionPort: () => ({
    implemented: true,
    recognize: () => Promise.reject(new Error('not used by this test')),
  }),
}))

jest.mock('../../src/wiring/runtime', () => {
  const actual = jest.requireActual<typeof import('../../src/wiring/runtime')>(
    '../../src/wiring/runtime',
  )
  return {
    ...actual,
    createRuntime: (deps: Parameters<typeof actual.createRuntime>[0]) => {
      mockCreateRuntimeCalls.push(mockCreateRuntimeCalls.length + 1)
      return actual.createRuntime(deps)
    },
  }
})

// eslint-disable-next-line @typescript-eslint/no-require-imports
const App = (require('../../App') as typeof import('../../App')).default

describe('the app entry', () => {
  it('creates ONE runtime however many times the root is mounted (Activity recreation)', async () => {
    const first = await render(<App />)
    await act(async () => {
      mockAuth.emit('SIGNED_IN', session('A'))
      await flush()
    })
    expect(await screen.findByTestId('tab-search')).toBeTruthy()
    await first.unmount()

    for (let recreation = 0; recreation < 3; recreation += 1) {
      const again = await render(<App />)
      await act(async () => {
        mockAuth.emit('INITIAL_SESSION', session('A'))
        await flush()
      })
      expect(await screen.findByTestId('tab-search')).toBeTruthy()
      await again.unmount()
    }
    expect(mockCreateRuntimeCalls).toEqual([1])
  })

  it('renders the shell: the four tabs, with the Search / Price Check screens inside it', async () => {
    const utils = await render(<App />)
    await act(async () => {
      mockAuth.emit('SIGNED_IN', session('A'))
      await flush()
    })
    for (const id of ['tab-collection', 'tab-search', 'tab-pricecheck', 'tab-profile']) {
      expect(await screen.findByTestId(id)).toBeTruthy()
    }
    await utils.unmount()
    // still the one runtime created above
    expect(mockCreateRuntimeCalls).toEqual([1])
  })
})
