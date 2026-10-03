# Production erasure registry (P195)

`STATUS=DEPLOYED_EMPTY · TEST_NAMESPACE_EXERCISED` · decision [D-195](../DECISIONS.md) · contract
[`scripts/restore-gate/registry-sink.ts`](../../scripts/restore-gate/registry-sink.ts) · restore side
[RESTORE_RUNBOOK.md](RESTORE_RUNBOOK.md) · data scope [P189_DELETION_DATA_MAP.md](P189_DELETION_DATA_MAP.md)

The registry is the one record that must survive a database restore: a backup cannot know that an
account was deleted after it was taken. P189 built the registry format, the gate and the function
side and deliberately left the **storage** open. P195 closes it.

## 1. Decision

A Cloudflare **Worker** in front of one SQLite-backed **Durable Object**, on the **Workers Free**
plan. Cost: **$0** (no card-bearing product enabled; see §6 for what happens at the limits).

| Requirement | How it is met |
|---|---|
| Outside the Supabase backup domain | Different provider, different account, different credentials. A Supabase restore cannot touch it. |
| Durable | Durable Object SQLite storage (replicated, transactional); PITR for 30 days exists inside the object (not wired — §5). |
| Append-only | The Worker has no update/delete route; the table carries `BEFORE UPDATE/DELETE … RAISE(ABORT)` triggers; one Durable Object serialises every append. |
| Integrity | The P189 format: contiguous `seq`, hash chain `prev`, HMAC-SHA256 `mac` under a key held only by the registry. Verified on every append (head), every export (whole chain) and again offline by the restore gate. |
| HTTPS | `*.workers.dev` only; the function client refuses non-https URLs (local loopback names excepted). |
| Separate credential | Three secrets, all different: **append token** (the Edge Function), **operator token** (read/export), **HMAC key** (never leaves the Worker and the operator). |
| No personal data | A record is `deletion_id` (random UUID), `subject` (SHA-256 of a namespaced random account UUID), `deleted_at`, chain fields. No e-mail, name, finance data. |
| Compatible with the P189 gate | `GET /v1/export` is byte-for-byte the registry file format; `restore-gate` and `restore-drill` read it unchanged (§4). |

## 2. Cloudflare primitives, evaluated against the P189 requirements

| | Durable Object (SQLite) | D1 | R2 | KV |
|---|---|---|---|---|
| Strong consistency | **Yes**, single instance, transactional | Yes (single primary) | Yes per object | **No** — eventually consistent, cached at the edge |
| Serialised append | **Yes**, by construction (one writer; our append is synchronous inside `transactionSync`) | Needs a Worker-side transaction; no row-level guard beyond SQL | No append primitive (whole-object PUT) | No |
| Conditional / unique writes | SQL `UNIQUE` on `deletion_id` and `subject`, explicit `seq` | SQL `UNIQUE` | `If-Match` on whole objects only | `put` is last-writer-wins |
| Tamper resistance | Triggers abort UPDATE/DELETE; no mutation route; HMAC chain | Same triggers possible; **a dashboard user can run arbitrary SQL** | Object lock is a paid/conditional feature | None |
| Durability / recovery | Replicated; 30-day PITR API (inside the object) | Time Travel 30 days | Durable, versioning optional | Durable but eventually consistent |
| Cost on the free plan | $0 within 100,000 rows written / 5 M read per day, 5 GB total; **over a limit operations fail, they are not billed** | $0 within comparable limits | **Needs a payment method on file** to enable | $0 but unsuitable |
| Operator access | Only through our Worker (`/v1/head`, `/v1/export`) — no dashboard SQL console on a DO | Dashboard SQL console (can edit rows) | Dashboard | Dashboard |
| Replay into the restore gate | Export route emits the file format directly | Needs a custom export | Needs a custom export | Not applicable |

Rejected: **KV** (eventual consistency can acknowledge a record a later read does not see — the one
property a ledger cannot lack); **R2** (no append, and enabling it needs a payment method, which the
cost policy forbids as a default); **D1** (workable, but a dashboard SQL console lets any account
user rewrite rows, and it needs the same Worker around it anyway). A **second Supabase project** was
not chosen: it would be the same provider and the same operator surface as the database it protects.

## 3. Components and endpoints

Source: `scripts/erasure-registry-worker/` — `ledger.ts` (storage-side core, node:crypto only),
`worker.ts` (Worker + Durable Object class), `wrangler.jsonc`, `smoke.ts` (synthetic test).

| Route | Credential | Answer |
|---|---|---|
| `POST /v1/erasures` | append token | `201 recorded` (new) / `200 recorded` (idempotent repeat; same subject under another id returns the existing record) / `409` (id reused for another subject) / `400` / `413` (> 2 KiB) |
| `GET /v1/head` | operator token | `{"seq","mac","records"}` |
| `GET /v1/export` | operator token | the full chain, NDJSON, newline-terminated, fully re-verified first (`500` if the stored chain fails its own check) |
| anything else, or no/unknown token | — | `401` (any request without a valid token) or `404`; the append token on an operator route is `403` |

There is no listing, no update and no delete route and **no route the Supabase function can use to
read**. The Worker answers `503 not_configured` if the key is missing or short, a token is under 24
characters, or the two tokens are equal. Nothing is cached (`Cache-Control: no-store`).

Deployments (account `Oskarhn06@outlook.com`, subdomain `oskarhn06`):

