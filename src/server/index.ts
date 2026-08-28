import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CollabAccess,
  CollabAccessInput,
  type core,
  Id,
  type Principal,
  UserId,
  WorkspaceId,
} from '@kernhq/contracts'
import {
  defineModule,
  defineServerModule,
  type JobDef,
  KernError,
  type Kernel,
  packageVersion,
  type Tx,
} from '@kernhq/kernel'
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  CreateIssue,
  InboundEmail,
  type Issue,
  MODULE_ID,
  RichDoc,
  trackerContract,
  trackerEvents,
  trackerNotificationTypes,
  trackerPermissions,
  UpdateIssue,
} from '../contract/index.js'
import { trackerRouter } from './router.js'
import { cycles, fieldDefs, issues, projectMembers, projects, schema, workspaces } from './schema.js'
import { issueUrl, projectUrl } from './services/db.js'
import { trackerServices } from './services/index.js'

export * from './rank.js'
export * from './rich.js'
export { trackerRouter } from './router.js'
export * from './schema.js'
export * from './services/index.js'

const DAY_MS = 86_400_000
const objectRef = (type: string, id: string) => ({ module: MODULE_ID, type, id })

/**
 * The `procedures` below are the module's service-to-service surface, reachable only over
 * `kernel.call`. They deliberately run with elevated access, so they must never be callable by an
 * end user: anything a person does goes through the oRPC router and its permission middleware.
 */
function requireService(principal: Principal): void {
  if (principal.kind !== 'service' && !principal.instanceAdmin) throw KernError.forbidden()
}

/** Workspaces the tracker is active in; scheduled work is done one workspace at a time. */
async function activeWorkspaces(kernel: Kernel): Promise<string[]> {
  const rows = await kernel.database.db.select({ id: workspaces.workspaceId }).from(workspaces)
  return rows.map((r) => r.id)
}

/** Run `fn` for every active workspace, logging (not propagating) per-workspace failures. */
async function forEachWorkspace(
  kernel: Kernel,
  job: string,
  fn: (workspaceId: string) => Promise<void>,
): Promise<void> {
  for (const workspaceId of await activeWorkspaces(kernel)) {
    if (!(await kernel.isModuleEnabled(workspaceId, MODULE_ID).catch(() => true))) continue
    try {
      await fn(workspaceId)
    } catch (err) {
      kernel.log.warn({ err: String(err), workspaceId, job }, 'tracker: scheduled job failed')
    }
  }
}

