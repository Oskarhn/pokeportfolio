/** mulberry32: small, fast, reproducible. Seeds are printed with every failure. */
export class Prng {
  private state: number

  constructor(readonly seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list')
    return items[Math.floor(this.next() * items.length)]!
  }

  chance(probability: number): boolean {
    return this.next() < probability
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1))
      ;[out[i], out[j]] = [out[j]!, out[i]!]
    }
    return out
  }
}

export function seedList(envName: string, defaultCount: number, base: number): number[] {
  const explicit = process.env[`${envName}_SEED`]
  if (explicit) return explicit.split(',').map((s) => Number(s.trim()))
  const count = Number(process.env[`${envName}_COUNT`] ?? defaultCount)
  const start = Number(process.env[`${envName}_BASE`] ?? base)
  return Array.from({ length: count }, (_, i) => start + i)
}
