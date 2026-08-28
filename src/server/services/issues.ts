import type { ObjectRef, Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { initialStatus, RESOLVED_CATEGORIES, type WorkflowDefinition } from '@kernhq/workflow'
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { trackerEvents } from '../../contract/events.js'
import {
  type Attachment,
  type BulkResult,
  type CreateIssue,
  type Issue,
  type IssueHistoryEntry,
  type IssueTemplate,
  type Link,
  MODULE_ID,
  type Priority,
  type ProjectSettings,
  RELATION_INVERSE,
  type RecurringIssue,
  type RelationSummary,
  type RelationType,
  type RelationView,
  type RichDoc,
  type SlaState,
  type StatusHistoryEntry,
  type UpdateIssue,
  type UpsertIssueTemplate as UpsertIssueTemplateSchema,
  type UpsertRecurringIssue as UpsertRecurringIssueSchema,
} from '../../contract/models.js'
import { initialRank, rankBetween } from '../rank.js'
import { docToText, extractMentions, preview } from '../rich.js'
import {
  attachments,
  comments,
  components,
  cycles,
  issueApprovals,
  issueCounters,
  issueHistory,
  issueStatusHistory,
  issues,
  issueTemplates,
  labels,
  links,
  milestones,
  projects,
  recurringIssues,
  relations,
  timers,
  versions,
  workItemTypes,
  worklogs,
} from '../schema.js'
import type { AccessService } from './access.js'
import type { ConfigService } from './config.js'
import {
  added,
  EMPTY_RELATION_SUMMARY,
  type IssueRow,
  issueUrl,
  type ProjectRow,
  parseSettings,
  removed,
  toAttachment,
  toHistoryEntry,
  toIssue,
  toIssueSummary,
  toIssueTemplate,
  toLink,
  toRecurringIssue,
  toStatusHistoryEntry,
  uniq,
} from './db.js'
import type { NotifyService } from './notify.js'
import { normaliseCustom } from './values.js'

type UpsertIssueTemplate = z.infer<typeof UpsertIssueTemplateSchema>
type UpsertRecurringIssue = z.infer<typeof UpsertRecurringIssueSchema>

export interface CreateOptions {
  source?: Issue['source']
  externalRef?: string | null
  /** skip permission checks: intake, email ingest and imports run as the system */
  system?: boolean
  triage?: boolean
}

const objectRef = (id: string): ObjectRef => ({ module: MODULE_ID, type: 'issue', id })

/** Issue columns a formula may read, so a change to one recomputes the formulas that use it. */
const FORMULA_TRIGGERS = ['estimate', 'priority', 'startDate', 'dueDate', 'title'] as const

/** Issues and everything attached to them: relations, attachments, links, watchers, history. */
export class IssueService {
  constructor(
    private readonly kernel: Kernel,
    private readonly access: AccessService,
    private readonly config: ConfigService,
    private readonly notify: NotifyService,
  ) {}

  // ------------------------------------------------------------------ reads

  async row(tx: Tx, workspaceId: string, issueId: string): Promise<IssueRow> {
    const [row] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, issueId)))
      .limit(1)
    if (!row) throw KernError.notFound('Issue')
    return row
  }

  /** Relation and sub-item counters for a page of issues, in two aggregate queries. */
  async relationSummaries(tx: Tx, ids: string[]): Promise<Map<string, RelationSummary>> {
    const out = new Map<string, RelationSummary>()
    if (!ids.length) return out
    for (const id of ids) out.set(id, { ...EMPTY_RELATION_SUMMARY })
    const rel = await tx.execute<{
      issue_id: string
      type: string
      n: number
      open: number
    }>(sql`
      select r.${sql.raw('from_issue_id')} as issue_id, r.type, count(*)::int as n,
             count(*) filter (where t.status_category not in ('done', 'cancelled'))::int as open
      from ${relations} r join ${issues} t on t.id = r.${sql.raw('to_issue_id')}
      where r.${sql.raw('from_issue_id')} = any(${sql.param(ids)}::uuid[])
      group by 1, 2`)
    for (const r of rel.rows) {
      const entry = out.get(r.issue_id)
      if (!entry) continue
      const n = Number(r.n)
      if (r.type === 'blocks') entry.blocks += n
      else if (r.type === 'blocked_by') {
        entry.blockedBy += n
        entry.openBlockers += Number(r.open)
      } else if (r.type === 'relates') entry.relates += n
      else if (r.type === 'duplicates' || r.type === 'duplicated_by') entry.duplicates += n
    }
    const subs = await tx.execute<{ parent_id: string; total: number; done: number }>(sql`
      select ${issues.parentId} as parent_id, count(*)::int as total,
             count(*) filter (where ${issues.statusCategory} in ('done', 'cancelled'))::int as done
      from ${issues}
      where ${issues.parentId} = any(${sql.param(ids)}::uuid[]) and ${issues.archivedAt} is null
      group by 1`)
    for (const r of subs.rows) {
      const entry = out.get(r.parent_id)
      if (!entry) continue
      entry.subItems = Number(r.total)
      entry.subItemsDone = Number(r.done)
    }
    return out
  }

  async hydrate(tx: Tx, rows: IssueRow[]): Promise<Issue[]> {
    const summaries = await this.relationSummaries(
      tx,
      rows.map((r) => r.id),
    )
    return rows.map((r) => toIssue(r, summaries.get(r.id)))
  }

  async get(tx: Tx, principal: Principal, workspaceId: string, issueId: string): Promise<Issue> {
    const row = await this.row(tx, workspaceId, issueId)
    await this.access.requireProject(tx, principal, workspaceId, row.projectId, 'tracker.issue.view')
    return (await this.hydrate(tx, [row]))[0]!
  }

  async getByKey(tx: Tx, principal: Principal, workspaceId: string, key: string): Promise<Issue> {
    const [row] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.key, key.toUpperCase())))
      .limit(1)
    if (!row) throw KernError.notFound('Issue')
    await this.access.requireProject(tx, principal, workspaceId, row.projectId, 'tracker.issue.view')
    return (await this.hydrate(tx, [row]))[0]!
  }

  async getMany(tx: Tx, principal: Principal, workspaceId: string, ids: string[]): Promise<Issue[]> {
    if (!ids.length) return []
    const rows = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.workspaceId, workspaceId), inArray(issues.id, ids)))
    const allowed = new Set(
      await this.access.visibleProjectIds(tx, principal, workspaceId, { includeArchived: true }),
    )
    const visible = rows.filter((r) => allowed.has(r.projectId))
    const hydrated = await this.hydrate(tx, visible)
    const byId = new Map(hydrated.map((i) => [i.id, i]))
    return ids.map((id) => byId.get(id)).filter((i): i is Issue => !!i)
  }

  // ------------------------------------------------------------------ create

  async create(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    input: CreateIssue,
    opts: CreateOptions = {},
  ): Promise<Issue> {
    const project = opts.system
      ? await this.access.loadProject(tx, workspaceId, input.projectId)
      : await this.access.requireProject(tx, principal, workspaceId, input.projectId, 'tracker.issue.create')
    if (project.archivedAt) throw KernError.conflict('Project is archived', 'tracker.project.archived')

    const merged = input.templateId
      ? await this.applyTemplate(tx, workspaceId, input)
      : { input, subItems: [] as Array<{ title: string; typeId?: string }> }
    const data = merged.input
    const settings = parseSettings(project.settings)

    const type = data.typeId
      ? await this.config.getType(tx, workspaceId, data.typeId)
      : await this.config.defaultType(tx, workspaceId, project.id)
    const { definition } = await this.config.workflowFor(tx, project, type.id)

    const triage = opts.triage ?? data.triage ?? false
    const status = this.pickInitialStatus(definition, data.statusId, triage)
    const now = new Date()

    const number = await this.allocateNumber(tx, workspaceId, project.id)
    const key = `${project.key}-${number}`
    const rank = await this.rankFor(tx, workspaceId, project.id, data.rankAfterId, data.rankBeforeId)

    const parentId = data.parentId ?? null
    if (parentId) await this.assertParentAllowed(tx, workspaceId, project, type.level, parentId)

    const assigneeIds = await this.defaultAssignees(tx, project, data, type.id)
    const labelIds = await this.enforceLabelGroups(tx, workspaceId, data.labelIds ?? [])
    await this.assertPlanningRefs(tx, workspaceId, project.id, data)

    const description = (data.description ?? null) as RichDoc | null
    const descriptionText = docToText(description)
    const { custom, skipped: skippedRequired } = await normaliseCustom({
      fields: await this.config.listFields(tx, workspaceId, { projectId: project.id }),
      current: null,
      patch: data.custom ?? {},
      mode: 'create',
      source: opts.source ?? 'app',
      memberIds: () => this.workspaceMemberIds(workspaceId),
      issueRefs: (ids) => this.issueRefs(tx, workspaceId, ids),
      systemValues: {
        estimate: data.estimate ?? null,
        priority: data.priority ?? 'none',
        startDate: data.startDate ?? null,
        dueDate: data.dueDate ?? null,
        title: data.title,
      },
    })
    // An inbound source is allowed to skip a required field rather than bounce the message. Say so
    // in the log, or an issue arrives incomplete with no record of why.
    if (skippedRequired.length)
      this.kernel.log.info(
        { source: opts.source ?? 'app', fields: skippedRequired.map((p) => p.fieldId) },
        'tracker: issue created without required custom fields',
      )
    const watchers = uniq([
      ...(data.watcherIds ?? []),
      ...assigneeIds,
      ...(principal.userId ? [principal.userId] : []),
      ...(data.reporterId ? [data.reporterId] : []),
    ])
    const source = opts.source ?? 'app'
    const sla = this.initialSla(settings, data.priority ?? 'none', now, triage)

    const id = uuidv7()
    const [row] = await tx
      .insert(issues)
      .values({
        id,
        workspaceId,
        projectId: project.id,
        key,
        number,
        typeId: type.id,
        title: data.title,
        description,
        descriptionText,
        statusId: status.id,
        statusCategory: status.category,
        priority: data.priority ?? 'none',
        assigneeIds,
        reporterId: data.reporterId ?? principal.userId ?? null,
        creatorId: principal.userId ?? null,
        labelIds,
        componentIds: data.componentIds ?? [],
        versionIds: data.versionIds ?? [],
        affectsVersionIds: data.affectsVersionIds ?? [],
        cycleId: data.cycleId ?? null,
        milestoneId: data.milestoneId ?? null,
        parentId,
        rank,
        estimate: data.estimate ?? null,
        estimateUnit: settings.estimation,
        startDate: data.startDate ?? null,
        dueDate: data.dueDate ?? null,
        custom,
        watcherIds: watchers,
        originalEstimateSec: data.originalEstimateSec ?? null,
        remainingSec: data.originalEstimateSec ?? null,
        sla,
        triage,
        source,
        externalRef: opts.externalRef ?? null,
      })
      .returning()

    await tx.insert(issueStatusHistory).values({
      id: uuidv7(),
      workspaceId,
      issueId: id,
      projectId: project.id,
      fromStatusId: null,
      toStatusId: status.id,
      fromCategory: null,
      toCategory: status.category,
      actorId: principal.userId ?? null,
      transitionId: null,
      durationSec: null,
    })
    await this.notify.history(tx, {
      workspaceId,
      issueId: id,
      actorId: principal.userId ?? null,
      action: 'created',
      data: { key, title: data.title },
    })

    if (data.attachmentIds?.length)
      await this.attachFiles(tx, workspaceId, id, data.attachmentIds, principal.userId ?? null)

    for (const sub of merged.subItems) {
      const subType = sub.typeId ?? (await this.subItemType(tx, workspaceId, project.id, type.level))
      await this.create(
        tx,
        principal,
        workspaceId,
        { projectId: project.id, title: sub.title, typeId: subType, parentId: id },
        { ...opts, system: true },
      )
    }

    const issue = (await this.hydrate(tx, [row!]))[0]!
    await this.afterCreate(issue, principal, { mentions: extractMentions(description) })
    if (settings.autoCreateIssueChannel) void this.ensureChatChannel(workspaceId, issue, watchers)
    return issue
  }

  private pickInitialStatus(definition: WorkflowDefinition, requested: string | undefined, triage: boolean) {
    if (requested) {
      const found = definition.statuses.find((s) => s.id === requested)
      if (!found) throw KernError.badRequest(`Unknown status "${requested}" for this workflow`)
      return found
    }
    if (triage) {
      const triageStatus = definition.statuses.find((s) => s.category === 'triage')
      if (triageStatus) return triageStatus
    }
    return initialStatus(definition)
  }

  private async allocateNumber(tx: Tx, workspaceId: string, projectId: string): Promise<number> {
    await tx
      .insert(issueCounters)
      .values({ projectId, workspaceId })
      .onConflictDoNothing({ target: issueCounters.projectId })
    const [row] = await tx
      .update(issueCounters)
      .set({ lastIssueNumber: sql`${issueCounters.lastIssueNumber} + 1` })
      .where(eq(issueCounters.projectId, projectId))
      .returning({ n: issueCounters.lastIssueNumber })
    if (!row) throw KernError.conflict('Could not allocate an issue number')
    return row.n
  }

  private async rankFor(
    tx: Tx,
    workspaceId: string,
    projectId: string,
    afterId?: string | null,
    beforeId?: string | null,
  ): Promise<string> {
    if (afterId || beforeId) return this.rankBetweenIssues(tx, workspaceId, afterId ?? null, beforeId ?? null)
    const [last] = await tx
      .select({ rank: issues.rank })
      .from(issues)
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.projectId, projectId)))
      .orderBy(desc(issues.rank))
      .limit(1)
    return last ? rankBetween(last.rank, null) : initialRank()
  }

  private async rankBetweenIssues(
    tx: Tx,
    workspaceId: string,
    afterId: string | null,
    beforeId: string | null,
  ): Promise<string> {
    const ids = [afterId, beforeId].filter((v): v is string => !!v)
    const rows = ids.length
      ? await tx
          .select({ id: issues.id, rank: issues.rank })
          .from(issues)
          .where(and(eq(issues.workspaceId, workspaceId), inArray(issues.id, ids)))
      : []
    const after = afterId ? (rows.find((r) => r.id === afterId)?.rank ?? null) : null
    const before = beforeId ? (rows.find((r) => r.id === beforeId)?.rank ?? null) : null
    return rankBetween(after, before)
  }

  private async defaultAssignees(
    tx: Tx,
    project: ProjectRow,
    input: CreateIssue,
    _typeId: string,
  ): Promise<string[]> {
    if (input.assigneeIds?.length) return uniq(input.assigneeIds)
    if (input.componentIds?.length) {
      const rows = await tx
        .select()
        .from(components)
        .where(
          and(eq(components.workspaceId, project.workspaceId), inArray(components.id, input.componentIds)),
        )
      for (const component of rows) {
        if (component.defaultAssignee === 'lead' && component.leadId) return [component.leadId]
        if (component.defaultAssignee === 'none') return []
      }
    }
    if (project.defaultAssignee === 'lead' && project.leadId) return [project.leadId]
    return []
  }

  /** Labels that share a group are mutually exclusive: the last one wins. */
  private async enforceLabelGroups(tx: Tx, workspaceId: string, labelIds: string[]): Promise<string[]> {
    if (labelIds.length < 2) return uniq(labelIds)
    const rows = await tx
      .select()
      .from(labels)
      .where(and(eq(labels.workspaceId, workspaceId), inArray(labels.id, labelIds)))
    const byGroup = new Map<string, string>()
    const out: string[] = []
    for (const id of uniq(labelIds)) {
      const label = rows.find((r) => r.id === id)
      if (!label?.groupName) {
        out.push(id)
        continue
      }
      byGroup.set(label.groupName, id)
    }
    return [...out, ...byGroup.values()]
  }

  private async assertPlanningRefs(
    tx: Tx,
    workspaceId: string,
    projectId: string,
    input: Partial<CreateIssue>,
  ): Promise<void> {
    if (input.cycleId) {
      const [row] = await tx
        .select({ p: cycles.projectId })
        .from(cycles)
        .where(and(eq(cycles.workspaceId, workspaceId), eq(cycles.id, input.cycleId)))
      if (!row || row.p !== projectId) throw KernError.badRequest('Cycle belongs to another project')
    }
    if (input.milestoneId) {
      const [row] = await tx
        .select({ p: milestones.projectId })
        .from(milestones)
        .where(and(eq(milestones.workspaceId, workspaceId), eq(milestones.id, input.milestoneId)))
      if (!row || row.p !== projectId) throw KernError.badRequest('Milestone belongs to another project')
    }
    for (const id of [...(input.versionIds ?? []), ...(input.affectsVersionIds ?? [])]) {
      const [row] = await tx
        .select({ p: versions.projectId })
        .from(versions)
        .where(and(eq(versions.workspaceId, workspaceId), eq(versions.id, id)))
      if (!row || row.p !== projectId) throw KernError.badRequest('Version belongs to another project')
    }
  }

  private async assertParentAllowed(
    tx: Tx,
    workspaceId: string,
    project: ProjectRow,
    childLevel: number,
    parentId: string,
  ): Promise<void> {
    const parent = await this.row(tx, workspaceId, parentId)
    if (parent.projectId !== project.id && childLevel >= 0)
      throw KernError.badRequest('Parent must be in the same project')
    const parentType = await this.config.getType(tx, workspaceId, parent.typeId)
    const rules = await this.config.hierarchyRules(tx, workspaceId)
    if (parentType.level === childLevel && !rules.allowSameLevel)
      throw KernError.badRequest('Same-level parenting is disabled in this workspace')
    if (parentType.level < childLevel) throw KernError.badRequest('A parent must sit above its child')
    if (parentType.level - childLevel > 1 && !rules.allowSkipLevels)
      throw KernError.badRequest('Skipping hierarchy levels is disabled in this workspace')
    if (childLevel < 0) {
      let depth = 1
      let cursor: string | null = parent.parentId
      while (cursor && depth <= rules.maxSubItemDepth + 1) {
        const next: IssueRow = await this.row(tx, workspaceId, cursor)
        const nextType = await this.config.getType(tx, workspaceId, next.typeId)
        if (nextType.level >= 0) break
        depth++
        cursor = next.parentId
      }
      if (depth > rules.maxSubItemDepth)
        throw KernError.badRequest(`Sub-items may only nest ${rules.maxSubItemDepth} level(s) deep`)
    }
  }

  private async subItemType(
    tx: Tx,
    workspaceId: string,
    projectId: string,
    parentLevel: number,
  ): Promise<string> {
    const types = await this.config.listTypes(tx, workspaceId, { projectId })
    const below = types.filter((t) => t.level < parentLevel).sort((a, b) => b.level - a.level)
    const chosen = below[0] ?? types.find((t) => t.level === parentLevel)
    if (!chosen) throw KernError.badRequest('No work item type available for sub-items')
    return chosen.id
  }

  /**
   * Workspace members, for validating a `user` custom field.
   *
   * If core cannot answer, the check is skipped rather than failed: a validation rule that depends
   * on another service must not make issues unwritable when that service is briefly unavailable.
   */
  /** The issues a `relation` value names, for checking a link is real and allowed. */
  private async issueRefs(
    tx: Tx,
    workspaceId: string,
    ids: string[],
  ): Promise<Map<string, { typeId: string; projectId: string }>> {
    if (!ids.length) return new Map()
    const rows = await tx
      .select({ id: issues.id, typeId: issues.typeId, projectId: issues.projectId })
      .from(issues)
      .where(and(eq(issues.workspaceId, workspaceId), inArray(issues.id, ids)))
    return new Map(rows.map((r) => [r.id, { typeId: r.typeId, projectId: r.projectId }]))
  }

  private async workspaceMemberIds(workspaceId: string): Promise<Set<string> | undefined> {
    const members = await this.kernel
      .call<Array<{ userId: string }>>('core.workspaces.members', { workspaceId })
      .catch(() => null)
    return members ? new Set(members.map((m) => m.userId)) : undefined
  }

  private initialSla(
    settings: ProjectSettings,
    priority: Priority,
    now: Date,
    triage: boolean,
  ): SlaState | null {
    if (!settings.sla.enabled) return null
    const goal = settings.sla.goals[priority]
    if (!goal) return null
    const hours = (h?: number) => (h ? new Date(now.getTime() + h * 3_600_000).toISOString() : null)
    return {
      firstResponseDueAt: hours(goal.firstResponseHours),
      firstRespondedAt: null,
      resolveDueAt: hours(goal.resolveHours),
      pausedAt: triage && settings.sla.pauseInCategories.includes('triage') ? now.toISOString() : null,
      pausedSec: 0,
      breached: false,
    }
  }

  private async applyTemplate(
    tx: Tx,
    workspaceId: string,
    input: CreateIssue,
  ): Promise<{ input: CreateIssue; subItems: Array<{ title: string; typeId?: string }> }> {
    const [row] = await tx
      .select()
      .from(issueTemplates)
      .where(and(eq(issueTemplates.workspaceId, workspaceId), eq(issueTemplates.id, input.templateId!)))
      .limit(1)
    if (!row) throw KernError.notFound('Issue template')
    const defaults = (row.defaults as Partial<CreateIssue>) ?? {}
    const { templateId: _ignored, ...rest } = input
    return {
      input: {
        ...defaults,
        ...rest,
        typeId: input.typeId ?? row.typeId ?? defaults.typeId,
        projectId: input.projectId,
        title: input.title,
      },
      subItems: (row.subItems as Array<{ title: string; typeId?: string }>) ?? [],
    }
  }

  private async afterCreate(
    issue: Issue,
    principal: Principal,
    extra: { mentions: string[] },
  ): Promise<void> {
    await this.kernel.emit(
      trackerEvents.issueCreated,
      {
        workspaceId: issue.workspaceId,
        projectId: issue.projectId,
        issueId: issue.id,
        key: issue.key,
        typeId: issue.typeId,
        title: issue.title,
        statusId: issue.statusId,
        priority: issue.priority,
        assigneeIds: issue.assigneeIds,
        triage: issue.triage,
        source: issue.source,
      },
      { workspaceId: issue.workspaceId, actorId: principal.userId },
    )
    await this.notify.change(issue.workspaceId, 'issue', issue.id, 'created', {
      scope: { projectId: issue.projectId },
    })
    await this.notify.notify({
      workspaceId: issue.workspaceId,
      userIds: issue.assigneeIds,
      type: 'tracker.issue.assigned',
      title: `${issue.key} assigned to you`,
      body: issue.title,
      object: objectRef(issue.id),
      url: issueUrl(issue.key),
      groupKey: issue.id,
      actorId: principal.userId,
      exclude: [principal.userId],
    })
    await this.notify.notify({
      workspaceId: issue.workspaceId,
      userIds: extra.mentions,
      type: 'tracker.issue.mentioned',
      title: `You were mentioned in ${issue.key}`,
      body: preview(issue.descriptionText),
      object: objectRef(issue.id),
      url: issueUrl(issue.key),
      groupKey: issue.id,
      actorId: principal.userId,
      exclude: [principal.userId],
    })
    await this.reindex(issue)
  }

  private async ensureChatChannel(workspaceId: string, issue: Issue, memberIds: string[]): Promise<void> {
    try {
      const channel = await this.kernel.call<{ id: string }>('chat.channels.ensureObjectChannel', {
        workspaceId,
        objectRef: objectRef(issue.id),
        name: `${issue.key} ${issue.title}`.slice(0, 120),
        memberIds,
      })
      if (channel?.id)
        await this.kernel.database.withWorkspace(workspaceId, (tx) =>
          tx.update(issues).set({ chatChannelId: channel.id }).where(eq(issues.id, issue.id)),
        )
    } catch (err) {
      this.kernel.log.debug({ err: String(err) }, 'tracker: issue chat channel unavailable')
    }
  }

  /** Push one issue into the workspace search index. */
  async reindex(issue: Issue): Promise<void> {
    await this.notify.index([
      {
        workspaceId: issue.workspaceId,
        object: objectRef(issue.id),
        title: `${issue.key} ${issue.title}`,
        body: issue.descriptionText || null,
        url: issueUrl(issue.key),
        icon: 'square-check-big',
        acl: null,
        updatedAt: issue.updatedAt,
        attributes: {
          projectId: issue.projectId,
          statusId: issue.statusId,
          statusCategory: issue.statusCategory,
          priority: issue.priority,
          assigneeIds: issue.assigneeIds,
        },
      },
    ])
  }

  // ------------------------------------------------------------------ update

  async update(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    patch: UpdateIssue,
    opts: { system?: boolean } = {},
  ): Promise<Issue> {
    const current = await this.row(tx, workspaceId, issueId)
    const project = opts.system
      ? await this.access.loadProject(tx, workspaceId, current.projectId)
      : await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.issue.view')
    if (!opts.system)
      await this.access.requireEditIssue(principal, workspaceId, current.projectId, {
        reporterId: current.reporterId,
        creatorId: current.creatorId,
        assigneeIds: current.assigneeIds ?? [],
      })

    const next: Record<string, unknown> = {}
    const changes: Array<{ field: string; from: unknown; to: unknown }> = []
    const track = (field: string, from: unknown, to: unknown) => {
      if (JSON.stringify(from) === JSON.stringify(to)) return
      next[field] = to
      changes.push({ field, from, to })
    }

    if (patch.title !== undefined) track('title', current.title, patch.title)
    if (patch.description !== undefined) {
      const text = docToText(patch.description)
      track('description', current.descriptionText, text)
      next.description = patch.description
      next.descriptionText = text
    }
    if (patch.priority !== undefined) track('priority', current.priority, patch.priority)
    if (patch.reporterId !== undefined) track('reporterId', current.reporterId, patch.reporterId)
    if (patch.estimate !== undefined) track('estimate', current.estimate, patch.estimate)
    if (patch.startDate !== undefined) track('startDate', current.startDate, patch.startDate)
    if (patch.dueDate !== undefined) track('dueDate', current.dueDate, patch.dueDate)
    if (patch.resolution !== undefined) track('resolution', current.resolution, patch.resolution)
    if (patch.triage !== undefined) track('triage', current.triage, patch.triage)
    if (patch.originalEstimateSec !== undefined)
      track('originalEstimateSec', current.originalEstimateSec, patch.originalEstimateSec)
    if (patch.remainingSec !== undefined) track('remainingSec', current.remainingSec, patch.remainingSec)

    if (patch.componentIds !== undefined)
      track('componentIds', current.componentIds ?? [], uniq(patch.componentIds))
    if (patch.versionIds !== undefined) track('versionIds', current.versionIds ?? [], uniq(patch.versionIds))
    if (patch.affectsVersionIds !== undefined)
      track('affectsVersionIds', current.affectsVersionIds ?? [], uniq(patch.affectsVersionIds))
    if (patch.cycleId !== undefined) track('cycleId', current.cycleId, patch.cycleId)
    if (patch.milestoneId !== undefined) track('milestoneId', current.milestoneId, patch.milestoneId)
    await this.assertPlanningRefs(tx, workspaceId, current.projectId, {
      cycleId: patch.cycleId ?? undefined,
      milestoneId: patch.milestoneId ?? undefined,
      versionIds: patch.versionIds,
      affectsVersionIds: patch.affectsVersionIds,
    })

    // assignees: full replacement or add/remove deltas
    const currentAssignees = current.assigneeIds ?? []
    let assignees = patch.assigneeIds ? uniq(patch.assigneeIds) : [...currentAssignees]
    if (patch.assigneeAdd?.length) assignees = uniq([...assignees, ...patch.assigneeAdd])
    if (patch.assigneeRemove?.length) {
      const drop = new Set<string>(patch.assigneeRemove)
      assignees = assignees.filter((a) => !drop.has(a))
    }
    const assigneesChanged = JSON.stringify(assignees) !== JSON.stringify(currentAssignees)
    if (assigneesChanged) {
      if (!opts.system)
        await this.access.require(principal, 'tracker.issue.assign', workspaceId, current.projectId)
      track('assigneeIds', currentAssignees, assignees)
      next.watcherIds = uniq([...(current.watcherIds ?? []), ...assignees])
    }

    const currentLabels = current.labelIds ?? []
    let labelIds = patch.labelIds ? uniq(patch.labelIds) : [...currentLabels]
    if (patch.labelAdd?.length) labelIds = uniq([...labelIds, ...patch.labelAdd])
    if (patch.labelRemove?.length) {
      const drop = new Set(patch.labelRemove)
      labelIds = labelIds.filter((l) => !drop.has(l))
    }
    labelIds = await this.enforceLabelGroups(tx, workspaceId, labelIds)
    if (JSON.stringify(labelIds) !== JSON.stringify(currentLabels)) track('labelIds', currentLabels, labelIds)

    // A formula reads the issue's own columns, so changing an estimate has to recompute one — which
    // means the custom values are revisited even when the patch never mentions them.
    const fieldDefsForProject =
      patch.custom !== undefined || FORMULA_TRIGGERS.some((key) => patch[key] !== undefined)
        ? await this.config.listFields(tx, workspaceId, { projectId: current.projectId })
        : []
    const recompute = patch.custom !== undefined || fieldDefsForProject.some((f) => f.type === 'formula')

    if (recompute) {
      // Validated on update too, not only on create. Until now an update wrote whatever it was
      // given: a `select` could be set to a value that was not one of its options.
      const { custom: merged } = await normaliseCustom({
        fields: fieldDefsForProject,
        current: (current.custom as Record<string, unknown>) ?? {},
        patch: patch.custom ?? {},
        mode: 'update',
        source: 'app',
        memberIds: () => this.workspaceMemberIds(workspaceId),
        issueRefs: (ids) => this.issueRefs(tx, workspaceId, ids),
        systemValues: {
          estimate: patch.estimate ?? current.estimate,
          priority: patch.priority ?? current.priority,
          startDate: patch.startDate ?? current.startDate,
          dueDate: patch.dueDate ?? current.dueDate,
          title: patch.title ?? current.title,
        },
      })
      track('custom', current.custom, merged)
    }

    if (patch.parentId !== undefined && patch.parentId !== current.parentId) {
      if (patch.parentId) {
        if (patch.parentId === issueId) throw KernError.badRequest('An issue cannot be its own parent')
        const type = await this.config.getType(tx, workspaceId, patch.typeId ?? current.typeId)
        await this.assertParentAllowed(tx, workspaceId, project, type.level, patch.parentId)
      }
      track('parentId', current.parentId, patch.parentId)
    }

    // a new type may follow a different workflow; keep the issue in a status that workflow knows
    let statusChange: { fromStatusId: string; toStatusId: string; toCategory: string } | null = null
    if (patch.typeId !== undefined && patch.typeId !== current.typeId) {
      await this.config.getType(tx, workspaceId, patch.typeId)
      track('typeId', current.typeId, patch.typeId)
      const { definition } = await this.config.workflowFor(tx, project, patch.typeId)
      if (!definition.statuses.some((s) => s.id === current.statusId)) {
        const target = initialStatus(definition)
        next.statusId = target.id
        next.statusCategory = target.category
        statusChange = {
          fromStatusId: current.statusId,
          toStatusId: target.id,
          toCategory: target.category,
        }
      }
    }

    if (!changes.length && !statusChange) return (await this.hydrate(tx, [current]))[0]!

    const [row] = await tx
      .update(issues)
      .set({ ...next, updatedAt: new Date(), lastActivityAt: new Date() })
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, issueId)))
      .returning()

    if (statusChange)
      await tx.insert(issueStatusHistory).values({
        id: uuidv7(),
        workspaceId,
        issueId,
        projectId: current.projectId,
        fromStatusId: statusChange.fromStatusId,
        toStatusId: statusChange.toStatusId,
        fromCategory: current.statusCategory,
        toCategory: statusChange.toCategory,
        actorId: principal.userId ?? null,
        transitionId: null,
        durationSec: null,
      })

    await this.notify.history(tx, {
      workspaceId,
      issueId,
      actorId: principal.userId ?? null,
      action: 'updated',
      changes,
    })

    const issue = (await this.hydrate(tx, [row!]))[0]!
    await this.kernel.emit(
      trackerEvents.issueUpdated,
      {
        workspaceId: issue.workspaceId,
        projectId: issue.projectId,
        issueId: issue.id,
        key: issue.key,
        changes,
      },
      { workspaceId, actorId: principal.userId },
    )
    if (assigneesChanged) {
      const gained = added(currentAssignees, assignees)
      await this.kernel.emit(
        trackerEvents.issueAssigned,
        {
          workspaceId: issue.workspaceId,
          projectId: issue.projectId,
          issueId: issue.id,
          key: issue.key,
          assigneeIds: issue.assigneeIds,
          added: gained as Issue['assigneeIds'],
          removed: removed(currentAssignees, assignees) as Issue['assigneeIds'],
        },
        { workspaceId, actorId: principal.userId },
      )
      await this.notify.notify({
        workspaceId,
        userIds: gained,
        type: 'tracker.issue.assigned',
        title: `${issue.key} assigned to you`,
        body: issue.title,
        object: objectRef(issue.id),
        url: issueUrl(issue.key),
        groupKey: issue.id,
        actorId: principal.userId,
        exclude: [principal.userId],
      })
    }
    if (patch.description !== undefined)
      await this.notify.notify({
        workspaceId,
        userIds: extractMentions(patch.description),
        type: 'tracker.issue.mentioned',
        title: `You were mentioned in ${issue.key}`,
        body: preview(issue.descriptionText),
        object: objectRef(issue.id),
        url: issueUrl(issue.key),
        groupKey: issue.id,
        actorId: principal.userId,
        exclude: [principal.userId],
      })
    await this.notify.change(workspaceId, 'issue', issue.id, 'updated', {
      scope: { projectId: issue.projectId },
    })
    await this.reindex(issue)
    return issue
  }

  /** Each issue is updated in its own transaction so one rejection does not undo the rest. */
  async bulkUpdate(
    principal: Principal,
    workspaceId: string,
    ids: string[],
    patch: UpdateIssue,
  ): Promise<BulkResult> {
    const results: BulkResult['results'] = []
    for (const id of ids) {
      try {
        await this.kernel.database.withWorkspace(
          workspaceId,
          (tx) => this.update(tx, principal, workspaceId, id, patch),
          { userId: principal.userId },
        )
        results.push({ id, ok: true })
      } catch (err) {
        const kern = err instanceof KernError ? err : null
        results.push({
          id,
          ok: false,
          error: {
            code: kern?.code ?? 'INTERNAL',
            message: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
    return {
      results,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    }
  }

  // ------------------------------------------------------------------ lifecycle

  async archive(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    archived: boolean,
  ): Promise<Issue> {
    const current = await this.row(tx, workspaceId, issueId)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.issue.archive')
    const [row] = await tx
      .update(issues)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, issueId)))
      .returning()
    await this.notify.history(tx, {
      workspaceId,
      issueId,
      actorId: principal.userId ?? null,
      action: archived ? 'archived' : 'unarchived',
    })
    const issue = (await this.hydrate(tx, [row!]))[0]!
    await this.kernel.emit(
      trackerEvents.issueArchived,
      {
        workspaceId: issue.workspaceId,
        projectId: issue.projectId,
        issueId: issue.id,
        key: issue.key,
        archived,
      },
      { workspaceId, actorId: principal.userId },
    )
    await this.notify.change(workspaceId, 'issue', issueId, 'updated', {
      scope: { projectId: issue.projectId },
    })
    if (archived) await this.notify.unindex(workspaceId, 'issue', [issueId])
    else await this.reindex(issue)
    return issue
  }

  async delete(tx: Tx, principal: Principal, workspaceId: string, issueId: string): Promise<void> {
    const current = await this.row(tx, workspaceId, issueId)
    await this.access.requireProject(
      tx,
      principal,
      workspaceId,
      current.projectId,
      'tracker.issue.delete_any',
    )
    await tx.update(issues).set({ parentId: null }).where(eq(issues.parentId, issueId))
    await tx.delete(comments).where(eq(comments.issueId, issueId))
    await tx.delete(attachments).where(eq(attachments.issueId, issueId))
    await tx.delete(links).where(eq(links.issueId, issueId))
    await tx.delete(relations).where(eq(relations.fromIssueId, issueId))
    await tx.delete(relations).where(eq(relations.toIssueId, issueId))
    await tx.delete(worklogs).where(eq(worklogs.issueId, issueId))
    await tx.delete(timers).where(eq(timers.issueId, issueId))
    await tx.delete(issueApprovals).where(eq(issueApprovals.issueId, issueId))
    await tx.delete(issueStatusHistory).where(eq(issueStatusHistory.issueId, issueId))
    await tx.delete(issueHistory).where(eq(issueHistory.issueId, issueId))
    await tx.delete(issues).where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, issueId)))

    await this.kernel.emit(
      trackerEvents.issueDeleted,
      {
        workspaceId: workspaceId as Issue['workspaceId'],
        projectId: current.projectId,
        issueId,
        key: current.key,
      },
      { workspaceId, actorId: principal.userId },
    )
    await this.notify.unindex(workspaceId, 'issue', [issueId])
    await this.notify.change(workspaceId, 'issue', issueId, 'deleted', {
      scope: { projectId: current.projectId },
    })
  }

  /** Move to another project: the issue is re-keyed and its sub-items follow. */
  async move(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    targetProjectId: string,
  ): Promise<Issue> {
    const current = await this.row(tx, workspaceId, issueId)
    if (current.projectId === targetProjectId) return (await this.hydrate(tx, [current]))[0]!
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.issue.edit_any')
    const target = await this.access.requireProject(
      tx,
      principal,
      workspaceId,
      targetProjectId,
      'tracker.issue.create',
    )
    const moved: string[] = []
    const relocate = async (row: IssueRow): Promise<IssueRow> => {
      const number = await this.allocateNumber(tx, workspaceId, target.id)
      const type = await this.matchType(tx, workspaceId, target, row.typeId)
      const { definition } = await this.config.workflowFor(tx, target, type)
      const status = definition.statuses.find((s) => s.id === row.statusId) ?? initialStatus(definition)
      const [updated] = await tx
        .update(issues)
        .set({
          projectId: target.id,
          key: `${target.key}-${number}`,
          number,
          typeId: type,
          statusId: status.id,
          statusCategory: status.category,
          // planning objects are project-scoped and cannot travel with the issue
          cycleId: null,
          milestoneId: null,
          componentIds: [],
          versionIds: [],
          affectsVersionIds: [],
          rank: await this.rankFor(tx, workspaceId, target.id),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, row.id))
        .returning()
      moved.push(row.id)
      const children = await tx.select().from(issues).where(eq(issues.parentId, row.id))
      for (const child of children) await relocate(child)
      return updated!
    }
    const row = await relocate(current)
    await this.notify.history(tx, {
      workspaceId,
      issueId,
      actorId: principal.userId ?? null,
      action: 'moved',
      changes: [{ field: 'projectId', from: current.projectId, to: target.id }],
      data: { fromKey: current.key, toKey: row.key },
    })
    const issue = (await this.hydrate(tx, [row]))[0]!
    await this.notify.change(workspaceId, 'issue', issueId, 'updated', {
      scope: { projectId: target.id },
    })
    await this.reindex(issue)
    return issue
  }

  private async matchType(tx: Tx, workspaceId: string, target: ProjectRow, typeId: string): Promise<string> {
    const source = await this.config.getType(tx, workspaceId, typeId)
    const candidates = await this.config.listTypes(tx, workspaceId, { projectId: target.id })
    const sameKey = candidates.find((t) => t.key === source.key)
    if (sameKey) return sameKey.id
    const sameLevel = candidates.find((t) => t.level === source.level)
    if (sameLevel) return sameLevel.id
    return (await this.config.defaultType(tx, workspaceId, target.id)).id
  }

  async rank(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    afterId: string | null | undefined,
    beforeId: string | null | undefined,
  ): Promise<{ id: string; rank: string }> {
    const current = await this.row(tx, workspaceId, issueId)
    await this.access.requireEditIssue(principal, workspaceId, current.projectId, {
      reporterId: current.reporterId,
      creatorId: current.creatorId,
      assigneeIds: current.assigneeIds ?? [],
    })
    const rank = await this.rankBetweenIssues(tx, workspaceId, afterId ?? null, beforeId ?? null)
    await tx
      .update(issues)
      .set({ rank, updatedAt: new Date() })
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, issueId)))
    await this.notify.change(workspaceId, 'issue', issueId, 'updated', {
      patch: { rank },
      scope: { projectId: current.projectId },
    })
    return { id: issueId, rank }
  }

  // ------------------------------------------------------------------ watchers

  async setWatcher(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    userId: string,
    watching: boolean,
  ): Promise<{ watcherIds: string[] }> {
    const current = await this.row(tx, workspaceId, issueId)
    // Watching yourself only needs to be able to see the issue. Adding or removing *someone else*
    // changes what lands in their inbox, so it takes the permission that manages watchers.
    const permission = userId === principal.userId ? 'tracker.issue.view' : 'tracker.issue.manage_watchers'
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, permission)
    const existing = current.watcherIds ?? []
    const watcherIds = watching ? uniq([...existing, userId]) : existing.filter((id: string) => id !== userId)
    await tx
      .update(issues)
      .set({ watcherIds, updatedAt: new Date() })
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, issueId)))
    return { watcherIds }
  }

  // ------------------------------------------------------------------ history

  async history(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    limit: number,
    cursor?: string,
  ): Promise<{
    items: IssueHistoryEntry[]
    statusHistory: StatusHistoryEntry[]
    nextCursor: string | null
  }> {
    const current = await this.row(tx, workspaceId, issueId)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.issue.view')
    const filters = [eq(issueHistory.workspaceId, workspaceId), eq(issueHistory.issueId, issueId)]
    if (cursor) filters.push(lt(issueHistory.id, cursor))
    const rows = await tx
      .select()
      .from(issueHistory)
      .where(and(...filters))
      .orderBy(desc(issueHistory.id))
      .limit(limit + 1)
    const items = rows.slice(0, limit).map(toHistoryEntry)
    const statusRows = await tx
      .select()
      .from(issueStatusHistory)
      .where(and(eq(issueStatusHistory.workspaceId, workspaceId), eq(issueStatusHistory.issueId, issueId)))
      .orderBy(asc(issueStatusHistory.occurredAt))
    return {
      items,
      statusHistory: statusRows.map(toStatusHistoryEntry),
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    }
  }

  // ------------------------------------------------------------------ relations

  async listRelations(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
  ): Promise<RelationView[]> {
    const current = await this.row(tx, workspaceId, issueId)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.issue.view')
    return this.relationViews(tx, workspaceId, issueId)
  }

  private async relationViews(tx: Tx, workspaceId: string, issueId: string): Promise<RelationView[]> {
    const rows = await tx
      .select()
      .from(relations)
      .where(and(eq(relations.workspaceId, workspaceId), eq(relations.fromIssueId, issueId)))
      .orderBy(asc(relations.createdAt))
    if (!rows.length) return []
    const targets = await tx
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.workspaceId, workspaceId),
          inArray(
            issues.id,
            rows.map((r) => r.toIssueId),
          ),
        ),
      )
    const hydrated = await this.hydrate(tx, targets)
    const byId = new Map(hydrated.map((i) => [i.id, toIssueSummary(i)]))
    return rows
      .filter((r) => byId.has(r.toIssueId))
      .map((r) => ({
        id: r.id,
        type: r.type as RelationType,
        issue: byId.get(r.toIssueId)!,
        createdAt: r.createdAt.toISOString(),
      }))
  }

  /** Relations are stored as a pair of rows so both issues can list theirs with one indexed lookup. */
  async createRelation(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    type: RelationType,
    targetIssueId: string,
  ): Promise<RelationView[]> {
    if (issueId === targetIssueId) throw KernError.badRequest('An issue cannot relate to itself')
    const current = await this.row(tx, workspaceId, issueId)
    const target = await this.row(tx, workspaceId, targetIssueId)
    await this.access.requireEditIssue(principal, workspaceId, current.projectId, {
      reporterId: current.reporterId,
      creatorId: current.creatorId,
      assigneeIds: current.assigneeIds ?? [],
    })
    await this.access.requireProject(tx, principal, workspaceId, target.projectId, 'tracker.issue.view')
    const pairId = uuidv7()
    await tx
      .insert(relations)
      .values([
        {
          id: pairId,
          workspaceId,
          type,
          fromIssueId: issueId,
          toIssueId: targetIssueId,
          createdBy: principal.userId ?? null,
        },
        {
          id: uuidv7(),
          workspaceId,
          type: RELATION_INVERSE[type],
          fromIssueId: targetIssueId,
          toIssueId: issueId,
          createdBy: principal.userId ?? null,
        },
      ])
      .onConflictDoNothing()
    await this.notify.history(tx, {
      workspaceId,
      issueId,
      actorId: principal.userId ?? null,
      action: 'relation_added',
      data: { type, targetIssueId, targetKey: target.key },
    })
    await this.notify.change(workspaceId, 'issue', issueId, 'updated')
    await this.notify.change(workspaceId, 'issue', targetIssueId, 'updated')
    return this.relationViews(tx, workspaceId, issueId)
  }

  async deleteRelation(tx: Tx, principal: Principal, workspaceId: string, relationId: string): Promise<void> {
    const [row] = await tx
      .select()
      .from(relations)
      .where(and(eq(relations.workspaceId, workspaceId), eq(relations.id, relationId)))
      .limit(1)
    if (!row) throw KernError.notFound('Relation')
    const source = await this.row(tx, workspaceId, row.fromIssueId)
    await this.access.requireEditIssue(principal, workspaceId, source.projectId, {
      reporterId: source.reporterId,
      creatorId: source.creatorId,
      assigneeIds: source.assigneeIds ?? [],
    })
    await tx.delete(relations).where(eq(relations.id, relationId))
    await tx
      .delete(relations)
      .where(
        and(
          eq(relations.workspaceId, workspaceId),
          eq(relations.fromIssueId, row.toIssueId),
          eq(relations.toIssueId, row.fromIssueId),
          eq(relations.type, RELATION_INVERSE[row.type as RelationType]),
        ),
      )
    await this.notify.change(workspaceId, 'issue', row.fromIssueId, 'updated')
    await this.notify.change(workspaceId, 'issue', row.toIssueId, 'updated')
  }

  // ------------------------------------------------------------------ attachments & links

  async listAttachments(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
  ): Promise<Attachment[]> {
    const current = await this.row(tx, workspaceId, issueId)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.issue.view')
    const rows = await tx
      .select()
      .from(attachments)
      .where(and(eq(attachments.workspaceId, workspaceId), eq(attachments.issueId, issueId)))
      .orderBy(asc(attachments.createdAt))
    return rows.map(toAttachment)
  }

  async attachFiles(
    tx: Tx,
    workspaceId: string,
    issueId: string,
    fileIds: string[],
    uploadedBy: string | null,
    commentId: string | null = null,
  ): Promise<Attachment[]> {
    const rows: Array<typeof attachments.$inferInsert> = []
    for (const fileId of uniq(fileIds)) {
      const file = await this.kernel
        .call<{ name: string; mimeType: string; size: number } | null>('core.files.get', { id: fileId })
        .catch(() => null)
      rows.push({
        id: uuidv7(),
        workspaceId,
        issueId,
        fileId,
        name: file?.name ?? 'attachment',
        mimeType: file?.mimeType ?? 'application/octet-stream',
        size: file?.size ?? 0,
        uploadedBy,
        commentId,
      })
    }
    if (!rows.length) return []
    const inserted = await tx
      .insert(attachments)
      .values(rows)
      .onConflictDoNothing({ target: [attachments.issueId, attachments.fileId] })
      .returning()
    await this.refreshAttachmentCount(tx, workspaceId, issueId)
    return inserted.map(toAttachment)
  }

  async addAttachments(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    fileIds: string[],
    commentId: string | null = null,
  ): Promise<Attachment[]> {
    const current = await this.row(tx, workspaceId, issueId)
    // A file that arrives with a comment is part of commenting, not part of editing the issue:
    // somebody who may reply but not edit must still be able to attach a screenshot to their reply.
    if (commentId)
      await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.issue.comment')
    else
      await this.access.requireEditIssue(principal, workspaceId, current.projectId, {
        reporterId: current.reporterId,
        creatorId: current.creatorId,
        assigneeIds: current.assigneeIds ?? [],
      })
    const created = await this.attachFiles(
      tx,
      workspaceId,
      issueId,
      fileIds,
      principal.userId ?? null,
      commentId,
    )
    await this.notify.change(workspaceId, 'issue', issueId, 'updated')
    return created
  }

  async removeAttachment(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    attachmentId: string,
  ): Promise<void> {
    const [row] = await tx
      .select()
      .from(attachments)
      .where(and(eq(attachments.workspaceId, workspaceId), eq(attachments.id, attachmentId)))
      .limit(1)
    if (!row) throw KernError.notFound('Attachment')
    const issue = await this.row(tx, workspaceId, row.issueId)
    // The author of a comment owns the files that arrived with it, the same way they own its text.
    const ownComment = row.commentId
      ? (
          await tx
            .select({ authorId: comments.authorId })
            .from(comments)
            .where(and(eq(comments.workspaceId, workspaceId), eq(comments.id, row.commentId)))
            .limit(1)
        )[0]?.authorId === principal.userId
      : false
    if (!ownComment)
      await this.access.requireEditIssue(principal, workspaceId, issue.projectId, {
        reporterId: issue.reporterId,
        creatorId: issue.creatorId,
        assigneeIds: issue.assigneeIds ?? [],
      })
    await tx.delete(attachments).where(eq(attachments.id, attachmentId))
    await this.refreshAttachmentCount(tx, workspaceId, row.issueId)
    await this.notify.change(workspaceId, 'issue', row.issueId, 'updated')
  }

  private async refreshAttachmentCount(tx: Tx, workspaceId: string, issueId: string): Promise<void> {
    await tx
      .update(issues)
      .set({
        attachmentCount: sql`(select count(*) from ${attachments} where ${attachments.issueId} = ${issueId})`,
      })
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, issueId)))
  }

  async listLinks(tx: Tx, principal: Principal, workspaceId: string, issueId: string): Promise<Link[]> {
    const current = await this.row(tx, workspaceId, issueId)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.issue.view')
    const rows = await tx
      .select()
      .from(links)
      .where(and(eq(links.workspaceId, workspaceId), eq(links.issueId, issueId)))
      .orderBy(asc(links.createdAt))
    return rows.map(toLink)
  }

  async addLink(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    input: { url: string; title?: string; kind: string },
  ): Promise<Link> {
    const current = await this.row(tx, workspaceId, issueId)
    await this.access.requireEditIssue(principal, workspaceId, current.projectId, {
      reporterId: current.reporterId,
      creatorId: current.creatorId,
      assigneeIds: current.assigneeIds ?? [],
    })
    const [row] = await tx
      .insert(links)
      .values({
        id: uuidv7(),
        workspaceId,
        issueId,
        url: input.url,
        title: input.title ?? null,
        kind: input.kind,
        createdBy: principal.userId ?? null,
      })
      .returning()
    await this.notify.change(workspaceId, 'issue', issueId, 'updated')
    return toLink(row!)
  }

  async removeLink(tx: Tx, principal: Principal, workspaceId: string, linkId: string): Promise<void> {
    const [row] = await tx
      .select()
      .from(links)
      .where(and(eq(links.workspaceId, workspaceId), eq(links.id, linkId)))
      .limit(1)
    if (!row) throw KernError.notFound('Link')
    const issue = await this.row(tx, workspaceId, row.issueId)
    await this.access.requireEditIssue(principal, workspaceId, issue.projectId, {
      reporterId: issue.reporterId,
      creatorId: issue.creatorId,
      assigneeIds: issue.assigneeIds ?? [],
    })
    await tx.delete(links).where(eq(links.id, linkId))
    await this.notify.change(workspaceId, 'issue', row.issueId, 'updated')
  }

  // ------------------------------------------------------------------ issue templates

  async listTemplates(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId?: string,
  ): Promise<IssueTemplate[]> {
    const filters = [eq(issueTemplates.workspaceId, workspaceId)]
    if (projectId) {
      await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.issue.view')
      filters.push(sql`(${issueTemplates.projectId} is null or ${issueTemplates.projectId} = ${projectId})`)
    } else {
      // Without a project the answer is "everything you could use": templates shared across the
      // workspace, plus those belonging to projects this caller can actually see.
      const visible = await this.access.visibleProjectIds(tx, principal, workspaceId)
      filters.push(
        visible.length
          ? or(isNull(issueTemplates.projectId), inArray(issueTemplates.projectId, visible))!
          : isNull(issueTemplates.projectId),
      )
    }
    const rows = await tx
      .select()
      .from(issueTemplates)
      .where(and(...filters))
      .orderBy(asc(issueTemplates.name))
    return rows.map(toIssueTemplate)
  }

  /**
   * Issue templates and recurring rules are project configuration, not content: they decide what
   * everyone else's issues look like. They take the same permission as managing the project, at
   * project scope when they belong to one and at workspace scope when they are shared.
   */
  private async recurringRow(tx: Tx, workspaceId: string, id: string) {
    const [row] = await tx
      .select()
      .from(recurringIssues)
      .where(and(eq(recurringIssues.workspaceId, workspaceId), eq(recurringIssues.id, id)))
      .limit(1)
    if (!row) throw KernError.notFound('Recurring issue')
    return row
  }

  private async templateRow(tx: Tx, workspaceId: string, id: string) {
    const [row] = await tx
      .select()
      .from(issueTemplates)
      .where(and(eq(issueTemplates.workspaceId, workspaceId), eq(issueTemplates.id, id)))
      .limit(1)
    if (!row) throw KernError.notFound('Issue template')
    return row
  }

  private async requireTemplateManage(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string | null,
  ): Promise<void> {
    if (projectId)
      await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.project.manage')
    else await this.access.requireWorkspace(principal, 'tracker.project.manage', workspaceId)
  }

  async createTemplate(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    input: UpsertIssueTemplate,
  ): Promise<IssueTemplate> {
    await this.requireTemplateManage(tx, principal, workspaceId, input.projectId ?? null)
    const [row] = await tx
      .insert(issueTemplates)
      .values({
        id: uuidv7(),
        workspaceId,
        projectId: input.projectId ?? null,
        name: input.name,
        description: input.description ?? null,
        typeId: input.typeId ?? null,
        defaults: input.defaults ?? {},
        subItems: input.subItems ?? [],
        createdBy: principal.userId ?? null,
      })
      .returning()
    return toIssueTemplate(row!)
  }

  async updateTemplate(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    id: string,
    patch: Partial<UpsertIssueTemplate>,
  ): Promise<IssueTemplate> {
    const current = await this.templateRow(tx, workspaceId, id)
    await this.requireTemplateManage(tx, principal, workspaceId, current.projectId)
    // moving a template into or out of a project needs the permission on the destination too
    if (patch.projectId !== undefined && patch.projectId !== current.projectId)
      await this.requireTemplateManage(tx, principal, workspaceId, patch.projectId ?? null)
    const [row] = await tx
      .update(issueTemplates)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.projectId === undefined ? {} : { projectId: patch.projectId }),
        ...(patch.typeId === undefined ? {} : { typeId: patch.typeId }),
        ...(patch.defaults === undefined ? {} : { defaults: patch.defaults }),
        ...(patch.subItems === undefined ? {} : { subItems: patch.subItems }),
        updatedAt: new Date(),
      })
      .where(and(eq(issueTemplates.workspaceId, workspaceId), eq(issueTemplates.id, id)))
      .returning()
    if (!row) throw KernError.notFound('Issue template')
    return toIssueTemplate(row)
  }

  async deleteTemplate(tx: Tx, principal: Principal, workspaceId: string, id: string): Promise<void> {
    const current = await this.templateRow(tx, workspaceId, id)
    await this.requireTemplateManage(tx, principal, workspaceId, current.projectId)
    await tx
      .delete(issueTemplates)
      .where(and(eq(issueTemplates.workspaceId, workspaceId), eq(issueTemplates.id, id)))
  }

  // ------------------------------------------------------------------ recurring issues

  async listRecurring(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
  ): Promise<RecurringIssue[]> {
    await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.issue.view')
    const rows = await tx
      .select()
      .from(recurringIssues)
      .where(and(eq(recurringIssues.workspaceId, workspaceId), eq(recurringIssues.projectId, projectId)))
      .orderBy(asc(recurringIssues.name))
    return rows.map(toRecurringIssue)
  }

  async createRecurring(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    input: UpsertRecurringIssue,
  ): Promise<RecurringIssue> {
    await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.project.manage')
    const [row] = await tx
      .insert(recurringIssues)
      .values({
        id: uuidv7(),
        workspaceId,
        projectId,
        name: input.name,
        rule: input.rule,
        defaults: input.defaults,
        enabled: input.enabled ?? true,
        nextRunAt: nextRun(input.rule, new Date()),
        createdBy: principal.userId ?? null,
      })
      .returning()
    return toRecurringIssue(row!)
  }

  async updateRecurring(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    id: string,
    patch: Partial<UpsertRecurringIssue>,
  ): Promise<RecurringIssue> {
    const current = await this.recurringRow(tx, workspaceId, id)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.project.manage')
    const [row] = await tx
      .update(recurringIssues)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.rule === undefined ? {} : { rule: patch.rule, nextRunAt: nextRun(patch.rule, new Date()) }),
        ...(patch.defaults === undefined ? {} : { defaults: patch.defaults }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        updatedAt: new Date(),
      })
      .where(and(eq(recurringIssues.workspaceId, workspaceId), eq(recurringIssues.id, id)))
      .returning()
    if (!row) throw KernError.notFound('Recurring issue')
    return toRecurringIssue(row)
  }

  async deleteRecurring(tx: Tx, principal: Principal, workspaceId: string, id: string): Promise<void> {
    const current = await this.recurringRow(tx, workspaceId, id)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.project.manage')
    await tx
      .delete(recurringIssues)
      .where(and(eq(recurringIssues.workspaceId, workspaceId), eq(recurringIssues.id, id)))
  }

  /** Create the issues whose recurrence is due. Called by the `tracker.recurring` job. */
  async runDueRecurring(workspaceId: string, now = new Date()): Promise<number> {
    const due = await this.kernel.database.withWorkspace(workspaceId, (tx) =>
      tx
        .select()
        .from(recurringIssues)
        .where(
          and(
            eq(recurringIssues.workspaceId, workspaceId),
            eq(recurringIssues.enabled, true),
            sql`${recurringIssues.nextRunAt} is not null and ${recurringIssues.nextRunAt} <= ${now.toISOString()}`,
          ),
        )
        .limit(200),
    )
    let created = 0
    for (const rule of due) {
      try {
        await this.kernel.database.withWorkspace(workspaceId, async (tx) => {
          const defaults = (rule.defaults as Partial<CreateIssue>) ?? {}
          const issue = await this.create(
            tx,
            this.kernel.system,
            workspaceId,
            {
              ...defaults,
              projectId: rule.projectId,
              title: defaults.title ?? rule.name,
            } as CreateIssue,
            { source: 'recurring', system: true },
          )
          await tx
            .update(recurringIssues)
            .set({
              lastRunAt: now,
              lastIssueId: issue.id,
              runCount: sql`${recurringIssues.runCount} + 1`,
              nextRunAt: nextRun(rule.rule as RecurringIssue['rule'], now),
              updatedAt: now,
            })
            .where(eq(recurringIssues.id, rule.id))
        })
        created++
      } catch (err) {
        this.kernel.log.warn({ err: String(err), rule: rule.id }, 'tracker: recurring issue failed')
      }
    }
    return created
  }

  /** Issues whose parent is `issueId` (used by the workflow `subtasks.allDone` condition). */
  async subItems(tx: Tx, workspaceId: string, issueId: string) {
    return tx
      .select({ id: issues.id, statusCategory: issues.statusCategory })
      .from(issues)
      .where(
        and(eq(issues.workspaceId, workspaceId), eq(issues.parentId, issueId), isNull(issues.archivedAt)),
      )
  }

  /** Everyone who should hear about a change to this issue. */
  watchersOf(row: IssueRow): string[] {
    return uniq([...(row.watcherIds ?? []), ...(row.assigneeIds ?? []), row.reporterId ?? ''].filter(Boolean))
  }

  isResolved(category: string): boolean {
    return RESOLVED_CATEGORIES.has(category as never)
  }

  /** Projects table accessor shared with the reports service. */
  projectsTable() {
    return projects
  }

  typesTable() {
    return workItemTypes
  }
}

