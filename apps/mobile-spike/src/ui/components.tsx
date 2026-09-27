import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type KeyboardAvoidingViewProps,
  type KeyboardTypeOptions,
  type ViewStyle,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Money } from '@shared/domain/money'
import { formatMoney } from '../money/format-money'
import type { Failure } from '../net/failure'
import { MIN_TOUCH, RADIUS, SPACE, TYPE, usePalette, useTheme, type Tokens } from './theme'

/**
 * P178 dark-first design system. Every component here reads colour from `useTheme()`/`usePalette()`
 * — never a literal hex value — so the whole app follows one token set (theme.ts). Existing exports
 * (Button, Body, Heading, MoneyText, Loading, FailureView, EmptyView, Card, TextField, Badge) keep
 * their exact prior API so every screen that already imports them is upgraded for free; everything
 * below `SectionHeader` is new, built for the screens this phase actually restyles.
 */

const KEYBOARD_BEHAVIOR: KeyboardAvoidingViewProps['behavior'] = 'padding'

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'text'

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
  variant?: ButtonVariant
  testID?: string
  accessibilityHint?: string
}) {
  const t = useTheme()
  const filled = variant === 'primary'
  const outlined = variant === 'secondary'
  const tint = variant === 'danger' ? t.negative : t.accent
  const color = filled ? t.onAccent : tint
  const style: ViewStyle = {
    minHeight: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    paddingHorizontal: variant === 'text' ? SPACE.sm : SPACE.lg,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: filled ? t.accent : 'transparent',
    borderWidth: outlined || variant === 'danger' ? StyleSheet.hairlineWidth * 2 : 0,
    borderColor: tint,
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
      <Text style={{ color, ...TYPE.button }}>{label}</Text>
    </Pressable>
  )
}

type NamedButtonProps = Omit<Parameters<typeof Button>[0], 'variant'>

export function PrimaryButton(props: NamedButtonProps) {
  return <Button {...props} variant="primary" />
}
export function SecondaryButton(props: NamedButtonProps) {
  return <Button {...props} variant="secondary" />
}
export function DestructiveButton(props: NamedButtonProps) {
  return <Button {...props} variant="danger" />
}
export function TextButton(props: NamedButtonProps) {
  return <Button {...props} variant="text" />
}

/** A close/back/dismiss control drawn from a plain text glyph — never an icon font or bundled SVG
 *  set, so there is no missing-glyph risk and no icon-direction decision hiding inside a component
 *  (P178 §8/§32: no icon set is chosen yet). Always carries a real accessibility label. */
export function IconButton({
  glyph,
  accessibilityLabel,
  onPress,
  testID,
  disabled,
  tone = 'default',
}: {
  glyph: string
  accessibilityLabel: string
  onPress: () => void
  testID?: string
  disabled?: boolean
  tone?: 'default' | 'danger'
}) {
  const t = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={{
        minHeight: MIN_TOUCH,
        minWidth: MIN_TOUCH,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled === true ? 0.5 : 1,
      }}
    >
      <Text style={{ fontSize: 22, color: tone === 'danger' ? t.negative : t.textPrimary }}>
        {glyph}
      </Text>
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

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
    <Text testID={testID} style={{ color: muted === true ? p.muted : p.text, ...TYPE.body }}>
      {children}
    </Text>
  )
}

export function Heading({ children, testID }: { children: ReactNode; testID?: string }) {
  const p = usePalette()
  return (
    <Text testID={testID} accessibilityRole="header" style={{ color: p.text, ...TYPE.title }}>
      {children}
    </Text>
  )
}

/** A muted, low-emphasis section label — sentence case, never uppercase/tracked (Foil's own rule,
 *  applied everywhere, not only in the Foil-styled screens). */
