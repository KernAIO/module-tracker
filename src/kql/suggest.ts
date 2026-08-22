import type { KqlSuggestion } from '../contract/models.js'
import { findField, KQL_FUNCTIONS, type KqlField, operatorsFor } from './fields.js'
import { tokenize } from './lexer.js'

const KEYWORD_TOKENS = new Set(['and', 'or', 'not', 'in', 'is', 'empty', 'order', 'by', 'asc', 'desc'])

const fieldSuggestion = (f: KqlField): KqlSuggestion => ({
  kind: 'field',
  label: f.name,
  insertText: f.name,
  detail: f.label,
})

const opSuggestion = (op: string): KqlSuggestion => ({ kind: 'operator', label: op, insertText: op })

const valueSuggestions = (field: KqlField): KqlSuggestion[] => {
  const out: KqlSuggestion[] = []
  for (const v of field.enumValues ?? []) out.push({ kind: 'value', label: v, insertText: v })
  if (field.kind === 'user')
    out.push({ kind: 'function', label: 'currentUser()', insertText: 'currentUser()', detail: 'You' })
  if (field.kind === 'date' || field.kind === 'datetime')
    for (const f of KQL_FUNCTIONS)
      if (['now', 'startOfDay', 'startOfWeek', 'startOfMonth'].includes(f.name))
        out.push({ kind: 'function', label: `${f.name}()`, insertText: `${f.name}()`, detail: f.detail })
  if (field.refType === 'cycle')
    for (const name of ['activeCycle', 'openCycles'])
      out.push({ kind: 'function', label: `${name}()`, insertText: `${name}()` })
  if (field.kind === 'boolean')
    for (const v of ['true', 'false']) out.push({ kind: 'value', label: v, insertText: v })
  return out
}

/**
 * Autocomplete for a KQL editor. Looks only at the tokens before `cursor`, so it works on
 * half-written queries the parser would reject.
 */
export function suggest(input: string, fields: readonly KqlField[], cursor?: number): KqlSuggestion[] {
  const at = cursor ?? input.length
  const head = input.slice(0, at)
  const { tokens } = tokenize(head)
  const real = tokens.filter((t) => t.kind !== 'eof')
  const last = real.at(-1)
  const prev = real.at(-2)

  const matchFields = (prefix: string) =>
    fields
      .filter((f) => f.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .slice(0, 40)
      .map(fieldSuggestion)

  // nothing typed yet, or the query continues after a connective / open paren
  const startsNewTerm =
    !last ||
    last.kind === 'lparen' ||
    (last.kind === 'ident' && ['and', 'or', 'not'].includes(last.text.toLowerCase()))
  if (startsNewTerm) return matchFields('')

  // the caret sits inside a bareword
  if (last.kind === 'ident' && last.end === at) {
    const word = last.text.toLowerCase()
    // after `field <op>` a bareword is a value, not a field
    if (prev?.kind === 'op' || (prev?.kind === 'ident' && ['in', 'is'].includes(prev.text.toLowerCase()))) {
      const fieldTok = fieldTokenBefore(real, real.length - 2)
      const field = fieldTok ? findField(fields, fieldTok) : undefined
      return field ? valueSuggestions(field).filter((s) => s.label.toLowerCase().startsWith(word)) : []
    }
    if (KEYWORD_TOKENS.has(word)) return matchFields('')
    const exact = findField(fields, last.text)
    if (exact) return operatorsFor(exact).map(opSuggestion)
    return matchFields(last.text)
  }

  // right after an operator → values of the field on its left
  if (last.kind === 'op' || (last.kind === 'ident' && ['in', 'is'].includes(last.text.toLowerCase()))) {
    const fieldTok = fieldTokenBefore(real, real.length - 2)
    const field = fieldTok ? findField(fields, fieldTok) : undefined
    return field ? valueSuggestions(field) : []
  }
  if (last.kind === 'lparen' || last.kind === 'comma') {
    const fieldTok = fieldTokenBefore(real, real.length - 1)
    const field = fieldTok ? findField(fields, fieldTok) : undefined
    return field ? valueSuggestions(field) : matchFields('')
  }

  // a complete term: offer connectives
  return [
    { kind: 'keyword', label: 'and', insertText: ' and ' },
    { kind: 'keyword', label: 'or', insertText: ' or ' },
    { kind: 'keyword', label: 'order by', insertText: ' order by ' },
  ]
}

/** Walk left from `from` to the nearest bareword that is not a keyword — the field of this comparison. */
function fieldTokenBefore(tokens: ReturnType<typeof tokenize>['tokens'], from: number): string | null {
  for (let i = from; i >= 0; i--) {
    const t = tokens[i]
    if (t?.kind !== 'ident') continue
    if (KEYWORD_TOKENS.has(t.text.toLowerCase())) continue
    return t.text
  }
  return null
}
