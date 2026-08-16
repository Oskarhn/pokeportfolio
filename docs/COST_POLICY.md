# Cost Policy

Canonical constraint document. Overrides convenience, and overrides any prior architectural
preference that conflicts with it.

---

## 1. Budget

**Target operating cost: $0/month.** The default posture for every recurring cost is still zero,
and that has not changed. What changed on 2026-08-17 (see [DECISIONS.md](DECISIONS.md) D-027) is
that the owner now permits a small **lifetime, total, discretionary ceiling** for the whole
project:

**Absolute lifetime spending ceiling: $50 USD.**

Read this precisely, because every word is load-bearing:

- It is a **lifetime project total**, not $50/month, not $50/year, not $50 per service.
- It is a **ceiling the owner may approve draws against**, not a budget already granted to
  Claude. See §1a.
- It exists so that a genuinely excellent, cheap, one-time option is not automatically rejected
  the way it would be under an absolute-zero rule — it does **not** mean spending is now welcome.

The working assumption for day-to-day engineering remains **$0**. Nothing in this section
authorizes spending a single cent without going through §1a first.

### 1a. The $50 is not pre-authorized

**Claude's current spending authorization is $0.** The $50 figure means only that the owner may
approve individual purchases later, one at a time, each on its own merits. Before proposing *any*
paid purchase, paid API, paid license, paid service, domain, hosting plan, dataset or other
monetary commitment, work through all of the following and present the answers to the owner:

1. What is the concrete problem?
2. Why is the current free solution inadequate — with evidence, not assertion?
3. What free alternatives exist per current official sources, and why do they not work?
4. Is there a reputable open-source, local or self-hosted alternative?
5. Is postponing the feature preferable to paying for it?
6. Can the same result be reached through more engineering effort instead of money?
7. What exactly does the paid option improve?
8. What is the **exact total cost**?
9. Can the service ever charge again after this payment (recurring, usage-based, renewal)?
10. Does it require a payment card on file?
11. Does it auto-renew?
12. What are the licensing or usage limitations?
13. Does the application keep working if the vendor disappears?
14. Ask the owner explicitly, and wait for a clear yes.

Do not purchase, enable billing on, or activate anything before that explicit approval lands.

### 1b. No spending before a free functional baseline exists

The owner wants to personally use and test a working version of the application — invite-gated
auth, adding cards, recording purchases and sales, seeing collection value where free pricing
exists, basic portfolio figures, persistence, real-device use — before a single cent is spent on
anything optional. "We will need this later" does not justify a purchase now. A mockup, a static
screenshot, a component-library demo or a passing unit-test suite does not count as that baseline.
Until it is reached, the practical answer to any paid-service question stays **no**.

### 1c. No ordinary subscriptions

Recurring subscription services are prohibited by default: monthly APIs, monthly hosting
upgrades, annual SaaS subscriptions, recurring market-data or scanner subscriptions, recurring
analytics or backup services. A $5/month service is not acceptable merely because it stays under
the $50 ceiling eventually — recurring cost is rejected on its own terms, not measured against the
ceiling.

**Narrow exception.** A very inexpensive, long-horizon, effectively one-time cost — roughly the
class of "~$10 covering several years" — may be *considered*, individually, against the same §1a
checklist, and counts against the $50 lifetime ceiling. It is not pre-approved by existing here.
If such a service has auto-renewal, auto-renewal must be disabled where possible and disclosed
before purchase regardless. One-time, perpetual and prepaid-fixed-cost options are preferred over
anything usage-metered or subscription-shaped; see §1d.

### 1d. One-time-purchase preference, not a purchase invitation

If spending is ever approved, prefer things that create durable, non-recurring value: a perpetual
software license, a one-time dataset license usable locally and legally, a permanent development
tool license, a static asset or one-time domain-like asset only with no reasonable free
alternative and explicit owner approval. Being "one-time" is necessary, never sufficient — it
still has to solve a demonstrated problem that survives the §1a checklist.

### 1e. Cost ledger

A running, minimal, durable record — no payment credentials, ever:

