import { useEffect, useState, type RefObject } from 'react'

/**
 * `useWindowVirtualizer`'s `scrollMargin` needs the container's offset from the window top. Refs
 * cannot be read during render (react-hooks/refs), so this measures it in an effect instead —
 * TanStack Virtual's own recipe for the window-scroll variant.
 */
export function useScrollMargin(ref: RefObject<HTMLElement | null>): number {
  const [scrollMargin, setScrollMargin] = useState(0)
  useEffect(() => {
    setScrollMargin(ref.current?.offsetTop ?? 0)
  }, [ref])
  return scrollMargin
}
