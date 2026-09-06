import { describe, expect, it } from 'vitest'

import {
  EXPORT_REMINDER_INTERVAL_DAYS,
  exportReminderStorageKey,
  markReminderSatisfied,
  readLastReminderMark,
  shouldRemindExport,
  type ReminderStore,
} from '../../src/domain/export/export-reminder'

/** PRODUCT_SPEC §4.12's periodic in-app export reminder (D-079). */
describe('export reminder cadence', () => {
  const NOW = new Date('2026-08-24T12:00:00Z')
  const USER_A = 'user-a-11111111-1111-1111-1111-111111111111'
  const USER_B = 'user-b-22222222-2222-2222-2222-222222222222'

  function storeWith(userId: string, value: string | null): ReminderStore {
    const map = new Map<string, string>()
    if (value !== null) map.set(exportReminderStorageKey(userId), value)
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
    const good = storeWith(USER_A, null)
    markReminderSatisfied(good, USER_A, NOW)
    expect(readLastReminderMark(good, USER_A)).toBe(NOW.toISOString())
    expect(shouldRemindExport(readLastReminderMark(good, USER_A), NOW)).toBe(false)

    const hostile: ReminderStore = {
      getItem: () => {
        throw new Error('private mode')
      },
      setItem: () => {
        throw new Error('private mode')
      },
    }
    expect(readLastReminderMark(hostile, USER_A)).toBeNull()
    expect(() => {
      markReminderSatisfied(hostile, USER_A, NOW)
    }).not.toThrow()
  })

  it("P111 regression: two different users on the same store never see each other's reminder state", () => {
    // A shared `localStorage` (same browser, two accounts signing in one after another) backs
    // both users — this is the exact real-world shape the bug shipped in.
    const shared: ReminderStore = {
      getItem: (key) => sharedMap.get(key) ?? null,
      setItem: (key, value) => {
        sharedMap.set(key, value)
      },
    }
    const sharedMap = new Map<string, string>()

    // User A exports — their own reminder is satisfied.
    markReminderSatisfied(shared, USER_A, NOW)
    expect(shouldRemindExport(readLastReminderMark(shared, USER_A), NOW)).toBe(false)

    // User B, on the SAME store, has never exported — B's own reminder must still fire. The old,
    // unnamespaced key would have wrongly reported B's reminder as satisfied here too.
    expect(readLastReminderMark(shared, USER_B)).toBeNull()
    expect(shouldRemindExport(readLastReminderMark(shared, USER_B), NOW)).toBe(true)

    // The two users' storage keys are genuinely distinct.
    expect(exportReminderStorageKey(USER_A)).not.toBe(exportReminderStorageKey(USER_B))
  })
})
