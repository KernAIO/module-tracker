import { describe, expect, it } from 'vitest'
import { initialRank, isValidRank, RankError, rankBetween, rankSequence } from './rank.js'

const sorted = (values: string[]) => [...values].sort()

describe('rankBetween', () => {
  it('produces a first rank in the middle of the space', () => {
    const first = initialRank()
    expect(isValidRank(first)).toBe(true)
    expect(first > '0').toBe(true)
    expect(first < 'z').toBe(true)
  })

  it('appends after the last rank', () => {
    let last = initialRank()
    const ranks = [last]
    for (let i = 0; i < 50; i++) {
      last = rankBetween(last, null)
      ranks.push(last)
    }
    expect(sorted(ranks)).toEqual(ranks)
  })

  it('prepends before the first rank', () => {
    let first = initialRank()
    const ranks = [first]
    for (let i = 0; i < 50; i++) {
      first = rankBetween(null, first)
      ranks.unshift(first)
    }
    expect(sorted(ranks)).toEqual(ranks)
  })

  it('inserts strictly between two neighbours', () => {
    const a = initialRank()
    const b = rankBetween(a, null)
    const mid = rankBetween(a, b)
    expect(a < mid).toBe(true)
    expect(mid < b).toBe(true)
  })

  it('survives repeated insertion at the same spot without collision', () => {
    const a = initialRank()
    let b = rankBetween(a, null)
    const between: string[] = []
    for (let i = 0; i < 200; i++) {
      const next = rankBetween(a, b)
      expect(a < next).toBe(true)
      expect(next < b).toBe(true)
      between.push(next)
      b = next
    }
    expect(new Set(between).size).toBe(between.length)
  })

  it('never ends with the lowest digit, so there is always room below', () => {
    let cursor = initialRank()
    for (let i = 0; i < 100; i++) {
      cursor = rankBetween(null, cursor)
      expect(cursor.endsWith('0')).toBe(false)
    }
  })

  it('keeps a randomly shuffled list in order after many moves', () => {
    const ranks: string[] = []
    for (let i = 0; i < 30; i++) ranks.push(rankBetween(ranks.at(-1) ?? null, null))
    // move a random element to a random position 300 times
    let seed = 42
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let step = 0; step < 300; step++) {
      const from = Math.floor(random() * ranks.length)
      const [moved] = ranks.splice(from, 1)
      expect(moved).toBeDefined()
      const to = Math.floor(random() * (ranks.length + 1))
      const before = to > 0 ? ranks[to - 1]! : null
      const after = to < ranks.length ? ranks[to]! : null
      ranks.splice(to, 0, rankBetween(before, after))
    }
    expect(sorted(ranks)).toEqual(ranks)
  })

  it('rejects neighbours that are out of order', () => {
    const a = initialRank()
    const b = rankBetween(a, null)
    expect(() => rankBetween(b, a)).toThrow(RankError)
    expect(() => rankBetween(a, a)).toThrow(RankError)
  })
})

describe('rankSequence', () => {
  it('returns an ordered run of ranks between two neighbours', () => {
    const a = initialRank()
    const b = rankBetween(a, null)
    const run = rankSequence(a, b, 5)
    expect(run).toHaveLength(5)
    expect(sorted(run)).toEqual(run)
    expect(a < run[0]!).toBe(true)
    expect(run.at(-1)! < b).toBe(true)
  })

  it('returns nothing for a non-positive count', () => {
    expect(rankSequence(null, null, 0)).toEqual([])
  })
})

describe('isValidRank', () => {
  it('accepts generated ranks and rejects malformed ones', () => {
    expect(isValidRank(initialRank())).toBe(true)
    expect(isValidRank('')).toBe(false)
    expect(isValidRank('V0')).toBe(false)
    expect(isValidRank('V!')).toBe(false)
  })
})
