import { describe, expect, it } from 'vitest'
import { describeRecurrence } from './recurrence.js'

const rule = (over: Record<string, unknown>) =>
  ({ freq: 'weekly', interval: 1, at: '09:00', ...over }) as never

describe('describeRecurrence', () => {
  it('says the plain cases plainly', () => {
    expect(describeRecurrence(rule({ freq: 'daily' }))).toBe('Every day at 09:00')
    expect(describeRecurrence(rule({ freq: 'weekly' }))).toBe('Every week at 09:00')
    expect(describeRecurrence(rule({ freq: 'monthly' }))).toBe('Every month at 09:00')
  })

  it('says the interval when it is not one', () => {
    expect(describeRecurrence(rule({ freq: 'weekly', interval: 2 }))).toBe('Every 2 weeks at 09:00')
  })

  it('names the days of the week', () => {
    // 0 is Sunday, which is the one that is easy to get wrong.
    expect(describeRecurrence(rule({ byWeekday: [1] }))).toBe('Every week on Monday at 09:00')
    expect(describeRecurrence(rule({ byWeekday: [0] }))).toBe('Every week on Sunday at 09:00')
    expect(describeRecurrence(rule({ byWeekday: [1, 4] }))).toBe('Every week on Monday, Thursday at 09:00')
  })

  it('names the day of the month', () => {
    expect(describeRecurrence(rule({ freq: 'monthly', byMonthDay: 1 }))).toBe(
      'Every month on the 1st at 09:00',
    )
  })

  it('says when it stops, because that is part of what somebody is agreeing to', () => {
    expect(describeRecurrence(rule({ count: 6 }))).toBe('Every week at 09:00, 6 times')
    expect(describeRecurrence(rule({ until: '2026-12-31T00:00:00.000Z' }))).toBe(
      'Every week at 09:00, until 2026-12-31',
    )
  })
})
