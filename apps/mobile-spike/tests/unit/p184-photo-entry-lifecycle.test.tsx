import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { act, render, screen, fireEvent } from '@testing-library/react-native'
import { AppState, type AppStateStatus } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { P169FeatureProvider, type P169StackParams } from '../../src/features/navigation'
import type {
  CardRecognitionPort,
  RecognitionOutcome,
} from '../../src/features/price-check/recognition'
import { P169_SCREENS } from '../../src/features/screens'
import type { PhotoOutcome } from '../../src/photo/photo-store'
import { RuntimeProvider } from '../../src/ui/runtime-context'
import { deferred, flush, harness, session, type Deferred } from '../support/fakes'
import { STANDARD_FX, fakeFx, FakeInvoker, FakeCatalog } from '../support/p169-fakes'

/**
 * PhotoEntryScreen around a CONTROLLABLE recognition port (P184): latest capture wins at the
 * screen, no result after leaving the screen, cancellation and resume around backgrounding,
 * identity A -> B / A -> B -> A, and "exactly one recognition per photo".
 */

const Stack = createNativeStackNavigator<P169StackParams>()

const photo = (n: number): PhotoOutcome => ({
  status: 'picked',
  image: {
    kind: 'local_image',
    uri: `file:///cache/ImagePicker/photo-${String(n)}.jpg`,
    width: 1000,
    height: 1400,
    source: 'library',
    acquiredAt: '2026-09-28T10:00:00.000Z',
  },
})

const analysed = (id: string, name: string): RecognitionOutcome => ({
  status: 'analysed',
  outcome: {
    kind: 'review',
    confidence: 'MEDIUM',
    candidates: [
      {
        candidateId: id,
        name,
        setName: 'P184 Set',
        collectorNumber: '007',
        imageBaseUrl: null,
        languageLabel: 'English',
      },
    ],
  },
})

class ScriptedPort implements CardRecognitionPort {
  readonly implemented = true
  readonly calls: Deferred<RecognitionOutcome>[] = []
  cancelActiveCalls = 0
  resetCalls = 0
  recognize(): Promise<RecognitionOutcome> {
    const pending = deferred<RecognitionOutcome>()
    this.calls.push(pending)
    return pending.promise
  }
  cancelActive(): void {
    this.cancelActiveCalls += 1
  }
  reset(): void {
    this.resetCalls += 1
  }
}

let appStateHandlers: ((state: AppStateStatus) => void)[] = []
beforeEach(() => {
  appStateHandlers = []
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    appStateHandlers.push(handler)
    return { remove: () => undefined }
  })
  ;(AppState as { currentState: AppStateStatus }).currentState = 'active'
})
afterEach(() => jest.restoreAllMocks())

const emitAppState = async (state: AppStateStatus): Promise<void> => {
  ;(AppState as { currentState: AppStateStatus }).currentState = state
  await act(async () => {
    for (const handler of appStateHandlers) handler(state)
    await flush(10)
  })
}

async function mount() {
  const port = new ScriptedPort()
  const invoker = new FakeInvoker()
  const h = harness({
    priceFeature: {
      invoke: invoker.invoke,
      readFx: fakeFx(STANDARD_FX),
      catalog: new FakeCatalog(),
      recognition: port,
    },
  })
  h.auth.emit('SIGNED_IN', session('A'))
  const ref = createNavigationContainerRef<P169StackParams>()
  await render(
    <SafeAreaProvider>
      <RuntimeProvider runtime={h.runtime}>
        <P169FeatureProvider
          feature={h.runtime.feature}
          host={{ onAddToCollection: () => undefined }}
        >
          <NavigationContainer ref={ref}>
            <Stack.Navigator>
              {P169_SCREENS.map((s) => (
                <Stack.Screen key={s.name} name={s.name} component={s.component} />
              ))}
            </Stack.Navigator>
          </NavigationContainer>
        </P169FeatureProvider>
      </RuntimeProvider>
    </SafeAreaProvider>,
  )
  await act(async () => {
    ref.navigate('P169PhotoEntry')
    await flush(10)
  })
  return { h, port, ref }
}

async function pick(h: ReturnType<typeof harness>, n: number): Promise<void> {
  h.photo.outcome = photo(n)
  await act(async () => {
    await fireEvent.press(screen.getByTestId('p169-photo-library'))
    await flush(20)
  })
}

const settle = async (d: Deferred<RecognitionOutcome>, outcome: RecognitionOutcome) => {
  await act(async () => {
    d.resolve(outcome)
    await flush(20)
  })
}

