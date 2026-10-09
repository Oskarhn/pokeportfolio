import type { ExecFileSyncOptions } from 'node:child_process'

export function nativePsqlAvailable(): boolean
export function findLocalSupabaseContainer(): string | null
export function runPsql(
  dbUrl: string | undefined,
  args: readonly string[],
  options?: ExecFileSyncOptions,
): string | Buffer
