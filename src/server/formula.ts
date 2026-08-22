/**
 * Formula fields: an expression over the same issue's own values.
 *
 * Deliberately narrow. A formula reads the issue it is on and nothing else — no rollups over
 * children, no references to other issues. That removes the dependency graph and the recompute
 * fan-out entirely, which is the difference between a slice of work and a quarter of it: a value is
 * computed when the issue is written, and nothing else can ever invalidate it.
 *
 * The KQL lexer is not reused. It has no arithmetic and its tokens carry query meanings (`~`, `in`,
 * field kinds), so sharing it would mean teaching one lexer two languages for the sake of a hundred
 * lines.
 *
 * A field is named the way it is named everywhere else: `{estimate}` for a system field,
 * `{cf.story_points}` for a custom one.
 */

export type FormulaValue = number | string | boolean | null

export interface FormulaProblem {
  message: string
  /** index into the source, for pointing at the mistake */
  at: number
}

type Token =
  | { kind: 'number'; value: number; at: number }
  | { kind: 'string'; value: string; at: number }
  | { kind: 'field'; name: string; at: number }
  | { kind: 'name'; value: string; at: number }
  | { kind: 'op'; value: string; at: number }

const OPERATORS = ['<=', '>=', '!=', '==', '+', '-', '*', '/', '%', '(', ')', ',', '<', '>']

function tokenize(source: string): { tokens: Token[]; problems: FormulaProblem[] } {
  const tokens: Token[] = []
  const problems: FormulaProblem[] = []
  let i = 0
  while (i < source.length) {
    const c = source[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    const at = i
    if (c === '{') {
      const end = source.indexOf('}', i)
      if (end === -1) {
        problems.push({ message: 'A field reference is missing its closing brace', at })
        break
      }
      tokens.push({ kind: 'field', name: source.slice(i + 1, end).trim(), at })
      i = end + 1
      continue
    }
    if (c === '"' || c === "'") {
      const end = source.indexOf(c, i + 1)
      if (end === -1) {
        problems.push({ message: 'A piece of text is missing its closing quote', at })
        break
      }
      tokens.push({ kind: 'string', value: source.slice(i + 1, end), at })
      i = end + 1
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < source.length && /[0-9._]/.test(source[j]!)) j++
      const raw = source.slice(i, j).replace(/_/g, '')
      const value = Number(raw)
      if (Number.isNaN(value)) problems.push({ message: `"${raw}" is not a number`, at })
      tokens.push({ kind: 'number', value: Number.isNaN(value) ? 0 : value, at })
      i = j
      continue
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i
      while (j < source.length && /[a-zA-Z0-9_]/.test(source[j]!)) j++
      tokens.push({ kind: 'name', value: source.slice(i, j), at })
      i = j
      continue
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i))
    if (op) {
      tokens.push({ kind: 'op', value: op, at })
      i += op.length
      continue
    }
    problems.push({ message: `"${c}" does not mean anything here`, at })
    i++
  }
  return { tokens, problems }
}

type Node =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'field'; name: string }
  | { type: 'call'; name: string; args: Node[]; at: number }
  | { type: 'unary'; op: string; operand: Node }
  | { type: 'binary'; op: string; left: Node; right: Node }

/** Binding power per operator: comparison loosest, then `+ -`, then `* / %`. */
const BINDING: Record<string, number> = {
  '<': 1,
  '>': 1,
  '<=': 1,
  '>=': 1,
  '==': 1,
  '!=': 1,
  '+': 2,
  '-': 2,
  '*': 3,
  '/': 3,
  '%': 3,
}

/** The functions a formula may call, with how many arguments each takes. */
const FUNCTIONS: Record<string, { min: number; max: number }> = {
  abs: { min: 1, max: 1 },
  round: { min: 1, max: 2 },
  min: { min: 1, max: 8 },
  max: { min: 1, max: 8 },
  coalesce: { min: 1, max: 8 },
  daysbetween: { min: 2, max: 2 },
  if: { min: 3, max: 3 },
  concat: { min: 1, max: 8 },
  length: { min: 1, max: 1 },
}