describe('recognition on the photo entry screen', () => {
  it('starts exactly one recognition for a photo and shows its candidate', async () => {
    const { h, port } = await mount()
    await pick(h, 1)
    expect(port.calls).toHaveLength(1)
    expect(screen.getByText('Analysing the photo')).toBeTruthy()
    await settle(port.calls[0] as Deferred<RecognitionOutcome>, analysed('cand-1', 'P184 Alpha'))
    expect(screen.getByTestId('p169-recognition-candidate-cand-1')).toBeTruthy()
    expect(port.calls).toHaveLength(1)
  })

  it('latest capture wins: photo B analysed first, photo A finishing later never flashes', async () => {
    const { h, port } = await mount()
    await pick(h, 1)
    await pick(h, 2)
    expect(port.calls).toHaveLength(2)
    await settle(port.calls[1] as Deferred<RecognitionOutcome>, analysed('cand-B', 'P184 Bravo'))
    expect(screen.getByTestId('p169-recognition-candidate-cand-B')).toBeTruthy()
    await settle(port.calls[0] as Deferred<RecognitionOutcome>, analysed('cand-A', 'P184 Alpha'))
    expect(screen.queryByTestId('p169-recognition-candidate-cand-A')).toBeNull()
    expect(screen.getByTestId('p169-recognition-candidate-cand-B')).toBeTruthy()
  })

  it('leaving the screen mid-recognition leaves no result and no state for the next entry', async () => {
    const { h, port, ref } = await mount()
    await pick(h, 1)
    await act(async () => {
      ref.navigate('P169Search')
      await flush(20)
    })
    // The photo is released when the screen loses focus.
    expect(h.runtime.photo.getSnapshot().image).toBeNull()
    expect(port.cancelActiveCalls).toBeGreaterThanOrEqual(1)
    await settle(port.calls[0] as Deferred<RecognitionOutcome>, analysed('cand-A', 'P184 Alpha'))
    await act(async () => {
      ref.goBack()
      await flush(20)
    })
    expect(screen.queryByTestId('p169-recognition-candidate-cand-A')).toBeNull()
    expect(screen.queryByTestId('p169-recognition-result')).toBeNull()
    expect(port.calls).toHaveLength(1)
  })
})

describe('backgrounding', () => {
  it('cancels the running recognition, and analyses the same photo once when the app returns', async () => {
    const { h, port } = await mount()
    await pick(h, 1)
    const cancelsBefore = port.cancelActiveCalls
    await emitAppState('background')
    expect(port.cancelActiveCalls).toBe(cancelsBefore + 1)
    // The pipeline reports the cancelled scan at its next checkpoint; the app is still backgrounded.
    await settle(port.calls[0] as Deferred<RecognitionOutcome>, { status: 'cancelled' })
    expect(port.calls).toHaveLength(1)
    await emitAppState('active')
    expect(port.calls).toHaveLength(2)
    await settle(port.calls[1] as Deferred<RecognitionOutcome>, analysed('cand-1', 'P184 Alpha'))
    expect(screen.getByTestId('p169-recognition-candidate-cand-1')).toBeTruthy()
  })

  it('a cancelled answer that arrives AFTER the app is already back re-analyses instead of staying blank', async () => {
    const { h, port } = await mount()
    await pick(h, 1)
    await emitAppState('background')
    await emitAppState('active') // recognition still in flight: no second one
    expect(port.calls).toHaveLength(1)
    await settle(port.calls[0] as Deferred<RecognitionOutcome>, { status: 'cancelled' })
    expect(port.calls).toHaveLength(2)
    await settle(port.calls[1] as Deferred<RecognitionOutcome>, analysed('cand-1', 'P184 Alpha'))
    expect(screen.getByTestId('p169-recognition-candidate-cand-1')).toBeTruthy()
  })

  it('returning from the system photo picker (background -> active, no photo yet) starts nothing', async () => {
    const { port } = await mount()
    await emitAppState('background')
    await emitAppState('active')
    expect(port.calls).toHaveLength(0)
  })

  it('a finished result is kept across background -> active, not analysed again', async () => {
    const { h, port } = await mount()
    await pick(h, 1)
    await settle(port.calls[0] as Deferred<RecognitionOutcome>, analysed('cand-1', 'P184 Alpha'))
    await emitAppState('background')
    await emitAppState('active')
    expect(port.calls).toHaveLength(1)
    expect(screen.getByTestId('p169-recognition-candidate-cand-1')).toBeTruthy()
  })
})

describe('identity', () => {
  it('A -> B cancels recognition through the registry and drops the photo and the answer', async () => {
    const { h, port } = await mount()
    await pick(h, 1)
    await act(async () => {
      h.auth.emit('SIGNED_IN', session('B'))
      await flush(20)
    })
    expect(port.resetCalls).toBeGreaterThanOrEqual(1)
    expect(h.runtime.photo.getSnapshot().image).toBeNull()
    await settle(port.calls[0] as Deferred<RecognitionOutcome>, analysed('cand-A', 'P184 Alpha'))
    expect(screen.queryByTestId('p169-recognition-candidate-cand-A')).toBeNull()
  })

  it('A -> B -> A keeps the old scan invalid', async () => {
    const { h, port } = await mount()
    await pick(h, 1)
    await act(async () => {
      h.auth.emit('SIGNED_IN', session('B'))
      await flush(10)
      h.auth.emit('SIGNED_IN', session('A'))
      await flush(10)
    })
    expect(port.resetCalls).toBeGreaterThanOrEqual(2)
    await settle(port.calls[0] as Deferred<RecognitionOutcome>, analysed('cand-A', 'P184 Alpha'))
    expect(screen.queryByTestId('p169-recognition-candidate-cand-A')).toBeNull()
  })

  it('a token refresh of the same user is not an identity change', async () => {
    const { h, port } = await mount()
    await pick(h, 1)
    const resetsBefore = port.resetCalls
    await act(async () => {
      h.auth.emit('TOKEN_REFRESHED', session('A'))
      await flush(10)
    })
    expect(port.resetCalls).toBe(resetsBefore)
    await settle(port.calls[0] as Deferred<RecognitionOutcome>, analysed('cand-1', 'P184 Alpha'))
    expect(screen.getByTestId('p169-recognition-candidate-cand-1')).toBeTruthy()
  })
})
