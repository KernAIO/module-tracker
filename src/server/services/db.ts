import type { Kernel, Tx } from '@kernhq/kernel'
import type { StatusCategory, WorkflowDefinition } from '@kernhq/workflow'
import type {
  Attachment,
  Comment,
  Component,
  Cycle,
  FieldDef,
  FieldScheme,
  ImportJob,
  Issue,
  IssueApproval,
  IssueHistoryEntry,
  IssueSummary,
  IssueTemplate,
  Label,
  Link,
  Milestone,
  Project,
  ProjectMember,
  ProjectSettings,
  ProjectTemplate,
  RecurringIssue,
  RelationSummary,
  SlaState,
  StatusHistoryEntry,
  Timer,
  TypeScheme,
  Version,
  View,
  ViewDisplay,
  Workflow,
  WorkflowScheme,
  WorkItemType,
  Worklog,
} from '../../contract/models.js'
import {
  ProjectSettings as ProjectSettingsSchema,
  ViewDisplay as ViewDisplaySchema,
} from '../../contract/models.js'
import type {
  attachments,
  comments,
  components,
  cycles,
  fieldDefs,
  fieldSchemes,
  importJobs,
  issueApprovals,
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
  timers,
  typeSchemes,
  versions,
  views,
  workflowSchemes,
  workflows,
  workItemTypes,
  worklogs,
} from '../schema.js'

export type ProjectRow = typeof projects.$inferSelect
export type ProjectMemberRow = typeof projectMembers.$inferSelect
export type ProjectTemplateRow = typeof projectTemplates.$inferSelect
export type WorkItemTypeRow = typeof workItemTypes.$inferSelect
export type TypeSchemeRow = typeof typeSchemes.$inferSelect
export type FieldDefRow = typeof fieldDefs.$inferSelect
export type FieldSchemeRow = typeof fieldSchemes.$inferSelect
export type WorkflowRow = typeof workflows.$inferSelect
export type WorkflowSchemeRow = typeof workflowSchemes.$inferSelect
export type IssueRow = typeof issues.$inferSelect
export type CommentRow = typeof comments.$inferSelect
export type AttachmentRow = typeof attachments.$inferSelect
export type LinkRow = typeof links.$inferSelect
export type CycleRow = typeof cycles.$inferSelect
export type MilestoneRow = typeof milestones.$inferSelect
export type VersionRow = typeof versions.$inferSelect
export type ComponentRow = typeof components.$inferSelect
export type LabelRow = typeof labels.$inferSelect
export type ViewRow = typeof views.$inferSelect
export type WorklogRow = typeof worklogs.$inferSelect
export type TimerRow = typeof timers.$inferSelect
export type ApprovalRow = typeof issueApprovals.$inferSelect
export type IssueTemplateRow = typeof issueTemplates.$inferSelect
export type RecurringIssueRow = typeof recurringIssues.$inferSelect
export type ImportJobRow = typeof importJobs.$inferSelect
export type HistoryRow = typeof issueHistory.$inferSelect
export type StatusHistoryRow = typeof issueStatusHistory.$inferSelect

export const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString()
export const isoReq = (d: Date | string): string => iso(d)!

/** Run `fn` inside a transaction with RLS bound to one workspace. */
export const withWs = <T>(
  kernel: Kernel,
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
  userId?: string | null,
): Promise<T> => kernel.database.withWorkspace(workspaceId, fn, { userId: userId ?? null })

const asId = <T>(v: string | null): T => v as unknown as T
const asIds = <T>(v: string[] | null | undefined): T[] => (v ?? []) as unknown as T[]

export const EMPTY_RELATION_SUMMARY: RelationSummary = {
  blocks: 0,
  blockedBy: 0,
  openBlockers: 0,
  relates: 0,
  duplicates: 0,
  subItems: 0,
  subItemsDone: 0,
}

// =====================================================================================
// mappers
// =====================================================================================

export interface ProjectCounters {
  issueCounter: number
  cycleCounter: number
  openIssueCount: number
}