export function SectionHeader({
  title,
  action,
  testID,
}: {
  title: string
  action?: { label: string; onPress: () => void; testID?: string }
  testID?: string
}) {
  const t = useTheme()
  return (
    <View
      testID={testID}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
    >
      <Text style={{ color: t.textSecondary, ...TYPE.section }}>{title}</Text>
      {action !== undefined ? (
        <TextButton label={action.label} onPress={action.onPress} testID={action.testID} />
      ) : null}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * The formatter joins digit groups (and the amount and "kr") with no-break spaces, so a long amount is
 * one unbreakable word and Android split it INSIDE a group at large text sizes ("8 917 127 26" /
 * "2 195 456,87 kr", P166 F4). For wrapping layouts those separators become ordinary spaces: a line
 * can then break only between whole groups or before the currency. The digits, the grouping and the
 * accessibility label are unchanged; formatMoney itself is not touched.
 */
export function breakableMoneyText(formatted: string): string {
  return formatted.replace(new RegExp('[\u00A0\u202F]', 'g'), ' ')
}

/** Smallest scale a one-line amount may shrink to; far below any amount this app can hold. */
export const MONEY_MIN_FONT_SCALE = 0.4

export type PriceState = 'manual' | 'fresh' | 'stale' | 'missing'

function moneyColor(t: Tokens, value: Money | null, state?: PriceState): string {
  if (value === null) return t.priceUnknown
  if (state === 'manual') return t.manualValue
  return t.priceKnown
}

/**
 * A money figure. Absent (null) renders the honest dash, never a zero (see format-money.ts).
 * `fit`: 'wrap' (default) may take several lines, breaking only between digit groups; 'shrink' stays on
 * one line and scales the font down instead of cutting digits off (fixed-height list rows).
 * `state`, when given, tints a manual (person-entered) value distinctly from a priced one — colour is
 * never the only signal: the price-state caption text next to it always says so in words too.
 */
export function MoneyText({
  value,
  testID,
  emphasis,
  fit = 'wrap',
  state,
  size = 'row',
}: {
  value: Money | null
  testID?: string
  emphasis?: boolean
  fit?: 'wrap' | 'shrink'
  state?: PriceState
  size?: 'row' | 'large' | 'display'
}) {
  const t = useTheme()
  const text = formatMoney(value)
  const role =
    size === 'display'
      ? TYPE.displayValue
      : size === 'large' || emphasis === true
        ? TYPE.moneyLarge
        : TYPE.moneyRow
  return (
    <Text
      testID={testID}
      accessibilityLabel={value === null ? 'No value' : text}
      {...(fit === 'shrink'
        ? { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: MONEY_MIN_FONT_SCALE }
        : {})}
      style={{
        color: moneyColor(t, value, state),
        fontVariant: ['tabular-nums'],
        fontSize: role.fontSize,
        fontWeight: role.fontWeight,
        lineHeight: role.lineHeight,
      }}
    >
      {fit === 'wrap' ? breakableMoneyText(text) : text}
    </Text>
  )
}

/** The value + its price-state caption, the pattern Card detail and Collection both need (P178 §11).
 *  `unitValue`, when given, is a secondary "per card" line below the caption. */
export function PriceBlock({
  label,
  value,
  state,
  stateLabel,
  unitValue,
  testID,
  unitTestID,
  stateTestID,
}: {
  label: string
  value: Money | null
  state: PriceState
  stateLabel: string
  unitValue?: Money | null
  testID?: string
  unitTestID?: string
  stateTestID?: string
}) {
  const t = useTheme()
  return (
    <View style={{ gap: SPACE.xs }}>
      <Text style={{ color: t.textSecondary, ...TYPE.caption }}>{label}</Text>
      <MoneyText testID={testID} value={value} state={state} size="large" />
      <Text testID={stateTestID} style={{ color: t.textMuted, ...TYPE.caption }}>
        {stateLabel}
      </Text>
      {unitValue !== undefined && unitValue !== null ? (
        <>
          <Text style={{ color: t.textSecondary, ...TYPE.caption, marginTop: SPACE.xs }}>
            Per card
          </Text>
          <MoneyText testID={unitTestID} value={unitValue} />
        </>
      ) : null}
    </View>
  )
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function Loading({ label, testID }: { label: string; testID?: string }) {
  const t = useTheme()
  return (
    <View
      testID={testID ?? 'loading'}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={{ padding: SPACE.xl, alignItems: 'center', gap: SPACE.md }}
    >
      <ActivityIndicator color={t.accent} />
      <Body muted>{label}</Body>
    </View>
  )
}
export const LoadingState = Loading

/** A failure with its fixed text and, when it can help, a retry. Never shows server detail. */
export function FailureView({ failure, onRetry }: { failure: Failure; onRetry?: () => void }) {
  const t = useTheme()
  return (
    <View
      testID={`failure-${failure.kind}`}
      accessibilityRole="alert"
      style={{ padding: SPACE.lg, gap: SPACE.md, alignItems: 'flex-start' }}
    >
      <Text style={{ color: t.negative, ...TYPE.bodyStrong }}>{failure.message}</Text>
      {failure.retryable && onRetry !== undefined ? (
        <SecondaryButton label="Try again" onPress={onRetry} />
      ) : null}
    </View>
  )
}
export const ErrorState = FailureView

export function EmptyView({ title, detail }: { title: string; detail?: string }) {
  return (
    <View testID="empty" style={{ padding: SPACE.xl, gap: SPACE.sm }}>
      <Heading>{title}</Heading>
      {detail !== undefined ? <Body muted>{detail}</Body> : null}
    </View>
  )
}
export const EmptyState = EmptyView

/** A full-width callout bar: a coloured left rule plus text, never colour alone. Used for the
 *  product's own honesty lines ("Checking a price never adds…", "Nothing is charged…", the
 *  scanner's "not built in yet" disclosure) so they read as a deliberate statement, not a stray
 *  caption. */
export function InlineNotice({
  children,
  tone = 'info',
  testID,
}: {
  children: ReactNode
  tone?: 'info' | 'warning' | 'danger' | 'neutral'
  testID?: string
}) {
  const t = useTheme()
  const rule =
    tone === 'danger'
      ? t.negative
      : tone === 'warning'
        ? t.warning
        : tone === 'info'
          ? t.info
          : t.borderStrong
  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        gap: SPACE.md,
        backgroundColor: t.surfaceRaised,
        borderRadius: RADIUS.sm,
        padding: SPACE.md,
      }}
    >
      <View style={{ width: 3, borderRadius: 2, backgroundColor: rule }} />
      <Text style={{ flex: 1, color: t.textSecondary, ...TYPE.caption }}>{children}</Text>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Surfaces & layout
// ---------------------------------------------------------------------------

export function Surface({
  children,
  testID,
  level = 'raised',
}: {
  children: ReactNode
  testID?: string
  level?: 'raised' | 'sunken' | 'flat'
}) {
  const t = useTheme()
  const background =
    level === 'sunken' ? t.surfaceSunken : level === 'flat' ? t.background : t.surfaceRaised
  return (
    <View
      testID={testID}
      style={{
        backgroundColor: background,
        borderRadius: RADIUS.md,
        padding: SPACE.lg,
        gap: SPACE.sm,
        borderWidth: level === 'flat' ? 0 : StyleSheet.hairlineWidth,
        borderColor: t.borderSubtle,
      }}
    >
      {children}
    </View>
  )
}

/** Kept as the original name: every existing screen already imports `Card`. */
export function Card({ children, testID }: { children: ReactNode; testID?: string }) {
  return <Surface testID={testID}>{children}</Surface>
}

export function Divider({ testID }: { testID?: string }) {
  const t = useTheme()
  return (
    <View
      testID={testID}
      style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.borderSubtle }}
    />
  )
}

