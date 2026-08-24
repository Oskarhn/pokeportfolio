import { describe, expect, it } from 'vitest'

import {
  createSectionWalk,
  ExportIntegrityError,
} from '../../src/domain/export/pagination-integrity'

describe('export section walk integrity (D-073)', () => {
  it('a healthy multi-page walk reconciles against its total', () => {
    const walk = createSectionWalk('holdings', ['id'])
    walk.observe([{ id: 'a' }, { id: 'b' }])
    walk.observe([{ id: 'c' }])
    expect(walk.received).toBe(3)
    expect(() => walk.finish(3)).not.toThrow()
  })

  it('a truncated walk fails loudly instead of writing an incomplete backup', () => {
    const walk = createSectionWalk('holdings', ['id'])
    walk.observe([{ id: 'a' }])
    expect(() => walk.finish(2)).toThrow(ExportIntegrityError)
    expect(() => walk.finish(2)).toThrow(/received 1 of 2/)
  })

  it('a duplicate primary key across pages names the row and section', () => {
    const walk = createSectionWalk('acquisition_lots', ['id'])
    walk.observe([{ id: 'lot-1' }, { id: 'lot-2' }])
    expect(() => walk.observe([{ id: 'lot-2' }])).toThrow(ExportIntegrityError)
    expect(() => walk.observe([{ id: 'lot-2' }])).toThrow(/duplicate row "lot-2"/)
    expect(() => walk.observe([{ id: 'lot-2' }])).toThrow(/acquisition_lots/)
  })

  it('composite-key join tables detect duplicated pairs, not shared halves', () => {
    const walk = createSectionWalk('holding_tags', ['holding_id', 'tag_id'])
    walk.observe([
      { holding_id: 'h1', tag_id: 't1' },
      { holding_id: 'h1', tag_id: 't2' },
    ])
    expect(() => walk.observe([{ holding_id: 'h1', tag_id: 't1' }])).toThrow(ExportIntegrityError)
  })

  it('finishing without a total is itself a failure — never a silent pass', () => {
    const walk = createSectionWalk('tags', ['id'])
    walk.observe([])
    expect(() => walk.finish(null)).toThrow(/no total count/)
  })

  it('an empty section with zero expected rows passes', () => {
    const walk = createSectionWalk('retailers', ['id'])
    expect(() => walk.finish(0)).not.toThrow()
  })
})
