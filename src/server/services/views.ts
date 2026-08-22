import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { type UpsertView as UpsertViewSchema, type View, ViewDisplay } from '../../contract/models.js'
import { parseKql } from '../../kql/parser.js'
import { viewPins, views } from '../schema.js'
import type { AccessService } from './access.js'
import { parseDisplay, toView, type ViewRow } from './db.js'
import type { NotifyService } from './notify.js'

type UpsertView = z.infer<typeof UpsertViewSchema>

/** Saved views: the KQL query plus how to draw it (list, board, calendar, timeline, spreadsheet). */
export class ViewService {
  constructor(
    private readonly kernel: Kernel,
    private readonly access: AccessService,
    private readonly notify: NotifyService,
  ) {}

  private async pinnedIds(tx: Tx, workspaceId: string, userId: string | null): Promise<Set<string>> {
    if (!userId) return new Set()
    const rows = await tx
      .select({ viewId: viewPins.viewId })
      .from(viewPins)
      .where(and(eq(viewPins.workspaceId, workspaceId), eq(viewPins.userId, userId)))
    return new Set(rows.map((r) => r.viewId))
  }

  async list(tx: Tx, principal: Principal, workspaceId: string, projectId?: string | null): Promise<View[]> {
    const visible = await this.access.visibleProjectIds(tx, principal, workspaceId)
    const userId = principal.userId
    const filters = [eq(views.workspaceId, workspaceId)]
    if (projectId === null) filters.push(isNull(views.projectId))
    else if (projectId) filters.push(eq(views.projectId, projectId))
    else filters.push(or(isNull(views.projectId), inArray(views.projectId, visible.length ? visible : ['']))!)
    const rows = await tx
      .select()
      .from(views)
      .where(and(...filters))
      .orderBy(asc(views.order), asc(views.name))
    const pinned = await this.pinnedIds(tx, workspaceId, userId)
    return rows.filter((r) => this.readable(r, principal, visible)).map((r) => toView(r, pinned.has(r.id)))
  }

  private readable(row: ViewRow, principal: Principal, visibleProjects: string[]): boolean {
    if (principal.instanceAdmin || principal.kind === 'service') return true
    if (row.visibility === 'private') return !!principal.userId && row.ownerId === principal.userId
    if (row.visibility === 'project') return !row.projectId || visibleProjects.includes(row.projectId)
    return true
  }

  async get(tx: Tx, principal: Principal, workspaceId: string, id: string): Promise<View> {
    const row = await this.row(tx, workspaceId, id)
    const visible = await this.access.visibleProjectIds(tx, principal, workspaceId)
    if (!this.readable(row, principal, visible)) throw KernError.forbidden('tracker.project.view')
    const pinned = await this.pinnedIds(tx, workspaceId, principal.userId)
    return toView(row, pinned.has(id))
  }

  private async row(tx: Tx, workspaceId: string, id: string): Promise<ViewRow> {
    const [row] = await tx
      .select()
      .from(views)
      .where(and(eq(views.workspaceId, workspaceId), eq(views.id, id)))
      .limit(1)
    if (!row) throw KernError.notFound('View')
    return row
  }

  private assertQueryParses(kql: string): void {
    const parsed = parseKql(kql)
    if (parsed.errors.length) throw KernError.badRequest(parsed.errors[0]!.message, { errors: parsed.errors })
  }

  private async requireShareRights(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    visibility: View['visibility'],
    projectId: string | null,
  ): Promise<void> {
    if (visibility === 'private') return
    if (projectId) await this.access.require(principal, 'tracker.view.manage_shared', workspaceId, projectId)
    else
      await this.kernel.authz.require(principal, 'tracker.view.manage_shared', {
        kind: 'workspace',
        id: workspaceId,
        workspaceId,
      })
    void tx
  }

  async create(tx: Tx, principal: Principal, workspaceId: string, input: UpsertView): Promise<View> {
    this.assertQueryParses(input.kql)
    const projectId = input.projectId ?? null
    if (projectId) await this.access.requireProject(tx, principal, workspaceId, projectId)
    await this.requireShareRights(tx, principal, workspaceId, input.visibility, projectId)
    const [row] = await tx
      .insert(views)
      .values({
        id: uuidv7(),
        workspaceId,
        projectId,
        name: input.name,
        description: input.description ?? null,
        icon: input.icon ?? null,
        kql: input.kql,
        layout: input.layout,
        display: ViewDisplay.parse(input.display ?? {}),
        filters: input.filters ?? {},
        visibility: input.visibility,
        ownerId: principal.userId ?? null,
        order: input.order ?? 0,
      })
      .returning()
    await this.notify.change(workspaceId, 'view', row!.id, 'created')
    return toView(row!, false)
  }