export function toProject(r: ProjectRow, counters: Partial<ProjectCounters> = {}): Project {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    key: r.key,
    name: r.name,
    description: r.description,
    icon: r.icon,
    color: r.color,
    leadId: asId(r.leadId),
    visibility: r.visibility as Project['visibility'],
    defaultAssignee: r.defaultAssignee as Project['defaultAssignee'],
    workflowSchemeId: r.workflowSchemeId,
    typeSchemeId: r.typeSchemeId,
    fieldSchemeId: r.fieldSchemeId,
    settings: parseSettings(r.settings),
    intakeToken: r.intakeToken,
    issueCounter: counters.issueCounter ?? 0,
    cycleCounter: counters.cycleCounter ?? 0,
    memberCount: r.memberCount,
    openIssueCount: counters.openIssueCount ?? 0,
    archivedAt: iso(r.archivedAt),
    createdBy: asId(r.createdBy),
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

/** Settings are stored as written; parsing fills in defaults added since the row was saved. */
export const parseSettings = (raw: unknown): ProjectSettings =>
  ProjectSettingsSchema.parse((raw as Record<string, unknown>) ?? {})

export const parseDisplay = (raw: unknown): ViewDisplay =>
  ViewDisplaySchema.parse((raw as Record<string, unknown>) ?? {})

export function toProjectMember(r: ProjectMemberRow): ProjectMember {
  return {
    projectId: r.projectId,
    userId: asId(r.userId),
    role: r.role as ProjectMember['role'],
    addedBy: asId(r.addedBy),
    addedAt: isoReq(r.addedAt),
  }
}

export function toProjectTemplate(r: ProjectTemplateRow): ProjectTemplate {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    key: r.key,
    name: r.name,
    description: r.description,
    icon: r.icon,
    body: (r.body as Record<string, unknown>) ?? {},
    builtin: r.builtin,
    createdAt: isoReq(r.createdAt),
  }
}

export function toWorkItemType(r: WorkItemTypeRow): WorkItemType {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    projectId: r.projectId,
    key: r.key,
    name: r.name,
    description: r.description,
    icon: r.icon,
    color: r.color,
    level: r.level,
    isDefault: r.isDefault,
    workflowId: r.workflowId,
    fieldLayout: (r.fieldLayout as WorkItemType['fieldLayout']) ?? [],
    templateBody: (r.templateBody as WorkItemType['templateBody']) ?? null,
    order: r.order,
    archivedAt: iso(r.archivedAt),
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

export function toTypeScheme(r: TypeSchemeRow): TypeScheme {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    name: r.name,
    typeIds: r.typeIds ?? [],
    defaultTypeId: r.defaultTypeId,
    createdAt: isoReq(r.createdAt),
  }
}

export function toFieldDef(r: FieldDefRow): FieldDef {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    projectId: r.projectId,
    key: r.key,
    name: r.name,
    description: r.description,
    type: r.type as FieldDef['type'],
    options: (r.options as FieldDef['options']) ?? [],
    defaultValue: r.defaultValue ?? null,
    config: (r.config as FieldDef['config']) ?? {},
    searchable: r.searchable,
    required: r.required,
    showInCards: r.showInCards,
    order: r.order,
    archivedAt: iso(r.archivedAt),
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

export function toFieldScheme(r: FieldSchemeRow): FieldScheme {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    name: r.name,
    fieldIds: r.fieldIds ?? [],
    createdAt: isoReq(r.createdAt),
  }
}

