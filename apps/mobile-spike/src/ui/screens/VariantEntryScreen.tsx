import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { runUnderIdentity } from '../../state/lease-run'
import type { Failure } from '../../net/failure'
import { EmptyView, FailureView, Loading } from '../components'
import type { SearchStackParams } from '../navigation-types'
import { useRuntime } from '../runtime-context'

/**
 * A holding knows its printing (card variant id), not its card. This screen finds the card the
 * printing belongs to (a plain read through the released catalog port, under the identity that was
 * current when it started) and replaces itself with the card screen with that printing chosen. A
 * late answer after an identity change is dropped, and a printing that does not exist is a "not
 * found", never a guess.
 */
export function VariantEntryScreen({
  route,
  navigation,
}: NativeStackScreenProps<SearchStackParams, 'P170VariantEntry'>) {
  const { variantId } = route.params
  const { authority, ports } = useRuntime()
  const [state, setState] = useState<'loading' | 'not_found' | Failure>('loading')
  const mounted = useRef(true)

  const resolve = useCallback(async () => {
    setState('loading')
    const outcome = await runUnderIdentity(authority, () =>
      ports.released.resolveVariant(variantId),
    )
    if (!mounted.current || outcome.kind === 'stale') return
    if (outcome.kind === 'failed') {
      setState(outcome.failure)
      return
    }
    if (outcome.value === null) {
      setState('not_found')
      return
    }
    navigation.replace('P169Card', {
      cardId: outcome.value.cardId,
      variantId: outcome.value.variantId,
    })
  }, [authority, ports, variantId, navigation])

  useEffect(() => {
    mounted.current = true
    void resolve()
    return () => {
      mounted.current = false
    }
  }, [resolve])

  if (state === 'loading') return <Loading label="Finding the card" />
  if (state === 'not_found') {
    return (
      <EmptyView
        title="Card not found"
        detail="This printing is not in the catalog, so it cannot be priced."
      />
    )
  }
  return <FailureView failure={state} onRetry={() => void resolve()} />
}
