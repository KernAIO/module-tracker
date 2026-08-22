import type { FieldType } from '../contract/models.js'
import type { KqlOp } from './ast.js'

export type KqlFieldKind =
  | 'text'
  | 'enum'
  | 'user'
  | 'number'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'ref'
  | 'id'
  | 'key'

export interface KqlField {
  name: string
  kind: KqlFieldKind
  label: string
  /** value is a uuid[] column (membership semantics for = / in) */
  array?: boolean
  sortable?: boolean
  /** enum values for autocomplete/validation */
  enumValues?: readonly string[]
  /** ref fields resolve barewords/strings by name via the resolver (labels, cycles…) */
  refType?:
    | 'project'
    | 'type'
    | 'label'
    | 'component'
    | 'version'
    | 'cycle'
    | 'milestone'
    | 'status'
    | 'issue'
  custom?: { key: string; fieldType: FieldType }
}

const EQ: KqlOp[] = ['=', '!=', 'in', 'not-in']
const EMPTY: KqlOp[] = ['is-empty', 'is-not-empty']
const CMP: KqlOp[] = ['<', '<=', '>', '>=']
const LIKE: KqlOp[] = ['~', '!~']

export function operatorsFor(f: KqlField): KqlOp[] {
  switch (f.kind) {
    case 'text':
      return [...LIKE, '=', '!=', ...EMPTY]
    case 'enum':
      return [...EQ, ...CMP, ...EMPTY]
    case 'user':
      return [...EQ, ...EMPTY]
    case 'number':
      return ['=', '!=', ...CMP, 'in', 'not-in', ...EMPTY]
    case 'date':
    case 'datetime':
      return ['=', '!=', ...CMP, ...EMPTY]
    case 'boolean':
      return ['=', '!=']
    case 'ref':
    case 'id':
      return [...EQ, ...EMPTY]
    case 'key':
      return [...EQ, ...LIKE]
  }
}

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const
export const STATUS_CATEGORIES = ['backlog', 'todo', 'in_progress', 'done', 'cancelled', 'triage'] as const

/** System fields available in every KQL query. Custom fields are added as `cf.<key>`. */
export const SYSTEM_FIELDS: readonly KqlField[] = [
  { name: 'key', kind: 'key', label: 'Issue key', sortable: true },
  { name: 'project', kind: 'ref', refType: 'project', label: 'Project', sortable: true },
  { name: 'type', kind: 'ref', refType: 'type', label: 'Type', sortable: true },
  { name: 'title', kind: 'text', label: 'Title', sortable: true },
  { name: 'status', kind: 'ref', refType: 'status', label: 'Status', sortable: true },
  {
    name: 'statusCategory',
    kind: 'enum',
    label: 'Status category',
    enumValues: STATUS_CATEGORIES,
    sortable: true,
  },
  { name: 'priority', kind: 'enum', label: 'Priority', enumValues: PRIORITIES, sortable: true },
  { name: 'assignee', kind: 'user', array: true, label: 'Assignee' },
  { name: 'reporter', kind: 'user', label: 'Reporter' },
  { name: 'label', kind: 'ref', refType: 'label', array: true, label: 'Label' },
  { name: 'component', kind: 'ref', refType: 'component', array: true, label: 'Component' },
  { name: 'version', kind: 'ref', refType: 'version', array: true, label: 'Fix version' },
  { name: 'affectsVersion', kind: 'ref', refType: 'version', array: true, label: 'Affects version' },
  { name: 'cycle', kind: 'ref', refType: 'cycle', label: 'Cycle', sortable: true },
  { name: 'milestone', kind: 'ref', refType: 'milestone', label: 'Milestone', sortable: true },
  { name: 'parent', kind: 'ref', refType: 'issue', label: 'Parent', sortable: true },
  { name: 'created', kind: 'datetime', label: 'Created', sortable: true },
  { name: 'updated', kind: 'datetime', label: 'Updated', sortable: true },
  { name: 'completed', kind: 'datetime', label: 'Completed', sortable: true },
  { name: 'due', kind: 'date', label: 'Due date', sortable: true },
  { name: 'start', kind: 'date', label: 'Start date', sortable: true },
  { name: 'estimate', kind: 'number', label: 'Estimate', sortable: true },
  { name: 'timeSpent', kind: 'number', label: 'Time spent (s)', sortable: true },
  { name: 'watcher', kind: 'user', array: true, label: 'Watcher' },
  { name: 'resolution', kind: 'text', label: 'Resolution', sortable: true },
  { name: 'text', kind: 'text', label: 'Full text' },
  { name: 'triage', kind: 'boolean', label: 'In triage', sortable: true },
  { name: 'archived', kind: 'boolean', label: 'Archived' },
  /** sort-only pseudo field (manual order) */
  { name: 'rank', kind: 'text', label: 'Manual rank', sortable: true },
] as const

export const KQL_FUNCTIONS = [
  { name: 'currentUser', args: 0, detail: 'The authenticated user' },
  { name: 'now', args: 0, detail: 'Current timestamp' },
  { name: 'startOfDay', args: '0-1', detail: 'Midnight today (optional day offset)' },
  { name: 'startOfWeek', args: '0-1', detail: 'Start of this week (optional week offset)' },
  { name: 'startOfMonth', args: '0-1', detail: 'Start of this month (optional month offset)' },
  { name: 'membersOf', args: 1, detail: 'Members of a workspace group' },
  { name: 'activeCycle', args: 0, detail: 'The active cycle(s) of the queried projects' },
  { name: 'openCycles', args: 0, detail: 'Active + upcoming cycles' },
] as const

export function findField(fields: readonly KqlField[], name: string): KqlField | undefined {
  const lower = name.toLowerCase()
  return fields.find((f) => f.name.toLowerCase() === lower)
}

/** Map a custom field def to a KQL field (`cf.<key>`). */
export function customKqlField(key: string, fieldType: FieldType, label: string): KqlField {
  const kind: KqlFieldKind =
    fieldType === 'number' || fieldType === 'formula'
      ? 'number'
      : fieldType === 'date'
        ? 'date'
        : fieldType === 'datetime'
          ? 'datetime'
          : fieldType === 'checkbox'
            ? 'boolean'
            : fieldType === 'user' || fieldType === 'multiuser'
              ? 'user'
              : fieldType === 'select' || fieldType === 'multiselect' || fieldType === 'label'
                ? 'enum'
                : 'text'
  return {
    name: `cf.${key}`,
    kind,
    label,
    array: fieldType === 'multiselect' || fieldType === 'multiuser' || fieldType === 'label',
    sortable: kind === 'number' || kind === 'date' || kind === 'datetime' || kind === 'text',
    custom: { key, fieldType },
  }
}
