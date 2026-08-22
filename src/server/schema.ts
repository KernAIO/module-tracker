import { sql } from 'drizzle-orm'
import {
  boolean,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// `pgSchema` directly (not `moduleSchema` from @kernhq/kernel) so drizzle-kit can load this file standalone
export const schema = pgSchema('mod_tracker')

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })
const ts = (name: string) => timestamp(name, { withTimezone: true })
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`)
const ws = () => uuid('workspace_id').notNull()
const uuidArray = (name: string) => uuid(name).array().notNull().default(sql`'{}'::uuid[]`)
const jsonObject = (name: string) => jsonb(name).notNull().default(sql`'{}'::jsonb`)
const jsonArray = (name: string) => jsonb(name).notNull().default(sql`'[]'::jsonb`)

/**
 * Workspaces the tracker is active in. Deliberately **not** a tenant table: it holds nothing but ids,
 * and the scheduled jobs (due dates, recurring issues, cycle roll-over, SLA clocks) need to enumerate
 * tenants before they can open an RLS-bound transaction per workspace.
 */
export const workspaces = schema.table('workspaces', {
  workspaceId: uuid('workspace_id').primaryKey(),
  createdAt: ts('created_at').notNull().defaultNow(),
})

// =====================================================================================
// projects
// =====================================================================================

export const projects = schema.table(
  'projects',
  {
    id: id(),
    workspaceId: ws(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    icon: text('icon'),
    color: text('color'),
    leadId: uuid('lead_id'),
    visibility: text('visibility').notNull().default('workspace'), // workspace | private
    defaultAssignee: text('default_assignee').notNull().default('unassigned'), // unassigned | lead
    workflowSchemeId: uuid('workflow_scheme_id'),
    typeSchemeId: uuid('type_scheme_id'),
    settings: jsonObject('settings'),
    /** public intake form token; null disables the form */
    intakeToken: text('intake_token'),
    memberCount: integer('member_count').notNull().default(0),
    archivedAt: ts('archived_at'),
    createdBy: uuid('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('projects_ws_key_uq').on(t.workspaceId, t.key),
    uniqueIndex('projects_intake_token_uq').on(t.intakeToken).where(sql`intake_token is not null`),
    index('projects_ws_idx').on(t.workspaceId, t.archivedAt),
  ],
)

/**
 * Public intake tokens. Like `workspaces` this is deliberately not a tenant table: the public intake
 * form and inbound email arrive with nothing but a token, so the token has to be resolvable to a
 * workspace *before* an RLS-bound transaction can be opened. It holds no tenant content.
 */
export const intakeTokens = schema.table('intake_tokens', {
  token: text('token').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  projectId: uuid('project_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
})

/**
 * Per-project sequence generators. Kept out of `projects` so allocating an issue key locks one narrow
 * row instead of the project itself (`update … returning` serialises concurrent creates per project).
 */
export const issueCounters = schema.table('issue_counters', {
  projectId: uuid('project_id').primaryKey(),
  workspaceId: ws(),
  lastIssueNumber: integer('last_issue_number').notNull().default(0),
  lastCycleNumber: integer('last_cycle_number').notNull().default(0),
})

export const projectMembers = schema.table(
  'project_members',
  {
    projectId: uuid('project_id').notNull(),
    workspaceId: ws(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull().default('member'), // admin | member | viewer
    addedBy: uuid('added_by'),
    addedAt: ts('added_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('project_members_ws_user_idx').on(t.workspaceId, t.userId),
  ],
)

export const projectTemplates = schema.table(
  'project_templates',
  {
    id: id(),
    workspaceId: ws(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    icon: text('icon'),
    body: jsonObject('body'),
    builtin: boolean('builtin').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('project_templates_ws_key_uq').on(t.workspaceId, t.key)],
)

// =====================================================================================
// work item types, custom fields, workflows
// =====================================================================================

export const workItemTypes = schema.table(
  'work_item_types',
  {
    id: id(),
    workspaceId: ws(),
    /** null = workspace-level type shared by every project */
    projectId: uuid('project_id'),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    icon: text('icon'),
    color: text('color'),
    level: integer('level').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    workflowId: uuid('workflow_id'),
    fieldLayout: jsonArray('field_layout'),
    templateBody: jsonb('template_body'),
    order: integer('order').notNull().default(0),
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('work_item_types_ws_project_key_uq')
      .on(t.workspaceId, t.projectId, t.key)
      .where(sql`project_id is not null`),
    uniqueIndex('work_item_types_ws_key_uq').on(t.workspaceId, t.key).where(sql`project_id is null`),
    index('work_item_types_ws_idx').on(t.workspaceId, t.projectId, t.order),
  ],
)

export const typeSchemes = schema.table(
  'type_schemes',
  {
    id: id(),
    workspaceId: ws(),
    name: text('name').notNull(),
    typeIds: uuidArray('type_ids'),
    defaultTypeId: uuid('default_type_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('type_schemes_ws_idx').on(t.workspaceId, t.createdAt)],
)

/** Per-workspace parenting rules (one row per workspace). */
export const hierarchyRules = schema.table('hierarchy_rules', {
  workspaceId: uuid('workspace_id').primaryKey(),
  rules: jsonObject('rules'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

export const fieldDefs = schema.table(
  'field_defs',
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid('project_id'),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    type: text('type').notNull(),
    options: jsonArray('options'),
    defaultValue: jsonb('default_value'),
    config: jsonObject('config'),
    searchable: boolean('searchable').notNull().default(false),
    required: boolean('required').notNull().default(false),
    showInCards: boolean('show_in_cards').notNull().default(false),
    order: integer('order').notNull().default(0),
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // One key per workspace, whatever the project scope: the key *is* the `issues.custom` key,
    // so two definitions sharing one would share a value. See migration 0002.
    uniqueIndex('field_defs_ws_key_uq').on(t.workspaceId, t.key),
    index('field_defs_ws_idx').on(t.workspaceId, t.projectId, t.order),
  ],
)

export const workflows = schema.table(
  'workflows',
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid('project_id'),
    name: text('name').notNull(),
    description: text('description'),
    definition: jsonObject('definition'),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('workflows_ws_idx').on(t.workspaceId, t.projectId, t.archivedAt)],
)

export const workflowSchemes = schema.table(
  'workflow_schemes',
  {
    id: id(),
    workspaceId: ws(),
    name: text('name').notNull(),
    defaultWorkflowId: uuid('default_workflow_id').notNull(),
    mappings: jsonArray('mappings'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('workflow_schemes_ws_idx').on(t.workspaceId, t.createdAt)],
)

// =====================================================================================
// issues
// =====================================================================================

export const issues = schema.table(
  'issues',
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid('project_id').notNull(),
    key: text('key').notNull(),
    number: integer('number').notNull(),
    typeId: uuid('type_id').notNull(),
    title: text('title').notNull(),
    description: jsonb('description'),
    descriptionText: text('description_text').notNull().default(''),
    statusId: text('status_id').notNull(),
    statusCategory: text('status_category').notNull(),
    priority: text('priority').notNull().default('none'),
    assigneeIds: uuidArray('assignee_ids'),
    reporterId: uuid('reporter_id'),
    creatorId: uuid('creator_id'),
    labelIds: uuidArray('label_ids'),
    componentIds: uuidArray('component_ids'),
    versionIds: uuidArray('version_ids'),
    affectsVersionIds: uuidArray('affects_version_ids'),
    cycleId: uuid('cycle_id'),
    milestoneId: uuid('milestone_id'),
    parentId: uuid('parent_id'),
    /** fractional index (base-62) for manual ordering in backlogs and boards */
    rank: text('rank').notNull(),
    estimate: doublePrecision('estimate'),
    estimateUnit: text('estimate_unit').notNull().default('points'),
    startDate: date('start_date', { mode: 'string' }),
    dueDate: date('due_date', { mode: 'string' }),
    completedAt: ts('completed_at'),
    cancelledAt: ts('cancelled_at'),
    resolution: text('resolution'),
    /** custom field values keyed by field key */
    custom: jsonObject('custom'),
    watcherIds: uuidArray('watcher_ids'),
    commentCount: integer('comment_count').notNull().default(0),
    attachmentCount: integer('attachment_count').notNull().default(0),
    timeSpentSec: integer('time_spent_sec').notNull().default(0),
    remainingSec: integer('remaining_sec'),
    originalEstimateSec: integer('original_estimate_sec'),
    sla: jsonb('sla'),
    triage: boolean('triage').notNull().default(false),
    snoozedUntil: ts('snoozed_until'),
    source: text('source').notNull().default('app'),
    externalRef: text('external_ref'),
    chatChannelId: uuid('chat_channel_id'),
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    lastActivityAt: ts('last_activity_at').notNull().defaultNow(),
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description_text, ''))`,
    ),
  },
  (t) => [
    uniqueIndex('issues_ws_key_uq').on(t.workspaceId, t.key),
    uniqueIndex('issues_project_number_uq').on(t.projectId, t.number),
    index('issues_ws_project_rank_idx').on(t.workspaceId, t.projectId, t.rank),
    index('issues_ws_project_status_idx').on(t.workspaceId, t.projectId, t.statusId),
    index('issues_ws_updated_idx').on(t.workspaceId, t.updatedAt),
    index('issues_ws_cycle_idx').on(t.workspaceId, t.cycleId).where(sql`cycle_id is not null`),
    index('issues_ws_parent_idx').on(t.workspaceId, t.parentId).where(sql`parent_id is not null`),
    index('issues_ws_due_idx').on(t.workspaceId, t.dueDate).where(sql`due_date is not null`),
    index('issues_ws_triage_idx').on(t.workspaceId, t.projectId).where(sql`triage`),
    index('issues_external_ref_idx').on(t.workspaceId, t.externalRef).where(sql`external_ref is not null`),
    index('issues_assignees_idx').using('gin', t.assigneeIds),
    index('issues_labels_idx').using('gin', t.labelIds),
    index('issues_components_idx').using('gin', t.componentIds),
    index('issues_versions_idx').using('gin', t.versionIds),
    index('issues_watchers_idx').using('gin', t.watcherIds),
    index('issues_custom_idx').using('gin', t.custom),
    index('issues_search_idx').using('gin', t.search),
  ],
)

