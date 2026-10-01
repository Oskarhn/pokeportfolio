import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { act, render } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { P169FeatureProvider, type P169StackParams } from '../../src/features/navigation'
import type {
  CardRecognitionPort,
  RecognitionOutcome,
} from '../../src/features/price-check/recognition'
import { P169_SCREENS } from '../../src/features/screens'
import { RuntimeProvider } from '../../src/ui/runtime-context'
import { flush, harness, session } from '../support/fakes'
import { STANDARD_FX, fakeFx, FakeInvoker, FakeCatalog } from '../support/p169-fakes'

/**
 * P186: the photo screen tells the recognizer when it becomes the screen the person is looking at,
 * so the model can start while they choose a photo. It must not happen at app launch or for any
 * other screen.
 */

const Stack = createNativeStackNavigator<P169StackParams>()

class WarmthPort implements CardRecognitionPort {
  readonly implemented = true
  entered = 0
  recognize(): Promise<RecognitionOutcome> {
    return new Promise(() => undefined)
  }
  scannerEntered(): void {
    this.entered += 1
  }
}

async function mountOnAnotherScreen(port: CardRecognitionPort) {
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
            <Stack.Navigator initialRouteName="P169Search">
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
    await flush(10)
  })
  return { ref }
}

describe('photo screen prewarm hook (P186)', () => {
  it('does not start the recognizer when the app is up and another screen is showing', async () => {
    const port = new WarmthPort()
    await mountOnAnotherScreen(port)
    expect(port.entered).toBe(0)
  })

  it('tells the recognizer when the photo screen is entered, once per entry', async () => {
    const port = new WarmthPort()
    const { ref } = await mountOnAnotherScreen(port)
    await act(async () => {
      ref.navigate('P169PhotoEntry')
      await flush(10)
    })
    expect(port.entered).toBe(1)
    await act(async () => {
      ref.goBack()
      await flush(10)
    })
    expect(port.entered).toBe(1)
    await act(async () => {
      ref.navigate('P169PhotoEntry')
      await flush(10)
    })
    expect(port.entered).toBe(2)
  })

  it('a port without the hook (older recognizers, test doubles) still works', async () => {
    const port: CardRecognitionPort = {
      implemented: true,
      recognize: () => new Promise(() => undefined),
    }
    const { ref } = await mountOnAnotherScreen(port)
    await act(async () => {
      ref.navigate('P169PhotoEntry')
      await flush(10)
      ref.goBack()
      await flush(10)
    })
    expect(ref.getCurrentRoute()?.name).toBe('P169Search')
  })
})
