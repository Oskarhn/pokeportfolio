import { createNavigationContainerRef } from '@react-navigation/native'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js'
import { AppRoot } from '../../src/ui/AppRoot'
import type { TabParams } from '../../src/ui/navigation-types'
import type { AccountDeletionPorts } from '../../src/account/account-deletion-controller'
import { PendingWriteJournal, type PendingWriteEntry } from '../../src/write/pending-write-journal'
import { flush, harness, MemoryKeyValueStore, session, type Harness } from '../support/fakes'

/**
 * P189: in-app account deletion on the native client, through the REAL composition root and the REAL
 * view tree with fakes for I/O only. UNIT_TESTED: component and controller proof, not a device run
 * (the Android emulator journey is separate evidence, docs/release/P189_ACCOUNT_DELETION.md).
 */

const PASSWORD = 'a password nobody logs'

interface Calls {
  invoked: { name: string; body: Record<string, unknown> }[]
  gone: number
}

function ports(
  answer: () => Promise<{ error: unknown }>,
  goneAnswer = false,
): AccountDeletionPorts & { calls: Calls } {
  const calls: Calls = { invoked: [], gone: 0 }
  return {
    calls,
    invoke: (name, options) => {
      calls.invoked.push({ name, body: options.body })
      return answer()
    },
    accountIsGone: () => {
      calls.gone += 1
      return Promise.resolve(goneAnswer)
    },
  }
}

const ok = () => Promise.resolve({ error: null })
const refuse = (status: number, body: unknown) => () =>
  Promise.resolve({ error: new FunctionsHttpError(new Response(JSON.stringify(body), { status })) })

const entry = (userId: string, key: string): PendingWriteEntry => ({
  idempotencyKey: key,
  operationKind: 'create_purchase',
  payloadHash: 'h',
  userId,
  createdAt: new Date().toISOString(),
})

async function signIn(h: Harness, id: string) {
  await act(async () => {
    h.auth.emit('SIGNED_IN', session(id))
    await flush()
  })
}

