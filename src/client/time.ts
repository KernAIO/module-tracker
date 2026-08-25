/**
 * Reading and writing amounts of time the way people say them.
 *
 * Somebody logging work writes `2h`, `90m`, `1h30m` or just `45`. Insisting on seconds — or on one
 * format — turns logging time into a chore, and a chore nobody does leaves `timeSpentSec` at zero
 * however good the reports built on it are.
 */

/**
 * Persian and Arabic keyboards produce their own digits, and we render numbers in them too — so
 * `۲۰m` is what a Persian user types, and `\d` in JavaScript matches none of it. Fold them to ASCII
 * before parsing rather than localising the format, because the units stay `h`/`m` in every locale.
 */
const toAsciiDigits = (text: string) =>
  text.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (d) => String((d.codePointAt(0) ?? 0) & 0xf))

/** Seconds from what somebody typed, or `null` if it does not mean an amount of time. */
export function parseDuration(input: string): number | null {
  const text = toAsciiDigits(input.trim().toLowerCase())
  if (!text) return null

  // A bare number is hours: "2" is two hours, because that is what people mean when logging work.
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const hours = Number(text)
    return hours > 0 ? Math.round(hours * 3600) : null
  }

  // Anything else has to be made of amounts with units, and nothing else: `1h30m`, `90 m`, `2h 15m`.
  if (!/^(?:\d+(?:\.\d+)?\s*[hm]\s*)+$/.test(text)) return null
  let seconds = 0
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)\s*([hm])/g))
    seconds += Number(amount) * (unit === 'h' ? 3600 : 60)
  return seconds > 0 ? Math.round(seconds) : null
}
