import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import {
  type ApprovalState,
  applyTransition,
  availableTransitions,
  builtinRegistry,
  canApprove,
  createApprovalState,
  type Intent,
  type RuleObject,
  recordDecision,
  resolveApprovers,
  type Subject,
  statusById,
  transitionById,
  type WorkflowDefinition,
} from '@kernhq/workflow'
import { and, asc, desc, eq } from 'drizzle-orm'
import { trackerEvents } from '../../contract/events.js'
import {
  type AvailableTransition,
  type Issue,
  type IssueApproval,
  MODULE_ID,
  type ProjectSettings,
  type SlaState,
} from '../../contract/models.js'
import { issueApprovals, issueStatusHistory, issues, projects } from '../schema.js'
import type { AccessService } from './access.js'
import type { CommentService } from './comments.js'
import type { ConfigService } from './config.js'
import { type IssueRow, issueUrl, type ProjectRow, parseSettings, toApproval, uniq } from './db.js'
import type { IssueService } from './issues.js'
import type { NotifyService } from './notify.js'
import { checkValue } from './values.js'

const registry = builtinRegistry()

export interface ApplyInput {
  transitionId: string
  fields?: Record<string, unknown>
  comment?: string
  resolution?: string | null
}

/** Drives `@kernhq/workflow` for issues: conditions, validators, post-function intents and approvals. */
export class TransitionService {
  /** Set after construction to break the cycle with the comment service. */
  comments!: CommentService

  constructor(
    private readonly kernel: Kernel,
    private readonly access: AccessService,
    private readonly config: ConfigService,
    private readonly issuesService: IssueService,
    private readonly notify: NotifyService,
  ) {}

  private ruleObject(row: IssueRow): RuleObject {
    return {
      id: row.id,
      statusId: row.statusId,
      assigneeIds: row.assigneeIds ?? [],
      reporterId: row.reporterId,
      fields: {
        title: row.title,
        priority: row.priority,
        estimate: row.estimate,
        dueDate: row.dueDate,
        startDate: row.startDate,
        labelIds: row.labelIds ?? [],
        componentIds: row.componentIds ?? [],
        versionIds: row.versionIds ?? [],
        cycleId: row.cycleId,
        milestoneId: row.milestoneId,
        parentId: row.parentId,
        resolution: row.resolution,
        description: row.descriptionText,
        ...((row.custom as Record<string, unknown>) ?? {}),
      },
    }
  }

  private actor(principal: Principal, workspaceId: string) {
    const membership = principal.memberships.find((m) => m.workspaceId === workspaceId)
    return {
      id: principal.userId,
      groupIds: membership?.groupIds ?? [],
      isAdmin: principal.instanceAdmin || membership?.role === 'owner' || membership?.role === 'admin',
    }
  }

  private hooks(tx: Tx, principal: Principal, project: ProjectRow, row: IssueRow) {
    return {
      hasPermission: (permission: string) =>
        this.access.can(principal, permission, project.workspaceId, project.id),
      resolveSubject: async (subject: Subject): Promise<readonly string[]> => {
        if (subject.kind === 'projectLead') return project.leadId ? [project.leadId] : []
        if (subject.kind === 'user' && subject.id) return [subject.id]
        // groups and custom roles live in core; the tracker cannot expand them locally
        return []
      },
      subitems: async () => {
        const rows = await this.issuesService.subItems(tx, project.workspaceId, row.id)
        return rows.map((r) => ({ id: r.id, statusCategory: r.statusCategory as never }))
      },
    }
  }

  private async context(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
  ): Promise<{ row: IssueRow; project: ProjectRow; definition: WorkflowDefinition }> {
    const row = await this.issuesService.row(tx, workspaceId, issueId)
    const project = await this.access.requireProject(
      tx,
      principal,
      workspaceId,
      row.projectId,
      'tracker.issue.view',
    )
    const { definition } = await this.config.workflowFor(tx, project, row.typeId)
    return { row, project, definition }
  }

