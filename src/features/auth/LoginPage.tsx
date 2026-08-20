import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useAuth } from '../../auth/useAuth'
import { AuthLayout, Button, FormMessage, PasswordField, TextField } from '../../ui/form'

/**
 * There is deliberately no "Create account" link. Account creation happens only by redeeming an
 * invitation, and that is enforced in Postgres and in the Auth hook — hiding a button would not
 * be a control, so the absence of one here is presentation, not security.
 */
export function LoginPage() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit() {
    setError(null)
    setBusy(true)
    const result = await signIn(email, password)
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return
    }
    await navigate({ to: '/' })
  }

  return (
    <AuthLayout title="Sign in" description="PokePortfolio is private and invite-only.">
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
        <PasswordField
          label="Password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value)
          }}
        />
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <Button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <Link
        to="/forgot-password"
        className="block text-sm text-sky-400 underline-offset-4 hover:underline"
      >
        Forgot your password?
      </Link>
    </AuthLayout>
  )
}