const jobs: JobDef<Record<string, unknown>>[] = [
  {
    // retried runs re-send the same notifications; they collapse client-side on `groupKey`
    name: 'due-soon',
    cron: '0 8 * * *',
    handler: async (_input, { kernel }) => {
      const svc = trackerServices(kernel)
      await forEachWorkspace(kernel, 'due-soon', async (workspaceId) => {
        const horizon = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10)
        const rows = await kernel.database.withWorkspace(workspaceId, (tx) =>
          tx
            .select()
            .from(issues)
            .where(
              and(
                eq(issues.workspaceId, workspaceId),
                isNull(issues.archivedAt),
                sql`${issues.dueDate} is not null and ${issues.dueDate} <= ${horizon}::date`,
                sql`${issues.statusCategory} not in ('done','cancelled')`,
              ),
            )
            .limit(500),
        )
        for (const row of rows) {
          await kernel.emit(
            trackerEvents.issueDue,
            {
              workspaceId: workspaceId as Issue['workspaceId'],
              projectId: row.projectId,
              issueId: row.id,
              key: row.key,
              dueDate: row.dueDate ?? '',
              assigneeIds: (row.assigneeIds ?? []) as Issue['assigneeIds'],
            },
            { workspaceId },
          )
          await svc.notify.notify({
            workspaceId,
            userIds: svc.issues.watchersOf(row),
            type: 'tracker.issue.due_soon',
            title: `${row.key} is due ${row.dueDate}`,
            body: row.title,
            object: objectRef('issue', row.id),
            url: issueUrl(row.key),
            groupKey: row.id,
          })
        }
      })
    },
  },
  {
    name: 'recurring',
    cron: '*/15 * * * *',
    handler: async (_input, { kernel }) => {
      const svc = trackerServices(kernel)
      await forEachWorkspace(kernel, 'recurring', async (workspaceId) => {
        await svc.issues.runDueRecurring(workspaceId)
      })
    },
  },
  {
    name: 'cycles',
    cron: '5 * * * *',
    handler: async (_input, { kernel }) => {
      const svc = trackerServices(kernel)
      const now = new Date()
      await forEachWorkspace(kernel, 'cycles', async (workspaceId) => {
        const due = await kernel.database.withWorkspace(workspaceId, (tx) =>
          tx
            .select()
            .from(cycles)
            .where(
              and(
                eq(cycles.workspaceId, workspaceId),
                inArray(cycles.status, ['upcoming', 'active']),
                lte(cycles.startAt, now),
              ),
            )
            .limit(200),
        )
        for (const cycle of due) {
          await kernel.database.withWorkspace(workspaceId, async (tx) => {
            if (cycle.status === 'upcoming')
              await svc.planning.startCycle(tx, kernel.system, workspaceId, cycle.id).catch(() => undefined)
            else if (cycle.endAt <= now)
              await svc.planning.completeCycle(tx, kernel.system, workspaceId, cycle.id)
          })
        }
        // remind watchers about cycles ending within a day
        const ending = await kernel.database.withWorkspace(workspaceId, (tx) =>
          tx
            .select()
            .from(cycles)
            .where(
              and(
                eq(cycles.workspaceId, workspaceId),
                eq(cycles.status, 'active'),
                lte(cycles.endAt, new Date(now.getTime() + DAY_MS)),
              ),
            ),
        )
        for (const cycle of ending) {
          const members = await kernel.database.withWorkspace(workspaceId, (tx) =>
            tx
              .select({ userId: projectMembers.userId })
              .from(projectMembers)
              .where(
                and(
                  eq(projectMembers.workspaceId, workspaceId),
                  eq(projectMembers.projectId, cycle.projectId),
                ),
              ),
          )
          await svc.notify.notify({
            workspaceId,
            userIds: members.map((m) => m.userId),
            type: 'tracker.cycle.ending',
            title: `${cycle.name} ends soon`,
            body: cycle.goal,
            object: objectRef('cycle', cycle.id),
            url: `/tracker/cycles/${cycle.id}`,
            groupKey: cycle.id,
          })
        }
        await svc.intake.wakeSnoozed(workspaceId, now)
      })
    },
  },
  {
    name: 'sla',
    cron: '*/10 * * * *',
    handler: async (_input, { kernel }) => {
      const now = Date.now()
      await forEachWorkspace(kernel, 'sla', async (workspaceId) => {
        await kernel.database.withWorkspace(workspaceId, async (tx) => {
          const rows = await tx
            .select({ id: issues.id, sla: issues.sla })
            .from(issues)
            .where(
              and(
                eq(issues.workspaceId, workspaceId),
                isNull(issues.archivedAt),
                sql`${issues.sla} is not null and (${issues.sla}->>'breached')::boolean is not true`,
              ),
            )
            .limit(1000)
          for (const row of rows) {
            const sla = row.sla as {
              firstResponseDueAt: string | null
              firstRespondedAt: string | null
              resolveDueAt: string | null
              pausedAt: string | null
              pausedSec: number
              breached: boolean
            }
            const grace = sla.pausedSec * 1000
            const missedResponse =
              !sla.firstRespondedAt &&
              sla.firstResponseDueAt !== null &&
              new Date(sla.firstResponseDueAt).getTime() + grace < now
            const missedResolve =
              sla.resolveDueAt !== null && new Date(sla.resolveDueAt).getTime() + grace < now
            if (!missedResponse && !missedResolve) continue
            await tx
              .update(issues)
              .set({ sla: { ...sla, breached: true } })
              .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, row.id)))
          }
        })
      })
    },
  },
  {
    name: 'import',
    schema: z.object({ workspaceId: WorkspaceId, importJobId: Id }),
    options: { retryLimit: 1, expireInSeconds: 3600 },
    handler: async (input, { kernel }) => {
      await trackerServices(kernel).imports.run(input.workspaceId as string, input.importJobId as string)
    },
  },
] as JobDef<Record<string, unknown>>[]

