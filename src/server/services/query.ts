import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx } from '@kernhq/kernel'
import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import type {
  FieldType,
  GroupBy,
  Issue,
  IssueQueryInput,
  IssueQueryResult,
  KqlFieldInfo,
  KqlParseResult,
  OrderBy,
} from '../../contract/models.js'
import { fieldsUsed, printQuery } from '../../kql/ast.js'
import { customKqlField, type KqlField, operatorsFor, SYSTEM_FIELDS } from '../../kql/fields.js'
import { parseKql } from '../../kql/parser.js'
import { suggest } from '../../kql/suggest.js'
import { validateQuery } from '../../kql/validate.js'
import {
  type CompileContext,
  collectRefs,
  compileOrder,
  compileWhere,
  emptyLookup,
  KqlCompileError,
  type RefLookup,
  usesCycleFunctions,
} from '../kql/compile.js'
import {
  components,
  cycles,
  issues,
  labels,
  milestones,
  projects,
  versions,
  workItemTypes,
} from '../schema.js'
import type { AccessService } from './access.js'
import type { ConfigService } from './config.js'
import type { IssueService } from './issues.js'

/** Group keys that live in a uuid[] column and therefore need `unnest` to count. */
const ARRAY_GROUPS: Partial<Record<GroupBy, SQL>> = {
  assignee: sql`${issues.assigneeIds}`,
  label: sql`${issues.labelIds}`,
  component: sql`${issues.componentIds}`,
  version: sql`${issues.versionIds}`,
}

const SCALAR_GROUPS: Partial<Record<GroupBy, SQL>> = {
  status: sql`${issues.statusId}`,
  statusCategory: sql`${issues.statusCategory}`,
  priority: sql`${issues.priority}`,
  type: sql`${issues.typeId}`,
  cycle: sql`${issues.cycleId}`,
  milestone: sql`${issues.milestoneId}`,
  project: sql`${issues.projectId}`,
  parent: sql`${issues.parentId}`,
  dueDate: sql`${issues.dueDate}::text`,
  createdAt: sql`${issues.createdAt}::date::text`,
}

const DEFAULT_ORDER: OrderBy[] = [{ field: 'rank', dir: 'asc' }]

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url')
const decodeCursor = (cursor?: string): number => {
  if (!cursor) return 0
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: number }
    return Math.max(0, Number(parsed.o ?? 0))
  } catch {
    throw KernError.badRequest('Invalid cursor')
  }
}

/** Everything behind `issues.query` and the KQL endpoints. */
export class QueryService {
  constructor(
    private readonly kernel: Kernel,
    private readonly access: AccessService,
    private readonly config: ConfigService,
    private readonly issuesService: IssueService,
  ) {}

  /** System fields plus one `cf.<key>` entry per custom field visible in these projects. */
  async kqlFields(tx: Tx, workspaceId: string, projectIds: string[]): Promise<KqlField[]> {
    const defs = await this.config.fieldsForProjects(tx, workspaceId, projectIds)
    const custom = defs.map((d) => customKqlField(d.key, d.type, d.name))
    const seen = new Set(SYSTEM_FIELDS.map((f) => f.name))
    return [...SYSTEM_FIELDS, ...custom.filter((f) => !seen.has(f.name))]
  }

  async fieldInfo(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectIds?: string[],
  ): Promise<KqlFieldInfo[]> {
    const visible = await this.access.visibleProjectIds(tx, principal, workspaceId, { only: projectIds })
    const fields = await this.kqlFields(tx, workspaceId, visible)
    const statuses = await this.config.statusesForProject(tx, workspaceId, visible[0])
    const types = await this.config.listTypes(tx, workspaceId, {})
    const defs = await this.config.fieldsForProjects(tx, workspaceId, visible)
    const optionsByKey = new Map(defs.map((d) => [d.key, d.options]))
    return fields.map((field) => {
      const values = (() => {
        if (field.name === 'status') return statuses.map((s) => ({ value: s.id, label: s.name }))
        if (field.name === 'type') return types.map((t) => ({ value: t.id, label: t.name }))
        if (field.enumValues) return field.enumValues.map((v) => ({ value: v, label: v }))
        if (field.custom) {
          const options = optionsByKey.get(field.custom.key) ?? []
          return options.map((o) => ({ value: o.id, label: o.label }))
        }
        return undefined
      })()
      return {
        name: field.name,
        type: field.kind,
        label: field.label,
        operators: operatorsFor(field),
        ...(values?.length ? { values } : {}),
        custom: !!field.custom,
        sortable: field.sortable ?? false,
      }
    })
  }

