import { type SQL, sql } from 'drizzle-orm'
import type { FieldType } from '../../contract/models.js'
import type { KqlComparison, KqlExpr, KqlOp, KqlQuery, KqlValue } from '../../kql/ast.js'
import { walkComparisons } from '../../kql/ast.js'
import { parseDateLiteral, shift, startOfDay, startOfMonth, startOfWeek } from '../../kql/dates.js'
import { findField, type KqlField } from '../../kql/fields.js'
import { issues } from '../schema.js'

/** Names a query mentions that have to be looked up before it can be compiled. */
export interface RefRequest {
  refType: NonNullable<KqlField['refType']> | 'user' | 'group'
  /** raw text as written in the query */
  text: string
}

/** Result of resolving every {@link RefRequest}: `refType` → lower-cased name → matching ids. */
export interface RefLookup {
  byType: Map<string, Map<string, string[]>>
  /** cycles of the queried projects, for `activeCycle()` / `openCycles()` */
  activeCycleIds: string[]
  openCycleIds: string[]
}

export const emptyLookup = (): RefLookup => ({
  byType: new Map(),
  activeCycleIds: [],
  openCycleIds: [],
})

export interface CompileContext {
  fields: readonly KqlField[]
  lookup: RefLookup
  userId: string | null
  now: Date
  /** custom field key → declared type, for casting `cf.*` comparisons */
  customTypes: Map<string, FieldType>
}

export class KqlCompileError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const FALSE = sql`false`
const TRUE = sql`true`

/** Collect every reference (label name, status name, user…) the query needs resolved. */
export function collectRefs(query: KqlQuery, fields: readonly KqlField[]): RefRequest[] {
  const out: RefRequest[] = []
  const add = (refType: RefRequest['refType'], value: KqlValue) => {
    if (value.kind === 'string' || value.kind === 'ident') out.push({ refType, text: String(value.value) })
    else if (value.kind === 'func' && value.name.toLowerCase() === 'membersof')
      for (const a of value.args)
        if (a.kind === 'string' || a.kind === 'ident') out.push({ refType: 'group', text: String(a.value) })
  }
  walkComparisons(query.where, (cmp) => {
    const field = findField(fields, cmp.field)
    if (!field) return
    const refType: RefRequest['refType'] | null = field.refType ?? (field.kind === 'user' ? 'user' : null)
    if (!refType) return
    for (const v of [cmp.value, ...(cmp.values ?? [])]) if (v) add(refType, v)
  })
  return out
}

/** True when the query needs the active/open cycle ids of the queried projects. */
export function usesCycleFunctions(query: KqlQuery): boolean {
  let used = false
  walkComparisons(query.where, (cmp) => {
    for (const v of [cmp.value, ...(cmp.values ?? [])])
      if (v?.kind === 'func' && ['activecycle', 'opencycles'].includes(v.name.toLowerCase())) used = true
  })
  return used
}

// =====================================================================================
// column descriptors
// =====================================================================================

type ExprKind =
  | 'text'
  | 'key'
  | 'uuid'
  | 'uuidArray'
  | 'enum'
  | 'priority'
  | 'timestamp'
  | 'date'
  | 'number'
  | 'bool'
  | 'fulltext'

interface FieldSql {
  expr: SQL
  kind: ExprKind
}

const PRIORITY_RANK = sql`case ${issues.priority} when 'urgent' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end`

