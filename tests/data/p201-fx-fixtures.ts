/**
 * Minimal, structurally faithful Norges Bank SDMX-JSON responses for the P201 FX suites. The shape
 * is the one captured live and kept in tests/data/norges-bank.test.ts (EUR/USD/JPY); only the
 * observations and the series-level UNIT_MULT vary here.
 */
export function sdmxResponse(
  baseCurrency: string,
  observations: [date: string, value: string][],
  unitMult: { id: string; name: string } = { id: '0', name: 'Units' },
) {
  return {
    meta: { id: 'P201-FIXTURE', prepared: '2026-10-09T17:00:00', test: true },
    data: {
      dataSets: [
        {
          series: {
            '0:0:0:0': {
              attributes: [0, 0, 0, 0],
              observations: Object.fromEntries(
                observations.map(([, value], i) => [String(i), [value]]),
              ),
            },
          },
        },
      ],
      structure: {
        dimensions: {
          series: [
            { id: 'FREQ', values: [{ id: 'B', name: 'Business' }] },
            { id: 'BASE_CUR', values: [{ id: baseCurrency, name: baseCurrency }] },
            { id: 'QUOTE_CUR', values: [{ id: 'NOK', name: 'Norwegian krone' }] },
            { id: 'TENOR', values: [{ id: 'SP', name: 'Spot' }] },
          ],
          observation: [
            {
              id: 'TIME_PERIOD',
              values: observations.map(([date]) => ({ id: date, name: date })),
            },
          ],
        },
        attributes: {
          series: [
            { id: 'DECIMALS', values: [{ id: '4', name: '4' }] },
            { id: 'CALCULATED', values: [{ id: 'false', name: 'false' }] },
            { id: 'UNIT_MULT', values: [unitMult] },
            { id: 'COLLECTION', values: [{ id: 'C', name: 'ECB concertation time 14:15 CET' }] },
          ],
          observation: [],
        },
      },
    },
  }
}

/** Path the harness keys the scripted Norges Bank answer on. */
export const norgesPath = (base: string) => `/api/data/EXR/B.${base}.NOK.SP`