  async parse(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    kql: string,
    projectIds?: string[],
  ): Promise<KqlParseResult> {
    const visible = await this.access.visibleProjectIds(tx, principal, workspaceId, { only: projectIds })
    const fields = await this.kqlFields(tx, workspaceId, visible)
    const parsed = parseKql(kql)
    const suggestions = suggest(kql, fields)
    if (!parsed.query) return { ok: false, ast: null, errors: parsed.errors, normalized: null, suggestions }
    const issuesFound = validateQuery(parsed.query, fields)
    const errors = [...parsed.errors, ...issuesFound]
    return {
      ok: errors.length === 0,
      ast: parsed.query,
      errors,
      normalized: printQuery(parsed.query),
      suggestions,
    }
  }

  // ------------------------------------------------------------------ execution

  async query(tx: Tx, principal: Principal, input: IssueQueryInput): Promise<IssueQueryResult> {
    const workspaceId = input.workspaceId
    const visible = await this.access.visibleProjectIds(tx, principal, workspaceId, {
      includeArchived: input.includeArchived,
      ...(input.projectIds?.length ? { only: input.projectIds } : {}),
    })
    const parsed = parseKql(input.kql ?? '')
    if (!parsed.query || parsed.errors.length)
      throw KernError.badRequest(parsed.errors[0]?.message ?? 'Invalid query', { errors: parsed.errors })
    const fields = await this.kqlFields(tx, workspaceId, visible)
    const problems = validateQuery(parsed.query, fields)
    if (problems.length) throw KernError.badRequest(problems[0]!.message, { errors: problems })

    const used = fieldsUsed(parsed.query)
    if (!visible.length)
      return { items: [], nextCursor: null, fields: used, ...(input.include.total ? { total: 0 } : {}) }

    const ctx = await this.compileContext(tx, workspaceId, visible, principal, parsed.query, fields)
    let where: SQL | undefined
    try {
      where = compileWhere(parsed.query, ctx)
    } catch (err) {
      if (err instanceof KqlCompileError) throw KernError.badRequest(err.message)
      throw err
    }

    const base = [eq(issues.workspaceId, workspaceId), inArray(issues.projectId, visible)]
    if (!input.includeArchived) base.push(isNull(issues.archivedAt))
    if (where) base.push(where)
    const condition = and(...base)!

    const orderBy = input.orderBy?.length ? input.orderBy : toOrderBy(parsed.query.orderBy)
    const order = [...orderBy.map((o) => compileOrder(o.field, o.dir, ctx)), sql`${issues.id} asc`]
    const offset = decodeCursor(input.cursor)

    const rows = await tx
      .select()
      .from(issues)
      .where(condition)
      .orderBy(...order)
      .limit(input.limit + 1)
      .offset(offset)
    const page = rows.slice(0, input.limit)
    const items: Issue[] = await this.issuesService.hydrate(tx, page)

    const result: IssueQueryResult = {
      items,
      nextCursor: rows.length > input.limit ? encodeCursor(offset + input.limit) : null,
      fields: used,
    }
    if (input.include.total) {
      const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(issues).where(condition)
      result.total = row?.n ?? 0
    }
    if (input.include.groupCounts && input.groupBy && input.groupBy !== 'none')
      result.groups = await this.groupCounts(tx, condition, input.groupBy)
    return result
  }

  private async groupCounts(
    tx: Tx,
    condition: SQL,
    groupBy: GroupBy,
  ): Promise<Array<{ key: string | null; count: number; estimate: number | null }>> {
    const arrayColumn = ARRAY_GROUPS[groupBy]
    const statement = arrayColumn
      ? sql`select g.key::text as key, count(*)::int as count, sum(${issues.estimate}) as estimate
            from ${issues}, lateral unnest(${arrayColumn}) as g(key)
            where ${condition} group by 1 order by 2 desc`
      : sql`select ${SCALAR_GROUPS[groupBy] ?? sql`null::text`} as key, count(*)::int as count, sum(${issues.estimate}) as estimate
            from ${issues} where ${condition} group by 1 order by 2 desc`
    const rows = await tx.execute<{ key: string | null; count: number; estimate: string | null }>(statement)
    return rows.rows.map((r) => ({
      key: r.key ?? null,
      count: Number(r.count),
      estimate: r.estimate === null ? null : Number(r.estimate),
    }))
  }