describe('the controller', () => {
  it('opens only with a signed-in identity and cancels cleanly', async () => {
    const p = ports(ok)
    const h = harness({ accountDeletion: p })
    h.runtime.accountDeletion.open()
    expect(h.runtime.accountDeletion.getSnapshot().phase).toBe('idle') // nobody signed in
    await signIn(h, 'A')
    h.runtime.accountDeletion.open()
    expect(h.runtime.accountDeletion.getSnapshot()).toMatchObject({
      phase: 'confirming',
      intentUserId: 'A',
    })
    h.runtime.accountDeletion.cancel()
    expect(h.runtime.accountDeletion.getSnapshot().phase).toBe('idle')
    expect(p.calls.invoked).toEqual([])
  })

  it('sends the SAME contract the web app sends: delete-account with the intended id, the password and the confirmation', async () => {
    const p = ports(ok)
    const h = harness({ accountDeletion: p })
    await signIn(h, 'A')
    h.runtime.accountDeletion.open()
    await h.runtime.accountDeletion.confirm(PASSWORD)
    expect(p.calls.invoked).toEqual([
      { name: 'delete-account', body: { expectedUserId: 'A', password: PASSWORD, confirm: true } },
    ])
  })

  it('on success: the pending-write journal of THAT user is cleared (others kept), the session is removed and the app is signed out', async () => {
    const journal = new PendingWriteJournal(new MemoryKeyValueStore())
    await journal.record(entry('A', 'k-a1'))
    await journal.record(entry('A', 'k-a2'))
    await journal.record(entry('B', 'k-b1'))
    const h = harness({ accountDeletion: ports(ok), journal })
    await signIn(h, 'A')
    h.runtime.accountDeletion.open()
    await h.runtime.accountDeletion.confirm(PASSWORD)
    await flush()

    expect(await journal.listFor('A')).toEqual([]) // nothing can be retried for a deleted account
    expect((await journal.listFor('B')).map((e) => e.idempotencyKey)).toEqual(['k-b1'])
    expect(h.removed()).toBe(1) // SecureStore session removed through the one sign-out path
    expect(h.auth.signOutCalls.length).toBe(1)
    expect(h.runtime.auth.getSnapshot().status).toBe('signed_out')
    expect(h.runtime.accountDeletion.getSnapshot().phase).toBe('done')
  })

  it('on success every identity-scoped store is reset (collection, photo, price check) before anything else can render', async () => {
    const h = harness({ accountDeletion: ports(ok) })
    await signIn(h, 'A')
    h.collection.pages.push({ rows: [], nextCursor: null })
    await h.runtime.collection.load()
    h.runtime.accountDeletion.open()
    await h.runtime.accountDeletion.confirm(PASSWORD)
    await flush()
    expect(h.runtime.collection.getSnapshot().status).toBe('idle')
    expect(h.runtime.photo.getSnapshot().status).toBe('idle')
    expect(h.runtime.photo.getSnapshot().image).toBeNull()
    expect(h.runtime.pendingWrites.getSnapshot()).toEqual({ userId: null, unresolved: [] })
  })

  it('a held scanner photo copy is deleted from the app-managed state when the account is deleted', async () => {
    const h = harness({ accountDeletion: ports(ok) })
    h.photo.outcome = {
      status: 'picked',
      image: { uri: 'file:///cache/p189-held.jpg', width: 10, height: 10 },
    } as never
    await signIn(h, 'A')
    await h.runtime.photo.acquire('library')
    expect(h.runtime.photo.getSnapshot().status).toBe('ready')
    h.runtime.accountDeletion.open()
    await h.runtime.accountDeletion.confirm(PASSWORD)
    await flush()
    expect(h.photo.deleted).toContain('file:///cache/p189-held.jpg')
    expect(h.runtime.photo.getSnapshot().image).toBeNull()
  })

  it.each([
    ['wrong password', refuse(403, { error: 'reauthentication_failed' }), /not correct/],
    [
      'registry unreachable',
      refuse(503, { error: 'deletion_incomplete', retryable: true, stage: 'registry' }),
      /has not started removing anything/,
    ],
    [
      'unfinished after starting',
      refuse(500, { error: 'deletion_incomplete', retryable: true, stage: 'data' }),
      /some of your data may already be removed/,
    ],
    [
      'deletion unavailable',
      refuse(503, { error: 'deletion_unavailable' }),
      /not available right now/,
    ],
  ])(
    'failure (%s): fixed copy, the account stays signed in, the journal is untouched',
    async (_n, answer, copy) => {
      const journal = new PendingWriteJournal(new MemoryKeyValueStore())
      await journal.record(entry('A', 'k-a1'))
      const h = harness({ accountDeletion: ports(answer), journal })
      await signIn(h, 'A')
      h.runtime.accountDeletion.open()
      await h.runtime.accountDeletion.confirm(PASSWORD)
      const s = h.runtime.accountDeletion.getSnapshot()
      expect(s.phase).toBe('confirming')
      expect(s.error).toMatch(copy)
      expect(h.runtime.auth.getSnapshot().status).toBe('signed_in')
      expect((await journal.listFor('A')).length).toBe(1)
      expect(h.removed()).toBe(0)
    },
  )

  it('never shows server text: SQL / PostgREST / function names in the body become the generic sentence', async () => {
    for (const body of [
      { error: 'duplicate key value violates unique constraint "x"' },
      { error: 'PGRST116', message: 'JSON object requested' },
      { message: 'at purge_account_data (index.ts:1)' },
    ]) {
      const h = harness({ accountDeletion: ports(refuse(500, body)) })
      await signIn(h, 'A')
      h.runtime.accountDeletion.open()
      await h.runtime.accountDeletion.confirm(PASSWORD)
      const error = h.runtime.accountDeletion.getSnapshot().error ?? ''
      expect(error).toMatch(/could not confirm the result/)
      expect(error).not.toMatch(/violates|PGRST|purge_account_data|index\.ts/)
    }
  })

  it('a lost answer: only Auth saying the account is gone counts as deleted', async () => {
    const lost = () => Promise.resolve({ error: new FunctionsFetchError(new Error('socket')) })
    const gone = harness({ accountDeletion: ports(lost, true) })
    await signIn(gone, 'A')
    gone.runtime.accountDeletion.open()
    await gone.runtime.accountDeletion.confirm(PASSWORD)
    await flush()
    expect(gone.runtime.accountDeletion.getSnapshot().phase).toBe('done')

    const still = harness({ accountDeletion: ports(lost, false) })
    await signIn(still, 'A')
    still.runtime.accountDeletion.open()
    await still.runtime.accountDeletion.confirm(PASSWORD)
    expect(still.runtime.accountDeletion.getSnapshot().phase).toBe('confirming')
    expect(still.runtime.auth.getSnapshot().status).toBe('signed_in')
  })

  it('an identity change while the dialog is open closes it and sends nothing (A -> B)', async () => {
    const p = ports(ok)
    const h = harness({ accountDeletion: p })
    await signIn(h, 'A')
    h.runtime.accountDeletion.open()
    await signIn(h, 'B') // registry.resetAll() resets the controller
    expect(h.runtime.accountDeletion.getSnapshot()).toMatchObject({
      phase: 'idle',
      intentUserId: null,
    })
    await h.runtime.accountDeletion.confirm(PASSWORD)
    expect(p.calls.invoked).toEqual([])
  })

  it('an identity that changes DURING the request ends the dialog silently and never signs the new identity out', async () => {
    let release: () => void = () => undefined
    const slow = () =>
      new Promise<{ error: unknown }>((resolve) => {
        release = () => resolve({ error: null })
      })
    const h = harness({ accountDeletion: ports(slow) })
    await signIn(h, 'A')
    h.runtime.accountDeletion.open()
    const pending = h.runtime.accountDeletion.confirm(PASSWORD)
    await flush()
    await signIn(h, 'B')
    release()
    await pending
    expect(h.runtime.auth.getSnapshot()).toMatchObject({ status: 'signed_in', userId: 'B' })
    expect(h.auth.signOutCalls.length).toBe(0)
  })

  it('refuses an empty password and a second concurrent confirmation', async () => {
    const p = ports(ok)
    const h = harness({ accountDeletion: p })
    await signIn(h, 'A')
    h.runtime.accountDeletion.open()
    await h.runtime.accountDeletion.confirm('')
    expect(p.calls.invoked).toEqual([])
  })
})

