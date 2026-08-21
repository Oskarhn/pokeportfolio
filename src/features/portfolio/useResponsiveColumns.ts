import { useEffect, useState } from 'react'

/**
 * Mirrors the Tailwind breakpoints `gridTile.ts`'s `gridColumnsClass` encodes in CSS, so the
 * virtualized grid (M7 prompt §56 — TanStack Virtual) knows how many tiles make up one virtual
 * row at the viewport's *current* width. CSS alone cannot tell a JS virtualizer this; a
 * ResizeObserver on `window` is the standard, small answer rather than a second design-tokens
 * source of truth.
 */
const BREAKPOINTS = { sm: 640, lg: 1024 } as const

const DEFAULT_COLUMNS: Record<'base' | 'sm' | 'lg', number> = { base: 2, sm: 3, lg: 4 }

const COLUMNS_BY_DENSITY: Record<number, Record<'base' | 'sm' | 'lg', number>> = {
  1: { base: 1, sm: 2, lg: 3 },
  2: DEFAULT_COLUMNS,
  3: { base: 3, sm: 4, lg: 6 },
  4: { base: 4, sm: 5, lg: 8 },
}

function columnsFor(density: number, width: number): number {
  const tier = width >= BREAKPOINTS.lg ? 'lg' : width >= BREAKPOINTS.sm ? 'sm' : 'base'
  const forDensity = COLUMNS_BY_DENSITY[density] ?? DEFAULT_COLUMNS
  return forDensity[tier]
}

export function useResponsiveColumns(density: number): number {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 1024 : window.innerWidth,
  )

  useEffect(() => {
    const onResize = () => {
      setWidth(window.innerWidth)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return columnsFor(density, width)
}
