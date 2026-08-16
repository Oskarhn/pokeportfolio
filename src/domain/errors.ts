/**
 * Typed domain errors. Thrown at the boundaries listed in FINANCIAL_MODEL.md —
 * currency mismatches, invalid allocation weights, malformed decimal input —
 * rather than allowed to fail silently or produce a fabricated number.
 */

export class CurrencyMismatchError extends Error {
  readonly left: string
  readonly right: string

  constructor(left: string, right: string) {
    super(`Cannot combine amounts in different currencies: ${left} and ${right}`)
    this.name = 'CurrencyMismatchError'
    this.left = left
    this.right = right
  }
}

export class InvalidMoneyInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidMoneyInputError'
  }
}

export class AllocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AllocationError'
  }
}
