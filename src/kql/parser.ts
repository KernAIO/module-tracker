import type { KqlComparison, KqlExpr, KqlOp, KqlOrder, KqlQuery, KqlValue, Span } from './ast.js'
import { type Token, tokenize } from './lexer.js'

export interface ParseError {
  message: string
  start: number
  end: number
}

export interface ParseResult {
  ok: boolean
  query: KqlQuery | null
  errors: ParseError[]
}

const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'in',
  'is',
  'empty',
  'order',
  'by',
  'asc',
  'desc',
  'true',
  'false',
  'null',
])

const COMPARE_OPS: Record<string, KqlOp> = {
  '=': '=',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '~': '~',
  '!~': '!~',
}

class ParseFailure extends Error {
  constructor(
    message: string,
    readonly span: Span,
  ) {
    super(message)
  }
}

/**
 * Recursive-descent parser for KQL.
 *
 * ```ebnf
 * query      = [ expr ] [ order-clause ] ;
 * expr       = or-expr ;
 * or-expr    = and-expr { "or" and-expr } ;
 * and-expr   = unary { "and" unary } ;
 * unary      = "not" unary | "(" expr ")" | comparison ;
 * comparison = field ( op value
 *                    | "in" "(" value { "," value } ")"
 *                    | "not" "in" "(" value { "," value } ")"
 *                    | "is" [ "not" ] "empty" ) ;
 * op         = "=" | "!=" | "<" | "<=" | ">" | ">=" | "~" | "!~" ;
 * value      = string | number | date | reldate | "true" | "false" | "null" | ident | function ;
 * function   = ident "(" [ value { "," value } ] ")" ;
 * order-clause = "order" "by" order-item { "," order-item } ;
 * order-item = field [ "asc" | "desc" ] ;
 * ```
 */
