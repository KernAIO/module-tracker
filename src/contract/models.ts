import { Color, Id, Timestamp, UserId, WorkspaceId } from '@kernhq/contracts'
import { ApprovalState, StatusCategory, WorkflowDefinition } from '@kernhq/workflow'
import { z } from 'zod'

export const MODULE_ID = 'tracker'

// =====================================================================================
// shared scalars
// =====================================================================================

/** Project key: 2–10 uppercase letters/digits, starts with a letter (`KRN`, `OPS2`). */
export const ProjectKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, '2–10 uppercase letters/digits, starting with a letter')
export type ProjectKey = z.infer<typeof ProjectKey>

/** Issue key `KRN-123`. */
export const IssueKey = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d+$/, 'issue key like KRN-123')
export type IssueKey = z.infer<typeof IssueKey>

/** Machine key for types/fields/labels: lowercase snake, starts with a letter. */
export const MachineKey = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and underscores')
export type MachineKey = z.infer<typeof MachineKey>

/** Tiptap / ProseMirror JSON document. */
export const RichDoc = z
  .object({ type: z.literal('doc'), content: z.array(z.record(z.string(), z.unknown())).optional() })
  .catchall(z.unknown())
export type RichDoc = z.infer<typeof RichDoc>

/** `YYYY-MM-DD` calendar date (no time zone). */
export const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
export type DateOnly = z.infer<typeof DateOnly>

export const Priority = z.enum(['none', 'low', 'medium', 'high', 'urgent'])
export type Priority = z.infer<typeof Priority>
export const PRIORITY_ORDER: Record<Priority, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 }

export const EstimateUnit = z.enum(['points', 'hours', 'none'])
export type EstimateUnit = z.infer<typeof EstimateUnit>

export { ApprovalState, StatusCategory, WorkflowDefinition }

const ok = z.object({ ok: z.literal(true) })
export const Ok = ok

// =====================================================================================
// projects
// =====================================================================================

export const ProjectVisibility = z.enum(['workspace', 'private'])
export type ProjectVisibility = z.infer<typeof ProjectVisibility>

export const CycleSettings = z.object({
  enabled: z.boolean().default(false),
  lengthWeeks: z.number().int().min(1).max(8).default(2),
  /** days between cycles */
  cooldownDays: z.number().int().min(0).max(14).default(0),
  /** move unfinished issues to the next cycle when one completes */
  autoRoll: z.boolean().default(true),
  /** 0 = Sunday … 6 = Saturday */
  startDay: z.number().int().min(0).max(6).default(1),
  /** auto-create the next upcoming cycle so there is always one planned */
  autoCreateUpcoming: z.number().int().min(0).max(6).default(1),
})
export type CycleSettings = z.infer<typeof CycleSettings>

export const ProjectSettings = z.object({
  estimation: EstimateUnit.default('points'),
  /** allowed point values for the estimate picker (points only) */
  estimateScale: z.array(z.number()).default([0, 1, 2, 3, 5, 8, 13, 21]),
  cycles: CycleSettings.default({
    enabled: false,
    lengthWeeks: 2,
    cooldownDays: 0,
    autoRoll: true,
    startDay: 1,
    autoCreateUpcoming: 1,
  }),
  triage: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  sla: z
    .object({
      enabled: z.boolean().default(false),
      /** hours to first response / resolution per priority */
      goals: z
        .partialRecord(
          Priority,
          z.object({
            firstResponseHours: z.number().positive().optional(),
            resolveHours: z.number().positive().optional(),
          }),
        )
        .default({}),
      /** status categories during which the SLA clock is paused */
      pauseInCategories: z.array(StatusCategory).default(['backlog']),
    })
    .default({ enabled: false, goals: {}, pauseInCategories: ['backlog'] }),
  /** require a resolution when moving to a done-category status */
  requireResolution: z.boolean().default(false),
  /** per-issue chat channel created automatically on issue creation */
  autoCreateIssueChannel: z.boolean().default(false),
  /** timezone used for cycle boundaries / due dates */
  timezone: z.string().default('UTC'),
})
export type ProjectSettings = z.infer<typeof ProjectSettings>

export const Project = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  key: ProjectKey,
  name: z.string().min(1).max(120),
  description: z.string().max(4000).nullable(),
  icon: z.string().max(64).nullable(),
  color: Color.nullable(),
  leadId: UserId.nullable(),
  visibility: ProjectVisibility,
  defaultAssignee: z.enum(['unassigned', 'lead']),
  workflowSchemeId: Id.nullable(),
  typeSchemeId: Id.nullable(),
  settings: ProjectSettings,
  /** public intake form token (null = intake disabled) */
  intakeToken: z.string().nullable(),
  /** last allocated issue number */
  issueCounter: z.number().int().nonnegative(),
  /** last allocated cycle number */
  cycleCounter: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  openIssueCount: z.number().int().nonnegative(),
  archivedAt: Timestamp.nullable(),
  createdBy: UserId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Project = z.infer<typeof Project>

/**
 * The built-in project templates. `software`, `support`, `marketing` and `simple` are the four
 * team shapes the tracker ships with; `kanban` and `blank` are kept because existing projects were
 * created from them.
 */
export const ProjectTemplateId = z.enum(['software', 'support', 'marketing', 'simple', 'kanban', 'blank'])
export type ProjectTemplateId = z.infer<typeof ProjectTemplateId>

export const CreateProject = z.object({
  key: ProjectKey,
  name: z.string().min(1).max(120),
  description: z.string().max(4000).optional(),
  icon: z.string().max(64).optional(),
  color: Color.optional(),
  leadId: UserId.optional(),
  visibility: ProjectVisibility.default('workspace'),
  defaultAssignee: z.enum(['unassigned', 'lead']).default('unassigned'),
  /** seed types/workflow/fields from a built-in template */
  template: ProjectTemplateId.default('software'),
  /** or from a saved project template (overrides `template`) */
  templateId: Id.optional(),
  settings: ProjectSettings.partial().optional(),
  memberIds: z.array(UserId).max(500).default([]),
})
export type CreateProject = z.infer<typeof CreateProject>

