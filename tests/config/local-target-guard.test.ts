import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  NonLocalTargetError,
  assertLocalOrDockerHostUrl,
  assertLocalTestTarget,
  assertLocalUrl,
  assertNotHostedKey,
  isLocalHostname,
} from '../support/local-target'

/**
 * P203: the destructive suites (tests/db, tests/authorization, the independent adversarial
 * packages, authenticated Playwright) must fail closed when their target is not a local stack.
 * This file proves the policy, proves every runner is wired to it, and proves the wiring by
 * actually starting the runners against a hosted-looking URL.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const read = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')

// Built from parts so this fixture is never mistaken for a real project identifier by a scanner.
const HOSTED_URL = ['https://', 'abcdefghijklmnopqrst', '.supabase', '.co'].join('')

function jwt(payload: object): string {
  const enc = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.signature-not-verified`
}

describe('isLocalHostname', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '[::1]'])('accepts %s', (host) => {
    expect(isLocalHostname(host)).toBe(true)
  })

  it.each([
    'abcdefghijklmnopqrst.supabase.co',
    'pokeportfolio-dev.pages.dev',
    'localhost.evil.com',
    '127.0.0.1.nip.io',
    'evil-localhost',
    '10.0.0.5',
    '0.0.0.0',
    'host.docker.internal',
    // A name that has to be resolved is not a verified loopback endpoint (P206): no subdomains,
    // no trailing dot, no other 127/8 address, no IPv4-mapped IPv6.
    'api.localhost',
    'a.b.localhost',
    'localhost.',
    '127.0.0.2',
    '[::ffff:7f00:1]',
    '[::ffff:127.0.0.1]',
    '',
  ])('refuses %j', (host) => {
    expect(isLocalHostname(host)).toBe(false)
  })
})

describe('assertLocalUrl', () => {
  it.each([
    'http://127.0.0.1:54321',
    'http://localhost:55330',
    'http://[::1]:54321',
    'http://[0:0:0:0:0:0:0:1]:54321',
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'postgres://postgres:postgres@localhost:54322/postgres?sslmode=disable',
    // The WHATWG parser normalises numeric IPv4 spellings, so they cannot smuggle a remote host:
    // what is contacted is the loopback address.
    'http://2130706433:54321',
    'http://0x7f.0.0.1:54321',
    'http://127.1:54321',
  ])('accepts %s', (url) => {
    expect(() => {
      assertLocalUrl('SUPABASE_URL', url)
    }).not.toThrow()
  })

  it.each([undefined, ''])('treats an absent variable (%j) as nothing to guard', (value) => {
    expect(() => {
      assertLocalUrl('SUPABASE_URL', value)
    }).not.toThrow()
  })

  it.each([
    HOSTED_URL,
    'https://pokeportfolio-dev.pages.dev',
    'http://localhost.evil.com:54321',
    'http://127.0.0.1.nip.io:54321',
    'http://127.0.0.1@evil.example:54321',
    'postgresql://postgres:secret-value@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
    'http://10.1.2.3:54321',
    // The Production project's own identifier (already public in docs/DECISIONS.md and the bundle).
    'https://nopmkroeygmlvndzjjqs.supabase.co',
    'postgresql://postgres:pw@db.nopmkroeygmlvndzjjqs.supabase.co:5432/postgres',
    // Loopback-looking prefixes that really name a remote host.
    'http://localhost:80@evil.example:54321',
    'http://localhost:pw@evil.example',
    'http://evil.example/localhost',
    // Userinfo on an API URL is never legitimate, even in front of a loopback host.
    'http://anything@127.0.0.1:54321',
    'http://user:pw@localhost:54321',
    // Loopback is exactly 127.0.0.1, localhost and [::1].
    'http://0.0.0.0:54321',
    'http://127.0.0.2:54321',
    'http://[::ffff:127.0.0.1]:54321',
    'http://localhost.:54321',
    'http://api.localhost:54321',
    // Wrong protocol or no host.
    'ftp://127.0.0.1',
    'file:///etc/passwd',
    'ws://127.0.0.1:54321',
  ])('refuses %s', (url) => {
    expect(() => {
      assertLocalUrl('SUPABASE_URL', url)
    }).toThrow(NonLocalTargetError)
  })

  it.each([
    // Backslash and embedded line breaks make different URL parsers read different hosts.
    'http://127.0.0.1\\@evil.example:54321',
    'http://127.0.0.1\n.evil.example:54321',
    'http://127.0.0.1\t.evil.example:54321',
    ' http://127.0.0.1:54321',
    'http://127.0.0.1:54321\r',
    'http://127.0.0.1:54321\u0000',
    'http://127.0.0.1:54321 .evil.example',
  ])('refuses the ambiguous value %j', (url) => {
    expect(() => {
      assertLocalUrl('SUPABASE_URL', url)
    }).toThrow(/whitespace, a control character or a backslash/)
  })

  it.each([
    // libpq and node-postgres let query parameters override the host written in the authority.
    'postgresql://postgres:pw@127.0.0.1:54322/postgres?host=db.example.org',
    'postgresql://postgres:pw@127.0.0.1:54322/postgres?HOST=db.example.org',
    'postgresql://postgres:pw@127.0.0.1:54322/postgres?hostaddr=203.0.113.9',
    'postgresql://postgres:pw@127.0.0.1:54322/postgres?sslmode=disable&service=prod',
    'postgresql://postgres:pw@127.0.0.1:54322/postgres?options=-c%20search_path%3Dx',
    // Multi-host and socket-path authorities are not a single verified loopback endpoint.
    'postgresql://postgres@127.0.0.1,db.example.org/postgres',
    'postgresql://postgres@%2Fvar%2Frun%2Fpostgresql/postgres',
  ])('refuses the redirectable Postgres URL %s', (url) => {
    expect(() => {
      assertLocalUrl('DB_URL', url)
    }).toThrow(NonLocalTargetError)
  })

  it('fails closed on a value that is not a URL at all', () => {
    expect(() => {
      assertLocalUrl('DB_URL', 'not-a-url')
    }).toThrow(/not a parseable URL/)
  })

  it('fails closed on a URL with no host', () => {
    expect(() => {
      assertLocalUrl('DB_URL', 'postgresql:///postgres?host=/var/run/postgresql')
    }).toThrow(NonLocalTargetError)
  })

  it('names the variable and the host but never repeats a credential in the URL', () => {
    const secret = 'super-secret-password-value'
    let message = ''
    try {
      assertLocalUrl('DB_URL', `postgresql://postgres:${secret}@db.example.org:5432/postgres`)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('DB_URL')
    expect(message).toContain('db.example.org')
    expect(message).not.toContain(secret)
  })

  it('does not repeat userinfo or query values of an API URL either', () => {
    let message = ''
    try {
      assertLocalUrl('SUPABASE_URL', 'http://anon:hunter2@127.0.0.1:54321/?apikey=sb_secret_value')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('SUPABASE_URL')
    expect(message).not.toContain('hunter2')
    expect(message).not.toContain('sb_secret_value')
  })
})

describe('assertLocalOrDockerHostUrl (the erasure-registry address)', () => {
  it.each([
    'http://127.0.0.1:8787',
    // Docker Desktop (Windows/macOS) and the Linux runner's docker0 bridge as the stack sees the host.
    'http://host.docker.internal:55790',
    'http://172.17.0.1:8787',
    'http://172.31.255.254:8787',
    'http://10.0.0.5:8787',
    'http://192.168.1.20:8787',
  ])('accepts %s', (url) => {
    expect(() => {
      assertLocalOrDockerHostUrl('ERASURE_REGISTRY_URL', url)
    }).not.toThrow()
  })

  it.each([
    'https://registry.example.org',
    'https://erasure-registry.workers.dev',
    // Just outside the private ranges.
    'http://172.15.0.1:8787',
    'http://172.32.0.1:8787',
    'http://192.169.0.1:8787',
    'http://11.0.0.1:8787',
    'http://host.docker.internal.evil.example:8787',
    'http://user:pw@127.0.0.1:8787',
    'ftp://127.0.0.1:8787',
    'http://127.0.0.1\\@registry.example.org',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => {
      assertLocalOrDockerHostUrl('ERASURE_REGISTRY_URL', url)
    }).toThrow(NonLocalTargetError)
  })

  it('treats an unset registry as nothing to guard', () => {
    expect(() => {
      assertLocalOrDockerHostUrl('ERASURE_REGISTRY_URL', undefined)
    }).not.toThrow()
  })
})

describe('assertNotHostedKey', () => {
  it('refuses a JWT that carries a project ref claim', () => {
    const key = jwt({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role: 'service_role' })
    expect(() => {
      assertNotHostedKey('SUPABASE_SERVICE_ROLE_KEY', key)
    }).toThrow(/hosted-project key/)
  })

  it('accepts the local stack demo key (no ref claim)', () => {
    const key = jwt({ iss: 'supabase-demo', role: 'service_role', exp: 1983812996 })
    expect(() => {
      assertNotHostedKey('SUPABASE_SERVICE_ROLE_KEY', key)
    }).not.toThrow()
  })

  it.each(['sb_secret_opaque_local_value', 'a.b', 'not.base64.json', '', undefined])(
    'leaves a key it cannot inspect (%j) to the URL check',
    (key) => {
      expect(() => {
        assertNotHostedKey('SUPABASE_ANON_KEY', key)
      }).not.toThrow()
    },
  )

  it('never echoes the key in the error', () => {
    const key = jwt({ ref: 'abcdefghijklmnopqrst' })
    let message = ''
    try {
      assertNotHostedKey('SUPABASE_ANON_KEY', key)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain(key)
    expect(message).not.toContain('signature-not-verified')
  })
})

describe('assertLocalTestTarget', () => {
  const local = {
    SUPABASE_URL: 'http://127.0.0.1:54321',
    DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    ERASURE_REGISTRY_URL: 'http://127.0.0.1:55790',
    SUPABASE_SERVICE_ROLE_KEY: jwt({ iss: 'supabase-demo', role: 'service_role' }),
  }

  it('accepts an entirely local configuration and an empty one', () => {
    expect(() => {
      assertLocalTestTarget(local)
    }).not.toThrow()
    expect(() => {
      assertLocalTestTarget({})
    }).not.toThrow()
  })

  it.each(['SUPABASE_URL', 'VITE_SUPABASE_URL', 'DB_URL', 'P153_DB_URL'])(
    'refuses a hosted %s even when everything else is local',
    (name) => {
      expect(() => {
        assertLocalTestTarget({ ...local, [name]: HOSTED_URL })
      }).toThrow(new RegExp(name))
    },
  )

  it('refuses a registry on a public host even when everything else is local', () => {
    expect(() => {
      assertLocalTestTarget({ ...local, ERASURE_REGISTRY_URL: 'https://registry.example.org' })
    }).toThrow(/ERASURE_REGISTRY_URL/)
  })

  it.each(['SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY'])(
    'refuses a hosted-project %s behind a local URL (a tunnelled project)',
    (name) => {
      expect(() => {
        assertLocalTestTarget({ ...local, [name]: jwt({ ref: 'abcdefghijklmnopqrst' }) })
      }).toThrow(new RegExp(name))
    },
  )
})

describe('every destructive runner is wired to the guard', () => {
  const guardSetup = 'local-target-global-setup'

  it.each([
    'vitest.db.config.ts',
    'test/m12-independent-adversarial/vitest.config.ts',
    'test/m13-independent-adversarial/vitest.config.ts',
    'tests/m16-independent/vitest.config.ts',
  ])('%s runs the guard as a global setup', (rel) => {
    expect(read(rel)).toContain(guardSetup)
  })

  it('playwright.config.ts asserts the target when the config loads', () => {
    const source = read('playwright.config.ts')
    expect(source).toContain("from './tests/support/local-target.ts'")
    expect(source).toMatch(/^assertLocalTestTarget\(process\.env\)$/m)
  })

  it('the shared client factories re-check the whole target at the point of use', () => {
    const source = read('tests/db/setup.ts')
    expect(source.match(/assertLocalTestTarget\(process\.env\)/g)).toHaveLength(2)
  })

  it.each(['tests/db/raw-sql.ts', 'tests/db/lib/held-lock-session.ts'])(
    '%s checks DB_URL before opening a direct Postgres connection',
    (rel) => {
      expect(read(rel)).toContain("assertLocalUrl('DB_URL'")
    },
  )

  it('no vitest config that names a Supabase-backed include omits the guard', () => {
    // Any future config under test/ or tests/ that starts a DB-backed package must opt in too.
    const configs = [
      'test/m12-independent-adversarial/vitest.config.ts',
      'test/m13-independent-adversarial/vitest.config.ts',
      'tests/m16-independent/vitest.config.ts',
      'vitest.db.config.ts',
    ]
    for (const rel of configs) expect(read(rel), rel).toContain(guardSetup)
  })
})

describe('the runners really abort against a hosted target', () => {
  const env = {
    ...process.env,
    SUPABASE_URL: HOSTED_URL,
    SUPABASE_ANON_KEY: 'unused',
    SUPABASE_SERVICE_ROLE_KEY: 'unused',
  }

  function run(args: string[], extra: Record<string, string> = {}) {
    return spawnSync(process.execPath, args, {
      cwd: repoRoot,
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 60_000,
    })
  }

  it('pnpm test:db refuses before any test executes', () => {
    const result = run(['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.db.config.ts'])
    const output = `${result.stdout}${result.stderr}`
    expect(result.status).not.toBe(0)
    expect(output).toContain('Refusing to run destructive tests')
    expect(output).toContain('SUPABASE_URL')
    // The global setup aborts the run, so vitest never reaches its per-file summary.
    expect(output).not.toMatch(/Test Files\s+\d+/)
  }, 90_000)

  it.each([
    'test/m12-independent-adversarial/vitest.config.ts',
    'test/m13-independent-adversarial/vitest.config.ts',
    'tests/m16-independent/vitest.config.ts',
  ])(
    '%s refuses before any test executes',
    (config) => {
      const result = run(['node_modules/vitest/vitest.mjs', 'run', '--config', config])
      const output = `${result.stdout}${result.stderr}`
      expect(result.status).not.toBe(0)
      expect(output).toContain('Refusing to run destructive tests')
    },
    90_000,
  )

  it('Playwright refuses to load its config with a hosted VITE_SUPABASE_URL', () => {
    const result = run(['node_modules/@playwright/test/cli.js', 'test', '--list'], {
      // Only the browser-facing variable is hosted, so the message must name exactly it.
      SUPABASE_URL: '',
      VITE_SUPABASE_URL: HOSTED_URL,
    })
    const output = `${result.stdout}${result.stderr}`
    expect(result.status).not.toBe(0)
    expect(output).toContain('Refusing to run destructive tests')
    expect(output).toContain('VITE_SUPABASE_URL')
  }, 90_000)
})
