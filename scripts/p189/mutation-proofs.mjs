#!/usr/bin/env node
/**
 * P189 mutation proofs: each mutant breaks ONE safety property of restore-safe account deletion, one
 * at a time, and the named suite must then FAIL on a real assertion (a build error does not count).
 * The tree is restored with `git checkout` after every mutant and the database function it touched is
 * re-created from the committed migration, so a failed run cannot leave a mutated state behind.
 *
 *   node scripts/p189/mutation-proofs.mjs [--only M03]      (needs the local stack env, see TESTING.md §6f)
 *
 * Output: one line per mutant, `KILLED` (the suite failed on assertions, as required), `SURVIVED`
 * (the suite stayed green: the property is not actually tested) or `ERROR` (the mutation did not
 * apply or the suite could not run). Exit 1 unless every mutant was killed.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const container = process.env.P156_DB_CONTAINER
const migration = 'supabase/migrations/20261002130000_p189_restore_safe_erasure.sql'

/** Re-creates one function from the COMMITTED migration text (git show), so mutants never leak. */
function sqlFunctionFromGit(name) {
  const text = execFileSync('git', ['show', `HEAD:${migration}`], { encoding: 'utf8' })
  return extractFunction(text, name)
}
function extractFunction(text, name) {
  const start = text.indexOf(`create or replace function public.${name}(`)
  if (start < 0) throw new Error(`function ${name} not found`)
  const end = text.indexOf('\n$$;', start)
  return text.slice(start, end + 4)
}
function runSql(sql) {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    {
      input: sql,
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  )
}

const OPS = ['pnpm', 'exec', 'vitest', 'run']
const DB = ['pnpm', 'test:db']
const NATIVE = {
  cwd: 'apps/mobile-spike',
  cmd: [
    'npx',
    'jest',
    '--selectProjects',
    'unit',
    '--runTestsByPath',
    'tests/unit/account-deletion.test.tsx',
  ],
}

/** kind 'file': text patch of a tracked file. kind 'sql': patch the migration text, apply that function
 *  to the database, restore it afterwards. */
