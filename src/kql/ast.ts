/**
 * KQL — Kern Query Language (JQL-like) abstract syntax tree.
 * Produced by `parse()`, consumed by the SQL compiler and the visual filter builder.
 */

export type KqlOp =
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '~'
  | '!~'
  | 'in'
  | 'not-in'
  | 'is-empty'
  | 'is-not-empty'

export interface Span {
  start: number
  end: number
}

export type KqlValue =
  | { kind: 'string'; value: string; span: Span }
  | { kind: 'number'; value: number; span: Span }
  | { kind: 'date'; value: string; span: Span }
  /** relative date `-7d` / `+2w`; units d(ay) w(eek) m(onth) y(ear), h(our) */
  | { kind: 'reldate'; amount: number; unit: 'h' | 'd' | 'w' | 'm' | 'y'; span: Span }
  | { kind: 'bool'; value: boolean; span: Span }
  | { kind: 'null'; span: Span }
  /** bareword like `done` or `high` */
  | { kind: 'ident'; value: string; span: Span }
  /** function call: currentUser(), membersOf("qa"), startOfWeek(-1) */
  | { kind: 'func'; name: string; args: KqlValue[]; span: Span }

export type KqlExpr =
  | { kind: 'and'; children: KqlExpr[]; span: Span }
  | { kind: 'or'; children: KqlExpr[]; span: Span }
  | { kind: 'not'; child: KqlExpr; span: Span }
  | KqlComparison

export interface KqlComparison {
  kind: 'cmp'
  field: string
  op: KqlOp
  /** absent for is-empty / is-not-empty */
  value: KqlValue | null
  /** list for in / not-in */
  values: KqlValue[] | null
  span: Span
}

export interface KqlOrder {
  field: string
  dir: 'asc' | 'desc'
  span: Span
}

export interface KqlQuery {
  where: KqlExpr | null
  orderBy: KqlOrder[]
}

/** Walk every comparison in an expression. */
export function walkComparisons(expr: KqlExpr | null, fn: (cmp: KqlComparison) => void): void {
  if (!expr) return
  if (expr.kind === 'cmp') fn(expr)
  else if (expr.kind === 'not') walkComparisons(expr.child, fn)
  else for (const c of expr.children) walkComparisons(c, fn)
}

/** Collect field names used in where + order by. */
export function fieldsUsed(query: KqlQuery): string[] {
  const out = new Set<string>()
  walkComparisons(query.where, (c) => out.add(c.field))
  for (const o of query.orderBy) out.add(o.field)
  return [...out]
}

/** Pretty-print a value back to KQL text. */
export function printValue(v: KqlValue): string {
  switch (v.kind) {
    case 'string':
      return JSON.stringify(v.value)
    case 'number':
      return String(v.value)
    case 'date':
      return v.value
    case 'reldate':
      return `${v.amount >= 0 ? '+' : ''}${v.amount}${v.unit}`
    case 'bool':
      return v.value ? 'true' : 'false'
    case 'null':
      return 'null'
    case 'ident':
      return /^[A-Za-z0-9_.-]+$/.test(v.value) ? v.value : JSON.stringify(v.value)
    case 'func':
      return `${v.name}(${v.args.map(printValue).join(', ')})`
  }
}

/** Pretty-print a whole query (normalised form). */
export function printQuery(query: KqlQuery): string {
  const expr = (e: KqlExpr, parent?: 'and' | 'or'): string => {
    switch (e.kind) {
      case 'cmp': {
        if (e.op === 'is-empty') return `${e.field} is empty`
        if (e.op === 'is-not-empty') return `${e.field} is not empty`
        if (e.op === 'in' || e.op === 'not-in')
          return `${e.field} ${e.op === 'in' ? 'in' : 'not in'} (${(e.values ?? []).map(printValue).join(', ')})`
        return `${e.field} ${e.op} ${e.value ? printValue(e.value) : ''}`.trim()
      }
      case 'not': {
        const inner = expr(e.child)
        return e.child.kind === 'cmp' ? `not ${inner}` : `not (${inner})`
      }
      case 'and': {
        const s = e.children.map((c) => expr(c, 'and')).join(' and ')
        return parent === 'or' ? s : s
      }
      case 'or': {
        const s = e.children.map((c) => expr(c, 'or')).join(' or ')
        return parent === 'and' ? `(${s})` : s
      }
    }
  }
  const parts: string[] = []
  if (query.where) parts.push(expr(query.where))
  if (query.orderBy.length)
    parts.push(
      `order by ${query.orderBy.map((o) => `${o.field}${o.dir === 'desc' ? ' desc' : ''}`).join(', ')}`,
    )
  return parts.join(' ')
}
