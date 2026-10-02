/**
 * The build-time public configuration of a LOCAL candidate build, resolved explicitly.
 *
 * P186's build driver only read `.local-backend/<stack>/public-env.json`, which exists only after a
 * local Supabase stack was started and its env written (`node scripts/p185/backend.mjs write-env`).
 * A clean checkout failed with an unexplained ENOENT. The two EXPO_PUBLIC_* values the app embeds
 * can now be given directly; the stack file is the fallback. Precedence, highest first:
 *   1. --supabase-url=… / --publishable-key=…
 *   2. EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in the environment
 *   3. .local-backend/<stack>/public-env.json (a started local stack)
 * Both values end up in the app bundle, so only PUBLIC values are accepted: the URL must be a local
 * development address (the app refuses anything else at startup, src/config/backend-config.ts) and
 * a secret/service-role key is refused. Nothing secret is read from, or written to, anywhere.
 */
'use strict'

const LOCAL_URL =
  /^http:\/\/(127\.0\.0\.1|localhost|10\.0\.2\.2|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):\d{2,5}$/

function isServiceRoleJwt(key) {
  const parts = key.split('.')
  if (parts.length !== 3) return false
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return payload.role === 'service_role'
  } catch {
    return false
  }
}

/**
 * @param {{ argv?: string[], env?: Record<string, string | undefined>, readStackFile: () => {appUrl?: string, apiUrl?: string, publishableKey?: string}, stack?: string }} input
 * @returns {{ url: string, publishableKey: string, source: 'cli' | 'env' | 'stack-file' }}
 */
function resolveBuildEnv({ argv = [], env = {}, readStackFile, stack = 'p186' }) {
  const flag = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)
  let url = flag('supabase-url')
  let key = flag('publishable-key')
  let source = 'cli'
  if (url === undefined && key === undefined) {
    url = env.EXPO_PUBLIC_SUPABASE_URL
    key = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    source = 'env'
  }
  if (url === undefined && key === undefined) {
    let file
    try {
      file = readStackFile()
    } catch (cause) {
      throw new Error(
        `no build-time backend configuration. Give --supabase-url=… and --publishable-key=… (or set ` +
          `EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY), or start the local stack ` +
          `"${stack}" and write its env (node scripts/p185/backend.mjs write-env) so ` +
          `.local-backend/${stack}/public-env.json exists. ${String(cause?.message ?? cause)}`,
      )
    }
    url = file.appUrl ?? file.apiUrl
    key = file.publishableKey
    source = 'stack-file'
  }
  if (typeof url !== 'string' || typeof key !== 'string' || url === '' || key === '') {
    throw new Error('both the backend URL and the publishable key are required (got only one)')
  }
  if (!LOCAL_URL.test(url)) throw new Error('refusing: not a local development URL')
  if (/^sb_secret_/.test(key) || isServiceRoleJwt(key)) throw new Error('refusing: secret key')
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error('refusing: malformed key')
  return { url, publishableKey: key, source }
}

module.exports = { resolveBuildEnv }
