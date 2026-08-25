import type { UserId, WorkspaceId } from '@kernhq/contracts'
import { type KqlExpr, type KqlValue, parseKql } from './kql.js'
import { rankBetween, rankSequence } from './rank.js'
import type {
  Attachment,
  Comment,
  Component,
  Cycle,
  FieldDef,
  GroupBy,
  ImportJob,
  Issue,
  IssueApproval,
  IssueHistoryEntry,
  IssueTemplate,
  Label,
  Link,
  Milestone,
  Priority,
  Project,
  RecurrenceRule,
  RecurringIssue,
  RelationType,
  RelationView,
  ResolvedField,
  ResolvedLayout,
  StatusInfo,
  Timer,
  Version,
  View,
  Workflow,
  WorkItemType,
  Worklog,
} from './types.js'

/**
 * In-memory tracker backend.
 *
 * Enabled with `PUBLIC_API_MOCK=1` (`pnpm dev:mock`). It exists so the issues experience can be
 * built, demoed and tested without Postgres and the services, and so the end-to-end tests have a
 * deterministic backend. It answers the same procedures with the same shapes as the contract,
 * including KQL: queries are parsed with the same reader the query box uses and evaluated against
 * the seed data, so filtering behaves the way it will against the real server.
 *
 * Anything not implemented throws loudly rather than quietly returning nothing.
 */

const NOW = Date.now()
const DAY = 864e5
const iso = (msAgo = 0) => new Date(NOW - msAgo).toISOString()
const day = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString().slice(0, 10)
/**
 * Same id scheme as the core mock, so people and workspaces line up across the two.
 *
 * The contract brands user and workspace ids so they cannot be mixed up by accident; at runtime they
 * are ordinary uuids, and this is the one place the mock mints them.
 */
const uid = (n: number) =>
  `01920000-0000-7000-8000-${String(n).padStart(12, '0')}` as string & UserId & WorkspaceId
const clone = <T>(v: T): T => structuredClone(v)

type Uid = ReturnType<typeof uid>

const WORKSPACE = uid(10)
const PEOPLE = [uid(1), uid(2), uid(3), uid(4)] as const
/** Pick a person by index, wrapping — the seed data spreads reporters and actors around. */
const who = (i: number): Uid => PEOPLE[i % PEOPLE.length] as Uid
const PERSON_NAMES: Record<string, string> = {
  [uid(1)]: 'Maya Rivera',
  [uid(2)]: 'Dan Brekke',
  [uid(3)]: 'Tomás Lindqvist',
  [uid(4)]: 'Inés Cabrera',
}
/** The signed-in user in mock mode, so `assignee = currentUser()` resolves. */
const ME = uid(1)

// ---------------------------------------------------------------------------------------------
// workflow
// ---------------------------------------------------------------------------------------------

const WORKFLOW_ID = uid(710)

const statuses: StatusInfo[] = [
  { id: 'triage', name: 'Triage', category: 'triage', color: null, order: 0, workflowId: WORKFLOW_ID },
  { id: 'backlog', name: 'Backlog', category: 'backlog', color: null, order: 1, workflowId: WORKFLOW_ID },
  { id: 'todo', name: 'Todo', category: 'todo', color: null, order: 2, workflowId: WORKFLOW_ID },
  {
    id: 'in_progress',
    name: 'In progress',
    category: 'in_progress',
    color: null,
    order: 3,
    workflowId: WORKFLOW_ID,
  },
  {
    id: 'in_review',
    name: 'In review',
    category: 'in_progress',
    color: null,
    order: 4,
    workflowId: WORKFLOW_ID,
  },
  { id: 'done', name: 'Done', category: 'done', color: null, order: 5, workflowId: WORKFLOW_ID },
  {
    id: 'cancelled',
    name: 'Cancelled',
    category: 'cancelled',
    color: null,
    order: 6,
    workflowId: WORKFLOW_ID,
  },
]
const statusById = new Map(statuses.map((s) => [s.id, s]))

// ---------------------------------------------------------------------------------------------
// projects, types, labels, planning
// ---------------------------------------------------------------------------------------------

const projectSettings: Project['settings'] = {
  estimation: 'points',
  estimateScale: [0, 1, 2, 3, 5, 8, 13, 21],
  cycles: {
    enabled: true,
    lengthWeeks: 2,
    cooldownDays: 0,
    autoRoll: true,
    startDay: 1,
    autoCreateUpcoming: 1,
  },
  triage: { enabled: true },
  sla: { enabled: false, goals: {}, pauseInCategories: ['backlog'] },
  requireResolution: false,
  autoCreateIssueChannel: false,
  timezone: 'UTC',
}

const project = (n: number, key: string, name: string, color: string, leadId: Uid): Project => ({
  id: uid(n),
  workspaceId: WORKSPACE,
  key,
  name,
  description: null,
  icon: null,
  color,
  leadId,
  visibility: 'workspace',
  defaultAssignee: 'unassigned',
  workflowSchemeId: null,
  typeSchemeId: null,
  settings: projectSettings,
  intakeToken: null,
  issueCounter: 0,
  cycleCounter: 0,
  memberCount: 4,
  openIssueCount: 0,
  archivedAt: null,
  createdBy: uid(1),
  createdAt: iso(120 * DAY),
  updatedAt: iso(2 * DAY),
})

const projects: Project[] = [
  project(700, 'KRN', 'Kern Platform', '#7E6A93', uid(2)),
  project(701, 'RTM', 'Realtime', '#6E8B62', uid(3)),
  project(702, 'DOC', 'Docs', '#B49A5F', uid(4)),
]

const workItemType = (n: number, key: string, name: string, icon: string, level: number): WorkItemType => ({
  id: uid(n),
  workspaceId: WORKSPACE,
  projectId: null,
  key,
  name,
  description: null,
  icon,
  color: null,
  level,
  isDefault: key === 'task',
  workflowId: WORKFLOW_ID,
  fieldLayout: [],
  templateBody: null,
  order: n - 720,
  archivedAt: null,
  createdAt: iso(120 * DAY),
  updatedAt: iso(120 * DAY),
})

/** Mutable, like every other setting here: the screen changes it and the demo remembers. */
const hierarchyRules = { allowSkipLevels: true, allowSameLevel: false, maxSubItemDepth: 1 }

const types: WorkItemType[] = [
  workItemType(720, 'task', 'Task', 'square-check-big', 0),
  // Bug carries a real layout, so the demo shows a customised type beside default ones: Severity
  // is promoted above the built-in properties and Cycle is hidden.
  {
    ...workItemType(721, 'bug', 'Bug', 'circle-alert', 0),
    fieldLayout: [
      { fieldId: 'cf.severity', section: 'sidebar', order: 1, required: true, hidden: false },
      { fieldId: 'cycle', section: 'hidden', order: 20, required: false, hidden: true },
    ],
  },
  workItemType(722, 'story', 'Story', 'bookmark', 0),
  workItemType(723, 'epic', 'Epic', 'zap', 1),
]

const label = (n: number, name: string, color: string, group: string | null = null): Label => ({
  id: uid(n),
  workspaceId: WORKSPACE,
  projectId: null,
  name,
  color,
  description: null,
  groupName: group,
  issueCount: 0,
  archivedAt: null,
  createdAt: iso(100 * DAY),
})

const labels: Label[] = [
  label(740, 'performance', '#B4661C'),
  label(741, 'security', '#A63D26'),
  label(742, 'design', '#B7714E'),
  label(743, 'infra', '#5F7383'),
  label(744, 'good first issue', '#4F7A55'),
  label(745, 'regression', '#7A55B5'),
]

const cycles: Cycle[] = [
  {
    id: uid(760),
    workspaceId: WORKSPACE,
    projectId: uid(700),
    number: 23,
    name: 'Sprint 23',
    goal: 'Ship the permissions rewrite',
    startAt: iso(28 * DAY),
    endAt: iso(14 * DAY),
    status: 'completed',
    startedAt: iso(28 * DAY),
    completedAt: iso(14 * DAY),
    carryOverCount: 3,
    stats: { total: 18, done: 15, estimateTotal: 41, estimateDone: 34 },
    createdAt: iso(40 * DAY),
    updatedAt: iso(14 * DAY),
  },
  {
    id: uid(761),
    workspaceId: WORKSPACE,
    projectId: uid(700),
    number: 24,
    name: 'Sprint 24',
    goal: 'Realtime presence and the new issue list',
    startAt: iso(10 * DAY),
    endAt: iso(-4 * DAY),
    status: 'active',
    startedAt: iso(10 * DAY),
    completedAt: null,
    carryOverCount: 3,
    stats: { total: 21, done: 9, estimateTotal: 52, estimateDone: 21 },
    createdAt: iso(20 * DAY),
    updatedAt: iso(2 * 3600e3),
  },
  {
    id: uid(762),
    workspaceId: WORKSPACE,
    projectId: uid(700),
    number: 25,
    name: 'Sprint 25',
    goal: null,
    startAt: iso(-4 * DAY),
    endAt: iso(-18 * DAY),
    status: 'upcoming',
    startedAt: null,
    completedAt: null,
    carryOverCount: 0,
    stats: { total: 4, done: 0, estimateTotal: 11, estimateDone: 0 },
    createdAt: iso(6 * DAY),
    updatedAt: iso(6 * DAY),
  },
]

const component = (n: number, project: number, name: string): Component => ({
  id: uid(n),
  workspaceId: WORKSPACE,
  projectId: uid(project),
  name,
  description: null,
  leadId: null,
  defaultAssignee: 'none',
  issueCount: 0,
  createdAt: iso(90 * DAY),
  updatedAt: iso(90 * DAY),
})

/**
 * The parts each project is built from.
 *
 * Seeded rather than empty because the sidebar offers a project's components as a way to look at
 * its work: with none, the demo's "Components" view is one heap called "No component".
 */
const components: Component[] = [
  component(2200, 700, 'Sync engine'),
  component(2201, 700, 'Kernel'),
  component(2202, 701, 'Presence'),
]

const milestones: Milestone[] = [
  {
    id: uid(770),
    workspaceId: WORKSPACE,
    projectId: uid(700),
    name: 'Beta launch',
    description: 'Everything a self-hosted pilot needs',
    targetDate: day(24),
    status: 'open',
    stats: { total: 14, done: 6 },
    completedAt: null,
    createdAt: iso(60 * DAY),
    updatedAt: iso(3 * DAY),
  },
  {
    id: uid(771),
    workspaceId: WORKSPACE,
    projectId: uid(701),
    name: 'Presence v1',
    description: null,
    targetDate: day(10),
    status: 'open',
    stats: { total: 7, done: 4 },
    completedAt: null,
    createdAt: iso(45 * DAY),
    updatedAt: iso(DAY),
  },
]

const fields: FieldDef[] = [
  {
    id: uid(780),
    workspaceId: WORKSPACE,
    projectId: null,
    key: 'severity',
    name: 'Severity',
    description: 'How badly this hurts in production',
    type: 'select',
    options: [
      { id: uid(781), label: 'S1', color: '#A63D26', order: 0, archived: false },
      { id: uid(782), label: 'S2', color: '#B4661C', order: 1, archived: false },
      { id: uid(783), label: 'S3', color: '#B49A5F', order: 2, archived: false },
      { id: uid(784), label: 'S4', color: '#8E8779', order: 3, archived: false },
    ],
    defaultValue: null,
    config: {},
    searchable: true,
    required: false,
    showInCards: true,
    order: 0,
    archivedAt: null,
    createdAt: iso(80 * DAY),
    updatedAt: iso(80 * DAY),
  },
  {
    id: uid(785),
    workspaceId: WORKSPACE,
    projectId: null,
    key: 'customer',
    name: 'Customer',
    description: null,
    type: 'text',
    options: [],
    defaultValue: null,
    config: { maxLength: 120 },
    searchable: true,
    required: false,
    showInCards: false,
    order: 1,
    archivedAt: null,
    createdAt: iso(80 * DAY),
    updatedAt: iso(80 * DAY),
  },
]