export function toWorkflow(r: WorkflowRow, usageCount?: number): Workflow {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    projectId: r.projectId,
    name: r.name,
    description: r.description,
    definition: r.definition as WorkflowDefinition,
    isDefault: r.isDefault,
    ...(usageCount === undefined ? {} : { usageCount }),
    archivedAt: iso(r.archivedAt),
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

export function toWorkflowScheme(r: WorkflowSchemeRow): WorkflowScheme {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    name: r.name,
    defaultWorkflowId: r.defaultWorkflowId,
    mappings: (r.mappings as WorkflowScheme['mappings']) ?? [],
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

export function toIssue(r: IssueRow, relationSummary: RelationSummary = EMPTY_RELATION_SUMMARY): Issue {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    projectId: r.projectId,
    key: r.key,
    number: r.number,
    typeId: r.typeId,
    title: r.title,
    description: (r.description as Issue['description']) ?? null,
    descriptionText: r.descriptionText,
    statusId: r.statusId,
    statusCategory: r.statusCategory as StatusCategory,
    priority: r.priority as Issue['priority'],
    assigneeIds: asIds(r.assigneeIds),
    reporterId: asId(r.reporterId),
    creatorId: asId(r.creatorId),
    labelIds: r.labelIds ?? [],
    componentIds: r.componentIds ?? [],
    versionIds: r.versionIds ?? [],
    affectsVersionIds: r.affectsVersionIds ?? [],
    cycleId: r.cycleId,
    milestoneId: r.milestoneId,
    parentId: r.parentId,
    rank: r.rank,
    estimate: r.estimate,
    estimateUnit: r.estimateUnit as Issue['estimateUnit'],
    startDate: r.startDate,
    dueDate: r.dueDate,
    completedAt: iso(r.completedAt),
    cancelledAt: iso(r.cancelledAt),
    resolution: r.resolution,
    custom: (r.custom as Record<string, unknown>) ?? {},
    watcherIds: asIds(r.watcherIds),
    subscriberCount: (r.watcherIds ?? []).length,
    commentCount: r.commentCount,
    attachmentCount: r.attachmentCount,
    relationSummary,
    timeSpentSec: r.timeSpentSec,
    remainingSec: r.remainingSec,
    originalEstimateSec: r.originalEstimateSec,
    sla: (r.sla as SlaState | null) ?? null,
    triage: r.triage,
    snoozedUntil: iso(r.snoozedUntil),
    source: r.source as Issue['source'],
    externalRef: r.externalRef,
    chatChannelId: r.chatChannelId,
    archivedAt: iso(r.archivedAt),
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
    lastActivityAt: isoReq(r.lastActivityAt),
  }
}

export const toIssueSummary = (issue: Issue): IssueSummary => ({
  id: issue.id,
  workspaceId: issue.workspaceId,
  projectId: issue.projectId,
  key: issue.key,
  number: issue.number,
  typeId: issue.typeId,
  title: issue.title,
  statusId: issue.statusId,
  statusCategory: issue.statusCategory,
  priority: issue.priority,
  assigneeIds: issue.assigneeIds,
  labelIds: issue.labelIds,
  cycleId: issue.cycleId,
  parentId: issue.parentId,
  rank: issue.rank,
  estimate: issue.estimate,
  dueDate: issue.dueDate,
  startDate: issue.startDate,
  triage: issue.triage,
  archivedAt: issue.archivedAt,
  updatedAt: issue.updatedAt,
})

export function toComment(r: CommentRow, reactions: Comment['reactions'] = []): Comment {
  const deleted = r.deletedAt != null
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    issueId: r.issueId,
    parentId: r.parentId,
    authorId: asId(r.authorId),
    body: deleted ? { type: 'doc', content: [] } : ((r.body as Comment['body']) ?? { type: 'doc' }),
    bodyText: deleted ? '' : r.bodyText,
    mentionIds: asIds(r.mentionIds),
    reactions,
    internal: r.internal,
    source: r.source as Comment['source'],
    replyCount: r.replyCount,
    editedAt: iso(r.editedAt),
    deletedAt: iso(r.deletedAt),
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

export function toAttachment(r: AttachmentRow): Attachment {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    issueId: r.issueId,
    fileId: r.fileId,
    name: r.name,
    mimeType: r.mimeType,
    size: r.size,
    uploadedBy: asId(r.uploadedBy),
    createdAt: isoReq(r.createdAt),
  }
}

export function toLink(r: LinkRow): Link {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    issueId: r.issueId,
    url: r.url,
    title: r.title,
    kind: r.kind,
    createdBy: asId(r.createdBy),
    createdAt: isoReq(r.createdAt),
  }
}

export interface CycleStats {
  total: number
  done: number
  estimateTotal: number
  estimateDone: number
}
export const EMPTY_CYCLE_STATS: CycleStats = { total: 0, done: 0, estimateTotal: 0, estimateDone: 0 }