const SYSTEM_SQL: Record<string, FieldSql> = {
  key: { expr: sql`${issues.key}`, kind: 'key' },
  project: { expr: sql`${issues.projectId}`, kind: 'uuid' },
  type: { expr: sql`${issues.typeId}`, kind: 'uuid' },
  title: { expr: sql`${issues.title}`, kind: 'text' },
  status: { expr: sql`${issues.statusId}`, kind: 'enum' },
  statuscategory: { expr: sql`${issues.statusCategory}`, kind: 'enum' },
  priority: { expr: PRIORITY_RANK, kind: 'priority' },
  assignee: { expr: sql`${issues.assigneeIds}`, kind: 'uuidArray' },
  reporter: { expr: sql`${issues.reporterId}`, kind: 'uuid' },
  label: { expr: sql`${issues.labelIds}`, kind: 'uuidArray' },
  component: { expr: sql`${issues.componentIds}`, kind: 'uuidArray' },
  version: { expr: sql`${issues.versionIds}`, kind: 'uuidArray' },
  affectsversion: { expr: sql`${issues.affectsVersionIds}`, kind: 'uuidArray' },
  cycle: { expr: sql`${issues.cycleId}`, kind: 'uuid' },
  milestone: { expr: sql`${issues.milestoneId}`, kind: 'uuid' },
  parent: { expr: sql`${issues.parentId}`, kind: 'uuid' },
  created: { expr: sql`${issues.createdAt}`, kind: 'timestamp' },
  updated: { expr: sql`${issues.updatedAt}`, kind: 'timestamp' },
  completed: { expr: sql`${issues.completedAt}`, kind: 'timestamp' },
  due: { expr: sql`${issues.dueDate}`, kind: 'date' },
  start: { expr: sql`${issues.startDate}`, kind: 'date' },
  estimate: { expr: sql`${issues.estimate}`, kind: 'number' },
  timespent: { expr: sql`${issues.timeSpentSec}`, kind: 'number' },
  watcher: { expr: sql`${issues.watcherIds}`, kind: 'uuidArray' },
  resolution: { expr: sql`${issues.resolution}`, kind: 'text' },
  text: { expr: sql`${issues.search}`, kind: 'fulltext' },
  triage: { expr: sql`${issues.triage}`, kind: 'bool' },
  archived: { expr: sql`(${issues.archivedAt} is not null)`, kind: 'bool' },
  rank: { expr: sql`${issues.rank}`, kind: 'text' },
}

const CUSTOM_KIND: Record<FieldType, ExprKind> = {
  text: 'text',
  textarea: 'text',
  number: 'number',
  date: 'date',
  datetime: 'timestamp',
  select: 'enum',
  multiselect: 'text',
  user: 'uuid',
  multiuser: 'text',
  label: 'text',
  url: 'text',
  checkbox: 'bool',
  relation: 'text',
  formula: 'number',
}

/** Custom field types whose value is a JSON array, so KQL compares them with containment. */
const CUSTOM_ARRAY: ReadonlySet<FieldType> = new Set([
  'multiselect',
  'multiuser',
  'label',
  // a relation always stores string[], even when relationMultiple is false; without this it
  // compiled as scalar text and silently matched nothing
  'relation',
])

function customExpr(key: string, type: FieldType): SQL {
  switch (type) {
    case 'number':
    case 'formula':
      return sql`nullif(${issues.custom}->>${key}, '')::numeric`
    case 'date':
      return sql`nullif(${issues.custom}->>${key}, '')::date`
    case 'datetime':
      return sql`nullif(${issues.custom}->>${key}, '')::timestamptz`
    case 'checkbox':
      return sql`nullif(${issues.custom}->>${key}, '')::boolean`
    default:
      return sql`${issues.custom}->>${key}`
  }
}

/** The SQL expression a KQL field name maps to, or null when the field is unknown. */
export function fieldSql(name: string, ctx: CompileContext): (FieldSql & { field: KqlField }) | null {
  const field = findField(ctx.fields, name)
  if (!field) return null
  if (field.custom) {
    const type = ctx.customTypes.get(field.custom.key) ?? field.custom.fieldType
    return { field, expr: customExpr(field.custom.key, type), kind: CUSTOM_KIND[type] }
  }
  const sys = SYSTEM_SQL[field.name.toLowerCase()]
  return sys ? { ...sys, field } : null
}