export const UpdateProject = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(4000).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  color: Color.nullable().optional(),
  leadId: UserId.nullable().optional(),
  visibility: ProjectVisibility.optional(),
  defaultAssignee: z.enum(['unassigned', 'lead']).optional(),
  workflowSchemeId: Id.nullable().optional(),
  typeSchemeId: Id.nullable().optional(),
  settings: ProjectSettings.partial().optional(),
})
export type UpdateProject = z.infer<typeof UpdateProject>

/** Project member: a user with a project role (mirrored as kernel authz binding at scope `project`). */
export const ProjectRole = z.enum(['admin', 'member', 'viewer'])
export type ProjectRole = z.infer<typeof ProjectRole>
export const ProjectMember = z.object({
  projectId: Id,
  userId: UserId,
  role: ProjectRole,
  addedBy: UserId.nullable(),
  addedAt: Timestamp,
})
export type ProjectMember = z.infer<typeof ProjectMember>

// =====================================================================================
// work item types & hierarchy
// =====================================================================================

/** -1 sub-item · 0 standard (task/bug/story) · 1 epic · 2 initiative. */
export const HierarchyLevel = z.number().int().min(-1).max(2)
export type HierarchyLevel = z.infer<typeof HierarchyLevel>

/**
 * The system fields a work item type may lay out, in their default order.
 *
 * `pinned` fields are always visible: an issue without a title, a status or a type is not an
 * issue. The settings editor does not offer the control, and the resolver ignores a stored
 * instruction that tries to hide one.
 */
export const SYSTEM_LAYOUT_FIELDS = [
  { id: 'title', section: 'main', pinned: true },
  { id: 'description', section: 'main', pinned: false },
  { id: 'status', section: 'sidebar', pinned: true },
  { id: 'type', section: 'sidebar', pinned: true },
  { id: 'assignees', section: 'sidebar', pinned: false },
  { id: 'priority', section: 'sidebar', pinned: false },
  { id: 'labels', section: 'sidebar', pinned: false },
  { id: 'components', section: 'sidebar', pinned: false },
  { id: 'versions', section: 'sidebar', pinned: false },
  { id: 'estimate', section: 'sidebar', pinned: false },
  { id: 'startDate', section: 'sidebar', pinned: false },
  { id: 'dueDate', section: 'sidebar', pinned: false },
  { id: 'cycle', section: 'sidebar', pinned: false },
  { id: 'milestone', section: 'sidebar', pinned: false },
  { id: 'parent', section: 'sidebar', pinned: false },
  { id: 'reporter', section: 'sidebar', pinned: false },
] as const satisfies ReadonlyArray<{
  id: string
  section: 'main' | 'sidebar'
  pinned: boolean
}>

export const SystemFieldId = z.enum(SYSTEM_LAYOUT_FIELDS.map((f) => f.id) as [string, ...string[]])
export type SystemFieldId = (typeof SYSTEM_LAYOUT_FIELDS)[number]['id']

/** System field ids that may never be hidden, whatever a stored layout says. */
export const PINNED_FIELD_IDS: readonly string[] = SYSTEM_LAYOUT_FIELDS.filter((f) => f.pinned).map(
  (f) => f.id,
)

/**
 * A layout entry's `fieldId` is a *namespaced* name: a system field id (`priority`, `dueDate`) or
 * `cf.<key>` for a custom field. That is the same string KQL, `ViewDisplay.columns` and workflow
 * post-functions already use, so one resolver serves all four.
 */
export const LayoutFieldId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^(?:[a-zA-Z][a-zA-Z0-9_]*|cf\.[a-z][a-z0-9_]*)$/, 'Expected a system field id or `cf.<key>`')
export type LayoutFieldId = z.infer<typeof LayoutFieldId>

export const FieldLayoutItem = z.object({
  /** system field id (`priority`, `dueDate`…) or `cf.<key>` for a custom field */
  fieldId: LayoutFieldId,
  section: z.enum(['main', 'sidebar', 'hidden']).default('sidebar'),
  /** required on this type, over and above the field definition's own `required` */
  required: z.boolean().default(false),
  hidden: z.boolean().default(false),
  order: z.number().int().default(0),
})
export type FieldLayoutItem = z.infer<typeof FieldLayoutItem>
export const WorkItemType = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  /** null = workspace-level type shared by all projects */
  projectId: Id.nullable(),
  key: MachineKey,
  name: z.string().min(1).max(60),
  description: z.string().max(500).nullable(),
  icon: z.string().max(64).nullable(),
  color: Color.nullable(),
  level: HierarchyLevel,
  isDefault: z.boolean(),
  /** explicit workflow; null → project's workflow scheme / default workflow */
  workflowId: Id.nullable(),
  fieldLayout: z.array(FieldLayoutItem),
  /** default description for new items of this type */
  templateBody: RichDoc.nullable(),
  order: z.number().int(),
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type WorkItemType = z.infer<typeof WorkItemType>

export const UpsertWorkItemType = WorkItemType.pick({
  key: true,
  name: true,
  level: true,
}).extend({
  projectId: Id.nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  color: Color.nullable().optional(),
  isDefault: z.boolean().optional(),
  workflowId: Id.nullable().optional(),
  fieldLayout: z.array(FieldLayoutItem).optional(),
  templateBody: RichDoc.nullable().optional(),
  order: z.number().int().optional(),
})
export type UpsertWorkItemType = z.infer<typeof UpsertWorkItemType>

/** Which levels may parent which: stored per workspace; default: 2→1→0→-1 (strict) with `allowSkip`. */
export const HierarchyRules = z.object({
  /** allow e.g. an initiative (2) to directly parent a task (0) */
  allowSkipLevels: z.boolean().default(true),
  /** allow same-level parenting (task under task) */
  allowSameLevel: z.boolean().default(false),
  /** max depth of nested sub-items */
  maxSubItemDepth: z.number().int().min(1).max(5).default(1),
})
export type HierarchyRules = z.infer<typeof HierarchyRules>

/** Type scheme: which types a project uses (+ default) – null projectTypeIds = all workspace types. */
export const TypeScheme = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  name: z.string().min(1).max(120),
  typeIds: z.array(Id),
  defaultTypeId: Id.nullable(),
  createdAt: Timestamp,
})
export type TypeScheme = z.infer<typeof TypeScheme>

// =====================================================================================
// custom fields
// =====================================================================================

export const FieldType = z.enum([
  'text',
  'textarea',
  'number',
  'date',
  'datetime',
  'select',
  'multiselect',
  'user',
  'multiuser',
  'label',
  'url',
  'checkbox',
  'relation',
  'formula',
])
export type FieldType = z.infer<typeof FieldType>

