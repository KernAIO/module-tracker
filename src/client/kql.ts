import type { KqlError, KqlSuggestion } from '@kernhq/module-tracker/contract'
import type { KqlExpr, KqlOp, KqlOrder, KqlQuery, KqlValue, Span } from '@kernhq/module-tracker/kql'
import {
  customKqlField,
  findField,
  KQL_FUNCTIONS,
  type KqlField,
  operatorsFor,
  printQuery,
  SYSTEM_FIELDS,
} from '@kernhq/module-tracker/kql'

/**
 * A KQL reader for the query box.
 *
 * The server is the authority: it parses the same grammar and compiles it to SQL. This one exists so
 * the input can underline a mistake and offer the next token while you type, without a round trip
 * per keystroke, and so the mock backend can answer queries at all. It produces the same
 * `KqlParseResult` shape the `kql.parse` procedure returns, so a component can be switched from one
 * to the other without changing anything else.
 */

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type TokenKind = 'ident' | 'string' | 'number' | 'date' | 'reldate' | 'op' | 'punct' | 'eof'

interface Token {
  kind: TokenKind
  /** the source text, with quotes stripped for strings */
  text: string
  raw: string
  start: number
  end: number
}

const OPERATORS = ['!=', '!~', '<=', '>=', '=', '<', '>', '~']
const IDENT_START = /[A-Za-z_]/
const IDENT_BODY = /[A-Za-z0-9_.\-/]/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const RELDATE = /^[+-]?\d+(?:\.\d+)?([hdwmy])$/

/** Words that end a bareword value and start a new clause. */
const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'is', 'empty', 'order', 'by', 'asc', 'desc'])

function lex(src: string): { tokens: Token[]; errors: KqlError[] } {
  const tokens: Token[] = []
  const errors: KqlError[] = []
  let i = 0

  while (i < src.length) {
    const ch = src[i] as string
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }

    if (ch === '"' || ch === "'") {
      const start = i
      const quote = ch
      let value = ''
      i++
      let closed = false
      while (i < src.length) {
        const c = src[i] as string
        if (c === '\\' && i + 1 < src.length) {
          value += src[i + 1]
          i += 2
          continue
        }
        if (c === quote) {
          i++
          closed = true
          break
        }
        value += c
        i++
      }
      if (!closed) errors.push({ message: 'Unclosed quote', start, end: src.length })
      tokens.push({ kind: 'string', text: value, raw: src.slice(start, i), start, end: i })
      continue
    }

    if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ kind: 'punct', text: ch, raw: ch, start: i, end: i + 1 })
      i++
      continue
    }

    const op = OPERATORS.find((o) => src.startsWith(o, i))
    if (op) {
      tokens.push({ kind: 'op', text: op, raw: op, start: i, end: i + op.length })
      i += op.length
      continue
    }

    // numbers, dates and relative dates all start with a digit or a sign
    if (/[0-9]/.test(ch) || ((ch === '-' || ch === '+') && /[0-9]/.test(src[i + 1] ?? ''))) {
      const start = i
      i++
      while (i < src.length && /[0-9.:\-a-zA-Z]/.test(src[i] as string)) i++
      const raw = src.slice(start, i)
      const kind: TokenKind = DATE.test(raw) ? 'date' : RELDATE.test(raw) ? 'reldate' : 'number'
      if (kind === 'number' && !/^[+-]?\d+(\.\d+)?$/.test(raw)) {
        errors.push({ message: `Not a number, date or relative date: ${raw}`, start, end: i })
      }
      tokens.push({ kind, text: raw, raw, start, end: i })
      continue
    }

    if (IDENT_START.test(ch)) {
      const start = i
      while (i < src.length && IDENT_BODY.test(src[i] as string)) i++
      const raw = src.slice(start, i)
      tokens.push({ kind: 'ident', text: raw, raw, start, end: i })
      continue
    }

    errors.push({ message: `Unexpected character ${JSON.stringify(ch)}`, start: i, end: i + 1 })
    i++
  }

  tokens.push({ kind: 'eof', text: '', raw: '', start: src.length, end: src.length })
  return { tokens, errors }
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

class Parser {
  private pos = 0
  readonly errors: KqlError[] = []

