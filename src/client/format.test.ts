import { describe, expect, it } from 'vitest'
import { formatDuration } from './format.js'

describe('formatDuration', () => {
  it('keeps minutes below an hour', () => {
    // A timer running for twenty minutes used to read "0h".
    expect(formatDuration(60)).toBe('1m')
    expect(formatDuration(20 * 60)).toBe('20m')
    expect(formatDuration(59 * 60)).toBe('59m')
  })

  it('keeps minutes below a day', () => {
    // 90 logged minutes used to read "2h", which is not a rounding, it is wrong.
    expect(formatDuration(90 * 60)).toBe('1h 30m')
    expect(formatDuration(2 * 3600)).toBe('2h')
    expect(formatDuration(7 * 3600 + 45 * 60)).toBe('7h 45m')
  })

  it('drops minutes above a day, where they stop being the point', () => {
    expect(formatDuration(26 * 3600)).toBe('1d 2h')
    expect(formatDuration(48 * 3600)).toBe('2d')
    expect(formatDuration(26 * 3600 + 30 * 60)).toBe('1d 2h')
  })

  it('says nothing rather than something wrong for nothing at all', () => {
    expect(formatDuration(0)).toBe('0h')
    expect(formatDuration(-5)).toBe('0h')
  })
})