| Namespace | Worker | URL | Purpose |
|---|---|---|---|
| **production** | `pokeportfolio-erasure-registry` | `https://pokeportfolio-erasure-registry.oskarhn06.workers.dev` | the real ledger — deployed, **empty (seq 0)**, never written by a test |
| **test** | `pokeportfolio-erasure-registry-test` | `https://pokeportfolio-erasure-registry-test.oskarhn06.workers.dev` | separate Worker, Durable Object storage and secrets; only synthetic subjects |

The production ledger has no cleanup path by design, so **tests only ever use the `-test` Worker**
(`smoke.ts` refuses the production URL).

## 4. Operations

**Secrets.** Worker secrets (`wrangler secret put`): `ERASURE_REGISTRY_KEY` (≥ 64 hex), `ERASURE_APPEND_TOKEN`,
`ERASURE_OPERATOR_TOKEN`. Supabase Edge Function secrets (`supabase secrets set`, project `pokeportfolio-dev`):
`ERASURE_REGISTRY_URL` and `ERASURE_REGISTRY_TOKEN` (= the append token) — **nothing else**; the function never
holds the key or the operator token. P195 generated both sets into a private directory outside every checkout
(`%USERPROFILE%\.pokeportfolio-p195\`, files `registry-prod.env`, `registry-test.env`). **Owner action: move the
production values into a password manager, then delete the files.** The HMAC key is also needed offline by
whoever runs a restore; losing it makes every export unverifiable (§7).

**Export (the independent backup).**

```bash
ERASURE_REGISTRY_KEY=… ERASURE_OPERATOR_TOKEN=… \
  pnpm exec tsx scripts/restore-gate/registry-export.ts \
  --url https://pokeportfolio-erasure-registry.oskarhn06.workers.dev --out <file outside the repo>
```

Downloads, verifies the whole chain with the operator's own copy of the key, writes atomically (mode 600),
and **refuses to replace a file whose head is newer** than the download. Exit 2 on any refusal. Recommended
cadence: after every real deletion and before every restore; there is **no scheduled job** (no free scheduler
the operator already owns; a GitHub Actions schedule would put the operator token into repository secrets).
Keep copies off the machine, like the database backups.

**Restore.** Hand the export to `restore-gate` / `scripts/p137/restore-drill.ts --erasure-registry <file>` exactly as
in the runbook. A corrupt, torn, reordered or wrongly keyed export is refused (exit 2) — measured in P195.

**Rotating the append token** (e.g. after a suspected leak): `wrangler secret put ERASURE_APPEND_TOKEN`, then
`supabase secrets set ERASURE_REGISTRY_TOKEN=…`. In between, deletions are refused and left retryable (measured).
The operator token rotates the same way. The **HMAC key cannot be rotated** without re-signing the chain; no tool
for that exists (BACKLOG).

## 5. What was measured (P195)

Unit/integration (`tests/ops/erasure-registry-worker.test.ts`, 16 tests, node:sqlite standing in for the object):
append, idempotency both ways, conflict, 25 concurrent appends → gap-free chain, minimal record, malformed /
oversize / wrong scope, the real Edge Function client against the Worker, auth on every route and method, role
separation, no listing/update/delete route, misconfiguration → 503, SQL triggers, export accepted by the
canonical parser and rejected under another key, tamper behind the triggers → export and append both fail
closed, a record removed from the middle detected, `registry-export` atomic write / corrupt / torn / older-than-
existing / http / unreachable / wrong-token.

Real workerd (local) and the real deployed **test** Worker: append A, repeat A, append B, conflict, head, append
token refused on operator routes, no-token refusal, export verified by the canonical parser, export file read by
`restore-gate`, corrupt/torn/dropped-first/wrong-key exports all refused (exit 2). The production Worker was only
read (head seq 0, no-token 401, append-token-on-head 403).

Not wired: the Durable Object's own point-in-time recovery (30 days) — available as a last-resort recovery primitive
through a future operator route; the export is the supported backup.

## 6. Cost and limits

Workers Free (docs checked 2026-10-03): SQLite-backed Durable Objects only; 100,000 rows written/day, 5 M rows read/day,
5 GB total; a request over a limit **fails** (no overage billing on the free plan). Each append writes a handful of
rows, so the free budget is orders of magnitude above the product's deletion rate. If a limit were ever reached the
effect is `deletion_incomplete` / retryable — fail closed, never a deletion without a receipt. Nothing was upgraded;
no payment method was added. Ledger: [COST_POLICY.md](../COST_POLICY.md).

## 7. Retention policy and residual risk

**Retention.** A record may not be removed while any backup able to resurrect that account remains restorable.
Provider backups: the project is on the **free plan — no scheduled backups, no PITR** (dashboard, read 2026-10-03), so
the only restorable images are the operator's own `pnpm db:backup` directories, whose age the owner controls.
Nothing here defines a legal retention period; the registry therefore **keeps every record indefinitely** until the
owner decides a policy against the oldest backup he keeps. There is no delete path to implement one.

**Residual risks (honest).**

- The HMAC protects against anyone **without the key**. A compromise of the Cloudflare account can redeploy the Worker
  and read its secrets: use 2FA on the account; keep verified exports off-platform (an export made before a
  compromise is the evidence).
- Truncation of the chain's tail is invisible in the registry alone; the database witness (`account_erasure_receipts`)
  and `--expect-head-seq` are the defence, as in P189.
- The registry is a single provider/account; the independent export is manual until the owner schedules it.
- The deleted-account list reveals how many accounts were erased and when (never who).
