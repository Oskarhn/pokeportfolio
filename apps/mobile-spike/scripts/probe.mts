import { readFileSync } from 'node:fs'
// @ts-expect-error mjs
import { readLocalEnv } from './local-backend.mjs'
const env = readLocalEnv() as Record<string, string>
const fx = JSON.parse(
  readFileSync(new URL('../.local-backend/fixture.json', import.meta.url), 'utf8'),
)
const login = await fetch(`${env.API_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: env.PUBLISHABLE_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ email: fx.users.a.email, password: fx.users.a.password }),
})
const sess = (await login.json()) as any
console.log(
  'login',
  login.status,
  'access_token bytes',
  JSON.stringify(sess).length,
  'keys',
  Object.keys(sess),
)
const rpc = async (name: string, body: object) => {
  const r = await fetch(`${env.REST_URL}/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: env.PUBLISHABLE_KEY,
      authorization: `Bearer ${sess.access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return { status: r.status, text: await r.text() }
}
const c = await rpc('portfolio_counts', {})
console.log('counts', c.status, c.text.slice(0, 400))
const l = await rpc('list_portfolio', { p_sort: 'value_desc', p_limit: 4 })
console.log(
  'list',
  l.status,
  l.text.replace(/"(card_image_base_url|notes)":null,?/g, '').slice(0, 900),
)
