import type { RecurrenceRule } from './index.js'

/**
 * A recurrence rule, said the way somebody would say it.
 *
 * `{freq: 'weekly', interval: 2, byWeekday: [1], at: '09:00'}` is precise and unreadable. Somebody
 * setting up a fortnightly review needs to see "Every 2 weeks on Monday at 09:00" and know at a
 * glance whether they got it right — a schedule you cannot read is a schedule you cannot check.
 *
 * The wording is passed in rather than imported. A module that reaches for `$msg` cannot be
 * unit-tested — SvelteKit's aliases come from `svelte.config.js`, which vitest does not read — and
 * a sentence-builder nobody can test is exactly the kind that gets Sunday wrong.
 */
export interface RecurrenceStrings {
  every: (unit: string) => string
  everyN: (n: number, unit: string) => string
  day: string
  week: string
  month: string
  year: string
  on: (when: string, days: string) => string
  dayOfMonth: (day: string) => string
  at: (when: string, time: string) => string
  times: (text: string, count: number) => string
  until: (text: string, date: string) => string
}

/** Plain English, and what the tests read against. */
export const ENGLISH: RecurrenceStrings = {
  every: (unit) => `Every ${unit}`,
  everyN: (n, unit) => `Every ${n} ${unit}s`,
  day: 'day',
  week: 'week',
  month: 'month',
  year: 'year',
  on: (when, days) => `${when} on ${days}`,
  dayOfMonth: (day) => `the ${day}`,
  at: (when, time) => `${when} at ${time}`,
  times: (text, count) => `${text}, ${count} times`,
  until: (text, date) => `${text}, until ${date}`,
}

/** Sunday-first, matching `byWeekday` where 0 is Sunday. */
const weekdayName = (day: number, locale: string): string =>
  new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(
    // 2024-01-07 was a Sunday, so adding the index lands on the right day.
    new Date(Date.UTC(2024, 0, 7 + day)),
  )

const ordinal = (day: number, locale: string): string =>
  locale.startsWith('en') && new Intl.PluralRules(locale, { type: 'ordinal' }).select(day) === 'one'
    ? `${day}st`
    : String(day)

export function describeRecurrence(
  rule: RecurrenceRule,
  strings: RecurrenceStrings = ENGLISH,
  locale = 'en',
): string {
  const every = (unit: string) =>
    rule.interval > 1 ? strings.everyN(rule.interval, unit) : strings.every(unit)

  let when: string
  switch (rule.freq) {
    case 'daily':
      when = every(strings.day)
      break
    case 'weekly': {
      when = every(strings.week)
      const days = (rule.byWeekday ?? []).map((d) => weekdayName(d, locale))
      if (days.length) when = strings.on(when, days.join(', '))
      break
    }
    case 'monthly': {
      when = every(strings.month)
      if (rule.byMonthDay) when = strings.on(when, strings.dayOfMonth(ordinal(rule.byMonthDay, locale)))
      break
    }
    default:
      when = every(strings.year)
  }

  let text = strings.at(when, rule.at)
  // An end condition changes what somebody is agreeing to, so it is part of the sentence rather
  // than a detail on another line.
  if (rule.count) text = strings.times(text, rule.count)
  else if (rule.until) text = strings.until(text, rule.until.slice(0, 10))
  return text
}
