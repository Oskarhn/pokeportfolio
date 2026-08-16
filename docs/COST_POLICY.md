# Cost Policy

Canonical constraint document. Overrides convenience, and overrides any prior architectural
preference that conflicts with it.

---

## 1. Budget

**0 NOK/month.** Not "cheap". Not "$5 is fine". Zero.

There is no authorization to incur cost of any kind: subscriptions, one-time purchases,
usage-based charges, domains, paid tiers, paid add-ons, or anything that begins billing
automatically after a quota.

A future decision may allow a small budget. **Never assume it has been made.**

## 2. Authorization

No paid service, paid tier, or billing-enabled feature may be introduced without the owner's
explicit approval, obtained first.

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
| Expected usage | ~105 MB/year of price snapshots (held variants only), well under 500 MB with 12-month thinning. 1–10 users against 50 000 MAU. |
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
| Verdict | **Not sufficient for production use.** Supabase's own documentation describes the built-in provider as unsuitable for production and subject to change without notice. |
| Source | https://supabase.com/docs/guides/auth/rate-limits · https://supabase.com/docs/guides/auth/auth-smtp |

This is documented as a decision point rather than resolved unilaterally — it changes login UX.
Free options, all verified 2026-08-16:

| Option | Free allowance | Domain needed? | Card? | Notes |
|---|---|---|---|---|
| **SMTP2GO** | 1 000/month, 200/day, 25/hour without a verified domain; **5 verified single-sender addresses** | **No** — a plain email address can be verified | No | The only option confirmed to work without owning a domain |
| Brevo | 300/day | Sender verification available | No | Larger allowance; domain improves deliverability |
| Mailjet | 6 000/month, 200/day | Sender verification available | No | |
| Resend | 3 000/month | **Yes — one domain** | No | A domain is a purchase, so this fails the zero-cost test |
| Password auth instead | n/a | n/a | n/a | Sends no email at all. Removes the dependency entirely. |

`SMTP2GO` and `password auth` are the two viable zero-cost paths. Resend is excluded precisely
because a domain costs money — a good illustration of why "the service is free" is not the whole
question.

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
| Is auth email sustainably free for 5–10 people? | Not with Supabase's built-in provider. Yes with SMTP2GO's free tier, or trivially with password auth |
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