export const FieldOption = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  color: Color.nullable().default(null),
  order: z.number().int().default(0),
  archived: z.boolean().default(false),
})
export type FieldOption = z.infer<typeof FieldOption>

/** Type-specific configuration. */
export const FieldConfig = z
  .object({
    /** number */
    min: z.number().optional(),
    max: z.number().optional(),
    precision: z.number().int().min(0).max(6).optional(),
    unit: z.string().max(16).optional(),
    /** text */
    maxLength: z.number().int().positive().optional(),
    pattern: z.string().max(200).optional(),
    /** relation: restrict to item types/projects */
    relationTypeIds: z.array(Id).optional(),
    relationProjectIds: z.array(Id).optional(),
    relationMultiple: z.boolean().optional(),
    /** formula: expression over other fields, e.g. `{estimate} * 2` or `daysBetween({startDate},{dueDate})` */
    formula: z.string().max(500).optional(),
    formulaResult: z.enum(['number', 'text', 'date', 'boolean']).optional(),
    /** datetime/date: include time-of-day */
    includeTime: z.boolean().optional(),
  })
  .catchall(z.unknown())
export type FieldConfig = z.infer<typeof FieldConfig>

export const FieldDef = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  /** null = workspace-level (available to all projects) */
  projectId: Id.nullable(),
  /** machine key, referenced in KQL as `cf.<key>` and in `issue.custom[key]` */
  key: MachineKey,
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable(),
  type: FieldType,
  options: z.array(FieldOption),
  defaultValue: z.unknown().nullable(),
  config: FieldConfig,
  searchable: z.boolean(),
  required: z.boolean(),
  /** show in list/board cards by default */
  showInCards: z.boolean(),
  order: z.number().int(),
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type FieldDef = z.infer<typeof FieldDef>

export const UpsertFieldDef = z.object({
  projectId: Id.nullable().optional(),
  key: MachineKey,
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  type: FieldType,
  options: z.array(FieldOption).optional(),
  defaultValue: z.unknown().nullable().optional(),
  config: FieldConfig.optional(),
  searchable: z.boolean().optional(),
  required: z.boolean().optional(),
  showInCards: z.boolean().optional(),
  order: z.number().int().optional(),
})
export type UpsertFieldDef = z.infer<typeof UpsertFieldDef>

/** One field as an interface should render it, system and custom fields alike. */
export const ResolvedField = z.object({
  fieldId: LayoutFieldId,
  /** `system` fields are rendered by a built-in component, `custom` ones by their field type */
  kind: z.enum(['system', 'custom']),
  label: z.string().min(1).max(120),
  section: z.enum(['main', 'sidebar']),
  order: z.number().int(),
  required: z.boolean(),
  pinned: z.boolean(),
  showInCards: z.boolean(),
  /** present when `kind` is `custom` — everything needed to render and validate the value */
  field: FieldDef.nullable(),
})
export type ResolvedField = z.infer<typeof ResolvedField>

/**
 * The fields of one work item type in one project, already ordered and merged.
 *
 * An **empty stored layout means the default layout** — everything visible. A field the stored
 * layout does not name appends to `sidebar` rather than disappearing, so a newly created field
 * shows up instead of looking broken.
 */
export const ResolvedLayout = z.object({
  typeId: Id,
  projectId: Id.nullable(),
  main: z.array(ResolvedField),
  sidebar: z.array(ResolvedField),
  hidden: z.array(ResolvedField),
})
export type ResolvedLayout = z.infer<typeof ResolvedLayout>

// =====================================================================================
// workflows
// =====================================================================================

export const Workflow = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  /** null = workspace-level workflow available to all projects */
  projectId: Id.nullable(),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable(),
  definition: WorkflowDefinition,
  isDefault: z.boolean(),
  /** number of issues currently using it (computed) */
  usageCount: z.number().int().nonnegative().optional(),
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Workflow = z.infer<typeof Workflow>

export const UpsertWorkflow = z.object({
  projectId: Id.nullable().optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  definition: WorkflowDefinition,
  isDefault: z.boolean().optional(),
})
export type UpsertWorkflow = z.infer<typeof UpsertWorkflow>

/** Maps item types to workflows for a project (typeId → workflowId; `defaultWorkflowId` otherwise). */
export const WorkflowScheme = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  name: z.string().min(1).max(120),
  defaultWorkflowId: Id,
  mappings: z.array(z.object({ typeId: Id, workflowId: Id })),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type WorkflowScheme = z.infer<typeof WorkflowScheme>
export const UpsertWorkflowScheme = WorkflowScheme.pick({
  name: true,
  defaultWorkflowId: true,
  mappings: true,
})

/** One status as exposed to the UI together with the workflow it belongs to. */
export const StatusInfo = z.object({
  id: z.string(),
  name: z.string(),
  category: StatusCategory,
  color: z.string().nullable(),
  order: z.number().int(),
  workflowId: Id,
})
export type StatusInfo = z.infer<typeof StatusInfo>

/** Available transition for an issue, as seen by the UI. */
export const AvailableTransition = z.object({
  id: z.string(),
  name: z.string(),
  toStatusId: z.string(),
  toStatus: StatusInfo,
  allowed: z.boolean(),
  reasons: z.array(z.object({ kind: z.string(), message: z.string(), field: z.string().optional() })),
  requiresApproval: z.boolean(),
  screen: z.object({ fields: z.array(z.string()), comment: z.boolean() }).nullable(),
  hidden: z.boolean(),
})
export type AvailableTransition = z.infer<typeof AvailableTransition>

// =====================================================================================
// issues
// =====================================================================================

export const RelationType = z.enum([
  'blocks',
  'blocked_by',
  'relates',
  'duplicates',
  'duplicated_by',
  'clones',
  'cloned_by',
])
export type RelationType = z.infer<typeof RelationType>
/** inverse relation for the other side */
export const RELATION_INVERSE: Record<RelationType, RelationType> = {
  blocks: 'blocked_by',
  blocked_by: 'blocks',
  relates: 'relates',
  duplicates: 'duplicated_by',
  duplicated_by: 'duplicates',
  clones: 'cloned_by',
  cloned_by: 'clones',
}

