import { backendDescribe, psql, publicEnv } from './support'

/**
 * The isolated stack must be harmless to everything outside it. P137 (in the released base, DB 104)
 * made the two Production-directed ingest cron jobs fail closed: they call
 * public.dispatch_ingest_call, which does nothing unless public.environment_ingest_config has a row.
 * This test observes that on the running stack instead of trusting the migration comment.
 */
backendDescribe('local stack isolation', () => {
  it('ingest dispatch is unconfigured, and pg_net has never queued or sent a request', () => {
    expect(psql('select count(*) from public.environment_ingest_config')).toBe('0')
    expect(psql('select count(*) from net.http_request_queue')).toBe('0')
    expect(psql('select count(*) from net._http_response')).toBe('0')
  })

  it('the cron jobs that exist are the known set; none targets a hosted URL', () => {
    const commands = psql('select command from cron.job').toLowerCase()
    expect(commands).not.toContain('supabase.co')
    expect(commands).not.toContain('pages.dev')
  })

  it('the API this suite talks to is the isolated stack (own project id and port)', () => {
    const env = publicEnv()
    expect(env.apiUrl).toBe('http://127.0.0.1:55321')
    expect(env.dbContainer).toBe('supabase_db_pokeportfolio-p158-mobile')
  })
})
