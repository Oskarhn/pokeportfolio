import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { Money } from '@shared/domain/money'
import { formatMoney } from '../../money/format-money'
import { SPACE, usePalette } from '../../ui/theme'

/**
 * Neutral, feature-local presentation helpers for the P169 screens. Deliberately plain (system
 * colours from the existing palette, system font, no icons): the owner-approved Stitch designs (P168)
 * replace the presentation later. Only what the shared kit (src/ui/components.tsx) does not do is
 * here, so the shared kit and the global theme stay untouched:
 *   - 48 dp minimum touch targets (Android guidance; the shared kit uses 44),
 *   - money on ONE line that shrinks to fit instead of wrapping inside the number,
 *   - a polite live region for search/lookup status announcements (TalkBack).
 */

export const TOUCH_48 = 48

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
 * An exact amount on one line. Android breaks a "word" that is wider than the line at an arbitrary
 * character, which at 200 % text split long amounts across lines (P166 finding). Here the amount
 * never wraps: it shrinks to fit, and the full value is the accessibility label. Absent renders as
 * the dash (format-money.ts), never as zero.
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
  const p = usePalette()
  const text = formatMoney(value)
  return (
    <Text
      testID={testID}
      accessibilityLabel={value === null ? 'No value' : text}
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.2}
      style={{
        color: value === null ? p.muted : p.text,
        fontSize: size === 'headline' ? 22 : 16,
        fontWeight: size === 'headline' ? '700' : '600',
        fontVariant: ['tabular-nums'],
      }}
    >
      {text}
    </Text>
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