const MUTANTS = [
  {
    id: 'M01',
    what: 'restore proceeds without a registry (an unreadable registry is treated as empty and allowed)',
    kind: 'file',
    file: 'scripts/restore-gate/restore-gate.ts',
    find: `  const key = parseRegistryKey(process.env[args.keyEnv])
  return readRegistryFile(args.registry, key)
}`,
    replace: `  try {
    const key = parseRegistryKey(process.env[args.keyEnv])
    return readRegistryFile(args.registry, key)
  } catch {
    args.allowEmpty = true
    return { records: [], head: { seq: 0, mac: '0'.repeat(64), records: 0 } }
  }
}`,
    run: [...DB, 'tests/db/p189_restore_safe_erasure.test.ts', '-t', 'MISSING registry'],
  },
  {
    id: 'M02',
    what: 'registry integrity verification skipped (MAC never checked)',
    kind: 'file',
    file: 'scripts/restore-gate/erasure-registry.ts',
    find: '    if (!constantTimeEqualHex(mac, macOf(key, rest))) {',
    replace: '    if (false && !constantTimeEqualHex(mac, macOf(key, rest))) {',
    run: [...OPS, 'tests/ops/erasure-registry.test.ts'],
  },
  {
    id: 'M03',
    what: 'a deleted user is omitted from the replay (only the first registry entry is replayed)',
    kind: 'sql',
    fn: 'restore_gate_apply',
    find: "     order by (e ->> 'seq')::bigint\n  loop",
    replace: "     order by (e ->> 'seq')::bigint limit 1\n  loop",
    run: [...DB, 'tests/db/p189_restore_safe_erasure.test.ts', '-t', 'R1 / R4 / R8'],
  },
  {
    id: 'M04',
    what: 'the replay deletes the WRONG user (every account except the registered one)',
    kind: 'sql',
    fn: 'restore_gate_apply',
    find: 'where public.erasure_subject_hash(u.id) = v_entry.subject',
    replace: 'where public.erasure_subject_hash(u.id) <> v_entry.subject',
    run: [...DB, 'tests/db/p189_restore_safe_erasure.test.ts', '-t', 'R1 / R4 / R8'],
  },
  {
    id: 'M05',
    what: 'a second replay corrupts data (it wipes a table when nothing is left to replay)',
    kind: 'sql',
    fn: 'restore_gate_apply',
    find: "  return jsonb_build_object('replayed_accounts', v_replayed, 'dry_run', p_dry_run);",
    replace:
      "  if v_replayed = 0 and not p_dry_run then delete from public.retailers; end if;\n  return jsonb_build_object('replayed_accounts', v_replayed, 'dry_run', p_dry_run);",
    run: [...DB, 'tests/db/p189_restore_safe_erasure.test.ts', '-t', 'R3'],
  },
  {
    id: 'M06',
    what: 'a LIVE user is deleted by the replay (the subject filter is dropped)',
    kind: 'sql',
    fn: 'restore_gate_apply',
    find: 'where public.erasure_subject_hash(u.id) = v_entry.subject loop',
    replace: 'where true loop',
    run: [...DB, 'tests/db/p189_restore_safe_erasure.test.ts', '-t', 'R1 / R4 / R8'],
  },
  {
    id: 'M07',
    what: 'the external record is written AFTER the success is reported (fire-and-forget append, failure swallowed)',
    kind: 'file',
    file: 'supabase/functions/_shared/account-deletion.ts',
    find: '        const receipt = await deps.appendToRegistry({',
    replace:
      '        const receipt = await Promise.resolve({ seq: 1, deletionId: prepared.deletionId })\n        void deps.appendToRegistry({',
    run: [...OPS, 'tests/ops/account-deletion-core.test.ts'],
  },
  {
    id: 'M08',
    what: 'account A can delete account B (the intent check is removed)',
    kind: 'file',
    file: 'supabase/functions/_shared/account-deletion.ts',
    find: '  if (parsed.expectedUserId !== user.id.toLowerCase()) {',
    replace: '  if (false) {',
    run: [...OPS, 'tests/ops/account-deletion-core.test.ts'],
  },
  {
    id: 'M09',
    what: 'the deletion endpoint accepts an anonymous caller (the bearer requirement is removed)',
    kind: 'file',
    file: 'supabase/functions/_shared/account-deletion.ts',
    find: "  if (!request.bearerToken) return respond(401, { error: 'unauthenticated' })",
    replace: '',
    run: [...OPS, 'tests/ops/account-deletion-core.test.ts'],
  },
  {
    id: 'M10',
    what: 'a stale or pending session can still write (the write barrier is removed)',
    kind: 'sql-raw',
    // Every guarded table, as in the P156 barrier migration. (The older INSERT-only guard would still
    // refuse an INSERT, which is why the UPDATE/DELETE/RPC barrier suite is the one that must notice.)
    sql: `do $$ declare t text; begin
  for t in select c.relname from pg_trigger g join pg_class c on c.oid = g.tgrelid
            where g.tgname = 'account_deletion_barrier' loop
    execute format('drop trigger account_deletion_barrier on public.%I', t);
  end loop; end $$;`,
    restore: `do $$ declare t text; begin
  foreach t in array array['retailers','storage_locations','tags','purchases','purchase_lines','holdings',
    'acquisition_lots','manual_card_definitions','holding_tags','manual_valuations','custom_collections',
    'custom_collection_members','sales','sale_lines','lot_disposals','lot_cost_adjustments','openings',
    'sealed_products','profiles','portfolio_snapshots','portfolio_recompute_queue','invitations'] loop
    execute format('create trigger account_deletion_barrier before insert or update or delete on public.%I for each statement execute function public.account_deletion_caller_guard()', t);
  end loop; end $$;`,
    run: [...DB, 'tests/db/p156_pending_write_barrier.test.ts'],
  },
  {
    id: 'M11',
    what: 'a native pending mutation survives deletion (the journal is not cleared)',
    kind: 'file',
    file: 'apps/mobile-spike/src/account/account-deletion-controller.ts',
    find: '    if (intent !== null) await this.journal.clearForUser(intent).catch(() => undefined)',
    replace: '',
    run: NATIVE,
  },
  {
    id: 'M12',
    what: 'raw backend error text is shown to the person (native)',
    kind: 'file',
    file: 'apps/mobile-spike/src/account/account-deletion-controller.ts',
    find: '  return UNKNOWN\n}\n\nexport class',
    replace: '  return (error as Error).message\n}\n\nexport class',
    run: NATIVE,
  },
  {
    id: 'M13',
    what: 'the public deletion page claims an unverified retention period',
    kind: 'file',
    file: 'src/features/legal/AccountDeletionPage.tsx',
    find: 'This is a one-person project;',
    replace: 'Your backups are erased within 30 days. This is a one-person project;',
    run: [...OPS, 'tests/ui/account-deletion-copy.test.ts'],
  },
  {
    id: 'M14',
    what: 'the account is deleted but the native session stays valid (sign-out skipped)',
    kind: 'file',
    file: 'apps/mobile-spike/src/account/account-deletion-controller.ts',
    find: '    if (lease.isCurrent()) await this.auth.signOut()',
    replace: '',
    run: NATIVE,
  },
  {
    id: 'M15',
    what: 'a restored image is promoted before postcheck (promote-check ignores the stamp)',
    kind: 'file',
    file: 'scripts/restore-gate/gate.ts',
    find: "  if (last === null || last.status !== 'passed') {",
    replace: '  if (false) {',
    run: [...DB, 'tests/db/p189_restore_safe_erasure.test.ts', '-t', 'postcheck stamps'],
  },
]

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null
let survived = 0
for (const m of MUTANTS) {
  if (only && m.id !== only) continue
  let verdict = 'ERROR'
  let detail = ''
  try {
    if (m.kind === 'file') {
      const text = readFileSync(m.file, 'utf8')
      if (!text.includes(m.find)) throw new Error('mutation did not apply (find text missing)')
      writeFileSync(m.file, text.replace(m.find, m.replace))
    } else if (m.kind === 'sql') {
      const original = sqlFunctionFromGit(m.fn)
      if (!original.includes(m.find)) throw new Error('mutation did not apply (find text missing)')
      runSql(original.replace(m.find, m.replace))
    } else {
      runSql(m.sql)
    }
    const [cmd, ...args] = m.run.cmd ?? m.run
    const r = spawnSync(cmd, args, {
      cwd: m.run.cwd ?? process.cwd(),
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    })
    const out = `${r.stdout}${r.stderr}`
    const assertionFailure =
      /AssertionError|expected .* to|Expected|expect\(/i.test(out) && /(×|✕|FAIL|failed)/.test(out)
    if (r.status !== 0 && assertionFailure) {
      verdict = 'KILLED'
      detail = (out.match(/(\d+) failed/) ?? [])[0] ?? ''
    } else if (r.status === 0) {
      verdict = 'SURVIVED'
      survived += 1
    } else detail = 'suite failed without an assertion failure (not a kill)'
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e)
  } finally {
    try {
      if (m.kind === 'file') execFileSync('git', ['checkout', '--', m.file])
      else if (m.kind === 'sql') runSql(sqlFunctionFromGit(m.fn))
      else runSql(m.restore)
    } catch (e) {
      console.error(`RESTORE FAILED for ${m.id}: ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 2
    }
  }
  console.log(`${m.id} ${verdict}  ${m.what}${detail ? `  [${detail}]` : ''}`)
  if (verdict !== 'KILLED') process.exitCode = process.exitCode || 1
}
if (survived > 0) console.log(`${String(survived)} mutant(s) SURVIVED`)
