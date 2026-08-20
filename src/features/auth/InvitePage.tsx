import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { supabase } from '../../data/supabase-client'
import { useAuth } from '../../auth/useAuth'
import { AuthLayout, Button, FormMessage, PasswordField } from '../../ui/form'

const MIN_PASSWORD_LENGTH = 12

/** Every invalid-invitation case is reported with one message, matching the server. */
const INVITATION_INVALID =
  'This invitation link is not valid. It may have expired, been revoked, or been used.'

type Stage =
  { kind: 'checking' } | { kind: 'invalid'; message: string } | { kind: 'ready'; email: string }

interface RedeemResponse {
  ok?: boolean
  error?: string
  message?: string
}

export function InvitePage() {
  const { token } = useParams({ from: '/invite/$token' })
  const navigate = useNavigate()
  const { signIn } = useAuth()

  const [stage, setStage] = useState<Stage>({ kind: 'checking' })
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true

    void supabase
      .rpc('invitation_status', { p_token: token })
      .maybeSingle()
      .then(({ data, error: rpcError }) => {
        if (!active) return
        if (rpcError) {
          setStage({
            kind: 'invalid',
            message: 'Could not reach the server. Check your connection and try again.',
          })
          return
        }
        if (data?.valid && data.invited_email) {
          setStage({ kind: 'ready', email: data.invited_email })
          return
        }
        setStage({ kind: 'invalid', message: INVITATION_INVALID })
      })

    return () => {
      active = false
    }
  }, [token])

  async function handleSubmit() {
    if (stage.kind !== 'ready') return

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
    const { data, error: invokeError } = await supabase.functions.invoke<RedeemResponse>(
      'redeem-invitation',
      { body: { token, password } },
    )

    if (invokeError || !data?.ok) {
      setBusy(false)
      // supabase-js reports a non-2xx as a FunctionsHttpError without parsing the body, so the
      // server's own message is not always reachable here. The generic invitation message is the
      // right default; a password problem is the one case worth distinguishing, because it is
      // the only one the person can act on.
      setError(
        data?.error === 'password_invalid'
          ? (data.message ?? INVITATION_INVALID)
          : INVITATION_INVALID,
      )
      return
    }

    const signedIn = await signIn(stage.email, password)
    setBusy(false)
    if (signedIn.error) {
      setError('Your account was created. Sign in with your new password to continue.')
      return
    }

    // `replace` rather than a push: it drops the invitation URL out of session history so the raw
    // token stops being one Back press away.
    await navigate({ to: '/', replace: true })
  }

  if (stage.kind === 'checking') {
    return (
      <AuthLayout title="Checking your invitation…">
        <div className="h-24 animate-pulse rounded-lg bg-slate-800/60" />
      </AuthLayout>
    )
  }

  if (stage.kind === 'invalid') {
    return (
      <AuthLayout title="Invitation unavailable">
        <FormMessage tone="error">{stage.message}</FormMessage>
        <p className="text-sm text-slate-400">
          Ask whoever invited you for a new link. If you already have an account, sign in instead.
        </p>
        <Link to="/login" className="text-sm text-sky-400 underline-offset-4 hover:underline">
          Go to sign in
        </Link>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Set up your account"
      description={`Creating the account for ${stage.email}.`}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void handleSubmit()
        }}
        noValidate
      >
        {/* Hidden but present: password managers need a username field to associate the saved
            credential with, and the address is fixed by the invitation, not chosen here. */}
        <input type="hidden" name="email" value={stage.email} autoComplete="username" readOnly />
        <PasswordField
          label="Password"
          name="new-password"
          autoComplete="new-password"
          required
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. A password manager is a good idea.`}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value)
          }}
        />
        <PasswordField
          label="Confirm password"
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
          {busy ? 'Creating your account…' : 'Create account'}
        </Button>
      </form>
    </AuthLayout>
  )
}
