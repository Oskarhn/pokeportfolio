export function extractLinkTargets(text: string): string[]

export function classifyLinkTarget(target: string): {
  kind: 'external' | 'anchor' | 'relative'
}

export function stripFragment(target: string): string

export function findSecretShapes(text: string): string[]

export function referencesSandboxPath(text: string): boolean