  constructor(
    private readonly tokens: Token[],
    private readonly fields: readonly KqlField[],
  ) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)] as Token
  }
  private next(): Token {
    const t = this.peek()
    if (t.kind !== 'eof') this.pos++
    return t
  }
  private isWord(word: string, offset = 0): boolean {
    const t = this.peek(offset)
    return t.kind === 'ident' && t.text.toLowerCase() === word
  }
  private eatWord(word: string): boolean {
    if (!this.isWord(word)) return false
    this.pos++
    return true
  }
  private error(message: string, token = this.peek()) {
    this.errors.push({ message, start: token.start, end: Math.max(token.end, token.start + 1) })
  }
  private span(from: Token, to = this.peek(-1)): Span {
    return { start: from.start, end: Math.max(to.end, from.end) }
  }

  parseQuery(): KqlQuery {
    const where = this.peek().kind === 'eof' || this.isWord('order') ? null : this.parseOr()
    const orderBy = this.parseOrderBy()
    if (this.peek().kind !== 'eof') {
      this.error(`Unexpected ${JSON.stringify(this.peek().raw)}`)
    }
    return { where, orderBy }
  }

  private parseOrderBy(): KqlOrder[] {
    if (!this.isWord('order')) return []
    const start = this.next()
    if (!this.eatWord('by')) this.error('Expected "by" after "order"')
    const out: KqlOrder[] = []
    for (;;) {
      const token = this.peek()
      if (token.kind !== 'ident') {
        this.error('Expected a field to order by')
        break
      }
      this.next()
      const field = this.checkField(token, { sortable: true })
      let dir: 'asc' | 'desc' = 'asc'
      if (this.eatWord('desc')) dir = 'desc'
      else this.eatWord('asc')
      out.push({ field: field?.name ?? token.text, dir, span: this.span(token) })
      if (this.peek().text === ',') {
        this.next()
        continue
      }
      break
    }
    if (out.length === 0) this.error('Expected at least one field after "order by"', start)
    return out
  }

  private parseOr(): KqlExpr {
    const first = this.peek()
    const children = [this.parseAnd()]
    while (this.eatWord('or')) children.push(this.parseAnd())
    return children.length === 1 ? (children[0] as KqlExpr) : { kind: 'or', children, span: this.span(first) }
  }

  private parseAnd(): KqlExpr {
    const first = this.peek()
    const children = [this.parseUnary()]
    while (this.eatWord('and')) children.push(this.parseUnary())
    return children.length === 1
      ? (children[0] as KqlExpr)
      : { kind: 'and', children, span: this.span(first) }
  }

  private parseUnary(): KqlExpr {
    const first = this.peek()
    if (this.eatWord('not')) {
      return { kind: 'not', child: this.parseUnary(), span: this.span(first) }
    }
    if (first.text === '(') {
      this.next()
      const inner = this.parseOr()
      if (this.peek().text === ')') this.next()
      else this.error('Expected ")"')
      return inner
    }
    return this.parseComparison()
  }

  private parseComparison(): KqlExpr {
    const fieldToken = this.peek()
    if (fieldToken.kind !== 'ident') {
      this.error(fieldToken.kind === 'eof' ? 'Expected a field' : `Expected a field, got ${fieldToken.raw}`)
      this.next()
      return { kind: 'cmp', field: '', op: '=', value: null, values: null, span: this.span(fieldToken) }
    }
    this.next()
    const field = this.checkField(fieldToken)
    // normalise to the field's canonical spelling so a saved query reads the same however it was typed
    const name = field?.name ?? fieldToken.text

    // `field is empty` / `field is not empty`
    if (this.isWord('is')) {
      this.next()
      const negated = this.eatWord('not')
      if (!this.eatWord('empty')) this.error('Expected "empty" after "is"')
      const op: KqlOp = negated ? 'is-not-empty' : 'is-empty'
      this.checkOperator(field, op, fieldToken)
      return { kind: 'cmp', field: name, op, value: null, values: null, span: this.span(fieldToken) }
    }

    // `field in (a, b)` / `field not in (a, b)`
    if (this.isWord('in') || (this.isWord('not') && this.isWord('in', 1))) {
      const op: KqlOp = this.isWord('not') ? 'not-in' : 'in'
      if (op === 'not-in') this.next()
      this.next()
      const values = this.parseValueList(field)
      this.checkOperator(field, op, fieldToken)
      return { kind: 'cmp', field: name, op, value: null, values, span: this.span(fieldToken) }
    }

    const opToken = this.peek()
    if (opToken.kind !== 'op') {
      this.error('Expected an operator such as =, !=, ~ or "in"', opToken)
      return { kind: 'cmp', field: name, op: '=', value: null, values: null, span: this.span(fieldToken) }
    }
    this.next()
    const op = opToken.text as KqlOp
    this.checkOperator(field, op, opToken)
    const value = this.parseValue(field)
    return { kind: 'cmp', field: name, op, value, values: null, span: this.span(fieldToken) }
  }

  private parseValueList(field: KqlField | undefined): KqlValue[] {
    const values: KqlValue[] = []
    if (this.peek().text !== '(') {
      this.error('Expected "(" after "in"')
      return values
    }
    this.next()
    if (this.peek().text === ')') {
      this.error('Expected at least one value')
      this.next()
      return values
    }
    for (;;) {
      values.push(this.parseValue(field))
      if (this.peek().text === ',') {
        this.next()
        continue
      }
      break
    }
    if (this.peek().text === ')') this.next()
    else this.error('Expected ")"')
    return values
  }

  private parseValue(field: KqlField | undefined): KqlValue {
    const token = this.next()
    const span: Span = { start: token.start, end: token.end }
    switch (token.kind) {
      case 'string':
        return { kind: 'string', value: token.text, span }
      case 'number':
        return { kind: 'number', value: Number(token.text), span }
      case 'date':
        return { kind: 'date', value: token.text, span }
      case 'reldate': {
        const m = RELDATE.exec(token.text)
        return {
          kind: 'reldate',
          amount: Number.parseFloat(token.text),
          unit: (m?.[1] ?? 'd') as 'h' | 'd' | 'w' | 'm' | 'y',
          span,
        }
      }
      case 'ident': {
        const lower = token.text.toLowerCase()
        if (this.peek().text === '(') return this.parseFunction(token)
        if (lower === 'true' || lower === 'false') return { kind: 'bool', value: lower === 'true', span }
        if (lower === 'null' || lower === 'empty') return { kind: 'null', span }
        if (KEYWORDS.has(lower)) this.error(`Expected a value, got the keyword "${token.text}"`, token)
        else this.checkEnumValue(field, token)
        return { kind: 'ident', value: token.text, span }
      }
      default:
        this.error('Expected a value', token)
        return { kind: 'null', span }
    }
  }

  private parseFunction(nameToken: Token): KqlValue {
    const known = KQL_FUNCTIONS.find((f) => f.name.toLowerCase() === nameToken.text.toLowerCase())
    if (!known) this.error(`Unknown function ${nameToken.text}()`, nameToken)
    this.next() // (
    const args: KqlValue[] = []
    if (this.peek().text !== ')') {
      for (;;) {
        args.push(this.parseValue(undefined))
        if (this.peek().text === ',') {
          this.next()
          continue
        }
        break
      }
    }
    if (this.peek().text === ')') this.next()
    else this.error('Expected ")"')
    return {
      kind: 'func',
      name: known?.name ?? nameToken.text,
      args,
      span: { start: nameToken.start, end: this.peek(-1).end },
    }
  }

  private checkField(token: Token, opts: { sortable?: boolean } = {}): KqlField | undefined {
    const field = findField(this.fields, token.text)
    if (!field) {
      this.error(`Unknown field "${token.text}"`, token)
      return undefined
    }
    if (opts.sortable && field.sortable !== true) {
      this.error(`"${field.name}" cannot be sorted on`, token)
    }
    return field
  }

  private checkOperator(field: KqlField | undefined, op: KqlOp, token: Token) {
    if (!field) return
    if (!operatorsFor(field).includes(op)) {
      this.error(`"${field.name}" does not support ${printOp(op)}`, token)
    }
  }

  private checkEnumValue(field: KqlField | undefined, token: Token) {
    if (!field?.enumValues) return
    if (!field.enumValues.some((v) => v.toLowerCase() === token.text.toLowerCase())) {
      this.error(`"${token.text}" is not a valid ${field.label.toLowerCase()}`, token)
    }
  }
}

