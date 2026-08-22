import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx } from '@kernhq/kernel'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { MODULE_ID } from '../../contract/models.js'
import { projectMembers, projects } from '../schema.js'
import type { ProjectRow } from './db.js'

/**
 * Project-level access control.
 *
 * `requires()` in the router only proves a permission at workspace scope. Everything that touches a
 * project goes through here as well, so per-project authz bindings (the project permission scheme)
 * and private-project membership are always applied — including for reads.
 */
export class AccessService {
  constructor(private readonly kernel: Kernel) {}

  /** True for callers that bypass tenancy checks entirely (other services, instance admins). */
  private privileged(principal: Principal): boolean {
    return principal.instanceAdmin || principal.kind === 'service'
  }

  async loadProject(tx: Tx, workspaceId: string, projectId: string): Promise<ProjectRow> {
    const [row] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))
      .limit(1)
    if (!row) throw KernError.notFound('Project')
    return row
  }

  async loadProjectByKey(tx: Tx, workspaceId: string, key: string): Promise<ProjectRow> {
    const [row] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.key, key.toUpperCase())))
      .limit(1)
    if (!row) throw KernError.notFound('Project')
    return row
  }

  async isProjectMember(
    tx: Tx,
    workspaceId: string,
    projectId: string,
    userId: string | null,
  ): Promise<boolean> {
    if (!userId) return false
    const [row] = await tx
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.workspaceId, workspaceId),
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
        ),
      )
      .limit(1)
    return !!row
  }

  /** Permission check at project scope, falling back to the workspace-effective set. */
  async can(
    principal: Principal,
    permission: string,
    workspaceId: string,
    projectId: string,
  ): Promise<boolean> {
    if (this.privileged(principal)) return true
    return this.kernel.authz.can(principal, permission, {
      kind: 'project',
      id: projectId,
      workspaceId,
      parents: [{ kind: 'workspace', id: workspaceId }],
    })
  }

  async require(
    principal: Principal,
    permission: string,
    workspaceId: string,
    projectId: string,
  ): Promise<void> {
    if (!(await this.can(principal, permission, workspaceId, projectId)))
      throw KernError.forbidden(permission)
  }

  /**
   * Permission check at workspace scope, for objects that are not owned by a project — a
   * workspace-wide label or issue template has no project whose scheme could grant the permission.
   */
  async requireWorkspace(principal: Principal, permission: string, workspaceId: string): Promise<void> {
    if (this.privileged(principal)) return
    await this.kernel.authz.require(principal, permission, {
      kind: 'workspace',
      id: workspaceId,
      workspaceId,
    })
  }

  /**
   * Load a project and assert the caller may act on it. Private projects additionally require
   * membership — a workspace-wide permission is not enough to see somebody else's private project.
   */
  async requireProject(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    permission = 'tracker.project.view',
  ): Promise<ProjectRow> {
    const project = await this.loadProject(tx, workspaceId, projectId)
    await this.assertAccess(tx, principal, project, permission)
    return project
  }

  async assertAccess(
    tx: Tx,
    principal: Principal,
    project: ProjectRow,
    permission = 'tracker.project.view',
  ): Promise<void> {
    if (this.privileged(principal)) return
    await this.require(principal, permission, project.workspaceId, project.id)
    if (
      project.visibility === 'private' &&
      !(await this.isProjectMember(tx, project.workspaceId, project.id, principal.userId))
    )
      throw KernError.forbidden('tracker.project.view')
  }

  /** Ids of every project the caller may read in this workspace (used to scope KQL queries). */
  async visibleProjectIds(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    opts: { includeArchived?: boolean; only?: string[] } = {},
  ): Promise<string[]> {
    const filters = [eq(projects.workspaceId, workspaceId)]
    if (!opts.includeArchived) filters.push(isNull(projects.archivedAt))
    if (opts.only?.length) filters.push(inArray(projects.id, opts.only))
    if (!this.privileged(principal) && principal.userId) {
      filters.push(
        or(
          eq(projects.visibility, 'workspace'),
          sql`exists (select 1 from ${projectMembers} where ${projectMembers.workspaceId} = ${workspaceId}::uuid and ${projectMembers.projectId} = ${projects.id} and ${projectMembers.userId} = ${principal.userId})`,
        )!,
      )
    } else if (!this.privileged(principal)) {
      return []
    }
    const rows = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(...filters))
    if (this.privileged(principal)) return rows.map((r) => r.id)
    // per-project deny bindings still have to be honoured
    const allowed: string[] = []
    for (const r of rows)
      if (await this.can(principal, 'tracker.project.view', workspaceId, r.id)) allowed.push(r.id)
    return allowed
  }

  /** `tracker.issue.edit` covers issues the caller reported or is assigned to; anything else needs `edit_any`. */
  async canEditIssue(
    principal: Principal,
    workspaceId: string,
    projectId: string,
    issue: { reporterId: string | null; creatorId: string | null; assigneeIds: string[] },
  ): Promise<boolean> {
    if (await this.can(principal, 'tracker.issue.edit_any', workspaceId, projectId)) return true
    const uid = principal.userId
    if (!uid) return false
    const own = issue.reporterId === uid || issue.creatorId === uid || issue.assigneeIds.includes(uid)
    return own && (await this.can(principal, 'tracker.issue.edit', workspaceId, projectId))
  }

  async requireEditIssue(
    principal: Principal,
    workspaceId: string,
    projectId: string,
    issue: { reporterId: string | null; creatorId: string | null; assigneeIds: string[] },
  ): Promise<void> {
    if (!(await this.canEditIssue(principal, workspaceId, projectId, issue)))
      throw KernError.forbidden('tracker.issue.edit')
  }

  /** The user id behind a request, for procedures that cannot act anonymously. */
  userId(principal: Principal): string {
    if (!principal.userId) throw KernError.unauthorized()
    return principal.userId
  }

  moduleId(): string {
    return MODULE_ID
  }
}
