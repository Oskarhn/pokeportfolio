export const SHA_RE: RegExp
export const CONTENT_ID_RE: RegExp
export const ALLOWED_STATUS_LABELS: readonly string[]

export interface ProjectStateValidationContext {
  readonly docExists: (relPath: string) => boolean
  readonly handoverText: string | null
}

export function validateProjectState(state: unknown, ctx: ProjectStateValidationContext): string[]