```text
Target operating cost:                 $0
Maximum approved project lifetime ceiling: $50 USD
Actually spent:                        $0
Explicitly approved but not yet spent: $0
Remaining ceiling:                     $50
Recurring subscriptions:               prohibited by default
Payment gate reached (§1b):            no
```

The remaining ceiling is not money available to spend — it is the maximum the owner is currently
willing to *consider*. If an item is ever approved, append a row here (or in DECISIONS.md,
cross-linked) recording: date, item/service, amount, currency and approximate USD equivalent,
whether one-time or recurring, the owner-approval reference, purpose, and the resulting remaining
ceiling.

## 2. Authorization

No paid service, paid tier, or billing-enabled feature may be introduced without the owner's
explicit approval, obtained first, per §1a.

Also prohibited without explicit approval:

- Entering payment card details anywhere
- Enabling billing on any account
- Upgrading any plan
- Attaching a billing profile because a platform prompts for one
- Enabling a feature whose usage can produce charges
- Treating a free trial as production infrastructure

A free trial is not a free tier. A trial may only be used if a genuinely sustainable free path
exists after it ends.

## 3. Selection order

1. Capability our existing stack already provides for free
2. Free, open-source, or local solution
3. Sustainable free tier with no card requirement
4. Self-hosted, if operationally reasonable at this scale
5. Paid — only after explicit approval

## 4. Quality is not traded away for cost

Precedence when they conflict:

**Correct → Secure → Legal/permitted → Maintainable → Free → Convenient**

Zero cost never justifies: unreliable or sketchy providers, Terms of Service violations,
prohibited scraping, weakened security, exposed user data, abandoned dependencies, or skipping
backups entirely.

If correctness, security or legality genuinely cannot be achieved for free, **stop and explain
the trade-off.** Do not silently take the unsafe path.

## 5. Regression rule

Before adding any external dependency or service, answer: *does this introduce cost now, or a
realistic possibility of automatic billing?*

If yes: research free alternatives, document the trade-off, and ask the owner.

Specifically **not** to be introduced casually because they are common SaaS defaults: Sentry,
PostHog, Resend, paid object storage, a paid scanner API, PriceCharting, Scrydex or any other
commercial TCG API, paid monitoring, a paid domain, a paid database, or paid AI inference.

---

## 6. Service cost matrix

All entries verified **2026-08-16** against official documentation unless noted.

### GitHub — source control

| | |
|---|---|
| Purpose | Repository, issues, Actions CI |
| Free allowance | Unlimited private repos. **2 000 Actions minutes/month** and 500 MB package storage on private repos. |
| Card required | No |
| Overage behaviour | Default spending limit on a Free account is **$0** — Actions jobs simply stop. No bill without explicitly raising the limit. |
| Accidental-charge risk | **None** while the spending limit stays at $0. Never raise it. |
| Expected usage | CI on push and pull request. A typical run is 2–4 minutes; at even 100 runs/month that is ~400 minutes, 20% of the allowance. |
| Headroom | Large |
| Fallback | Run `pnpm check` locally; CI is convenience, not a dependency |
| Reconsider when | Actions usage exceeds ~1 500 min/month |
| Source | https://docs.github.com/en/billing/managing-billing-for-github-actions |

> Note: Actions minutes are consumed only by **private** repositories. Public repositories get
> unlimited free minutes. This is not a reason to make the repository public.

### Cloudflare Pages — frontend hosting

| | |
|---|---|
| Purpose | Static SPA hosting |
| Free allowance | **Unlimited bandwidth and requests.** 500 builds/month, 20 000 files per deployment, 20-minute build timeout. |
| Card required | No |
| Overage behaviour | Build limit stops further builds until the next month. Bandwidth is genuinely unlimited. |
| Accidental-charge risk | **None** for static hosting. Risk exists only if Workers/KV/R2/D1 are added — so they are not. |
| Expected usage | A handful of builds per week |
| Headroom | Very large |
| Fallback | GitHub Pages (also free, private repo Pages requires GitHub Pro — so Netlify or Vercel Hobby would be the actual fallback) |
| Reconsider when | Never, at this scale |
| Source | https://developers.cloudflare.com/pages/platform/limits |