/** Next occurrence of a recurrence rule after `from`. */
export function nextRun(rule: RecurringIssue['rule'], from: Date): Date | null {
  const [hh, mm] = (rule.at ?? '09:00').split(':').map(Number)
  const base = new Date(from.getTime())
  base.setUTCSeconds(0, 0)
  const at = (d: Date) => {
    const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh ?? 9, mm ?? 0))
    return copy
  }
  const interval = Math.max(1, rule.interval ?? 1)
  let candidate = at(base)
  if (candidate <= from) candidate = new Date(candidate.getTime() + 86_400_000)

  if (rule.freq === 'daily') {
    const days = Math.ceil((candidate.getTime() - at(base).getTime()) / 86_400_000)
    if (days % interval !== 0)
      candidate = new Date(candidate.getTime() + (interval - (days % interval)) * 86_400_000)
  } else if (rule.freq === 'weekly') {
    const weekdays = rule.byWeekday?.length ? rule.byWeekday : [candidate.getUTCDay()]
    for (let i = 0; i < 7 * interval + 7; i++) {
      const probe = new Date(candidate.getTime() + i * 86_400_000)
      if (weekdays.includes(probe.getUTCDay())) {
        candidate = probe
        break
      }
    }
  } else if (rule.freq === 'monthly') {
    const day = rule.byMonthDay ?? candidate.getUTCDate()
    let probe = new Date(Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), day, hh ?? 9, mm ?? 0))
    if (probe <= from)
      probe = new Date(
        Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth() + interval, day, hh ?? 9, mm ?? 0),
      )
    candidate = probe
  } else if (rule.freq === 'yearly') {
    let probe = new Date(
      Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), candidate.getUTCDate(), hh ?? 9, mm ?? 0),
    )
    if (probe <= from)
      probe = new Date(
        Date.UTC(
          probe.getUTCFullYear() + interval,
          probe.getUTCMonth(),
          probe.getUTCDate(),
          hh ?? 9,
          mm ?? 0,
        ),
      )
    candidate = probe
  }
  if (rule.until && candidate > new Date(rule.until)) return null
  return candidate
}