/**
 * The tracker module: projects, work items, workflows, KQL, planning, time tracking and reports.
 *
 * Hosted by the core service by default. Like every Kern module it is reachable from anywhere through
 * `/api/tracker` and `kernel.call('tracker.*')`, so a deployment that outgrows core can move it to its
 * own service by registering it there instead.
 */
export const trackerModule = defineServerModule({
  definition: defineModule({
    id: MODULE_ID,
    name: 'Tracker',
    version: packageVersion(import.meta.url),
    description: 'Projects, issues, workflows, KQL, cycles, views, reports and time tracking',
    icon: 'square-check-big',
    core: false,
    defaultHost: 'core',
    permissions: trackerPermissions,
    events: trackerEvents,
    notificationTypes: trackerNotificationTypes,
    objectTypes: [
      { type: 'issue', label: 'Issue', icon: 'square-check-big', channelable: true },
      { type: 'project', label: 'Project', icon: 'diamond', channelable: true },
      { type: 'cycle', label: 'Cycle', icon: 'refresh-cw' },
    ],
  }),
  /** Attached so the developer panel can check the router against what was promised. */
  contract: trackerContract,
  schema,
  migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '../../migrations'),
  router: trackerRouter,

  subscriptions: {
    /** register the workspace so scheduled jobs can find it */
    'core.workspace.created': async (event, kernel) => {
      const payload = event.payload as { workspaceId: string }
      await kernel.database.db
        .insert(workspaces)
        .values({ workspaceId: payload.workspaceId })
        .onConflictDoNothing({ target: workspaces.workspaceId })
    },
    /** a removed member keeps their history but loses membership, assignments and watches */
    'core.member.removed': async (event, kernel) => {
      const payload = event.payload as { workspaceId: string; userId: string }
      const { workspaceId, userId } = payload
      await kernel.database.withWorkspace(workspaceId, async (tx) => {
        await tx
          .delete(projectMembers)
          .where(and(eq(projectMembers.workspaceId, workspaceId), eq(projectMembers.userId, userId)))
        await tx
          .update(issues)
          .set({
            assigneeIds: sql`array_remove(${issues.assigneeIds}, ${userId}::uuid)`,
            watcherIds: sql`array_remove(${issues.watcherIds}, ${userId}::uuid)`,
          })
          .where(
            and(
              eq(issues.workspaceId, workspaceId),
              sql`${userId}::uuid = any(${issues.assigneeIds}) or ${userId}::uuid = any(${issues.watcherIds})`,
            ),
          )
      })
    },
  },

  jobs,

  /** procedures other modules and services call through `kernel.call('tracker.<name>', …)` */
  procedures: {
    'issues.get': {
      input: z.object({ workspaceId: WorkspaceId, issueId: Id }),
      handler: (input, { kernel, principal }) => {
        requireService(principal)
        return kernel.database.withWorkspace(input.workspaceId, (tx) =>
          trackerServices(kernel).issues.get(tx, principal, input.workspaceId, input.issueId),
        )
      },
    },
    'issues.getMany': {
      input: z.object({ workspaceId: WorkspaceId, ids: z.array(Id).max(500) }),
      handler: (input, { kernel, principal }) => {
        requireService(principal)
        return kernel.database.withWorkspace(input.workspaceId, (tx) =>
          trackerServices(kernel).issues.getMany(tx, principal, input.workspaceId, input.ids),
        )
      },
    },
    'issues.create': {
      input: z.object({ workspaceId: WorkspaceId, issue: CreateIssue }),
      handler: (input, { kernel, principal }) => {
        requireService(principal)
        return kernel.database.withWorkspace(input.workspaceId, (tx) =>
          trackerServices(kernel).issues.create(tx, principal, input.workspaceId, input.issue, {
            source: 'api',
          }),
        )
      },
    },
    'issues.update': {
      input: z.object({ workspaceId: WorkspaceId, issueId: Id, patch: UpdateIssue }),
      handler: (input, { kernel, principal }) => {
        requireService(principal)
        return kernel.database.withWorkspace(input.workspaceId, (tx) =>
          trackerServices(kernel).issues.update(tx, principal, input.workspaceId, input.issueId, input.patch),
        )
      },
    },
    /** the mail module hands inbound messages over here */
    'issues.createFromEmail': {
      input: InboundEmail,
      handler: (input, { kernel, principal }) => {
        requireService(principal)
        return trackerServices(kernel).intake.ingestEmail(input)
      },
    },
    'issues.addComment': {
      input: z.object({
        workspaceId: WorkspaceId,
        issueId: Id,
        body: RichDoc,
        authorId: UserId.nullable().default(null),
        internal: z.boolean().default(false),
      }),
      handler: (input, { kernel, principal }) => {
        requireService(principal)
        return kernel.database.withWorkspace(input.workspaceId, (tx) =>
          trackerServices(kernel).comments.create(
            tx,
            principal,
            input.workspaceId,
            input.issueId,
            input.body,
            {
              authorId: input.authorId,
              internal: input.internal,
              source: 'automation',
            },
          ),
        )
      },
    },
    'projects.get': {
      input: z.object({ workspaceId: WorkspaceId, projectId: Id }),
      handler: (input, { kernel, principal }) => {
        requireService(principal)
        return kernel.database.withWorkspace(input.workspaceId, (tx) =>
          trackerServices(kernel).projects.get(tx, principal, input.workspaceId, input.projectId),
        )
      },
    },
    'projects.members': {
      input: z.object({ workspaceId: WorkspaceId, projectId: Id }),
      output: z.object({ userIds: z.array(UserId) }),
      handler: async (input, { kernel, principal }) => {
        requireService(principal)
        return {
          userIds: await kernel.database.withWorkspace(input.workspaceId, (tx) =>
            trackerServices(kernel).projects.memberIds(tx, input.workspaceId, input.projectId),
          ),
        }
      },
    },
    /**
     * Whether a user may open an issue's collaborative description.
     *
     * The shapes come from `@kernhq/contracts` rather than being spelled out here, because this
     * procedure is called by the collab gateway and the two had diverged: it declared
     * `{ workspaceId, issueId, userId }` returning `{ canView, canEdit }` while the gateway sends
     * `{ workspaceId, type, id, userId }` and reads `{ canRead, canWrite }`. Zod rejected every call,
     * the broker threw, and the gateway fell back to plain workspace membership — so this answer had
     * never once been used, and nothing failed loudly enough to say so.
     */
    'collab.access': {
      input: CollabAccessInput,
      output: CollabAccess,
      handler: async (input, { kernel, principal }) => {
        requireService(principal)
        // The only collaborative document the tracker owns is an issue description.
        if (input.type !== 'issue') return { canRead: false, canWrite: false }
        return kernel.database.withWorkspace(input.workspaceId, async (tx) => {
          const svc = trackerServices(kernel)
          try {
            const row = await svc.issues.row(tx, input.workspaceId, input.id)
            // the caller is usually a service, so the target user's memberships come from core
            const subject =
              principal.userId === input.userId
                ? principal
                : ((await kernel
                    .call<Principal | null>('core.users.principal', { userId: input.userId })
                    .catch(() => null)) ?? {
                    ...principal,
                    userId: input.userId,
                    instanceAdmin: false,
                    kind: 'user' as const,
                  })
            const canRead = await svc.access.can(
              subject,
              'tracker.issue.view',
              input.workspaceId,
              row.projectId,
            )
            const canWrite =
              canRead &&
              (await svc.access.canEditIssue(subject, input.workspaceId, row.projectId, {
                reporterId: row.reporterId,
                creatorId: row.creatorId,
                assigneeIds: row.assigneeIds ?? [],
              }))
            return { canRead, canWrite }
          } catch (err) {
            // a missing or forbidden issue means "no access"; anything else is a real failure
            if (err instanceof KernError && (err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN'))
              return { canRead: false, canWrite: false }
            throw err
          }
        })
      },
    },
  },

  /** `tracker:issue:<id>` documents for the workspace-wide search index */
  search: [
    {
      types: ['issue'],
      load: async (workspaceId, id, kernel): Promise<core.SearchDocument | null> =>
        kernel.database.withWorkspace(workspaceId, async (tx) => {
          const [row] = await tx
            .select()
            .from(issues)
            .where(and(eq(issues.workspaceId, workspaceId), eq(issues.id, id)))
            .limit(1)
          if (!row || row.archivedAt) return null
          return searchDocument(workspaceId, row, await searchableKeys(tx, workspaceId))
        }),
      scan: async function* (workspaceId, kernel) {
        // read once for the whole scan rather than per row
        const keys = await kernel.database.withWorkspace(workspaceId, (tx) => searchableKeys(tx, workspaceId))
        let cursor: string | null = null
        for (;;) {
          const rows: Array<typeof issues.$inferSelect> = await kernel.database.withWorkspace(
            workspaceId,
            (tx) =>
              tx
                .select()
                .from(issues)
                .where(
                  and(
                    eq(issues.workspaceId, workspaceId),
                    isNull(issues.archivedAt),
                    cursor ? sql`${issues.id} > ${cursor}` : sql`true`,
                  ),
                )
                .orderBy(issues.id)
                .limit(500),
          )
          if (!rows.length) return
          for (const row of rows) yield searchDocument(workspaceId, row, keys)
          cursor = rows.at(-1)?.id ?? null
        }
      },
    },
  ],

  /** render `tracker:issue:<id>` / `tracker:project:<id>` references anywhere in the product */
  resolvers: [
    {
      type: 'issue',
      resolve: async (workspaceId, ids, _principal, kernel) =>
        kernel.database.withWorkspace(workspaceId, async (tx) => {
          const rows = await tx
            .select()
            .from(issues)
            .where(and(eq(issues.workspaceId, workspaceId), inArray(issues.id, ids)))
          const byId = new Map(rows.map((r) => [r.id, r]))
          return ids.map((id) => {
            const row = byId.get(id)
            if (!row) return null
            return {
              id,
              title: `${row.key} ${row.title}`,
              url: issueUrl(row.key),
              icon: 'square-check-big',
              subtitle: row.statusId,
            }
          })
        }),
    },
    {
      type: 'cycle',
      resolve: async (workspaceId, ids, _principal, kernel) =>
        kernel.database.withWorkspace(workspaceId, async (tx) => {
          const rows = await tx
            .select()
            .from(cycles)
            .where(and(eq(cycles.workspaceId, workspaceId), inArray(cycles.id, ids)))
          const byId = new Map(rows.map((r) => [r.id, r]))
          return ids.map((id) => {
            const row = byId.get(id)
            if (!row) return null
            return {
              id,
              title: row.name,
              url: `/tracker/cycles/${row.id}`,
              icon: 'refresh-cw',
              subtitle: row.goal,
            }
          })
        }),
    },
    {
      type: 'project',
      resolve: async (workspaceId, ids, _principal, kernel) =>
        kernel.database.withWorkspace(workspaceId, async (tx) => {
          const rows = await tx
            .select()
            .from(projects)
            .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, ids)))
          const byId = new Map(rows.map((r) => [r.id, r]))
          return ids.map((id) => {
            const row = byId.get(id)
            if (!row) return null
            return {
              id,
              title: row.name,
              url: projectUrl(row.key),
              icon: row.icon ?? 'diamond',
              subtitle: row.key,
            }
          })
        }),
    },
  ],

  /** tracker events, conditions and actions offered to the automation builder */
  automations: {
    triggers: [
      { key: 'tracker.issue.created', label: 'Issue created', event: 'tracker.issue.created' },
      { key: 'tracker.issue.updated', label: 'Issue updated', event: 'tracker.issue.updated' },
      {
        key: 'tracker.issue.status_changed',
        label: 'Issue status changed',
        event: 'tracker.issue.status_changed',
      },
      { key: 'tracker.issue.assigned', label: 'Issue assigned', event: 'tracker.issue.assigned' },
      { key: 'tracker.issue.commented', label: 'Issue commented', event: 'tracker.issue.commented' },
      { key: 'tracker.issue.due', label: 'Issue due', event: 'tracker.issue.due' },
      { key: 'tracker.cycle.completed', label: 'Cycle completed', event: 'tracker.cycle.completed' },
    ],
    conditions: [
      {
        key: 'tracker.issue.inProject',
        label: 'Issue is in project',
        schema: z.object({ projectIds: z.array(Id).min(1) }),
        evaluate: (input, ctx) => {
          const config = input as { projectIds: string[] }
          const payload = (ctx.event as { payload?: { projectId?: string } }).payload ?? {}
          return !!payload.projectId && config.projectIds.includes(payload.projectId)
        },
      },
      {
        key: 'tracker.issue.statusCategoryIs',
        label: 'Status category is',
        schema: z.object({ categories: z.array(z.string()).min(1) }),
        evaluate: (input, ctx) => {
          const config = input as { categories: string[] }
          const payload = (ctx.event as { payload?: { toCategory?: string } }).payload ?? {}
          return !!payload.toCategory && config.categories.includes(payload.toCategory)
        },
      },
      {
        key: 'tracker.issue.priorityIs',
        label: 'Priority is',
        schema: z.object({ priorities: z.array(z.string()).min(1) }),
        evaluate: async (input, ctx) => {
          const config = input as { priorities: string[] }
          const payload = (ctx.event as { payload?: { issueId?: string } }).payload ?? {}
          if (!payload.issueId) return false
          const [row] = await ctx.kernel.database.withWorkspace(ctx.workspaceId, (tx) =>
            tx
              .select({ priority: issues.priority })
              .from(issues)
              .where(and(eq(issues.workspaceId, ctx.workspaceId), eq(issues.id, payload.issueId!)))
              .limit(1),
          )
          return !!row && config.priorities.includes(row.priority)
        },
      },
    ],
    actions: [
      {
        key: 'tracker.issue.update',
        label: 'Update the issue',
        schema: z.object({ patch: UpdateIssue }),
        run: async (input, ctx) => {
          const config = input as { patch: z.infer<typeof UpdateIssue> }
          const payload = (ctx.event as { payload?: { issueId?: string } }).payload ?? {}
          if (!payload.issueId) return null
          return ctx.kernel.database.withWorkspace(ctx.workspaceId, (tx) =>
            trackerServices(ctx.kernel).issues.update(
              tx,
              ctx.actor,
              ctx.workspaceId,
              payload.issueId!,
              config.patch,
              { system: true },
            ),
          )
        },
      },
      {
        key: 'tracker.issue.transition',
        label: 'Run a transition',
        schema: z.object({ transitionId: z.string().min(1), comment: z.string().max(2000).optional() }),
        run: async (input, ctx) => {
          const config = input as { transitionId: string; comment?: string }
          const payload = (ctx.event as { payload?: { issueId?: string } }).payload ?? {}
          if (!payload.issueId) return null
          return ctx.kernel.database.withWorkspace(ctx.workspaceId, (tx) =>
            trackerServices(ctx.kernel).transitions.apply(
              tx,
              ctx.actor,
              ctx.workspaceId,
              payload.issueId!,
              { transitionId: config.transitionId, ...(config.comment ? { comment: config.comment } : {}) },
              { system: true, skipConditions: true },
            ),
          )
        },
      },
      {
        key: 'tracker.issue.comment',
        label: 'Add a comment',
        schema: z.object({ text: z.string().min(1).max(10_000) }),
        run: async (input, ctx) => {
          const config = input as { text: string }
          const payload = (ctx.event as { payload?: { issueId?: string } }).payload ?? {}
          if (!payload.issueId) return null
          return ctx.kernel.database.withWorkspace(ctx.workspaceId, (tx) =>
            trackerServices(ctx.kernel).comments.create(
              tx,
              ctx.actor,
              ctx.workspaceId,
              payload.issueId!,
              {
                type: 'doc',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: config.text }] }],
              },
              { source: 'automation', authorId: null },
            ),
          )
        },
      },
      {
        key: 'tracker.issue.assign',
        label: 'Assign the issue',
        schema: z.object({ userIds: z.array(UserId) }),
        run: async (input, ctx) => {
          const config = input as { userIds: string[] }
          const payload = (ctx.event as { payload?: { issueId?: string } }).payload ?? {}
          if (!payload.issueId) return null
          return ctx.kernel.database.withWorkspace(ctx.workspaceId, (tx) =>
            trackerServices(ctx.kernel).issues.update(
              tx,
              ctx.actor,
              ctx.workspaceId,
              payload.issueId!,
              { assigneeIds: config.userIds as z.infer<typeof UpdateIssue>['assigneeIds'] },
              { system: true },
            ),
          )
        },
      },
    ],
  },

  onWorkspaceEnabled: async (workspaceId, kernel) => {
    await kernel.database.db
      .insert(workspaces)
      .values({ workspaceId })
      .onConflictDoNothing({ target: workspaces.workspaceId })
  },
})

