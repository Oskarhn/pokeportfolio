import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../data/supabase-client'
import { Button, FormMessage, TextField } from '../../ui/form'

const EXPIRY_HOURS = 168

interface CreatedInvitation {
  invitation_id: string
  token: string
  invited_email: string
  expires_at: string
}

/**
 * The whole administrative surface for a five-to-ten-user application: issue a link, copy it once,
 * see what is outstanding, revoke what should not be. No user-management dashboard, because there
 * is no population to manage.
 *
 * Every button here calls a Postgres function that re-checks `is_admin()` itself, and the list
 * reads a view whose underlying table has an admin-only RLS policy. A non-admin who reaches this
 * route sees a screen where nothing works, which is the correct behaviour — the route is not the
 * control.
 */
export function InvitationsPage() {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [label, setLabel] = useState('')
  const [issued, setIssued] = useState<CreatedInvitation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const invitations = useQuery({
    queryKey: ['invitations'],
    queryFn: async () => {
      const { data, error: queryError } = await supabase
        .from('invitation_overview')
        .select('id, email, label, expires_at, revoked_at, use_count, max_uses, status')
        .order('created_at', { ascending: false })
      if (queryError) throw new Error(queryError.message)
      return data
    },
  })

  const create = useMutation({
    mutationFn: async () => {
      const { data, error: rpcError } = await supabase
        .rpc('create_invitation', {
          p_email: email.trim(),
          p_expires_in_hours: EXPIRY_HOURS,
          p_label: label.trim() || undefined,
        })
        .single()
      if (rpcError) throw new Error(rpcError.message)
      return data as CreatedInvitation
    },
    onSuccess: (data) => {
      setIssued(data)
      setCopied(false)
      setEmail('')
      setLabel('')
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['invitations'] })
    },
    onError: (mutationError: Error) => {
      setIssued(null)
      setError(describeCreateError(mutationError.message))
    },
  })

  const revoke = useMutation({
    mutationFn: async (invitationId: string) => {
      const { error: rpcError } = await supabase.rpc('revoke_invitation', {
        p_invitation_id: invitationId,
      })
      if (rpcError) throw new Error(rpcError.message)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invitations'] })
    },
    onError: () => {
      setError('That invitation could not be revoked.')
    },
  })

  const inviteUrl = issued ? `${window.location.origin}/invite/${issued.token}` : null

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 py-2">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Invitations</h1>
        <p className="text-sm text-slate-400">
          An invitation link is shown once and cannot be recovered. Send it over a channel you trust
          — the link is the credential.
        </p>
      </header>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          create.mutate()
        }}
        noValidate
      >
        <TextField
          label="Email"
          type="email"
          name="invite-email"
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
        <TextField
          label="Note"
          name="invite-label"
          hint="Optional. Only you see this."
          value={label}
          onChange={(event) => {
            setLabel(event.target.value)
          }}
        />
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create invitation'}
        </Button>
      </form>

      {issued && inviteUrl ? (
        <section className="space-y-3 rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-4">
          <h2 className="text-sm font-semibold text-emerald-200">
            Link for {issued.invited_email}
          </h2>
          <p className="break-all rounded border border-slate-700 bg-slate-900 p-3 font-mono text-xs text-slate-200">
            {inviteUrl}
          </p>
          <p className="text-xs text-emerald-200/80">
            Valid until {new Date(issued.expires_at).toLocaleString()}. This is the only time it is
            shown.
          </p>
          <Button
            variant="quiet"
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(inviteUrl).then(() => {
                setCopied(true)
              })
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-300">Outstanding</h2>
        {invitations.isPending ? (
          <div className="h-20 animate-pulse rounded-lg bg-slate-800/60" />
        ) : invitations.isError ? (
          <FormMessage tone="error">Could not load invitations.</FormMessage>
        ) : invitations.data && invitations.data.length > 0 ? (
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            {invitations.data.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-3 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-200">{invitation.email}</p>
                  <p className="text-xs text-slate-500">
                    {invitation.status} · expires{' '}
                    {new Date(invitation.expires_at as string).toLocaleDateString()}
                    {invitation.label ? ` · ${invitation.label}` : ''}
                  </p>
                </div>
                {invitation.status === 'active' ? (
                  <Button
                    variant="quiet"
                    type="button"
                    className="w-auto"
                    disabled={revoke.isPending}
                    onClick={() => {
                      revoke.mutate(invitation.id as string)
                    }}
                  >
                    Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">
            No invitations yet. Create one above to let someone in.
          </p>
        )}
      </section>
    </div>
  )
}

/** Maps the RPC's error codes to something an admin can act on. Admins may see more detail. */
function describeCreateError(message: string): string {
  if (message.includes('account_exists')) return 'That address already has an account.'
  if (message.includes('invalid_email')) return 'That does not look like an email address.'
  if (message.includes('not_authorized')) return 'Your account cannot create invitations.'
  return 'The invitation could not be created.'
}
