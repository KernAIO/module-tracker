import type { Span } from './ast.js'

export type TokenKind =
  | 'ident'
  | 'string'
  | 'number'
  | 'date'
  | 'reldate'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'eof'

export interface Token extends Span {
  kind: TokenKind
  /** raw source text of the token */
  text: string
  /** decoded value: strings without quotes, numbers as numbers */
  value?: string | number
  /** reldate only */
  amount?: number
  unit?: 'h' | 'd' | 'w' | 'm' | 'y'
}

export interface LexError {
  message: string
  start: number
  end: number
}

export interface LexResult {
  tokens: Token[]
  errors: LexError[]
}

/** Two-character operators are matched before single-character ones. */
const OPS2 = ['!=', '<=', '>=', '!~'] as const
const OPS1 = ['=', '<', '>', '~'] as const

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/
const RELDATE_RE = /^[+-]?\d+(?:\.\d+)?[hdwmy](?![\w.])/
const NUMBER_RE = /^[+-]?\d+(?:\.\d+)?/
/** Barewords may contain dots (`cf.severity`) and dashes (`KRN-12`), but must start with a letter. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.]*(?:-[A-Za-z0-9_.]+)*/

const isDigit = (c: string) => c >= '0' && c <= '9'
const isIdentStart = (c: string) => /[A-Za-z_]/.test(c)

/**
 * Turn KQL source into a flat token list. The lexer never throws: anything it cannot read becomes an
 * error with a span, and lexing continues at the next character so the parser can still report
 * everything it understood.
 */
export function tokenize(input: string): LexResult {
  const tokens: Token[] = []
  const errors: LexError[] = []
  let i = 0
  const push = (t: Token) => {
    tokens.push(t)
  }

  while (i < input.length) {
    const c = input[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    const start = i

    if (c === '(') {
      push({ kind: 'lparen', text: c, start, end: ++i })
      continue
    }
    if (c === ')') {
      push({ kind: 'rparen', text: c, start, end: ++i })
      continue
    }
    if (c === ',') {
      push({ kind: 'comma', text: c, start, end: ++i })
      continue
    }

    const two = input.slice(i, i + 2)
    if ((OPS2 as readonly string[]).includes(two)) {
      i += 2
      push({ kind: 'op', text: two, start, end: i })
      continue
    }
    if ((OPS1 as readonly string[]).includes(c)) {
      i += 1
      push({ kind: 'op', text: c, start, end: i })
      continue
    }
    if (c === '!') {
      // a lone `!` is only meaningful in `!=` / `!~`
      errors.push({ message: 'Expected "!=" or "!~"', start, end: start + 1 })
      i++
      continue
    }

    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      let out = ''
      let closed = false
      while (j < input.length) {
        const ch = input[j]!
        if (ch === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc
          j += 2
          continue
        }
        if (ch === quote) {
          closed = true
          j++
          break
        }
        out += ch
        j++
      }
      if (!closed) errors.push({ message: 'Unterminated string', start, end: j })
      push({ kind: 'string', text: input.slice(start, j), value: out, start, end: j })
      i = j
      continue
    }

    if (isDigit(c) || ((c === '-' || c === '+') && isDigit(input[i + 1] ?? ''))) {
      const rest = input.slice(i)
      const dateM = DATE_RE.exec(rest)
      if (dateM) {
        i += dateM[0].length
        push({ kind: 'date', text: dateM[0], value: dateM[0], start, end: i })
        continue
      }
      const relM = RELDATE_RE.exec(rest)
      if (relM) {
        const raw = relM[0]
        i += raw.length
        push({
          kind: 'reldate',
          text: raw,
          amount: Number(raw.slice(0, -1)),
          unit: raw.slice(-1) as Token['unit'],
          start,
          end: i,
        })
        continue
      }
      const numM = NUMBER_RE.exec(rest)
      if (numM) {
        i += numM[0].length
        push({ kind: 'number', text: numM[0], value: Number(numM[0]), start, end: i })
        continue
      }
    }

    if (isIdentStart(c)) {
      const m = IDENT_RE.exec(input.slice(i))!
      i += m[0].length
      push({ kind: 'ident', text: m[0], value: m[0], start, end: i })
      continue
    }

    errors.push({ message: `Unexpected character "${c}"`, start, end: start + 1 })
    i++
  }

  push({ kind: 'eof', text: '', start: input.length, end: input.length })
  return { tokens, errors }
}
