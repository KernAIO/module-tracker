import type { KqlComparison, KqlQuery, KqlValue } from './ast.js'
import { walkComparisons } from './ast.js'
import { findField, KQL_FUNCTIONS, type KqlField, operatorsFor } from './fields.js'

export interface KqlIssue {
  message: string
  start: number
  end: number
}

const FUNCTIONS = new Map(KQL_FUNCTIONS.map((f) => [f.name.toLowerCase(), f]))

const argCountOk = (spec: number | string, got: number): boolean =>
  typeof spec === 'number' ? got === spec : spec === '0-1' ? got <= 1 : true

/** Semantic checks: known fields, operators the field supports, plausible values, known functions. */
export function validateQuery(query: KqlQuery, fields: readonly KqlField[]): KqlIssue[] {
  const issues: KqlIssue[] = []
  walkComparisons(query.where, (cmp) => issues.push(...checkComparison(cmp, fields)))
  for (const order of query.orderBy) {
    const field = findField(fields, order.field)
    if (!field) {
      issues.push({ message: `Unknown field "${order.field}"`, ...order.span })
      continue
    }
    // only fields explicitly marked sortable have a deterministic column to order by
    if (!field.sortable) issues.push({ message: `Field "${order.field}" cannot be sorted on`, ...order.span })
  }
  return issues
}

function checkComparison(cmp: KqlComparison, fields: readonly KqlField[]): KqlIssue[] {
  const issues: KqlIssue[] = []
  const field = findField(fields, cmp.field)
  if (!field) {
    return [{ message: `Unknown field "${cmp.field}"`, start: cmp.span.start, end: cmp.span.end }]
  }
  const allowed = operatorsFor(field)
  if (!allowed.includes(cmp.op))
    issues.push({
      message: `Operator "${cmp.op}" is not supported for "${field.name}" (try ${allowed.join(', ')})`,
      start: cmp.span.start,
      end: cmp.span.end,
    })
  for (const v of [cmp.value, ...(cmp.values ?? [])]) if (v) issues.push(...checkValue(v, field))
  return issues
}

function checkValue(value: KqlValue, field: KqlField): KqlIssue[] {
  if (value.kind === 'func') {
    const spec = FUNCTIONS.get(value.name.toLowerCase())
    if (!spec) return [{ message: `Unknown function "${value.name}()"`, ...value.span }]
    if (!argCountOk(spec.args, value.args.length))
      return [{ message: `${value.name}() expects ${spec.args} argument(s)`, ...value.span }]
    return []
  }
  if (value.kind === 'null') return []
  switch (field.kind) {
    case 'number':
      if (value.kind !== 'number') return [{ message: `"${field.name}" expects a number`, ...value.span }]
      return []
    case 'boolean':
      if (value.kind !== 'bool') return [{ message: `"${field.name}" expects true or false`, ...value.span }]
      return []
    case 'date':
    case 'datetime':
      if (value.kind !== 'date' && value.kind !== 'reldate')
        return [
          {
            message: `"${field.name}" expects a date (2026-08-22), a relative date (-7d) or a function`,
            ...value.span,
          },
        ]
      return []
    case 'enum': {
      const text = value.kind === 'string' || value.kind === 'ident' ? String(value.value) : null
      if (text && field.enumValues && !field.enumValues.includes(text.toLowerCase()))
        return [
          {
            message: `"${text}" is not a valid ${field.name} (${field.enumValues.join(', ')})`,
            ...value.span,
          },
        ]
      return []
    }
    default:
      return []
  }
}
