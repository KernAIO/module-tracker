/**
 * Fractional indexing for manual ordering.
 *
 * A rank is a base-62 fraction written without the leading `0.`, so plain lexicographic ordering of
 * the strings equals numeric ordering of the fractions. Inserting between two neighbours only writes
 * the moved row — never the rest of the list — which is what makes drag-and-drop cheap on a board
 * with thousands of issues.
 *
 * Invariant: a rank never ends in `0`, otherwise there would be no room left below it.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length

export class RankError extends Error {}

const digit = (c: string): number => {
  const i = DIGITS.indexOf(c)
  if (i < 0) throw new RankError(`Invalid rank digit "${c}"`)
  return i
}

/** Strictly between `a` and `b` (both exclusive); `''` is the lower bound, `null` the upper one. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new RankError(`Ranks out of order: "${a}" >= "${b}"`)
  if (a.endsWith('0') || b?.endsWith('0')) throw new RankError('Rank must not end with the lowest digit')

  if (b !== null) {
    let common = 0
    while ((a[common] ?? '0') === b[common]) common++
    if (common > 0) return b.slice(0, common) + midpoint(a.slice(common), b.slice(common))
  }

  const digitA = a ? digit(a[0]!) : 0
  const digitB = b !== null && b.length > 0 ? digit(b[0]!) : BASE
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)]!
  // the leading digits are adjacent: descend into `a`'s tail
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[digitA]! + midpoint(a.slice(1), null)
}

/**
 * A rank strictly between `before` and `after`.
 * `before = null` means "at the very start", `after = null` means "at the very end".
 */
export function rankBetween(before: string | null, after: string | null): string {
  return midpoint(before ?? '', after)
}

/** `count` evenly spread ranks between two neighbours, in order. */
export function rankSequence(before: string | null, after: string | null, count: number): string[] {
  if (count <= 0) return []
  const out: string[] = []
  let cursor = before
  for (let i = 0; i < count; i++) {
    const next = rankBetween(cursor, after)
    out.push(next)
    cursor = next
  }
  return out
}

/** First rank of an empty list. */
export const initialRank = (): string => rankBetween(null, null)

export const isValidRank = (rank: string): boolean =>
  rank.length > 0 && !rank.endsWith('0') && [...rank].every((c) => DIGITS.includes(c))