**Decision:** Pages only. Cloudflare Workers, KV, R2 and D1 are **not** adopted. The backend
already lives in Supabase; adding Workers would introduce a second billable surface for no gain.

### Supabase — database, auth, functions, scheduling

| | |
|---|---|
| Purpose | PostgreSQL with RLS, authentication, Edge Functions, `pg_cron` |
| Free allowance | 500 MB database, 1 GB file storage, 5 GB egress, 50 000 MAU, 500 000 Edge Function invocations, 2 active projects, `pg_cron` on all plans |
| Card required | No |
| Overage behaviour | Free projects are **restricted**, not billed. Exceeding a quota limits the project until usage falls or the plan is upgraded. |
| Accidental-charge risk | **None** while no card is attached and no upgrade is performed |
| Inactivity | Project pauses after ~7 days without database activity. Manual resume. Restorable within 90 days. |
| Backups | **None on Free.** Manual `supabase db dump` is the documented recommendation. |
| Expected usage | ~105 MB/year of price snapshots (held variants only, one row per variant per day regardless of how many copies are owned), well under 500 MB with 12-month thinning. Holdings and lots add ~2 MB per 10 000 lots. 1–10 users against 50 000 MAU. |
| Headroom | Database is the binding constraint, not users |
| Fallback | Plain PostgreSQL elsewhere — the schema is standard SQL in versioned migrations |
| Reconsider when | Database exceeds ~350 MB, or free-plan terms change materially |
| Source | https://supabase.com/docs/guides/platform/billing-on-supabase · [pausing](https://supabase.com/docs/guides/platform/free-project-pausing) · [backups](https://supabase.com/docs/guides/platform/backups) |

Legitimate daily price ingestion keeps the project active as a side effect of work the app
genuinely needs. This is not a contrived heartbeat, and the app must still behave sanely against
a paused project.

### Supabase Auth email — **the one real cost risk**

| | |
|---|---|
| Purpose | Delivering login codes |
| Free allowance | Built-in email provider: **2 emails per hour, project-wide.** Not per user. |
| Card required | No |
| Overage behaviour | Requests beyond the limit fail with a 429 |
| Accidental-charge risk | None — but the **functional** risk is severe |
| Expected usage | One email per login. Sessions persist, so a single user might log in monthly. Onboarding two friends in one sitting already exceeds the limit. |
| Verdict | **Not sufficient for login.** Supabase's own documentation describes the built-in provider as unsuitable for production and subject to change without notice. |
| Source | https://supabase.com/docs/guides/auth/rate-limits · https://supabase.com/docs/guides/auth/auth-smtp |

**Resolved: email and password.** Normal login sends no email at all, so the constraint no longer
touches the critical path. The options that were evaluated, all verified 2026-08-16:

| Option | Free allowance | Domain needed? | Card? | Outcome |
|---|---|---|---|---|
| **Password auth** | n/a — sends nothing | n/a | n/a | **Selected.** Removes the dependency rather than working around it. |
| SMTP2GO | 1 000/month, 200/day, 25/hour without a verified domain; 5 verified single-sender addresses | **No** | No | Viable, but adds an account and a deliverability dependency to every login |
| Brevo | 300/day | Sender verification available | No | Same objection |
| Mailjet | 6 000/month, 200/day | Sender verification available | No | Same objection |
| Resend | 3 000/month | **Yes — one domain** | No | Rejected: a domain is a purchase, so it fails the zero-cost test outright |

Resend is a useful illustration of why "the service has a free tier" is not the whole question —
its prerequisite costs money even though its plan does not.

**Password reset** remains an email path, but it is rare: a handful of events per year against a
limit of two per hour. It uses the built-in provider, with an admin-assisted recovery path as the
documented fallback. **Transition trigger:** if reset volume ever approaches the limit, add
SMTP2GO's free tier at that point. It is not needed today and is not adopted speculatively.

### TCGdex — catalog, images, raw prices

