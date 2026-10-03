import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { AppRoot } from '../../src/ui/AppRoot'
import { detail, flush, harness, row, session, type Harness } from '../support/fakes'

/**
 * Android recreates the Activity on an undeclared configuration change; React Native then mounts a
 * NEW root in the SAME JS runtime (seen on the emulator in P167). Simulated here as unmount + render
 * with the same runtime. UNIT_TESTED; the device run is scripts/android-p167-check.mjs.
 */
async function mountAndSignIn(h: Harness, user: string) {
  const utils = await render(<AppRoot runtime={h.runtime} backendHost="127.0.0.1" />)
  await act(async () => {
    h.auth.emit('SIGNED_IN', session(user))
    await flush()
  })
  return utils
}

it('a new root after an Activity recreation reopens the screen the person was on', async () => {
  const h = harness()
  h.collection.pages.push({ rows: [row('a1')], nextCursor: null })
  h.collection.details.set('a1', detail('a1', { title: 'KEEP-ME' }))
  const first = await mountAndSignIn(h, 'A')
  await fireEvent.press(await screen.findByTestId('row-a1'))
  expect(await screen.findByText('KEEP-ME')).toBeTruthy()

  await first.unmount() // the old Activity's root goes away
  const second = await render(<AppRoot runtime={h.runtime} backendHost="127.0.0.1" />)
  await act(async () => {
    h.auth.emit('INITIAL_SESSION', session('A'))
    await flush()
  })
  expect(await screen.findByText('KEEP-ME')).toBeTruthy()
  expect(screen.queryByTestId('collection-list')).toBeNull()
  await second.unmount()
})

it('an identity change never restores the previous user into their screen', async () => {
  const h = harness()
  h.collection.pages.push({ rows: [row('a1')], nextCursor: null })
  h.collection.details.set('a1', detail('a1', { title: 'A-PRIVATE' }))
  const first = await mountAndSignIn(h, 'A')
  await fireEvent.press(await screen.findByTestId('row-a1'))
  expect(await screen.findByText('A-PRIVATE')).toBeTruthy()

  h.collection.pages.push({ rows: [row('b1')], nextCursor: null })
  // The identity key remounts the NavigationContainer, which restores from the same memory an
  // Activity recreation uses: it must have been emptied by the identity boundary.
  await act(async () => {
    h.auth.emit('SIGNED_IN', session('B'))
    await flush()
  })
  expect(await screen.findByTestId('row-b1')).toBeTruthy()
  expect(screen.queryByText('A-PRIVATE')).toBeNull()
  expect(JSON.stringify(h.runtime.navigation.get() ?? {})).not.toContain('CardDetail')
  await first.unmount()
})
