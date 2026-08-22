import { describe, expect, it } from 'vitest'
import type { KqlComparison, KqlExpr } from './ast.js'
import { fieldsUsed, printQuery, walkComparisons } from './ast.js'
import { dateOnly, parseDateLiteral, shift, startOfDay, startOfMonth, startOfWeek } from './dates.js'
import { customKqlField, operatorsFor, SYSTEM_FIELDS } from './fields.js'
import { tokenize } from './lexer.js'
import { parseKql } from './parser.js'
import { suggest } from './suggest.js'
import { validateQuery } from './validate.js'

const parse = (input: string) => {
  const result = parseKql(input)
  if (!result.query) throw new Error(`parse failed: ${result.errors.map((e) => e.message).join('; ')}`)
  return result
}

const comparisons = (expr: KqlExpr | null): KqlComparison[] => {
  const out: KqlComparison[] = []
  walkComparisons(expr, (c) => out.push(c))
  return out
}

const FIELDS = [
  ...SYSTEM_FIELDS,
  customKqlField('severity', 'select', 'Severity'),
  customKqlField('story_points', 'number', 'Story points'),
  customKqlField('teams', 'multiselect', 'Teams'),
]

// =====================================================================================
// lexer
// =====================================================================================

describe('tokenize', () => {
  it('splits operators, identifiers and punctuation', () => {
    const { tokens, errors } = tokenize('status != done and priority in (high, urgent)')
    expect(errors).toEqual([])
    expect(tokens.map((t) => t.kind)).toEqual([
      'ident',
      'op',
      'ident',
      'ident',
      'ident',
      'ident',
      'lparen',
      'ident',
      'comma',
      'ident',
      'rparen',
      'eof',
    ])
  })

  it('reads two-character operators before single-character ones', () => {
    expect(tokenize('a <= 1').tokens[1]!.text).toBe('<=')
    expect(tokenize('a >= 1').tokens[1]!.text).toBe('>=')
    expect(tokenize('a !~ "x"').tokens[1]!.text).toBe('!~')
    expect(tokenize('a<1').tokens[1]!.text).toBe('<')
  })

  it('reads quoted strings with escapes', () => {
    const { tokens } = tokenize(String.raw`title ~ "a \"quoted\" word"`)
    expect(tokens[2]!.value).toBe('a "quoted" word')
  })

  it('reports an unterminated string instead of throwing', () => {
    const { errors } = tokenize('title ~ "open')
    expect(errors[0]?.message).toBe('Unterminated string')
  })

  it('distinguishes dates, relative dates and plain numbers', () => {
    expect(tokenize('due < 2026-08-22').tokens[2]).toMatchObject({ kind: 'date', value: '2026-08-22' })
    expect(tokenize('updated > -7d').tokens[2]).toMatchObject({ kind: 'reldate', amount: -7, unit: 'd' })
    expect(tokenize('due > +2w').tokens[2]).toMatchObject({ kind: 'reldate', amount: 2, unit: 'w' })
    expect(tokenize('estimate > 5').tokens[2]).toMatchObject({ kind: 'number', value: 5 })
    expect(tokenize('estimate > -3.5').tokens[2]).toMatchObject({ kind: 'number', value: -3.5 })
  })

  it('keeps issue keys and dotted custom field names as one identifier', () => {
    expect(tokenize('key = KRN-123').tokens[2]!.text).toBe('KRN-123')
    expect(tokenize('cf.story_points > 3').tokens[0]!.text).toBe('cf.story_points')
  })

  it('records spans so errors can be underlined in the editor', () => {
    const { tokens } = tokenize('status = done')
    expect(tokens[0]).toMatchObject({ start: 0, end: 6 })
    expect(tokens[2]).toMatchObject({ start: 9, end: 13 })
  })
})

// =====================================================================================
// parser
// =====================================================================================

