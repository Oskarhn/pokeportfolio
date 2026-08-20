import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { supabase } from '../../data/supabase-client'
import { useAuth } from '../../auth/useAuth'
import { AuthLayout, Button, FormMessage, PasswordField } from '../../ui/form'

const MIN_PASSWORD_LENGTH = 12

/**
 * The landing page for a recovery link. supabase-js consumes the tokens in the URL fragment and
 * establishes a recovery session before this renders, which is why the guard below is simply
 * "is there a session" — arriving here without one means the link was already used, expired, or
 * never existed.
 */
export function ResetPasswordPage() {
  const { status } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit() {
    setError(null)

    if (password !== confirmation) {
      setError('The two passwords do not match.')
      return
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }

    setBusy(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setBusy(false)

    if (updateError) {
      setError('That password could not be set. Choose a different one and try again.')
      return
    }
    await navigate({ to: '/', replace: true })
  }

  if (status === 'loading') {
    return (
      <AuthLayout title="Checking your recovery link…">
        <div className="h-24 animate-pulse rounded-lg bg-slate-800/60" />
      </AuthLayout>
    )
  }

  if (status === 'signed-out') {
    return (
      <AuthLayout title="Recovery link unavailable">
        <FormMessage tone="error">
          This recovery link is no longer valid. Request a new one and use it straight away.
        </FormMessage>
        <Link
          to="/forgot-password"
          className="text-sm text-sky-400 underline-offset-4 hover:underline"
        >
          Request a new link
        </Link>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Choose a new password">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void handleSubmit()
        }}
        noValidate
      >
        <PasswordField
          label="New password"
          name="new-password"
          autoComplete="new-password"
          required
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value)
          }}
        />
        <PasswordField
          label="Confirm new password"
          name="confirm-password"
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={(event) => {
            setConfirmation(event.target.value)
          }}
        />
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save new password'}
        </Button>
      </form>
    </AuthLayout>
  )
}