export const RelationSummary = z.object({
  blocks: z.number().int().nonnegative(),
  blockedBy: z.number().int().nonnegative(),
  /** blockers that are still open */
  openBlockers: z.number().int().nonnegative(),
  relates: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  subItems: z.number().int().nonnegative(),
  subItemsDone: z.number().int().nonnegative(),
})
export type RelationSummary = z.infer<typeof RelationSummary>

export const SlaState = z.object({
  firstResponseDueAt: Timestamp.nullable(),
  firstRespondedAt: Timestamp.nullable(),
  resolveDueAt: Timestamp.nullable(),
  pausedAt: Timestamp.nullable(),
  /** total paused seconds */
  pausedSec: z.number().int().nonnegative(),
  breached: z.boolean(),
})
export type SlaState = z.infer<typeof SlaState>

export const Issue = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  projectId: Id,
  key: IssueKey,
  number: z.number().int().positive(),
  typeId: Id,
  title: z.string().min(1).max(500),
  description: RichDoc.nullable(),
  /** plain-text rendering of description (search, previews) */
  descriptionText: z.string(),
  statusId: z.string(),
  statusCategory: StatusCategory,
  priority: Priority,
  assigneeIds: z.array(UserId),
  reporterId: UserId.nullable(),
  creatorId: UserId.nullable(),
  /** label ids */
  labelIds: z.array(Id),
  componentIds: z.array(Id),
  /** fix versions */
  versionIds: z.array(Id),
  affectsVersionIds: z.array(Id),
  cycleId: Id.nullable(),
  milestoneId: Id.nullable(),
  parentId: Id.nullable(),
  /** fractional index for manual ordering (backlog / board) */
  rank: z.string(),
  estimate: z.number().nullable(),
  estimateUnit: EstimateUnit,
  startDate: DateOnly.nullable(),
  dueDate: DateOnly.nullable(),
  completedAt: Timestamp.nullable(),
  cancelledAt: Timestamp.nullable(),
  resolution: z.string().max(64).nullable(),
  /** custom field values keyed by field key */
  custom: z.record(z.string(), z.unknown()),
  watcherIds: z.array(UserId),
  subscriberCount: z.number().int().nonnegative(),
  commentCount: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
  relationSummary: RelationSummary,
  timeSpentSec: z.number().int().nonnegative(),
  remainingSec: z.number().int().nonnegative().nullable(),
  originalEstimateSec: z.number().int().nonnegative().nullable(),
  sla: SlaState.nullable(),
  triage: z.boolean(),
  /** hidden from the triage queue until this time */
  snoozedUntil: Timestamp.nullable(),
  /** external origin: email/intake/import */
  source: z.enum(['app', 'email', 'intake', 'import', 'api', 'automation', 'recurring']),
  /** external reference (email message id, jira key…) */
  externalRef: z.string().nullable(),
  /** per-issue chat channel id once opened */
  chatChannelId: Id.nullable(),
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastActivityAt: Timestamp,
})
export type Issue = z.infer<typeof Issue>

/** Lightweight issue for lists/boards/pickers. */
export const IssueSummary = Issue.pick({
  id: true,
  workspaceId: true,
  projectId: true,
  key: true,
  number: true,
  typeId: true,
  title: true,
  statusId: true,
  statusCategory: true,
  priority: true,
  assigneeIds: true,
  labelIds: true,
  cycleId: true,
  parentId: true,
  rank: true,
  estimate: true,
  dueDate: true,
  startDate: true,
  triage: true,
  archivedAt: true,
  updatedAt: true,
})
export type IssueSummary = z.infer<typeof IssueSummary>

/** Fields an issue may be created with. */
export const CreateIssue = z.object({
  projectId: Id,
  typeId: Id.optional(),
  title: z.string().min(1).max(500),
  description: RichDoc.nullable().optional(),
  statusId: z.string().optional(),
  priority: Priority.optional(),
  assigneeIds: z.array(UserId).max(20).optional(),
  reporterId: UserId.optional(),
  labelIds: z.array(Id).max(50).optional(),
  componentIds: z.array(Id).max(20).optional(),
  versionIds: z.array(Id).max(20).optional(),
  affectsVersionIds: z.array(Id).max(20).optional(),
  cycleId: Id.nullable().optional(),
  milestoneId: Id.nullable().optional(),
  parentId: Id.nullable().optional(),
  estimate: z.number().nullable().optional(),
  startDate: DateOnly.nullable().optional(),
  dueDate: DateOnly.nullable().optional(),
  originalEstimateSec: z.number().int().nonnegative().nullable().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
  watcherIds: z.array(UserId).optional(),
  triage: z.boolean().optional(),
  /** issue template to apply first */
  templateId: Id.optional(),
  /** place relative to another issue in rank order */
  rankAfterId: Id.optional(),
  rankBeforeId: Id.optional(),
  /** core file ids to attach */
  attachmentIds: z.array(Id).max(50).optional(),
})
export type CreateIssue = z.infer<typeof CreateIssue>

/** Patch for update/bulk-update. `null` clears nullable fields. Arrays replace unless `*Add/*Remove` used. */
export const UpdateIssue = z.object({
  typeId: Id.optional(),
  title: z.string().min(1).max(500).optional(),
  description: RichDoc.nullable().optional(),
  priority: Priority.optional(),
  assigneeIds: z.array(UserId).max(20).optional(),
  assigneeAdd: z.array(UserId).optional(),
  assigneeRemove: z.array(UserId).optional(),
  reporterId: UserId.nullable().optional(),
  labelIds: z.array(Id).max(50).optional(),
  labelAdd: z.array(Id).optional(),
  labelRemove: z.array(Id).optional(),
  componentIds: z.array(Id).max(20).optional(),
  versionIds: z.array(Id).max(20).optional(),
  affectsVersionIds: z.array(Id).max(20).optional(),
  cycleId: Id.nullable().optional(),
  milestoneId: Id.nullable().optional(),
  parentId: Id.nullable().optional(),
  estimate: z.number().nullable().optional(),
  startDate: DateOnly.nullable().optional(),
  dueDate: DateOnly.nullable().optional(),
  resolution: z.string().max(64).nullable().optional(),
  originalEstimateSec: z.number().int().nonnegative().nullable().optional(),
  remainingSec: z.number().int().nonnegative().nullable().optional(),
  /** merged into existing custom values; `null` value removes a key */
  custom: z.record(z.string(), z.unknown()).optional(),
  triage: z.boolean().optional(),
})
export type UpdateIssue = z.infer<typeof UpdateIssue>