class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!
  }
  private next(): Token {
    const t = this.peek()
    if (t.kind !== 'eof') this.pos++
    return t
  }
  private atKeyword(word: string, offset = 0): boolean {
    const t = this.peek(offset)
    return t.kind === 'ident' && t.text.toLowerCase() === word
  }
  private eatKeyword(word: string): boolean {
    if (!this.atKeyword(word)) return false
    this.pos++
    return true
  }
  private expectKeyword(word: string): Token {
    const t = this.peek()
    if (!this.eatKeyword(word)) throw new ParseFailure(`Expected "${word}"`, span(t))
    return t
  }
  private expect(kind: Token['kind'], label: string): Token {
    const t = this.peek()
    if (t.kind !== kind) throw new ParseFailure(`Expected ${label}`, span(t))
    return this.next()
  }

  parse(): KqlQuery {
    let where: KqlExpr | null = null
    if (this.peek().kind !== 'eof' && !this.atKeyword('order')) where = this.parseOr()
    const orderBy = this.parseOrderClause()
    const trailing = this.peek()
    if (trailing.kind !== 'eof') throw new ParseFailure(`Unexpected "${trailing.text}"`, span(trailing))
    return { where, orderBy }
  }

  private parseOrderClause(): KqlOrder[] {
    if (!this.atKeyword('order')) return []
    this.next()
    this.expectKeyword('by')
    const out: KqlOrder[] = []
    for (;;) {
      const field = this.peek()
      if (field.kind !== 'ident' || KEYWORDS.has(field.text.toLowerCase()))
        throw new ParseFailure('Expected a field name', span(field))
      this.next()
      let dir: 'asc' | 'desc' = 'asc'
      let end = field.end
      if (this.atKeyword('asc') || this.atKeyword('desc')) {
        const d = this.next()
        dir = d.text.toLowerCase() as 'asc' | 'desc'
        end = d.end
      }
      out.push({ field: field.text, dir, span: { start: field.start, end } })
      if (this.peek().kind === 'comma') {
        this.next()
        continue
      }
      break
    }
    return out
  }

  private parseOr(): KqlExpr {
    const first = this.parseAnd()
    if (!this.atKeyword('or')) return first
    const children = [first]
    while (this.eatKeyword('or')) children.push(this.parseAnd())
    return { kind: 'or', children, span: joinSpans(children) }
  }

  private parseAnd(): KqlExpr {
    const first = this.parseUnary()
    if (!this.atKeyword('and')) return first
    const children = [first]
    while (this.eatKeyword('and')) children.push(this.parseUnary())
    return { kind: 'and', children, span: joinSpans(children) }
  }

  private parseUnary(): KqlExpr {
    // `not` starts a negation only when it is not the `not in` of a comparison
    if (this.atKeyword('not') && !this.atKeyword('in', 1)) {
      const start = this.next().start
      const child = this.parseUnary()
      return { kind: 'not', child, span: { start, end: child.span.end } }
    }
    if (this.peek().kind === 'lparen') {
      this.next()
      const inner = this.parseOr()
      this.expect('rparen', '")"')
      return inner
    }
    return this.parseComparison()
  }

  private parseComparison(): KqlComparison {
    const field = this.peek()
    if (field.kind !== 'ident' || KEYWORDS.has(field.text.toLowerCase()))
      throw new ParseFailure('Expected a field name', span(field))
    this.next()

    const t = this.peek()
    if (t.kind === 'op') {
      const op = COMPARE_OPS[t.text]
      if (!op) throw new ParseFailure(`Unknown operator "${t.text}"`, span(t))
      this.next()
      const value = this.parseValue()
      return {
        kind: 'cmp',
        field: field.text,
        op,
        value,
        values: null,
        span: { start: field.start, end: value.span.end },
      }
    }
    if (this.atKeyword('in') || (this.atKeyword('not') && this.atKeyword('in', 1))) {
      const negated = this.eatKeyword('not')
      this.expectKeyword('in')
      this.expect('lparen', '"("')
      const values: KqlValue[] = []
      if (this.peek().kind !== 'rparen') {
        values.push(this.parseValue())
        while (this.peek().kind === 'comma') {
          this.next()
          values.push(this.parseValue())
        }
      }
      const close = this.expect('rparen', '")"')
      return {
        kind: 'cmp',
        field: field.text,
        op: negated ? 'not-in' : 'in',
        value: null,
        values,
        span: { start: field.start, end: close.end },
      }
    }
    if (this.atKeyword('is')) {
      this.next()
      const negated = this.eatKeyword('not')
      const empty = this.expectKeyword('empty')
      return {
        kind: 'cmp',
        field: field.text,
        op: negated ? 'is-not-empty' : 'is-empty',
        value: null,
        values: null,
        span: { start: field.start, end: empty.end },
      }
    }
    throw new ParseFailure(`Expected an operator after "${field.text}"`, span(t))
  }

  private parseValue(): KqlValue {
    const t = this.peek()
    switch (t.kind) {
      case 'string':
        this.next()
        return { kind: 'string', value: String(t.value ?? ''), span: span(t) }
      case 'number':
        this.next()
        return { kind: 'number', value: Number(t.value), span: span(t) }
      case 'date':
        this.next()
        return { kind: 'date', value: String(t.value), span: span(t) }
      case 'reldate':
        this.next()
        return { kind: 'reldate', amount: t.amount!, unit: t.unit!, span: span(t) }
      case 'ident': {
        const lower = t.text.toLowerCase()
        if (lower === 'true' || lower === 'false') {
          this.next()
          return { kind: 'bool', value: lower === 'true', span: span(t) }
        }
        if (lower === 'null') {
          this.next()
          return { kind: 'null', span: span(t) }
        }
        if (KEYWORDS.has(lower)) throw new ParseFailure(`Expected a value, got "${t.text}"`, span(t))
        this.next()
        if (this.peek().kind === 'lparen') {
          this.next()
          const args: KqlValue[] = []
          if (this.peek().kind !== 'rparen') {
            args.push(this.parseValue())
            while (this.peek().kind === 'comma') {
              this.next()
              args.push(this.parseValue())
            }
          }
          const close = this.expect('rparen', '")"')
          return { kind: 'func', name: t.text, args, span: { start: t.start, end: close.end } }
        }
        return { kind: 'ident', value: t.text, span: span(t) }
      }
      default:
        throw new ParseFailure('Expected a value', span(t))
    }
  }
}

const span = (t: Token): Span => ({ start: t.start, end: t.end })
const joinSpans = (nodes: Array<{ span: Span }>): Span => ({
  start: nodes[0]?.span.start ?? 0,
  end: nodes.at(-1)?.span.end ?? 0,
})

/** Parse a KQL string. Never throws: syntax problems come back as spans in `errors`. */
export function parseKql(input: string): ParseResult {
  const { tokens, errors: lexErrors } = tokenize(input)
  const errors: ParseError[] = [...lexErrors]
  if (!input.trim()) return { ok: errors.length === 0, query: { where: null, orderBy: [] }, errors }
  try {
    const query = new Parser(tokens).parse()
    return { ok: errors.length === 0, query, errors }
  } catch (err) {
    if (err instanceof ParseFailure) {
      errors.push({ message: err.message, start: err.span.start, end: err.span.end })
      return { ok: false, query: null, errors }
    }
    throw err
  }
}