describe('parseKql', () => {
  it('parses an empty query as "everything"', () => {
    const result = parseKql('   ')
    expect(result.ok).toBe(true)
    expect(result.query).toEqual({ where: null, orderBy: [] })
  })

  it('parses a single comparison', () => {
    const { query } = parse('status = done')
    expect(query!.where).toMatchObject({ kind: 'cmp', field: 'status', op: '=' })
    expect((query!.where as KqlComparison).value).toMatchObject({ kind: 'ident', value: 'done' })
  })

  it('parses every comparison operator', () => {
    for (const op of ['=', '!=', '<', '<=', '>', '>=', '~', '!~']) {
      const { query } = parse(`estimate ${op} 3`)
      expect((query!.where as KqlComparison).op).toBe(op)
    }
  })

  it('gives "and" tighter binding than "or"', () => {
    const { query } = parse('a = 1 or b = 2 and c = 3')
    expect(query!.where!.kind).toBe('or')
    const or = query!.where as Extract<KqlExpr, { kind: 'or' }>
    expect(or.children).toHaveLength(2)
    expect(or.children[1]!.kind).toBe('and')
  })

  it('honours parentheses', () => {
    const { query } = parse('(a = 1 or b = 2) and c = 3')
    expect(query!.where!.kind).toBe('and')
  })

  it('flattens repeated connectives into one node', () => {
    const { query } = parse('a = 1 and b = 2 and c = 3')
    expect((query!.where as Extract<KqlExpr, { kind: 'and' }>).children).toHaveLength(3)
  })

  it('parses "not" as a prefix and "not in" as an operator', () => {
    const negation = parse('not status = done').query!
    expect(negation.where!.kind).toBe('not')
    const notIn = parse('priority not in (low, none)').query!
    expect(notIn.where).toMatchObject({ kind: 'cmp', op: 'not-in' })
    expect((notIn.where as KqlComparison).values).toHaveLength(2)
  })

  it('parses is empty / is not empty', () => {
    expect(parse('assignee is empty').query!.where).toMatchObject({ op: 'is-empty' })
    expect(parse('assignee is not empty').query!.where).toMatchObject({ op: 'is-not-empty' })
  })

  it('parses function calls with and without arguments', () => {
    const { query } = parse('assignee = currentUser() and created > startOfWeek(-1)')
    const [first, second] = comparisons(query!.where)
    expect(first!.value).toMatchObject({ kind: 'func', name: 'currentUser', args: [] })
    expect(second!.value).toMatchObject({ kind: 'func', name: 'startOfWeek' })
    expect((second!.value as { args: unknown[] }).args).toHaveLength(1)
  })

  it('parses booleans and null', () => {
    expect(parse('triage = true').query!.where).toMatchObject({
      value: { kind: 'bool', value: true },
    })
    expect(parse('cycle = null').query!.where).toMatchObject({ value: { kind: 'null' } })
  })

  it('parses an order by clause with and without a where', () => {
    expect(parse('order by priority desc, updated').query!.orderBy).toEqual([
      { field: 'priority', dir: 'desc', span: expect.anything() },
      { field: 'updated', dir: 'asc', span: expect.anything() },
    ])
    const both = parse('status = done order by updated desc').query!
    expect(both.where).toBeTruthy()
    expect(both.orderBy).toHaveLength(1)
  })

  it('is case-insensitive for keywords but not for values', () => {
    const { query } = parse('status = Done AND priority IN (high)')
    expect(query!.where!.kind).toBe('and')
    expect(comparisons(query!.where)[0]!.value).toMatchObject({ value: 'Done' })
  })

  it('reports syntax errors with a span instead of throwing', () => {
    const missingValue = parseKql('status =')
    expect(missingValue.ok).toBe(false)
    expect(missingValue.errors[0]).toMatchObject({ message: 'Expected a value' })

    const missingOperator = parseKql('status done')
    expect(missingOperator.ok).toBe(false)
    expect(missingOperator.errors[0]!.message).toContain('Expected an operator')

    const unbalanced = parseKql('(status = done')
    expect(unbalanced.ok).toBe(false)
    expect(unbalanced.errors[0]!.message).toContain('")"')
  })

  it('collects the fields a query touches', () => {
    const { query } = parse('assignee = currentUser() and label = bug order by priority')
    expect(fieldsUsed(query!).sort()).toEqual(['assignee', 'label', 'priority'])
  })
})