  async available(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
  ): Promise<AvailableTransition[]> {
    const { row, project, definition } = await this.context(tx, principal, workspaceId, issueId)
    const approvals = await this.approvalStates(tx, workspaceId, issueId)
    const statuses = await this.config.statusesForProject(tx, workspaceId, project.id)
    const byId = new Map(statuses.map((s) => [s.id, s]))
    const evaluations = await availableTransitions(definition, row.statusId, {
      registry,
      object: this.ruleObject(row),
      actor: this.actor(principal, workspaceId),
      ...this.hooks(tx, principal, project, row),
      includeHidden: true,
    })
    return evaluations.map((evaluation) => {
      const approval = approvals.get(evaluation.transition.id)
      const satisfied = approval?.status === 'approved'
      const target = byId.get(evaluation.to.id) ?? {
        id: evaluation.to.id,
        name: evaluation.to.name,
        category: evaluation.to.category,
        color: evaluation.to.color ?? null,
        order: evaluation.to.order ?? 0,
        workflowId: definition.id,
      }
      return {
        id: evaluation.transition.id,
        name: evaluation.transition.name,
        toStatusId: evaluation.to.id,
        toStatus: target,
        allowed: evaluation.allowed,
        reasons: evaluation.reasons.map((r) => ({
          kind: r.kind,
          message: r.message,
          ...(r.field ? { field: r.field } : {}),
        })),
        requiresApproval: !!evaluation.transition.approval && !satisfied,
        screen: evaluation.transition.screen
          ? {
              fields: evaluation.transition.screen.fields,
              comment: evaluation.transition.screen.comment,
            }
          : null,
        hidden: evaluation.transition.hidden,
      }
    })
  }

  private async approvalStates(
    tx: Tx,
    workspaceId: string,
    issueId: string,
  ): Promise<Map<string, ApprovalState>> {
    const rows = await tx
      .select()
      .from(issueApprovals)
      .where(and(eq(issueApprovals.workspaceId, workspaceId), eq(issueApprovals.issueId, issueId)))
    return new Map(rows.map((r) => [r.transitionId, r.state as ApprovalState]))
  }

  async listApprovals(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
  ): Promise<IssueApproval[]> {
    await this.context(tx, principal, workspaceId, issueId)
    const rows = await tx
      .select()
      .from(issueApprovals)
      .where(and(eq(issueApprovals.workspaceId, workspaceId), eq(issueApprovals.issueId, issueId)))
      .orderBy(asc(issueApprovals.createdAt))
    return rows.map(toApproval)
  }

  async apply(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    input: ApplyInput,
    opts: { system?: boolean; skipConditions?: boolean } = {},
  ): Promise<{ issue: Issue; approval: IssueApproval | null }> {
    const { row, project, definition } = await this.context(tx, principal, workspaceId, issueId)
    if (!opts.system)
      await this.access.require(principal, 'tracker.issue.transition', workspaceId, project.id)

    const transition = transitionById(definition, input.transitionId)
    if (!transition) throw KernError.notFound('Transition')
    const settings = parseSettings(project.settings)
    const target = statusById(definition, transition.to)
    if (target?.category === 'done' && settings.requireResolution && !(input.resolution ?? row.resolution))
      throw KernError.badRequest('A resolution is required to close this issue', { field: 'resolution' })

    const approvals = await this.approvalStates(tx, workspaceId, issueId)
    const existing = approvals.get(transition.id)
    const result = await applyTransition(definition, row.statusId, transition.id, {
      registry,
      object: this.ruleObject(row),
      actor: this.actor(principal, workspaceId),
      input: {
        fields: input.fields ?? {},
        comment: input.comment ?? null,
        resolution: input.resolution ?? null,
      },
      ...this.hooks(tx, principal, project, row),
      approvalSatisfied: existing?.status === 'approved',
      ...(opts.skipConditions ? { skipConditions: true } : {}),
    })

    if (!result.ok && result.pendingApproval) {
      const approval = await this.requestApproval(tx, principal, workspaceId, row, project, transition.id)
      const issue = (await this.issuesService.hydrate(tx, [row]))[0]!
      return { issue, approval }
    }
    if (!result.ok)
      throw KernError.badRequest(result.reasons.map((r) => r.message).join('; ') || 'Transition blocked', {
        reasons: result.reasons,
      })

    const issue = await this.commit(tx, principal, workspaceId, row, project, {
      transitionId: transition.id,
      screen: transition.screen ?? null,
      screenFields: input.fields ?? {},
      toStatusId: result.to.id,
      toCategory: result.to.category,
      intents: result.intents,
      comment: input.comment ?? null,
      resolution: input.resolution ?? null,
      settings,
    })
    return {
      issue,
      approval: existing ? await this.approvalRow(tx, workspaceId, issueId, transition.id) : null,
    }
  }