/** A themed screen background with consistent padding. Optional — existing screens that already
 *  manage their own ScrollView keep doing so; this is for screens redesigned in this phase and any
 *  new ones. */
export function AppScreen({
  children,
  scroll = true,
  testID,
  contentContainerStyle,
}: {
  children: ReactNode
  scroll?: boolean
  testID?: string
  contentContainerStyle?: ViewStyle
}) {
  const t = useTheme()
  if (!scroll) {
    return (
      <View testID={testID} style={{ flex: 1, backgroundColor: t.background }}>
        {children}
      </View>
    )
  }
  return (
    <ScrollView
      testID={testID}
      style={{ backgroundColor: t.background }}
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg, ...contentContainerStyle }}
    >
      {children}
    </ScrollView>
  )
}

/** A simple top toolbar row for a screen that needs one inside its own content (distinct from the
 *  navigator's native header, which handles the platform back gesture). */
export function AppHeader({
  title,
  subtitle,
  left,
  right,
  testID,
}: {
  title: string
  subtitle?: string
  left?: ReactNode
  right?: ReactNode
  testID?: string
}) {
  const t = useTheme()
  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACE.sm,
        paddingHorizontal: SPACE.lg,
        paddingVertical: SPACE.md,
        backgroundColor: t.surface,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: t.borderSubtle,
      }}
    >
      {left}
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.textPrimary, ...TYPE.title }}>{title}</Text>
        {subtitle !== undefined ? (
          <Text style={{ color: t.textSecondary, ...TYPE.caption }}>{subtitle}</Text>
        ) : null}
      </View>
      {right}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Task (write-form) layout
