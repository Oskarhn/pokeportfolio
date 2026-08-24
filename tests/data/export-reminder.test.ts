import { describe, expect, it } from 'vitest'

import {
  EXPORT_REMINDER_INTERVAL_DAYS,
  markReminderSatisfied,
  readLastReminderMark,
  shouldRemindExport,
  type ReminderStore,
} from '../../src/domain/export/export-reminder'

/** PRODUCT_SPEC §4.12's periodic in-app export reminder (D-079). */
describe('export reminder cadence', () => {
  const NOW = new Date('2026-08-24T12:00:00Z')

  function storeWith(value: string | null): ReminderStore {
    const map = new Map<string, string>()
    if (value !== null) map.set('pokeportfolio.export.reminder-marked-at', value)
    return {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, v) => {
        map.set(key, v)
      },
    }
  }

  it('reminds when nothing was ever marked', () => {
    expect(shouldRemindExport(null, NOW)).toBe(true)
  })

  it('stays quiet inside the interval and reminds after it', () => {
    const recent = new Date(NOW.getTime() - (EXPORT_REMINDER_INTERVAL_DAYS - 1) * 86_400_000)
    expect(shouldRemindExport(recent.toISOString(), NOW)).toBe(false)

    const stale = new Date(NOW.getTime() - (EXPORT_REMINDER_INTERVAL_DAYS + 1) * 86_400_000)
    expect(shouldRemindExport(stale.toISOString(), NOW)).toBe(true)

    const boundary = new Date(NOW.getTime() - EXPORT_REMINDER_INTERVAL_DAYS * 86_400_000)
    expect(shouldRemindExport(boundary.toISOString(), NOW)).toBe(true)
  })

  it('a corrupted stored value degrades to reminding — never to silently skipping', () => {
    expect(shouldRemindExport('not a timestamp', NOW)).toBe(true)
  })

  it('marking then reading round-trips; a throwing store never breaks the caller', () => {
    const good = storeWith(null)
    markReminderSatisfied(good, NOW)
    expect(readLastReminderMark(good)).toBe(NOW.toISOString())
    expect(shouldRemindExport(readLastReminderMark(good), NOW)).toBe(false)

    const hostile: ReminderStore = {
      getItem: () => {
        throw new Error('private mode')
      },
      setItem: () => {
        throw new Error('private mode')
      },
    }
    expect(readLastReminderMark(hostile)).toBeNull()
    expect(() => markReminderSatisfied(hostile, NOW)).not.toThrow()
  })
})