export const BulkResult = z.object({
  results: z.array(
    z.object({
      id: Id,
      ok: z.boolean(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    }),
  ),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
})
export type BulkResult = z.infer<typeof BulkResult>

/** Activity/history entry for an issue (projection of core activity + status history). */
export const IssueHistoryEntry = z.object({
  id: Id,
  issueId: Id,
  actorId: UserId.nullable(),
  action: z.string(),
  changes: z.array(z.object({ field: z.string(), from: z.unknown(), to: z.unknown() })),
  data: z.record(z.string(), z.unknown()),
  occurredAt: Timestamp,
})
export type IssueHistoryEntry = z.infer<typeof IssueHistoryEntry>

export const StatusHistoryEntry = z.object({
  id: Id,
  issueId: Id,
  fromStatusId: z.string().nullable(),
  toStatusId: z.string(),
  fromCategory: StatusCategory.nullable(),
  toCategory: StatusCategory,
  actorId: UserId.nullable(),
  transitionId: z.string().nullable(),
  /** seconds spent in the previous status */
  durationSec: z.number().int().nonnegative().nullable(),
  occurredAt: Timestamp,
})
export type StatusHistoryEntry = z.infer<typeof StatusHistoryEntry>

// ---------- comments ----------

export const ReactionSummary = z.object({
  emoji: z.string(),
  count: z.number().int(),
  userIds: z.array(UserId),
})
export type ReactionSummary = z.infer<typeof ReactionSummary>

export const Comment = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  issueId: Id,
  /** threaded reply */
  parentId: Id.nullable(),
  authorId: UserId.nullable(),
  body: RichDoc,
  bodyText: z.string(),
  mentionIds: z.array(UserId),
  reactions: z.array(ReactionSummary),
  /** internal comments are hidden from portal/email requesters */
  internal: z.boolean(),
  /** comment created from an inbound email */
  source: z.enum(['app', 'email', 'automation', 'system']),
  replyCount: z.number().int().nonnegative(),
  editedAt: Timestamp.nullable(),
  deletedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Comment = z.infer<typeof Comment>

// ---------- relations / attachments / links ----------

export const Relation = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  type: RelationType,
  fromIssueId: Id,
  toIssueId: Id,
  createdBy: UserId.nullable(),
  createdAt: Timestamp,
})
export type Relation = z.infer<typeof Relation>

/** Relation as seen from one issue's perspective. */
export const RelationView = z.object({
  id: Id,
  type: RelationType,
  issue: IssueSummary,
  createdAt: Timestamp,
})
export type RelationView = z.infer<typeof RelationView>

export const Attachment = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  issueId: Id,
  /** the comment that introduced this file, if any — the issue lists it either way */
  commentId: Id.nullable(),
  /** core file id */
  fileId: Id,
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  uploadedBy: UserId.nullable(),
  createdAt: Timestamp,
})
export type Attachment = z.infer<typeof Attachment>

export const Link = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  issueId: Id,
  url: z.string().url(),
  title: z.string().max(300).nullable(),
  /** e.g. `github_pr`, `doc`, `generic` */
  kind: z.string().max(32),
  createdBy: UserId.nullable(),
  createdAt: Timestamp,
})
export type Link = z.infer<typeof Link>

// ---------- time tracking ----------

export const Worklog = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  projectId: Id,
  issueId: Id,
  userId: UserId,
  startedAt: Timestamp,
  durationSec: z.number().int().positive(),
  note: z.string().max(2000).nullable(),
  billable: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Worklog = z.infer<typeof Worklog>
export const UpsertWorklog = z.object({
  startedAt: Timestamp.optional(),
  durationSec: z.number().int().positive(),
  note: z.string().max(2000).nullable().optional(),
  billable: z.boolean().optional(),
  /** reduce remaining estimate by: auto (duration) | leave | set */
  adjustRemaining: z.enum(['auto', 'leave', 'set']).default('auto'),
  remainingSec: z.number().int().nonnegative().optional(),
})

export const Timer = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  issueId: Id,
  userId: UserId,
  startedAt: Timestamp,
  note: z.string().max(2000).nullable(),
})
export type Timer = z.infer<typeof Timer>

/** Timesheet cell: seconds per (user, issue/project, day). */
export const TimesheetRow = z.object({
  userId: UserId,
  projectId: Id,
  issueId: Id.nullable(),
  issueKey: z.string().nullable(),
  date: DateOnly,
  durationSec: z.number().int().nonnegative(),
  billableSec: z.number().int().nonnegative(),
})
export type TimesheetRow = z.infer<typeof TimesheetRow>

// ---------- templates / recurring ----------

export const IssueTemplate = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  projectId: Id.nullable(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  typeId: Id.nullable(),
  /** CreateIssue-shaped defaults (without projectId) */
  defaults: CreateIssue.omit({ projectId: true, templateId: true }).partial(),
  /** sub-items to create with the issue */
  subItems: z.array(z.object({ title: z.string().min(1).max(500), typeId: Id.optional() })),
  createdBy: UserId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type IssueTemplate = z.infer<typeof IssueTemplate>
export const UpsertIssueTemplate = IssueTemplate.pick({ name: true }).extend({
  projectId: Id.nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  typeId: Id.nullable().optional(),
  defaults: IssueTemplate.shape.defaults.optional(),
  subItems: IssueTemplate.shape.subItems.optional(),
})

/** Recurrence rule (simplified RRULE). */
export const RecurrenceRule = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(365).default(1),
  /** weekly: 0–6; monthly: day of month 1–31 */
  byWeekday: z.array(z.number().int().min(0).max(6)).optional(),
  byMonthDay: z.number().int().min(1).max(31).optional(),
  /** HH:mm in project timezone */
  at: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default('09:00'),
  until: Timestamp.nullable().optional(),
  count: z.number().int().positive().nullable().optional(),
})
export type RecurrenceRule = z.infer<typeof RecurrenceRule>