// ---------------------------------------------------------------------------

/** A pinned bottom action bar. Laid out as a normal flex sibling of the scrollable form content
 *  (never `position: absolute`), so it can never overlap the last field — it simply takes its own
 *  space and the form's ScrollView fills what remains. */
export function TaskFooter({
  children,
  testID,
  insetBottom = 0,
}: {
  children: ReactNode
  testID?: string
  insetBottom?: number
}) {
  const t = useTheme()
  return (
    <View
      testID={testID}
      style={{
        backgroundColor: t.surfaceRaised,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: t.borderSubtle,
        padding: SPACE.lg,
        paddingBottom: SPACE.lg + insetBottom,
        gap: SPACE.xs,
      }}
    >
      {children}
    </View>
  )
}

/** Composes a scrollable form with a footer pinned below it (never over it) and keeps both above the
 *  keyboard. Use for the financial write-form screens (P178 §15). */
export function TaskScreen({
  children,
  footer,
  testID,
}: {
  children: ReactNode
  footer: ReactNode
  testID?: string
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={KEYBOARD_BEHAVIOR}>
      <View style={{ flex: 1, backgroundColor: t.background }}>
        <ScrollView
          testID={testID}
          contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg }}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
        <TaskFooter insetBottom={insets.bottom}>{footer}</TaskFooter>
      </View>
    </KeyboardAvoidingView>
  )
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

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
  const t = useTheme()
  return (
    <View style={{ gap: SPACE.xs }}>
      <Text style={{ color: t.textSecondary, ...TYPE.caption }}>{label}</Text>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.textMuted}
        keyboardType={keyboardType}
        editable={editable}
        accessibilityLabel={label}
        style={{
          minHeight: MIN_TOUCH,
          paddingHorizontal: SPACE.md,
          borderRadius: RADIUS.sm,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: errorText != null ? t.negative : t.borderSubtle,
          backgroundColor: t.surfaceSunken,
          color: t.textPrimary,
          fontSize: TYPE.body.fontSize,
        }}
      />
      {errorText != null ? (
        <Text accessibilityRole="alert" style={{ color: t.negative, ...TYPE.caption }}>
          {errorText}
        </Text>
      ) : null}
    </View>
  )
}

/** A `TextField` preset for money: forces the decimal keypad and tabular figures. Parsing and
 *  currency-exponent rules still live entirely in `write/money-input.ts` — this only shapes input. */
export function MoneyField(props: Omit<Parameters<typeof TextField>[0], 'keyboardType'>) {
  return <TextField {...props} keyboardType="decimal-pad" />
}

/** A `TextField` preset for an ISO date typed as text (no native date-picker dependency is added for
 *  this: the value is validated by `write/event-date.ts` exactly like every other write field). */
export function DateField(props: Parameters<typeof TextField>[0]) {
  return <TextField {...props} placeholder={props.placeholder ?? 'YYYY-MM-DD'} />
}