/**
 * The mock's version of the server's layout resolver.
 *
 * It follows the same two rules, because a demo that behaved differently would teach the wrong
 * thing: an empty layout shows everything, and a field the layout does not name is appended.
 * `bug` carries a real stored layout so the demo shows a customised type next to default ones.
 */
const SYSTEM_ROWS: Array<{ id: string; section: 'main' | 'sidebar'; pinned: boolean }> = [
  { id: 'title', section: 'main', pinned: true },
  { id: 'description', section: 'main', pinned: false },
  { id: 'status', section: 'sidebar', pinned: true },
  { id: 'type', section: 'sidebar', pinned: true },
  { id: 'assignees', section: 'sidebar', pinned: false },
  { id: 'priority', section: 'sidebar', pinned: false },
  { id: 'labels', section: 'sidebar', pinned: false },
  { id: 'estimate', section: 'sidebar', pinned: false },
  { id: 'dueDate', section: 'sidebar', pinned: false },
  { id: 'cycle', section: 'sidebar', pinned: false },
  { id: 'project', section: 'sidebar', pinned: false },
]

function resolveMockLayout(typeId: string, projectId: string | null): ResolvedLayout {
  const type = types.find((t) => t.id === typeId)
  const stored = new Map((type?.fieldLayout ?? []).map((i) => [i.fieldId, i]))
  const out: Array<ResolvedField & { placedHidden: boolean }> = []
  let order = 0

  const place = (
    fieldId: string,
    kind: 'system' | 'custom',
    label: string,
    defaultSection: 'main' | 'sidebar',
    pinned: boolean,
    field: FieldDef | null,
  ) => {
    const item = stored.get(fieldId)
    const placedHidden = !pinned && (item?.hidden === true || item?.section === 'hidden')
    out.push({
      fieldId,
      kind,
      label,
      section: item?.section === 'main' || item?.section === 'sidebar' ? item.section : defaultSection,
      order: item?.order ?? order,
      required: pinned || item?.required === true || field?.required === true,
      pinned,
      showInCards: field?.showInCards ?? false,
      field,
      placedHidden,
    })
    order += 1
  }

  for (const row of SYSTEM_ROWS) place(row.id, 'system', row.id, row.section, row.pinned, null)
  for (const field of fields) place(`cf.${field.key}`, 'custom', field.name, 'sidebar', false, field)

  const sort = (a: ResolvedField, b: ResolvedField) => a.order - b.order
  const shown = ({ placedHidden: _drop, ...f }: ResolvedField & { placedHidden: boolean }) => f
  const pick = (want: (f: (typeof out)[number]) => boolean) => out.filter(want).sort(sort).map(shown)

  return {
    typeId,
    projectId,
    main: pick((f) => !f.placedHidden && f.section === 'main'),
    sidebar: pick((f) => !f.placedHidden && f.section === 'sidebar'),
    hidden: pick((f) => f.placedHidden),
  }
}

const EXTRA_FIELDS: FieldDef[] = [
  {
    id: uid(786),
    workspaceId: WORKSPACE,
    projectId: null,
    key: 'caused_by',
    name: 'Caused by',
    description: 'The change that introduced this',
    type: 'relation',
    options: [],
    defaultValue: null,
    config: { relationMultiple: true },
    searchable: false,
    required: false,
    showInCards: false,
    order: 2,
    archivedAt: null,
    createdAt: iso(80 * DAY),
    updatedAt: iso(80 * DAY),
  },
  {
    id: uid(787),
    workspaceId: WORKSPACE,
    projectId: null,
    key: 'days_open',
    name: 'Days open',
    description: 'Calculated from the dates',
    type: 'formula',
    options: [],
    defaultValue: null,
    config: { formula: 'daysBetween({startDate}, {dueDate})', formulaResult: 'number' },
    searchable: false,
    required: false,
    showInCards: false,
    order: 3,
    archivedAt: null,
    createdAt: iso(80 * DAY),
    updatedAt: iso(80 * DAY),
  },
]
fields.push(...EXTRA_FIELDS)

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

/** `[project, type, title, status, priority, assignees, labels, estimate, dueInDays, cycle]` */
type Seed = [
  number,
  string,
  string,
  string,
  Priority,
  number[],
  number[],
  number | null,
  number | null,
  number | null,
]

const SEEDS: Seed[] = [
  [0, 'bug', 'Voice rooms drop after 20 minutes', 'in_progress', 'urgent', [0], [740, 745], 5, 0, 761],
  [0, 'task', 'Row-level security policies for module schemas', 'in_review', 'high', [1], [741], 8, 1, 761],
  [0, 'story', 'Issue list keyboard navigation', 'in_progress', 'high', [0, 2], [742], 3, 2, 761],
  [0, 'bug', 'Workspace switcher loses focus on Escape', 'todo', 'medium', [2], [742], 1, null, 761],
  [0, 'task', 'Cache effective permissions in Valkey', 'done', 'high', [1], [740, 743], 5, null, 761],
  [0, 'task', 'Audit log export as NDJSON', 'backlog', 'low', [], [], 3, null, null],
  [0, 'bug', 'Invite links expire a day early', 'triage', 'medium', [], [745], null, null, null],
  [0, 'story', 'Saved views with shared visibility', 'todo', 'medium', [3], [], 8, 6, 762],
  [0, 'task', 'Migrate job queue to pg-boss 11', 'in_progress', 'medium', [1], [743], 5, 4, 761],
  [0, 'bug', 'Duplicate notifications on reconnect', 'in_review', 'high', [0], [745], 2, 1, 761],
  [0, 'task', 'Rate limit the public intake form', 'todo', 'high', [1], [741], 2, 3, 761],
  [0, 'story', 'Bulk edit from the issue list', 'backlog', 'medium', [], [], 5, null, null],
  [0, 'task', 'Drop the legacy members endpoint', 'done', 'low', [2], [], 1, null, 760],
  [0, 'bug', 'Avatar initials wrong for single-word names', 'done', 'low', [3], [742], 1, null, 760],
  [0, 'epic', 'Self-hosted install in one command', 'in_progress', 'high', [1], [743], 21, 20, null],
  [0, 'task', 'Postgres 18 upgrade for the dev compose file', 'todo', 'low', [], [743], 2, null, 762],
  [0, 'bug', 'Search returns archived workspaces', 'triage', 'low', [], [], null, null, null],
  [0, 'task', 'Document the module contract lifecycle', 'backlog', 'none', [], [744], 3, null, null],
  [0, 'story', 'Board drag and drop with WIP limits', 'in_progress', 'urgent', [0], [742], 8, 1, 761],
  [0, 'task', 'Ship signed release artefacts', 'cancelled', 'medium', [1], [741], 5, null, 760],

  [1, 'bug', 'Presence flickers when a tab is backgrounded', 'in_progress', 'high', [2], [740], 3, 2, null],
  [1, 'task', 'Heartbeat interval should back off on failure', 'todo', 'medium', [2], [743], 2, null, null],
  [1, 'story', 'Typing indicators across devices', 'backlog', 'medium', [], [], 5, null, null],
  [
    1,
    'bug',
    'WebSocket reconnect storms after a deploy',
    'in_review',
    'urgent',
    [1, 2],
    [740, 743],
    5,
    0,
    null,
  ],
  [1, 'task', 'Publish presence to the workspace channel only', 'done', 'medium', [2], [741], 3, null, null],
  [1, 'task', 'Trim the realtime payload for board updates', 'todo', 'low', [], [740], 2, 9, null],
  [1, 'bug', 'Away status never clears on mobile', 'triage', 'medium', [], [], null, null, null],
  [1, 'story', 'Live cursors in the planner', 'backlog', 'low', [], [742], 8, null, null],
  [1, 'task', 'Load test 5k concurrent sockets', 'todo', 'high', [1], [740], 5, 5, null],
  [1, 'task', 'Retire the polling fallback', 'done', 'low', [2], [], 1, null, null],
  [1, 'bug', 'Presence dot misaligned in RTL', 'todo', 'low', [3], [742], 1, 3, null],
  [1, 'story', 'Huddles from any channel', 'backlog', 'medium', [], [], 13, null, null],

  [2, 'task', 'Write the KQL reference page', 'in_progress', 'medium', [3], [744], 5, 3, null],
  [2, 'bug', 'Code blocks lose language on paste', 'todo', 'low', [3], [], 2, null, null],
  [2, 'story', 'Publish docs to a public site', 'backlog', 'medium', [], [], 8, null, null],
  [2, 'task', 'Persian translation pass for the shell', 'in_review', 'high', [3], [742], 3, 1, null],
  [2, 'task', 'Screenshot the board for the README', 'done', 'low', [0], [], 1, null, null],
  [2, 'bug', 'Embedded issue cards break in dark mode', 'triage', 'medium', [], [742], null, null, null],
  [2, 'task', 'Contributing guide for module authors', 'todo', 'medium', [1], [744], 3, 8, null],
  [2, 'story', 'Versioned docs per release', 'backlog', 'low', [], [], 8, null, null],
  [2, 'task', 'Alt text for every diagram', 'todo', 'low', [], [744, 742], 2, 12, null],
  [2, 'bug', 'Search index misses headings', 'done', 'medium', [3], [], 2, null, null],
]

const emptyRelations = () => ({
  blocks: 0,
  blockedBy: 0,
  openBlockers: 0,
  relates: 0,
  duplicates: 0,
  subItems: 0,
  subItemsDone: 0,
})

function buildIssues(): Issue[] {
  const ranks = rankSequence(SEEDS.length)
  const counters = new Map<string, number>()
  return SEEDS.map((seed, i) => {
    const [p, typeKey, title, statusId, priority, assignees, labelIds, estimate, dueIn, cycle] = seed
    const proj = projects[p] as Project
    const number = (counters.get(proj.id) ?? 0) + 1
    counters.set(proj.id, number)
    const status = statusById.get(statusId) as StatusInfo
    const type = types.find((t) => t.key === typeKey) as WorkItemType
    const done = status.category === 'done'
    const cancelled = status.category === 'cancelled'
    return {
      id: uid(800 + i),
      workspaceId: WORKSPACE,
      projectId: proj.id,
      key: `${proj.key}-${number}`,
      number,
      typeId: type.id,
      title,
      description: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: describe(title, typeKey) }] }],
      },
      descriptionText: describe(title, typeKey),
      statusId: status.id,
      statusCategory: status.category,
      priority,
      assigneeIds: assignees.map((a) => who(a)),
      reporterId: who(i + 1),
      creatorId: who(i + 2),
      labelIds: labelIds.map((n) => uid(n)),
      // the first project's work is spread over its two components; the rest carry none
      componentIds: p === 0 ? [uid(i % 2 === 0 ? 2200 : 2201)] : p === 1 && i % 3 === 0 ? [uid(2202)] : [],
      versionIds: [],
      affectsVersionIds: [],
      cycleId: cycle ? uid(cycle) : null,
      milestoneId: p === 0 && i % 3 === 0 ? uid(770) : p === 1 && i % 2 === 0 ? uid(771) : null,
      parentId: null,
      rank: ranks[i] as string,
      estimate,
      estimateUnit: 'points',
      startDate: null,
      dueDate: dueIn === null ? null : day(dueIn),
      completedAt: done ? iso((i % 7) * DAY) : null,
      cancelledAt: cancelled ? iso(5 * DAY) : null,
      resolution: done ? 'fixed' : cancelled ? 'wontfix' : null,
      // A `select` stores an option *id*, not its label. Storing the label made the list look
      // right by accident and left the board — which builds its columns from the option ids —
      // with nothing in any of them.
      custom: typeKey === 'bug' ? { severity: i % 4 === 0 ? uid(781) : uid(783) } : {},
      watcherIds: i % 4 === 0 ? [ME] : [],
      subscriberCount: assignees.length + 1,
      commentCount: 0,
      attachmentCount: 0,
      relationSummary: emptyRelations(),
      timeSpentSec: done ? 3600 * ((i % 5) + 1) : i % 3 === 0 ? 3600 * 2 : 0,
      remainingSec: null,
      originalEstimateSec: null,
      sla: null,
      triage: status.category === 'triage',
      snoozedUntil: null,
      source: status.category === 'triage' ? 'intake' : 'app',
      externalRef: null,
      chatChannelId: null,
      archivedAt: null,
      createdAt: iso((SEEDS.length - i + 2) * DAY),
      updatedAt: iso((i % 9) * 3600e3 + 600e3),
      lastActivityAt: iso((i % 9) * 3600e3 + 600e3),
    } satisfies Issue
  })
}