  /** Write the status change and everything the post-functions asked for, in one transaction. */
  private async commit(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    row: IssueRow,
    project: ProjectRow,
    plan: {
      transitionId: string
      screen: { fields: string[]; comment: boolean } | null
      screenFields: Record<string, unknown>
      toStatusId: string
      toCategory: string
      intents: Intent[]
      comment: string | null
      resolution: string | null
      settings: ProjectSettings
    },
  ): Promise<Issue> {
    const now = new Date()
    const patch: Record<string, unknown> = {
      statusId: plan.toStatusId,
      statusCategory: plan.toCategory,
      updatedAt: now,
      lastActivityAt: now,
    }
    const custom = { ...((row.custom as Record<string, unknown>) ?? {}) }
    let resolution = plan.resolution ?? row.resolution
    const webhooks: Array<Extract<Intent, { kind: 'webhook' }>> = []
    const notifications: Array<Extract<Intent, { kind: 'notify' }>> = []
    const subitems: Array<Extract<Intent, { kind: 'subitem.create' }>> = []

    // What the transition screen collected. This used to be handed to the rule engine and then
    // dropped, so a screen appeared to work only when a `field.set` post-function happened to
    // repeat the value.
    //
    // Only the fields the screen *declares* are applied: `tracker.issue.transition` is a narrower
    // permission than `tracker.issue.update`, and an unfiltered patch here would be a way around it.
    if (plan.screen?.fields.length) {
      const declared = new Set(plan.screen.fields)
      const defs = await this.config.listFields(tx, workspaceId, { projectId: row.projectId })
      for (const [name, value] of Object.entries(plan.screenFields)) {
        if (!declared.has(name)) continue
        const column = SETTABLE_COLUMNS[name]
        if (column) {
          patch[column] = value
          continue
        }
        const key = name.startsWith('cf.') ? name.slice(3) : name
        const def = defs.find((d) => d.key === key)
        if (!def) continue
        const problem = checkValue(def, value)
        if (problem) throw KernError.badRequest(problem, { field: `cf.${key}` })
        if (value === null) delete custom[key]
        else custom[key] = value
      }
    }

    for (const intent of plan.intents) {
      switch (intent.kind) {
        case 'field.set': {
          const column = SETTABLE_COLUMNS[intent.field]
          if (column) patch[column] = intent.value
          else custom[intent.field] = intent.value
          break
        }
        case 'assign':
          patch.assigneeIds = intent.userId ? [intent.userId] : []
          break
        case 'resolution.set':
          resolution = intent.value
          break
        case 'notify':
          notifications.push(intent)
          break
        case 'webhook':
          webhooks.push(intent)
          break
        case 'subitem.create':
          subitems.push(intent)
          break
        default:
          this.kernel.log.debug({ intent: intent.kind }, 'tracker: unhandled workflow intent')
      }
    }
    patch.custom = custom
    patch.resolution = resolution ?? null

    if (plan.toCategory === 'done') patch.completedAt = row.completedAt ?? now
    else if (plan.toCategory === 'cancelled') patch.cancelledAt = row.cancelledAt ?? now
    else {
      patch.completedAt = null
      patch.cancelledAt = null
    }
    if (plan.toCategory !== 'triage') patch.triage = false
    patch.sla = this.advanceSla(row, plan.settings, plan.toCategory, now)

    const [updated] = await tx
      .update(issues)
      .set(patch)
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, row.id)))
      .returning()

    const [previous] = await tx
      .select({ occurredAt: issueStatusHistory.occurredAt })
      .from(issueStatusHistory)
      .where(eq(issueStatusHistory.issueId, row.id))
      .orderBy(desc(issueStatusHistory.occurredAt))
      .limit(1)
    await tx.insert(issueStatusHistory).values({
      id: uuidv7(),
      workspaceId,
      issueId: row.id,
      projectId: row.projectId,
      fromStatusId: row.statusId,
      toStatusId: plan.toStatusId,
      fromCategory: row.statusCategory,
      toCategory: plan.toCategory,
      actorId: principal.userId ?? null,
      transitionId: plan.transitionId,
      durationSec: previous
        ? Math.max(0, Math.round((now.getTime() - previous.occurredAt.getTime()) / 1000))
        : null,
    })
    await this.notify.history(tx, {
      workspaceId,
      issueId: row.id,
      actorId: principal.userId ?? null,
      action: 'status_changed',
      changes: [{ field: 'statusId', from: row.statusId, to: plan.toStatusId }],
      data: { transitionId: plan.transitionId, resolution },
    })

    if (plan.comment?.trim())
      await this.comments.create(
        tx,
        principal,
        workspaceId,
        row.id,
        { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: plan.comment }] }] },
        { silent: true },
      )

    for (const sub of subitems)
      await this.issuesService.create(
        tx,
        principal,
        workspaceId,
        {
          projectId: row.projectId,
          title: sub.title,
          parentId: row.id,
          ...(sub.assignTo ? { assigneeIds: [sub.assignTo as Issue['assigneeIds'][number]] } : {}),
        },
        { system: true, source: 'automation' },
      )

    const issue = (await this.issuesService.hydrate(tx, [updated!]))[0]!
    await this.kernel.emit(
      trackerEvents.issueStatusChanged,
      {
        workspaceId: issue.workspaceId,
        projectId: issue.projectId,
        issueId: issue.id,
        key: issue.key,
        fromStatusId: row.statusId,
        toStatusId: plan.toStatusId,
        fromCategory: row.statusCategory as never,
        toCategory: plan.toCategory as never,
        transitionId: plan.transitionId,
        resolution: resolution ?? null,
      },
      { workspaceId, actorId: principal.userId },
    )
    await this.notify.notify({
      workspaceId,
      userIds: this.issuesService.watchersOf(row),
      type: 'tracker.issue.status_changed',
      title: `${issue.key} moved to ${plan.toStatusId}`,
      body: issue.title,
      object: { module: MODULE_ID, type: 'issue', id: issue.id },
      url: issueUrl(issue.key),
      groupKey: issue.id,
      actorId: principal.userId,
      exclude: [principal.userId],
    })
    for (const intent of notifications) {
      const targets = await resolveApprovers(intent.subjects, this.ruleObject(updated!), (subject) =>
        this.hooks(tx, principal, project, row).resolveSubject(subject),
      )
      await this.notify.notify({
        workspaceId,
        userIds: targets,
        type: 'tracker.issue.status_changed',
        title: `${issue.key}: ${intent.template}`,
        body: issue.title,
        object: { module: MODULE_ID, type: 'issue', id: issue.id },
        url: issueUrl(issue.key),
        actorId: principal.userId,
      })
    }
    await this.notify.change(workspaceId, 'issue', issue.id, 'updated', {
      scope: { projectId: issue.projectId },
    })
    await this.issuesService.reindex(issue)
    for (const hook of webhooks) void this.callWebhook(hook, issue)
    return issue
  }

  private async callWebhook(intent: Extract<Intent, { kind: 'webhook' }>, issue: Issue): Promise<void> {
    try {
      await fetch(intent.url, {
        method: intent.method,
        headers: { 'content-type': 'application/json', ...(intent.headers ?? {}) },
        body: intent.method === 'GET' ? undefined : JSON.stringify(intent.payload ?? { issue }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (err) {
      this.kernel.log.warn({ err: String(err), url: intent.url }, 'tracker: workflow webhook failed')
    }
  }

  /** Pause/resume the SLA clock and flag breaches as the issue moves through categories. */
  private advanceSla(
    row: IssueRow,
    settings: ProjectSettings,
    toCategory: string,
    now: Date,
  ): SlaState | null {
    const sla = row.sla as SlaState | null
    if (!sla || !settings.sla.enabled) return sla
    const paused = settings.sla.pauseInCategories.includes(toCategory as never)
    const next: SlaState = { ...sla }
    if (paused && !next.pausedAt) next.pausedAt = now.toISOString()
    if (!paused && next.pausedAt) {
      next.pausedSec += Math.max(0, Math.round((now.getTime() - new Date(next.pausedAt).getTime()) / 1000))
      next.pausedAt = null
    }
    if (toCategory === 'done' || toCategory === 'cancelled') {
      if (next.resolveDueAt) {
        const due = new Date(next.resolveDueAt).getTime() + next.pausedSec * 1000
        next.breached = next.breached || now.getTime() > due
      }
      next.resolveDueAt = null
      next.firstResponseDueAt = null
    }
    return next
  }

  // ------------------------------------------------------------------ approvals

  private async approvalRow(
    tx: Tx,
    workspaceId: string,
    issueId: string,
    transitionId: string,
  ): Promise<IssueApproval | null> {
    const [row] = await tx
      .select()
      .from(issueApprovals)
      .where(
        and(
          eq(issueApprovals.workspaceId, workspaceId),
          eq(issueApprovals.issueId, issueId),
          eq(issueApprovals.transitionId, transitionId),
        ),
      )
      .limit(1)
    return row ? toApproval(row) : null
  }

  private async requestApproval(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    row: IssueRow,
    project: ProjectRow,
    transitionId: string,
  ): Promise<IssueApproval> {
    const { definition } = await this.config.workflowFor(tx, project, row.typeId)
    const transition = transitionById(definition, transitionId)
    if (!transition?.approval) throw KernError.badRequest('This transition does not require approval')
    const existing = await this.approvalRow(tx, workspaceId, row.id, transitionId)
    if (existing && (existing.state as ApprovalState).status === 'pending') return existing
    const state = createApprovalState(transition, principal.userId ?? null)
    const [inserted] = await tx
      .insert(issueApprovals)
      .values({ id: uuidv7(), workspaceId, issueId: row.id, transitionId, state })
      .onConflictDoUpdate({
        target: [issueApprovals.issueId, issueApprovals.transitionId],
        set: { state, updatedAt: new Date() },
      })
      .returning()
    const approvers = await resolveApprovers(transition.approval.approvers, this.ruleObject(row), (subject) =>
      this.hooks(tx, principal, project, row).resolveSubject(subject),
    )
    await this.notify.notify({
      workspaceId,
      userIds: approvers,
      type: 'tracker.issue.approval_requested',
      title: `${row.key} needs your approval`,
      body: row.title,
      object: { module: MODULE_ID, type: 'issue', id: row.id },
      url: issueUrl(row.key),
      groupKey: row.id,
      actorId: principal.userId,
      exclude: [principal.userId],
    })
    return toApproval(inserted!)
  }

  async decide(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    transitionId: string,
    decision: 'approve' | 'reject',
    comment?: string,
  ): Promise<{ approval: IssueApproval; issue: Issue | null }> {
    const { row, project } = await this.context(tx, principal, workspaceId, issueId)
    const [approvalRow] = await tx
      .select()
      .from(issueApprovals)
      .where(
        and(
          eq(issueApprovals.workspaceId, workspaceId),
          eq(issueApprovals.issueId, issueId),
          eq(issueApprovals.transitionId, transitionId),
        ),
      )
      .limit(1)
    if (!approvalRow) throw KernError.notFound('Approval')
    const state = approvalRow.state as ApprovalState
    const userId = this.access.userId(principal)
    const allowed = await canApprove(state, this.actor(principal, workspaceId), this.ruleObject(row), (s) =>
      this.hooks(tx, principal, project, row).resolveSubject(s),
    )
    if (!allowed) throw KernError.forbidden('tracker.issue.transition')
    const next = recordDecision(state, { userId, decision, comment: comment ?? null })
    const [updated] = await tx
      .update(issueApprovals)
      .set({ state: next, updatedAt: new Date() })
      .where(eq(issueApprovals.id, approvalRow.id))
      .returning()

    let issue: Issue | null = null
    if (next.status === 'approved') {
      const applied = await this.apply(
        tx,
        principal,
        workspaceId,
        issueId,
        { transitionId, comment },
        { system: true },
      )
      issue = applied.issue
    }
    return { approval: toApproval(updated!), issue }
  }

  /** Move an issue straight to a status, picking a transition automatically (triage, automations). */
  async moveToStatus(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    statusId: string,
    opts: { comment?: string; resolution?: string | null } = {},
  ): Promise<Issue> {
    const { row, project, definition } = await this.context(tx, principal, workspaceId, issueId)
    const direct = definition.transitions.find(
      (t) => t.to === statusId && (t.from === '*' || t.from.includes(row.statusId)),
    )
    if (direct)
      return (
        await this.apply(
          tx,
          principal,
          workspaceId,
          issueId,
          {
            transitionId: direct.id,
            ...(opts.comment ? { comment: opts.comment } : {}),
            ...(opts.resolution === undefined ? {} : { resolution: opts.resolution }),
          },
          { system: true, skipConditions: true },
        )
      ).issue
    const target = statusById(definition, statusId)
    if (!target) throw KernError.badRequest(`Unknown status "${statusId}"`)
    return this.commit(tx, principal, workspaceId, row, project, {
      transitionId: `direct:${statusId}`,
      // a direct status set has no screen to collect anything
      screen: null,
      screenFields: {},
      toStatusId: target.id,
      toCategory: target.category,
      intents: [],
      comment: opts.comment ?? null,
      resolution: opts.resolution ?? null,
      settings: parseSettings(project.settings),
    })
  }

  /** The initial status of the workflow an issue follows (used when accepting out of triage). */
  async firstNonTriageStatus(tx: Tx, workspaceId: string, issueId: string): Promise<string> {
    const row = await this.issuesService.row(tx, workspaceId, issueId)
    const [project] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, row.projectId)))
      .limit(1)
    if (!project) throw KernError.notFound('Project')
    const { definition } = await this.config.workflowFor(tx, project, row.typeId)
    const ordered = [...definition.statuses].sort((a, b) => a.order - b.order)
    const candidate =
      ordered.find((s) => s.category === 'backlog') ?? ordered.find((s) => s.category === 'todo')
    return (candidate ?? ordered[0]!).id
  }

  /** Statuses whose category counts as resolved, for reports and cycle roll-over. */
  resolvedStatusIds(definition: WorkflowDefinition): string[] {
    return uniq(
      definition.statuses.filter((s) => s.category === 'done' || s.category === 'cancelled').map((s) => s.id),
    )
  }
}

/** Workflow `field.set` targets that map onto real issue columns rather than custom fields. */
const SETTABLE_COLUMNS: Record<string, string> = {
  priority: 'priority',
  dueDate: 'dueDate',
  startDate: 'startDate',
  estimate: 'estimate',
  cycleId: 'cycleId',
  milestoneId: 'milestoneId',
  triage: 'triage',
  title: 'title',
}