function printOp(op: KqlOp): string {
  return op === 'is-empty' ? '"is empty"' : op === 'is-not-empty' ? '"is not empty"' : `"${op}"`
}

// ---------------------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------------------

export interface ParseOptions {
  /** system fields plus any `cf.*` custom fields the workspace defines */
  fields?: readonly KqlField[]
  /** caret offset, used to decide what to suggest next */
  cursor?: number
}

export interface ParsedKql {
  ok: boolean
  ast: KqlQuery | null
  errors: KqlError[]
  normalized: string | null
  suggestions: KqlSuggestion[]
}

/** Parse and validate a KQL string. Empty input is valid and matches everything. */
export function parseKql(source: string, opts: ParseOptions = {}): ParsedKql {
  const fields = opts.fields ?? SYSTEM_FIELDS
  const { tokens, errors: lexErrors } = lex(source)
  const parser = new Parser(tokens, fields)
  const ast = parser.parseQuery()
  const errors = [...lexErrors, ...parser.errors].sort((a, b) => a.start - b.start)
  const ok = errors.length === 0
  return {
    ok,
    ast: ok ? ast : null,
    errors,
    normalized: ok ? printQuery(ast) : null,
    suggestions: suggest(tokens, fields, opts.cursor ?? source.length),
  }
}

