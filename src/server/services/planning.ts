import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { trackerEvents } from '../../contract/events.js'
import type {
  Component,
  Cycle,
  CycleStatus,
  Label,
  Milestone,
  UpsertComponent as UpsertComponentSchema,
  UpsertCycle as UpsertCycleSchema,
  UpsertLabel as UpsertLabelSchema,
  UpsertMilestone as UpsertMilestoneSchema,
  UpsertVersion as UpsertVersionSchema,
  Version,
} from '../../contract/models.js'
import { components, cycles, issueCounters, issues, labels, milestones, versions } from '../schema.js'
import type { AccessService } from './access.js'
import {
  type CycleStats,
  EMPTY_CYCLE_STATS,
  toComponent,
  toCycle,
  toLabel,
  toMilestone,
  toVersion,
} from './db.js'
import type { NotifyService } from './notify.js'

type UpsertCycle = z.infer<typeof UpsertCycleSchema>
type UpsertMilestone = z.infer<typeof UpsertMilestoneSchema>
type UpsertVersion = z.infer<typeof UpsertVersionSchema>
type UpsertComponent = z.infer<typeof UpsertComponentSchema>
type UpsertLabel = z.infer<typeof UpsertLabelSchema>

const RESOLVED = ['done', 'cancelled']

export class PlanningService {
  constructor(
    private readonly kernel: Kernel,
    private readonly access: AccessService,
    private readonly notify: NotifyService,
  ) {}

  // ------------------------------------------------------------------ cycles

