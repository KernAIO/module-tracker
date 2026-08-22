import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx } from '@kernhq/kernel'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type {
  BurndownReport,
  CfdReport,
  CreatedVsResolvedReport,
  TimeReport,
  TimesheetRow,
  VelocityReport,
} from '../../contract/models.js'
import { dateOnly } from '../../kql/dates.js'
import { cycles, issueStatusHistory, issues } from '../schema.js'
import type { AccessService } from './access.js'
import type { ConfigService } from './config.js'
import { parseSettings, toCycle } from './db.js'
import type { PlanningService } from './planning.js'
import type { TimeService } from './time.js'

const DAY_MS = 86_400_000
const RESOLVED = ['done', 'cancelled']

/** Inclusive list of `YYYY-MM-DD` between two dates. */
function dayRange(from: string, to: string, max = 400): string[] {
  const start = new Date(`${from}T00:00:00.000Z`).getTime()
  const end = new Date(`${to}T00:00:00.000Z`).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end < start)
    throw KernError.badRequest('Invalid date range')
  const days: string[] = []
  for (let t = start; t <= end && days.length < max; t += DAY_MS) days.push(dateOnly(new Date(t)))
  return days
}

export class ReportService {
  constructor(
    private readonly kernel: Kernel,
    private readonly access: AccessService,
    private readonly config: ConfigService,
    private readonly planning: PlanningService,
    private readonly timeService: TimeService,
  ) {}

  // ------------------------------------------------------------------ burndown