describe('the Profile screen', () => {
  async function mountProfile(h: Harness) {
    const navigationRef = createNavigationContainerRef<TabParams>()
    await render(
      <AppRoot runtime={h.runtime} backendHost="127.0.0.1" navigationRef={navigationRef} />,
    )
    await signIn(h, 'A')
    await fireEvent.press(await screen.findByTestId('tab-profile'))
    await screen.findByTestId('delete-account')
  }

  it('shows the delete action as a separate, deliberate flow; nothing is sent by opening it', async () => {
    const p = ports(ok)
    const h = harness({ accountDeletion: p })
    await mountProfile(h)
    expect(screen.getByTestId('sign-out')).toBeTruthy() // sign-out is a different control
    await fireEvent.press(screen.getByTestId('delete-account-open'))
    expect(await screen.findByTestId('delete-account-covers')).toBeTruthy()
    expect(screen.getByTestId('delete-account-not-covered')).toBeTruthy()
    expect(p.calls.invoked).toEqual([])
  })

  it('the destructive button stays disabled until the password is typed AND the acknowledgement is on', async () => {
    const h = harness({ accountDeletion: ports(ok) })
    await mountProfile(h)
    await fireEvent.press(screen.getByTestId('delete-account-open'))
    const confirmDisabled = async (): Promise<boolean> =>
      (
        (await screen.findByTestId('delete-account-confirm')).props as {
          accessibilityState: { disabled: boolean }
        }
      ).accessibilityState.disabled
    expect(await confirmDisabled()).toBe(true)
    await fireEvent.changeText(screen.getByTestId('delete-account-password'), PASSWORD)
    expect(await confirmDisabled()).toBe(true)
    await fireEvent.press(screen.getByTestId('delete-account-ack'))
    expect(await confirmDisabled()).toBe(false)
  })

  it('the password field is masked', async () => {
    const h = harness({ accountDeletion: ports(ok) })
    await mountProfile(h)
    await fireEvent.press(screen.getByTestId('delete-account-open'))
    expect((await screen.findByTestId('delete-account-password')).props.secureTextEntry).toBe(true)
  })

  it('a wrong password shows the fixed message in the sheet and keeps the person signed in', async () => {
    const h = harness({ accountDeletion: ports(refuse(403, { error: 'reauthentication_failed' })) })
    await mountProfile(h)
    await fireEvent.press(screen.getByTestId('delete-account-open'))
    await fireEvent.changeText(await screen.findByTestId('delete-account-password'), PASSWORD)
    await fireEvent.press(screen.getByTestId('delete-account-ack'))
    await fireEvent.press(screen.getByTestId('delete-account-confirm'))
    expect(await screen.findByText(/not correct/)).toBeTruthy()
    expect(h.runtime.auth.getSnapshot().status).toBe('signed_in')
  })

  it('a successful deletion returns to the signed-out screen', async () => {
    const h = harness({ accountDeletion: ports(ok) })
    await mountProfile(h)
    await fireEvent.press(screen.getByTestId('delete-account-open'))
    await fireEvent.changeText(await screen.findByTestId('delete-account-password'), PASSWORD)
    await fireEvent.press(screen.getByTestId('delete-account-ack'))
    await fireEvent.press(screen.getByTestId('delete-account-confirm'))
    await waitFor(() => {
      expect(screen.getByTestId('login-screen')).toBeTruthy()
    })
  })
})