/**
 * What could come next at the caret.
 *
 * The grammar is regular enough that the token before the caret decides the answer: nothing or a
 * connective means a field is expected, a field means an operator, an operator means a value.
 */
function suggest(tokens: Token[], fields: readonly KqlField[], cursor: number): KqlSuggestion[] {
  const before = tokens.filter((t) => t.kind !== 'eof' && t.end <= cursor)
  // a token the caret sits inside is being typed, so it filters rather than terminates
  const typing = tokens.find((t) => t.kind !== 'eof' && t.start < cursor && t.end >= cursor)
  const prefix = typing && typing.end === cursor ? typing.text.toLowerCase() : ''
  const anchor = prefix ? before[before.length - 2] : before[before.length - 1]

  const matches = (label: string) => !prefix || label.toLowerCase().startsWith(prefix)
  const fieldSuggestions = (): KqlSuggestion[] =>
    fields
      .filter((f) => matches(f.name))
      .map((f) => ({
        kind: 'field' as const,
        label: f.name,
        insertText: `${f.name} `,
        detail: f.label,
      }))

  if (!anchor) return fieldSuggestions()

  if (
    anchor.kind === 'op' ||
    (anchor.kind === 'ident' && ['in', 'not'].includes(anchor.text.toLowerCase()))
  ) {
    const fieldToken = [...before].reverse().find((t) => t.kind === 'ident' && findField(fields, t.text))
    const field = fieldToken ? findField(fields, fieldToken.text) : undefined
    const values: KqlSuggestion[] = (field?.enumValues ?? [])
      .filter((v) => matches(v))
      .map((v) => ({ kind: 'value' as const, label: v, insertText: `${v} `, detail: field?.label }))
    const functions: KqlSuggestion[] = KQL_FUNCTIONS.filter((f) => matches(f.name)).map((f) => ({
      kind: 'function' as const,
      label: `${f.name}()`,
      insertText: `${f.name}() `,
      detail: f.detail,
    }))
    return [...values, ...functions]
  }

  if (anchor.kind === 'ident') {
    const lower = anchor.text.toLowerCase()
    if (KEYWORDS.has(lower)) return fieldSuggestions()
    const field = findField(fields, anchor.text)
    if (field) {
      const ops: KqlSuggestion[] = operatorsFor(field)
        .map((op) => (op === 'is-empty' ? 'is empty' : op === 'is-not-empty' ? 'is not empty' : op))
        .filter((op) => matches(op))
        .map((op) => ({ kind: 'operator' as const, label: op, insertText: `${op} ` }))
      return ops
    }
  }

  // after a complete clause the only sensible continuations are connectives
  return ['and', 'or', 'order by']
    .filter((k) => matches(k))
    .map((k) => ({ kind: 'keyword' as const, label: k, insertText: `${k} ` }))
}

export type {
  KqlComparison,
  KqlExpr,
  KqlOp,
  KqlOrder,
  KqlQuery,
  KqlValue,
  Span,
} from '@kernhq/module-tracker/kql'
export type { KqlField }
export { customKqlField, operatorsFor, SYSTEM_FIELDS }
