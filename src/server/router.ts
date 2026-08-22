import {
  authed,
  KernError,
  type Kernel,
  type RequestContext,
  requires,
  type Tx,
  workspaceScoped,
} from '@kernhq/kernel'
import { implement } from '@orpc/server'
import { MODULE_ID, trackerContract } from '../contract/index.js'
import { trackerServices } from './services/index.js'

const os = implement(trackerContract).$context<RequestContext>()
// the public intake endpoints have no workspaceId and no principal, so they stay outside the gate
const { intake: _intakeContract, ...workspaceContract } = trackerContract

const ok = { ok: true as const }

/** Fixed-window limiter for the two anonymous intake endpoints. */
class IntakeLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  check(key: string): void {
    const now = Date.now()
    const entry = this.hits.get(key)
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k)
      return
    }
    entry.count++
    if (entry.count > this.limit)
      throw new KernError('RATE_LIMITED', 'Too many submissions, please try again later')
  }
}

/**
 * oRPC router for `/api/tracker`. Deliberately thin: it opens the workspace-bound transaction and
 * hands straight over to a service, which is where the permission checks and the logic live.
 */
export function trackerRouter(kernel: Kernel) {
  const svc = trackerServices(kernel)
  const scoped = implement(workspaceContract).$context<RequestContext>().use(workspaceScoped(MODULE_ID))
  const formLimiter = new IntakeLimiter(60, 60_000)
  const submitLimiter = new IntakeLimiter(10, 60_000)

  const run = <T>(context: RequestContext, workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    kernel.database.withWorkspace(workspaceId, fn, { userId: context.principal.userId })

  return os.router({
    // ---------------------------------------------------------------- projects
    projects: {
      list: scoped.projects.list
        .use(requires('tracker.project.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.projects.list(tx, context.principal, input.workspaceId, input.includeArchived),
          ),
        ),
      get: scoped.projects.get
        .use(requires('tracker.project.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.projects.get(tx, context.principal, input.workspaceId, input.projectId),
          ),
        ),
      getByKey: scoped.projects.getByKey
        .use(requires('tracker.project.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.projects.getByKey(tx, context.principal, input.workspaceId, input.key),
          ),
        ),
      create: scoped.projects.create
        .use(requires('tracker.project.create'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.projects.create(tx, context.principal, input.workspaceId, input),
          ),
        ),
      update: scoped.projects.update.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.projects.update(tx, context.principal, input.workspaceId, input.projectId, input.patch),
        ),
      ),
      archive: scoped.projects.archive.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.projects.archive(tx, context.principal, input.workspaceId, input.projectId, input.archived),
        ),
      ),
      delete: scoped.projects.delete.handler(async ({ input, context }) => {
        await run(context, input.workspaceId, (tx) =>
          svc.projects.delete(tx, context.principal, input.workspaceId, input.projectId),
        )
        return ok
      }),
      setIntake: scoped.projects.setIntake.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.projects.setIntake(
            tx,
            context.principal,
            input.workspaceId,
            input.projectId,
            input.enabled,
            input.rotate,
          ),
        ),
      ),
      members: {
        list: scoped.projects.members.list.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.projects.listMembers(tx, context.principal, input.workspaceId, input.projectId),
          ),
        ),
        add: scoped.projects.members.add.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.projects.addMembersChecked(
              tx,
              context.principal,
              input.workspaceId,
              input.projectId,
              input.userIds,
              input.role,
            ),
          ),
        ),
        remove: scoped.projects.members.remove.handler(async ({ input, context }) => {
          await run(context, input.workspaceId, (tx) =>
            svc.projects.removeMember(
              tx,
              context.principal,
              input.workspaceId,
              input.projectId,
              input.userId,
            ),
          )
          return ok
        }),
        setRole: scoped.projects.members.setRole.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.projects.setMemberRole(
              tx,
              context.principal,
              input.workspaceId,
              input.projectId,
              input.userId,
              input.role,
            ),
          ),
        ),
      },
      templates: {
        list: scoped.projects.templates.list
          .use(requires('tracker.project.view'))
          .handler(({ input, context }) =>
            run(context, input.workspaceId, (tx) => svc.projects.listTemplates(tx, input.workspaceId)),
          ),
        saveFromProject: scoped.projects.templates.saveFromProject.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.projects.saveTemplateFromProject(
              tx,
              context.principal,
              input.workspaceId,
              input.projectId,
              input.name,
              input.description,
            ),
          ),
        ),
        delete: scoped.projects.templates.delete
          .use(requires('tracker.project.create'))
          .handler(async ({ input, context }) => {
            await run(context, input.workspaceId, (tx) =>
              svc.projects.deleteTemplate(tx, input.workspaceId, input.id),
            )
            return ok
          }),
      },
    },

    // ------------------------------------------------------------ work item types
    types: {
      list: scoped.types.list.use(requires('tracker.project.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) =>
          (
            await svc.config.listTypes(tx, input.workspaceId, {
              ...(input.projectId ? { projectId: input.projectId } : {}),
              includeArchived: input.includeArchived,
            })
          ).map((row) => svc.config.toContractType(row)),
        ),
      ),
      create: scoped.types.create
        .use(requires('tracker.workflow.manage'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.config.createType(tx, input.workspaceId, input, context.principal.userId),
          ),
        ),
      update: scoped.types.update
        .use(requires('tracker.workflow.manage'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.config.updateType(tx, input.workspaceId, input.id, input.patch),
          ),
        ),
      archive: scoped.types.archive
        .use(requires('tracker.workflow.manage'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.config.archiveType(tx, input.workspaceId, input.id, input.archived),
          ),
        ),
      layout: scoped.types.layout
        .use(requires('tracker.project.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.layout.resolve(tx, input.workspaceId, input.projectId ?? null, input.id),
          ),
        ),
      hierarchyRules: scoped.types.hierarchyRules.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) => svc.config.hierarchyRules(tx, input.workspaceId)),
      ),
      setHierarchyRules: scoped.types.setHierarchyRules
        .use(requires('tracker.workflow.manage'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.config.setHierarchyRules(tx, input.workspaceId, input.rules),
          ),
        ),
      schemes: {
        list: scoped.types.schemes.list.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) => svc.config.listTypeSchemes(tx, input.workspaceId)),
        ),
        create: scoped.types.schemes.create
          .use(requires('tracker.workflow.manage'))
          .handler(({ input, context }) =>
            run(context, input.workspaceId, async (tx) => {
              await svc.config.assertTypesExist(tx, input.workspaceId, input.typeIds)
              return svc.config.createTypeScheme(tx, input.workspaceId, input)
            }),
          ),
        update: scoped.types.schemes.update
          .use(requires('tracker.workflow.manage'))
          .handler(({ input, context }) =>
            run(context, input.workspaceId, (tx) =>
              svc.config.updateTypeScheme(tx, input.workspaceId, input.id, input.patch),
            ),
          ),
        delete: scoped.types.schemes.delete
          .use(requires('tracker.workflow.manage'))
          .handler(async ({ input, context }) => {
            await run(context, input.workspaceId, (tx) =>
              svc.config.deleteTypeScheme(tx, input.workspaceId, input.id),
            )
            return ok
          }),
      },
    },

    // -------------------------------------------------------------- custom fields
    fields: {
      list: scoped.fields.list.use(requires('tracker.project.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.config.listFields(tx, input.workspaceId, {
            ...(input.projectId ? { projectId: input.projectId } : {}),
            includeArchived: input.includeArchived,
          }),
        ),
      ),
      create: scoped.fields.create
        .use(requires('tracker.field.manage'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) => svc.config.createField(tx, input.workspaceId, input)),
        ),
      update: scoped.fields.update
        .use(requires('tracker.field.manage'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.config.updateField(tx, input.workspaceId, input.id, input.patch),
          ),
        ),
      archive: scoped.fields.archive
        .use(requires('tracker.field.manage'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.config.archiveField(tx, input.workspaceId, input.id, input.archived),
          ),
        ),
      delete: scoped.fields.delete
        .use(requires('tracker.field.manage'))
        .handler(async ({ input, context }) => {
          await run(context, input.workspaceId, (tx) =>
            svc.config.deleteField(tx, input.workspaceId, input.id),
          )
          return ok
        }),
    },

    // ------------------------------------------------------------------ workflows
    workflows: {
      list: scoped.workflows.list.use(requires('tracker.project.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.config.listWorkflows(tx, input.workspaceId, {
            ...(input.projectId ? { projectId: input.projectId } : {}),
            includeArchived: input.includeArchived,
          }),
        ),
      ),
      get: scoped.workflows.get
        .use(requires('tracker.project.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, async (tx) =>
            svc.config.toContractWorkflow(await svc.config.getWorkflowRow(tx, input.workspaceId, input.id)),
          ),
        ),
      create: scoped.workflows.create
        .use(requires('tracker.workflow.manage'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) => svc.config.createWorkflow(tx, input.workspaceId, input)),
        ),
      update: scoped.workflows.update
        .use(requires('tracker.workflow.manage'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.config.updateWorkflow(tx, input.workspaceId, input.id, input.patch),
          ),
        ),
      archive: scoped.workflows.archive
        .use(requires('tracker.workflow.manage'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.config.archiveWorkflow(tx, input.workspaceId, input.id, input.archived),
          ),
        ),
      validate: scoped.workflows.validate.handler(({ input }) => svc.config.validate(input.definition)),
      // no workspaceId in the input, so this one only requires an authenticated caller
      templates: os.workflows.templates.use(authed).handler(() => svc.config.workflowTemplates()),
      statuses: scoped.workflows.statuses
        .use(requires('tracker.project.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.config.statusesForProject(tx, input.workspaceId, input.projectId),
          ),
        ),
      schemes: {
        list: scoped.workflows.schemes.list.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) => svc.config.listWorkflowSchemes(tx, input.workspaceId)),
        ),
        create: scoped.workflows.schemes.create
          .use(requires('tracker.workflow.manage'))
          .handler(({ input, context }) =>
            run(context, input.workspaceId, (tx) =>
              svc.config.createWorkflowScheme(tx, input.workspaceId, input),
            ),
          ),
        update: scoped.workflows.schemes.update
          .use(requires('tracker.workflow.manage'))
          .handler(({ input, context }) =>
            run(context, input.workspaceId, (tx) =>
              svc.config.updateWorkflowScheme(tx, input.workspaceId, input.id, input.patch),
            ),
          ),
        delete: scoped.workflows.schemes.delete
          .use(requires('tracker.workflow.manage'))
          .handler(async ({ input, context }) => {
            await run(context, input.workspaceId, (tx) =>
              svc.config.deleteWorkflowScheme(tx, input.workspaceId, input.id),
            )
            return ok
          }),
      },
    },

    // --------------------------------------------------------------------- issues
    issues: {
      get: scoped.issues.get.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.issues.get(tx, context.principal, input.workspaceId, input.issueId),
        ),
      ),
      getByKey: scoped.issues.getByKey.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.issues.getByKey(tx, context.principal, input.workspaceId, input.key),
        ),
      ),
      getMany: scoped.issues.getMany.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.issues.getMany(tx, context.principal, input.workspaceId, input.ids),
        ),
      ),
      query: scoped.issues.query.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) => svc.query.query(tx, context.principal, input)),
      ),
      create: scoped.issues.create.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.issues.create(tx, context.principal, input.workspaceId, input),
        ),
      ),
      update: scoped.issues.update.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.issues.update(tx, context.principal, input.workspaceId, input.issueId, input.patch),
        ),
      ),
      bulkUpdate: scoped.issues.bulkUpdate
        .use(requires('tracker.issue.bulk_edit'))
        .handler(({ input, context }) =>
          svc.issues.bulkUpdate(context.principal, input.workspaceId, input.ids, input.patch),
        ),
      delete: scoped.issues.delete.handler(async ({ input, context }) => {
        await run(context, input.workspaceId, (tx) =>
          svc.issues.delete(tx, context.principal, input.workspaceId, input.issueId),
        )
        return ok
      }),
      archive: scoped.issues.archive.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.issues.archive(tx, context.principal, input.workspaceId, input.issueId, input.archived),
        ),
      ),
      move: scoped.issues.move.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.issues.move(tx, context.principal, input.workspaceId, input.issueId, input.projectId),
        ),
      ),
      rank: scoped.issues.rank.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.issues.rank(
            tx,
            context.principal,
            input.workspaceId,
            input.issueId,
            input.afterId,
            input.beforeId,
          ),
        ),
      ),
      history: scoped.issues.history.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.issues.history(
            tx,
            context.principal,
            input.workspaceId,
            input.issueId,
            input.limit,
            input.cursor,
          ),
        ),
      ),
      watchers: {
        add: scoped.issues.watchers.add.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.issues.setWatcher(
              tx,
              context.principal,
              input.workspaceId,
              input.issueId,
              input.userId ?? svc.access.userId(context.principal),
              true,
            ),
          ),
        ),
        remove: scoped.issues.watchers.remove.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.issues.setWatcher(
              tx,
              context.principal,
              input.workspaceId,
              input.issueId,
              input.userId,
              false,
            ),
          ),
        ),
      },
      transitions: {
        available: scoped.issues.transitions.available.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.transitions.available(tx, context.principal, input.workspaceId, input.issueId),
          ),
        ),
        apply: scoped.issues.transitions.apply.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.transitions.apply(tx, context.principal, input.workspaceId, input.issueId, {
              transitionId: input.transitionId,
              ...(input.fields ? { fields: input.fields } : {}),
              ...(input.comment ? { comment: input.comment } : {}),
              ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
            }),
          ),
        ),
      },
      approvals: {
        list: scoped.issues.approvals.list.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.transitions.listApprovals(tx, context.principal, input.workspaceId, input.issueId),
          ),
        ),
        decide: scoped.issues.approvals.decide.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.transitions.decide(
              tx,
              context.principal,
              input.workspaceId,
              input.issueId,
              input.transitionId,
              input.decision,
              input.comment,
            ),
          ),
        ),
      },
      comments: {
        list: scoped.issues.comments.list.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.comments.list(
              tx,
              context.principal,
              input.workspaceId,
              input.issueId,
              input.limit,
              input.cursor,
            ),
          ),
        ),
        create: scoped.issues.comments.create.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.comments.create(tx, context.principal, input.workspaceId, input.issueId, input.body, {
              parentId: input.parentId ?? null,
              internal: input.internal,
            }),
          ),
        ),
        update: scoped.issues.comments.update.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.comments.update(tx, context.principal, input.workspaceId, input.commentId, input.body),
          ),
        ),
        delete: scoped.issues.comments.delete.handler(async ({ input, context }) => {
          await run(context, input.workspaceId, (tx) =>
            svc.comments.delete(tx, context.principal, input.workspaceId, input.commentId),
          )
          return ok
        }),
        react: scoped.issues.comments.react.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.comments.react(tx, context.principal, input.workspaceId, input.commentId, input.emoji),
          ),
        ),
      },
      relations: {
        list: scoped.issues.relations.list.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.issues.listRelations(tx, context.principal, input.workspaceId, input.issueId),
          ),
        ),
        create: scoped.issues.relations.create.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.issues.createRelation(
              tx,
              context.principal,
              input.workspaceId,
              input.issueId,
              input.type,
              input.targetIssueId,
            ),
          ),
        ),
        delete: scoped.issues.relations.delete.handler(async ({ input, context }) => {
          await run(context, input.workspaceId, (tx) =>
            svc.issues.deleteRelation(tx, context.principal, input.workspaceId, input.relationId),
          )
          return ok
        }),
      },
      attachments: {
        list: scoped.issues.attachments.list.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.issues.listAttachments(tx, context.principal, input.workspaceId, input.issueId),
          ),
        ),
        add: scoped.issues.attachments.add.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.issues.addAttachments(tx, context.principal, input.workspaceId, input.issueId, input.fileIds),
          ),
        ),
        remove: scoped.issues.attachments.remove.handler(async ({ input, context }) => {
          await run(context, input.workspaceId, (tx) =>
            svc.issues.removeAttachment(tx, context.principal, input.workspaceId, input.attachmentId),
          )
          return ok
        }),
      },
      links: {
        list: scoped.issues.links.list.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.issues.listLinks(tx, context.principal, input.workspaceId, input.issueId),
          ),
        ),
        add: scoped.issues.links.add.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.issues.addLink(tx, context.principal, input.workspaceId, input.issueId, {
              url: input.url,
              ...(input.title ? { title: input.title } : {}),
              kind: input.kind,
            }),
          ),
        ),
        remove: scoped.issues.links.remove.handler(async ({ input, context }) => {
          await run(context, input.workspaceId, (tx) =>
            svc.issues.removeLink(tx, context.principal, input.workspaceId, input.linkId),
          )
          return ok
        }),
      },
      templates: {
        list: scoped.issues.templates.list.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.issues.listTemplates(tx, context.principal, input.workspaceId, input.projectId),
          ),
        ),
        create: scoped.issues.templates.create.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.issues.createTemplate(tx, context.principal, input.workspaceId, input),
          ),
        ),
        update: scoped.issues.templates.update.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.issues.updateTemplate(tx, context.principal, input.workspaceId, input.id, input.patch),
          ),
        ),
        delete: scoped.issues.templates.delete.handler(async ({ input, context }) => {
          await run(context, input.workspaceId, (tx) =>
            svc.issues.deleteTemplate(tx, context.principal, input.workspaceId, input.id),
          )
          return ok
        }),
      },
      recurring: {
        list: scoped.issues.recurring.list.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.issues.listRecurring(tx, context.principal, input.workspaceId, input.projectId),
          ),
        ),
        create: scoped.issues.recurring.create.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.issues.createRecurring(tx, context.principal, input.workspaceId, input.projectId, input),
          ),
        ),
        update: scoped.issues.recurring.update.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.issues.updateRecurring(tx, context.principal, input.workspaceId, input.id, input.patch),
          ),
        ),
        delete: scoped.issues.recurring.delete.handler(async ({ input, context }) => {
          await run(context, input.workspaceId, (tx) =>
            svc.issues.deleteRecurring(tx, context.principal, input.workspaceId, input.id),
          )
          return ok
        }),
      },
    },

    // ------------------------------------------------------------------------ kql
    kql: {
      parse: scoped.kql.parse.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.query.parse(tx, context.principal, input.workspaceId, input.kql, input.projectIds),
        ),
      ),
      fields: scoped.kql.fields.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.query.fieldInfo(tx, context.principal, input.workspaceId, input.projectIds),
        ),
      ),
    },

    // ------------------------------------------------------------------- planning
    cycles: {
      list: scoped.cycles.list.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.listCycles(tx, context.principal, input.workspaceId, input.projectId, input.status),
        ),
      ),
      get: scoped.cycles.get.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.getCycle(tx, context.principal, input.workspaceId, input.id),
        ),
      ),
      create: scoped.cycles.create.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.createCycle(tx, context.principal, input.workspaceId, input.projectId, input),
        ),
      ),
      update: scoped.cycles.update.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.updateCycle(tx, context.principal, input.workspaceId, input.id, input.patch),
        ),
      ),
      delete: scoped.cycles.delete.handler(async ({ input, context }) => {
        await run(context, input.workspaceId, (tx) =>
          svc.planning.deleteCycle(tx, context.principal, input.workspaceId, input.id),
        )
        return ok
      }),
      start: scoped.cycles.start.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.startCycle(tx, context.principal, input.workspaceId, input.id),
        ),
      ),
      complete: scoped.cycles.complete.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.completeCycle(tx, context.principal, input.workspaceId, input.id, input.rollToCycleId),
        ),
      ),
    },

    milestones: {
      list: scoped.milestones.list.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.listMilestones(tx, context.principal, input.workspaceId, input.projectId),
        ),
      ),
      create: scoped.milestones.create.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.createMilestone(tx, context.principal, input.workspaceId, input.projectId, input),
        ),
      ),
      update: scoped.milestones.update.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.updateMilestone(tx, context.principal, input.workspaceId, input.id, input.patch),
        ),
      ),
      delete: scoped.milestones.delete.handler(async ({ input, context }) => {
        await run(context, input.workspaceId, (tx) =>
          svc.planning.deleteMilestone(tx, context.principal, input.workspaceId, input.id),
        )
        return ok
      }),
    },

    versions: {
      list: scoped.versions.list.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.listVersions(tx, context.principal, input.workspaceId, input.projectId),
        ),
      ),
      create: scoped.versions.create.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.createVersion(tx, context.principal, input.workspaceId, input.projectId, input),
        ),
      ),
      update: scoped.versions.update.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.updateVersion(tx, context.principal, input.workspaceId, input.id, input.patch),
        ),
      ),
      delete: scoped.versions.delete.handler(async ({ input, context }) => {
        await run(context, input.workspaceId, (tx) =>
          svc.planning.deleteVersion(tx, context.principal, input.workspaceId, input.id),
        )
        return ok
      }),
      release: scoped.versions.release.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.releaseVersion(tx, context.principal, input.workspaceId, input.id, input.released),
        ),
      ),
    },

    components: {
      list: scoped.components.list.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.listComponents(tx, context.principal, input.workspaceId, input.projectId),
        ),
      ),
      create: scoped.components.create.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.createComponent(tx, context.principal, input.workspaceId, input.projectId, input),
        ),
      ),
      update: scoped.components.update.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.updateComponent(tx, context.principal, input.workspaceId, input.id, input.patch),
        ),
      ),
      delete: scoped.components.delete.handler(async ({ input, context }) => {
        await run(context, input.workspaceId, (tx) =>
          svc.planning.deleteComponent(tx, context.principal, input.workspaceId, input.id),
        )
        return ok
      }),
    },

    labels: {
      list: scoped.labels.list.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.listLabels(
            tx,
            context.principal,
            input.workspaceId,
            input.projectId,
            input.includeArchived,
          ),
        ),
      ),
      create: scoped.labels.create.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.createLabel(tx, context.principal, input.workspaceId, input),
        ),
      ),
      update: scoped.labels.update.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.planning.updateLabel(tx, context.principal, input.workspaceId, input.id, input.patch),
        ),
      ),
      delete: scoped.labels.delete.handler(async ({ input, context }) => {
        await run(context, input.workspaceId, (tx) =>
          svc.planning.deleteLabel(tx, context.principal, input.workspaceId, input.id),
        )
        return ok
      }),
    },

    // ---------------------------------------------------------------------- views
    views: {
      list: scoped.views.list.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.views.list(tx, context.principal, input.workspaceId, input.projectId),
        ),
      ),
      get: scoped.views.get.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.views.get(tx, context.principal, input.workspaceId, input.id),
        ),
      ),
      create: scoped.views.create.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.views.create(tx, context.principal, input.workspaceId, input),
        ),
      ),
      update: scoped.views.update.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.views.update(tx, context.principal, input.workspaceId, input.id, input.patch),
        ),
      ),
      delete: scoped.views.delete.handler(async ({ input, context }) => {
        await run(context, input.workspaceId, (tx) =>
          svc.views.delete(tx, context.principal, input.workspaceId, input.id),
        )
        return ok
      }),
      pin: scoped.views.pin.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.views.pin(tx, context.principal, input.workspaceId, input.id, input.pinned),
        ),
      ),
    },

    // --------------------------------------------------------------------- intake
    intake: {
      form: os.intake.form.handler(({ input, context }) => {
        formLimiter.check(context.ip || 'anonymous')
        return svc.intake.form(input.token)
      }),
      submit: os.intake.submit.handler(({ input, context }) => {
        submitLimiter.check(context.ip || 'anonymous')
        return svc.intake.submit(input)
      }),
    },

    triage: {
      accept: scoped.triage.accept.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.intake.accept(tx, context.principal, input.workspaceId, input.issueId, input.statusId),
        ),
      ),
      decline: scoped.triage.decline.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.intake.decline(tx, context.principal, input.workspaceId, input.issueId, input.comment),
        ),
      ),
      snooze: scoped.triage.snooze.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.intake.snooze(tx, context.principal, input.workspaceId, input.issueId, input.until),
        ),
      ),
    },

    // -------------------------------------------------------------------- reports
    reports: {
      burndown: scoped.reports.burndown.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.reports.burndown(tx, context.principal, input.workspaceId, input.cycleId),
        ),
      ),
      velocity: scoped.reports.velocity.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.reports.velocity(tx, context.principal, input.workspaceId, input.projectId, input.lastN),
        ),
      ),
      cfd: scoped.reports.cfd.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.reports.cfd(tx, context.principal, input.workspaceId, input.projectId, input.from, input.to),
        ),
      ),
      createdVsResolved: scoped.reports.createdVsResolved.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.reports.createdVsResolved(
            tx,
            context.principal,
            input.workspaceId,
            input.projectId,
            input.from,
            input.to,
          ),
        ),
      ),
      time: scoped.reports.time.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.reports.time(tx, context.principal, input.workspaceId, {
            from: input.from,
            to: input.to,
            ...(input.projectId ? { projectId: input.projectId } : {}),
            ...(input.userId ? { userId: input.userId } : {}),
            billableOnly: input.billableOnly,
          }),
        ),
      ),
    },

    // -------------------------------------------------------------- time tracking
    worklogs: {
      list: scoped.worklogs.list.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.time.list(tx, context.principal, input.workspaceId, input.issueId),
        ),
      ),
      create: scoped.worklogs.create.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.time.create(tx, context.principal, input.workspaceId, input.issueId, {
            ...(input.startedAt ? { startedAt: input.startedAt } : {}),
            durationSec: input.durationSec,
            ...(input.note === undefined ? {} : { note: input.note }),
            ...(input.billable === undefined ? {} : { billable: input.billable }),
            adjustRemaining: input.adjustRemaining,
            ...(input.remainingSec === undefined ? {} : { remainingSec: input.remainingSec }),
          }),
        ),
      ),
      update: scoped.worklogs.update.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.time.update(tx, context.principal, input.workspaceId, input.id, input.patch),
        ),
      ),
      delete: scoped.worklogs.delete.handler(async ({ input, context }) => {
        await run(context, input.workspaceId, (tx) =>
          svc.time.delete(tx, context.principal, input.workspaceId, input.id),
        )
        return ok
      }),
      timers: {
        start: scoped.worklogs.timers.start.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.time.start(tx, context.principal, input.workspaceId, input.issueId, input.note),
          ),
        ),
        stop: scoped.worklogs.timers.stop.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.time.stop(tx, context.principal, input.workspaceId, input.discard),
          ),
        ),
        current: scoped.worklogs.timers.current.handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) => svc.time.current(tx, context.principal, input.workspaceId)),
        ),
      },
    },

    // -------------------------------------------------------------------- imports
    imports: {
      start: scoped.imports.start.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.imports.start(tx, context.principal, input.workspaceId, input.projectId, {
            source: input.source,
            fileId: input.fileId,
            mapping: input.mapping as Record<string, unknown>,
          }),
        ),
      ),
      get: scoped.imports.get.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.imports.get(tx, context.principal, input.workspaceId, input.id),
        ),
      ),
      list: scoped.imports.list.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.imports.list(tx, context.principal, input.workspaceId, input.projectId),
        ),
      ),
      cancel: scoped.imports.cancel.handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.imports.cancel(tx, context.principal, input.workspaceId, input.id),
        ),
      ),
    },
  })
}