export const comments = schema.table(
  'comments',
  {
    id: id(),
    workspaceId: ws(),
    issueId: uuid('issue_id').notNull(),
    parentId: uuid('parent_id'),
    authorId: uuid('author_id'),
    body: jsonObject('body'),
    bodyText: text('body_text').notNull().default(''),
    mentionIds: uuidArray('mention_ids'),
    internal: boolean('internal').notNull().default(false),
    source: text('source').notNull().default('app'),
    replyCount: integer('reply_count').notNull().default(0),
    editedAt: ts('edited_at'),
    deletedAt: ts('deleted_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    search: tsvector('search').generatedAlwaysAs(sql`to_tsvector('simple', coalesce(body_text, ''))`),
  },
  (t) => [
    index('comments_issue_idx').on(t.issueId, t.createdAt),
    index('comments_thread_idx').on(t.parentId, t.createdAt).where(sql`parent_id is not null`),
    index('comments_search_idx').using('gin', t.search),
  ],
)

export const commentReactions = schema.table(
  'comment_reactions',
  {
    commentId: uuid('comment_id').notNull(),
    workspaceId: ws(),
    userId: uuid('user_id').notNull(),
    emoji: text('emoji').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.commentId, t.userId, t.emoji] })],
)

export const relations = schema.table(
  'relations',
  {
    id: id(),
    workspaceId: ws(),
    type: text('type').notNull(),
    fromIssueId: uuid('from_issue_id').notNull(),
    toIssueId: uuid('to_issue_id').notNull(),
    createdBy: uuid('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('relations_edge_uq').on(t.fromIssueId, t.toIssueId, t.type),
    index('relations_to_idx').on(t.toIssueId),
  ],
)

export const attachments = schema.table(
  'attachments',
  {
    id: id(),
    workspaceId: ws(),
    issueId: uuid('issue_id').notNull(),
    /** set when the file arrived with a comment; the issue still lists it either way */
    commentId: uuid('comment_id'),
    fileId: uuid('file_id').notNull(),
    name: text('name').notNull(),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    size: integer('size').notNull().default(0),
    uploadedBy: uuid('uploaded_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('attachments_issue_file_uq').on(t.issueId, t.fileId),
    index('attachments_issue_idx').on(t.issueId, t.createdAt),
    index('attachments_comment_idx').on(t.commentId),
  ],
)

export const links = schema.table(
  'links',
  {
    id: id(),
    workspaceId: ws(),
    issueId: uuid('issue_id').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    kind: text('kind').notNull().default('generic'),
    createdBy: uuid('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('links_issue_idx').on(t.issueId, t.createdAt)],
)

/** Field-level history. Mirrored into `core.activity` but kept locally so history reads stay in one schema. */
export const issueHistory = schema.table(
  'issue_history',
  {
    id: id(),
    workspaceId: ws(),
    issueId: uuid('issue_id').notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    changes: jsonArray('changes'),
    data: jsonObject('data'),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
  },
  (t) => [index('issue_history_issue_idx').on(t.issueId, t.occurredAt)],
)

/** Status transitions with the time spent in the previous status: the source of CFD and cycle-time reports. */
export const issueStatusHistory = schema.table(
  'issue_status_history',
  {
    id: id(),
    workspaceId: ws(),
    issueId: uuid('issue_id').notNull(),
    projectId: uuid('project_id').notNull(),
    fromStatusId: text('from_status_id'),
    toStatusId: text('to_status_id').notNull(),
    fromCategory: text('from_category'),
    toCategory: text('to_category').notNull(),
    actorId: uuid('actor_id'),
    transitionId: text('transition_id'),
    durationSec: integer('duration_sec'),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
  },
  (t) => [
    index('issue_status_history_issue_idx').on(t.issueId, t.occurredAt),
    index('issue_status_history_project_idx').on(t.projectId, t.occurredAt),
  ],
)

export const issueApprovals = schema.table(
  'issue_approvals',
  {
    id: id(),
    workspaceId: ws(),
    issueId: uuid('issue_id').notNull(),
    transitionId: text('transition_id').notNull(),
    state: jsonObject('state'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('issue_approvals_issue_transition_uq').on(t.issueId, t.transitionId)],
)

export const issueTemplates = schema.table(
  'issue_templates',
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid('project_id'),
    name: text('name').notNull(),
    description: text('description'),
    typeId: uuid('type_id'),
    defaults: jsonObject('defaults'),
    subItems: jsonArray('sub_items'),
    createdBy: uuid('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('issue_templates_ws_idx').on(t.workspaceId, t.projectId)],
)

export const recurringIssues = schema.table(
  'recurring_issues',
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    rule: jsonObject('rule'),
    defaults: jsonObject('defaults'),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: ts('next_run_at'),
    lastRunAt: ts('last_run_at'),
    lastIssueId: uuid('last_issue_id'),
    runCount: integer('run_count').notNull().default(0),
    createdBy: uuid('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('recurring_issues_project_idx').on(t.projectId),
    index('recurring_issues_due_idx').on(t.nextRunAt).where(sql`enabled`),
  ],
)

// =====================================================================================
// planning
// =====================================================================================

export const cycles = schema.table(
  'cycles',
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid('project_id').notNull(),
    number: integer('number').notNull(),
    name: text('name').notNull(),
    goal: text('goal'),
    startAt: ts('start_at').notNull(),
    endAt: ts('end_at').notNull(),
    status: text('status').notNull().default('upcoming'), // upcoming | active | completed
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    carryOverCount: integer('carry_over_count').notNull().default(0),
    /** scope snapshot taken when the cycle started (committed work, for velocity) */
    committed: jsonObject('committed'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cycles_project_number_uq').on(t.projectId, t.number),
    index('cycles_project_status_idx').on(t.projectId, t.status, t.startAt),
  ],
)

export const milestones = schema.table(
  'milestones',
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    targetDate: date('target_date', { mode: 'string' }),
    status: text('status').notNull().default('open'),
    completedAt: ts('completed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('milestones_project_idx').on(t.projectId, t.targetDate)],
)

export const versions = schema.table(
  'versions',
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('unreleased'),
    startDate: date('start_date', { mode: 'string' }),
    releaseDate: date('release_date', { mode: 'string' }),
    releasedAt: ts('released_at'),
    order: integer('order').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('versions_project_idx').on(t.projectId, t.order)],
)

export const components = schema.table(
  'components',
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid('project_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    leadId: uuid('lead_id'),
    defaultAssignee: text('default_assignee').notNull().default('project'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('components_project_name_uq').on(t.projectId, t.name)],
)

export const labels = schema.table(
  'labels',
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid('project_id'),
    name: text('name').notNull(),
    color: text('color'),
    description: text('description'),
    /** labels sharing a group are mutually exclusive on an issue */
    groupName: text('group_name'),
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('labels_project_name_uq').on(t.projectId, t.name).where(sql`project_id is not null`),
    uniqueIndex('labels_ws_name_uq').on(t.workspaceId, t.name).where(sql`project_id is null`),
    index('labels_ws_idx').on(t.workspaceId, t.projectId),
  ],
)

// =====================================================================================
// views, time tracking, imports
// =====================================================================================

export const views = schema.table(
  'views',
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid('project_id'),
    name: text('name').notNull(),
    description: text('description'),
    icon: text('icon'),
    kql: text('kql').notNull().default(''),
    layout: text('layout').notNull().default('list'),
    display: jsonObject('display'),
    filters: jsonObject('filters'),
    visibility: text('visibility').notNull().default('private'),
    ownerId: uuid('owner_id'),
    builtin: boolean('builtin').notNull().default(false),
    order: integer('order').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('views_ws_idx').on(t.workspaceId, t.projectId, t.order)],
)

/** Sidebar pinning is per user, so it cannot live on the shared view row. */
export const viewPins = schema.table(
  'view_pins',
  {
    viewId: uuid('view_id').notNull(),
    workspaceId: ws(),
    userId: uuid('user_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.viewId, t.userId] }),
    index('view_pins_ws_user_idx').on(t.workspaceId, t.userId),
  ],
)

export const worklogs = schema.table(
  'worklogs',
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid('project_id').notNull(),
    issueId: uuid('issue_id').notNull(),
    userId: uuid('user_id').notNull(),
    startedAt: ts('started_at').notNull().defaultNow(),
    durationSec: integer('duration_sec').notNull(),
    note: text('note'),
    billable: boolean('billable').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('worklogs_issue_idx').on(t.issueId, t.startedAt),
    index('worklogs_ws_user_started_idx').on(t.workspaceId, t.userId, t.startedAt),
    index('worklogs_project_started_idx').on(t.projectId, t.startedAt),
  ],
)

export const timers = schema.table(
  'timers',
  {
    id: id(),
    workspaceId: ws(),
    issueId: uuid('issue_id').notNull(),
    userId: uuid('user_id').notNull(),
    startedAt: ts('started_at').notNull().defaultNow(),
    note: text('note'),
  },
  (t) => [uniqueIndex('timers_ws_user_uq').on(t.workspaceId, t.userId)],
)

export const importJobs = schema.table(
  'import_jobs',
  {
    id: id(),
    workspaceId: ws(),
    projectId: uuid('project_id').notNull(),
    source: text('source').notNull(),
    fileId: uuid('file_id').notNull(),
    mapping: jsonObject('mapping'),
    status: text('status').notNull().default('pending'),
    progress: jsonObject('progress'),
    errors: jsonArray('errors'),
    createdBy: uuid('created_by'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('import_jobs_project_idx').on(t.projectId, t.createdAt)],
)

/** Every table protected by the workspace RLS policy (see migrations/0001_rls.sql). */
export const TENANT_TABLES = [
  'projects',
  'issue_counters',
  'project_members',
  'project_templates',
  'work_item_types',
  'type_schemes',
  'hierarchy_rules',
  'field_defs',
  'workflows',
  'workflow_schemes',
  'issues',
  'comments',
  'comment_reactions',
  'relations',
  'attachments',
  'links',
  'issue_history',
  'issue_status_history',
  'issue_approvals',
  'issue_templates',
  'recurring_issues',
  'cycles',
  'milestones',
  'versions',
  'components',
  'labels',
  'views',
  'view_pins',
  'worklogs',
  'timers',
  'import_jobs',
] as const
