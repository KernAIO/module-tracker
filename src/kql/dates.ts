/**
 * Date maths for KQL literals and functions. Everything is computed in UTC: the tracker stores
 * timestamps with time zone, and a query must mean the same thing wherever it runs.
 */

export type RelUnit = 'h' | 'd' | 'w' | 'm' | 'y'

const DAY_MS = 86_400_000

/** Apply a relative offset (`-7d`, `+2w`) to a base instant. */
export function shift(base: Date, amount: number, unit: RelUnit): Date {
  const d = new Date(base.getTime())
  switch (unit) {
    case 'h':
      return new Date(d.getTime() + amount * 3_600_000)
    case 'd':
      return new Date(d.getTime() + amount * DAY_MS)
    case 'w':
      return new Date(d.getTime() + amount * 7 * DAY_MS)
    case 'm': {
      const target = new Date(d.getTime())
      const day = target.getUTCDate()
      target.setUTCDate(1)
      target.setUTCMonth(target.getUTCMonth() + Math.trunc(amount))
      // clamp (31 Jan + 1m → 28/29 Feb)
      const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
      target.setUTCDate(Math.min(day, lastDay))
      return target
    }
    case 'y': {
      const target = new Date(d.getTime())
      target.setUTCFullYear(target.getUTCFullYear() + Math.trunc(amount))
      return target
    }
  }
}

export function startOfDay(base: Date, offsetDays = 0): Date {
  const d = new Date(base.getTime() + offsetDays * DAY_MS)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** Start of the ISO week (Monday) containing `base`, shifted by `offsetWeeks`. */
export function startOfWeek(base: Date, offsetWeeks = 0, weekStartsOn = 1): Date {
  const day = startOfDay(base)
  const diff = (day.getUTCDay() - weekStartsOn + 7) % 7
  return new Date(day.getTime() - diff * DAY_MS + offsetWeeks * 7 * DAY_MS)
}

export function startOfMonth(base: Date, offsetMonths = 0): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offsetMonths, 1))
}

/** `YYYY-MM-DD` in UTC. */
export const dateOnly = (d: Date): string => d.toISOString().slice(0, 10)

/** Parse a KQL date literal (`2026-08-22` or a full ISO timestamp) into an instant. */
export function parseDateLiteral(value: string): Date | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value.replace(' ', 'T')
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}
