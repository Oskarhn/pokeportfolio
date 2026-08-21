import { useEffect, useState } from 'react'

/** Shared debounce hook — Search and Portfolio's top search bars both need it as of M7.1, so it
 *  moved out of being CatalogPage's private one-off. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value)
    }, delayMs)
    return () => {
      clearTimeout(timer)
    }
  }, [value, delayMs])
  return debounced
}
