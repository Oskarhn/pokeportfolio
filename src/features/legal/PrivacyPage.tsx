import { useDocumentMeta } from '../../ui/useDocumentMeta'
import { LegalLayout } from './LegalLayout'

/**
 * Written from a real data-flow inventory of this codebase (P101), not a template — every claim
 * below traces to a specific file or doc: `src/data/supabase-client.ts` (auth/session storage),
 * `src/ui/theme.ts` (the one other localStorage key), `docs/ARCHITECTURE.md` §"Scanner" (captured
 * image bytes never cross the network — enforced by a static audit test), `docs/API_SOURCES.md`
 * (TCGdex/Cardmarket/TCGplayer/Norges Bank), `docs/SECURITY.md` §7/§8 (RLS boundary, reset).
 * No company name, postal address or DPO — there isn't one; see the Contact section.
 */
export function PrivacyPage() {
  useDocumentMeta({
    title: 'Privacy',
    description:
      'What PokePortfolio stores, where it goes, and what stays on your device — a private, invite-only Pokémon TCG portfolio tracker.',
    robots: 'index, follow',
    canonicalPath: '/privacy',
  })

  return (
    <LegalLayout title="Privacy" updated="2026-09-04">
      <p>
        PokePortfolio is a private, invite-only tool built and operated by one person, for a small
        group of invited people. This page describes exactly what the application does with your
        data — nothing more, since nothing more exists to describe.
      </p>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">What is stored, and where</h2>
        <p>
          Your account (email, and an invitation-based sign-up) and everything you enter — your
          collection, purchases, sales, sealed-product openings, storage locations, tags, custom
          collections and manual valuations — are stored in a Postgres database on Supabase (hosted
          in the EU, Paris). Row-level security scopes every table to your own account: another
          invited person's session cannot read or write your rows, and this is enforced by the
          database itself, not just by the app's screens.
        </p>
        <p>
          Your display preferences (theme, default view, capture defaults) live in that same
          per-account row. There is no separate marketing or CRM database, and no third party ever
          receives a copy of your collection or financial data.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">The scanner</h2>
        <p>
          If you use the card scanner, every photo/frame is processed entirely on your own device in
          the browser — card and text recognition both run locally (WebAssembly/WebGPU). The
          captured image bytes never cross the network; nothing is uploaded to a server, and nothing
          is stored after the session ends. The scanner identifies a candidate match and shows it to
          you for review — it never adds anything to your Portfolio without your confirmation.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">Card artwork and market data</h2>
        <p>
          Card images are loaded directly from TCGdex's image CDN when a page displays them —
          PokePortfolio does not host or redistribute card artwork. Market price data comes from
          Cardmarket and TCGplayer (relayed through TCGdex), and currency conversion uses exchange
          rates published by Norges Bank. These are read-only reference lookups; they do not receive
          any information about you or your collection.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">What's on your device</h2>
        <p>
          Two things are stored locally in your browser, and nothing else: your signed-in session
          (so you don't have to sign in on every visit) and your theme preference. Neither is used
          for tracking, and neither is shared with anyone. See{' '}
          <a href="#analytics" className="underline underline-offset-2">
            Analytics
          </a>{' '}
          below for the one other thing that may run in your browser.
        </p>
      </section>

      <section id="analytics" className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">Analytics</h2>
        <p>
          PokePortfolio may use Cloudflare Web Analytics — the same hosting provider that serves
          this site, not a separate third-party tracker. It counts aggregate page views and measures
          real-world page performance. Per Cloudflare's own documentation, it does not use cookies
          or any client-side storage to do this, and it does not fingerprint visitors by IP address,
          user agent or any other signal. There is nothing to opt out of because there is nothing
          that identifies you individually to opt out of — which is also why this page shows no
          cookie-consent banner (see the reasoning recorded in DECISIONS.md).
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">Export, backup and deletion</h2>
        <p>
          You can generate a complete export of your data (a full JSON backup plus per-category CSV
          files) at any time from Profile → Export &amp; backup — nothing is withheld from it.
          Profile → Reset portfolio data permanently erases your portfolio, purchases, sales,
          openings and history; it does not remove your account itself. There is no self-service
          "delete my account" action yet — email the address below to have your account and
          remaining data removed.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">Contact</h2>
        <p>
          This is a one-person project with no company, legal entity or registered address behind
          it. Questions, correction requests or deletion requests:{' '}
          <a href="mailto:oskarhn06@outlook.com" className="underline underline-offset-2">
            oskarhn06@outlook.com
          </a>
          .
        </p>
      </section>
    </LegalLayout>
  )
}
