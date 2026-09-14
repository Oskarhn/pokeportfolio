/**
 * Process-level adapters for the backup tool: the repository's own pinned Supabase CLI (resolved
 * from node_modules, never a globally installed or freshly downloaded binary), git location
 * probes, and repository facts. Kept apart from backup-core.ts so the core stays unit-testable.
 */
import { execFile, spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DumpRunner, GitLocationProbe } from './backup-core'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Absolute path of the Supabase CLI's node entry point pinned by this repository's lockfile. */
export function resolvePinnedSupabaseCli(): string {
  const require = createRequire(join(REPO_ROOT, 'package.json'))
  const packageJsonPath = require.resolve('supabase/package.json')
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>
  }
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.supabase
  if (bin === undefined) throw new Error('supabase package declares no `supabase` bin entry')
  return join(dirname(packageJsonPath), bin)
}

interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Runs `node <pinned cli> ...args` without a shell, so paths with spaces (this repository lives
 * in `Pokemonapp prosjekt`) are passed as single argv entries and never re-parsed.
 */
export function runSupabaseCli(args: readonly string[], cwd = REPO_ROOT): Promise<CliResult> {
  const cli = resolvePinnedSupabaseCli()
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (error) => {
      resolvePromise({ exitCode: 127, stdout, stderr: `${stderr}\n${error.message}` })
    })
    child.on('close', (code) => {
      resolvePromise({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

export function createCliDumpRunner(cwd = REPO_ROOT): DumpRunner {
  return async (args) => {
    const result = await runSupabaseCli(args, cwd)
    return { exitCode: result.exitCode, stderr: `${result.stderr}\n${result.stdout}` }
  }
}

export async function supabaseCliVersion(): Promise<string> {
  const result = await runSupabaseCli(['--version'])
  const version = result.stdout.trim().split(/\s+/).pop() ?? ''
  if (result.exitCode !== 0 || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error('could not determine the pinned Supabase CLI version')
  }
  return version
}

function git(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], { windowsHide: true }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('git is not available — cannot prove the output location is outside git'))
        return
      }
      const code = error ? Number((error as { code?: unknown }).code ?? 1) : 0
      resolvePromise({ code: Number.isFinite(code) ? code : 1, stdout, stderr })
    })
  })
}

/** 'inside' when `dir` belongs to any git work tree; unknown git failures are treated as inside. */
export const gitLocationProbe: GitLocationProbe = async (dir) => {
  const result = await git(['-C', dir, 'rev-parse', '--is-inside-work-tree'])
  if (result.code === 0) return 'inside'
  if (/not a git repository/i.test(result.stderr)) return 'outside'
  return 'inside'
}

export async function isGitIgnored(path: string): Promise<boolean> {
  const result = await git(['-C', dirname(path), 'check-ignore', '-q', path])
  return result.code === 0
}

/** The main checkout (not a linked worktree), so the default root is shared by all worktrees. */
export async function mainCheckoutRoot(): Promise<string> {
  const result = await git([
    '-C',
    REPO_ROOT,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  if (result.code !== 0) throw new Error('cannot locate the main git checkout')
  return dirname(result.stdout.trim())
}

export function readLinkedProjectRef(): string {
  try {
    return readFileSync(join(REPO_ROOT, 'supabase', '.temp', 'project-ref'), 'utf8').trim()
  } catch {
    return ''
  }
}

export function countLocalMigrationFiles(): number {
  return readdirSync(join(REPO_ROOT, 'supabase', 'migrations')).filter((name) =>
    /^\d{14}_.+\.sql$/.test(name),
  ).length
}
