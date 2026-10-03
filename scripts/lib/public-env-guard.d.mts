export const KNOWN_PUBLIC_VARS: readonly string[]

export interface EnvFinding {
  readonly field: string
  readonly category: string
}

export interface PublicEnvGuardOptions {
  readonly requireHosted?: boolean
  readonly requirePresent?: boolean
}

export interface PublicEnvGuardResult {
  readonly ok: boolean
  readonly profile: 'hosted' | 'local' | 'invalid'
  readonly problems: EnvFinding[]
  readonly notes: EnvFinding[]
}

export function findSecretShapes(text: string): { secretKey: boolean; serviceRoleJwt: boolean }

export function validatePublicEnv(
  env: Readonly<Record<string, string | undefined>>,
  options?: PublicEnvGuardOptions,
): PublicEnvGuardResult

export function formatGuardReport(result: PublicEnvGuardResult): string[]

export class PublicEnvGuardError extends Error {
  readonly problems: EnvFinding[]
  constructor(result: { readonly problems: EnvFinding[] })
}

export function assertPublicEnv(
  env: Readonly<Record<string, string | undefined>>,
  options?: PublicEnvGuardOptions,
): PublicEnvGuardResult

export function collectPublicEnv(
  fileEnv: Readonly<Record<string, string>>,
  processEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined>

export function resolveRequireHosted(
  processEnv: Readonly<Record<string, string | undefined>>,
): boolean
