/**
 * The ordering invariants manual ranking depends on.
 *
 * There was no test for this file, which is how a loop that hangs the tab survived: dragging a
 * sixth card to the top of one list was enough to reach it, and every other test passed.
 */
import { describe, expect, it } from 'vitest'
import { initialRank, isValidRank, rankBetween, rankSequence } from './rank.js'

describe('rankBetween', () => {
  it('lands strictly between its neighbours', () => {
    const a = initialRank()
    const c = rankBetween(a, null)
    const b = rankBetween(a, c)
    expect(a < b).toBe(true)
    expect(b < c).toBe(true)
  })

  it('opens either end', () => {
    const first = initialRank()
    expect(rankBetween(null, first) < first).toBe(true)
    expect(rankBetween(first, null) > first).toBe(true)
  })

  it('refuses neighbours that are the wrong way round', () => {
    const a = initialRank()
    const b = rankBetween(a, null)
    expect(() => rankBetween(b, a)).toThrow()
  })

  it('keeps finding room when the same gap is split over and over', () => {
    let lo = initialRank()
    const hi = rankBetween(lo, null)
    const seen = new Set<string>([lo, hi])
    for (let i = 0; i < 200; i++) {
      const mid = rankBetween(lo, hi)
      expect(lo < mid, `${lo} < ${mid} failed at split ${i}`).toBe(true)
      expect(mid < hi, `${mid} < ${hi} failed at split ${i}`).toBe(true)
      expect(seen.has(mid), `collision at split ${i}`).toBe(false)
      seen.add(mid)
      lo = mid
    }
  })
})

describe('dragging to the top, over and over', () => {
  it('keeps finding room instead of looping until the tab dies', () => {
    // The regression: an absent lower bound was treated as "below digit 0", so the fifth insertion
    // at the top minted '0' and the sixth searched below it for ever.
    let first = initialRank()
    const seen = new Set<string>([first])
    for (let i = 0; i < 200; i++) {
      const next = rankBetween(null, first)
      expect(next < first, `${next} < ${first} failed at insertion ${i}`).toBe(true)
      expect(isValidRank(next), `${next} is not canonical at insertion ${i}`).toBe(true)
      expect(seen.has(next), `collision at insertion ${i}`).toBe(false)
      seen.add(next)
      first = next
    }
  })

  it('never mints a key with no room below it', () => {
    let first = initialRank()
    for (let i = 0; i < 50; i++) {
      first = rankBetween(null, first)
      expect(first.endsWith('0'), `${first} ends in the lowest digit`).toBe(false)
    }
  })
})

describe('rankSequence', () => {
  it('produces keys that already sort into the order they were asked for', () => {
    const keys = rankSequence(25)
    expect(keys).toHaveLength(25)
    expect([...keys].sort()).toEqual(keys)
    expect(new Set(keys).size).toBe(25)
  })
})