function describe(title: string, typeKey: string): string {
  return typeKey === 'bug'
    ? `Reproduced on the current main branch. ${title} — the fix likely belongs in the module that owns the surface, not the shell.`
    : `${title}. Scope it small enough to land in one cycle and leave the contract unchanged where possible.`
}

// ---------------------------------------------------------------------------------------------
// KQL evaluation
// ---------------------------------------------------------------------------------------------

type Scalar = string | number | boolean | null

/** Field accessor used by the KQL evaluator, mirroring `SYSTEM_FIELDS`. */
function fieldValue(issue: Issue, name: string): Scalar | Scalar[] {
  switch (name.toLowerCase()) {
    case 'key':
      return issue.key
    case 'project':
      return issue.projectId
    case 'type':
      return issue.typeId
    case 'title':
      return issue.title
    case 'status':
      return issue.statusId
    case 'statuscategory':
      return issue.statusCategory
    case 'priority':
      return issue.priority
    case 'assignee':
      return issue.assigneeIds
    case 'reporter':
      return issue.reporterId
    case 'label':
      return issue.labelIds
    case 'component':
      return issue.componentIds
    case 'version':
      return issue.versionIds
    case 'cycle':
      return issue.cycleId
    case 'milestone':
      return issue.milestoneId
    case 'parent':
      // The server resolves an issue key to its id before comparing (`parent = "KRN-12"`), so the
      // mock answers with the key as well as the id — otherwise a query that works against the
      // real backend silently matches nothing here.
      return issue.parentId ? [issue.parentId, keyOfIssue(issue.parentId)] : null
    case 'created':
      return issue.createdAt
    case 'updated':
      return issue.updatedAt
    case 'completed':
      return issue.completedAt
    case 'due':
      return issue.dueDate
    case 'start':
      return issue.startDate
    case 'estimate':
      return issue.estimate
    case 'timespent':
      return issue.timeSpentSec
    case 'watcher':
      return issue.watcherIds
    case 'resolution':
      return issue.resolution
    case 'triage':
      return issue.triage
    case 'archived':
      return issue.archivedAt !== null
    case 'text':
      return `${issue.key} ${issue.title} ${issue.descriptionText}`
    default:
      return name.startsWith('cf.') ? ((issue.custom[name.slice(3)] ?? null) as Scalar) : null
  }
}

/** Every spelling a value may be written as: an id, a key, a name or a person's handle. */
function aliasesFor(value: string): string[] {
  const out = [value]
  const proj = projects.find((p) => p.id === value)
  if (proj) out.push(proj.key, proj.name)
  const type = types.find((t) => t.id === value)
  if (type) out.push(type.key, type.name)
  const lbl = labels.find((l) => l.id === value)
  if (lbl) out.push(lbl.name)
  const cyc = cycles.find((c) => c.id === value)
  if (cyc) out.push(cyc.name, String(cyc.number))
  const ms = milestones.find((m) => m.id === value)
  if (ms) out.push(ms.name)
  const status = statusById.get(value)
  if (status) out.push(status.name)
  const person = PERSON_NAMES[value]
  if (person) out.push(person, person.split(' ')[0] as string)
  return out.map((s) => s.toLowerCase())
}

function literal(v: KqlValue): Scalar {
  switch (v.kind) {
    case 'string':
    case 'ident':
    case 'date':
      return v.value
    case 'number':
      return v.value
    case 'bool':
      return v.value
    case 'reldate': {
      const per = { h: 3600e3, d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY }[v.unit]
      return new Date(NOW + v.amount * per).toISOString()
    }
    case 'func':
      return v.name === 'currentUser' ? ME : v.name === 'now' ? new Date(NOW).toISOString() : null
    default:
      return null
  }
}

function equals(actual: Scalar | Scalar[], expected: Scalar): boolean {
  if (expected === null) return actual === null || (Array.isArray(actual) && actual.length === 0)
  const wanted = String(expected).toLowerCase()
  const candidates = Array.isArray(actual) ? actual : [actual]
  return candidates.some((c) => c !== null && aliasesFor(String(c)).includes(wanted))
}

function compare(actual: Scalar | Scalar[], expected: Scalar): number {
  const a = Array.isArray(actual) ? (actual[0] ?? null) : actual
  if (a === null || expected === null) return Number.NaN
  if (typeof a === 'number' || typeof expected === 'number') return Number(a) - Number(expected)
  return String(a) < String(expected) ? -1 : String(a) > String(expected) ? 1 : 0
}

/** The key of an issue by id, for KQL comparisons that name an issue the way people do. */
function keyOfIssue(id: string): string {
  return issueKeyById.get(id) ?? id
}
const issueKeyById = new Map<string, string>()