  /** Resolve every name the query mentions (labels, statuses, users…) before compiling. */
  private async compileContext(
    tx: Tx,
    workspaceId: string,
    projectIds: string[],
    principal: Principal,
    query: ReturnType<typeof parseKql>['query'],
    fields: KqlField[],
  ): Promise<CompileContext> {
    const lookup: RefLookup = emptyLookup()
    const customTypes = new Map<string, FieldType>()
    for (const field of fields) if (field.custom) customTypes.set(field.custom.key, field.custom.fieldType)
    if (!query) return { fields, lookup, userId: principal.userId, now: new Date(), customTypes }

    const requests = collectRefs(query, fields)
    const wanted = new Map<string, Set<string>>()
    for (const request of requests) {
      const set = wanted.get(request.refType) ?? new Set<string>()
      set.add(request.text.toLowerCase())
      wanted.set(request.refType, set)
    }

    const put = (refType: string, name: string, id: string) => {
      const map = lookup.byType.get(refType) ?? new Map<string, string[]>()
      const key = name.toLowerCase()
      map.set(key, [...(map.get(key) ?? []), id])
      lookup.byType.set(refType, map)
    }

    if (wanted.has('project')) {
      const rows = await tx
        .select({ id: projects.id, key: projects.key, name: projects.name })
        .from(projects)
        .where(eq(projects.workspaceId, workspaceId))
      for (const row of rows) {
        put('project', row.key, row.id)
        put('project', row.name, row.id)
        put('project', row.id, row.id)
      }
    }
    if (wanted.has('type')) {
      const rows = await tx
        .select({ id: workItemTypes.id, key: workItemTypes.key, name: workItemTypes.name })
        .from(workItemTypes)
        .where(eq(workItemTypes.workspaceId, workspaceId))
      for (const row of rows) {
        put('type', row.key, row.id)
        put('type', row.name, row.id)
      }
    }
    if (wanted.has('label')) {
      const rows = await tx
        .select({ id: labels.id, name: labels.name })
        .from(labels)
        .where(eq(labels.workspaceId, workspaceId))
      for (const row of rows) put('label', row.name, row.id)
    }
    if (wanted.has('component')) {
      const rows = await tx
        .select({ id: components.id, name: components.name })
        .from(components)
        .where(eq(components.workspaceId, workspaceId))
      for (const row of rows) put('component', row.name, row.id)
    }
    if (wanted.has('version')) {
      const rows = await tx
        .select({ id: versions.id, name: versions.name })
        .from(versions)
        .where(eq(versions.workspaceId, workspaceId))
      for (const row of rows) put('version', row.name, row.id)
    }
    if (wanted.has('milestone')) {
      const rows = await tx
        .select({ id: milestones.id, name: milestones.name })
        .from(milestones)
        .where(eq(milestones.workspaceId, workspaceId))
      for (const row of rows) put('milestone', row.name, row.id)
    }
    if (wanted.has('cycle') || usesCycleFunctions(query)) {
      const rows = await tx
        .select({ id: cycles.id, name: cycles.name, status: cycles.status, projectId: cycles.projectId })
        .from(cycles)
        .where(eq(cycles.workspaceId, workspaceId))
      for (const row of rows) {
        put('cycle', row.name, row.id)
        if (!projectIds.includes(row.projectId)) continue
        if (row.status === 'active') lookup.activeCycleIds.push(row.id)
        if (row.status === 'active' || row.status === 'upcoming') lookup.openCycleIds.push(row.id)
      }
    }
    if (wanted.has('status')) {
      const statuses = await this.config.statusesForProject(tx, workspaceId, projectIds[0])
      for (const status of statuses) {
        put('status', status.id, status.id)
        put('status', status.name, status.id)
      }
    }
    if (wanted.has('issue')) {
      const keys = [...(wanted.get('issue') ?? [])].map((k) => k.toUpperCase())
      if (keys.length) {
        const rows = await tx
          .select({ id: issues.id, key: issues.key })
          .from(issues)
          .where(and(eq(issues.workspaceId, workspaceId), inArray(issues.key, keys)))
        for (const row of rows) put('issue', row.key, row.id)
      }
    }
    if (wanted.has('user')) {
      // user names/emails resolve through core; raw uuids and currentUser() always work
      const names = [...(wanted.get('user') ?? [])]
      const members = await this.kernel
        .call<Array<{ userId: string; email?: string; name?: string }>>('core.workspaces.members', {
          workspaceId,
        })
        .catch(() => [])
      for (const member of members ?? []) {
        if (member.email) put('user', member.email, member.userId)
        if (member.name) put('user', member.name, member.userId)
        put('user', member.userId, member.userId)
      }
      void names
    }

    return { fields, lookup, userId: principal.userId, now: new Date(), customTypes }
  }
}

const toOrderBy = (orders: Array<{ field: string; dir: 'asc' | 'desc' }>): OrderBy[] =>
  orders.length ? orders.map((o) => ({ field: o.field, dir: o.dir })) : DEFAULT_ORDER
