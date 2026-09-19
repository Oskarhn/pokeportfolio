import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../../src/auth/auth-context'
import { AuthCredentialsUnavailableError } from '../../src/auth/identity-lease'
import { useLeasedAction, type LeasedMutationResult } from '../../src/auth/useLeasedMutation'
import { createLeasedDb } from '../../src/data/leased-client'
import { KEY, SESSION_TEXT, makeWorld, retryableFetchError, sessionOf } from './p149-lookup-world'
import { createPurchase } from '../../src/data/purchases'

vi.mock('../../src/data/supabase-client', () => ({
  supabase: {},
  supabaseUrl: 'http://stub.invalid',
  supabasePublishableKey: 'stub-key',
}))

/**
 * P149 (closes P148-M2) - the REAL `useLeasedAction` hook, the one every financial form submits
 * through, driven without a DOM. P145 recorded that the repository had no DOM renderer for it; this
 * file gets what it needs from `react-dom/server`: rendering a component once yields the hook's
 * `mutate`, and a mutation-level `onError` / `onSuccess` runs inside TanStack Query's mutation cache
 * whether or not anything is subscribed.
 *
 * What the forms show is `onError`'s argument: PurchaseFormPage, SaleFormPage and the edit pages all
 * put `error.message` on screen. P148-M2 was this hook staying silent, because the credential
 * provider had revoked a lease whose identity had not changed.
 */

interface Outcome {
  errors: Error[]
  successes: unknown[]
}

/** Renders a component that calls the hook under user A, and returns the hook's result. */
function mountHook(world: ReturnType<typeof makeWorld>, outcome: Outcome) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const box: { current: LeasedMutationResult<unknown, void> | null } = { current: null }
  const auth = {
    status: 'signed-in',
    session: { user: { id: 'user-a' } } as Session,
    identity: world.world.authority,
  } as unknown as AuthState

  function Probe() {
    box.current = useLeasedAction<unknown>({
      mutationFn: (lease) =>
        createPurchase(
          { purchasedOn: '2026-09-01', currency: 'NOK', lines: [], notes: 'p149' },
          KEY,
          createLeasedDb(lease, world.deps),
        ),
      onSuccess: (data) => {
        outcome.successes.push(data)
      },
      onError: (error) => {
        outcome.errors.push(error)
      },
    })
    return null
  }
  renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AuthContext, { value: auth }, createElement(Probe)),
    ),
  )
  if (box.current === null) throw new Error('the hook did not render')
  return box.current
}

describe('useLeasedAction - what the form is told when the credential lookup fails', () => {
  let outcome: Outcome
  let world: ReturnType<typeof makeWorld>
  beforeEach(() => {
    outcome = { errors: [], successes: [] }
    world = makeWorld()
  })

  it('control: a healthy lookup runs the mutation once, as A, and reports success', async () => {
    const hook = mountHook(world, outcome)
    hook.mutate()
    await vi.waitFor(() => {
      expect(outcome.successes).toHaveLength(1)
    })
    expect(outcome.errors).toEqual([])
    expect(world.world.dispatched.map((d) => [d.owner, d.key])).toEqual([['user-a', KEY]])
  })

  it('P148-M2: a transient lookup failure reaches the form as the fixed session message - not silence', async () => {
    world.world.lookup = () =>
      Promise.resolve({ data: { session: null }, error: retryableFetchError })
    const hook = mountHook(world, outcome)
    hook.mutate()
    await vi.waitFor(() => {
      expect(outcome.errors).toHaveLength(1)
    })
    expect(outcome.errors[0]).toBeInstanceOf(AuthCredentialsUnavailableError)
    expect(outcome.errors[0]?.message).toBe(SESSION_TEXT)
    expect(outcome.successes).toEqual([])
    expect(world.world.dispatched).toEqual([]) // and nothing was sent
  })

  it('the person presses Save again: a NEW lease is taken, the lookup is asked again, and it can succeed with the same key', async () => {
    world.world.lookup = () =>
      Promise.resolve({ data: { session: null }, error: retryableFetchError })
    const hook = mountHook(world, outcome)
    hook.mutate()
    await vi.waitFor(() => {
      expect(outcome.errors).toHaveLength(1)
    })

    world.world.lookup = () => Promise.resolve({ data: { session: sessionOf('a', 2) } })
    hook.mutate()
    await vi.waitFor(() => {
      expect(outcome.successes).toHaveLength(1)
    })
    expect(outcome.errors).toHaveLength(1) // the first failure, and no second one
    expect(world.world.dispatched).toEqual([
      { owner: 'user-a', authorization: 'Bearer token-a-2', key: KEY },
    ])
    expect(world.world.lookups).toBe(2)
  })

  it("A -> B announced while the lookup fails: the form is NOT told about A's failure (it now belongs to B), and nothing is sent", async () => {
    world.world.lookup = () => {
      world.world.authority.observe('user-b')
      return Promise.resolve({ data: { session: null }, error: retryableFetchError })
    }
    const hook = mountHook(world, outcome)
    hook.mutate()
    await vi.waitFor(() => {
      expect(world.world.lookups).toBe(1)
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(outcome.errors).toEqual([])
    expect(outcome.successes).toEqual([])
    expect(world.world.dispatched).toEqual([])
  })

  it('signed out (no session, no error): the identity ended, so the form is not told about it either', async () => {
    world.world.lookup = () => Promise.resolve({ data: { session: null } })
    const hook = mountHook(world, outcome)
    hook.mutate()
    await vi.waitFor(() => {
      expect(world.world.lookups).toBe(1)
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(outcome.errors).toEqual([])
    expect(world.world.dispatched).toEqual([])
  })
})
