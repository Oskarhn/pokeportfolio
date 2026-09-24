import { useColorScheme } from 'react-native'

/**
 * NEUTRAL, PROVISIONAL styling: system colours only, no brand, no icon, no typeface choice. The
 * owner has not selected a visual direction (P154 proposes several; none is approved), so nothing here
 * decides one. Touch targets are at least 44 pt (Apple HIG) / 48 dp is not enforced; text uses the
 * system font and scales with the user's text-size setting (`allowFontScaling` stays on).
 */
export const MIN_TOUCH = 44

export interface Palette {
  background: string
  surface: string
  text: string
  muted: string
  border: string
  accent: string
  onAccent: string
  danger: string
  warning: string
}

const LIGHT: Palette = {
  background: '#f4f4f6',
  surface: '#ffffff',
  text: '#111114',
  muted: '#5a5a66',
  border: '#d6d6dc',
  accent: '#1f4fd8',
  onAccent: '#ffffff',
  danger: '#b3261e',
  warning: '#8a5a00',
}

const DARK: Palette = {
  background: '#0e0e10',
  surface: '#1a1a1e',
  text: '#f2f2f5',
  muted: '#a3a3ad',
  border: '#33333a',
  accent: '#7da2ff',
  onAccent: '#0e0e10',
  danger: '#ff8a80',
  warning: '#ffcc66',
}

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? DARK : LIGHT
}

export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const