export const RecurringIssue = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  projectId: Id,
  name: z.string().min(1).max(120),
  rule: RecurrenceRule,
  /** template to instantiate (CreateIssue defaults) */
  defaults: IssueTemplate.shape.defaults,
  enabled: z.boolean(),
  nextRunAt: Timestamp.nullable(),
  lastRunAt: Timestamp.nullable(),
  lastIssueId: Id.nullable(),
  runCount: z.number().int().nonnegative(),
  createdBy: UserId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type RecurringIssue = z.infer<typeof RecurringIssue>
export const UpsertRecurringIssue = RecurringIssue.pick({ name: true, rule: true, defaults: true }).extend({
  enabled: z.boolean().optional(),
})

// =====================================================================================
// planning: cycles, milestones, versions, components, labels
// =====================================================================================

export const CycleStatus = z.enum(['upcoming', 'active', 'completed'])
export type CycleStatus = z.infer<typeof CycleStatus>

export const Cycle = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  projectId: Id,
  number: z.number().int().positive(),
  name: z.string().min(1).max(120),
  goal: z.string().max(2000).nullable(),
  startAt: Timestamp,
  endAt: Timestamp,
  status: CycleStatus,
  startedAt: Timestamp.nullable(),
  completedAt: Timestamp.nullable(),
  /** issues carried over from the previous cycle when this one started */
  carryOverCount: z.number().int().nonnegative(),
  /** snapshot of scope (estimate sum) at start / issue counts */
  stats: z.object({
    total: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    estimateTotal: z.number().nonnegative(),
    estimateDone: z.number().nonnegative(),
  }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Cycle = z.infer<typeof Cycle>
export const UpsertCycle = z.object({
  name: z.string().min(1).max(120).optional(),
  goal: z.string().max(2000).nullable().optional(),
  startAt: Timestamp,
  endAt: Timestamp,
})

export const Milestone = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  projectId: Id,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable(),
  targetDate: DateOnly.nullable(),
  status: z.enum(['open', 'completed', 'cancelled']),
  stats: z.object({ total: z.number().int().nonnegative(), done: z.number().int().nonnegative() }),
  completedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Milestone = z.infer<typeof Milestone>
export const UpsertMilestone = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  targetDate: DateOnly.nullable().optional(),
  status: z.enum(['open', 'completed', 'cancelled']).optional(),
})

export const VersionStatus = z.enum(['unreleased', 'released', 'archived'])
export type VersionStatus = z.infer<typeof VersionStatus>
export const Version = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  projectId: Id,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable(),
  status: VersionStatus,
  startDate: DateOnly.nullable(),
  releaseDate: DateOnly.nullable(),
  releasedAt: Timestamp.nullable(),
  stats: z.object({ total: z.number().int().nonnegative(), done: z.number().int().nonnegative() }),
  order: z.number().int(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Version = z.infer<typeof Version>
export const UpsertVersion = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  startDate: DateOnly.nullable().optional(),
  releaseDate: DateOnly.nullable().optional(),
  order: z.number().int().optional(),
})

export const Component = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  projectId: Id,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable(),
  leadId: UserId.nullable(),
  /** issues with this component default-assign to: none | lead | project default */
  defaultAssignee: z.enum(['none', 'lead', 'project']),
  issueCount: z.number().int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Component = z.infer<typeof Component>
export const UpsertComponent = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  leadId: UserId.nullable().optional(),
  defaultAssignee: z.enum(['none', 'lead', 'project']).optional(),
})

export const Label = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  /** null = workspace-level label */
  projectId: Id.nullable(),
  name: z.string().min(1).max(60),
  color: Color.nullable(),
  description: z.string().max(300).nullable(),
  /** label groups (Linear-style); labels in the same group are mutually exclusive */
  groupName: z.string().max(60).nullable(),
  issueCount: z.number().int().nonnegative(),
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
})
export type Label = z.infer<typeof Label>
export const UpsertLabel = z.object({
  projectId: Id.nullable().optional(),
  name: z.string().min(1).max(60),
  color: Color.nullable().optional(),
  description: z.string().max(300).nullable().optional(),
  groupName: z.string().max(60).nullable().optional(),
})

// =====================================================================================
// views & boards
// =====================================================================================

export const ViewLayout = z.enum(['list', 'board', 'calendar', 'timeline', 'spreadsheet'])
export type ViewLayout = z.infer<typeof ViewLayout>
export const ViewVisibility = z.enum(['private', 'project', 'workspace'])
export type ViewVisibility = z.infer<typeof ViewVisibility>

/** Group/sort keys accepted by views and `issues.query`. */
export const GroupBy = z.enum([
  'none',
  'status',
  'statusCategory',
  'assignee',
  'priority',
  'type',
  'label',
  'cycle',
  'milestone',
  'project',
  'parent',
  'component',
  'version',
  'dueDate',
  'createdAt',
])
export type GroupBy = z.infer<typeof GroupBy>

/**
 * A group key that may also name a custom field. `GroupBy` stays as it was so nothing that accepts
 * only the built-in keys has to change; views and `issues.query` accept this wider one.
 */
export const GroupByValue = z.union([GroupBy, z.string().regex(/^cf\.[a-z][a-z0-9_]*$/)])
export type GroupByValue = z.infer<typeof GroupByValue>

export const OrderBy = z.object({
  /** KQL field name (`priority`, `updated`, `rank`, `cf.severity`…) */
  field: z.string().min(1),
  dir: z.enum(['asc', 'desc']).default('asc'),
})
export type OrderBy = z.infer<typeof OrderBy>

export const BoardColumn = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  /** statuses shown in this column */
  statusIds: z.array(z.string()),
  wipLimit: z.number().int().positive().nullable().default(null),
  collapsed: z.boolean().default(false),
})
export type BoardColumn = z.infer<typeof BoardColumn>