function parse(source: string): { ast: Node | null; problems: FormulaProblem[]; fields: string[] } {
  const { tokens, problems } = tokenize(source)
  const fields: string[] = []
  let pos = 0
  const peek = () => tokens[pos]
  const fail = (message: string, at: number) => {
    problems.push({ message, at })
  }

  function primary(): Node | null {
    const token = peek()
    if (!token) {
      fail('The formula stops before it finishes', source.length)
      return null
    }
    pos++
    if (token.kind === 'number') return { type: 'number', value: token.value }
    if (token.kind === 'string') return { type: 'string', value: token.value }
    if (token.kind === 'field') {
      if (!token.name) {
        fail('A field reference has no name', token.at)
        return null
      }
      fields.push(token.name)
      return { type: 'field', name: token.name }
    }
    if (token.kind === 'name') {
      const name = token.value.toLowerCase()
      const next = peek()
      if (!next || next.kind !== 'op' || next.value !== '(') {
        if (name === 'true') return { type: 'number', value: 1 }
        if (name === 'false') return { type: 'number', value: 0 }
        fail(`"${token.value}" is not a function. Did you mean {${token.value}}?`, token.at)
        return null
      }
      pos++ // the '('
      const args: Node[] = []
      if (peek()?.kind === 'op' && (peek() as { value: string }).value === ')') pos++
      else {
        for (;;) {
          const arg = expression(0)
          if (!arg) return null
          args.push(arg)
          const sep = peek()
          if (sep?.kind === 'op' && sep.value === ',') {
            pos++
            continue
          }
          if (sep?.kind === 'op' && sep.value === ')') {
            pos++
            break
          }
          fail('Expected a comma or a closing bracket', sep?.at ?? source.length)
          return null
        }
      }
      const spec = FUNCTIONS[name]
      if (!spec) fail(`There is no function called "${token.value}"`, token.at)
      else if (args.length < spec.min || args.length > spec.max)
        fail(`"${token.value}" does not take ${args.length} argument(s)`, token.at)
      return { type: 'call', name, args, at: token.at }
    }
    if (token.value === '(') {
      const inner = expression(0)
      const close = peek()
      if (close?.kind === 'op' && close.value === ')') pos++
      else fail('A bracket is never closed', token.at)
      return inner
    }
    if (token.value === '-') {
      const operand = expression(4)
      return operand ? { type: 'unary', op: '-', operand } : null
    }
    fail(`"${token.value}" cannot start a value`, token.at)
    return null
  }

  function expression(minBinding: number): Node | null {
    let left = primary()
    if (!left) return null
    for (;;) {
      const token = peek()
      if (!token || token.kind !== 'op') break
      const binding = BINDING[token.value]
      if (binding === undefined || binding < minBinding) break
      pos++
      const right = expression(binding + 1)
      if (!right) return null
      left = { type: 'binary', op: token.value, left, right }
    }
    return left
  }

  const ast = expression(0)
  if (ast && pos < tokens.length) fail('There is something extra after the formula', tokens[pos]!.at)
  return { ast: problems.length ? null : ast, problems, fields }
}

/** The fields a formula reads, whether or not it parses cleanly. */
export function formulaReferences(source: string): string[] {
  return [...new Set(parse(source).fields)]
}

/** Is this a formula the evaluator can run? Returns every problem, not just the first. */
export function validateFormula(source: string): { ok: boolean; problems: FormulaProblem[] } {
  const { problems } = parse(source)
  return { ok: problems.length === 0, problems }
}

const asNumber = (value: FormulaValue): number | null => {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isNaN(n) ? null : n
  }
  return null
}

const asDate = (value: FormulaValue): number | null => {
  if (typeof value !== 'string') return null
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : t
}

const DAY = 86_400_000

function evaluate(node: Node, read: (name: string) => FormulaValue): FormulaValue {
  switch (node.type) {
    case 'number':
      return node.value
    case 'string':
      return node.value
    case 'field':
      return read(node.name)
    case 'unary': {
      const n = asNumber(evaluate(node.operand, read))
      return n === null ? null : -n
    }
    case 'binary': {
      const left = evaluate(node.left, read)
      const right = evaluate(node.right, read)
      if (['==', '!='].includes(node.op)) {
        const same = JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
        return node.op === '==' ? same : !same
      }
      if (node.op === '+' && (typeof left === 'string' || typeof right === 'string'))
        return `${left ?? ''}${right ?? ''}`
      const a = asNumber(left)
      const b = asNumber(right)
      // A missing value makes the whole expression empty rather than zero: a story with no estimate
      // has no doubled estimate either, and pretending it is 0 would put it top of a sort.
      if (a === null || b === null) return null
      switch (node.op) {
        case '+':
          return a + b
        case '-':
          return a - b
        case '*':
          return a * b
        case '/':
          return b === 0 ? null : a / b
        case '%':
          return b === 0 ? null : a % b
        case '<':
          return a < b
        case '>':
          return a > b
        case '<=':
          return a <= b
        case '>=':
          return a >= b
        default:
          return null
      }
    }
    case 'call': {
      const args = node.args.map((a) => evaluate(a, read))
      switch (node.name) {
        case 'abs': {
          const n = asNumber(args[0] ?? null)
          return n === null ? null : Math.abs(n)
        }
        case 'round': {
          const n = asNumber(args[0] ?? null)
          if (n === null) return null
          const places = asNumber(args[1] ?? 0) ?? 0
          const factor = 10 ** Math.max(0, Math.min(6, Math.trunc(places)))
          return Math.round(n * factor) / factor
        }
        case 'min':
        case 'max': {
          const numbers = args.map(asNumber).filter((n): n is number => n !== null)
          if (!numbers.length) return null
          return node.name === 'min' ? Math.min(...numbers) : Math.max(...numbers)
        }
        case 'coalesce':
          return args.find((a) => a !== null && a !== '') ?? null
        case 'daysbetween': {
          const from = asDate(args[0] ?? null)
          const to = asDate(args[1] ?? null)
          if (from === null || to === null) return null
          return Math.round((to - from) / DAY)
        }
        case 'if':
          return args[0] ? (args[1] ?? null) : (args[2] ?? null)
        case 'concat':
          return args.map((a) => (a === null ? '' : String(a))).join('')
        case 'length': {
          const value = args[0]
          return value === null || value === undefined ? null : String(value).length
        }
        default:
          return null
      }
    }
  }
}

/**
 * Run a formula. Returns `null` for anything it cannot compute — a missing value, a division by
 * zero, a date that will not parse — rather than throwing or inventing a zero.
 */
export function runFormula(source: string, read: (name: string) => FormulaValue): FormulaValue {
  const { ast } = parse(source)
  if (!ast) return null
  try {
    return evaluate(ast, read)
  } catch {
    return null
  }
}