function matches(issue: Issue, expr: KqlExpr | null): boolean {
  if (!expr) return true
  switch (expr.kind) {
    case 'and':
      return expr.children.every((c) => matches(issue, c))
    case 'or':
      return expr.children.some((c) => matches(issue, c))
    case 'not':
      return !matches(issue, expr.child)
    case 'cmp': {
      const actual = fieldValue(issue, expr.field)
      const empty = actual === null || actual === '' || (Array.isArray(actual) && actual.length === 0)
      switch (expr.op) {
        case 'is-empty':
          return empty
        case 'is-not-empty':
          return !empty
        case 'in':
          return (expr.values ?? []).some((v) => equals(actual, literal(v)))
        case 'not-in':
          return !(expr.values ?? []).some((v) => equals(actual, literal(v)))
        case '=':
          return equals(actual, expr.value ? literal(expr.value) : null)
        case '!=':
          return !equals(actual, expr.value ? literal(expr.value) : null)
        case '~':
        case '!~': {
          const needle = String(expr.value ? literal(expr.value) : '').toLowerCase()
          const hay = (Array.isArray(actual) ? actual.join(' ') : String(actual ?? '')).toLowerCase()
          const hit = needle.length > 0 && hay.includes(needle)
          return expr.op === '~' ? hit : !hit
        }
        default: {
          const d = compare(actual, expr.value ? literal(expr.value) : null)
          if (Number.isNaN(d)) return false
          return expr.op === '<' ? d < 0 : expr.op === '<=' ? d <= 0 : expr.op === '>' ? d > 0 : d >= 0
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------------------------

/** Every workspace-scoped procedure carries the workspace; the mock has one, so it only checks shape. */
type Ws = { workspaceId: string }

const RICH = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

export function createMockTrackerApi() {
  const state = {
    issues: buildIssues(),
    comments: [] as Comment[],
    attachments: [] as Attachment[],
    relations: [] as RelationView[],
    views: [] as View[],
    // Seeded and then mutable: the planning screen creates, starts, completes and deletes these,
    // and a demo that resets them on every render cannot show a cycle being closed.
    cycles: cycles.map((c) => ({ ...c })),
    milestones: milestones.map((ms) => ({ ...ms })),
    components: components.map((c) => ({ ...c })),
    versions: [] as Version[],
    worklogs: [] as Worklog[],
    issueTemplates: [] as IssueTemplate[],
    recurring: [] as RecurringIssue[],
    // One finished import, so the history is something the demo shows rather than something that
    // only appears after you run one yourself.
    imports: [
      {
        id: uid(2900),
        workspaceId: WORKSPACE,
        projectId: uid(700),
        source: 'csv',
        fileId: uid(2901),
        mapping: { Summary: 'title', Priority: 'priority' },
        status: 'completed',
        progress: { total: 214, processed: 214, created: 211, skipped: 0, failed: 3 },
        errors: [
          { row: 42, message: 'Priority "Blocker" is not one of urgent, high, medium, low' },
          { row: 118, message: 'Title is empty' },
          { row: 190, message: 'Title is empty' },
        ],
        createdBy: ME,
        startedAt: iso(9 * DAY),
        finishedAt: iso(9 * DAY - 40_000),
        createdAt: iso(9 * DAY),
      },
    ] as ImportJob[],
    workflows: [
      {
        id: WORKFLOW_ID,
        workspaceId: WORKSPACE,
        projectId: null,
        name: 'Software',
        description: 'The workflow every demo project uses',
        definition: {
          id: WORKFLOW_ID,
          name: 'Software',
          statuses: statuses.map((s, order) => ({
            id: s.id,
            name: s.name,
            category: s.category,
            order,
            ...(s.id === 'backlog' ? { initial: true } : {}),
          })),
          // Every array present: the contract requires them, and a transition missing
          // `validators` is not "no validators" to the type, it is an incomplete transition.
          transitions: [
            {
              id: 'plan',
              name: 'Plan',
              from: ['backlog'],
              to: 'todo',
              conditions: [],
              validators: [],
              postFunctions: [],
              hidden: false,
            },
            {
              id: 'start',
              name: 'Start',
              from: ['backlog', 'todo'],
              to: 'in_progress',
              conditions: [],
              validators: [],
              postFunctions: [{ type: 'assign.to', config: { to: 'currentUser' } }],
              hidden: false,
            },
            {
              id: 'review',
              name: 'Ready for review',
              from: ['in_progress'],
              to: 'in_review',
              conditions: [],
              validators: [{ type: 'comment.required' }],
              postFunctions: [],
              hidden: false,
            },
            {
              id: 'complete',
              name: 'Done',
              from: ['in_progress', 'in_review'],
              to: 'done',
              conditions: [{ type: 'subtasks.allDone' }],
              validators: [],
              postFunctions: [{ type: 'resolution.set', config: { value: 'done' } }],
              hidden: false,
            },
          ],
        },
        isDefault: true,
        archivedAt: null,
        createdAt: iso(120 * DAY),
        updatedAt: iso(120 * DAY),
      },
    ] as Workflow[],
    timer: null as Timer | null,
    links: [] as Link[],
    approvals: [] as IssueApproval[],
    history: [] as IssueHistoryEntry[],
    counters: new Map<string, number>(),
  }
  for (const issue of state.issues) {
    state.counters.set(issue.projectId, Math.max(state.counters.get(issue.projectId) ?? 0, issue.number))
    issueKeyById.set(issue.id, issue.key)
  }

  const seedComment = (issueIndex: number, authorIdx: number, text: string, minutesAgo: number) => {
    const issue = state.issues[issueIndex] as Issue
    state.comments.push({
      id: uid(900 + state.comments.length),
      workspaceId: WORKSPACE,
      issueId: issue.id,
      parentId: null,
      authorId: who(authorIdx),
      body: RICH(text),
      bodyText: text,
      mentionIds: [],
      reactions:
        state.comments.length % 3 === 0 ? [{ emoji: '👍', count: 2, userIds: [who(0), who(2)] }] : [],
      internal: false,
      source: 'app',
      replyCount: 0,
      editedAt: null,
      deletedAt: null,
      createdAt: iso(minutesAgo * 60e3),
      updatedAt: iso(minutesAgo * 60e3),
    })
    issue.commentCount += 1
  }

  seedComment(
    0,
    1,
    'Reproduced on staging — the socket closes at exactly 20 minutes, so it smells like an idle timeout on the proxy rather than our heartbeat.',
    240,
  )
  seedComment(0, 2, 'Agreed. I bumped the proxy read timeout locally and it survived an hour.', 180)
  seedComment(
    0,
    0,
    'Let us keep the heartbeat anyway; it protects us from every other proxy we do not control.',
    45,
  )
  seedComment(
    2,
    3,
    'j and k for up and down, x to select, enter to open. Anything else and we are inventing a new language.',
    600,
  )
  seedComment(2, 0, 'Works for me. Escape closes the panel and returns focus to the row.', 90)
  seedComment(
    18,
    1,
    'WIP limits should warn rather than block — a hard stop just makes people rename columns.',
    320,
  )

  for (const [i, issue] of state.issues.entries()) {
    if (i % 5 !== 0) continue
    state.history.push({
      id: uid(950 + i),
      issueId: issue.id,
      actorId: who(i),
      action: 'created',
      changes: [],
      data: {},
      occurredAt: issue.createdAt,
    })
    state.history.push({
      id: uid(951 + i),
      issueId: issue.id,
      actorId: who(i + 1),
      action: 'status_changed',
      changes: [{ field: 'status', from: 'todo', to: issue.statusId }],
      data: {},
      occurredAt: issue.updatedAt,
    })
  }

  const find = (issueId: string) => {
    const issue = state.issues.find((i) => i.id === issueId)
    if (!issue) throw new Error(`[mock] unknown issue ${issueId}`)
    return issue
  }
  const touch = (issue: Issue) => {
    issue.updatedAt = new Date().toISOString()
    issue.lastActivityAt = issue.updatedAt
  }

  const sortKey = (issue: Issue, field: string): string | number => {
    switch (field) {
      case 'priority':
        return -['none', 'low', 'medium', 'high', 'urgent'].indexOf(issue.priority)
      case 'updated':
        return -new Date(issue.updatedAt).getTime()
      case 'created':
        return -new Date(issue.createdAt).getTime()
      case 'due':
        return issue.dueDate ?? '9999-12-31'
      case 'estimate':
        return issue.estimate ?? Number.MAX_SAFE_INTEGER
      case 'key':
        return issue.key
      default:
        return issue.rank
    }
  }

  return {
    projects: {
      list: async ({ includeArchived }: Ws & { includeArchived?: boolean }) =>
        clone(
          projects
            .filter((p) => includeArchived || !p.archivedAt)
            // Counted, not seeded: a static count drifts the moment the demo creates an issue,
            // and a row whose only number is always zero says nothing.
            .map((p) => ({
              ...p,
              openIssueCount: state.issues.filter(
                (i) =>
                  i.projectId === p.id && i.statusCategory !== 'done' && i.statusCategory !== 'cancelled',
              ).length,
            })),
        ),
      get: async ({ projectId }: Ws & { projectId: string }) =>
        clone(projects.find((p) => p.id === projectId) ?? (projects[0] as Project)),
      getByKey: async ({ key }: Ws & { key: string }) =>
        clone(projects.find((p) => p.key === key) ?? (projects[0] as Project)),
      create: async (
        input: Ws & { name: string; key: string; description?: string | null; template?: string },
      ) => {
        if (projects.some((p) => p.key === input.key.toUpperCase()))
          throw new Error(`[mock] the key "${input.key}" is already used`)
        const now = new Date().toISOString()
        const project: Project = {
          ...(projects[0] as Project),
          id: uid(1900 + projects.length),
          key: input.key.toUpperCase(),
          name: input.name,
          description: input.description ?? null,
          issueCounter: 0,
          createdAt: now,
          updatedAt: now,
        }
        projects.push(project)
        state.counters.set(project.id, 0)
        return clone(project)
      },
      update: async ({ projectId, patch }: Ws & { projectId: string; patch: Partial<Project> }) => {
        const project = projects.find((p) => p.id === projectId)
        if (!project) throw new Error(`[mock] unknown project ${projectId}`)
        Object.assign(project, patch, { updatedAt: new Date().toISOString() })
        return clone(project)
      },
      archive: async ({ projectId, archived }: Ws & { projectId: string; archived?: boolean }) => {
        const project = projects.find((p) => p.id === projectId)
        if (!project) throw new Error(`[mock] unknown project ${projectId}`)
        project.archivedAt = archived === false ? null : new Date().toISOString()
        return clone(project)
      },
      delete: async ({ projectId }: Ws & { projectId: string }) => {
        const at = projects.findIndex((p) => p.id === projectId)
        if (at < 0) throw new Error(`[mock] unknown project ${projectId}`)
        projects.splice(at, 1)
        // Everything that belonged to it goes with it, which is what makes this irreversible.
        state.issues = state.issues.filter((i) => i.projectId !== projectId)
        return { ok: true as const }
      },
      setIntake: async ({
        enabled,
        rotate,
      }: Ws & { projectId: string; enabled: boolean; rotate?: boolean }) => ({
        token: enabled ? (rotate ? 'demo-intake-token-2' : 'demo-intake-token') : null,
      }),
      templates: {
        // The four the tracker ships with. The mock does not apply them — it has no schema to seed —
        // but the chooser is what this exists for, and it must offer what the server offers.
        list: async (_input: Ws) =>
          [
            { key: 'software', name: 'Software', description: 'Epics, stories, bugs, and a review step.' },
            {
              key: 'support',
              name: 'Support desk',
              description: 'Tickets with a customer, an impact and a clock.',
            },
            {
              key: 'marketing',
              name: 'Marketing',
              description: 'Campaigns, assets and requests, with a publish date.',
            },
            { key: 'simple', name: 'Simple task list', description: 'Tasks. Nothing to learn first.' },
          ].map((t) => ({
            id: t.key,
            workspaceId: null,
            key: t.key,
            name: t.name,
            description: t.description,
            icon: null,
            body: { version: 1, workflows: [], fields: [], types: [], labels: [], views: [] },
            builtin: true,
            createdAt: iso(0),
          })),
      },
    },

    types: {
      list: async ({ includeArchived }: Ws & { includeArchived?: boolean }) =>
        clone(types.filter((t) => includeArchived || !t.archivedAt)),
      layout: async ({ id, projectId }: Ws & { id: string; projectId?: string | null }) =>
        clone(resolveMockLayout(id, projectId ?? null)),
      create: async ({ key, name, ...rest }: Ws & { key: string; name: string } & Partial<WorkItemType>) => {
        if (types.some((t) => t.key === key)) throw new Error(`[mock] type ${key} already exists`)
        const type: WorkItemType = {
          ...workItemType(724 + types.length, key, name, 'square-check-big', 0),
          ...rest,
        }
        // Only one type is the default, here as on the server.
        if (type.isDefault) for (const other of types) other.isDefault = false
        types.push(type)
        return clone(type)
      },
      update: async ({ id, patch }: Ws & { id: string; patch: Partial<WorkItemType> }) => {
        const type = types.find((t) => t.id === id)
        if (!type) throw new Error(`[mock] unknown type ${id}`)
        if (patch.isDefault) for (const other of types) other.isDefault = false
        Object.assign(type, patch, { updatedAt: new Date().toISOString() })
        return clone(type)
      },
      hierarchyRules: async (_input: Ws) => clone(hierarchyRules),
      setHierarchyRules: async ({ rules }: Ws & { rules: typeof hierarchyRules }) => {
        Object.assign(hierarchyRules, rules)
        return clone(hierarchyRules)
      },
      archive: async ({ id, archived }: Ws & { id: string; archived?: boolean }) => {
        const type = types.find((t) => t.id === id)
        if (!type) throw new Error(`[mock] unknown type ${id}`)
        if (type.isDefault && archived !== false)
          throw new Error('[mock] the default type cannot be archived')
        type.archivedAt = archived === false ? null : new Date().toISOString()
        return clone(type)
      },
    },
    labels: {
      list: async ({ projectId }: Ws & { projectId?: string }) =>
        clone(labels.filter((l) => !projectId || !l.projectId || l.projectId === projectId)),
      create: async ({ projectId, name }: Ws & { projectId?: string; name: string }) => {
        const label: Label = {
          id: uid(2100 + labels.length),
          workspaceId: WORKSPACE,
          projectId: projectId ?? null,
          name,
          color: null,
          description: null,
          groupName: null,
          issueCount: 0,
          archivedAt: null,
          createdAt: new Date().toISOString(),
        }
        labels.push(label)
        return clone(label)
      },
      update: async ({ id, patch }: Ws & { id: string; patch: Partial<Label> }) => {
        const label = labels.find((l) => l.id === id)
        if (!label) throw new Error(`[mock] unknown label ${id}`)
        Object.assign(label, patch)
        return clone(label)
      },
      delete: async ({ id }: Ws & { id: string }) => {
        const index = labels.findIndex((l) => l.id === id)
        if (index >= 0) labels.splice(index, 1)
        // and off every issue that had it, the way the server does
        for (const issue of state.issues) issue.labelIds = issue.labelIds.filter((l) => l !== id)
        return { ok: true as const }
      },
    },

    components: {
      // The count is derived rather than stored: the server counts issues, and a mock that keeps a
      // number of its own drifts from the list it is meant to describe the moment anything moves.
      list: async ({ projectId }: Ws & { projectId: string }) =>
        clone(
          state.components
            .filter((c) => c.projectId === projectId)
            .map((c) => ({
              ...c,
              issueCount: state.issues.filter((i) => i.componentIds.includes(c.id)).length,
            })),
        ),
      create: async ({
        projectId,
        name,
        description,
        leadId,
        defaultAssignee,
      }: Ws & {
        projectId: string
        name: string
        description?: string | null
        leadId?: Component['leadId']
        defaultAssignee?: Component['defaultAssignee']
      }) => {
        const now = new Date().toISOString()
        const component: Component = {
          id: uid(2200 + state.components.length),
          workspaceId: WORKSPACE,
          projectId,
          name,
          description: description ?? null,
          leadId: leadId ?? null,
          defaultAssignee: defaultAssignee ?? 'none',
          issueCount: 0,
          createdAt: now,
          updatedAt: now,
        }
        state.components.push(component)
        return clone(component)
      },
      update: async ({ id, patch }: Ws & { id: string; patch: Partial<Component> }) => {
        const component = state.components.find((c) => c.id === id)
        if (!component) throw new Error(`[mock] unknown component ${id}`)
        Object.assign(component, patch, { updatedAt: new Date().toISOString() })
        return clone(component)
      },
      delete: async ({ id }: Ws & { id: string }) => {
        state.components = state.components.filter((c) => c.id !== id)
        return { ok: true as const }
      },
    },

    versions: {
      list: async ({ projectId }: Ws & { projectId: string }) =>
        clone(state.versions.filter((v) => v.projectId === projectId)),
      create: async ({ projectId, name }: Ws & { projectId: string; name: string }) => {
        const now = new Date().toISOString()
        const version: Version = {
          id: uid(2300 + state.versions.length),
          workspaceId: WORKSPACE,
          projectId,
          name,
          description: null,
          status: 'unreleased',
          startDate: null,
          releaseDate: null,
          releasedAt: null,
          stats: { total: 0, done: 0 },
          order: state.versions.length,
          createdAt: now,
          updatedAt: now,
        }
        state.versions.push(version)
        return clone(version)
      },
      update: async ({ id, patch }: Ws & { id: string; patch: Partial<Version> }) => {
        const version = state.versions.find((v) => v.id === id)
        if (!version) throw new Error(`[mock] unknown version ${id}`)
        Object.assign(version, patch, { updatedAt: new Date().toISOString() })
        return clone(version)
      },
      delete: async ({ id }: Ws & { id: string }) => {
        state.versions = state.versions.filter((v) => v.id !== id)
        return { ok: true as const }
      },
      release: async ({ id, released }: Ws & { id: string; released: boolean }) => {
        const version = state.versions.find((v) => v.id === id)
        if (!version) throw new Error(`[mock] unknown version ${id}`)
        version.status = released ? 'released' : 'unreleased'
        version.releasedAt = released ? new Date().toISOString() : null
        return clone(version)
      },
    },
    fields: {
      list: async ({ includeArchived }: Ws & { includeArchived?: boolean }) =>
        clone(fields.filter((f) => includeArchived || !f.archivedAt)),
      archive: async ({ id, archived }: Ws & { id: string; archived?: boolean }) => {
        const field = fields.find((f) => f.id === id)
        if (!field) throw new Error(`[mock] unknown field ${id}`)
        field.archivedAt = archived === false ? null : new Date().toISOString()
        return clone(field)
      },
      create: async (input: Ws & { key: string; name: string; type: FieldDef['type'] }) => {
        if (fields.some((f) => f.key === input.key))
          // Same rule as the database: the key is where the value lives, so it is unique per
          // workspace whatever the project scope.
          throw new Error(`[mock] the key "${input.key}" is already used`)
        const now = new Date().toISOString()
        const field: FieldDef = {
          id: uid(1800 + fields.length),
          workspaceId: WORKSPACE,
          projectId: null,
          key: input.key,
          name: input.name,
          description: null,
          type: input.type,
          options: [],
          defaultValue: null,
          config: {},
          searchable: false,
          required: false,
          showInCards: false,
          order: fields.length,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
          ...(input as Partial<FieldDef>),
        }
        fields.push(field)
        return clone(field)
      },
      update: async ({ id, patch }: Ws & { id: string; patch: Partial<FieldDef> }) => {
        const field = fields.find((f) => f.id === id)
        if (!field) throw new Error(`[mock] unknown field ${id}`)
        Object.assign(field, patch, { updatedAt: new Date().toISOString() })
        return clone(field)
      },
      delete: async ({ id }: Ws & { id: string }) => {
        const field = fields.find((f) => f.id === id)
        const index = fields.findIndex((f) => f.id === id)
        if (index >= 0) fields.splice(index, 1)
        // Deleting a field strips its value from every issue, the way the server does.
        if (field) for (const issue of state.issues) delete issue.custom[field.key]
        return { ok: true as const }
      },
    },
    workflows: {
      statuses: async (_input: Ws) => clone(statuses),
      list: async ({ includeArchived }: Ws & { includeArchived?: boolean }) =>
        clone(state.workflows.filter((w) => includeArchived || !w.archivedAt)),
      // The three the server ships. The definitions are thin here — the chooser is what this is
      // for, and the mock has no engine to run them through.
      templates: async () => [
        {
          id: 'software',
          name: 'Software',
          definition: clone((state.workflows[0] as Workflow).definition),
        },
        {
          id: 'kanban',
          name: 'Kanban',
          definition: clone((state.workflows[0] as Workflow).definition),
        },
        {
          id: 'simple',
          name: 'Simple',
          definition: clone((state.workflows[0] as Workflow).definition),
        },
      ],
      validate: async ({ definition }: Ws & { definition: unknown }) => {
        const def = definition as Workflow['definition']
        const ids = new Set<string>()
        const problems: Array<{ path: string; message: string }> = []
        for (const [i, st] of def.statuses.entries()) {
          if (ids.has(st.id))
            problems.push({ path: `statuses.${i}.id`, message: `Duplicate status id "${st.id}"` })
          ids.add(st.id)
        }
        for (const [i, t] of def.transitions.entries()) {
          if (!ids.has(t.to))
            problems.push({ path: `transitions.${i}.to`, message: `Unknown target status "${t.to}"` })
        }
        return { ok: problems.length === 0, problems }
      },
      create: async ({ name, definition }: Ws & { name: string; definition: Workflow['definition'] }) => {
        const now = new Date().toISOString()
        const workflow: Workflow = {
          ...(state.workflows[0] as Workflow),
          id: uid(2800 + state.workflows.length),
          name,
          description: null,
          isDefault: false,
          definition: clone(definition),
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        }
        state.workflows.push(workflow)
        return clone(workflow)
      },
      archive: async ({ id, archived }: Ws & { id: string; archived?: boolean }) => {
        const workflow = state.workflows.find((w) => w.id === id)
        if (!workflow) throw new Error(`[mock] unknown workflow ${id}`)
        if (workflow.isDefault && archived !== false)
          throw new Error('[mock] the default workflow cannot be archived')
        workflow.archivedAt = archived === false ? null : new Date().toISOString()
        return clone(workflow)
      },
      update: async ({ id, patch }: Ws & { id: string; patch: Partial<Workflow> }) => {
        const workflow = state.workflows.find((w) => w.id === id)
        if (!workflow) throw new Error(`[mock] unknown workflow ${id}`)
        Object.assign(workflow, patch, { updatedAt: new Date().toISOString() })
        // The board and every status label read from `statuses`, so a rename has to reach it.
        for (const status of workflow.definition.statuses) {
          const known = statuses.find((s) => s.id === status.id)
          if (known) known.name = status.name
        }
        return clone(workflow)
      },
    },
    milestones: {
      list: async ({ projectId }: Ws & { projectId?: string }) =>
        clone(state.milestones.filter((ms) => !projectId || ms.projectId === projectId)),
      create: async ({
        projectId,
        name,
        description,
        targetDate,
      }: Ws & {
        projectId: string
        name: string
        description?: string | null
        targetDate?: string | null
      }) => {
        const now = new Date().toISOString()
        const milestone: Milestone = {
          id: uid(2600 + state.milestones.length),
          workspaceId: WORKSPACE,
          projectId,
          name,
          description: description ?? null,
          targetDate: targetDate ?? null,
          status: 'open',
          stats: { total: 0, done: 0 },
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        }
        state.milestones.push(milestone)
        return clone(milestone)
      },
      update: async ({ id, patch }: Ws & { id: string; patch: Partial<Milestone> }) => {
        const milestone = state.milestones.find((ms) => ms.id === id)
        if (!milestone) throw new Error(`[mock] unknown milestone ${id}`)
        Object.assign(milestone, patch, { updatedAt: new Date().toISOString() })
        if (patch.status)
          milestone.completedAt = patch.status === 'completed' ? new Date().toISOString() : null
        return clone(milestone)
      },
      delete: async ({ id }: Ws & { id: string }) => {
        state.milestones = state.milestones.filter((ms) => ms.id !== id)
        return { ok: true as const }
      },
    },
    cycles: {
      list: async ({ projectId }: Ws & { projectId?: string }) =>
        clone(state.cycles.filter((c) => !projectId || c.projectId === projectId)),
      get: async ({ id }: Ws & { id: string }) => {
        const cycle = state.cycles.find((c) => c.id === id)
        if (!cycle) throw new Error(`[mock] unknown cycle ${id}`)
        return clone(cycle)
      },
      create: async ({
        projectId,
        name,
        goal,
        startAt,
        endAt,
      }: Ws & {
        projectId: string
        name?: string
        goal?: string | null
        startAt: string
        endAt: string
      }) => {
        const now = new Date().toISOString()
        const number =
          Math.max(0, ...state.cycles.filter((c) => c.projectId === projectId).map((c) => c.number)) + 1
        const cycle: Cycle = {
          id: uid(2700 + state.cycles.length),
          workspaceId: WORKSPACE,
          projectId,
          number,
          name: name || `Cycle ${number}`,
          goal: goal ?? null,
          startAt,
          endAt,
          status: 'upcoming',
          startedAt: null,
          completedAt: null,
          carryOverCount: 0,
          stats: { total: 0, done: 0, estimateTotal: 0, estimateDone: 0 },
          createdAt: now,
          updatedAt: now,
        }
        state.cycles.push(cycle)
        return clone(cycle)
      },
      update: async ({ id, patch }: Ws & { id: string; patch: Partial<Cycle> }) => {
        const cycle = state.cycles.find((c) => c.id === id)
        if (!cycle) throw new Error(`[mock] unknown cycle ${id}`)
        Object.assign(cycle, patch, { updatedAt: new Date().toISOString() })
        return clone(cycle)
      },
      start: async ({ id }: Ws & { id: string }) => {
        const cycle = state.cycles.find((c) => c.id === id)
        if (!cycle) throw new Error(`[mock] unknown cycle ${id}`)
        // One at a time, like the server: starting a second while one runs is a conflict, not a swap.
        if (state.cycles.some((c) => c.projectId === cycle.projectId && c.status === 'active'))
          throw new Error('[mock] another cycle is already active')
        cycle.status = 'active'
        cycle.startedAt = new Date().toISOString()
        return clone(cycle)
      },
      complete: async ({ id, rollToCycleId }: Ws & { id: string; rollToCycleId?: string | null }) => {
        const cycle = state.cycles.find((c) => c.id === id)
        if (!cycle) throw new Error(`[mock] unknown cycle ${id}`)
        // Omitted means "choose for me"; null means the backlog. The server draws the same line.
        const target =
          rollToCycleId === undefined
            ? (state.cycles.find((c) => c.projectId === cycle.projectId && c.status === 'upcoming')?.id ??
              null)
            : rollToCycleId
        const unfinished = state.issues.filter(
          (i) => i.cycleId === id && i.statusCategory !== 'done' && i.statusCategory !== 'cancelled',
        )
        for (const issue of unfinished) issue.cycleId = target
        if (target && unfinished.length) {
          const next = state.cycles.find((c) => c.id === target)
          if (next) next.carryOverCount += unfinished.length
        }
        cycle.status = 'completed'
        cycle.completedAt = new Date().toISOString()
        return clone(cycle)
      },
      delete: async ({ id }: Ws & { id: string }) => {
        state.cycles = state.cycles.filter((c) => c.id !== id)
        return { ok: true as const }
      },
    },
    worklogs: {
      list: async ({ issueId }: Ws & { issueId: string }) =>
        clone(state.worklogs.filter((w) => w.issueId === issueId)),
      create: async ({
        issueId,
        durationSec,
        note,
      }: Ws & { issueId: string; durationSec: number; note?: string | null }) => {
        const issue = find(issueId)
        const worklog: Worklog = {
          id: uid(2400 + state.worklogs.length),
          workspaceId: WORKSPACE,
          projectId: issue.projectId,
          issueId,
          userId: ME,
          startedAt: new Date().toISOString(),
          durationSec,
          note: note ?? null,
          billable: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        state.worklogs.push(worklog)
        issue.timeSpentSec += durationSec
        touch(issue)
        return { worklog: clone(worklog), issue: clone(issue) }
      },
      update: async ({ id, patch }: Ws & { id: string; patch: Record<string, unknown> }) => {
        const worklog = state.worklogs.find((w) => w.id === id)
        if (!worklog) throw new Error(`[mock] unknown worklog ${id}`)
        Object.assign(worklog, patch, { updatedAt: new Date().toISOString() })
        // The issue's total is the sum of its entries, so correcting one has to reach it.
        const issue = state.issues.find((i) => i.id === worklog.issueId)
        if (issue)
          issue.timeSpentSec = state.worklogs
            .filter((w) => w.issueId === worklog.issueId)
            .reduce((sum, w) => sum + w.durationSec, 0)
        return clone(worklog)
      },
      delete: async ({ id }: Ws & { id: string }) => {
        const gone = state.worklogs.find((w) => w.id === id)
        state.worklogs = state.worklogs.filter((w) => w.id !== id)
        if (gone) {
          const issue = state.issues.find((i) => i.id === gone.issueId)
          if (issue) issue.timeSpentSec = Math.max(0, issue.timeSpentSec - gone.durationSec)
        }
        return { ok: true as const }
      },
      timers: {
        current: async (_input: Ws) => clone(state.timer),
        start: async ({ issueId }: Ws & { issueId: string }) => {
          // A timer belongs to a person: starting one replaces whatever they had running.
          const timer: Timer = {
            id: uid(2500),
            workspaceId: WORKSPACE,
            issueId,
            userId: ME,
            startedAt: new Date().toISOString(),
            note: null,
          }
          state.timer = timer
          return clone(timer)
        },
        stop: async ({ discard }: Ws & { discard?: boolean }) => {
          const timer = state.timer
          state.timer = null
          if (!timer || discard) return { worklog: null }
          const issue = find(timer.issueId)
          const durationSec = Math.max(60, Math.round((Date.now() - Date.parse(timer.startedAt)) / 1000))
          const worklog: Worklog = {
            id: uid(2400 + state.worklogs.length),
            workspaceId: WORKSPACE,
            projectId: issue.projectId,
            issueId: timer.issueId,
            userId: ME,
            startedAt: timer.startedAt,
            durationSec,
            note: timer.note,
            billable: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          state.worklogs.push(worklog)
          issue.timeSpentSec += durationSec
          touch(issue)
          return { worklog: clone(worklog) }
        },
      },
    },

    intake: {
      // A single well-known token, so the demo form has a link that works.
      form: async ({ token }: { token: string }) => {
        if (token !== 'demo-intake-token') throw new Error('[mock] unknown intake token')
        const project = projects[0] as Project
        return clone({
          projectId: project.id,
          projectName: project.name,
          token,
          title: `Contact ${project.name}`,
          description: 'Tell us what went wrong and we will pick it up.',
          fields: [
            { key: 'name', label: 'Your name', type: 'text' as const, required: false },
            { key: 'email', label: 'Email', type: 'email' as const, required: true },
            { key: 'title', label: 'Summary', type: 'text' as const, required: true },
            { key: 'description', label: 'Details', type: 'textarea' as const, required: false },
            {
              key: 'cf.severity',
              label: 'Severity',
              description: 'How badly this hurts in production',
              type: 'select' as const,
              required: false,
              options: fields
                .find((f) => f.key === 'severity')!
                .options.map((o) => ({ value: o.id, label: o.label })),
            },
          ],
          allowAttachments: false,
        })
      },
      submit: async (input: { token: string; title: string; website?: string }) => {
        if (input.website) throw new Error('[mock] rejected')
        if (input.token !== 'demo-intake-token') throw new Error('[mock] unknown intake token')
        const project = projects[0] as Project
        const number = (state.counters.get(project.id) ?? 0) + 1
        state.counters.set(project.id, number)
        return { ok: true as const, issueKey: `${project.key}-${number}` }
      },
    },

    imports: {
      list: async ({ projectId }: Ws & { projectId: string }) =>
        clone(state.imports.filter((j) => j.projectId === projectId)),
      get: async ({ id }: Ws & { id: string }) => {
        const job = state.imports.find((j) => j.id === id)
        if (!job) throw new Error(`[mock] unknown import ${id}`)
        // Advance a little on each poll, so the progress bar is something a person can watch
        // rather than a number that appears finished before it started.
        if (job.status === 'running') {
          job.progress.processed = Math.min(job.progress.total, job.progress.processed + 4)
          job.progress.created = Math.max(0, job.progress.processed - job.progress.failed)
          if (job.progress.processed >= job.progress.total) {
            job.status = 'completed'
            job.finishedAt = new Date().toISOString()
          }
        }
        return clone(job)
      },
      start: async ({ projectId, source, fileId, mapping }: Ws & Record<string, never>) => {
        const now = new Date().toISOString()
        const job: ImportJob = {
          id: uid(2800 + state.imports.length),
          workspaceId: WORKSPACE,
          projectId: projectId as unknown as string,
          source: (source ?? 'csv') as ImportJob['source'],
          fileId: fileId as unknown as string,
          mapping: (mapping ?? {}) as Record<string, unknown>,
          status: 'running',
          // A row that fails is part of what an import looks like; a demo where nothing ever
          // fails teaches nobody what the errors list is for.
          progress: { total: 12, processed: 0, created: 0, skipped: 0, failed: 1 },
          errors: [{ row: 3, message: 'Row 3 has no title' }],
          createdBy: ME,
          startedAt: now,
          finishedAt: null,
          createdAt: now,
          updatedAt: now,
        } as ImportJob
        state.imports.push(job)
        return clone(job)
      },
      cancel: async ({ id }: Ws & { id: string }) => {
        const job = state.imports.find((j) => j.id === id)
        if (!job) throw new Error(`[mock] unknown import ${id}`)
        job.status = 'cancelled'
        job.finishedAt = new Date().toISOString()
        return clone(job)
      },
    },

    reports: {
      burndown: async ({ cycleId }: Ws & { cycleId: string }) => {
        const cycle = state.cycles.find((c) => c.id === cycleId) ?? state.cycles[0]
        if (!cycle) throw new Error('[mock] no cycle to burn down')
        // A straight ideal line and a plausible actual one: enough for the chart to be exercised
        // without pretending the mock recomputes history.
        const days = 14
        const scope = 40
        const points = Array.from({ length: days }, (_, i) => {
          const done = Math.min(scope, Math.round((i / (days - 1)) * scope * 0.85))
          return {
            // `iso` counts backwards from now, so day 0 is the furthest back and the axis reads
            // left to right the way a person reads a date.
            date: day(-(days - 1 - i)),
            remaining: scope - done,
            ideal: Math.round(scope - (i / (days - 1)) * scope),
            completed: done,
            scope,
            scopeChange: 0,
          }
        })
        return clone({ cycle, unit: 'points' as const, points })
      },
      velocity: async (_input: Ws & { projectId: string }) => ({
        unit: 'points' as const,
        cycles: state.cycles.slice(0, 4).map((c, i) => ({
          cycle: {
            id: c.id,
            number: c.number,
            name: c.name,
            startAt: c.startAt,
            endAt: c.endAt,
            status: c.status,
          },
          committed: 30 + i * 4,
          completed: 26 + i * 3,
          committedCount: 12 + i,
          completedCount: 10 + i,
        })),
        average: 29,
      }),
      cfd: async ({ from, to }: Ws & { from: string; to: string }) => {
        const start = Date.parse(from)
        const days = Math.max(1, Math.round((Date.parse(to) - start) / DAY) + 1)
        // Work flows: the backlog drains, in-progress bulges in the middle, done climbs. A flat
        // demo would make the chart look broken rather than calm.
        const shape = (i: number) => {
          const t = days > 1 ? i / (days - 1) : 1
          return {
            backlog: Math.round(20 - 12 * t),
            todo: Math.round(6 + 3 * Math.sin(t * Math.PI)),
            in_progress: Math.round(3 + 6 * Math.sin(t * Math.PI)),
            in_review: Math.round(1 + 3 * Math.sin(t * Math.PI * 0.8)),
            done: Math.round(2 + 22 * t),
          }
        }
        return {
          statuses: statuses
            .filter((st) => ['backlog', 'todo', 'in_progress', 'in_review', 'done'].includes(st.id))
            .map((st) => ({ id: st.id, name: st.name, category: st.category, color: st.color })),
          points: Array.from({ length: days }, (_, i) => ({
            date: new Date(start + i * DAY).toISOString().slice(0, 10),
            counts: shape(i) as Record<string, number>,
          })),
        }
      },
      createdVsResolved: async ({ from, to }: Ws & { from: string; to: string }) => {
        const start = Date.parse(from)
        const days = Math.max(1, Math.round((Date.parse(to) - start) / DAY) + 1)
        let open = 18
        const points = Array.from({ length: days }, (_, i) => {
          const created = (i % 5) + 1
          const resolved = (i % 4) + 1
          open = Math.max(0, open + created - resolved)
          return {
            date: new Date(start + i * DAY).toISOString().slice(0, 10),
            created,
            resolved,
            openTotal: open,
          }
        })
        return { points }
      },
      time: async ({ from, to }: Ws & { from: string; to: string }) => {
        const withTime = state.issues.filter((i) => i.timeSpentSec > 0).slice(0, 10)
        const totalSec = withTime.reduce((sum, i) => sum + i.timeSpentSec, 0)
        return clone({
          from,
          to,
          totalSec,
          billableSec: Math.round(totalSec * 0.8),
          rows: [],
          byUser: totalSec
            ? [{ userId: ME, durationSec: totalSec, billableSec: Math.round(totalSec * 0.8) }]
            : [],
          byIssue: withTime.map((issue) => ({
            issueId: issue.id,
            issueKey: issue.key,
            title: issue.title,
            durationSec: issue.timeSpentSec,
            originalEstimateSec: issue.estimate ? issue.estimate * 3600 : null,
            remainingSec: null,
          })),
        })
      },
    },

    triage: {
      accept: async ({ issueId }: Ws & { issueId: string }) => {
        const issue = find(issueId)
        // Out of triage into the workflow's first real status, the way the server does it.
        const target = statuses.find((s) => s.category !== 'triage')
        if (target) {
          issue.statusId = target.id
          issue.statusCategory = target.category
        }
        issue.triage = false
        issue.snoozedUntil = null
        touch(issue)
        return clone(issue)
      },
      decline: async ({ issueId }: Ws & { issueId: string }) => {
        const issue = find(issueId)
        const cancelled = statuses.find((s) => s.category === 'cancelled')
        if (cancelled) {
          issue.statusId = cancelled.id
          issue.statusCategory = cancelled.category
        }
        issue.triage = false
        issue.cancelledAt = new Date().toISOString()
        touch(issue)
        return clone(issue)
      },
      snooze: async ({ issueId, until }: Ws & { issueId: string; until: string }) => {
        const issue = find(issueId)
        issue.snoozedUntil = until
        touch(issue)
        return clone(issue)
      },
    },

    views: {
      list: async (_input: Ws): Promise<View[]> => clone(state.views),
      get: async ({ id }: Ws & { id: string }) => {
        const view = state.views.find((v) => v.id === id)
        if (!view) throw new Error(`[mock] unknown view ${id}`)
        return clone(view)
      },
      create: async (input: Ws & Partial<View> & { name: string }) => {
        const now = new Date().toISOString()
        const view: View = {
          id: uid(2000 + state.views.length),
          workspaceId: WORKSPACE,
          projectId: null,
          name: input.name,
          description: null,
          icon: null,
          kql: input.kql ?? '',
          layout: input.layout ?? 'list',
          display: { groupBy: 'status', ...(input.display ?? {}) } as View['display'],
          filters: {} as View['filters'],
          visibility: input.visibility ?? 'private',
          ownerId: ME,
          pinned: false,
          builtin: false,
          order: state.views.length,
          createdAt: now,
          updatedAt: now,
        }
        state.views.push(view)
        return clone(view)
      },
      update: async ({ id, patch }: Ws & { id: string; patch: Partial<View> }) => {
        const view = state.views.find((v) => v.id === id)
        if (!view) throw new Error(`[mock] unknown view ${id}`)
        Object.assign(view, patch, { updatedAt: new Date().toISOString() })
        return clone(view)
      },
      delete: async ({ id }: Ws & { id: string }) => {
        state.views = state.views.filter((v) => v.id !== id)
        return { ok: true as const }
      },
      pin: async ({ id, pinned }: Ws & { id: string; pinned: boolean }) => {
        const view = state.views.find((v) => v.id === id)
        if (!view) throw new Error(`[mock] unknown view ${id}`)
        view.pinned = pinned
        return clone(view)
      },
    },

    kql: {
      fields: async (_input: Ws) =>
        [
          ...SYSTEM_FIELD_INFO,
          ...fields.map((f) => ({
            name: `cf.${f.key}`,
            type: f.type === 'number' ? ('number' as const) : ('enum' as const),
            label: f.name,
            operators: ['=', '!=', 'in', 'not-in', 'is-empty', 'is-not-empty'],
            values: f.options.map((o) => ({ value: o.label, label: o.label })),
            custom: true,
            sortable: true,
          })),
        ] as never,
      parse: async ({ kql }: Ws & { kql: string }) => {
        const parsed = parseKql(kql)
        return {
          ok: parsed.ok,
          ast: parsed.ast as unknown,
          errors: parsed.errors,
          normalized: parsed.normalized,
          suggestions: parsed.suggestions,
        }
      },
    },

    issues: {
      query: async (
        input: Ws & {
          kql?: string
          projectIds?: string[]
          orderBy?: Array<{ field: string; dir: 'asc' | 'desc' }>
          groupBy?: GroupBy
          limit?: number
          includeArchived?: boolean
        },
      ) => {
        const parsed = parseKql(input.kql ?? '')
        const where = parsed.ok ? (parsed.ast?.where ?? null) : null
        let items = state.issues
          .filter((i) => input.includeArchived || i.archivedAt === null)
          .filter((i) => !input.projectIds?.length || input.projectIds.includes(i.projectId))
          .filter((i) => matches(i, where))

        const order = input.orderBy?.length ? input.orderBy : (parsed.ast?.orderBy ?? [])
        if (order.length) {
          items = [...items].sort((a, b) => {
            for (const o of order) {
              const av = sortKey(a, o.field)
              const bv = sortKey(b, o.field)
              const d = av < bv ? -1 : av > bv ? 1 : 0
              if (d !== 0) return o.dir === 'desc' ? -d : d
            }
            return a.rank < b.rank ? -1 : 1
          })
        } else {
          items = [...items].sort((a, b) => (a.rank < b.rank ? -1 : 1))
        }

        return {
          items: clone(items.slice(0, input.limit ?? 100)),
          nextCursor: null,
          total: items.length,
          fields: [],
        }
      },

      get: async ({ issueId }: Ws & { issueId: string }) => clone(find(issueId)),
      getByKey: async ({ key }: Ws & { key: string }) => {
        const issue = state.issues.find((i) => i.key.toLowerCase() === key.toLowerCase())
        if (!issue) throw new Error(`[mock] unknown issue ${key}`)
        return clone(issue)
      },
      getMany: async ({ ids }: Ws & { ids: string[] }) =>
        clone(state.issues.filter((i) => ids.includes(i.id))),

      create: async (
        input: Ws & {
          projectId: string
          title: string
          typeId?: string
          description?: Issue['description']
          priority?: Priority
          assigneeIds?: Uid[]
          labelIds?: string[]
          estimate?: number | null
          dueDate?: string | null
          cycleId?: string | null
          statusId?: string
        },
      ) => {
        const proj = projects.find((p) => p.id === input.projectId) ?? (projects[0] as Project)
        const number = (state.counters.get(proj.id) ?? 0) + 1
        state.counters.set(proj.id, number)
        const status = statusById.get(input.statusId ?? 'todo') ?? (statuses[2] as StatusInfo)
        const text = input.description?.content?.length ? plainText(input.description) : ''
        const issue: Issue = {
          ...(state.issues[0] as Issue),
          id: uid(1000 + state.issues.length),
          projectId: proj.id,
          key: `${proj.key}-${number}`,
          number,
          typeId: input.typeId ?? (types[0] as WorkItemType).id,
          title: input.title,
          description: input.description ?? null,
          descriptionText: text,
          statusId: status.id,
          statusCategory: status.category,
          priority: input.priority ?? 'none',
          assigneeIds: input.assigneeIds ?? [],
          reporterId: ME,
          creatorId: ME,
          labelIds: input.labelIds ?? [],
          cycleId: input.cycleId ?? null,
          milestoneId: null,
          rank: rankSequence(1)[0] as string,
          estimate: input.estimate ?? null,
          dueDate: input.dueDate ?? null,
          completedAt: null,
          cancelledAt: null,
          resolution: null,
          custom: {},
          watcherIds: [ME],
          subscriberCount: 1,
          commentCount: 0,
          attachmentCount: 0,
          relationSummary: emptyRelations(),
          timeSpentSec: 0,
          triage: status.category === 'triage',
          source: 'app',
          archivedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
        }
        // new work lands at the top of its column, which is where people look for it
        const first = state.issues[0]
        if (first) issue.rank = rankBetweenSafe(null, first.rank)
        state.issues.unshift(issue)
        return clone(issue)
      },

      update: async ({ issueId, patch }: Ws & { issueId: string; patch: Record<string, unknown> }) => {
        const issue = find(issueId)
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) continue
          if (key === 'assigneeAdd') {
            issue.assigneeIds = [...new Set([...issue.assigneeIds, ...(value as Uid[])])]
          } else if (key === 'assigneeRemove') {
            issue.assigneeIds = issue.assigneeIds.filter((a) => !(value as UserId[]).includes(a))
          } else if (key === 'labelAdd') {
            issue.labelIds = [...new Set([...issue.labelIds, ...(value as string[])])]
          } else if (key === 'labelRemove') {
            issue.labelIds = issue.labelIds.filter((l) => !(value as string[]).includes(l))
          } else if (key === 'custom') {
            issue.custom = { ...issue.custom, ...(value as Record<string, unknown>) }
          } else if (key === 'description') {
            issue.description = value as Issue['description']
            issue.descriptionText = plainText(issue.description)
          } else {
            ;(issue as unknown as Record<string, unknown>)[key] = value
          }
        }
        touch(issue)
        return clone(issue)
      },

      move: async ({ issueId, projectId }: Ws & { issueId: string; projectId: string }) => {
        const issue = find(issueId)
        const project = projects.find((p) => p.id === projectId)
        if (!project) throw new Error(`[mock] unknown project ${projectId}`)
        // The key belongs to the project, so moving re-keys the issue — the same thing the server
        // does, and the reason the panel has to follow the new key afterwards.
        const next = (state.counters.get(projectId) ?? 0) + 1
        state.counters.set(projectId, next)
        issue.projectId = projectId
        issue.key = `${project.key}-${next}`
        issue.number = next
        // Relations render by key through this map, so a stale entry would show the old key on
        // every issue that points at this one.
        issueKeyById.set(issue.id, issue.key)
        // Nothing project-scoped survives the move; the server clears these for the same reason.
        issue.componentIds = []
        issue.versionIds = []
        issue.cycleId = null
        issue.milestoneId = null
        touch(issue)
        return clone(issue)
      },

      bulkUpdate: async ({ ids, patch }: Ws & { ids: string[]; patch: Record<string, unknown> }) => {
        const results = ids.map((id) => {
          const issue = state.issues.find((i) => i.id === id)
          if (!issue) return { id, ok: false, error: { code: 'NOT_FOUND', message: 'Unknown issue' } }
          Object.assign(issue, patch)
          touch(issue)
          return { id, ok: true }
        })
        return {
          results,
          succeeded: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
        }
      },

      rank: async ({
        issueId,
        afterId,
        beforeId,
      }: Ws & {
        issueId: string
        afterId?: string
        beforeId?: string
      }) => {
        const issue = find(issueId)
        const after = afterId ? find(afterId).rank : null
        const before = beforeId ? find(beforeId).rank : null
        issue.rank = rankBetweenSafe(after, before)
        touch(issue)
        return { id: issue.id, rank: issue.rank }
      },

      archive: async ({ issueId, archived = true }: Ws & { issueId: string; archived?: boolean }) => {
        const issue = find(issueId)
        issue.archivedAt = archived ? new Date().toISOString() : null
        touch(issue)
        return clone(issue)
      },

      delete: async ({ issueId }: Ws & { issueId: string }) => {
        state.issues = state.issues.filter((i) => i.id !== issueId)
        // What the screen promises goes with it: the server cascades these, so the demo must too.
        state.comments = state.comments.filter((c) => c.issueId !== issueId)
        state.attachments = state.attachments.filter((a) => a.issueId !== issueId)
        return { ok: true as const }
      },

      history: async ({ issueId }: Ws & { issueId: string }) => ({
        items: clone(state.history.filter((h) => h.issueId === issueId)),
        statusHistory: [],
        nextCursor: null,
      }),

      watchers: {
        add: async ({ issueId, userId }: Ws & { issueId: string; userId?: Uid }) => {
          const issue = find(issueId)
          issue.watcherIds = [...new Set([...issue.watcherIds, userId ?? ME])]
          return { watcherIds: [...issue.watcherIds] }
        },
        remove: async ({ issueId, userId }: Ws & { issueId: string; userId: Uid }) => {
          const issue = find(issueId)
          issue.watcherIds = issue.watcherIds.filter((w) => w !== userId)
          return { watcherIds: [...issue.watcherIds] }
        },
      },

      transitions: {
        available: async ({ issueId }: Ws & { issueId: string }) => {
          const issue = find(issueId)
          return statuses
            .filter((s) => s.id !== issue.statusId)
            .map((s) => ({
              id: `to:${s.id}`,
              name: s.name,
              toStatusId: s.id,
              toStatus: clone(s),
              allowed: true,
              reasons: [],
              // Closing needs a sign-off in the demo, so an approval is something you can see
              // and decide rather than a screen nobody ever reaches.
              requiresApproval: s.category === 'done',
              screen: null,
              hidden: false,
            }))
        },
        apply: async ({ issueId, transitionId }: Ws & { issueId: string; transitionId: string }) => {
          const issue = find(issueId)
          const target = statusById.get(transitionId.replace(/^to:/, ''))
          if (!target) throw new Error(`[mock] unknown transition ${transitionId}`)
          if (target.category === 'done') {
            const existing = state.approvals.find(
              (a) => a.issueId === issue.id && a.state.transitionId === transitionId,
            )
            if (existing?.state.status !== 'approved') {
              // Park it: the issue stays where it is until somebody signs off.
              const approval = existing ?? newApproval(issue.id, transitionId)
              if (!existing) state.approvals.push(approval)
              return { issue: clone(issue), approval: clone(approval) }
            }
          }
          state.history.push({
            id: uid(1200 + state.history.length),
            issueId: issue.id,
            actorId: ME,
            action: 'status_changed',
            changes: [{ field: 'status', from: issue.statusId, to: target.id }],
            data: {},
            occurredAt: new Date().toISOString(),
          })
          issue.statusId = target.id
          issue.statusCategory = target.category
          issue.triage = target.category === 'triage'
          issue.completedAt = target.category === 'done' ? new Date().toISOString() : null
          issue.cancelledAt = target.category === 'cancelled' ? new Date().toISOString() : null
          touch(issue)
          return { issue: clone(issue), approval: null }
        },
      },

      templates: {
        // Filtered, because a template belongs to one project and the project's own page asks for
        // its own: an unfiltered list showed another team's templates as if they were yours.
        list: async ({ projectId }: Ws & { projectId?: string }) =>
          clone(state.issueTemplates.filter((t) => !projectId || t.projectId === projectId)),
        create: async (
          input: Ws & {
            name: string
            projectId?: string | null
            description?: string | null
            defaults?: IssueTemplate['defaults']
          },
        ) => {
          const now = new Date().toISOString()
          const template: IssueTemplate = {
            // Its own range: 2600 is the milestones', and two objects sharing an id made one of
            // them unremovable, since a delete matches by id alone.
            id: uid(3100 + state.issueTemplates.length),
            workspaceId: WORKSPACE,
            projectId: input.projectId ?? null,
            name: input.name,
            description: input.description ?? null,
            typeId: null,
            defaults: input.defaults ?? {},
            subItems: [],
            createdBy: ME,
            createdAt: now,
            updatedAt: now,
          }
          state.issueTemplates.push(template)
          return clone(template)
        },
        update: async ({ id, patch }: Ws & { id: string; patch: Partial<IssueTemplate> }) => {
          const template = state.issueTemplates.find((t) => t.id === id)
          if (!template) throw new Error(`[mock] unknown issue template ${id}`)
          Object.assign(template, patch, { updatedAt: new Date().toISOString() })
          return clone(template)
        },
        delete: async ({ id }: Ws & { id: string }) => {
          state.issueTemplates = state.issueTemplates.filter((t) => t.id !== id)
          return { ok: true as const }
        },
      },

      recurring: {
        list: async ({ projectId }: Ws & { projectId: string }) =>
          clone(state.recurring.filter((r) => r.projectId === projectId)),
        create: async (input: Ws & { projectId: string; name: string; rule: RecurrenceRule }) => {
          const now = new Date().toISOString()
          const entry: RecurringIssue = {
            id: uid(2700 + state.recurring.length),
            workspaceId: WORKSPACE,
            projectId: input.projectId,
            name: input.name,
            rule: input.rule,
            defaults: { title: input.name },
            enabled: true,
            // The real scheduler computes this; the mock says "tomorrow", which is enough for the
            // row to show something a person can sanity-check.
            nextRunAt: iso(-DAY),
            lastRunAt: null,
            lastIssueId: null,
            runCount: 0,
            createdBy: ME,
            createdAt: now,
            updatedAt: now,
          }
          state.recurring.push(entry)
          return clone(entry)
        },
        update: async ({ id, patch }: Ws & { id: string; patch: Partial<RecurringIssue> }) => {
          const entry = state.recurring.find((r) => r.id === id)
          if (!entry) throw new Error(`[mock] unknown recurring issue ${id}`)
          Object.assign(entry, patch, { updatedAt: new Date().toISOString() })
          return clone(entry)
        },
        delete: async ({ id }: Ws & { id: string }) => {
          state.recurring = state.recurring.filter((r) => r.id !== id)
          return { ok: true as const }
        },
      },

      comments: {
        list: async ({ issueId }: Ws & { issueId: string }) => ({
          items: clone(
            state.comments
              .filter((c) => c.issueId === issueId)
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
          ),
          nextCursor: null,
        }),
        create: async ({
          issueId,
          body,
          parentId,
          internal,
        }: Ws & {
          issueId: string
          body: Comment['body']
          parentId?: string | null
          internal?: boolean
        }) => {
          const issue = find(issueId)
          const comment: Comment = {
            id: uid(1100 + state.comments.length),
            workspaceId: WORKSPACE,
            issueId,
            parentId: parentId ?? null,
            authorId: ME,
            body,
            bodyText: plainText(body),
            mentionIds: [],
            reactions: [],
            internal: internal ?? false,
            source: 'app',
            replyCount: 0,
            editedAt: null,
            deletedAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          state.comments.push(comment)
          issue.commentCount += 1
          if (comment.parentId) {
            const parent = state.comments.find((c) => c.id === comment.parentId)
            if (parent) parent.replyCount += 1
          }
          touch(issue)
          return clone(comment)
        },
        update: async ({ commentId, body }: Ws & { commentId: string; body: Comment['body'] }) => {
          const comment = state.comments.find((c) => c.id === commentId)
          if (!comment) throw new Error(`[mock] unknown comment ${commentId}`)
          comment.body = body
          comment.bodyText = plainText(body)
          comment.editedAt = new Date().toISOString()
          comment.updatedAt = comment.editedAt
          return clone(comment)
        },
        react: async ({ commentId, emoji }: Ws & { commentId: string; emoji: string }) => {
          const comment = state.comments.find((c) => c.id === commentId)
          if (!comment) throw new Error(`[mock] unknown comment ${commentId}`)
          const existing = comment.reactions.find((r) => r.emoji === emoji)
          if (!existing) {
            comment.reactions = [...comment.reactions, { emoji, count: 1, userIds: [ME] }]
          } else if (existing.userIds.includes(ME)) {
            existing.userIds = existing.userIds.filter((u) => u !== ME)
            existing.count = existing.userIds.length
            comment.reactions = comment.reactions.filter((r) => r.count > 0)
          } else {
            existing.userIds = [...existing.userIds, ME]
            existing.count = existing.userIds.length
          }
          return clone(comment)
        },
        delete: async ({ commentId }: Ws & { commentId: string }) => {
          const comment = state.comments.find((c) => c.id === commentId)
          state.comments = state.comments.filter((c) => c.id !== commentId)
          // The files that arrived with it go too: nothing else points at them.
          state.attachments = state.attachments.filter((a) => a.commentId !== commentId)
          if (comment) {
            const issue = state.issues.find((i) => i.id === comment.issueId)
            if (issue) issue.commentCount = Math.max(0, issue.commentCount - 1)
          }
          return { ok: true as const }
        },
      },
      approvals: {
        list: async ({ issueId }: Ws & { issueId: string }) =>
          clone(state.approvals.filter((a) => a.issueId === issueId)),
        decide: async ({
          issueId,
          transitionId,
          decision,
          comment,
        }: Ws & {
          issueId: string
          transitionId: string
          decision: 'approve' | 'reject'
          comment?: string
        }) => {
          const approval = state.approvals.find(
            (a) => a.issueId === issueId && a.state.transitionId === transitionId,
          )
          if (!approval) throw new Error(`[mock] no approval for ${transitionId}`)
          approval.state.decisions = [
            ...approval.state.decisions,
            { userId: ME, decision, comment: comment ?? null, at: new Date().toISOString() },
          ]
          const approved = approval.state.decisions.filter(
            (d: { decision: string }) => d.decision === 'approve',
          ).length
          approval.state.status =
            decision === 'reject' && approval.state.spec.rejectOnAnyRejection
              ? 'rejected'
              : approved >= approval.state.spec.minApprovals
                ? 'approved'
                : 'pending'
          approval.updatedAt = new Date().toISOString()

          // An approval that completes applies the transition it was blocking.
          let issue: Issue | null = null
          if (approval.state.status === 'approved') {
            const target = statusById.get(transitionId.replace(/^to:/, ''))
            const row = find(issueId)
            if (target) {
              row.statusId = target.id
              row.statusCategory = target.category
              row.completedAt = new Date().toISOString()
              touch(row)
            }
            issue = clone(row)
          }
          return { approval: clone(approval), issue }
        },
      },
      relations: {
        list: async ({ issueId }: Ws & { issueId: string }) =>
          clone(state.relations.filter((r) => relationOwner.get(r.id) === issueId)),
        create: async ({
          issueId,
          type,
          targetIssueId,
        }: Ws & { issueId: string; type: RelationType; targetIssueId: string }) => {
          const target = find(targetIssueId)
          const source = find(issueId)
          const id = uid(1500 + state.relations.length)
          const inverseId = uid(1500 + state.relations.length + 1)
          const at = new Date().toISOString()
          // Both directions, the way the server writes them: an issue that blocks another is
          // blocked-by from the other side, and each end lists its own view.
          state.relations.push({ id, type, issue: summaryOf(target), createdAt: at })
          relationOwner.set(id, issueId)
          state.relations.push({
            id: inverseId,
            type: RELATION_INVERSE[type],
            issue: summaryOf(source),
            createdAt: at,
          })
          relationOwner.set(inverseId, targetIssueId)
          inverseOf.set(id, inverseId)
          inverseOf.set(inverseId, id)
          return clone(state.relations.filter((r) => relationOwner.get(r.id) === issueId))
        },
        delete: async ({ relationId }: Ws & { relationId: string }) => {
          const partner = inverseOf.get(relationId)
          state.relations = state.relations.filter((r) => r.id !== relationId && r.id !== partner)
          return { ok: true as const }
        },
      },
      links: {
        list: async ({ issueId }: Ws & { issueId: string }) =>
          clone(state.links.filter((l) => l.issueId === issueId)),
        add: async ({
          issueId,
          url,
          title,
          kind,
        }: Ws & { issueId: string; url: string; title?: string; kind?: string }) => {
          const link: Link = {
            id: uid(1600 + state.links.length),
            workspaceId: WORKSPACE,
            issueId,
            url,
            title: title ?? null,
            kind: kind ?? 'generic',
            createdBy: ME,
            createdAt: new Date().toISOString(),
          }
          state.links.push(link)
          return clone(link)
        },
        remove: async ({ linkId }: Ws & { linkId: string }) => {
          state.links = state.links.filter((l) => l.id !== linkId)
          return { ok: true as const }
        },
      },
      attachments: {
        list: async ({ issueId }: Ws & { issueId: string }) =>
          clone(state.attachments.filter((a) => a.issueId === issueId)),
        add: async ({
          issueId,
          fileIds,
          commentId,
        }: Ws & { issueId: string; fileIds: string[]; commentId?: string | null }) => {
          const issue = find(issueId)
          const added: Attachment[] = fileIds.map((fileId, i) => ({
            id: uid(1400 + state.attachments.length + i),
            workspaceId: WORKSPACE,
            issueId,
            commentId: commentId ?? null,
            fileId,
            name: mockFileName(fileId),
            mimeType: 'application/octet-stream',
            size: 24_000,
            uploadedBy: ME,
            createdAt: new Date().toISOString(),
          }))
          state.attachments = [...state.attachments, ...added]
          issue.attachmentCount = state.attachments.filter((a) => a.issueId === issueId).length
          touch(issue)
          return clone(added)
        },
        remove: async ({ attachmentId }: Ws & { attachmentId: string }) => {
          const gone = state.attachments.find((a) => a.id === attachmentId)
          state.attachments = state.attachments.filter((a) => a.id !== attachmentId)
          if (gone) {
            const issue = state.issues.find((i) => i.id === gone.issueId)
            if (issue)
              issue.attachmentCount = state.attachments.filter((a) => a.issueId === gone.issueId).length
          }
          return { ok: true as const }
        },
      },
    },
  }
}

/**
 * The other side of each relation. The real server owns this mapping and returns both views; the
 * mock has to write both halves itself, and the client entry exports types only, so it is repeated
 * here rather than imported from the contract.
 */
const RELATION_INVERSE: Record<RelationType, RelationType> = {
  blocks: 'blocked_by',
  blocked_by: 'blocks',
  relates: 'relates',
  duplicates: 'duplicated_by',
  duplicated_by: 'duplicates',
  clones: 'cloned_by',
  cloned_by: 'clones',
}

/** A fresh pending approval, shaped the way the workflow engine writes one. */
function newApproval(issueId: string, transitionId: string): IssueApproval {
  const at = new Date().toISOString()
  return {
    id: uid(1700 + approvalCounter++),
    workspaceId: WORKSPACE,
    issueId,
    transitionId,
    state: {
      transitionId,
      spec: { approvers: [{ kind: 'role', id: 'admin' }], minApprovals: 1, rejectOnAnyRejection: true },
      requestedBy: ME,
      requestedAt: at,
      decisions: [],
      status: 'pending',
    },
    createdAt: at,
    updatedAt: at,
  } as IssueApproval
}
let approvalCounter = 0

/** Which issue each relation view belongs to, and which view is its other half. */
const relationOwner = new Map<string, string>()
const inverseOf = new Map<string, string>()

/** The subset of an issue a relation shows. */
function summaryOf(issue: Issue): RelationView['issue'] {
  return {
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
  } as RelationView['issue']
}

/** The mock uploader keeps bytes in memory and names them by id; show something readable. */
function mockFileName(fileId: string): string {
  return `file-${fileId.slice(0, 8)}`
}

function plainText(doc: Issue['description'] | Comment['body']): string {
  const walk = (node: unknown): string => {
    if (!node || typeof node !== 'object') return ''
    const n = node as { text?: string; content?: unknown[] }
    if (typeof n.text === 'string') return n.text
    return (n.content ?? []).map(walk).join(' ')
  }
  return doc ? walk(doc).trim() : ''
}

/** A drop can land next to an equal rank after a concurrent edit; a fresh key is better than a throw. */
function rankBetweenSafe(before: string | null, after: string | null): string {
  try {
    return rankBetween(before, after)
  } catch {
    return rankBetween(null, null)
  }
}

const SYSTEM_FIELD_INFO = [
  {
    name: 'project',
    type: 'ref',
    label: 'Project',
    operators: ['=', '!=', 'in', 'not-in'],
    custom: false,
    sortable: true,
  },
  {
    name: 'status',
    type: 'ref',
    label: 'Status',
    operators: ['=', '!=', 'in', 'not-in'],
    custom: false,
    sortable: true,
  },
  {
    name: 'priority',
    type: 'enum',
    label: 'Priority',
    operators: ['=', '!=', 'in', 'not-in'],
    custom: false,
    sortable: true,
    values: [
      { value: 'urgent', label: 'Urgent' },
      { value: 'high', label: 'High' },
      { value: 'medium', label: 'Medium' },
      { value: 'low', label: 'Low' },
      { value: 'none', label: 'None' },
    ],
  },
  {
    name: 'assignee',
    type: 'user',
    label: 'Assignee',
    operators: ['=', '!=', 'in', 'not-in', 'is-empty', 'is-not-empty'],
    custom: false,
    sortable: false,
  },
  {
    name: 'label',
    type: 'ref',
    label: 'Label',
    operators: ['=', '!=', 'in', 'not-in', 'is-empty'],
    custom: false,
    sortable: false,
  },
  {
    name: 'cycle',
    type: 'ref',
    label: 'Cycle',
    operators: ['=', '!=', 'in', 'not-in'],
    custom: false,
    sortable: true,
  },
  {
    name: 'due',
    type: 'date',
    label: 'Due date',
    operators: ['=', '!=', '<', '<=', '>', '>='],
    custom: false,
    sortable: true,
  },
  { name: 'text', type: 'text', label: 'Full text', operators: ['~', '!~'], custom: false, sortable: false },
]