export const ViewDisplay = z.object({
  groupBy: GroupByValue.default('none'),
  subGroupBy: GroupBy.optional(),
  orderBy: z.array(OrderBy).default([{ field: 'rank', dir: 'asc' }]),
  /** visible columns (list/spreadsheet): system field names or `cf.<key>` */
  columns: z.array(z.string()).default(['key', 'title', 'status', 'assignee', 'priority', 'updated']),
  /** board: swimlane grouping */
  swimlanes: GroupBy.optional(),
  showSubItems: z.boolean().default(true),
  showEmptyGroups: z.boolean().default(true),
  showCompleted: z.enum(['all', 'none', '1d', '7d', '30d']).default('7d'),
  /** board columns (null → one column per status of the project's workflows) */
  boardColumns: z.array(BoardColumn).nullable().default(null),
  wipLimits: z.record(z.string(), z.number().int().positive()).default({}),
  /** calendar: which date field positions issues — a system date field or `cf.<key>` */
  calendarField: z
    .union([
      z.enum(['dueDate', 'startDate', 'createdAt', 'updatedAt', 'resolvedAt']),
      z.string().regex(/^cf\.[a-z][a-z0-9_]*$/),
    ])
    .default('dueDate'),
  /** timeline: show dependency arrows */
  showDependencies: z.boolean().default(true),
  density: z.enum(['compact', 'comfortable']).default('comfortable'),
  /** card properties to display */
  cardProps: z.array(z.string()).default(['key', 'priority', 'assignee', 'labels', 'estimate', 'dueDate']),
})
export type ViewDisplay = z.infer<typeof ViewDisplay>

/** Visual filter builder state (kept verbatim for the UI; the server only uses `kql`). */
export const ViewFilters = z.record(z.string(), z.unknown())