// =====================================================================================
// value resolution
// =====================================================================================

function idsFor(ctx: CompileContext, refType: string, text: string): string[] {
  const map = ctx.lookup.byType.get(refType)
  const hit = map?.get(text.toLowerCase())
  if (hit?.length) return hit
  return UUID_RE.test(text) ? [text] : []
}

/** Resolve a KQL value used against a uuid / ref field into concrete ids. */
function resolveIds(value: KqlValue, field: KqlField, ctx: CompileContext): string[] {
  if (value.kind === 'func') {
    const name = value.name.toLowerCase()
    if (name === 'currentuser') return ctx.userId ? [ctx.userId] : []
    if (name === 'activecycle') return ctx.lookup.activeCycleIds
    if (name === 'opencycles') return ctx.lookup.openCycleIds
    if (name === 'membersof') {
      const arg = value.args[0]
      const key = arg && (arg.kind === 'string' || arg.kind === 'ident') ? String(arg.value) : ''
      return idsFor(ctx, 'group', key)
    }
    return []
  }
  if (value.kind === 'string' || value.kind === 'ident') {
    const refType = field.refType ?? (field.kind === 'user' ? 'user' : null)
    return refType ? idsFor(ctx, refType, String(value.value)) : [String(value.value)]
  }
  if (value.kind === 'number') return [String(value.value)]
  return []
}

/** Resolve a KQL value used against a date/timestamp field into an instant. */
function resolveInstant(value: KqlValue, ctx: CompileContext): { at: Date; dayPrecision: boolean } | null {
  if (value.kind === 'date') {
    const at = parseDateLiteral(value.value)
    return at ? { at, dayPrecision: /^\d{4}-\d{2}-\d{2}$/.test(value.value) } : null
  }
  if (value.kind === 'reldate') return { at: shift(ctx.now, value.amount, value.unit), dayPrecision: false }
  if (value.kind === 'func') {
    const arg = value.args[0]
    const offset = arg?.kind === 'number' ? arg.value : 0
    switch (value.name.toLowerCase()) {
      case 'now':
        return { at: ctx.now, dayPrecision: false }
      case 'startofday':
        return { at: startOfDay(ctx.now, offset), dayPrecision: false }
      case 'startofweek':
        return { at: startOfWeek(ctx.now, offset), dayPrecision: false }
      case 'startofmonth':
        return { at: startOfMonth(ctx.now, offset), dayPrecision: false }
      default:
        return null
    }
  }
  return null
}

const literalText = (value: KqlValue): string =>
  value.kind === 'string' || value.kind === 'ident'
    ? String(value.value)
    : value.kind === 'number'
      ? String(value.value)
      : value.kind === 'bool'
        ? String(value.value)
        : value.kind === 'date'
          ? value.value
          : ''

// =====================================================================================
// comparison compilation
// =====================================================================================

const negate = (condition: SQL, negated: boolean) => (negated ? sql`(not (${condition}))` : condition)

function compareOrdered(expr: SQL, op: KqlOp, param: SQL): SQL {
  switch (op) {
    case '=':
      return sql`${expr} = ${param}`
    case '!=':
      return sql`(${expr} is distinct from ${param})`
    case '<':
      return sql`${expr} < ${param}`
    case '<=':
      return sql`${expr} <= ${param}`
    case '>':
      return sql`${expr} > ${param}`
    case '>=':
      return sql`${expr} >= ${param}`
    default:
      throw new KqlCompileError(`Operator "${op}" is not supported here`)
  }
}

