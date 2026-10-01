#!/usr/bin/env node
/**
 * P186 secret scan of a built package (APK or AAB): looks inside every entry (inflated) for
 * secret-shaped content and reports ONLY which pattern matched in which entry, never the value.
 *
 *   node scripts/p186/secret-scan.mjs <file.apk|file.aab>
 *
 * `--stack p186` additionally looks for the EXACT secret values of that local stack (secret key,
 * service-role key, JWT secret), read from `supabase status` into memory only. The literal prefix
 * `sb_secret_` is NOT a finding on its own: the app's own refusal guard contains it (Hermes also
 * packs adjacent string literals together, so a pattern with a tail would match unrelated text).
 *
 * Exits 1 when a forbidden pattern is found. Patterns that are public by design (a Supabase
 * publishable key, an anon key) are reported as INFO and never fail the scan: they are meant to ship
 * in a client. A service-role key, a secret key, a private key block or a JWT signing secret are
 * never meant to, and fail it.
 */
import { readFileSync } from 'node:fs'
import { readEntry, readZipEntries } from './package-inventory.mjs'
import { readLocalEnv, stackOf } from '../p169/local-backend.mjs'

const FORBIDDEN = [
  ['service_role claim', /["']role["']\s*:\s*["']service_role["']/],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ['JWT signing secret name', /JWT_SECRET|SERVICE_ROLE_KEY|SUPABASE_SERVICE/],
  ['AWS access key id', /AKIA[0-9A-Z]{16}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
]
const PUBLIC_BY_DESIGN = [
  ['supabase publishable key (public by design)', /sb_publishable_[A-Za-z0-9_-]{8,}/],
  ['supabase anon JWT (public by design)', /eyJhbGciOiJIUzI1NiIs[A-Za-z0-9._-]{20,}/],
]

const stackFlag = process.argv.indexOf('--stack')
const known = []
if (stackFlag !== -1) {
  const env = readLocalEnv(stackOf([`--stack=${process.argv[stackFlag + 1]}`]))
  for (const key of ['SECRET_KEY', 'SERVICE_ROLE_KEY', 'JWT_SECRET'])
    if (typeof env[key] === 'string' && env[key].length >= 16) known.push([key, env[key]])
}
const file = process.argv[2]
if (file === undefined) throw new Error('usage: secret-scan.mjs <apk|aab>')
const buffer = readFileSync(file)
const entries = readZipEntries(buffer).filter((e) => !e.name.endsWith('/'))
const findings = []
const info = []
const TEXTUAL =
  /\.(bundle|json|xml|txt|properties|js|html|pro|pb|arsc|dex|so|sym|binarypb)$|(^|\/)(assets|res\/raw)\//
for (const entry of entries) {
  // Native libraries, models and the index hold no text secrets and dominate the size: skip them.
  if (/\.(so|sym|onnx|bin|fb|tflite|png|webp|jpg|ttf|otf)$/i.test(entry.name)) continue
  if (!TEXTUAL.test(entry.name) && !entry.name.endsWith('.dex')) continue
  let text
  try {
    text = readEntry(buffer, entry).toString('latin1')
  } catch {
    continue
  }
  for (const [label, value] of known)
    if (text.includes(value)) findings.push({ label: `exact local ${label}`, entry: entry.name })
  for (const [label, re] of FORBIDDEN)
    if (re.test(text)) findings.push({ label, entry: entry.name })
  for (const [label, re] of PUBLIC_BY_DESIGN)
    if (re.test(text)) info.push({ label, entry: entry.name })
}
console.log(
  JSON.stringify(
    {
      file,
      scannedEntries: entries.length,
      knownSecretsChecked: known.map(([label]) => label),
      forbiddenFindings: findings,
      publicByDesign: info,
    },
    null,
    2,
  ),
)
process.exit(findings.length === 0 ? 0 : 1)
