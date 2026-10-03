import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from 'react'
import { useColorScheme, type ColorSchemeName } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native'

/**
 * P178 dark-first design tokens. Dark (Foil-derived: graphite ground, one brass accent) is the
 * primary, fully polished theme; light (Utility-derived: warm white, petrol accent) is kept
 * functional so the architecture does not foreclose it, but is not the visual priority this phase.
 * Every screen consumes these semantic roles — never a raw hex value — so a future palette change
 * is one edit here, not a hunt through every screen.
 */
export const MIN_TOUCH = 48

export type ThemeMode = 'dark' | 'light' | 'system'

export interface Tokens {
  background: string
  surface: string
  surfaceRaised: string
  surfaceSunken: string
  borderSubtle: string
  borderStrong: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  textDisabled: string
  accent: string
  accentPressed: string
  accentSoft: string
  onAccent: string
  positive: string
  negative: string
  warning: string
  info: string
  priceKnown: string
  priceUnknown: string
  manualValue: string
  overlay: string
  scrim: string
}

export const DARK_TOKENS: Tokens = {
  background: '#0F0F11',
  surface: '#0F0F11',
  surfaceRaised: '#18181B',
  surfaceSunken: '#0A0A0B',
  borderSubtle: '#2B2B30',
  borderStrong: '#3D3D44',
  textPrimary: '#F2F0EA',
  textSecondary: '#C4C1B9',
  textMuted: '#B0ADA5',
  textDisabled: '#6E6B65',
  accent: '#C9A45C',
  accentPressed: '#AD8A49',
  accentSoft: '#3A311F',
  onAccent: '#1A1408',
  positive: '#7FD1A6',
  negative: '#F0958D',
  warning: '#C99A46',
  info: '#8FA6B0',
  priceKnown: '#F2F0EA',
  priceUnknown: '#B0ADA5',
  manualValue: '#C9A45C',
  overlay: 'rgba(0,0,0,0.6)',
  scrim: 'rgba(0,0,0,0.85)',
}

export const LIGHT_TOKENS: Tokens = {
  background: '#FAFAF7',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  surfaceSunken: '#F0EFEA',
  borderSubtle: '#DADDD8',
  borderStrong: '#C7CBC4',
  textPrimary: '#191C1B',
  textSecondary: '#4A4F4D',
  textMuted: '#5F6461',
  textDisabled: '#9AA09C',
  accent: '#0E6B62',
  accentPressed: '#0B554E',
  accentSoft: '#DCEDEA',
  onAccent: '#FFFFFF',
  positive: '#2E7D5B',
  negative: '#B3261E',
  warning: '#8A5A00',
  info: '#3A6EA5',
  priceKnown: '#191C1B',
  priceUnknown: '#6B706D',
  manualValue: '#0E6B62',
  overlay: 'rgba(0,0,0,0.4)',
  scrim: 'rgba(0,0,0,0.6)',
}

const TOKENS: Record<'dark' | 'light', Tokens> = { dark: DARK_TOKENS, light: LIGHT_TOKENS }

/** Legacy flat shape kept for the many screens written against `usePalette()`; derived from the
 *  active token set so those screens inherit the dark-first theme without individually changing. */
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

function toPalette(t: Tokens): Palette {
  return {
    background: t.background,
    surface: t.surface,
    text: t.textPrimary,
    muted: t.textSecondary,
    border: t.borderSubtle,
    accent: t.accent,
    onAccent: t.onAccent,
    danger: t.negative,
    warning: t.warning,
  }
}

interface ThemeModeState {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
}

/** Default context value (mode 'dark', no-op setter) so any subtree can read tokens correctly even
 *  without an explicit provider mounted above it — e.g. a screen rendered alone in a unit test. */
const ThemeModeContext = createContext<ThemeModeState>({ mode: 'dark', setMode: () => {} })

/** Mounted once, at the app root. Dark is the launch default — NOT read from the system at start,
 *  so the app never launches light just because the phone happens to be in light mode. */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>('dark')
  const value = useMemo(() => ({ mode, setMode }), [mode])
  return createElement(ThemeModeContext.Provider, { value }, children)
}

export function useThemeMode(): ThemeModeState {
  return useContext(ThemeModeContext)
}

function resolveScheme(mode: ThemeMode, system: ColorSchemeName): 'dark' | 'light' {
  if (mode === 'system') return system === 'light' ? 'light' : 'dark'
  return mode
}

export function useActiveScheme(): 'dark' | 'light' {
  const { mode } = useThemeMode()
  const system = useColorScheme()
  return resolveScheme(mode, system)
}

export function useTokens(): Tokens {
  return TOKENS[useActiveScheme()]
}

/** Preferred hook for new/rewritten screens: the full semantic token set. */
export const useTheme = useTokens

export function usePalette(): Palette {
  return toPalette(useTokens())
}

/** Light icons read on the dark ground; dark icons read on the light one. Exported as a pure
 *  function (P178 mutant #11) so the launch-time invariant — never dark-on-dark — is a direct unit
 *  test, not dependent on how a native passthrough component like `expo-status-bar` renders in a
 *  test environment. */
export function statusBarStyleFor(scheme: 'dark' | 'light'): 'light' | 'dark' {
  return scheme === 'dark' ? 'light' : 'dark'
}

/** Renders the system status bar in the icon colour that reads on the active background. Mounted
 *  once near the app root, inside `AppThemeProvider`, so a theme-mode change updates it live. */
export function ThemedStatusBar() {
  const scheme = useActiveScheme()
  return createElement(StatusBar, { style: statusBarStyleFor(scheme) })
}

export function navigationTheme(scheme: 'light' | 'dark'): Theme {
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme
  const t = TOKENS[scheme]
  return {
    ...base,
    dark: scheme === 'dark',
    colors: {
      ...base.colors,
      primary: t.accent,
      background: t.background,
      card: t.surface,
      text: t.textPrimary,
      border: t.borderSubtle,
      notification: t.negative,
    },
  }
}

export function useNavigationTheme(): Theme {
  const scheme = useActiveScheme()
  return useMemo(() => navigationTheme(scheme), [scheme])
}

export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const
export const RADIUS = { sm: 8, md: 10, lg: 14, pill: 999 } as const

export interface TypeRole {
  fontSize: number
  fontWeight: '400' | '500' | '600' | '700'
  lineHeight: number
}

/** Typography roles (P178 §7). Nothing below `micro` (12 sp); money keeps tabular figures so
 *  digits never shift width as they change. Sentence case throughout — never apply uppercase or
 *  letter-spacing to any of these as a stylistic default (Foil's own rule, kept everywhere). */
export const TYPE = {
  displayValue: { fontSize: 34, fontWeight: '700', lineHeight: 40 },
  titleLarge: { fontSize: 24, fontWeight: '700', lineHeight: 30 },
  title: { fontSize: 20, fontWeight: '700', lineHeight: 26 },
  section: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  body: { fontSize: 16, fontWeight: '400', lineHeight: 22 },
  bodyStrong: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  caption: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  micro: { fontSize: 12, fontWeight: '500', lineHeight: 16 },
  moneyLarge: { fontSize: 28, fontWeight: '700', lineHeight: 34 },
  moneyRow: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  button: { fontSize: 16, fontWeight: '700', lineHeight: 20 },
} satisfies Record<string, TypeRole>
