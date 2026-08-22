/**
 * Fractional indexing for `Issue.rank`.
 *
 * Manual ordering (backlog, board columns) must survive concurrent edits: two people dragging
 * different cards at the same time should not have to renumber anything. Each issue therefore
 * carries a short string key, and inserting between two rows only mints a new key strictly between
 * its neighbours — no other row is touched, and the result sorts with a plain string comparison.
 *
 * The alphabet is ordered by code point (digits, uppercase, lowercase) so lexicographic order and
 * numeric order agree, which is what `ORDER BY rank` in Postgres relies on.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length

const indexOfDigit = (ch: string) => {
  const i = DIGITS.indexOf(ch)
  if (i < 0) throw new Error(`invalid rank character: ${JSON.stringify(ch)}`)
  return i
}

/** True when `rank` only uses the rank alphabet and has no trailing zero (the canonical form). */
export function isValidRank(rank: string): boolean {
  if (rank.length === 0) return false
  for (const ch of rank) if (!DIGITS.includes(ch)) return false
  return !rank.endsWith(DIGITS[0] as string)
}

/**
 * A key strictly between `before` and `after`. Pass `null` for an open end: `rankBetween(null, first)`
 * puts an item at the top of the list, `rankBetween(last, null)` at the bottom.
 */
export function rankBetween(before: string | null, after: string | null): string {
  const lo = before ?? ''
  const hi = after ?? ''
  if (lo && hi && lo >= hi) {
    throw new Error(`rankBetween expects before < after, got ${JSON.stringify(lo)} >= ${JSON.stringify(hi)}`)
  }

  let prefix = ''
  // once the digit we keep is strictly below the upper bound's digit, the rest of `hi` cannot
  // constrain us any more and we are free to use the whole alphabet
  let free = hi === ''

  for (let i = 0; ; i++) {
    const da = i < lo.length ? indexOfDigit(lo[i] as string) : -1
    const db = free ? BASE : i < hi.length ? indexOfDigit(hi[i] as string) : 0
    if (db - da > 1) return prefix + DIGITS[Math.floor((da + db) / 2)]
    const kept = da >= 0 ? da : 0
    prefix += DIGITS[kept]
    if (!free && kept < db) free = true
  }
}

/** First rank in an empty list. */
export function initialRank(): string {
  return rankBetween(null, null)
}

/**
 * `count` evenly spread ranks, for seeding a list. Cheaper and tidier than calling `rankBetween`
 * repeatedly, which would bias every new key towards the end.
 */
export function rankSequence(count: number): string[] {
  const out: string[] = []
  let prev: string | null = null
  for (let i = 0; i < count; i++) {
    prev = rankBetween(prev, null)
    out.push(prev)
  }
  return out
}

/** Ascending comparator for anything carrying a `rank`. */
export function byRank(a: { rank: string }, b: { rank: string }): number {
  return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0
}

/**
 * The rank an item needs to land at `targetIndex` of `ordered` (the list it is being dropped into,
 * already excluding the dragged item).
 */
export function rankForIndex(ordered: Array<{ rank: string }>, targetIndex: number): string {
  const before = targetIndex > 0 ? (ordered[targetIndex - 1]?.rank ?? null) : null
  const after = targetIndex < ordered.length ? (ordered[targetIndex]?.rank ?? null) : null
  return rankBetween(before, after)
}