// =====================================================================================
// printer — normalisation round-trips
// =====================================================================================

describe('printQuery', () => {
  const roundTrip = (input: string) => printQuery(parse(input).query!)

  it('normalises spacing and keyword case', () => {
    expect(roundTrip('status=done   AND   priority  =  high')).toBe('status = done and priority = high')
  })

  it('keeps parentheses only where precedence needs them', () => {
    expect(roundTrip('(a = 1 or b = 2) and c = 3')).toBe('(a = 1 or b = 2) and c = 3')
    expect(roundTrip('a = 1 or b = 2 and c = 3')).toBe('a = 1 or b = 2 and c = 3')
  })

  it('re-parses to the same tree', () => {
    for (const input of [
      'status != done',
      'priority in (high, urgent) and assignee is empty',
      'not (label = bug or label = regression)',
      'created > -30d order by updated desc, priority',
      'cf.story_points >= 5',
    ]) {
      const once = roundTrip(input)
      expect(roundTrip(once)).toBe(once)
    }
  })

  it('quotes values that are not bare words', () => {
    expect(roundTrip('title ~ "two words"')).toBe('title ~ "two words"')
  })
})

// =====================================================================================
// validation
// =====================================================================================

describe('validateQuery', () => {
  it('accepts a well-formed query', () => {
    expect(validateQuery(parse('status = done and priority = high').query!, FIELDS)).toEqual([])
  })

  it('rejects unknown fields', () => {
    const issues = validateQuery(parse('nope = 1').query!, FIELDS)
    expect(issues[0]!.message).toContain('Unknown field "nope"')
  })

  it('rejects operators a field does not support', () => {
    const issues = validateQuery(parse('triage > true').query!, FIELDS)
    expect(issues[0]!.message).toContain('is not supported')
  })

  it('rejects values of the wrong shape', () => {
    expect(validateQuery(parse('estimate = "big"').query!, FIELDS)[0]!.message).toContain('expects a number')
    expect(validateQuery(parse('due = 5').query!, FIELDS)[0]!.message).toContain('expects a date')
    expect(validateQuery(parse('priority = enormous').query!, FIELDS)[0]!.message).toContain(
      'not a valid priority',
    )
  })

  it('accepts relative dates and date functions on date fields', () => {
    expect(validateQuery(parse('created > -7d').query!, FIELDS)).toEqual([])
    expect(validateQuery(parse('created > startOfMonth()').query!, FIELDS)).toEqual([])
  })

  it('rejects unknown functions and wrong arity', () => {
    expect(validateQuery(parse('assignee = nobody()').query!, FIELDS)[0]!.message).toContain(
      'Unknown function',
    )
    expect(validateQuery(parse('label = membersOf()').query!, FIELDS)[0]!.message).toContain(
      'expects 1 argument',
    )
  })

  it('knows about custom fields', () => {
    expect(validateQuery(parse('cf.story_points > 3').query!, FIELDS)).toEqual([])
    expect(validateQuery(parse('cf.unknown > 3').query!, FIELDS)[0]!.message).toContain('Unknown field')
  })

  it('rejects sorting on a field that is not sortable', () => {
    expect(validateQuery(parse('order by assignee').query!, FIELDS)[0]!.message).toContain('cannot be sorted')
  })
})

describe('operatorsFor', () => {
  it('offers containment operators for arrays and comparison for numbers', () => {
    const assignee = SYSTEM_FIELDS.find((f) => f.name === 'assignee')!
    expect(operatorsFor(assignee)).toContain('in')
    expect(operatorsFor(assignee)).not.toContain('<')
    const estimate = SYSTEM_FIELDS.find((f) => f.name === 'estimate')!
    expect(operatorsFor(estimate)).toEqual(expect.arrayContaining(['<', '<=', '>', '>=', 'is-empty']))
  })

  it('maps custom field types onto the right kind', () => {
    expect(customKqlField('a', 'number', 'A').kind).toBe('number')
    expect(customKqlField('b', 'checkbox', 'B').kind).toBe('boolean')
    expect(customKqlField('c', 'multiselect', 'C')).toMatchObject({ kind: 'enum', array: true })
    expect(customKqlField('d', 'datetime', 'D').kind).toBe('datetime')
  })
})