export function toCycle(r: CycleRow, stats: CycleStats = EMPTY_CYCLE_STATS): Cycle {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    projectId: r.projectId,
    number: r.number,
    name: r.name,
    goal: r.goal,
    startAt: isoReq(r.startAt),
    endAt: isoReq(r.endAt),
    status: r.status as Cycle['status'],
    startedAt: iso(r.startedAt),
    completedAt: iso(r.completedAt),
    carryOverCount: r.carryOverCount,
    stats,
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

export function toMilestone(r: MilestoneRow, stats = { total: 0, done: 0 }): Milestone {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    projectId: r.projectId,
    name: r.name,
    description: r.description,
    targetDate: r.targetDate,
    status: r.status as Milestone['status'],
    stats,
    completedAt: iso(r.completedAt),
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

export function toVersion(r: VersionRow, stats = { total: 0, done: 0 }): Version {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    projectId: r.projectId,
    name: r.name,
    description: r.description,
    status: r.status as Version['status'],
    startDate: r.startDate,
    releaseDate: r.releaseDate,
    releasedAt: iso(r.releasedAt),
    stats,
    order: r.order,
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

export function toComponent(r: ComponentRow, issueCount = 0): Component {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    projectId: r.projectId,
    name: r.name,
    description: r.description,
    leadId: asId(r.leadId),
    defaultAssignee: r.defaultAssignee as Component['defaultAssignee'],
    issueCount,
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

export function toLabel(r: LabelRow, issueCount = 0): Label {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    projectId: r.projectId,
    name: r.name,
    color: r.color,
    description: r.description,
    groupName: r.groupName,
    issueCount,
    archivedAt: iso(r.archivedAt),
    createdAt: isoReq(r.createdAt),
  }
}

export function toView(r: ViewRow, pinned: boolean): View {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    projectId: r.projectId,
    name: r.name,
    description: r.description,
    icon: r.icon,
    kql: r.kql,
    layout: r.layout as View['layout'],
    display: parseDisplay(r.display),
    filters: (r.filters as Record<string, unknown>) ?? {},
    visibility: r.visibility as View['visibility'],
    ownerId: asId(r.ownerId),
    pinned,
    builtin: r.builtin,
    order: r.order,
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

export function toWorklog(r: WorklogRow): Worklog {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    projectId: r.projectId,
    issueId: r.issueId,
    userId: asId(r.userId),
    startedAt: isoReq(r.startedAt),
    durationSec: r.durationSec,
    note: r.note,
    billable: r.billable,
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

export function toTimer(r: TimerRow): Timer {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    issueId: r.issueId,
    userId: asId(r.userId),
    startedAt: isoReq(r.startedAt),
    note: r.note,
  }
}

export function toApproval(r: ApprovalRow): IssueApproval {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    issueId: r.issueId,
    transitionId: r.transitionId,
    state: r.state as IssueApproval['state'],
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

export function toIssueTemplate(r: IssueTemplateRow): IssueTemplate {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    projectId: r.projectId,
    name: r.name,
    description: r.description,
    typeId: r.typeId,
    defaults: (r.defaults as IssueTemplate['defaults']) ?? {},
    subItems: (r.subItems as IssueTemplate['subItems']) ?? [],
    createdBy: asId(r.createdBy),
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

export function toRecurringIssue(r: RecurringIssueRow): RecurringIssue {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    projectId: r.projectId,
    name: r.name,
    rule: r.rule as RecurringIssue['rule'],
    defaults: (r.defaults as RecurringIssue['defaults']) ?? {},
    enabled: r.enabled,
    nextRunAt: iso(r.nextRunAt),
    lastRunAt: iso(r.lastRunAt),
    lastIssueId: r.lastIssueId,
    runCount: r.runCount,
    createdBy: asId(r.createdBy),
    createdAt: isoReq(r.createdAt),
    updatedAt: isoReq(r.updatedAt),
  }
}

export function toImportJob(r: ImportJobRow): ImportJob {
  return {
    id: r.id,
    workspaceId: asId(r.workspaceId),
    projectId: r.projectId,
    source: r.source as ImportJob['source'],
    fileId: r.fileId,
    mapping: (r.mapping as Record<string, unknown>) ?? {},
    status: r.status as ImportJob['status'],
    progress: (r.progress as ImportJob['progress']) ?? {
      total: 0,
      processed: 0,
      created: 0,
      skipped: 0,
      failed: 0,
    },
    errors: (r.errors as ImportJob['errors']) ?? [],
    createdBy: asId(r.createdBy),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    createdAt: isoReq(r.createdAt),
  }
}

export function toHistoryEntry(r: HistoryRow): IssueHistoryEntry {
  return {
    id: r.id,
    issueId: r.issueId,
    actorId: asId(r.actorId),
    action: r.action,
    changes: (r.changes as IssueHistoryEntry['changes']) ?? [],
    data: (r.data as Record<string, unknown>) ?? {},
    occurredAt: isoReq(r.occurredAt),
  }
}

export function toStatusHistoryEntry(r: StatusHistoryRow): StatusHistoryEntry {
  return {
    id: r.id,
    issueId: r.issueId,
    fromStatusId: r.fromStatusId,
    toStatusId: r.toStatusId,
    fromCategory: r.fromCategory as StatusCategory | null,
    toCategory: r.toCategory as StatusCategory,
    actorId: asId(r.actorId),
    transitionId: r.transitionId,
    durationSec: r.durationSec,
    occurredAt: isoReq(r.occurredAt),
  }
}

// =====================================================================================
// misc
// =====================================================================================

/** Machine key from a display name: `Story points` → `story_points`. */
export const machineKey = (name: string, fallback = 'field'): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'f$1')
    .slice(0, 48) || fallback

export const issueUrl = (key: string): string => `/tracker/issues/${key}`
export const projectUrl = (key: string): string => `/tracker/projects/${key}`

export const uniq = <T>(values: Iterable<T>): T[] => [...new Set(values)]

/** Difference between two arrays treated as sets, in `next` order. */
export const added = <T>(before: readonly T[], next: readonly T[]): T[] => {
  const set = new Set(before)
  return next.filter((v) => !set.has(v))
}
export const removed = <T>(before: readonly T[], next: readonly T[]): T[] => {
  const set = new Set(next)
  return before.filter((v) => !set.has(v))
}
