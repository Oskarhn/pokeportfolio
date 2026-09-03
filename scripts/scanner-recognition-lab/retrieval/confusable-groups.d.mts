export interface ConfusableCorpusRow {
  cardId: string
  name: string
  setId: string
}
export declare function buildConfusableGroups(
  corpusRows: ConfusableCorpusRow[],
): Map<string, string[]>
export declare function buildCardToGroup(groups: Map<string, string[]>): Map<string, string>