export const View = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  /** null = cross-project (workspace) view */
  projectId: Id.nullable(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  icon: z.string().max(64).nullable(),
  kql: z.string().max(4000),
  layout: ViewLayout,
  display: ViewDisplay,
  filters: ViewFilters,
  visibility: ViewVisibility,
  ownerId: UserId.nullable(),
  /** pinned to the sidebar for the caller */
  pinned: z.boolean(),
  /** built-in views (My issues, Triage, Backlog…) cannot be deleted */
  builtin: z.boolean(),
  order: z.number().int(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type View = z.infer<typeof View>
export const UpsertView = z.object({
  projectId: Id.nullable().optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  kql: z.string().max(4000).default(''),
  layout: ViewLayout.default('list'),
  display: ViewDisplay.partial().optional(),
  filters: ViewFilters.optional(),
  visibility: ViewVisibility.default('private'),
  order: z.number().int().optional(),
})

// =====================================================================================
// KQL
// =====================================================================================

export const KqlError = z.object({
  message: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
})
export type KqlError = z.infer<typeof KqlError>

export const KqlSuggestion = z.object({
  kind: z.enum(['field', 'operator', 'value', 'keyword', 'function']),
  label: z.string(),
  insertText: z.string(),
  detail: z.string().optional(),
})
export type KqlSuggestion = z.infer<typeof KqlSuggestion>

export const KqlFieldInfo = z.object({
  name: z.string(),
  type: z.enum(['text', 'enum', 'user', 'number', 'date', 'datetime', 'boolean', 'ref', 'id', 'key']),
  label: z.string(),
  operators: z.array(z.string()),
  /** enum/ref fields: known values for autocomplete */
  values: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  custom: z.boolean(),
  sortable: z.boolean(),
})
export type KqlFieldInfo = z.infer<typeof KqlFieldInfo>

export const KqlParseResult = z.object({
  ok: z.boolean(),
  /** normalized AST (JSON) – see `@kernhq/module-tracker/kql` for the typed shape */
  ast: z.unknown().nullable(),
  errors: z.array(KqlError),
  /** normalised, pretty-printed query */
  normalized: z.string().nullable(),
  suggestions: z.array(KqlSuggestion),
})
export type KqlParseResult = z.infer<typeof KqlParseResult>

export const IssueQueryInput = z.object({
  workspaceId: WorkspaceId,
  kql: z.string().max(4000).default(''),
  /** restrict to these projects (ACL is applied regardless) */
  projectIds: z.array(Id).optional(),
  orderBy: z.array(OrderBy).optional(),
  /** a built-in key or `cf.<key>`, the same vocabulary views use */
  groupBy: GroupByValue.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  includeArchived: z.boolean().default(false),
  include: z
    .object({
      /** total count (extra query) */
      total: z.boolean().default(false),
      /** per-group counts when groupBy set */
      groupCounts: z.boolean().default(false),
      /** full Issue instead of IssueSummary */
      full: z.boolean().default(false),
    })
    .default({ total: false, groupCounts: false, full: false }),
})
export type IssueQueryInput = z.infer<typeof IssueQueryInput>

export const IssueQueryResult = z.object({
  items: z.array(Issue),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative().optional(),
  groups: z
    .array(
      z.object({
        key: z.string().nullable(),
        count: z.number().int().nonnegative(),
        estimate: z.number().nullable(),
      }),
    )
    .optional(),
  /** fields used in the query (for the UI to highlight) */
  fields: z.array(z.string()),
})
export type IssueQueryResult = z.infer<typeof IssueQueryResult>

// =====================================================================================
// intake / triage / email
// =====================================================================================

export const IntakeForm = z.object({
  projectId: Id,
  projectName: z.string(),
  token: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  fields: z.array(
    z.object({
      /** `name`, `email`, `title`, `description`, or `cf.<key>` for a custom field */
      key: z.string(),
      label: z.string(),
      description: z.string().nullable().optional(),
      type: z.enum([
        'text',
        'textarea',
        'email',
        'select',
        'multiselect',
        'number',
        'date',
        'checkbox',
        'url',
      ]),
      required: z.boolean(),
      options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    }),
  ),
  /** allow file uploads on the public form */
  allowAttachments: z.boolean(),
})
export type IntakeForm = z.infer<typeof IntakeForm>

export const IntakeSubmission = z.object({
  token: z.string().min(8),
  title: z.string().min(1).max(500),
  description: z.string().max(20000).optional(),
  email: z.string().email().optional(),
  name: z.string().max(120).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  /** honeypot – must be empty */
  website: z.string().max(0).optional(),
})
export type IntakeSubmission = z.infer<typeof IntakeSubmission>

export const EmailAddress = z.object({ address: z.string(), name: z.string().nullable().optional() })
/** Inbound email as handed over by the mail module. */
export const InboundEmail = z.object({
  /** project intake token (from `intake+<token>@…`) – or projectId for trusted callers */
  projectToken: z.string().optional(),
  projectId: Id.optional(),
  workspaceId: WorkspaceId.optional(),
  messageId: z.string().min(1),
  inReplyTo: z.string().nullable().optional(),
  references: z.array(z.string()).default([]),
  from: EmailAddress,
  to: z.array(EmailAddress).default([]),
  subject: z.string().max(1000),
  text: z.string().max(200000).nullable().optional(),
  html: z.string().max(500000).nullable().optional(),
  receivedAt: Timestamp.optional(),
  /** core file ids already stored by the mail module */
  attachments: z
    .array(z.object({ fileId: Id, name: z.string(), mimeType: z.string(), size: z.number().int() }))
    .default([]),
})
export type InboundEmail = z.infer<typeof InboundEmail>

export const EmailIngestResult = z.object({
  action: z.enum(['created', 'commented', 'ignored']),
  issueId: Id.nullable(),
  issueKey: z.string().nullable(),
  commentId: Id.nullable(),
  reason: z.string().optional(),
})
export type EmailIngestResult = z.infer<typeof EmailIngestResult>

// =====================================================================================
// reports
// =====================================================================================

export const BurndownPoint = z.object({
  date: DateOnly,
  remaining: z.number(),
  ideal: z.number(),
  completed: z.number(),
  scope: z.number(),
  /** scope added/removed that day */
  scopeChange: z.number(),
})
export const BurndownReport = z.object({
  cycle: Cycle,
  unit: EstimateUnit,
  points: z.array(BurndownPoint),
})
export type BurndownReport = z.infer<typeof BurndownReport>

export const VelocityReport = z.object({
  unit: EstimateUnit,
  cycles: z.array(
    z.object({
      cycle: Cycle.pick({ id: true, number: true, name: true, startAt: true, endAt: true, status: true }),
      committed: z.number(),
      completed: z.number(),
      committedCount: z.number().int(),
      completedCount: z.number().int(),
    }),
  ),
  average: z.number(),
})
export type VelocityReport = z.infer<typeof VelocityReport>

export const CfdReport = z.object({
  statuses: z.array(StatusInfo.pick({ id: true, name: true, category: true, color: true })),
  points: z.array(z.object({ date: DateOnly, counts: z.record(z.string(), z.number().int()) })),
})
export type CfdReport = z.infer<typeof CfdReport>

export const CreatedVsResolvedReport = z.object({
  points: z.array(
    z.object({
      date: DateOnly,
      created: z.number().int(),
      resolved: z.number().int(),
      openTotal: z.number().int(),
    }),
  ),
})
export type CreatedVsResolvedReport = z.infer<typeof CreatedVsResolvedReport>

export const TimeReport = z.object({
  from: DateOnly,
  to: DateOnly,
  totalSec: z.number().int().nonnegative(),
  billableSec: z.number().int().nonnegative(),
  rows: z.array(TimesheetRow),
  byUser: z.array(z.object({ userId: UserId, durationSec: z.number().int(), billableSec: z.number().int() })),
  byIssue: z.array(
    z.object({
      issueId: Id,
      issueKey: z.string(),
      title: z.string(),
      durationSec: z.number().int(),
      originalEstimateSec: z.number().int().nullable(),
      remainingSec: z.number().int().nullable(),
    }),
  ),
})
export type TimeReport = z.infer<typeof TimeReport>

// =====================================================================================
// imports
// =====================================================================================

export const ImportSource = z.enum(['jira', 'linear', 'csv'])
export type ImportSource = z.infer<typeof ImportSource>

export const CsvMapping = z.object({
  /** CSV column → issue field (system name or `cf.<key>`) */
  columns: z.record(z.string(), z.string()),
  /** parse options */
  delimiter: z.string().max(1).default(','),
  hasHeader: z.boolean().default(true),
  dateFormat: z.string().optional(),
  /** map status names → status ids (unmapped → initial status) */
  statusMap: z.record(z.string(), z.string()).default({}),
  /** map user emails/names → user ids */
  userMap: z.record(z.string(), UserId).default({}),
  /** map type names → type ids */
  typeMap: z.record(z.string(), Id).default({}),
  priorityMap: z.record(z.string(), Priority).default({}),
  createMissingLabels: z.boolean().default(true),
})
export type CsvMapping = z.infer<typeof CsvMapping>

export const ImportJob = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  projectId: Id,
  source: ImportSource,
  fileId: Id,
  mapping: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
  progress: z.object({
    total: z.number().int().nonnegative(),
    processed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  errors: z.array(z.object({ row: z.number().int().nullable(), message: z.string() })),
  /** external id → issue key mapping (for relations / idempotency) */
  createdBy: UserId.nullable(),
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  createdAt: Timestamp,
})
export type ImportJob = z.infer<typeof ImportJob>

// =====================================================================================
// approvals (transition approvals persisted per issue)
// =====================================================================================

export const IssueApproval = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  issueId: Id,
  transitionId: z.string(),
  state: ApprovalState,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type IssueApproval = z.infer<typeof IssueApproval>

// =====================================================================================
// project templates
// =====================================================================================

/**
 * Everything a template seeds into a new project. This is the *only* description of a template's
 * contents: the built-in four are values of this type in code, and a template saved from an
 * existing project snapshots into the same shape, so one applier serves both.
 *
 * Ids inside a body are template-local. Workflows are named by index, types name their workflow by
 * that index, and layouts name fields by `cf.<key>` — nothing here refers to a database id, which
 * is what lets a body created in one workspace apply in another.
 */
export const ProjectTemplateBody = z.object({
  version: z.literal(1).default(1),
  settings: ProjectSettings.partial().optional(),
  workflows: z
    .array(z.object({ name: z.string().min(1).max(120), definition: WorkflowDefinition }))
    .default([]),
  fields: z.array(UpsertFieldDef).default([]),
  types: z
    .array(
      UpsertWorkItemType.omit({ workflowId: true }).extend({
        /** index into `workflows`; null → the project's default workflow */
        workflowIndex: z.number().int().nonnegative().nullable().default(null),
      }),
    )
    .default([]),
  labels: z
    .array(z.object({ name: z.string().min(1).max(60), color: Color.nullable().default(null) }))
    .default([]),
  views: z.array(UpsertView).default([]),
})
export type ProjectTemplateBody = z.infer<typeof ProjectTemplateBody>

/** Reusable project blueprint (types, workflow, fields, labels, sample views). */
export const ProjectTemplate = z.object({
  id: Id,
  workspaceId: WorkspaceId.nullable(),
  key: MachineKey,
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable(),
  icon: z.string().max(64).nullable(),
  body: ProjectTemplateBody,
  builtin: z.boolean(),
  createdAt: Timestamp,
})
export type ProjectTemplate = z.infer<typeof ProjectTemplate>
