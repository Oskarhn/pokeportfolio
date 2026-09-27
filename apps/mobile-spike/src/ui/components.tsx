import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type ViewStyle,
} from 'react-native'
import type { Money } from '@shared/domain/money'
import { formatMoney } from '../money/format-money'
import type { Failure } from '../net/failure'
import { MIN_TOUCH, SPACE, usePalette } from './theme'

export function Button({
  label,
  onPress,
  disabled,
  variant = 'primary',
  testID,
  accessibilityHint,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  variant?: 'primary' | 'secondary' | 'danger'
  testID?: string
  accessibilityHint?: string
}) {
  const p = usePalette()
  const background = variant === 'primary' ? p.accent : 'transparent'
  const color = variant === 'primary' ? p.onAccent : variant === 'danger' ? p.danger : p.accent
  const style: ViewStyle = {
    minHeight: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    paddingHorizontal: SPACE.lg,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: background,
    borderWidth: variant === 'primary' ? 0 : StyleSheet.hairlineWidth * 2,
    borderColor: color,
    opacity: disabled === true ? 0.5 : 1,
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      onPress={onPress}
      style={style}
    >
      <Text style={{ color, fontSize: 16, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  )
}

export function Body({
  children,
  muted,
  testID,
}: {
  children: ReactNode
  muted?: boolean
  testID?: string
}) {
  const p = usePalette()
  return (
    <Text testID={testID} style={{ color: muted === true ? p.muted : p.text, fontSize: 15 }}>
      {children}
    </Text>
  )
}

export function Heading({ children }: { children: ReactNode }) {
  const p = usePalette()
  return (
    <Text accessibilityRole="header" style={{ color: p.text, fontSize: 22, fontWeight: '700' }}>
      {children}
    </Text>
  )
}

/**
 * The formatter joins digit groups (and the amount and "kr") with no-break spaces, so a long amount is
 * one unbreakable word and Android split it INSIDE a group at large text sizes ("8 917 127 26" /
 * "2 195 456,87 kr", P166 F4). For wrapping layouts those separators become ordinary spaces: a line
 * can then break only between whole groups or before the currency. The digits, the grouping and the
 * accessibility label are unchanged; formatMoney itself is not touched.
 */
export function breakableMoneyText(formatted: string): string {
  return formatted.replace(/[\u00A0\u202F]/g, ' ')
}

/** Smallest scale a one-line amount may shrink to; far below any amount this app can hold. */
export const MONEY_MIN_FONT_SCALE = 0.4

/**
 * A money figure. Absent (null) renders the honest dash, never a zero (see format-money.ts).
 * `fit`: 'wrap' (default) may take several lines, breaking only between digit groups; 'shrink' stays on
 * one line and scales the font down instead of cutting digits off (fixed-height list rows).
 */
export function MoneyText({
  value,
  testID,
  emphasis,
  fit = 'wrap',
}: {
  value: Money | null
  testID?: string
  emphasis?: boolean
  fit?: 'wrap' | 'shrink'
}) {
  const p = usePalette()
  const text = formatMoney(value)
  return (
    <Text
      testID={testID}
      accessibilityLabel={value === null ? 'No value' : text}
      {...(fit === 'shrink'
        ? { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: MONEY_MIN_FONT_SCALE }
        : {})}
      style={{
        color: value === null ? p.muted : p.text,
        fontSize: emphasis === true ? 20 : 15,
        fontWeight: emphasis === true ? '700' : '500',
        fontVariant: ['tabular-nums'],
      }}
    >
      {fit === 'wrap' ? breakableMoneyText(text) : text}
    </Text>
  )
}

export function Loading({ label }: { label: string }) {
  const p = usePalette()
  return (
    <View
      testID="loading"
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={{ padding: SPACE.xl, alignItems: 'center', gap: SPACE.md }}
    >
      <ActivityIndicator color={p.accent} />
      <Body muted>{label}</Body>
    </View>
  )
}

/** A failure with its fixed text and, when it can help, a retry. Never shows server detail. */
export function FailureView({ failure, onRetry }: { failure: Failure; onRetry?: () => void }) {
  const p = usePalette()
  return (
    <View
      testID={`failure-${failure.kind}`}
      accessibilityRole="alert"
      style={{ padding: SPACE.lg, gap: SPACE.md, alignItems: 'flex-start' }}
    >
      <Text style={{ color: p.danger, fontSize: 15, fontWeight: '600' }}>{failure.message}</Text>
      {failure.retryable && onRetry !== undefined ? (
        <Button label="Try again" variant="secondary" onPress={onRetry} />
      ) : null}
    </View>
  )
}

export function EmptyView({ title, detail }: { title: string; detail?: string }) {
  return (
    <View testID="empty" style={{ padding: SPACE.xl, gap: SPACE.sm }}>
      <Heading>{title}</Heading>
      {detail !== undefined ? <Body muted>{detail}</Body> : null}
    </View>
  )
}

export function Card({ children, testID }: { children: ReactNode; testID?: string }) {
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

/**
 * A labeled text field for the write forms. `keyboardType="decimal-pad"` for money/quantity fields
 * never restricts what can be TYPED (a pasted or autocorrected value can still contain letters), so
 * every money parser downstream (`write/money-input.ts`) still validates the raw string itself —
 * this component is a keyboard hint, never a validator.
 */
export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  errorText,
  testID,
  editable = true,
}: {
  label: string
  value: string
  onChangeText: (text: string) => void
  placeholder?: string
  keyboardType?: KeyboardTypeOptions
  errorText?: string | null
  testID?: string
  editable?: boolean
}) {
  const p = usePalette()
  return (
    <View style={{ gap: SPACE.xs }}>
      <Text style={{ color: p.muted, fontSize: 13, fontWeight: '600' }}>{label}</Text>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={p.muted}
        keyboardType={keyboardType}
        editable={editable}
        accessibilityLabel={label}
        style={{
          minHeight: MIN_TOUCH,
          paddingHorizontal: SPACE.md,
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: errorText != null ? p.danger : p.border,
          backgroundColor: p.surface,
          color: p.text,
          fontSize: 16,
        }}
      />
      {errorText != null ? (
        <Text accessibilityRole="alert" style={{ color: p.danger, fontSize: 13 }}>
          {errorText}
        </Text>
      ) : null}
    </View>
  )
}

export function Badge({ label }: { label: string }) {
  const p = usePalette()
  return (
    <Text
      style={{
        alignSelf: 'flex-start',
        color: p.warning,
        borderColor: p.warning,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 2,
        fontSize: 12,
        fontWeight: '700',
      }}
    >
      {label}
    </Text>
  )
}
