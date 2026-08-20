import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { supabase } from '../../data/supabase-client'
import { AuthLayout, Button, FormMessage, TextField } from '../../ui/form'

/**
 * Password recovery over the built-in mail provider, which is capped at two auth emails per hour
 * across the whole project and is documented as best-effort. For five to ten users that is an
 * acceptable recovery channel, and it is the reason account creation does not send email at all
 * (docs/SECURITY.md §5.1). If it fails, the admin-assisted path in SECURITY.md §5.2 applies.
 *
 * The confirmation is unconditional. Telling the caller whether the address has an account would
 * turn this form into the enumeration oracle the Supabase API deliberately is not.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  async function handleSubmit() {
    setBusy(true)
    await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    setBusy(false)
    setSent(true)
  }

  return (
    <AuthLayout
      title="Reset your password"
      description="We will email a recovery link if this address has an account."
    >
      {sent ? (
        <FormMessage tone="success">
          If that address has an account, a recovery link is on its way. It expires shortly, so use
          it soon.
        </FormMessage>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSubmit()
          }}
          noValidate
        >
          <TextField
            label="Email"
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value)
            }}
          />
          <Button type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send recovery link'}
          </Button>
        </form>
      )}
      <Link to="/login" className="block text-sm text-sky-400 underline-offset-4 hover:underline">
        Back to sign in
      </Link>
    </AuthLayout>
  )
}
