import { parseKql } from './kql.js'
import type { Priority } from './types.js'

/**
 * The visual filter, and how it becomes KQL.
 *
 * The toolbar has two ways to narrow the list, and they must not fight: the Filter menu builds a
 * structured filter, the query box takes anything KQL can express. They are combined with `and`, so
 * picking two labels and typing `due <= +7d` means what it looks like it means, and clearing the
 * chip never touches what you typed.
 *
 * Deliberately free of interface strings, so the composition rules can be unit-tested on their own;
 * the names these appear under live in `./labels`.
 */
export interface TrackerFilters {
  projectIds: string[]
  statusIds: string[]
  priorities: Priority[]
  assigneeIds: string[]
  labelIds: string[]
}

export const emptyFilters = (): TrackerFilters => ({
  projectIds: [],
  statusIds: [],
  priorities: [],
  assigneeIds: [],
  labelIds: [],
})

export const filterCount = (f: TrackerFilters): number =>
  f.projectIds.length + f.statusIds.length + f.priorities.length + f.assigneeIds.length + f.labelIds.length

/** Ids are quoted: a uuid starts with a digit, which KQL would otherwise read as a number. */
const clause = (field: string, values: string[], quote = true): string | null => {
  if (values.length === 0) return null
  const rendered = values.map((v) => (quote ? JSON.stringify(v) : v))
  return values.length === 1 ? `${field} = ${rendered[0]}` : `${field} in (${rendered.join(', ')})`
}

export function filtersToKql(f: TrackerFilters): string {
  return [
    clause('project', f.projectIds),
    clause('status', f.statusIds),
    clause('priority', f.priorities, false),
    clause('assignee', f.assigneeIds),
    clause('label', f.labelIds),
  ]
    .filter((c): c is string => c !== null)
    .join(' and ')
}

/** The saved queries behind the preset tabs (DESIGN.md 2.5). */
export type Preset = 'assigned' | 'active' | 'backlog' | 'created' | 'subscribed' | 'all'

export const PRESETS: Preset[] = ['assigned', 'active', 'backlog', 'created', 'subscribed', 'all']

export function presetKql(preset: Preset): string {
  switch (preset) {
    case 'assigned':
      return 'assignee = currentUser()'
    case 'active':
      return 'statusCategory in (todo, in_progress)'
    case 'backlog':
      return 'statusCategory in (backlog, triage)'
    case 'created':
      return 'reporter = currentUser()'
    case 'subscribed':
      return 'watcher = currentUser()'
    default:
      return ''
  }
}

/**
 * A part has to be bracketed before it is joined with `and`, or its `or` swallows the parts around
 * it: `assignee = currentUser() and priority = urgent or priority = high` means "mine and urgent, or
 * anyone's high", which quietly shows other people's issues. Asking the parser is the only reliable
 * test — `OR` is a keyword whatever its case, and the word may equally appear inside a quoted value
 * ("editor or reviewer"), where it means nothing. A part we cannot parse is bracketed anyway: the
 * server rejects it either way, and this keeps the failure the user's typo rather than ours.
 */
const needsBrackets = (part: string): boolean => {
  const parsed = parseKql(part)
  if (!parsed.ok || !parsed.ast) return true
  return parsed.ast.where?.kind === 'or'
}

/** Everything the list is narrowed by, as one query the server can answer. */
export function composeKql(preset: Preset, filters: TrackerFilters, manual: string): string {
  const parts = [presetKql(preset), filtersToKql(filters), manual.trim()].filter((part) => part.length > 0)
  if (parts.length < 2) return parts[0] ?? ''
  return parts.map((part) => (needsBrackets(part) ? `(${part})` : part)).join(' and ')
}
