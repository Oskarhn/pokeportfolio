/**
 * @jest-environment node
 */
// P187: the native test drivers take their stack, emulator, AVD, app id and ports from the command
// line / environment (a parallel verifier of P186 had to edit source), and the Android release build
// takes its public backend values explicitly instead of from a pre-existing local-stack file.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/* eslint-disable @typescript-eslint/no-require-imports */
const { resolveInstance, dynamicStack } = require('../../scripts/p186/instance.cjs') as {
  resolveInstance: (input: {
    env?: Record<string, string>
    argv?: string[]
  }) => Record<string, string | number>
  dynamicStack: (name: string, shift: string | number) => Record<string, string | number | boolean>
}
const { resolveBuildEnv } = require('../../scripts/p186/build-env.cjs') as {
  resolveBuildEnv: (input: {
    argv?: string[]
    env?: Record<string, string>
    stack?: string
    readStackFile: () => { appUrl?: string; apiUrl?: string; publishableKey?: string }
  }) => { url: string; publishableKey: string; source: string }
}
/* eslint-enable @typescript-eslint/no-require-imports */

describe('resolveInstance: defaults reproduce the P186 normal use exactly', () => {
  it('no input -> the values scripts/p186/env.mjs used to hard-code', () => {
    expect(resolveInstance({})).toEqual({
      instance: 'p186',
      portShift: 650,
      SPIKE_PACKAGE: 'invalid.pokeportfolio.spike.p186',
      ANDROID_SERIAL: 'emulator-5560',
      ANDROID_AVD_NAME: 'p186_api36',
      P185_STACK: 'p186',
      P185_PORT_SHIFT: '650',
      P185_PROXY_PORT: '55841',
      P185_API_PORT: '55971',
      P185_DB_CONTAINER: 'supabase_db_pokeportfolio-p186-app',
      P185_EVIDENCE_DIR: 'p186-evidence',
    })
  })
})

describe('resolveInstance: a parallel instance needs no source edit', () => {
  it('derives every value from the instance name, port shift and emulator port', () => {
    const r = resolveInstance({
      env: { P186_INSTANCE: 'verify1', P186_PORT_SHIFT: '1600', P186_EMULATOR_PORT: '5562' },
    })
    expect(r).toMatchObject({
      SPIKE_PACKAGE: 'invalid.pokeportfolio.spike.verify1',
      ANDROID_SERIAL: 'emulator-5562',
      ANDROID_AVD_NAME: 'verify1_api36',
      P185_STACK: 'verify1',
      P185_API_PORT: '56921',
      P185_DB_CONTAINER: 'supabase_db_pokeportfolio-verify1-app',
      P185_EVIDENCE_DIR: 'verify1-evidence',
    })
  })

  it('precedence: command line > explicit consumer variable > P186_* > default', () => {
    const env = {
      P186_INSTANCE: 'fromenv',
      P186_EMULATOR_PORT: '5564',
      ANDROID_SERIAL: 'emulator-5570',
      P185_API_PORT: '57000',
    }
    const r = resolveInstance({ env, argv: ['--instance=fromcli', '--emulator-port=5566'] })
    expect(r.instance).toBe('fromcli') // CLI beats P186_INSTANCE
    expect(r.ANDROID_SERIAL).toBe('emulator-5570') // an explicit consumer variable beats the derived one
    expect(r.P185_API_PORT).toBe('57000')
    expect(r.ANDROID_AVD_NAME).toBe('fromcli_api36')
  })

  it('refuses names and ports that would address someone else', () => {
    expect(() => resolveInstance({ env: { P186_INSTANCE: '../x' } })).toThrow(/must match/)
    expect(() => resolveInstance({ env: { P186_EMULATOR_PORT: '5561' } })).toThrow(/even/)
    expect(() => resolveInstance({ env: { P186_EMULATOR_PORT: '80' } })).toThrow(/emulator port/)
    expect(() => resolveInstance({ env: { P186_PORT_SHIFT: 'x' } })).toThrow(/port shift/)
  })
})

