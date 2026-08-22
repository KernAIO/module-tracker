import { randomBytes } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import { trackerEvents } from '../../contract/events.js'
import {
  type CreateProject,
  MODULE_ID,
  type Project,
  type ProjectMember,
  type ProjectRole,
  type ProjectSettings,
  ProjectSettings as ProjectSettingsSchema,
  type ProjectTemplate,
  type UpdateProject,
} from '../../contract/models.js'
import {
  attachments,
  comments,
  components,
  cycles,
  importJobs,
  intakeTokens,
  issueApprovals,
  issueCounters,
  issueHistory,
  issueStatusHistory,
  issues,
  issueTemplates,
  labels,
  links,
  milestones,
  projectMembers,
  projects,
  projectTemplates,
  recurringIssues,
  relations,
  timers,
  versions,
  viewPins,
  views,
  workflows,
  workItemTypes,
  worklogs,
  workspaces,
} from '../schema.js'
import { PROJECT_TEMPLATE_CHOICES, PROJECT_TEMPLATES } from '../seeds/templates.js'
import type { AccessService } from './access.js'
import type { ConfigService } from './config.js'
import {
  machineKey,
  type ProjectCounters,
  type ProjectRow,
  toProject,
  toProjectMember,
  toProjectTemplate,
} from './db.js'
import type { NotifyService } from './notify.js'

const RESOLVED = ['done', 'cancelled']

/** Views every new project gets, so the UI has something to show before anyone configures anything. */
const BUILTIN_VIEWS = [
  { name: 'All issues', icon: 'list', kql: '', layout: 'list', order: 0 },
  { name: 'Board', icon: 'kanban', kql: 'statusCategory != backlog', layout: 'board', order: 1 },
  { name: 'Backlog', icon: 'inbox', kql: 'statusCategory = backlog', layout: 'list', order: 2 },
  {
    name: 'My issues',
    icon: 'user',
    kql: 'assignee = currentUser() and statusCategory != done',
    layout: 'list',
    order: 3,
  },
] as const

export class ProjectService {
  constructor(
    private readonly kernel: Kernel,
    private readonly access: AccessService,
    private readonly config: ConfigService,
    private readonly notify: NotifyService,
  ) {}

  // ------------------------------------------------------------------ reads

