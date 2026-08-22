import { baseContract, Id, PageInput, page, Timestamp, UserId, WorkspaceId } from '@kernhq/contracts'
import { oc } from '@orpc/contract'
import { z } from 'zod'
import {
  Attachment,
  AvailableTransition,
  BulkResult,
  BurndownReport,
  CfdReport,
  Comment,
  Component,
  CreatedVsResolvedReport,
  CreateIssue,
  CreateProject,
  CsvMapping,
  Cycle,
  DateOnly,
  FieldDef,
  FieldScheme,
  HierarchyRules,
  ImportJob,
  ImportSource,
  IntakeForm,
  IntakeSubmission,
  Issue,
  IssueApproval,
  IssueHistoryEntry,
  IssueKey,
  IssueQueryInput,
  IssueQueryResult,
  IssueTemplate,
  KqlFieldInfo,
  KqlParseResult,
  Label,
  Link,
  Milestone,
  Ok,
  Project,
  ProjectMember,
  ProjectRole,
  ProjectTemplate,
  RecurringIssue,
  RelationType,
  RelationView,
  RichDoc,
  StatusHistoryEntry,
  StatusInfo,
  TimeReport,
  Timer,
  TypeScheme,
  UpdateIssue,
  UpdateProject,
  UpsertComponent,
  UpsertCycle,
  UpsertFieldDef,
  UpsertIssueTemplate,
  UpsertLabel,
  UpsertMilestone,
  UpsertRecurringIssue,
  UpsertVersion,
  UpsertView,
  UpsertWorkflow,
  UpsertWorkflowScheme,
  UpsertWorkItemType,
  UpsertWorklog,
  VelocityReport,
  Version,
  View,
  Workflow,
  WorkflowDefinition,
  WorkflowScheme,
  WorkItemType,
  Worklog,
} from './models.js'

const ws = z.object({ workspaceId: WorkspaceId })
const pr = ws.extend({ projectId: Id })
const iss = ws.extend({ issueId: Id })
const t = (...tags: string[]) => ({ tags })

/**
 * oRPC contract of the tracker module, mounted at `/api/tracker`.
 * Every procedure is workspace-scoped unless marked public (intake form endpoints).
 */
