import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { Money } from '@shared/domain/money'
import { MoneyText } from '../../ui/components'
import { MIN_TOUCH, SPACE, usePalette } from '../../ui/theme'

/**
 * Neutral, feature-local presentation helpers for the Search / Price Check screens. Deliberately
 * plain (system colours from the existing palette, system font, no icons): the owner-approved
 * designs replace the presentation later. Only what the shell kit (src/ui/components.tsx) does not
 * do is here:
 *   - buttons with a selected state and an accessibility hint,
 *   - a polite live region for search/lookup status announcements (TalkBack),
 *   - money through the shell's MoneyText (see ExactMoney).
 */

/** One source of truth for the touch-target floor: the shell's (48 dp, Android guidance). */
export const TOUCH_48 = MIN_TOUCH

export function ActionButton({
  label,
  onPress,
  testID,
  variant = 'primary',
  disabled,
  selected,
  hint,
}: {
  label: string
  onPress: () => void
  testID?: string
  variant?: 'primary' | 'secondary'
  disabled?: boolean
  selected?: boolean
  hint?: string
}) {
  const p = usePalette()
  const filled = variant === 'primary' || selected === true
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: disabled === true, selected: selected === true }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TOUCH_48,
        minWidth: TOUCH_48,
        paddingHorizontal: SPACE.lg,
        paddingVertical: SPACE.sm,
        borderRadius: 10,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: filled ? p.accent : 'transparent',
        borderWidth: filled ? 0 : StyleSheet.hairlineWidth * 2,
        borderColor: p.accent,
        opacity: disabled === true ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      <Text
        style={{
          color: filled ? p.onAccent : p.accent,
          fontSize: 16,
          fontWeight: '600',
          textAlign: 'center',
        }}
      >
        {label}
      </Text>
    </Pressable>
  )
}

/**
 * An exact amount. Adapter over the shell's `MoneyText` (P167): the amount wraps only between digit
 * groups (or before the currency) and never shrinks, so at 200 % text every digit stays full size and
 * visible. The formatted value and the announced label are unchanged; absent renders as the dash,
 * never as zero (format-money.ts). P169 first shipped a one-line shrink-to-fit here; P167's wrapping
 * rule replaced it when the two were integrated.
 */
export function ExactMoney({
  value,
  testID,
  size = 'body',
}: {
  value: Money | null
  testID?: string
  size?: 'body' | 'headline'
}) {
  return (
    <MoneyText
      {...(testID !== undefined ? { testID } : {})}
      value={value}
      emphasis={size === 'headline'}
      fit="wrap"
    />
  )
}

/** Status line that TalkBack announces when it changes (no-results, errors, loading done). */
export function LiveStatus({
  children,
  testID,
  tone = 'muted',
}: {
  children: ReactNode
  testID?: string
  tone?: 'muted' | 'danger'
}) {
  const p = usePalette()
  return (
    <Text
      testID={testID}
      accessibilityLiveRegion="polite"
      accessibilityRole={tone === 'danger' ? 'alert' : 'text'}
      style={{ color: tone === 'danger' ? p.danger : p.muted, fontSize: 15 }}
    >
      {children}
    </Text>
  )
}

export function Section({ children, testID }: { children: ReactNode; testID?: string }) {
  const p = usePalette()
  return (
    <View
      testID={testID}
      style={{
        backgroundColor: p.surface,
        borderRadius: 12,
        padding: SPACE.lg,
        gap: SPACE.sm,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: p.border,
      }}
    >
      {children}
    </View>
  )
}

export function Label({
  children,
  muted,
  testID,
  bold,
}: {
  children: ReactNode
  muted?: boolean
  testID?: string
  bold?: boolean
}) {
  const p = usePalette()
  return (
    <Text
      testID={testID}
      style={{
        color: muted === true ? p.muted : p.text,
        fontSize: 15,
        fontWeight: bold === true ? '700' : '400',
      }}
    >
      {children}
    </Text>
  )
}
