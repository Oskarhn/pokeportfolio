import {
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import { twMerge } from 'tailwind-merge'

/**
 * The small set of form primitives the auth screens need.
 *
 * Provisional by intent (docs/DESIGN_SYSTEM.md §0): the owner supplies visual direction later,
 * and spending effort on branded auth pages now would be spending it twice. What is here is the
 * part that would still be a bug in any visual direction — labels tied to inputs, visible focus
 * rings, touch targets that clear 44px, errors announced rather than only coloured, and the
 * autocomplete attributes that decide whether a password manager works at all.
 */

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  hint?: string
  error?: string | null
}

const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-3 text-base text-slate-100 ' +
  'placeholder:text-slate-500 outline-none focus-visible:border-sky-500 ' +
  'focus-visible:ring-2 focus-visible:ring-sky-500/40 disabled:opacity-60'

export function TextField({ label, hint, error, id, ...props }: FieldProps) {
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const describedBy = hint ? `${fieldId}-hint` : undefined

  return (
    <div className="space-y-1.5">
      <label htmlFor={fieldId} className="block text-sm font-medium text-slate-300">
        {label}
      </label>
      <input
        id={fieldId}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={inputClass}
        {...props}
      />
      {hint ? (
        <p id={`${fieldId}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Paste is never blocked and the value is never intercepted — both break password managers, which
 * is the opposite of what a password policy is for.
 */
export function PasswordField({ label, hint, error, id, ...props }: FieldProps) {
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const [revealed, setRevealed] = useState(false)
  const describedBy = hint ? `${fieldId}-hint` : undefined

  return (
    <div className="space-y-1.5">
      <label htmlFor={fieldId} className="block text-sm font-medium text-slate-300">
        {label}
      </label>
      <div className="relative">
        <input
          id={fieldId}
          type={revealed ? 'text' : 'password'}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={`${inputClass} pr-20`}
          {...props}
        />
        <button
          type="button"
          onClick={() => {
            setRevealed((current) => !current)
          }}
          className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-slate-400 hover:text-slate-200 focus-visible:outline-2 focus-visible:outline-sky-500"
        >
          {revealed ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint ? (
        <p id={`${fieldId}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string
  hint?: string
}

export function SelectField({ label, hint, id, children, ...props }: SelectProps) {
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const describedBy = hint ? `${fieldId}-hint` : undefined

  return (
    <div className="space-y-1.5">
      <label htmlFor={fieldId} className="block text-sm font-medium text-slate-300">
        {label}
      </label>
      <select id={fieldId} aria-describedby={describedBy} className={inputClass} {...props}>
        {children}
      </select>
      {hint ? (
        <p id={`${fieldId}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** A labelled set of mutually-exclusive choices rendered as buttons rather than native radios —
 *  matches the language-filter control on /catalog, so a chosen option always has the same look
 *  across the app. */
export function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
}) {
  const groupId = useId()
  return (
    <div className="space-y-1.5">
      <span id={groupId} className="block text-sm font-medium text-slate-300">
        {label}
      </span>
      <div className="flex flex-wrap gap-2" role="group" aria-labelledby={groupId}>
        {options.map(([optionValue, optionLabel]) => (
          <button
            key={optionValue}
            type="button"
            aria-pressed={value === optionValue}
            onClick={() => {
              onChange(optionValue)
            }}
            className={`min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors ${
              value === optionValue
                ? 'border-sky-500 bg-sky-600/20 text-slate-200'
                : 'border-slate-700 text-slate-300 hover:bg-slate-800'
            }`}
          >
            {optionLabel}
          </button>
        ))}
      </div>
    </div>
  )
}

export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3 border-t border-slate-800 pt-4 first:border-t-0 first:pt-0">
      <legend className="mb-1 text-sm font-semibold text-slate-200">{title}</legend>
      {children}
    </fieldset>
  )
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'quiet' }) {
  const base =
    'inline-flex min-h-11 w-full items-center justify-center rounded-lg px-4 text-sm font-semibold ' +
    'transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 ' +
    'disabled:cursor-not-allowed disabled:opacity-60'
  const variants = {
    primary: 'bg-sky-600 text-white hover:bg-sky-500',
    quiet: 'border border-slate-700 text-slate-200 hover:bg-slate-800',
  }
  // twMerge, not plain concatenation: a caller overriding a base utility (e.g. w-auto over the
  // default w-full, used at 15 call sites across 10 features) must reliably win. Plain string
  // concatenation left both classes in the DOM and let Tailwind's build-order — not the caller's
  // intent — decide which one applied, which is what silently forced several forms' "Save"/action
  // buttons back to full width (found P104, ProfilePage mobile overflow at 390px).
  return <button className={twMerge(base, variants[variant], className)} {...props} />
}

/** `role="alert"` so a failed sign-in is announced, not only reddened. */
export function FormMessage({ tone, children }: { tone: 'error' | 'success'; children: string }) {
  const tones = {
    error: 'border-rose-900/60 bg-rose-950/40 text-rose-200',
    success: 'border-emerald-900/60 bg-emerald-950/40 text-emerald-200',
  }
  return (
    <p role="alert" className={`rounded-lg border px-3 py-2 text-sm ${tones[tone]}`}>
      {children}
    </p>
  )
}

export function AuthLayout({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  // `my-auto` centres the form in whatever height is left rather than pinning it to the top with
  // dead space beneath. On a phone that keeps the fields near the middle of the screen, which is
  // where a thumb is.
  //
  // The uneven padding — 24px top, 96px bottom — sits the content ~36px above true centre. When a
  // box is centred, its *content* is offset from the middle by half the difference between its top
  // and bottom padding, so this is a deliberate 1cm nudge upward rather than a stray value.
  //
  // It is there for iOS. The on-screen keyboard carries an accessory bar above it (the field-
  // stepping and Done controls), and that bar was covering the "Forgot your password?" link on an
  // installed iPhone PWA while a field had focus. The bar's height is not exposed to CSS —
  // env(keyboard-inset-*) is not available in iOS Safari — so there is nothing to subtract; the
  // options are a fixed offset or a VisualViewport listener repositioning the form on every
  // resize. A dozen lines of JavaScript fighting the browser for a centimetre is the worse trade.
  return (
    <div className="mx-auto my-auto w-full max-w-sm space-y-6 pt-6 pb-24">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">{title}</h1>
        {description ? <p className="text-sm text-slate-400">{description}</p> : null}
      </div>
      {children}
    </div>
  )
}
