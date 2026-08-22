import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { Issue, Timer, Worklog } from '../../contract/models.js'
import { issues, timers, worklogs } from '../schema.js'
import type { AccessService } from './access.js'
import { toTimer, toWorklog, type WorklogRow } from './db.js'
import type { IssueService } from './issues.js'
import type { NotifyService } from './notify.js'

export interface UpsertWorklogInput {
  startedAt?: string
  durationSec: number
  note?: string | null
  billable?: boolean
  adjustRemaining: 'auto' | 'leave' | 'set'
  remainingSec?: number
}

/** Worklogs and the single running timer a user may have per workspace. */
export class TimeService {
  constructor(
    private readonly kernel: Kernel,
    private readonly access: AccessService,
    private readonly issuesService: IssueService,
    private readonly notify: NotifyService,
  ) {}

  async list(tx: Tx, principal: Principal, workspaceId: string, issueId: string): Promise<Worklog[]> {
    const issue = await this.issuesService.row(tx, workspaceId, issueId)
    await this.access.requireProject(tx, principal, workspaceId, issue.projectId, 'tracker.issue.view')
    const rows = await tx
      .select()
      .from(worklogs)
      .where(and(eq(worklogs.workspaceId, workspaceId), eq(worklogs.issueId, issueId)))
      .orderBy(desc(worklogs.startedAt))
    return rows.map(toWorklog)
  }

  async create(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    input: UpsertWorklogInput,
    opts: { userId?: string; startedAt?: Date } = {},
  ): Promise<{ worklog: Worklog; issue: Issue }> {
    const issue = await this.issuesService.row(tx, workspaceId, issueId)
    await this.access.require(principal, 'tracker.worklog.log', workspaceId, issue.projectId)
    const userId = opts.userId ?? this.access.userId(principal)
    const startedAt = opts.startedAt ?? (input.startedAt ? new Date(input.startedAt) : new Date())
    const [row] = await tx
      .insert(worklogs)
      .values({
        id: uuidv7(),
        workspaceId,
        projectId: issue.projectId,
        issueId,
        userId,
        startedAt,
        durationSec: input.durationSec,
        note: input.note ?? null,
        billable: input.billable ?? false,
      })
      .returning()
    const updated = await this.applyToIssue(tx, workspaceId, issueId, input.durationSec, input)
    await this.notify.history(tx, {
      workspaceId,
      issueId,
      actorId: userId,
      action: 'worklog_added',
      data: { durationSec: input.durationSec, worklogId: row!.id },
    })
    await this.notify.change(workspaceId, 'issue', issueId, 'updated', {
      scope: { projectId: issue.projectId },
    })
    return { worklog: toWorklog(row!), issue: updated }
  }