export const trackerContract = {
  // ------------------------------------------------------------------ projects
  projects: {
    list: baseContract
      .route({ method: 'GET', path: '/projects', ...t('projects') })
      .input(ws.extend({ includeArchived: z.boolean().default(false) }))
      .output(z.array(Project)),
    get: baseContract
      .route({ method: 'GET', path: '/projects/{projectId}', ...t('projects') })
      .input(pr)
      .output(Project),
    getByKey: baseContract
      .route({ method: 'GET', path: '/projects/key/{key}', ...t('projects') })
      .input(ws.extend({ key: z.string() }))
      .output(Project),
    create: baseContract
      .route({ method: 'POST', path: '/projects', ...t('projects') })
      .input(ws.extend(CreateProject.shape))
      .output(Project),
    update: baseContract
      .route({ method: 'PATCH', path: '/projects/{projectId}', ...t('projects') })
      .input(pr.extend({ patch: UpdateProject }))
      .output(Project),
    archive: baseContract
      .route({ method: 'POST', path: '/projects/{projectId}/archive', ...t('projects') })
      .input(pr.extend({ archived: z.boolean().default(true) }))
      .output(Project),
    delete: baseContract
      .route({ method: 'DELETE', path: '/projects/{projectId}', ...t('projects') })
      .input(pr)
      .output(Ok),
    /** rotate/enable/disable the public intake token */
    setIntake: baseContract
      .route({ method: 'POST', path: '/projects/{projectId}/intake', ...t('projects', 'intake') })
      .input(pr.extend({ enabled: z.boolean(), rotate: z.boolean().default(false) }))
      .output(z.object({ token: z.string().nullable() })),

    members: {
      list: baseContract
        .route({ method: 'GET', path: '/projects/{projectId}/members', ...t('projects') })
        .input(pr)
        .output(z.array(ProjectMember)),
      add: baseContract
        .route({ method: 'POST', path: '/projects/{projectId}/members', ...t('projects') })
        .input(pr.extend({ userIds: z.array(UserId).min(1).max(200), role: ProjectRole.default('member') }))
        .output(z.array(ProjectMember)),
      remove: baseContract
        .route({ method: 'DELETE', path: '/projects/{projectId}/members/{userId}', ...t('projects') })
        .input(pr.extend({ userId: UserId }))
        .output(Ok),
      setRole: baseContract
        .route({ method: 'PUT', path: '/projects/{projectId}/members/{userId}', ...t('projects') })
        .input(pr.extend({ userId: UserId, role: ProjectRole }))
        .output(ProjectMember),
    },

    templates: {
      list: baseContract
        .route({ method: 'GET', path: '/project-templates', ...t('projects') })
        .input(ws)
        .output(z.array(ProjectTemplate)),
      /** snapshot an existing project (types, workflows, fields, labels, views) as a template */
      saveFromProject: baseContract
        .route({ method: 'POST', path: '/project-templates', ...t('projects') })
        .input(pr.extend({ name: z.string().min(1).max(120), description: z.string().max(1000).optional() }))
        .output(ProjectTemplate),
      delete: baseContract
        .route({ method: 'DELETE', path: '/project-templates/{id}', ...t('projects') })
        .input(ws.extend({ id: Id }))
        .output(Ok),
    },
  },

  // ------------------------------------------------------------ work item types
  types: {
    list: baseContract
      .route({ method: 'GET', path: '/types', ...t('types') })
      .input(ws.extend({ projectId: Id.optional(), includeArchived: z.boolean().default(false) }))
      .output(z.array(WorkItemType)),
    create: baseContract
      .route({ method: 'POST', path: '/types', ...t('types') })
      .input(ws.extend(UpsertWorkItemType.shape))
      .output(WorkItemType),
    update: baseContract
      .route({ method: 'PATCH', path: '/types/{id}', ...t('types') })
      .input(ws.extend({ id: Id, patch: UpsertWorkItemType.partial() }))
      .output(WorkItemType),
    archive: baseContract
      .route({ method: 'POST', path: '/types/{id}/archive', ...t('types') })
      .input(ws.extend({ id: Id, archived: z.boolean().default(true) }))
      .output(WorkItemType),
    hierarchyRules: baseContract
      .route({ method: 'GET', path: '/types/hierarchy-rules', ...t('types') })
      .input(ws)
      .output(HierarchyRules),
    setHierarchyRules: baseContract
      .route({ method: 'PUT', path: '/types/hierarchy-rules', ...t('types') })
      .input(ws.extend({ rules: HierarchyRules }))
      .output(HierarchyRules),
    schemes: {
      list: baseContract
        .route({ method: 'GET', path: '/type-schemes', ...t('types') })
        .input(ws)
        .output(z.array(TypeScheme)),
      create: baseContract
        .route({ method: 'POST', path: '/type-schemes', ...t('types') })
        .input(
          ws.extend({
            name: z.string().min(1).max(120),
            typeIds: z.array(Id),
            defaultTypeId: Id.nullable().optional(),
          }),
        )
        .output(TypeScheme),
      update: baseContract
        .route({ method: 'PATCH', path: '/type-schemes/{id}', ...t('types') })
        .input(
          ws.extend({
            id: Id,
            patch: z.object({
              name: z.string().min(1).max(120).optional(),
              typeIds: z.array(Id).optional(),
              defaultTypeId: Id.nullable().optional(),
            }),
          }),
        )
        .output(TypeScheme),
      delete: baseContract
        .route({ method: 'DELETE', path: '/type-schemes/{id}', ...t('types') })
        .input(ws.extend({ id: Id }))
        .output(Ok),
    },
  },

  // -------------------------------------------------------------- custom fields
  fields: {
    list: baseContract
      .route({ method: 'GET', path: '/fields', ...t('fields') })
      .input(ws.extend({ projectId: Id.optional(), includeArchived: z.boolean().default(false) }))
      .output(z.array(FieldDef)),
    create: baseContract
      .route({ method: 'POST', path: '/fields', ...t('fields') })
      .input(ws.extend(UpsertFieldDef.shape))
      .output(FieldDef),
    update: baseContract
      .route({ method: 'PATCH', path: '/fields/{id}', ...t('fields') })
      .input(ws.extend({ id: Id, patch: UpsertFieldDef.partial().omit({ key: true, type: true }) }))
      .output(FieldDef),
    archive: baseContract
      .route({ method: 'POST', path: '/fields/{id}/archive', ...t('fields') })
      .input(ws.extend({ id: Id, archived: z.boolean().default(true) }))
      .output(FieldDef),
    delete: baseContract
      .route({ method: 'DELETE', path: '/fields/{id}', ...t('fields') })
      .input(ws.extend({ id: Id }))
      .output(Ok),
    schemes: {
      list: baseContract
        .route({ method: 'GET', path: '/field-schemes', ...t('fields') })
        .input(ws)
        .output(z.array(FieldScheme)),
      create: baseContract
        .route({ method: 'POST', path: '/field-schemes', ...t('fields') })
        .input(ws.extend({ name: z.string().min(1).max(120), fieldIds: z.array(Id) }))
        .output(FieldScheme),
      update: baseContract
        .route({ method: 'PATCH', path: '/field-schemes/{id}', ...t('fields') })
        .input(
          ws.extend({
            id: Id,
            patch: z.object({
              name: z.string().min(1).max(120).optional(),
              fieldIds: z.array(Id).optional(),
            }),
          }),
        )
        .output(FieldScheme),
      delete: baseContract
        .route({ method: 'DELETE', path: '/field-schemes/{id}', ...t('fields') })
        .input(ws.extend({ id: Id }))
        .output(Ok),
    },
  },

  // ------------------------------------------------------------------ workflows
  workflows: {
    list: baseContract
      .route({ method: 'GET', path: '/workflows', ...t('workflows') })
      .input(ws.extend({ projectId: Id.optional(), includeArchived: z.boolean().default(false) }))
      .output(z.array(Workflow)),
    get: baseContract
      .route({ method: 'GET', path: '/workflows/{id}', ...t('workflows') })
      .input(ws.extend({ id: Id }))
      .output(Workflow),
    create: baseContract
      .route({ method: 'POST', path: '/workflows', ...t('workflows') })
      .input(ws.extend(UpsertWorkflow.shape))
      .output(Workflow),
    update: baseContract
      .route({ method: 'PATCH', path: '/workflows/{id}', ...t('workflows') })
      .input(ws.extend({ id: Id, patch: UpsertWorkflow.partial() }))
      .output(Workflow),
    archive: baseContract
      .route({ method: 'POST', path: '/workflows/{id}/archive', ...t('workflows') })
      .input(ws.extend({ id: Id, archived: z.boolean().default(true) }))
      .output(Workflow),
    /** validate a definition without saving (structure + rule configs) */
    validate: baseContract
      .route({ method: 'POST', path: '/workflows/validate', ...t('workflows') })
      .input(ws.extend({ definition: z.unknown() }))
      .output(
        z.object({ ok: z.boolean(), problems: z.array(z.object({ path: z.string(), message: z.string() })) }),
      ),
    /** built-in workflow templates (software, kanban, simple) */
    templates: baseContract
      .route({ method: 'GET', path: '/workflows/templates', ...t('workflows') })
      .output(z.array(z.object({ id: z.string(), name: z.string(), definition: WorkflowDefinition }))),
    /** every status of every workflow a project uses (board columns, KQL autocomplete) */
    statuses: baseContract
      .route({ method: 'GET', path: '/workflows/statuses', ...t('workflows') })
      .input(ws.extend({ projectId: Id.optional() }))
      .output(z.array(StatusInfo)),
    schemes: {
      list: baseContract
        .route({ method: 'GET', path: '/workflow-schemes', ...t('workflows') })
        .input(ws)
        .output(z.array(WorkflowScheme)),
      create: baseContract
        .route({ method: 'POST', path: '/workflow-schemes', ...t('workflows') })
        .input(ws.extend(UpsertWorkflowScheme.shape))
        .output(WorkflowScheme),
      update: baseContract
        .route({ method: 'PATCH', path: '/workflow-schemes/{id}', ...t('workflows') })
        .input(ws.extend({ id: Id, patch: UpsertWorkflowScheme.partial() }))
        .output(WorkflowScheme),
      delete: baseContract
        .route({ method: 'DELETE', path: '/workflow-schemes/{id}', ...t('workflows') })
        .input(ws.extend({ id: Id }))
        .output(Ok),
    },
  },

  // --------------------------------------------------------------------- issues
  issues: {
    get: baseContract
      .route({ method: 'GET', path: '/issues/{issueId}', ...t('issues') })
      .input(iss)
      .output(Issue),
    getByKey: baseContract
      .route({ method: 'GET', path: '/issues/key/{key}', ...t('issues') })
      .input(ws.extend({ key: IssueKey }))
      .output(Issue),
    getMany: baseContract
      .route({ method: 'POST', path: '/issues/get-many', ...t('issues') })
      .input(ws.extend({ ids: z.array(Id).max(500) }))
      .output(z.array(Issue)),
    /** KQL-powered listing behind every view/board/report */
    query: baseContract
      .route({ method: 'POST', path: '/issues/query', ...t('issues', 'kql') })
      .input(IssueQueryInput)
      .output(IssueQueryResult),
    create: baseContract
      .route({ method: 'POST', path: '/issues', ...t('issues') })
      .input(ws.extend(CreateIssue.shape))
      .output(Issue),
    update: baseContract
      .route({ method: 'PATCH', path: '/issues/{issueId}', ...t('issues') })
      .input(iss.extend({ patch: UpdateIssue }))
      .output(Issue),
    bulkUpdate: baseContract
      .route({ method: 'POST', path: '/issues/bulk', ...t('issues') })
      .input(ws.extend({ ids: z.array(Id).min(1).max(500), patch: UpdateIssue }))
      .output(BulkResult),
    delete: baseContract
      .route({ method: 'DELETE', path: '/issues/{issueId}', ...t('issues') })
      .input(iss)
      .output(Ok),
    archive: baseContract
      .route({ method: 'POST', path: '/issues/{issueId}/archive', ...t('issues') })
      .input(iss.extend({ archived: z.boolean().default(true) }))
      .output(Issue),
    /** move to another project (re-keys the issue and its sub-items) */
    move: baseContract
      .route({ method: 'POST', path: '/issues/{issueId}/move', ...t('issues') })
      .input(iss.extend({ projectId: Id }))
      .output(Issue),
    /** reorder within rank order; place after and/or before the given issues */
    rank: baseContract
      .route({ method: 'POST', path: '/issues/{issueId}/rank', ...t('issues') })
      .input(iss.extend({ afterId: Id.nullable().optional(), beforeId: Id.nullable().optional() }))
      .output(z.object({ id: Id, rank: z.string() })),
    /** field-level history + status history */
    history: baseContract
      .route({ method: 'GET', path: '/issues/{issueId}/history', ...t('issues') })
      .input(iss.extend(PageInput.shape))
      .output(
        z.object({
          items: z.array(IssueHistoryEntry),
          statusHistory: z.array(StatusHistoryEntry),
          nextCursor: z.string().nullable(),
        }),
      ),
    watchers: {
      add: baseContract
        .route({ method: 'POST', path: '/issues/{issueId}/watchers', ...t('issues') })
        .input(iss.extend({ userId: UserId.optional() }))
        .output(z.object({ watcherIds: z.array(UserId) })),
      remove: baseContract
        .route({ method: 'DELETE', path: '/issues/{issueId}/watchers/{userId}', ...t('issues') })
        .input(iss.extend({ userId: UserId }))
        .output(z.object({ watcherIds: z.array(UserId) })),
    },

    transitions: {
      /** transitions available from the issue's current status, with per-transition blockers */
      available: baseContract
        .route({ method: 'GET', path: '/issues/{issueId}/transitions', ...t('issues', 'workflows') })
        .input(iss)
        .output(z.array(AvailableTransition)),
      apply: baseContract
        .route({
          method: 'POST',
          path: '/issues/{issueId}/transitions/{transitionId}',
          ...t('issues', 'workflows'),
        })
        .input(
          iss.extend({
            transitionId: z.string(),
            fields: z.record(z.string(), z.unknown()).optional(),
            comment: z.string().max(10000).optional(),
            resolution: z.string().max(64).nullable().optional(),
          }),
        )
        .output(
          z.object({
            issue: Issue,
            /** set when the transition is now waiting for approval instead of applied */
            approval: IssueApproval.nullable(),
          }),
        ),
    },

    approvals: {
      list: baseContract
        .route({ method: 'GET', path: '/issues/{issueId}/approvals', ...t('issues', 'workflows') })
        .input(iss)
        .output(z.array(IssueApproval)),
      decide: baseContract
        .route({
          method: 'POST',
          path: '/issues/{issueId}/approvals/{transitionId}',
          ...t('issues', 'workflows'),
        })
        .input(
          iss.extend({
            transitionId: z.string(),
            decision: z.enum(['approve', 'reject']),
            comment: z.string().max(2000).optional(),
          }),
        )
        .output(
          z.object({
            approval: IssueApproval,
            /** when the approval completed and the transition auto-applied */
            issue: Issue.nullable(),
          }),
        ),
    },

    comments: {
      list: baseContract
        .route({ method: 'GET', path: '/issues/{issueId}/comments', ...t('comments') })
        .input(iss.extend(PageInput.shape))
        .output(page(Comment)),
      create: baseContract
        .route({ method: 'POST', path: '/issues/{issueId}/comments', ...t('comments') })
        .input(
          iss.extend({
            body: RichDoc,
            parentId: Id.nullable().optional(),
            internal: z.boolean().default(false),
          }),
        )
        .output(Comment),
      update: baseContract
        .route({ method: 'PATCH', path: '/comments/{commentId}', ...t('comments') })
        .input(ws.extend({ commentId: Id, body: RichDoc }))
        .output(Comment),
      delete: baseContract
        .route({ method: 'DELETE', path: '/comments/{commentId}', ...t('comments') })
        .input(ws.extend({ commentId: Id }))
        .output(Ok),
      /** toggle a reaction */
      react: baseContract
        .route({ method: 'POST', path: '/comments/{commentId}/reactions', ...t('comments') })
        .input(ws.extend({ commentId: Id, emoji: z.string().min(1).max(32) }))
        .output(Comment),
    },

    relations: {
      list: baseContract
        .route({ method: 'GET', path: '/issues/{issueId}/relations', ...t('relations') })
        .input(iss)
        .output(z.array(RelationView)),
      create: baseContract
        .route({ method: 'POST', path: '/issues/{issueId}/relations', ...t('relations') })
        .input(iss.extend({ type: RelationType, targetIssueId: Id }))
        .output(z.array(RelationView)),
      delete: baseContract
        .route({ method: 'DELETE', path: '/relations/{relationId}', ...t('relations') })
        .input(ws.extend({ relationId: Id }))
        .output(Ok),
    },

    attachments: {
      list: baseContract
        .route({ method: 'GET', path: '/issues/{issueId}/attachments', ...t('attachments') })
        .input(iss)
        .output(z.array(Attachment)),
      /** attach an already-uploaded core file */
      add: baseContract
        .route({ method: 'POST', path: '/issues/{issueId}/attachments', ...t('attachments') })
        .input(iss.extend({ fileIds: z.array(Id).min(1).max(50) }))
        .output(z.array(Attachment)),
      remove: baseContract
        .route({ method: 'DELETE', path: '/attachments/{attachmentId}', ...t('attachments') })
        .input(ws.extend({ attachmentId: Id }))
        .output(Ok),
    },

    links: {
      list: baseContract
        .route({ method: 'GET', path: '/issues/{issueId}/links', ...t('links') })
        .input(iss)
        .output(z.array(Link)),
      add: baseContract
        .route({ method: 'POST', path: '/issues/{issueId}/links', ...t('links') })
        .input(
          iss.extend({
            url: z.string().url(),
            title: z.string().max(300).optional(),
            kind: z.string().max(32).default('generic'),
          }),
        )
        .output(Link),
      remove: baseContract
        .route({ method: 'DELETE', path: '/links/{linkId}', ...t('links') })
        .input(ws.extend({ linkId: Id }))
        .output(Ok),
    },

    templates: {
      list: baseContract
        .route({ method: 'GET', path: '/issue-templates', ...t('templates') })
        .input(ws.extend({ projectId: Id.optional() }))
        .output(z.array(IssueTemplate)),
      create: baseContract
        .route({ method: 'POST', path: '/issue-templates', ...t('templates') })
        .input(ws.extend(UpsertIssueTemplate.shape))
        .output(IssueTemplate),
      update: baseContract
        .route({ method: 'PATCH', path: '/issue-templates/{id}', ...t('templates') })
        .input(ws.extend({ id: Id, patch: UpsertIssueTemplate.partial() }))
        .output(IssueTemplate),
      delete: baseContract
        .route({ method: 'DELETE', path: '/issue-templates/{id}', ...t('templates') })
        .input(ws.extend({ id: Id }))
        .output(Ok),
    },

    recurring: {
      list: baseContract
        .route({ method: 'GET', path: '/recurring', ...t('templates') })
        .input(pr)
        .output(z.array(RecurringIssue)),
      create: baseContract
        .route({ method: 'POST', path: '/recurring', ...t('templates') })
        .input(pr.extend(UpsertRecurringIssue.shape))
        .output(RecurringIssue),
      update: baseContract
        .route({ method: 'PATCH', path: '/recurring/{id}', ...t('templates') })
        .input(ws.extend({ id: Id, patch: UpsertRecurringIssue.partial() }))
        .output(RecurringIssue),
      delete: baseContract
        .route({ method: 'DELETE', path: '/recurring/{id}', ...t('templates') })
        .input(ws.extend({ id: Id }))
        .output(Ok),
    },
  },

  // ------------------------------------------------------------------------ kql
  kql: {
    /** parse + validate a query; returns AST, errors and autocomplete suggestions */
    parse: baseContract
      .route({ method: 'POST', path: '/kql/parse', ...t('kql') })
      .input(ws.extend({ kql: z.string().max(4000), projectIds: z.array(Id).optional() }))
      .output(KqlParseResult),
    /** searchable fields incl. custom fields, with operators and known values */
    fields: baseContract
      .route({ method: 'GET', path: '/kql/fields', ...t('kql') })
      .input(ws.extend({ projectIds: z.array(Id).optional() }))
      .output(z.array(KqlFieldInfo)),
  },

  // ------------------------------------------------------------------- planning
  cycles: {
    list: baseContract
      .route({ method: 'GET', path: '/cycles', ...t('cycles') })
      .input(pr.extend({ status: z.enum(['upcoming', 'active', 'completed']).optional() }))
      .output(z.array(Cycle)),
    get: baseContract
      .route({ method: 'GET', path: '/cycles/{id}', ...t('cycles') })
      .input(ws.extend({ id: Id }))
      .output(Cycle),
    create: baseContract
      .route({ method: 'POST', path: '/cycles', ...t('cycles') })
      .input(pr.extend(UpsertCycle.shape))
      .output(Cycle),
    update: baseContract
      .route({ method: 'PATCH', path: '/cycles/{id}', ...t('cycles') })
      .input(ws.extend({ id: Id, patch: UpsertCycle.partial() }))
      .output(Cycle),
    delete: baseContract
      .route({ method: 'DELETE', path: '/cycles/{id}', ...t('cycles') })
      .input(ws.extend({ id: Id }))
      .output(Ok),
    start: baseContract
      .route({ method: 'POST', path: '/cycles/{id}/start', ...t('cycles') })
      .input(ws.extend({ id: Id }))
      .output(Cycle),
    /** complete; unfinished issues move to `rollTo` (next upcoming by default) or the backlog */
    complete: baseContract
      .route({ method: 'POST', path: '/cycles/{id}/complete', ...t('cycles') })
      .input(ws.extend({ id: Id, rollToCycleId: Id.nullable().optional() }))
      .output(Cycle),
  },

  milestones: {
    list: baseContract
      .route({ method: 'GET', path: '/milestones', ...t('planning') })
      .input(pr)
      .output(z.array(Milestone)),
    create: baseContract
      .route({ method: 'POST', path: '/milestones', ...t('planning') })
      .input(pr.extend(UpsertMilestone.shape))
      .output(Milestone),
    update: baseContract
      .route({ method: 'PATCH', path: '/milestones/{id}', ...t('planning') })
      .input(ws.extend({ id: Id, patch: UpsertMilestone.partial() }))
      .output(Milestone),
    delete: baseContract
      .route({ method: 'DELETE', path: '/milestones/{id}', ...t('planning') })
      .input(ws.extend({ id: Id }))
      .output(Ok),
  },

  versions: {
    list: baseContract
      .route({ method: 'GET', path: '/versions', ...t('planning') })
      .input(pr)
      .output(z.array(Version)),
    create: baseContract
      .route({ method: 'POST', path: '/versions', ...t('planning') })
      .input(pr.extend(UpsertVersion.shape))
      .output(Version),
    update: baseContract
      .route({ method: 'PATCH', path: '/versions/{id}', ...t('planning') })
      .input(ws.extend({ id: Id, patch: UpsertVersion.partial() }))
      .output(Version),
    delete: baseContract
      .route({ method: 'DELETE', path: '/versions/{id}', ...t('planning') })
      .input(ws.extend({ id: Id }))
      .output(Ok),
    release: baseContract
      .route({ method: 'POST', path: '/versions/{id}/release', ...t('planning') })
      .input(ws.extend({ id: Id, released: z.boolean().default(true) }))
      .output(Version),
  },

  components: {
    list: baseContract
      .route({ method: 'GET', path: '/components', ...t('planning') })
      .input(pr)
      .output(z.array(Component)),
    create: baseContract
      .route({ method: 'POST', path: '/components', ...t('planning') })
      .input(pr.extend(UpsertComponent.shape))
      .output(Component),
    update: baseContract
      .route({ method: 'PATCH', path: '/components/{id}', ...t('planning') })
      .input(ws.extend({ id: Id, patch: UpsertComponent.partial() }))
      .output(Component),
    delete: baseContract
      .route({ method: 'DELETE', path: '/components/{id}', ...t('planning') })
      .input(ws.extend({ id: Id }))
      .output(Ok),
  },

  labels: {
    list: baseContract
      .route({ method: 'GET', path: '/labels', ...t('planning') })
      .input(ws.extend({ projectId: Id.optional(), includeArchived: z.boolean().default(false) }))
      .output(z.array(Label)),
    create: baseContract
      .route({ method: 'POST', path: '/labels', ...t('planning') })
      .input(ws.extend(UpsertLabel.shape))
      .output(Label),
    update: baseContract
      .route({ method: 'PATCH', path: '/labels/{id}', ...t('planning') })
      .input(ws.extend({ id: Id, patch: UpsertLabel.partial() }))
      .output(Label),
    delete: baseContract
      .route({ method: 'DELETE', path: '/labels/{id}', ...t('planning') })
      .input(ws.extend({ id: Id }))
      .output(Ok),
  },

  // ---------------------------------------------------------------------- views
  views: {
    list: baseContract
      .route({ method: 'GET', path: '/views', ...t('views') })
      .input(ws.extend({ projectId: Id.nullable().optional() }))
      .output(z.array(View)),
    get: baseContract
      .route({ method: 'GET', path: '/views/{id}', ...t('views') })
      .input(ws.extend({ id: Id }))
      .output(View),
    create: baseContract
      .route({ method: 'POST', path: '/views', ...t('views') })
      .input(ws.extend(UpsertView.shape))
      .output(View),
    update: baseContract
      .route({ method: 'PATCH', path: '/views/{id}', ...t('views') })
      .input(ws.extend({ id: Id, patch: UpsertView.partial() }))
      .output(View),
    delete: baseContract
      .route({ method: 'DELETE', path: '/views/{id}', ...t('views') })
      .input(ws.extend({ id: Id }))
      .output(Ok),
    pin: baseContract
      .route({ method: 'POST', path: '/views/{id}/pin', ...t('views') })
      .input(ws.extend({ id: Id, pinned: z.boolean() }))
      .output(View),
  },

  // ------------------------------------------------------------- intake / triage
  intake: {
    /** PUBLIC: intake form metadata by token (no auth) */
    form: oc
      .route({ method: 'GET', path: '/intake/{token}', ...t('intake') })
      .input(z.object({ token: z.string().min(8) }))
      .output(IntakeForm),
    /** PUBLIC: submit the intake form → triage issue (no auth, honeypot + rate-limited) */
    submit: oc
      .route({ method: 'POST', path: '/intake/{token}', ...t('intake') })
      .input(IntakeSubmission)
      .output(z.object({ ok: z.literal(true), issueKey: IssueKey })),
  },

  triage: {
    /** accept out of triage into the workflow (default: initial non-triage status) */
    accept: baseContract
      .route({ method: 'POST', path: '/triage/{issueId}/accept', ...t('intake') })
      .input(iss.extend({ statusId: z.string().optional() }))
      .output(Issue),
    decline: baseContract
      .route({ method: 'POST', path: '/triage/{issueId}/decline', ...t('intake') })
      .input(iss.extend({ comment: z.string().max(2000).optional() }))
      .output(Issue),
    snooze: baseContract
      .route({ method: 'POST', path: '/triage/{issueId}/snooze', ...t('intake') })
      .input(iss.extend({ until: Timestamp }))
      .output(Issue),
  },

  // -------------------------------------------------------------------- reports
  reports: {
    burndown: baseContract
      .route({ method: 'GET', path: '/reports/burndown/{cycleId}', ...t('reports') })
      .input(ws.extend({ cycleId: Id }))
      .output(BurndownReport),
    velocity: baseContract
      .route({ method: 'GET', path: '/reports/velocity', ...t('reports') })
      .input(pr.extend({ lastN: z.number().int().min(1).max(24).default(6) }))
      .output(VelocityReport),
    cfd: baseContract
      .route({ method: 'GET', path: '/reports/cfd', ...t('reports') })
      .input(pr.extend({ from: DateOnly, to: DateOnly }))
      .output(CfdReport),
    createdVsResolved: baseContract
      .route({ method: 'GET', path: '/reports/created-vs-resolved', ...t('reports') })
      .input(pr.extend({ from: DateOnly, to: DateOnly }))
      .output(CreatedVsResolvedReport),
    time: baseContract
      .route({ method: 'GET', path: '/reports/time', ...t('reports', 'time') })
      .input(
        ws.extend({
          from: DateOnly,
          to: DateOnly,
          projectId: Id.optional(),
          userId: UserId.optional(),
          billableOnly: z.boolean().default(false),
        }),
      )
      .output(TimeReport),
  },

  // ---------------------------------------------------------------- time tracking
  worklogs: {
    list: baseContract
      .route({ method: 'GET', path: '/issues/{issueId}/worklogs', ...t('time') })
      .input(iss)
      .output(z.array(Worklog)),
    create: baseContract
      .route({ method: 'POST', path: '/issues/{issueId}/worklogs', ...t('time') })
      .input(iss.extend(UpsertWorklog.shape))
      .output(z.object({ worklog: Worklog, issue: Issue })),
    update: baseContract
      .route({ method: 'PATCH', path: '/worklogs/{id}', ...t('time') })
      .input(ws.extend({ id: Id, patch: UpsertWorklog.partial() }))
      .output(Worklog),
    delete: baseContract
      .route({ method: 'DELETE', path: '/worklogs/{id}', ...t('time') })
      .input(ws.extend({ id: Id }))
      .output(Ok),
    timers: {
      /** start a timer on an issue (stops any running timer of the caller first) */
      start: baseContract
        .route({ method: 'POST', path: '/issues/{issueId}/timer', ...t('time') })
        .input(iss.extend({ note: z.string().max(2000).optional() }))
        .output(Timer),
      /** stop the caller's running timer → worklog */
      stop: baseContract
        .route({ method: 'POST', path: '/timer/stop', ...t('time') })
        .input(ws.extend({ discard: z.boolean().default(false) }))
        .output(z.object({ worklog: Worklog.nullable() })),
      current: baseContract
        .route({ method: 'GET', path: '/timer', ...t('time') })
        .input(ws)
        .output(z.object({ timer: Timer.nullable() })),
    },
  },

  // -------------------------------------------------------------------- imports
  imports: {
    /** start an import job (CSV / Jira JSON / Linear JSON export); file must be uploaded to core files first */
    start: baseContract
      .route({ method: 'POST', path: '/imports', ...t('imports') })
      .input(
        pr.extend({
          source: ImportSource,
          fileId: Id,
          /** CSV: CsvMapping; jira/linear: source-specific options (all optional) */
          mapping: z.union([CsvMapping, z.record(z.string(), z.unknown())]).default({}),
        }),
      )
      .output(ImportJob),
    get: baseContract
      .route({ method: 'GET', path: '/imports/{id}', ...t('imports') })
      .input(ws.extend({ id: Id }))
      .output(ImportJob),
    list: baseContract
      .route({ method: 'GET', path: '/imports', ...t('imports') })
      .input(pr)
      .output(z.array(ImportJob)),
    cancel: baseContract
      .route({ method: 'POST', path: '/imports/{id}/cancel', ...t('imports') })
      .input(ws.extend({ id: Id }))
      .output(ImportJob),
  },
}

export type TrackerContract = typeof trackerContract
