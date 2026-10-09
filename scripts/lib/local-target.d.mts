export class NonLocalTargetError extends Error {
  constructor(message: string)
}
export function isLocalHostname(hostname: string): boolean
export function assertLocalUrl(name: string, value: string | null | undefined): void
export function assertLocalOrDockerHostUrl(name: string, value: string | null | undefined): void
export function assertNotHostedKey(name: string, value: string | null | undefined): void
export function assertLocalTestTarget(env: Readonly<Record<string, string | undefined>>): void
