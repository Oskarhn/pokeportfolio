// Shared corpus/lexicon helpers for the P85 OCR benchmarks — kept out of the two run-*.ts
// entrypoints so both the forensics grid search and the full recognition benchmark build the
// SAME lexicon from the SAME corpus (a forensics winner picked against one lexicon and reported
// against another would be a silent methodology bug).
import { buildCorpus } from '../../scanner-visual-benchmark/lib/fetch-references.mjs'

/** Real TCGdex corpus (name/localId ground truth), reusing the EXACT fetch/cache module the
 *  P76/P79/P82 visual benchmarks already use — no second corpus-fetching implementation. */
export async function loadOcrCorpus({ maxPerSet = 999 } = {}) {
  return buildCorpus({ maxPerSet })
}