  /** Roll a logged duration into the issue's `timeSpentSec` and remaining estimate. */
  private async applyToIssue(
    tx: Tx,
    workspaceId: string,
    issueId: string,
    deltaSec: number,
    input: Pick<UpsertWorklogInput, 'adjustRemaining' | 'remainingSec'>,
  ): Promise<Issue> {
    const remaining =
      input.adjustRemaining === 'set'
        ? sql`${input.remainingSec ?? 0}`
        : input.adjustRemaining === 'auto'
          ? sql`case when ${issues.remainingSec} is null then null else greatest(0, ${issues.remainingSec} - ${deltaSec}) end`
          : sql`${issues.remainingSec}`
    const [row] = await tx
      .update(issues)
      .set({
        timeSpentSec: sql`greatest(0, ${issues.timeSpentSec} + ${deltaSec})`,
        remainingSec: remaining,
        updatedAt: new Date(),
        lastActivityAt: new Date(),
      })
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, issueId)))
      .returning()
    if (!row) throw KernError.notFound('Issue')
    return (await this.issuesService.hydrate(tx, [row]))[0]!
  }

  private async worklogRow(tx: Tx, workspaceId: string, id: string): Promise<WorklogRow> {
    const [row] = await tx
      .select()
      .from(worklogs)
      .where(and(eq(worklogs.workspaceId, workspaceId), eq(worklogs.id, id)))
      .limit(1)
    if (!row) throw KernError.notFound('Worklog')
    return row
  }

  async update(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    id: string,
    patch: Partial<UpsertWorklogInput>,
  ): Promise<Worklog> {
    const current = await this.worklogRow(tx, workspaceId, id)
    await this.assertOwnership(principal, workspaceId, current)
    const duration = patch.durationSec ?? current.durationSec
    const [row] = await tx
      .update(worklogs)
      .set({
        ...(patch.startedAt === undefined ? {} : { startedAt: new Date(patch.startedAt) }),
        ...(patch.durationSec === undefined ? {} : { durationSec: patch.durationSec }),
        ...(patch.note === undefined ? {} : { note: patch.note }),
        ...(patch.billable === undefined ? {} : { billable: patch.billable }),
        updatedAt: new Date(),
      })
      .where(and(eq(worklogs.workspaceId, workspaceId), eq(worklogs.id, id)))
      .returning()
    if (duration !== current.durationSec)
      await this.applyToIssue(tx, workspaceId, current.issueId, duration - current.durationSec, {
        adjustRemaining: patch.adjustRemaining ?? 'leave',
        ...(patch.remainingSec === undefined ? {} : { remainingSec: patch.remainingSec }),
      })
    await this.notify.change(current.workspaceId, 'issue', current.issueId, 'updated', {
      scope: { projectId: current.projectId },
    })
    return toWorklog(row!)
  }

  async delete(tx: Tx, principal: Principal, workspaceId: string, id: string): Promise<void> {
    const current = await this.worklogRow(tx, workspaceId, id)
    await this.assertOwnership(principal, workspaceId, current)
    await tx.delete(worklogs).where(and(eq(worklogs.workspaceId, workspaceId), eq(worklogs.id, id)))
    await this.applyToIssue(tx, workspaceId, current.issueId, -current.durationSec, {
      adjustRemaining: 'leave',
    })
    await this.notify.change(workspaceId, 'issue', current.issueId, 'updated', {
      scope: { projectId: current.projectId },
    })
  }

  private async assertOwnership(principal: Principal, workspaceId: string, row: WorklogRow): Promise<void> {
    if (principal.userId && row.userId === principal.userId) return
    await this.access.require(principal, 'tracker.worklog.edit_any', workspaceId, row.projectId)
  }

  // ------------------------------------------------------------------ timers

  async current(tx: Tx, principal: Principal, workspaceId: string): Promise<{ timer: Timer | null }> {
    const userId = this.access.userId(principal)
    const [row] = await tx
      .select()
      .from(timers)
      .where(and(eq(timers.workspaceId, workspaceId), eq(timers.userId, userId)))
      .limit(1)
    return { timer: row ? toTimer(row) : null }
  }

  /** Starting a timer stops whatever the user had running, so the log never double counts. */
  async start(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    issueId: string,
    note?: string,
  ): Promise<Timer> {
    const issue = await this.issuesService.row(tx, workspaceId, issueId)
    await this.access.require(principal, 'tracker.worklog.log', workspaceId, issue.projectId)
    const userId = this.access.userId(principal)
    await this.stop(tx, principal, workspaceId, false).catch(() => undefined)
    const [row] = await tx
      .insert(timers)
      .values({ id: uuidv7(), workspaceId, issueId, userId, note: note ?? null, startedAt: new Date() })
      .onConflictDoUpdate({
        target: [timers.workspaceId, timers.userId],
        set: { issueId, note: note ?? null, startedAt: new Date() },
      })
      .returning()
    return toTimer(row!)
  }

  async stop(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    discard: boolean,
  ): Promise<{ worklog: Worklog | null }> {
    const userId = this.access.userId(principal)
    const [row] = await tx
      .delete(timers)
      .where(and(eq(timers.workspaceId, workspaceId), eq(timers.userId, userId)))
      .returning()
    if (!row || discard) return { worklog: null }
    const durationSec = Math.max(1, Math.round((Date.now() - row.startedAt.getTime()) / 1000))
    const { worklog } = await this.create(
      tx,
      principal,
      workspaceId,
      row.issueId,
      { durationSec, note: row.note, adjustRemaining: 'auto' },
      { userId, startedAt: row.startedAt },
    )
    return { worklog }
  }

  /** Raw worklog rows for the time report. */
  async between(
    tx: Tx,
    workspaceId: string,
    from: string,
    to: string,
    filters: { projectId?: string; userId?: string; billableOnly?: boolean } = {},
  ): Promise<WorklogRow[]> {
    const where = [
      eq(worklogs.workspaceId, workspaceId),
      sql`${worklogs.startedAt} >= ${`${from}T00:00:00Z`}::timestamptz`,
      sql`${worklogs.startedAt} < (${`${to}T00:00:00Z`}::timestamptz + interval '1 day')`,
    ]
    if (filters.projectId) where.push(eq(worklogs.projectId, filters.projectId))
    if (filters.userId) where.push(eq(worklogs.userId, filters.userId))
    if (filters.billableOnly) where.push(eq(worklogs.billable, true))
    return tx
      .select()
      .from(worklogs)
      .where(and(...where))
      .orderBy(asc(worklogs.startedAt))
  }

  kernelRef(): Kernel {
    return this.kernel
  }
}