  async burndown(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    cycleId: string,
  ): Promise<BurndownReport> {
    const [cycleRow] = await tx
      .select()
      .from(cycles)
      .where(and(eq(cycles.workspaceId, workspaceId), eq(cycles.id, cycleId)))
      .limit(1)
    if (!cycleRow) throw KernError.notFound('Cycle')
    const project = await this.access.requireProject(tx, principal, workspaceId, cycleRow.projectId)
    const unit = parseSettings(project.settings).estimation

    const rows = await tx
      .select({
        id: issues.id,
        estimate: issues.estimate,
        createdAt: issues.createdAt,
        completedAt: issues.completedAt,
        cancelledAt: issues.cancelledAt,
        statusCategory: issues.statusCategory,
      })
      .from(issues)
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.cycleId, cycleId), isNull(issues.archivedAt)))

    const weight = (estimate: number | null) => (unit === 'none' ? 1 : (estimate ?? 0))
    const days = dayRange(dateOnly(cycleRow.startAt), dateOnly(cycleRow.endAt), 120)
    const totalScope = rows.reduce((sum, r) => sum + weight(r.estimate), 0)

    let previousScope = 0
    const points = days.map((date, index) => {
      const endOfDay = new Date(`${date}T23:59:59.999Z`)
      const scope = rows
        .filter((r) => r.createdAt <= endOfDay)
        .reduce((sum, r) => sum + weight(r.estimate), 0)
      const completed = rows
        .filter((r) => {
          const at = r.completedAt ?? r.cancelledAt
          return at != null && at <= endOfDay
        })
        .reduce((sum, r) => sum + weight(r.estimate), 0)
      const ideal = days.length > 1 ? totalScope * (1 - index / (days.length - 1)) : 0
      const point = {
        date,
        remaining: Math.max(0, scope - completed),
        ideal: Number(ideal.toFixed(2)),
        completed,
        scope,
        scopeChange: index === 0 ? 0 : scope - previousScope,
      }
      previousScope = scope
      return point
    })

    const stats = {
      total: rows.length,
      done: rows.filter((r) => RESOLVED.includes(r.statusCategory)).length,
      estimateTotal: totalScope,
      estimateDone: rows
        .filter((r) => RESOLVED.includes(r.statusCategory))
        .reduce((sum, r) => sum + weight(r.estimate), 0),
    }
    return { cycle: toCycle(cycleRow, stats), unit, points }
  }

  // ------------------------------------------------------------------ velocity

  async velocity(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    lastN: number,
  ): Promise<VelocityReport> {
    const project = await this.access.requireProject(tx, principal, workspaceId, projectId)
    const unit = parseSettings(project.settings).estimation
    const rows = await tx
      .select()
      .from(cycles)
      .where(
        and(
          eq(cycles.workspaceId, workspaceId),
          eq(cycles.projectId, projectId),
          inArray(cycles.status, ['completed', 'active']),
        ),
      )
      .orderBy(desc(cycles.number))
      .limit(lastN)
    const ordered = rows.reverse()
    const weight = (estimate: number | null) => (unit === 'none' ? 1 : (estimate ?? 0))

    const entries: VelocityReport['cycles'] = []
    for (const row of ordered) {
      const issueRows = await tx
        .select({ estimate: issues.estimate, statusCategory: issues.statusCategory })
        .from(issues)
        .where(
          and(eq(issues.workspaceId, workspaceId), eq(issues.cycleId, row.id), isNull(issues.archivedAt)),
        )
      const committedSnapshot = (row.committed as { total?: number; estimateTotal?: number }) ?? {}
      const completedRows = issueRows.filter((r) => r.statusCategory === 'done')
      entries.push({
        cycle: {
          id: row.id,
          number: row.number,
          name: row.name,
          startAt: row.startAt.toISOString(),
          endAt: row.endAt.toISOString(),
          status: row.status as VelocityReport['cycles'][number]['cycle']['status'],
        },
        committed:
          committedSnapshot.estimateTotal ?? issueRows.reduce((sum, r) => sum + weight(r.estimate), 0),
        completed: completedRows.reduce((sum, r) => sum + weight(r.estimate), 0),
        committedCount: committedSnapshot.total ?? issueRows.length,
        completedCount: completedRows.length,
      })
    }
    const average = entries.length
      ? Number((entries.reduce((sum, e) => sum + e.completed, 0) / entries.length).toFixed(2))
      : 0
    return { unit, cycles: entries, average }
  }

  // ------------------------------------------------------------------ cumulative flow

  async cfd(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    from: string,
    to: string,
  ): Promise<CfdReport> {
    await this.access.requireProject(tx, principal, workspaceId, projectId)
    const statuses = await this.config.statusesForProject(tx, workspaceId, projectId)
    const days = dayRange(from, to)
    const end = new Date(`${to}T23:59:59.999Z`)

    const history = await tx
      .select({
        issueId: issueStatusHistory.issueId,
        toStatusId: issueStatusHistory.toStatusId,
        occurredAt: issueStatusHistory.occurredAt,
      })
      .from(issueStatusHistory)
      .where(
        and(
          eq(issueStatusHistory.workspaceId, workspaceId),
          eq(issueStatusHistory.projectId, projectId),
          sql`${issueStatusHistory.occurredAt} <= ${end.toISOString()}`,
        ),
      )
      .orderBy(asc(issueStatusHistory.occurredAt))

    const timeline = new Map<string, Array<{ at: number; statusId: string }>>()
    for (const row of history) {
      const list = timeline.get(row.issueId) ?? []
      list.push({ at: row.occurredAt.getTime(), statusId: row.toStatusId })
      timeline.set(row.issueId, list)
    }

    const points = days.map((date) => {
      const cutoff = new Date(`${date}T23:59:59.999Z`).getTime()
      const counts: Record<string, number> = {}
      for (const status of statuses) counts[status.id] = 0
      for (const entries of timeline.values()) {
        let current: string | null = null
        for (const entry of entries) {
          if (entry.at > cutoff) break
          current = entry.statusId
        }
        if (current) counts[current] = (counts[current] ?? 0) + 1
      }
      return { date, counts }
    })
    return {
      statuses: statuses.map((s) => ({ id: s.id, name: s.name, category: s.category, color: s.color })),
      points,
    }
  }

  // ------------------------------------------------------------------ created vs resolved

  async createdVsResolved(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    projectId: string,
    from: string,
    to: string,
  ): Promise<CreatedVsResolvedReport> {
    await this.access.requireProject(tx, principal, workspaceId, projectId)
    const days = dayRange(from, to)
    const end = new Date(`${to}T23:59:59.999Z`)
    const rows = await tx
      .select({
        createdAt: issues.createdAt,
        completedAt: issues.completedAt,
        cancelledAt: issues.cancelledAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.workspaceId, workspaceId),
          eq(issues.projectId, projectId),
          sql`${issues.createdAt} <= ${end.toISOString()}`,
        ),
      )
    const points = days.map((date) => {
      const dayStart = new Date(`${date}T00:00:00.000Z`).getTime()
      const dayEnd = dayStart + DAY_MS
      let created = 0
      let resolved = 0
      let openTotal = 0
      for (const row of rows) {
        const createdAt = row.createdAt.getTime()
        const resolvedAt = (row.completedAt ?? row.cancelledAt)?.getTime() ?? null
        if (createdAt >= dayStart && createdAt < dayEnd) created++
        if (resolvedAt !== null && resolvedAt >= dayStart && resolvedAt < dayEnd) resolved++
        if (createdAt < dayEnd && (resolvedAt === null || resolvedAt >= dayEnd)) openTotal++
      }
      return { date, created, resolved, openTotal }
    })
    return { points }
  }

  // ------------------------------------------------------------------ time

  async time(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    input: { from: string; to: string; projectId?: string; userId?: string; billableOnly: boolean },
  ): Promise<TimeReport> {
    if (input.projectId) await this.access.requireProject(tx, principal, workspaceId, input.projectId)
    const visible = await this.access.visibleProjectIds(tx, principal, workspaceId, {
      ...(input.projectId ? { only: [input.projectId] } : {}),
    })
    const logs = (
      await this.timeService.between(tx, workspaceId, input.from, input.to, {
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        billableOnly: input.billableOnly,
      })
    ).filter((row) => visible.includes(row.projectId))

    const issueIds = [...new Set(logs.map((l) => l.issueId))]
    const issueRows = issueIds.length
      ? await tx
          .select({
            id: issues.id,
            key: issues.key,
            title: issues.title,
            originalEstimateSec: issues.originalEstimateSec,
            remainingSec: issues.remainingSec,
          })
          .from(issues)
          .where(and(eq(issues.workspaceId, workspaceId), inArray(issues.id, issueIds)))
      : []
    const byIssueId = new Map(issueRows.map((r) => [r.id, r]))

    const cells = new Map<string, TimesheetRow>()
    for (const log of logs) {
      const date = dateOnly(log.startedAt)
      const key = `${log.userId}|${log.issueId}|${date}`
      const existing = cells.get(key) ?? {
        userId: log.userId as TimesheetRow['userId'],
        projectId: log.projectId,
        issueId: log.issueId,
        issueKey: byIssueId.get(log.issueId)?.key ?? null,
        date,
        durationSec: 0,
        billableSec: 0,
      }
      existing.durationSec += log.durationSec
      if (log.billable) existing.billableSec += log.durationSec
      cells.set(key, existing)
    }
    const rows = [...cells.values()].sort((a, b) => a.date.localeCompare(b.date))

    const byUser = new Map<string, { userId: string; durationSec: number; billableSec: number }>()
    for (const row of rows) {
      const entry = byUser.get(row.userId) ?? { userId: row.userId, durationSec: 0, billableSec: 0 }
      entry.durationSec += row.durationSec
      entry.billableSec += row.billableSec
      byUser.set(row.userId, entry)
    }
    const byIssue = new Map<string, TimeReport['byIssue'][number]>()
    for (const log of logs) {
      const issue = byIssueId.get(log.issueId)
      const entry = byIssue.get(log.issueId) ?? {
        issueId: log.issueId,
        issueKey: issue?.key ?? '',
        title: issue?.title ?? '',
        durationSec: 0,
        originalEstimateSec: issue?.originalEstimateSec ?? null,
        remainingSec: issue?.remainingSec ?? null,
      }
      entry.durationSec += log.durationSec
      byIssue.set(log.issueId, entry)
    }

    return {
      from: input.from,
      to: input.to,
      totalSec: logs.reduce((sum, l) => sum + l.durationSec, 0),
      billableSec: logs.filter((l) => l.billable).reduce((sum, l) => sum + l.durationSec, 0),
      rows,
      byUser: [...byUser.values()].map((u) => ({
        userId: u.userId as TimesheetRow['userId'],
        durationSec: u.durationSec,
        billableSec: u.billableSec,
      })),
      byIssue: [...byIssue.values()].sort((a, b) => b.durationSec - a.durationSec),
    }
  }

  /** Exposed so jobs can reuse the resolved-category list. */
  resolvedCategories(): string[] {
    return this.planning.resolvedCategories()
  }

  kernelRef(): Kernel {
    return this.kernel
  }
}