  async counters(tx: Tx, workspaceId: string, projectIds: string[]): Promise<Map<string, ProjectCounters>> {
    const out = new Map<string, ProjectCounters>()
    if (!projectIds.length) return out
    const counterRows = await tx
      .select()
      .from(issueCounters)
      .where(and(eq(issueCounters.workspaceId, workspaceId), inArray(issueCounters.projectId, projectIds)))
    const openRows = await tx
      .select({ projectId: issues.projectId, n: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.workspaceId, workspaceId),
          inArray(issues.projectId, projectIds),
          isNull(issues.archivedAt),
          notInArray(issues.statusCategory, RESOLVED),
        ),
      )
      .groupBy(issues.projectId)
    const open = new Map(openRows.map((r) => [r.projectId, r.n]))
    for (const id of projectIds)
      out.set(id, {
        issueCounter: counterRows.find((c) => c.projectId === id)?.lastIssueNumber ?? 0,
        cycleCounter: counterRows.find((c) => c.projectId === id)?.lastCycleNumber ?? 0,
        openIssueCount: open.get(id) ?? 0,
      })
    return out
  }

  async list(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    includeArchived: boolean,
  ): Promise<Project[]> {
    const ids = await this.access.visibleProjectIds(tx, principal, workspaceId, { includeArchived })
    if (!ids.length) return []
    const rows = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, ids)))
      .orderBy(asc(projects.key))
    const counters = await this.counters(tx, workspaceId, ids)
    return rows.map((r) => toProject(r, counters.get(r.id)))
  }

  async get(tx: Tx, principal: Principal, workspaceId: string, projectId: string): Promise<Project> {
    const row = await this.access.requireProject(tx, principal, workspaceId, projectId)
    return this.hydrate(tx, row)
  }

  async getByKey(tx: Tx, principal: Principal, workspaceId: string, key: string): Promise<Project> {
    const row = await this.access.loadProjectByKey(tx, workspaceId, key)
    await this.access.assertAccess(tx, principal, row)
    return this.hydrate(tx, row)
  }

  async hydrate(tx: Tx, row: ProjectRow): Promise<Project> {
    const counters = await this.counters(tx, row.workspaceId, [row.id])
    return toProject(row, counters.get(row.id))
  }

  // ------------------------------------------------------------------ create / update

  async create(tx: Tx, principal: Principal, workspaceId: string, input: CreateProject): Promise<Project> {
    const key = input.key.toUpperCase()
    const [clash] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.key, key)))
      .limit(1)
    if (clash) throw KernError.conflict(`Project key "${key}" is already used`, 'tracker.project.key_taken')

    const id = uuidv7()
    const settings: ProjectSettings = ProjectSettingsSchema.parse(input.settings ?? {})
    await tx.insert(projects).values({
      id,
      workspaceId,
      key,
      name: input.name,
      description: input.description ?? null,
      icon: input.icon ?? null,
      color: input.color ?? null,
      leadId: input.leadId ?? principal.userId ?? null,
      visibility: input.visibility,
      defaultAssignee: input.defaultAssignee,
      settings,
      createdBy: principal.userId ?? null,
    })
    await tx.insert(issueCounters).values({ projectId: id, workspaceId })
    await tx
      .insert(workspaces)
      .values({ workspaceId })
      .onConflictDoNothing({ target: workspaces.workspaceId })

    let applied: { defaultTypeId: string } | null = null
    if (input.templateId) {
      const [template] = await tx
        .select()
        .from(projectTemplates)
        .where(and(eq(projectTemplates.workspaceId, workspaceId), eq(projectTemplates.id, input.templateId)))
        .limit(1)
      if (!template) throw KernError.notFound('Project template')
      applied = await this.config.applyProjectTemplateBody(tx, workspaceId, id, template.body)
    }
    if (!applied) await this.config.seedProject(tx, workspaceId, id, input.template)

    const memberIds = new Set<string>(input.memberIds ?? [])
    if (principal.userId) memberIds.add(principal.userId)
    if (input.leadId) memberIds.add(input.leadId)
    await this.addMembers(tx, workspaceId, id, [...memberIds], 'member', principal.userId ?? null, {
      adminIds: principal.userId ? [principal.userId] : [],
    })

    for (const view of BUILTIN_VIEWS)
      await tx.insert(views).values({
        id: uuidv7(),
        workspaceId,
        projectId: id,
        name: view.name,
        icon: view.icon,
        kql: view.kql,
        layout: view.layout,
        display: view.layout === 'board' ? { groupBy: 'status' } : {},
        visibility: 'project',
        builtin: true,
        order: view.order,
      })

    // member_count and the counters are written after the insert, so read the row back
    const project = await this.hydrate(tx, await this.access.loadProject(tx, workspaceId, id))
    await this.kernel.emit(
      trackerEvents.projectCreated,
      { workspaceId: workspaceId as Project['workspaceId'], projectId: id, key, name: input.name },
      { workspaceId, actorId: principal.userId },
    )
    await this.notify.change(workspaceId, 'project', id, 'created')
    return project
  }

  async update(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    patch: UpdateProject,
  ): Promise<Project> {
    const current = await this.access.requireProject(
      tx,
      principal,
      workspaceId,
      projectId,
      'tracker.project.manage',
    )
    const settings =
      patch.settings === undefined
        ? undefined
        : ProjectSettingsSchema.parse({
            ...((current.settings as Record<string, unknown>) ?? {}),
            ...patch.settings,
          })
    const [row] = await tx
      .update(projects)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.icon === undefined ? {} : { icon: patch.icon }),
        ...(patch.color === undefined ? {} : { color: patch.color }),
        ...(patch.leadId === undefined ? {} : { leadId: patch.leadId }),
        ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
        ...(patch.defaultAssignee === undefined ? {} : { defaultAssignee: patch.defaultAssignee }),
        ...(patch.workflowSchemeId === undefined ? {} : { workflowSchemeId: patch.workflowSchemeId }),
        ...(patch.typeSchemeId === undefined ? {} : { typeSchemeId: patch.typeSchemeId }),
        ...(settings === undefined ? {} : { settings }),
        updatedAt: new Date(),
      })
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))
      .returning()
    await this.kernel.emit(
      trackerEvents.projectUpdated,
      {
        workspaceId: workspaceId as Project['workspaceId'],
        projectId,
        changes: Object.keys(patch),
      },
      { workspaceId, actorId: principal.userId },
    )
    await this.notify.change(workspaceId, 'project', projectId, 'updated')
    return this.hydrate(tx, row!)
  }

  async archive(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    archived: boolean,
  ): Promise<Project> {
    await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.project.manage')
    const [row] = await tx
      .update(projects)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))
      .returning()
    await this.kernel.emit(
      trackerEvents.projectArchived,
      { workspaceId: workspaceId as Project['workspaceId'], projectId, archived },
      { workspaceId, actorId: principal.userId },
    )
    await this.notify.change(workspaceId, 'project', projectId, 'updated', { patch: { archived } })
    return this.hydrate(tx, row!)
  }

  /** Hard delete: the project and everything that hangs off it. */
  async delete(tx: Tx, principal: Principal, workspaceId: string, projectId: string): Promise<void> {
    const project = await this.access.requireProject(
      tx,
      principal,
      workspaceId,
      projectId,
      'tracker.project.delete',
    )
    const issueIds = (
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.workspaceId, workspaceId), eq(issues.projectId, projectId)))
    ).map((r) => r.id)

    if (issueIds.length) {
      await tx.delete(comments).where(inArray(comments.issueId, issueIds))
      await tx.delete(attachments).where(inArray(attachments.issueId, issueIds))
      await tx.delete(links).where(inArray(links.issueId, issueIds))
      await tx.delete(issueHistory).where(inArray(issueHistory.issueId, issueIds))
      await tx.delete(issueStatusHistory).where(inArray(issueStatusHistory.issueId, issueIds))
      await tx.delete(issueApprovals).where(inArray(issueApprovals.issueId, issueIds))
      await tx.delete(relations).where(inArray(relations.fromIssueId, issueIds))
      await tx.delete(relations).where(inArray(relations.toIssueId, issueIds))
      await tx.delete(worklogs).where(inArray(worklogs.issueId, issueIds))
      await tx.delete(timers).where(inArray(timers.issueId, issueIds))
      await tx.delete(issues).where(inArray(issues.id, issueIds))
    }
    const byProject = [
      tx.delete(cycles).where(eq(cycles.projectId, projectId)),
      tx.delete(milestones).where(eq(milestones.projectId, projectId)),
      tx.delete(versions).where(eq(versions.projectId, projectId)),
      tx.delete(components).where(eq(components.projectId, projectId)),
      tx.delete(labels).where(eq(labels.projectId, projectId)),
      tx.delete(recurringIssues).where(eq(recurringIssues.projectId, projectId)),
      tx.delete(issueTemplates).where(eq(issueTemplates.projectId, projectId)),
      tx.delete(importJobs).where(eq(importJobs.projectId, projectId)),
      tx.delete(workItemTypes).where(eq(workItemTypes.projectId, projectId)),
      tx.delete(workflows).where(eq(workflows.projectId, projectId)),
      tx.delete(projectMembers).where(eq(projectMembers.projectId, projectId)),
      tx.delete(issueCounters).where(eq(issueCounters.projectId, projectId)),
      tx.delete(intakeTokens).where(eq(intakeTokens.projectId, projectId)),
    ]
    for (const statement of byProject) await statement
    const viewIds = (await tx.select({ id: views.id }).from(views).where(eq(views.projectId, projectId))).map(
      (r) => r.id,
    )
    if (viewIds.length) await tx.delete(viewPins).where(inArray(viewPins.viewId, viewIds))
    await tx.delete(views).where(eq(views.projectId, projectId))
    await tx.delete(projects).where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))

    await this.notify.unindex(workspaceId, 'issue', issueIds)
    await this.kernel.emit(
      trackerEvents.projectDeleted,
      { workspaceId: workspaceId as Project['workspaceId'], projectId, key: project.key },
      { workspaceId, actorId: principal.userId },
    )
    await this.notify.change(workspaceId, 'project', projectId, 'deleted')
  }

  // ------------------------------------------------------------------ intake token

  async setIntake(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    enabled: boolean,
    rotate: boolean,
  ): Promise<{ token: string | null }> {
    const project = await this.access.requireProject(
      tx,
      principal,
      workspaceId,
      projectId,
      'tracker.project.manage',
    )
    let token: string | null = project.intakeToken
    if (!enabled) token = null
    else if (rotate || !token) token = randomBytes(24).toString('base64url')
    await tx
      .update(projects)
      .set({ intakeToken: token, updatedAt: new Date() })
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))
    // public routing needs the token outside RLS (see `intakeTokens` in the schema)
    await tx.delete(intakeTokens).where(eq(intakeTokens.projectId, projectId))
    if (token) await tx.insert(intakeTokens).values({ token, workspaceId, projectId })
    return { token }
  }

  // ------------------------------------------------------------------ members

  async listMembers(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
  ): Promise<ProjectMember[]> {
    await this.access.requireProject(tx, principal, workspaceId, projectId)
    const rows = await tx
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.workspaceId, workspaceId), eq(projectMembers.projectId, projectId)))
      .orderBy(asc(projectMembers.addedAt))
    return rows.map(toProjectMember)
  }

  async addMembers(
    tx: Tx,
    workspaceId: string,
    projectId: string,
    userIds: string[],
    role: ProjectRole,
    actorId: string | null,
    opts: { adminIds?: string[] } = {},
  ): Promise<ProjectMember[]> {
    if (!userIds.length) return []
    const admins = new Set(opts.adminIds ?? [])
    const rows = await tx
      .insert(projectMembers)
      .values(
        userIds.map((userId) => ({
          projectId,
          workspaceId,
          userId,
          role: admins.has(userId) ? 'admin' : role,
          addedBy: actorId,
        })),
      )
      .onConflictDoNothing({ target: [projectMembers.projectId, projectMembers.userId] })
      .returning()
    await this.refreshMemberCount(tx, projectId)
    return rows.map(toProjectMember)
  }

  async addMembersChecked(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    userIds: string[],
    role: ProjectRole,
  ): Promise<ProjectMember[]> {
    await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.project.manage')
    const created = await this.addMembers(tx, workspaceId, projectId, userIds, role, principal.userId ?? null)
    await this.notify.change(workspaceId, 'project', projectId, 'updated')
    return created
  }

  async removeMember(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    userId: string,
  ): Promise<void> {
    await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.project.manage')
    await tx
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.workspaceId, workspaceId),
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
        ),
      )
    await this.refreshMemberCount(tx, projectId)
    await this.notify.change(workspaceId, 'project', projectId, 'updated')
  }

  async setMemberRole(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    userId: string,
    role: ProjectRole,
  ): Promise<ProjectMember> {
    await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.project.manage')
    const [row] = await tx
      .update(projectMembers)
      .set({ role })
      .where(
        and(
          eq(projectMembers.workspaceId, workspaceId),
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
        ),
      )
      .returning()
    if (!row) throw KernError.notFound('Project member')
    return toProjectMember(row)
  }

  private async refreshMemberCount(tx: Tx, projectId: string): Promise<void> {
    await tx
      .update(projects)
      .set({
        memberCount: sql`(select count(*) from ${projectMembers} where ${projectMembers.projectId} = ${projectId})`,
      })
      .where(eq(projects.id, projectId))
  }

  /** Members of a project, or the whole workspace when the project is workspace-visible. */
  async memberIds(tx: Tx, projectId: string): Promise<string[]> {
    const rows = await tx
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId))
    return rows.map((r) => r.userId)
  }

  // ------------------------------------------------------------------ project templates

  /**
   * The templates a new project can be created from: the four the tracker ships with, then the
   * ones this workspace saved.
   *
   * The built-ins used to be rows with a null workspace, which this query could never return
   * because it filters by workspace — so the shipped templates were invisible to the only screen
   * meant to offer them. They are values in `seeds/templates.ts` now, and appear here directly.
   */
  async listTemplates(tx: Tx, workspaceId: string): Promise<ProjectTemplate[]> {
    const saved = await tx
      .select()
      .from(projectTemplates)
      .where(eq(projectTemplates.workspaceId, workspaceId))
      .orderBy(asc(projectTemplates.name))
    const builtin: ProjectTemplate[] = PROJECT_TEMPLATE_CHOICES.map((choice) => ({
      id: choice.id as ProjectTemplate['id'],
      workspaceId: null,
      key: choice.id,
      name: choice.name,
      description: choice.description,
      icon: null,
      body: PROJECT_TEMPLATES[choice.id],
      builtin: true,
      createdAt: new Date(0).toISOString() as ProjectTemplate['createdAt'],
    }))
    return [...builtin, ...saved.map(toProjectTemplate)]
  }

  async saveTemplateFromProject(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    name: string,
    description?: string,
  ): Promise<ProjectTemplate> {
    await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.project.manage')
    const body = await this.config.snapshotProject(tx, workspaceId, projectId)
    const [row] = await tx
      .insert(projectTemplates)
      .values({
        id: uuidv7(),
        workspaceId,
        key: machineKey(name, 'template'),
        name,
        description: description ?? null,
        body,
        builtin: false,
      })
      .onConflictDoUpdate({
        target: [projectTemplates.workspaceId, projectTemplates.key],
        set: { name, description: description ?? null, body },
      })
      .returning()
    return toProjectTemplate(row!)
  }

  async deleteTemplate(tx: Tx, workspaceId: string, id: string): Promise<void> {
    await tx
      .delete(projectTemplates)
      .where(and(eq(projectTemplates.workspaceId, workspaceId), eq(projectTemplates.id, id)))
  }

  /** Register a workspace so scheduled jobs know it exists (idempotent). */
  async registerWorkspace(tx: Tx, workspaceId: string): Promise<void> {
    await tx
      .insert(workspaces)
      .values({ workspaceId })
      .onConflictDoNothing({ target: workspaces.workspaceId })
    void MODULE_ID
  }
}
