import { describe, expect, it } from 'vitest'
import { formulaReferences, runFormula, validateFormula } from './formula.js'

const values: Record<string, unknown> = {
  estimate: 5,
  'cf.story_points': 8,
  startDate: '2026-01-01',
  dueDate: '2026-01-15',
  title: 'Ship it',
  'cf.empty': null,
}
const read = (name: string) => (values[name] ?? null) as never

const run = (source: string) => runFormula(source, read)

describe('arithmetic', () => {
  it('does the obvious things', () => {
    expect(run('1 + 2 * 3')).toBe(7)
    expect(run('(1 + 2) * 3')).toBe(9)
    expect(run('10 / 4')).toBe(2.5)
    expect(run('-{estimate}')).toBe(-5)
  })

  it('reads a field by the name it has everywhere else', () => {
    expect(run('{estimate} * 2')).toBe(10)
    expect(run('{cf.story_points} + 1')).toBe(9)
  })

  it('is empty rather than zero when a value is missing', () => {
    // A story with no estimate has no doubled estimate either. Calling it 0 would sort it top.
    expect(run('{cf.empty} * 2')).toBeNull()
    expect(run('{nothing_at_all} + 1')).toBeNull()
  })

  it('refuses to divide by zero instead of returning Infinity', () => {
    expect(run('1 / 0')).toBeNull()
    expect(run('1 % 0')).toBeNull()
  })
})

describe('functions', () => {
  it('rounds, to a number of places if asked', () => {
    expect(run('round(2.567)')).toBe(3)
    expect(run('round(2.567, 2)')).toBe(2.57)
  })

  it('counts days between two dates', () => {
    expect(run('daysBetween({startDate}, {dueDate})')).toBe(14)
    expect(run('daysBetween({startDate}, {cf.empty})')).toBeNull()
  })

  it('picks the first value that is there', () => {
    expect(run('coalesce({cf.empty}, {estimate})')).toBe(5)
    expect(run('coalesce({cf.empty}, {nothing})')).toBeNull()
  })

  it('chooses between two values', () => {
    expect(run('if({estimate} > 3, "big", "small")')).toBe('big')
    expect(run('if({estimate} > 30, "big", "small")')).toBe('small')
  })

  it('joins and measures text', () => {
    expect(run('concat({title}, " (", {estimate}, ")")')).toBe('Ship it (5)')
    expect(run('length({title})')).toBe(7)
  })

  it('takes the smallest and the largest, ignoring what is missing', () => {
    expect(run('min({estimate}, {cf.story_points})')).toBe(5)
    expect(run('max({estimate}, {cf.empty})')).toBe(5)
  })
})

describe('comparison', () => {
  it('compares numbers and equality', () => {
    expect(run('{estimate} >= 5')).toBe(true)
    expect(run('{estimate} == 5')).toBe(true)
    expect(run('{title} == "Ship it"')).toBe(true)
    expect(run('{title} != "Ship it"')).toBe(false)
  })
})

describe('validation', () => {
  it('accepts what it can run', () => {
    expect(validateFormula('{estimate} * 2').ok).toBe(true)
    expect(validateFormula('round(daysBetween({startDate}, {dueDate}) / 7, 1)').ok).toBe(true)
  })

  it('names what is wrong, with a position', () => {
    const unclosed = validateFormula('({estimate} * 2')
    expect(unclosed.ok).toBe(false)
    expect(unclosed.problems[0]?.message).toMatch(/never closed/)

    const unknown = validateFormula('frobnicate(1)')
    expect(unknown.problems[0]?.message).toMatch(/no function called/)

    const braces = validateFormula('{estimate * 2')
    expect(braces.problems[0]?.message).toMatch(/closing brace/)
  })

  it('suggests the braces when a field is written bare', () => {
    // `estimate * 2` is the mistake everybody makes first.
    expect(validateFormula('estimate * 2').problems[0]?.message).toMatch(/\{estimate\}/)
  })

  it('refuses trailing rubbish', () => {
    expect(validateFormula('1 + 2 3').ok).toBe(false)
  })
})

describe('references', () => {
  it('lists the fields a formula reads, once each', () => {
    expect(formulaReferences('{estimate} + {estimate} + {cf.points}')).toEqual(['estimate', 'cf.points'])
  })

  it('lists them even when the formula does not parse', () => {
    // Cycle detection has to work on a formula somebody is still typing.
    expect(formulaReferences('{estimate} + ')).toEqual(['estimate'])
  })
})