  private async cycleStats(tx: Tx, cycleIds: string[]): Promise<Map<string, CycleStats>> {
    const out = new Map<string, CycleStats>()
    for (const id of cycleIds) out.set(id, { ...EMPTY_CYCLE_STATS })
    if (!cycleIds.length) return out
    const rows = await tx
      .select({
        cycleId: issues.cycleId,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${issues.statusCategory} in ('done','cancelled'))::int`,
        estimateTotal: sql<number>`coalesce(sum(${issues.estimate}), 0)::float8`,
        estimateDone: sql<number>`coalesce(sum(${issues.estimate}) filter (where ${issues.statusCategory} in ('done','cancelled')), 0)::float8`,
      })
      .from(issues)
      .where(and(inArray(issues.cycleId, cycleIds), isNull(issues.archivedAt)))
      .groupBy(issues.cycleId)
    for (const row of rows)
      if (row.cycleId)
        out.set(row.cycleId, {
          total: Number(row.total),
          done: Number(row.done),
          estimateTotal: Number(row.estimateTotal),
          estimateDone: Number(row.estimateDone),
        })
    return out
  }

  async listCycles(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    status?: CycleStatus,
  ): Promise<Cycle[]> {
    await this.access.requireProject(tx, principal, workspaceId, projectId)
    const filters = [eq(cycles.workspaceId, workspaceId), eq(cycles.projectId, projectId)]
    if (status) filters.push(eq(cycles.status, status))
    const rows = await tx
      .select()
      .from(cycles)
      .where(and(...filters))
      .orderBy(asc(cycles.number))
    const stats = await this.cycleStats(
      tx,
      rows.map((r) => r.id),
    )
    return rows.map((r) => toCycle(r, stats.get(r.id)))
  }

  async getCycle(tx: Tx, principal: Principal, workspaceId: string, id: string): Promise<Cycle> {
    const row = await this.cycleRow(tx, workspaceId, id)
    await this.access.requireProject(tx, principal, workspaceId, row.projectId)
    const stats = await this.cycleStats(tx, [id])
    return toCycle(row, stats.get(id))
  }

  private async cycleRow(tx: Tx, workspaceId: string, id: string) {
    const [row] = await tx
      .select()
      .from(cycles)
      .where(and(eq(cycles.workspaceId, workspaceId), eq(cycles.id, id)))
      .limit(1)
    if (!row) throw KernError.notFound('Cycle')
    return row
  }

  async createCycle(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    input: UpsertCycle,
  ): Promise<Cycle> {
    await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.cycle.manage')
    if (new Date(input.endAt) <= new Date(input.startAt))
      throw KernError.badRequest('A cycle must end after it starts')
    await tx
      .insert(issueCounters)
      .values({ projectId, workspaceId })
      .onConflictDoNothing({ target: issueCounters.projectId })
    const [counter] = await tx
      .update(issueCounters)
      .set({ lastCycleNumber: sql`${issueCounters.lastCycleNumber} + 1` })
      .where(eq(issueCounters.projectId, projectId))
      .returning({ n: issueCounters.lastCycleNumber })
    const number = counter?.n ?? 1
    const [row] = await tx
      .insert(cycles)
      .values({
        id: uuidv7(),
        workspaceId,
        projectId,
        number,
        name: input.name ?? `Cycle ${number}`,
        goal: input.goal ?? null,
        startAt: new Date(input.startAt),
        endAt: new Date(input.endAt),
        status: 'upcoming',
      })
      .returning()
    await this.notify.change(workspaceId, 'cycle', row!.id, 'created', { scope: { projectId } })
    return toCycle(row!)
  }

  async updateCycle(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    id: string,
    patch: Partial<UpsertCycle>,
  ): Promise<Cycle> {
    const current = await this.cycleRow(tx, workspaceId, id)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.cycle.manage')
    const [row] = await tx
      .update(cycles)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.goal === undefined ? {} : { goal: patch.goal }),
        ...(patch.startAt === undefined ? {} : { startAt: new Date(patch.startAt) }),
        ...(patch.endAt === undefined ? {} : { endAt: new Date(patch.endAt) }),
        updatedAt: new Date(),
      })
      .where(and(eq(cycles.workspaceId, workspaceId), eq(cycles.id, id)))
      .returning()
    const stats = await this.cycleStats(tx, [id])
    await this.notify.change(workspaceId, 'cycle', id, 'updated', { scope: { projectId: current.projectId } })
    return toCycle(row!, stats.get(id))
  }

  async deleteCycle(tx: Tx, principal: Principal, workspaceId: string, id: string): Promise<void> {
    const current = await this.cycleRow(tx, workspaceId, id)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.cycle.manage')
    await tx.update(issues).set({ cycleId: null }).where(eq(issues.cycleId, id))
    await tx.delete(cycles).where(and(eq(cycles.workspaceId, workspaceId), eq(cycles.id, id)))
    await this.notify.change(workspaceId, 'cycle', id, 'deleted', { scope: { projectId: current.projectId } })
  }

  /** Starting a cycle snapshots its scope so velocity can compare committed against completed. */
  async startCycle(tx: Tx, principal: Principal, workspaceId: string, id: string): Promise<Cycle> {
    const current = await this.cycleRow(tx, workspaceId, id)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.cycle.manage')
    if (current.status === 'completed') throw KernError.conflict('Cycle is already completed')
    const [running] = await tx
      .select({ id: cycles.id })
      .from(cycles)
      .where(
        and(
          eq(cycles.workspaceId, workspaceId),
          eq(cycles.projectId, current.projectId),
          eq(cycles.status, 'active'),
        ),
      )
      .limit(1)
    if (running && running.id !== id)
      throw KernError.conflict('Another cycle is already active in this project', 'tracker.cycle.active')
    const stats = (await this.cycleStats(tx, [id])).get(id) ?? EMPTY_CYCLE_STATS
    const [row] = await tx
      .update(cycles)
      .set({
        status: 'active',
        startedAt: new Date(),
        committed: { total: stats.total, estimateTotal: stats.estimateTotal },
        updatedAt: new Date(),
      })
      .where(and(eq(cycles.workspaceId, workspaceId), eq(cycles.id, id)))
      .returning()
    await this.kernel.emit(
      trackerEvents.cycleStarted,
      {
        workspaceId: workspaceId as Cycle['workspaceId'],
        projectId: current.projectId,
        cycleId: id,
        number: current.number,
      },
      { workspaceId, actorId: principal.userId },
    )
    await this.notify.change(workspaceId, 'cycle', id, 'updated', { scope: { projectId: current.projectId } })
    return toCycle(row!, stats)
  }

  /** Complete a cycle; unfinished work rolls into `rollToCycleId`, the next upcoming cycle, or the backlog. */
  async completeCycle(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    id: string,
    rollToCycleId?: string | null,
  ): Promise<Cycle> {
    const current = await this.cycleRow(tx, workspaceId, id)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.cycle.manage')
    if (current.status === 'completed') return this.getCycle(tx, principal, workspaceId, id)

    let target: string | null = rollToCycleId ?? null
    if (target === undefined || target === null) {
      const [next] = await tx
        .select({ id: cycles.id })
        .from(cycles)
        .where(
          and(
            eq(cycles.workspaceId, workspaceId),
            eq(cycles.projectId, current.projectId),
            eq(cycles.status, 'upcoming'),
          ),
        )
        .orderBy(asc(cycles.startAt))
        .limit(1)
      target = next?.id ?? null
    }
    const unfinished = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.workspaceId, workspaceId),
          eq(issues.cycleId, id),
          isNull(issues.archivedAt),
          sql`${issues.statusCategory} not in ('done','cancelled')`,
        ),
      )
    if (unfinished.length)
      await tx
        .update(issues)
        .set({ cycleId: target, updatedAt: new Date() })
        .where(
          inArray(
            issues.id,
            unfinished.map((r) => r.id),
          ),
        )
    if (target && unfinished.length)
      await tx
        .update(cycles)
        .set({ carryOverCount: sql`${cycles.carryOverCount} + ${unfinished.length}` })
        .where(eq(cycles.id, target))

    const stats = (await this.cycleStats(tx, [id])).get(id) ?? EMPTY_CYCLE_STATS
    const [row] = await tx
      .update(cycles)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(cycles.workspaceId, workspaceId), eq(cycles.id, id)))
      .returning()
    await this.kernel.emit(
      trackerEvents.cycleCompleted,
      {
        workspaceId: workspaceId as Cycle['workspaceId'],
        projectId: current.projectId,
        cycleId: id,
        number: current.number,
        carriedOver: unfinished.length,
      },
      { workspaceId, actorId: principal.userId },
    )
    await this.notify.change(workspaceId, 'cycle', id, 'updated', { scope: { projectId: current.projectId } })
    return toCycle(row!, stats)
  }

  // ------------------------------------------------------------------ milestones

  private async countByColumn(
    tx: Tx,
    column: typeof issues.milestoneId,
    ids: string[],
  ): Promise<Map<string, { total: number; done: number }>> {
    const out = new Map<string, { total: number; done: number }>()
    for (const id of ids) out.set(id, { total: 0, done: 0 })
    if (!ids.length) return out
    const rows = await tx
      .select({
        key: column,
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${issues.statusCategory} in ('done','cancelled'))::int`,
      })
      .from(issues)
      .where(and(inArray(column, ids), isNull(issues.archivedAt)))
      .groupBy(column)
    for (const row of rows)
      if (row.key) out.set(row.key, { total: Number(row.total), done: Number(row.done) })
    return out
  }

  async listMilestones(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
  ): Promise<Milestone[]> {
    await this.access.requireProject(tx, principal, workspaceId, projectId)
    const rows = await tx
      .select()
      .from(milestones)
      .where(and(eq(milestones.workspaceId, workspaceId), eq(milestones.projectId, projectId)))
      .orderBy(asc(milestones.targetDate), asc(milestones.name))
    const stats = await this.countByColumn(
      tx,
      issues.milestoneId,
      rows.map((r) => r.id),
    )
    return rows.map((r) => toMilestone(r, stats.get(r.id)))
  }

  async createMilestone(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    input: UpsertMilestone,
  ): Promise<Milestone> {
    await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.cycle.manage')
    const [row] = await tx
      .insert(milestones)
      .values({
        id: uuidv7(),
        workspaceId,
        projectId,
        name: input.name,
        description: input.description ?? null,
        targetDate: input.targetDate ?? null,
        status: input.status ?? 'open',
      })
      .returning()
    await this.notify.change(workspaceId, 'milestone', row!.id, 'created', { scope: { projectId } })
    return toMilestone(row!)
  }

  async updateMilestone(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    id: string,
    patch: Partial<UpsertMilestone>,
  ): Promise<Milestone> {
    const [current] = await tx
      .select()
      .from(milestones)
      .where(and(eq(milestones.workspaceId, workspaceId), eq(milestones.id, id)))
      .limit(1)
    if (!current) throw KernError.notFound('Milestone')
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.cycle.manage')
    const [row] = await tx
      .update(milestones)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.targetDate === undefined ? {} : { targetDate: patch.targetDate }),
        ...(patch.status === undefined
          ? {}
          : { status: patch.status, completedAt: patch.status === 'completed' ? new Date() : null }),
        updatedAt: new Date(),
      })
      .where(and(eq(milestones.workspaceId, workspaceId), eq(milestones.id, id)))
      .returning()
    const stats = await this.countByColumn(tx, issues.milestoneId, [id])
    await this.notify.change(workspaceId, 'milestone', id, 'updated', {
      scope: { projectId: current.projectId },
    })
    return toMilestone(row!, stats.get(id))
  }

  async deleteMilestone(tx: Tx, principal: Principal, workspaceId: string, id: string): Promise<void> {
    const [current] = await tx
      .select()
      .from(milestones)
      .where(and(eq(milestones.workspaceId, workspaceId), eq(milestones.id, id)))
      .limit(1)
    if (!current) throw KernError.notFound('Milestone')
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.cycle.manage')
    await tx.update(issues).set({ milestoneId: null }).where(eq(issues.milestoneId, id))
    await tx.delete(milestones).where(and(eq(milestones.workspaceId, workspaceId), eq(milestones.id, id)))
    await this.notify.change(workspaceId, 'milestone', id, 'deleted', {
      scope: { projectId: current.projectId },
    })
  }

  // ------------------------------------------------------------------ versions

  private async versionStats(tx: Tx, ids: string[]): Promise<Map<string, { total: number; done: number }>> {
    const out = new Map<string, { total: number; done: number }>()
    for (const id of ids) out.set(id, { total: 0, done: 0 })
    if (!ids.length) return out
    const rows = await tx.execute<{ id: string; total: number; done: number }>(sql`
      select v.id, count(i.id)::int as total,
             count(i.id) filter (where i.status_category in ('done','cancelled'))::int as done
      from unnest(${sql.param(ids)}::uuid[]) as v(id)
      left join ${issues} i on v.id = any(i.version_ids) and i.archived_at is null
      group by v.id`)
    for (const row of rows.rows) out.set(row.id, { total: Number(row.total), done: Number(row.done) })
    return out
  }

  async listVersions(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
  ): Promise<Version[]> {
    await this.access.requireProject(tx, principal, workspaceId, projectId)
    const rows = await tx
      .select()
      .from(versions)
      .where(and(eq(versions.workspaceId, workspaceId), eq(versions.projectId, projectId)))
      .orderBy(asc(versions.order), asc(versions.name))
    const stats = await this.versionStats(
      tx,
      rows.map((r) => r.id),
    )
    return rows.map((r) => toVersion(r, stats.get(r.id)))
  }

  async createVersion(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    input: UpsertVersion,
  ): Promise<Version> {
    await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.version.manage')
    const [row] = await tx
      .insert(versions)
      .values({
        id: uuidv7(),
        workspaceId,
        projectId,
        name: input.name,
        description: input.description ?? null,
        startDate: input.startDate ?? null,
        releaseDate: input.releaseDate ?? null,
        order: input.order ?? 0,
      })
      .returning()
    await this.notify.change(workspaceId, 'version', row!.id, 'created', { scope: { projectId } })
    return toVersion(row!)
  }

  async updateVersion(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    id: string,
    patch: Partial<UpsertVersion>,
  ): Promise<Version> {
    const current = await this.versionRow(tx, workspaceId, id)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.version.manage')
    const [row] = await tx
      .update(versions)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.startDate === undefined ? {} : { startDate: patch.startDate }),
        ...(patch.releaseDate === undefined ? {} : { releaseDate: patch.releaseDate }),
        ...(patch.order === undefined ? {} : { order: patch.order }),
        updatedAt: new Date(),
      })
      .where(and(eq(versions.workspaceId, workspaceId), eq(versions.id, id)))
      .returning()
    const stats = await this.versionStats(tx, [id])
    await this.notify.change(workspaceId, 'version', id, 'updated', {
      scope: { projectId: current.projectId },
    })
    return toVersion(row!, stats.get(id))
  }

  private async versionRow(tx: Tx, workspaceId: string, id: string) {
    const [row] = await tx
      .select()
      .from(versions)
      .where(and(eq(versions.workspaceId, workspaceId), eq(versions.id, id)))
      .limit(1)
    if (!row) throw KernError.notFound('Version')
    return row
  }

  async deleteVersion(tx: Tx, principal: Principal, workspaceId: string, id: string): Promise<void> {
    const current = await this.versionRow(tx, workspaceId, id)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.version.manage')
    await tx
      .update(issues)
      .set({
        versionIds: sql`array_remove(${issues.versionIds}, ${id}::uuid)`,
        affectsVersionIds: sql`array_remove(${issues.affectsVersionIds}, ${id}::uuid)`,
      })
      .where(sql`${id}::uuid = any(${issues.versionIds}) or ${id}::uuid = any(${issues.affectsVersionIds})`)
    await tx.delete(versions).where(and(eq(versions.workspaceId, workspaceId), eq(versions.id, id)))
    await this.notify.change(workspaceId, 'version', id, 'deleted', {
      scope: { projectId: current.projectId },
    })
  }

  async releaseVersion(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    id: string,
    released: boolean,
  ): Promise<Version> {
    const current = await this.versionRow(tx, workspaceId, id)
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.version.manage')
    const [row] = await tx
      .update(versions)
      .set({
        status: released ? 'released' : 'unreleased',
        releasedAt: released ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(versions.workspaceId, workspaceId), eq(versions.id, id)))
      .returning()
    if (released)
      await this.kernel.emit(
        trackerEvents.versionReleased,
        {
          workspaceId: workspaceId as Version['workspaceId'],
          projectId: current.projectId,
          versionId: id,
          name: current.name,
        },
        { workspaceId, actorId: principal.userId },
      )
    const stats = await this.versionStats(tx, [id])
    await this.notify.change(workspaceId, 'version', id, 'updated', {
      scope: { projectId: current.projectId },
    })
    return toVersion(row!, stats.get(id))
  }

  // ------------------------------------------------------------------ components

  async listComponents(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
  ): Promise<Component[]> {
    await this.access.requireProject(tx, principal, workspaceId, projectId)
    const rows = await tx
      .select()
      .from(components)
      .where(and(eq(components.workspaceId, workspaceId), eq(components.projectId, projectId)))
      .orderBy(asc(components.name))
    const counts = await this.arrayCounts(
      tx,
      'component_ids',
      rows.map((r) => r.id),
    )
    return rows.map((r) => toComponent(r, counts.get(r.id) ?? 0))
  }

  private async arrayCounts(tx: Tx, column: string, ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    if (!ids.length) return out
    const rows = await tx.execute<{ id: string; n: number }>(sql`
      select v.id, count(i.id)::int as n
      from unnest(${sql.param(ids)}::uuid[]) as v(id)
      left join ${issues} i on v.id = any(i.${sql.raw(column)}) and i.archived_at is null
      group by v.id`)
    for (const row of rows.rows) out.set(row.id, Number(row.n))
    return out
  }

  async createComponent(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    input: UpsertComponent,
  ): Promise<Component> {
    await this.access.requireProject(tx, principal, workspaceId, projectId, 'tracker.project.manage')
    const [row] = await tx
      .insert(components)
      .values({
        id: uuidv7(),
        workspaceId,
        projectId,
        name: input.name,
        description: input.description ?? null,
        leadId: input.leadId ?? null,
        defaultAssignee: input.defaultAssignee ?? 'project',
      })
      .returning()
    await this.notify.change(workspaceId, 'component', row!.id, 'created', { scope: { projectId } })
    return toComponent(row!)
  }

  async updateComponent(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    id: string,
    patch: Partial<UpsertComponent>,
  ): Promise<Component> {
    const [current] = await tx
      .select()
      .from(components)
      .where(and(eq(components.workspaceId, workspaceId), eq(components.id, id)))
      .limit(1)
    if (!current) throw KernError.notFound('Component')
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.project.manage')
    const [row] = await tx
      .update(components)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.leadId === undefined ? {} : { leadId: patch.leadId }),
        ...(patch.defaultAssignee === undefined ? {} : { defaultAssignee: patch.defaultAssignee }),
        updatedAt: new Date(),
      })
      .where(and(eq(components.workspaceId, workspaceId), eq(components.id, id)))
      .returning()
    const counts = await this.arrayCounts(tx, 'component_ids', [id])
    await this.notify.change(workspaceId, 'component', id, 'updated', {
      scope: { projectId: current.projectId },
    })
    return toComponent(row!, counts.get(id) ?? 0)
  }

  async deleteComponent(tx: Tx, principal: Principal, workspaceId: string, id: string): Promise<void> {
    const [current] = await tx
      .select()
      .from(components)
      .where(and(eq(components.workspaceId, workspaceId), eq(components.id, id)))
      .limit(1)
    if (!current) throw KernError.notFound('Component')
    await this.access.requireProject(tx, principal, workspaceId, current.projectId, 'tracker.project.manage')
    await tx
      .update(issues)
      .set({ componentIds: sql`array_remove(${issues.componentIds}, ${id}::uuid)` })
      .where(sql`${id}::uuid = any(${issues.componentIds})`)
    await tx.delete(components).where(and(eq(components.workspaceId, workspaceId), eq(components.id, id)))
    await this.notify.change(workspaceId, 'component', id, 'deleted', {
      scope: { projectId: current.projectId },
    })
  }

  // ------------------------------------------------------------------ labels

  async listLabels(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId?: string,
    includeArchived = false,
  ): Promise<Label[]> {
    if (projectId) await this.access.requireProject(tx, principal, workspaceId, projectId)
    const filters = [eq(labels.workspaceId, workspaceId)]
    if (!includeArchived) filters.push(isNull(labels.archivedAt))
    if (projectId) filters.push(sql`(${labels.projectId} is null or ${labels.projectId} = ${projectId})`)
    const rows = await tx
      .select()
      .from(labels)
      .where(and(...filters))
      .orderBy(asc(labels.groupName), asc(labels.name))
    const counts = await this.arrayCounts(
      tx,
      'label_ids',
      rows.map((r) => r.id),
    )
    return rows.map((r) => toLabel(r, counts.get(r.id) ?? 0))
  }

  async createLabel(tx: Tx, principal: Principal, workspaceId: string, input: UpsertLabel): Promise<Label> {
    if (input.projectId)
      await this.access.requireProject(tx, principal, workspaceId, input.projectId, 'tracker.project.manage')
    const [row] = await tx
      .insert(labels)
      .values({
        id: uuidv7(),
        workspaceId,
        projectId: input.projectId ?? null,
        name: input.name,
        color: input.color ?? null,
        description: input.description ?? null,
        groupName: input.groupName ?? null,
      })
      .returning()
    await this.notify.change(workspaceId, 'label', row!.id, 'created')
    return toLabel(row!)
  }

  async updateLabel(tx: Tx, workspaceId: string, id: string, patch: Partial<UpsertLabel>): Promise<Label> {
    const [row] = await tx
      .update(labels)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.color === undefined ? {} : { color: patch.color }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.groupName === undefined ? {} : { groupName: patch.groupName }),
        ...(patch.projectId === undefined ? {} : { projectId: patch.projectId }),
      })
      .where(and(eq(labels.workspaceId, workspaceId), eq(labels.id, id)))
      .returning()
    if (!row) throw KernError.notFound('Label')
    const counts = await this.arrayCounts(tx, 'label_ids', [id])
    await this.notify.change(workspaceId, 'label', id, 'updated')
    return toLabel(row, counts.get(id) ?? 0)
  }

  async deleteLabel(tx: Tx, workspaceId: string, id: string): Promise<void> {
    await tx
      .update(issues)
      .set({ labelIds: sql`array_remove(${issues.labelIds}, ${id}::uuid)` })
      .where(sql`${id}::uuid = any(${issues.labelIds})`)
    await tx.delete(labels).where(and(eq(labels.workspaceId, workspaceId), eq(labels.id, id)))
    await this.notify.change(workspaceId, 'label', id, 'deleted')
  }

  /** Find or create a label by name, used by CSV import and email ingest. */
  async ensureLabel(tx: Tx, workspaceId: string, projectId: string | null, name: string): Promise<string> {
    const [existing] = await tx
      .select({ id: labels.id })
      .from(labels)
      .where(
        and(
          eq(labels.workspaceId, workspaceId),
          eq(labels.name, name),
          projectId ? eq(labels.projectId, projectId) : isNull(labels.projectId),
        ),
      )
      .limit(1)
    if (existing) return existing.id
    const [row] = await tx
      .insert(labels)
      .values({ id: uuidv7(), workspaceId, projectId, name })
      .returning({ id: labels.id })
    return row!.id
  }

  /** Statuses considered resolved when rolling a cycle over. */
  resolvedCategories(): string[] {
    return RESOLVED
  }
}