function compileComparison(cmp: KqlComparison, ctx: CompileContext): SQL {
  const target = fieldSql(cmp.field, ctx)
  if (!target) throw new KqlCompileError(`Unknown field "${cmp.field}"`)
  const { expr, kind, field } = target
  const isArrayCustom = !!field.custom && CUSTOM_ARRAY.has(field.custom.fieldType)

  if (cmp.op === 'is-empty' || cmp.op === 'is-not-empty') {
    const empty =
      kind === 'uuidArray'
        ? sql`coalesce(array_length(${expr}, 1), 0) = 0`
        : isArrayCustom
          ? sql`(${issues.custom}->${field.custom!.key} is null or jsonb_array_length(coalesce(${issues.custom}->${field.custom!.key}, '[]'::jsonb)) = 0)`
          : kind === 'text' || kind === 'key' || kind === 'enum'
            ? sql`(${expr} is null or ${expr} = '')`
            : sql`${expr} is null`
    return cmp.op === 'is-empty' ? empty : sql`(not (${empty}))`
  }

  const values = cmp.values ?? (cmp.value ? [cmp.value] : [])
  if (!values.length) throw new KqlCompileError(`"${cmp.field}" needs a value`)
  const negated = cmp.op === '!=' || cmp.op === 'not-in' || cmp.op === '!~'
  const membership = cmp.op === 'in' || cmp.op === 'not-in' || cmp.op === '=' || cmp.op === '!='

  // `null` means "unset" for every field
  if (values.length === 1 && values[0]!.kind === 'null') return negate(sql`${expr} is null`, negated)

  switch (kind) {
    case 'uuidArray': {
      const ids = values.flatMap((v) => resolveIds(v, field, ctx))
      if (!ids.length) return negate(FALSE, negated)
      return negate(sql`${expr} && ${sql.param(ids)}::uuid[]`, negated)
    }
    case 'uuid': {
      const ids = values.flatMap((v) => resolveIds(v, field, ctx))
      if (!ids.length) return negate(FALSE, negated)
      return negate(sql`${expr} = any(${sql.param(ids)}::uuid[])`, negated)
    }
    case 'priority': {
      const ranks = values.map((v) => priorityRank(literalText(v)))
      if (membership) {
        if (ranks.some((r) => r === null)) throw new KqlCompileError('Unknown priority')
        return negate(sql`${expr} = any(${sql.param(ranks)}::int[])`, negated)
      }
      const rank = ranks[0]
      if (rank === null) throw new KqlCompileError('Unknown priority')
      return compareOrdered(expr, cmp.op, sql`${rank}`)
    }
    case 'enum': {
      if (field.name.toLowerCase() === 'status') {
        const ids = values.flatMap((v) => resolveIds(v, field, ctx))
        if (!ids.length) return negate(FALSE, negated)
        return negate(sql`${expr} = any(${sql.param(ids)}::text[])`, negated)
      }
      const texts = values.map((v) => literalText(v).toLowerCase())
      if (!membership) return compareOrdered(expr, cmp.op, sql`${texts[0]}`)
      return negate(sql`lower(${expr}) = any(${sql.param(texts)}::text[])`, negated)
    }
    case 'number': {
      const nums = values.map((v) => (v.kind === 'number' ? v.value : Number(literalText(v))))
      if (nums.some((n) => Number.isNaN(n))) throw new KqlCompileError(`"${cmp.field}" expects a number`)
      if (!membership) return compareOrdered(expr, cmp.op, sql`${nums[0]}`)
      return negate(sql`${expr} = any(${sql.param(nums)}::numeric[])`, negated)
    }
    case 'bool': {
      const v = values[0]!
      const bool = v.kind === 'bool' ? v.value : literalText(v).toLowerCase() === 'true'
      return negate(sql`coalesce(${expr}, false) = ${bool}`, negated)
    }
    case 'timestamp':
    case 'date': {
      const resolved = values.map((v) => resolveInstant(v, ctx))
      const first = resolved[0]
      if (!first) throw new KqlCompileError(`"${cmp.field}" expects a date`)
      const isDateColumn = kind === 'date'
      const param = (at: Date) =>
        isDateColumn ? sql`${at.toISOString().slice(0, 10)}::date` : sql`${at.toISOString()}::timestamptz`
      if (cmp.op === '=' || cmp.op === '!=') {
        // a plain day means the whole day, not one instant
        if (first.dayPrecision && !isDateColumn) {
          const next = new Date(first.at.getTime() + 86_400_000)
          return negate(sql`(${expr} >= ${param(first.at)} and ${expr} < ${param(next)})`, negated)
        }
        return negate(sql`${expr} = ${param(first.at)}`, negated)
      }
      if (cmp.op === 'in' || cmp.op === 'not-in') {
        const parts = resolved.filter(Boolean).map((r) => sql`${expr} = ${param(r!.at)}`)
        return negate(sql`(${sql.join(parts, sql` or `)})`, negated)
      }
      return compareOrdered(expr, cmp.op, param(first.at))
    }
    case 'fulltext': {
      const q = values.map(literalText).join(' ')
      return negate(sql`${expr} @@ plainto_tsquery('simple', ${q})`, negated)
    }
    case 'key': {
      const texts = values.map((v) => literalText(v).toUpperCase())
      if (cmp.op === '~' || cmp.op === '!~') return negate(sql`${expr} ilike ${`%${texts[0]}%`}`, negated)
      return negate(sql`${expr} = any(${sql.param(texts)}::text[])`, negated)
    }
    default: {
      // text-ish, including array-valued custom fields
      if (isArrayCustom) {
        const texts = values.map(literalText)
        const contains = sql`coalesce(${issues.custom}->${field.custom!.key}, '[]'::jsonb) @> ${JSON.stringify(texts.slice(0, 1))}::jsonb`
        if (cmp.op === 'in' || cmp.op === 'not-in') {
          const parts = texts.map(
            (t) =>
              sql`coalesce(${issues.custom}->${field.custom!.key}, '[]'::jsonb) @> ${JSON.stringify([t])}::jsonb`,
          )
          return negate(sql`(${sql.join(parts, sql` or `)})`, negated)
        }
        return negate(contains, negated)
      }
      const texts = values.map(literalText)
      if (cmp.op === '~' || cmp.op === '!~') return negate(sql`${expr} ilike ${`%${texts[0]}%`}`, negated)
      if (!membership) return compareOrdered(expr, cmp.op, sql`${texts[0]}`)
      return negate(sql`${expr} = any(${sql.param(texts)}::text[])`, negated)
    }
  }
}