// =====================================================================================
// suggestions
// =====================================================================================

describe('suggest', () => {
  it('offers fields on an empty query and after a connective', () => {
    expect(suggest('', FIELDS).every((s) => s.kind === 'field')).toBe(true)
    expect(suggest('status = done and ', FIELDS).every((s) => s.kind === 'field')).toBe(true)
  })

  it('filters fields by the prefix being typed', () => {
    const labels = suggest('assi', FIELDS).map((s) => s.label)
    expect(labels).toContain('assignee')
    expect(labels).not.toContain('priority')
  })

  it('offers operators once a field is complete', () => {
    expect(suggest('priority', FIELDS).every((s) => s.kind === 'operator')).toBe(true)
  })

  it('offers enum values after an operator', () => {
    expect(suggest('priority = ', FIELDS).map((s) => s.label)).toContain('urgent')
    expect(suggest('priority = ur', FIELDS).map((s) => s.label)).toEqual(['urgent'])
  })

  it('offers currentUser() for user fields and cycle functions for cycles', () => {
    expect(suggest('assignee = ', FIELDS).map((s) => s.label)).toContain('currentUser()')
    expect(suggest('cycle = ', FIELDS).map((s) => s.label)).toContain('activeCycle()')
  })

  it('offers connectives after a complete term', () => {
    expect(suggest('status = done ', FIELDS).map((s) => s.label)).toEqual(['and', 'or', 'order by'])
  })
})

// =====================================================================================
// date helpers
// =====================================================================================

describe('date maths', () => {
  const base = new Date('2026-08-22T15:30:00.000Z') // a Saturday

  it('shifts by hours, days and weeks', () => {
    expect(shift(base, -7, 'd').toISOString()).toBe('2026-08-15T15:30:00.000Z')
    expect(shift(base, 2, 'w').toISOString()).toBe('2026-09-05T15:30:00.000Z')
    expect(shift(base, -3, 'h').toISOString()).toBe('2026-08-22T12:30:00.000Z')
  })

  it('clamps month arithmetic to the end of a short month', () => {
    expect(dateOnly(shift(new Date('2026-01-31T00:00:00Z'), 1, 'm'))).toBe('2026-02-28')
    expect(dateOnly(shift(new Date('2026-03-31T00:00:00Z'), -1, 'm'))).toBe('2026-02-28')
  })

  it('shifts by years', () => {
    expect(dateOnly(shift(base, 1, 'y'))).toBe('2027-08-22')
  })

  it('computes boundaries in UTC', () => {
    expect(startOfDay(base).toISOString()).toBe('2026-08-22T00:00:00.000Z')
    expect(startOfDay(base, -1).toISOString()).toBe('2026-08-21T00:00:00.000Z')
    // ISO weeks start on Monday
    expect(startOfWeek(base).toISOString()).toBe('2026-08-17T00:00:00.000Z')
    expect(startOfWeek(base, -1).toISOString()).toBe('2026-08-10T00:00:00.000Z')
    expect(startOfMonth(base).toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(startOfMonth(base, -2).toISOString()).toBe('2026-06-01T00:00:00.000Z')
  })

  it('parses both plain days and full timestamps', () => {
    expect(parseDateLiteral('2026-08-22')?.toISOString()).toBe('2026-08-22T00:00:00.000Z')
    expect(parseDateLiteral('2026-08-22T10:00:00Z')?.toISOString()).toBe('2026-08-22T10:00:00.000Z')
    expect(parseDateLiteral('not a date')).toBeNull()
  })
})
