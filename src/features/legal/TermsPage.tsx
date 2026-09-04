import { useDocumentMeta } from '../../ui/useDocumentMeta'
import { LegalLayout } from './LegalLayout'

/** Mirrors docs/PRODUCT_SPEC.md §1.3's explicit non-goal ("Investment advice, price prediction,
 *  'buy/hold/sell' signals") and docs/PUBLICATION_CHECKLIST.md §8's attribution/trademark items
 *  — linked here rather than restated, per CLAUDE.md's "don't duplicate content, link instead". */
export function TermsPage() {
  useDocumentMeta({
    title: 'Terms',
    description:
      'Terms of use for PokePortfolio, a private, invite-only Pokémon TCG portfolio tracker.',
    robots: 'index, follow',
    canonicalPath: '/terms',
  })

  return (
    <LegalLayout title="Terms of use" updated="2026-09-04">
      <p>
        PokePortfolio is a private tool built and operated by one individual, provided on a limited
        basis to people who have been personally invited. There is no company or legal entity behind
        it — using it means agreeing to the points below, offered as-is.
      </p>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">Not financial advice</h2>
        <p>
          Every price, value and total shown is an informational estimate, sourced from third-party
          market data (Cardmarket and TCGplayer, via TCGdex) or from values you enter yourself.
          PokePortfolio does not give investment advice, does not predict prices, and never issues a
          buy/hold/sell signal of any kind. Nothing in this application should be treated as
          financial, tax or legal advice — verify anything that matters to you against a primary
          source before acting on it.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">Your data is your responsibility</h2>
        <p>
          You are responsible for the accuracy of what you enter — purchase prices, sale prices,
          quantities and dates. PokePortfolio does not verify transactions against a receipt,
          marketplace or bank record; it records what you tell it. Export your data regularly
          (Profile → Export &amp; backup) — see{' '}
          <a href="/privacy" className="underline underline-offset-2">
            Privacy
          </a>{' '}
          for what that includes.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">A limited, private service</h2>
        <p>
          Access is invite-only and may be revoked, and the service itself may change, be
          interrupted or be discontinued at any time, without notice and without any service-level
          guarantee. It is offered free of charge and as a hobby project, not a commercial product.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">Unofficial, unaffiliated</h2>
        <p>
          PokePortfolio is unofficial and unaffiliated with The Pokémon Company, Nintendo, Creatures
          or GAME FREAK. Card names, artwork and set data come from TCGdex; market prices come from
          Cardmarket and TCGplayer via TCGdex; currency exchange rates come from Norges Bank. Card
          imagery is loaded directly from TCGdex's own image service and is never copied or
          redistributed by this application.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">Changes and contact</h2>
        <p>
          These terms may be revised as the application changes; the date at the top of this page
          reflects the last review. Questions:{' '}
          <a href="mailto:oskarhn06@outlook.com" className="underline underline-offset-2">
            oskarhn06@outlook.com
          </a>
          .
        </p>
      </section>
    </LegalLayout>
  )
}
