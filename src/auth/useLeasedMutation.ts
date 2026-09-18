import { useCallback, useMemo } from 'react'
import { useMutation, type UseMutationResult } from '@tanstack/react-query'
import { useAuth } from './useAuth'
import { runWithLease, type IdentityLease } from './identity-lease'

/**
 * `useMutation` for every mutation that must not outlive the identity it began under (P145).
 *
 * The lease is taken in `mutate()` — the moment the person commits to the action — for the user the
 * component was RENDERED under, then passed to the operation and to the callbacks. Consequences:
 *
 *   - `mutationFn(variables, lease)` receives the lease and must route every request through
 *     `leasedDb(lease)`; nothing else in this hook can see a request.
 *   - If the identity ends before or during the operation (another tab switched user or signed out,
 *     this tab signed out, or React has not yet committed the remount when the button was pressed),
 *     the operation stops at its next step and `onSuccess` / `onError` are NOT called: the screen
 *     that would have shown a result or an error no longer belongs to that identity, and a message
 *     about A's data must not appear under B. TanStack Query keeps the mutation's own state, which
 *     is discarded with the identity boundary's cache clear.
 *   - Query invalidation and navigation belong in `onSuccess`, so they are skipped too: the new
 *     identity's caches were already reset and it must not be navigated by a result it never asked
 *     for.
 *
 * TanStack Query cancelling or removing a mutation does not stop code that is already running,
 * which is why the guard lives in the request layer (data/leased-client.ts), not here.
 */

interface Leased<TVariables> {
  variables: TVariables
  lease: IdentityLease
}

export interface LeasedMutationOptions<TData, TVariables, TContext> {
  mutationFn: (variables: TVariables, lease: IdentityLease) => Promise<TData>
  onMutate?: (variables: TVariables, lease: IdentityLease) => TContext | Promise<TContext>
  onSuccess?: (data: TData, variables: TVariables, lease: IdentityLease) => unknown
  onError?: (error: Error, variables: TVariables, lease: IdentityLease) => unknown
}

/** Per-call callbacks, as with `useMutation().mutate`: skipped for a lease that has ended. */
export interface LeasedMutateCallbacks<TData, TVariables> {
  onSuccess?: (data: TData, variables: TVariables) => void
  onError?: (error: Error, variables: TVariables) => void
}

export type LeasedMutationResult<TData, TVariables> = Omit<
  UseMutationResult<TData, Error, Leased<TVariables>>,
  'mutate' | 'mutateAsync' | 'variables'
> & {
  /** The variables of the most recent call, as the caller passed them. */
  variables: TVariables | undefined
  mutate: (variables: TVariables, callbacks?: LeasedMutateCallbacks<TData, TVariables>) => void
  mutateAsync: (variables: TVariables) => Promise<TData>
}

export function useLeasedMutation<TData, TVariables = void, TContext = unknown>(
  options: LeasedMutationOptions<TData, TVariables, TContext>,
): LeasedMutationResult<TData, TVariables> {
  const { identity, session } = useAuth()
  const renderedUserId = session?.user.id ?? null

  const inner = useMutation<TData, Error, Leased<TVariables>, TContext | undefined>({
    mutationFn: ({ variables, lease }) =>
      runWithLease(lease, () => options.mutationFn(variables, lease)),
    onMutate: ({ variables, lease }) =>
      lease.isCurrent() ? options.onMutate?.(variables, lease) : undefined,
    onSuccess: async (data, { variables, lease }) => {
      if (!lease.isCurrent()) return
      await options.onSuccess?.(data, variables, lease)
    },
    onError: async (error, { variables, lease }) => {
      if (!lease.isCurrent()) return
      await options.onError?.(error, variables, lease)
    },
  })

  const { mutate: innerMutate, mutateAsync: innerMutateAsync } = inner
  const mutate = useCallback(
    (variables: TVariables, callbacks?: LeasedMutateCallbacks<TData, TVariables>) => {
      const lease = identity.begin(renderedUserId)
      innerMutate(
        { variables, lease },
        {
          onSuccess: (data) => {
            if (lease.isCurrent()) callbacks?.onSuccess?.(data, variables)
          },
          onError: (error) => {
            if (lease.isCurrent()) callbacks?.onError?.(error, variables)
          },
        },
      )
    },
    [innerMutate, identity, renderedUserId],
  )
  const mutateAsync = useCallback(
    (variables: TVariables) =>
      innerMutateAsync({ variables, lease: identity.begin(renderedUserId) }),
    [innerMutateAsync, identity, renderedUserId],
  )

  return useMemo(
    () => ({ ...inner, variables: inner.variables?.variables, mutate, mutateAsync }),
    // `inner` changes identity on every state transition, which is exactly when the result must.
    [inner, mutate, mutateAsync],
  )
}

export interface LeasedActionOptions<TData, TContext> {
  mutationFn: (lease: IdentityLease) => Promise<TData>
  onMutate?: (lease: IdentityLease) => TContext | Promise<TContext>
  onSuccess?: (data: TData, lease: IdentityLease) => unknown
  onError?: (error: Error, lease: IdentityLease) => unknown
}

/** {@link useLeasedMutation} for an action that takes no input: `mutate()` with no argument. */
export function useLeasedAction<TData, TContext = unknown>(
  options: LeasedActionOptions<TData, TContext>,
): LeasedMutationResult<TData, void> {
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- `void` variables are what make `mutate()` callable without an argument
  return useLeasedMutation<TData, void, TContext>({
    mutationFn: (_variables, lease) => options.mutationFn(lease),
    onMutate: options.onMutate
      ? (_variables, lease) => options.onMutate?.(lease) as TContext
      : undefined,
    onSuccess: options.onSuccess
      ? (data, _variables, lease) => options.onSuccess?.(data, lease)
      : undefined,
    onError: options.onError
      ? (error, _variables, lease) => options.onError?.(error, lease)
      : undefined,
  })
}