/**
 * Text from the custom fields marked `searchable`, appended to the indexed body.
 *
 * `searchable` has been settable since the field editor existed and reached nothing, so a workspace
 * that marked "Customer" searchable could not find an issue by customer name.
 */
function searchableText(row: typeof issues.$inferSelect, searchableKeys: ReadonlySet<string>): string {
  if (!searchableKeys.size) return ''
  const custom = (row.custom as Record<string, unknown>) ?? {}
  const parts: string[] = []
  for (const key of searchableKeys) {
    const value = custom[key]
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) parts.push(value.filter((v) => typeof v === 'string').join(' '))
    else if (typeof value === 'string' || typeof value === 'number') parts.push(String(value))
  }
  return parts.filter(Boolean).join(' ')
}

function searchDocument(
  workspaceId: string,
  row: typeof issues.$inferSelect,
  searchableKeys: ReadonlySet<string> = new Set(),
): core.SearchDocument {
  const extra = searchableText(row, searchableKeys)
  return {
    workspaceId: workspaceId as core.SearchDocument['workspaceId'],
    object: objectRef('issue', row.id),
    title: `${row.key} ${row.title}`,
    body: [row.descriptionText || '', extra].filter(Boolean).join('\n') || null,
    url: issueUrl(row.key),
    icon: 'square-check-big',
    acl: null,
    updatedAt: row.updatedAt.toISOString(),
    attributes: {
      projectId: row.projectId,
      statusId: row.statusId,
      statusCategory: row.statusCategory,
      priority: row.priority,
      assigneeIds: row.assigneeIds ?? [],
    },
  }
}

/** Keys of the workspace's custom fields marked `searchable`. */
async function searchableKeys(tx: Tx, workspaceId: string): Promise<ReadonlySet<string>> {
  const rows = await tx
    .select({ key: fieldDefs.key })
    .from(fieldDefs)
    .where(
      and(
        eq(fieldDefs.workspaceId, workspaceId),
        eq(fieldDefs.searchable, true),
        isNull(fieldDefs.archivedAt),
      ),
    )
  return new Set(rows.map((r) => r.key))
}

export default trackerModule
export type TrackerModule = typeof trackerModule
