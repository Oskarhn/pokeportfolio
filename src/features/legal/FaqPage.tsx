import type { ReactNode } from 'react'
import { useDocumentMeta } from '../../ui/useDocumentMeta'
import { LegalLayout } from './LegalLayout'

interface FaqEntry {
  q: string
  a: ReactNode
}

/** Every answer traces to real, shipped behavior (HANDOVER.md/PRODUCT_SPEC.md/ARCHITECTURE.md) —
 *  the prompt is explicit that this must not promise anything unshipped. */
const entries: FaqEntry[] = [
  {
    q: 'What is PokePortfolio?',
    a: 'A private, invite-only tool for tracking a Pokémon TCG collection both as a collection and as a set of financial records — what you own, what it might be worth, and what the hobby has actually cost you.',
  },
  {
    q: 'How are card values estimated?',
    a: 'From market data relayed through TCGdex (Cardmarket and TCGplayer), converted to NOK using Norges Bank exchange rates. Every figure is an estimate from third-party data, never a guarantee of what a card would actually sell for — see Terms.',
  },
  {
    q: 'Does it support raw, graded and sealed items?',
    a: 'Yes — raw singles, graded cards (with grader and grade), and sealed product are all first-class holdings, not a bolt-on.',
  },
  {
    q: "What if I don't know what I paid for something?",
    a: 'You can add it without a cost basis. Missing cost is shown as missing, never as zero — PokePortfolio never fabricates a number it doesn’t have.',
  },
  {
    q: 'Does the scanner just add cards automatically?',
    a: 'No. The scanner identifies a candidate match from your camera and shows it to you to review — it never adds anything to your Portfolio without your confirmation.',
  },
  {
    q: 'Does the scanner upload my photos anywhere?',
    a: 'No. Card and text recognition run entirely on your device in the browser. Captured images never cross the network.',
  },
  {
    q: 'What does PokePortfolio do with my data?',
    a: (
      <>
        See{' '}
        <a href="/privacy" className="underline underline-offset-2">
          Privacy
        </a>{' '}
        — short answer: your data stays yours, scoped to your account, and nothing is sold or shared
        with a third party.
      </>
    ),
  },
  {
    q: 'Can I get my data out?',
    a: 'Yes, at any time — Profile → Export & backup produces a full JSON backup plus per-category CSV files.',
  },
  {
    q: 'How do I get access?',
    a: 'By invitation only — there is no public sign-up. If you’ve been invited, you’ll have received a link to set up your account.',
  },
  {
    q: 'I found a wrong card, price or bug — how do I report it?',
    a: (
      <>
        Email{' '}
        <a href="mailto:oskarhn06@outlook.com" className="underline underline-offset-2">
          oskarhn06@outlook.com
        </a>{' '}
        with what you saw and, if you can, which card/set.
      </>
    ),
  },
]

export function FaqPage() {
  useDocumentMeta({
    title: 'FAQ',
    description:
      'Frequently asked questions about PokePortfolio — a private, invite-only Pokémon TCG portfolio tracker.',
    robots: 'index, follow',
    canonicalPath: '/faq',
  })

  return (
    <LegalLayout title="Frequently asked questions" updated="2026-09-04">
      <dl className="space-y-5">
        {entries.map((entry) => (
          <div key={entry.q}>
            <dt className="font-medium text-slate-100">{entry.q}</dt>
            <dd className="mt-1 text-slate-300">{entry.a}</dd>
          </div>
        ))}
      </dl>
    </LegalLayout>
  )
}