| | |
|---|---|
| Free allowance | Unlimited in practice. No API key. No published hard rate limits. |
| Card required | No |
| Accidental-charge risk | None |
| Expected usage | One daily batch over held variants |
| Fallback | Our own accumulated `price_snapshots` survive independently; manual valuation covers the gap |
| Reconsider when | Rate limiting appears, or the service becomes unreliable |
| Source | https://tcgdex.dev/faq |

### Norges Bank — FX rates

| | |
|---|---|
| Free allowance | Open public data, no key, no limits published |
| Card required | No |
| Accidental-charge risk | None |
| Expected usage | One call per day for three currency pairs |
| Fallback | The European Central Bank publishes a comparable free feed |
| Source | https://www.norges-bank.no/en/topics/statistics/open-data/guide-data-warehouse/ |

### Cardmarket / TCGplayer / PriceCharting / Scrydex / PSA

| | |
|---|---|
| Status | **Not used.** Cardmarket and TCGplayer APIs are closed to new applicants; PriceCharting (~$59/year), Scrydex (~$29/month) and PSA's paid API are **not approved.** |
| Consequence | Sealed and graded valuation is manual. This is an honest limitation, not a degraded workaround. |
| Reconsider | Only if the owner explicitly authorises spending |

### Scanner infrastructure — future

| | |
|---|---|
| Target | Browser-local inference. Open-source models, static index artefact served from Pages. |
| Recurring cost | **Zero by design.** No per-image API. |
| One-time cost | Engineering effort and a model/index download for the user |
| Accidental-charge risk | None, provided no hosted vision API is introduced |
| Reconsider | Only if local inference proves impractical, with documented evidence, and then only after asking |

### Backups

| | |
|---|---|
| Provider backups | **None on Supabase Free** |
| Free approach | `supabase db dump` before every migration and after significant data entry, stored off-machine. In-app JSON export in V1. |
| Cost | Zero |
| Risk | Depends on discipline rather than automation. Documented plainly; the product never implies backups are automatic. |

---

## 7. Zero-cost audit — conclusions

| Question | Answer |
|---|---|
| Does any MVP feature depend on a paid service? | **No** — with the auth email question resolved to SMTP2GO or password auth |
| Can it run indefinitely at expected usage for 0 NOK? | **Yes**, under current terms |
| Any service with automatic overage billing? | **None.** GitHub stops at a $0 limit; Supabase restricts; Cloudflare Pages is unlimited on bandwidth |
| Any card required anywhere? | **No** |
| Is auth email sustainably free for 5–10 people? | **Yes** — password auth sends no login email. Password reset is rare and fits the built-in provider, with an admin fallback. |
| Does all-card tracking break the free tier? | **No.** Price history is keyed per variant, not per copy, so snapshot volume is decoupled from collection size. 10 000 lots is ~2 MB of holdings data. |
| What if TCGdex disappears? | Our snapshots survive; internal UUID identity is canonical; manual valuation continues. Painful, not fatal. |
| What if Supabase Free changes? | Schema is standard PostgreSQL in versioned migrations; `pg_dump` export exists. Days of migration work, not a rewrite. |
| What if Cloudflare changes? | Static assets deploy anywhere. |
| Are we storing too much price history? | No — held variants only, ~105 MB/year, thinned after 12 months |
| Will images breach free storage? | No — catalog artwork is hotlinked from the provider, never copied. User photos are V1 and capped. |
| Is a paid domain assumed anywhere? | **No.** Deployment uses the free `*.pages.dev` subdomain. This is why Resend was excluded. |
| Will GitHub Actions cost anything? | No — 2 000 free minutes, $0 spending limit |
| Does scanner inference need paid compute? | No — browser-local by design |

## 8. Reopening a cost decision

A paid service may be reconsidered only when all of the following hold, and the owner then
approves explicitly:

1. The capability is genuinely needed, not merely convenient.
2. No free alternative reaches acceptable quality — with evidence, not assertion.
3. Postponing the feature has been considered and rejected for a stated reason.
4. The cost, billing model and cancellation path are documented.
5. An exit plan exists if the service is later dropped.

**Default answer when a feature cannot be built well for free: postpone the feature.**