  async update(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    id: string,
    patch: Partial<UpsertView>,
  ): Promise<View> {
    const current = await this.row(tx, workspaceId, id)
    await this.requireEdit(tx, principal, workspaceId, current)
    if (patch.kql !== undefined) this.assertQueryParses(patch.kql)
    if (patch.visibility && patch.visibility !== current.visibility)
      await this.requireShareRights(tx, principal, workspaceId, patch.visibility, current.projectId)
    const display =
      patch.display === undefined
        ? undefined
        : ViewDisplay.parse({ ...parseDisplay(current.display), ...patch.display })
    const [row] = await tx
      .update(views)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.icon === undefined ? {} : { icon: patch.icon }),
        ...(patch.kql === undefined ? {} : { kql: patch.kql }),
        ...(patch.layout === undefined ? {} : { layout: patch.layout }),
        ...(display === undefined ? {} : { display }),
        ...(patch.filters === undefined ? {} : { filters: patch.filters }),
        ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
        ...(patch.projectId === undefined ? {} : { projectId: patch.projectId }),
        ...(patch.order === undefined ? {} : { order: patch.order }),
        updatedAt: new Date(),
      })
      .where(and(eq(views.workspaceId, workspaceId), eq(views.id, id)))
      .returning()
    const pinned = await this.pinnedIds(tx, workspaceId, principal.userId)
    await this.notify.change(workspaceId, 'view', id, 'updated')
    return toView(row!, pinned.has(id))
  }

  private async requireEdit(tx: Tx, principal: Principal, workspaceId: string, row: ViewRow): Promise<void> {
    if (principal.instanceAdmin || principal.kind === 'service') return
    if (row.ownerId && row.ownerId === principal.userId) return
    await this.requireShareRights(
      tx,
      principal,
      workspaceId,
      row.visibility as View['visibility'],
      row.projectId,
    )
  }

  async delete(tx: Tx, principal: Principal, workspaceId: string, id: string): Promise<void> {
    const current = await this.row(tx, workspaceId, id)
    if (current.builtin) throw KernError.conflict('Built-in views cannot be deleted', 'tracker.view.builtin')
    await this.requireEdit(tx, principal, workspaceId, current)
    await tx.delete(viewPins).where(eq(viewPins.viewId, id))
    await tx.delete(views).where(and(eq(views.workspaceId, workspaceId), eq(views.id, id)))
    await this.notify.change(workspaceId, 'view', id, 'deleted')
  }

  /** Pinning is per user: it never changes the shared view row. */
  async pin(tx: Tx, principal: Principal, workspaceId: string, id: string, pinned: boolean): Promise<View> {
    const row = await this.row(tx, workspaceId, id)
    const userId = this.access.userId(principal)
    if (pinned)
      await tx
        .insert(viewPins)
        .values({ viewId: id, workspaceId, userId })
        .onConflictDoNothing({ target: [viewPins.viewId, viewPins.userId] })
    else await tx.delete(viewPins).where(and(eq(viewPins.viewId, id), eq(viewPins.userId, userId)))
    return toView(row, pinned)
  }

  /** Views pinned by a user across the workspace (sidebar). */
  async pinnedFor(tx: Tx, workspaceId: string, userId: string): Promise<View[]> {
    const rows = await tx
      .select({ view: views })
      .from(viewPins)
      .innerJoin(views, eq(views.id, viewPins.viewId))
      .where(and(eq(viewPins.workspaceId, workspaceId), eq(viewPins.userId, userId)))
      .orderBy(asc(views.order))
    return rows.map((r) => toView(r.view, true))
  }

  /** Count of views in a workspace (used by the workspace overview). */
  async count(tx: Tx, workspaceId: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(views)
      .where(eq(views.workspaceId, workspaceId))
    return row?.n ?? 0
  }
}
