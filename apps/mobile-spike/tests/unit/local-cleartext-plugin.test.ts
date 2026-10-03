// The Android network security config written by plugins/with-local-cleartext.js must permit plain
// HTTP to the local backend aliases only; every other host keeps the platform default (HTTPS only).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../../plugins/with-local-cleartext') as {
  LOCAL_HOSTS: string[]
  networkSecurityConfigXml: () => string
}

describe('local cleartext config plugin', () => {
  const xml = plugin.networkSecurityConfigXml()

  it('keeps cleartext disabled by default', () => {
    expect(xml).toContain('<base-config cleartextTrafficPermitted="false" />')
    expect(xml.match(/cleartextTrafficPermitted="true"/g)).toHaveLength(1)
  })

  it('permits exactly the loopback aliases the backend guard accepts, without subdomains', () => {
    const domains = [...xml.matchAll(/<domain includeSubdomains="false">([^<]+)<\/domain>/g)].map(
      (m) => m[1],
    )
    expect(domains).toEqual(['10.0.2.2', '10.0.3.2', '127.0.0.1', 'localhost'])
    expect(xml).not.toMatch(/includeSubdomains="true"/)
    expect(xml).not.toMatch(/supabase\.co|pages\.dev/)
  })
})