export function SearchField({
  value,
  onChangeText,
  placeholder,
  testID,
  onSubmitEditing,
}: {
  value: string
  onChangeText: (text: string) => void
  placeholder: string
  testID?: string
  onSubmitEditing?: () => void
}) {
  const t = useTheme()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: MIN_TOUCH,
        paddingHorizontal: SPACE.md,
        borderRadius: RADIUS.pill,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.borderSubtle,
        backgroundColor: t.surfaceSunken,
        gap: SPACE.sm,
      }}
    >
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.textMuted}
        accessibilityLabel={placeholder}
        returnKeyType="search"
        onSubmitEditing={onSubmitEditing}
        style={{
          flex: 1,
          color: t.textPrimary,
          fontSize: TYPE.body.fontSize,
          paddingVertical: SPACE.sm,
        }}
      />
      {value !== '' ? (
        <IconButton glyph="×" accessibilityLabel="Clear search" onPress={() => onChangeText('')} />
      ) : null}
    </View>
  )
}

/** A row that opens a picker (a `BottomSheet`, typically) — label, current value, trailing chevron. */
export function SelectRow({
  label,
  value,
  onPress,
  testID,
  disabled,
}: {
  label: string
  value: string
  onPress: () => void
  testID?: string
  disabled?: boolean
}) {
  const t = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: MIN_TOUCH,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: SPACE.md,
        borderRadius: RADIUS.sm,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.borderSubtle,
        backgroundColor: t.surfaceSunken,
        opacity: disabled === true ? 0.5 : 1,
      }}
    >
      <View>
        <Text style={{ color: t.textSecondary, ...TYPE.caption }}>{label}</Text>
        <Text style={{ color: t.textPrimary, ...TYPE.body }}>{value}</Text>
      </View>
      <Text style={{ color: t.textMuted, fontSize: 20 }}>{'›'}</Text>
    </Pressable>
  )
}

export function RadioRow({
  label,
  meta,
  selected,
  onPress,
  testID,
}: {
  label: string
  meta?: string
  selected: boolean
  onPress: () => void
  testID?: string
}) {
  const t = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        minHeight: MIN_TOUCH,
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACE.md,
        paddingVertical: SPACE.sm,
        paddingHorizontal: SPACE.md,
        borderRadius: RADIUS.sm,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: selected ? t.accent : t.borderSubtle,
        backgroundColor: selected ? t.accentSoft : 'transparent',
      }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          borderWidth: 2,
          borderColor: selected ? t.accent : t.borderStrong,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {selected ? (
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.accent }} />
        ) : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.textPrimary, ...TYPE.body }}>{label}</Text>
        {meta !== undefined ? (
          <Text style={{ color: t.textSecondary, ...TYPE.caption }}>{meta}</Text>
        ) : null}
      </View>
    </Pressable>
  )
}

