import { useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react'

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
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />
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
  // where a thumb is and where the keyboard is least likely to cover them.
  return (
    <div className="mx-auto my-auto w-full max-w-sm space-y-6 py-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">{title}</h1>
        {description ? <p className="text-sm text-slate-400">{description}</p> : null}
      </div>
      {children}
    </div>
  )
}