describe('dynamicStack and stackOf', () => {
  it('uses the same port formulas as the registered P186 entry', () => {
    expect(dynamicStack('p186', 650)).toMatchObject({
      projectId: 'pokeportfolio-p186-app',
      mockPort: 55502,
    })
  })

  it('stackOf accepts an unregistered name only when a port shift is named', () => {
    const script =
      "import('./scripts/p169/local-backend.mjs').then((m) => { const s = m.stackOf(['--stack=zzverify']); console.log(JSON.stringify({ api: s.apiPort, db: s.dbContainer })) })"
    const run = (shift: string | null) => {
      const env: Record<string, string | undefined> = { ...process.env }
      delete env.P185_PORT_SHIFT
      delete env.P186_PORT_SHIFT
      if (shift !== null) env.P186_PORT_SHIFT = shift
      return execFileSync(process.execPath, ['-e', script], {
        cwd: join(__dirname, '..', '..'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      })
    }
    expect(JSON.parse(run('1600'))).toEqual({
      api: 56921,
      db: 'supabase_db_pokeportfolio-zzverify-app',
    })
    expect(() => run(null)).toThrow(/unknown stack "zzverify"/)
  })
})

describe('resolveBuildEnv', () => {
  const fileWith =
    (appUrl: string, key = 'sb_publishable_abc') =>
    () => ({
      appUrl,
      publishableKey: key,
    })
  const noFile = () => {
    throw new Error('ENOENT public-env.json')
  }

  it('explicit CLI values win and need no local stack', () => {
    const r = resolveBuildEnv({
      argv: ['--supabase-url=http://127.0.0.1:55971', '--publishable-key=sb_publishable_cli'],
      env: { EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:1111' },
      readStackFile: noFile,
    })
    expect(r).toEqual({
      url: 'http://127.0.0.1:55971',
      publishableKey: 'sb_publishable_cli',
      source: 'cli',
    })
  })

  it('then the environment, then the stack file', () => {
    expect(
      resolveBuildEnv({
        env: {
          EXPO_PUBLIC_SUPABASE_URL: 'http://192.168.1.20:54321',
          EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_env',
        },
        readStackFile: noFile,
      }).source,
    ).toBe('env')
    expect(resolveBuildEnv({ readStackFile: fileWith('http://127.0.0.1:55971') }).source).toBe(
      'stack-file',
    )
  })

  it('a missing prerequisite names what to do instead of failing with a bare ENOENT', () => {
    expect(() => resolveBuildEnv({ stack: 'p186', readStackFile: noFile })).toThrow(
      /--supabase-url.*EXPO_PUBLIC_SUPABASE_URL.*write-env/s,
    )
  })

  it('refuses a half-specified pair, a non-local URL and secret keys', () => {
    expect(() =>
      resolveBuildEnv({ argv: ['--supabase-url=http://127.0.0.1:1000'], readStackFile: noFile }),
    ).toThrow(/ENOENT|both/)
    expect(() => resolveBuildEnv({ readStackFile: fileWith('https://x.supabase.co:443') })).toThrow(
      /not a local/,
    )
    expect(() => resolveBuildEnv({ readStackFile: fileWith('http://8.8.8.8:54321') })).toThrow(
      /not a local/,
    )
    expect(() =>
      resolveBuildEnv({ readStackFile: fileWith('http://127.0.0.1:1000', 'sb_secret_x') }),
    ).toThrow(/secret/)
    const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')
    expect(() =>
      resolveBuildEnv({
        readStackFile: fileWith('http://127.0.0.1:1000', `h.${payload}.s`),
      }),
    ).toThrow(/secret/)
  })
})

describe('resolveInstance: every explicit consumer variable beats the derived value', () => {
  it.each([
    ['SPIKE_PACKAGE', 'invalid.pokeportfolio.explicit'],
    ['ANDROID_SERIAL', 'emulator-5590'],
    ['ANDROID_AVD_NAME', 'explicit_avd'],
    ['P185_STACK', 'explicitstack'],
    ['P185_PROXY_PORT', '59001'],
    ['P185_API_PORT', '59002'],
    ['P185_DB_CONTAINER', 'explicit_container'],
    ['P185_EVIDENCE_DIR', 'explicit-evidence'],
  ])('%s', (name, value) => {
    const r = resolveInstance({ env: { [name]: value } })
    expect(r[name]).toBe(value)
  })
})