const priorityRank = (text: string): number | null =>
  ({ none: 0, low: 1, medium: 2, high: 3, urgent: 4 })[text.toLowerCase()] ?? null

function compileExpr(expr: KqlExpr, ctx: CompileContext): SQL {
  switch (expr.kind) {
    case 'cmp':
      return compileComparison(expr, ctx)
    case 'not':
      return sql`(not (${compileExpr(expr.child, ctx)}))`
    case 'and':
      return sql`(${sql.join(
        expr.children.map((c) => compileExpr(c, ctx)),
        sql` and `,
      )})`
    case 'or':
      return sql`(${sql.join(
        expr.children.map((c) => compileExpr(c, ctx)),
        sql` or `,
      )})`
  }
}

/** Compile the `where` part of a parsed query. Returns undefined for an empty query. */
export function compileWhere(query: KqlQuery, ctx: CompileContext): SQL | undefined {
  if (!query.where) return undefined
  return compileExpr(query.where, ctx)
}

/** Compile one sort key. Unknown fields fall back to `rank`. */
export function compileOrder(field: string, dir: 'asc' | 'desc', ctx: CompileContext): SQL {
  const target = fieldSql(field, ctx)
  const expr = target?.expr ?? sql`${issues.rank}`
  const direction = dir === 'desc' ? sql`desc` : sql`asc`
  // sorting must be deterministic even when the key is null
  return sql`${expr} ${direction} nulls last`
}

export { FALSE as sqlFalse, TRUE as sqlTrue }