export function SwitchRow({
  label,
  helper,
  value,
  onValueChange,
  testID,
  disabled,
}: {
  label: string
  helper?: string
  value: boolean
  onValueChange: (value: boolean) => void
  testID?: string
  disabled?: boolean
}) {
  const t = useTheme()
  return (
    <View
      style={{
        minHeight: MIN_TOUCH,
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACE.md,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.textPrimary, ...TYPE.body }}>{label}</Text>
        {helper !== undefined ? (
          <Text style={{ color: t.textMuted, ...TYPE.caption }}>{helper}</Text>
        ) : null}
      </View>
      <Switch
        testID={testID}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={label}
        trackColor={{ false: t.borderStrong, true: t.accentSoft }}
        thumbColor={value ? t.accent : t.textDisabled}
      />
    </View>
  )
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  testID,
}: {
  options: { value: T; label: string; testID?: string }[]
  value: T
  onChange: (value: T) => void
  testID?: string
}) {
  const t = useTheme()
  return (
    <View
      testID={testID}
      accessibilityRole="radiogroup"
      style={{
        flexDirection: 'row',
        borderRadius: RADIUS.pill,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.borderSubtle,
        backgroundColor: t.surfaceSunken,
        padding: 3,
        gap: 3,
      }}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Pressable
            key={option.value}
            testID={option.testID}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            style={{
              flex: 1,
              minHeight: MIN_TOUCH,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: RADIUS.pill,
              backgroundColor: selected ? t.accent : 'transparent',
              paddingHorizontal: SPACE.sm,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: selected ? t.onAccent : t.textSecondary,
                ...TYPE.caption,
                fontWeight: '600',
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Chips & badges
// ---------------------------------------------------------------------------

export function Chip({ label, testID }: { label: string; testID?: string }) {
  const t = useTheme()
  return (
    <View
      testID={testID}
      style={{
        alignSelf: 'flex-start',
        backgroundColor: t.surfaceRaised,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.borderSubtle,
        borderRadius: RADIUS.pill,
        paddingHorizontal: SPACE.md,
        paddingVertical: SPACE.xs,
      }}
    >
      <Text style={{ color: t.textSecondary, ...TYPE.caption }}>{label}</Text>
    </View>
  )
}

export function FilterChip({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string
  selected: boolean
  onPress: () => void
  testID?: string
}) {
  const t = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        minHeight: MIN_TOUCH,
        justifyContent: 'center',
        backgroundColor: selected ? t.accentSoft : t.surfaceRaised,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: selected ? t.accent : t.borderSubtle,
        borderRadius: RADIUS.pill,
        paddingHorizontal: SPACE.md,
      }}
    >
      <Text
        style={{ color: selected ? t.accent : t.textSecondary, ...TYPE.caption, fontWeight: '600' }}
      >
        {selected ? `✓ ${label}` : label}
      </Text>
    </Pressable>
  )
}

/** Kept for the one legacy call site that still asks for a plain tone-coloured pill by name. */
export function Badge({ label }: { label: string }) {
  const t = useTheme()
  return (
    <Text
      style={{
        alignSelf: 'flex-start',
        color: t.warning,
        borderColor: t.warning,
        borderWidth: 1,
        borderRadius: RADIUS.sm - 2,
        paddingHorizontal: 6,
        paddingVertical: 2,
        ...TYPE.micro,
      }}
    >
      {label}
    </Text>
  )
}

export function StatusBadge({
  label,
  tone = 'neutral',
  testID,
}: {
  label: string
  tone?: 'positive' | 'negative' | 'warning' | 'info' | 'neutral'
  testID?: string
}) {
  const t = useTheme()
  const color =
    tone === 'positive'
      ? t.positive
      : tone === 'negative'
        ? t.negative
        : tone === 'warning'
          ? t.warning
          : tone === 'info'
            ? t.info
            : t.textSecondary
  return (
    <View
      testID={testID}
      style={{
        alignSelf: 'flex-start',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: color,
        borderRadius: RADIUS.pill,
        paddingHorizontal: SPACE.md,
        paddingVertical: SPACE.xs,
      }}
    >
      <Text style={{ color, ...TYPE.caption, fontWeight: '600' }}>{label}</Text>
    </View>
  )
}

const PROVIDER_LABELS: Record<string, string> = {
  tcgdex_cardmarket: 'Cardmarket via TCGdex',
  tcgdex_tcgplayer: 'TCGplayer via TCGdex',
}

export function providerLabelForCode(code: string): string {
  return PROVIDER_LABELS[code] ?? code
}

export function ProviderBadge({ label, testID }: { label: string; testID?: string }) {
  return <Chip label={label} testID={testID} />
}

/** Freshness is always stated in words (`label`) — colour is a secondary reinforcement, never the
 *  only signal, matching the rest of this app's accessibility posture. */
export function FreshnessBadge({
  label,
  freshness,
  testID,
}: {
  label: string
  freshness: 'fresh' | 'stale' | 'outdated' | 'unknown'
  testID?: string
}) {
  const tone =
    freshness === 'fresh'
      ? 'positive'
      : freshness === 'stale'
        ? 'warning'
        : freshness === 'outdated'
          ? 'negative'
          : 'neutral'
  return <StatusBadge label={label} tone={tone} testID={testID} />
}

// ---------------------------------------------------------------------------
// Card artwork & rows
// ---------------------------------------------------------------------------

const ARTWORK_SIZE = {
  sm: { width: 40, height: 56 },
  md: { width: 64, height: 90 },
  lg: { width: 96, height: 134 },
} as const

/** A flat, purpose-built placeholder tile (5:7, the real card-image aspect ratio) — never a
 *  generated illustration or borrowed art. `finish` draws the thin accent edge Foil reserves for
 *  holo/reverse-holo printings; every other finish gets a plain hairline border. */
export function CardArtwork({
  size = 'sm',
  finish,
  testID,
}: {
  size?: 'sm' | 'md' | 'lg'
  finish?: 'normal' | 'holo' | 'reverse' | 'other' | null
  testID?: string
}) {
  const t = useTheme()
  const dims = ARTWORK_SIZE[size]
  const isFoil = finish === 'holo' || finish === 'reverse'
  return (
    <View
      testID={testID}
      style={{
        ...dims,
        borderRadius: RADIUS.sm,
        backgroundColor: t.surfaceRaised,
        borderWidth: isFoil ? 2 : StyleSheet.hairlineWidth,
        borderColor: isFoil ? t.accent : t.borderSubtle,
      }}
    />
  )
}

/** The presentational half of a collection list row: artwork, identity, trailing money/note. Left
 *  un-memoised on purpose — `CollectionScreen` wraps it in its own `memo` boundary so the
 *  virtualization performance work stays exactly where it was. */
export function CardRow({
  title,
  subtitle,
  value,
  valueState,
  note,
  finish,
  onPress,
  testID,
  height,
  accessibilityLabel,
}: {
  title: string
  subtitle: string
  value: Money | null
  valueState?: PriceState
  note?: string
  finish?: 'normal' | 'holo' | 'reverse' | 'other' | null
  onPress?: () => void
  testID?: string
  height?: number
  accessibilityLabel?: string
}) {
  const t = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress !== undefined ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={{
        height,
        minHeight: MIN_TOUCH,
        paddingHorizontal: SPACE.lg,
        paddingVertical: SPACE.sm,
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACE.md,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: t.borderSubtle,
        backgroundColor: t.surface,
      }}
    >
      <CardArtwork size="sm" finish={finish} />
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={1.4}
          style={{ color: t.textPrimary, ...TYPE.bodyStrong }}
        >
          {title}
        </Text>
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={1.4}
          style={{ color: t.textSecondary, ...TYPE.caption }}
        >
          {subtitle}
        </Text>
        {note !== undefined ? (
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={1.4}
            style={{ color: t.textMuted, ...TYPE.micro }}
          >
            {note}
          </Text>
        ) : null}
      </View>
      <View style={{ maxWidth: '40%', flexShrink: 1, alignItems: 'flex-end' }}>
        <MoneyText value={value} fit="shrink" state={valueState} />
      </View>
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// Bottom sheet
// ---------------------------------------------------------------------------

/** A modal sheet sliding from the bottom — the app's one generic picker surface (used today for the
 *  purchase/sale currency picker; any future single-choice picker can reuse it instead of growing a
 *  bespoke dropdown per screen). */
export function BottomSheet({
  visible,
  onClose,
  title,
  children,
  testID,
}: {
  visible: boolean
  onClose: () => void
  title: string
  children: ReactNode
  testID?: string
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        testID={testID !== undefined ? `${testID}-scrim` : undefined}
        accessibilityLabel="Close"
        onPress={onClose}
        style={{ flex: 1, backgroundColor: t.overlay, justifyContent: 'flex-end' }}
      >
        <Pressable testID={testID} onPress={(e) => e.stopPropagation()}>
          <View
            style={{
              backgroundColor: t.surfaceRaised,
              borderTopLeftRadius: RADIUS.lg,
              borderTopRightRadius: RADIUS.lg,
              paddingTop: SPACE.md,
              paddingBottom: SPACE.lg + insets.bottom,
              paddingHorizontal: SPACE.lg,
              gap: SPACE.sm,
            }}
          >
            <View
              style={{
                alignSelf: 'center',
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: t.borderStrong,
                marginBottom: SPACE.sm,
              }}
            />
            <Text accessibilityRole="header" style={{ color: t.textPrimary, ...TYPE.section }}>
              {title}
            </Text>
            {children}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
