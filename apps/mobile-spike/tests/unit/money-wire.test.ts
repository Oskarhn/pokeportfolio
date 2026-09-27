import {
  LEDGER_MINOR_MAX,
  LEDGER_MINOR_MIN,
  moneyArg,
  MoneyWireError,
  optionalMoneyArg,
  serializeMinorUnits,
  serializeOptionalMinorUnits,
} from '../../src/write/money-wire'

/** P175's WRITE half of the bigint<->PostgREST boundary (mutation #2 in output_175.txt: a
 *  Number(bigint) anywhere on this path must fail a test). */
describe('serializeMinorUnits', () => {
  it('is a decimal string, never a JSON number', () => {
    expect(serializeMinorUnits(9007199254740993n)).toBe('9007199254740993')
    expect(typeof serializeMinorUnits(9007199254740993n)).toBe('string')
  })

  it('round-trips exactly above Number.MAX_SAFE_INTEGER', () => {
    const value = 9007199254740993n
    expect(BigInt(serializeMinorUnits(value))).toBe(value)
  })

  it('preserves sign for a negative amount', () => {
    expect(serializeMinorUnits(-12345n)).toBe('-12345')
  })

  it('refuses a value outside the bigint ledger range', () => {
    expect(() => serializeMinorUnits(LEDGER_MINOR_MAX + 1n)).toThrow(MoneyWireError)
    expect(() => serializeMinorUnits(LEDGER_MINOR_MIN - 1n)).toThrow(MoneyWireError)
  })

  it('accepts the exact boundary values', () => {
    expect(serializeMinorUnits(LEDGER_MINOR_MAX)).toBe(LEDGER_MINOR_MAX.toString())
    expect(serializeMinorUnits(LEDGER_MINOR_MIN)).toBe(LEDGER_MINOR_MIN.toString())
  })

  it('refuses a plain number at runtime (a caller bug, not a value to coerce)', () => {
    // @ts-expect-error deliberately calling with the wrong runtime type
    expect(() => serializeMinorUnits(5)).toThrow(MoneyWireError)
  })
})

describe('serializeOptionalMinorUnits', () => {
  it('undefined stays undefined (never becomes a serialized zero)', () => {
    expect(serializeOptionalMinorUnits(undefined)).toBeUndefined()
  })

  it('an explicit 0n still serializes', () => {
    expect(serializeOptionalMinorUnits(0n)).toBe('0')
  })
})

describe('moneyArg / optionalMoneyArg', () => {
  it('moneyArg carries the exact string under the generated (number) type', () => {
    const arg = moneyArg(9007199254740993n)
    expect(arg as unknown as string).toBe('9007199254740993')
  })

  it('optionalMoneyArg(undefined) omits the key rather than sending 0', () => {
    expect(optionalMoneyArg(undefined)).toBeUndefined()
  })
})
