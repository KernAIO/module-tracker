import type { TrackerCatalogue } from './context.svelte.js'
import type { Preset } from './filters.js'
import { t } from './i18n.js'
import type { EstimateUnit, GroupBy, GroupKey, Priority, Project, StatusCategory } from './index.js'

/**
 * What the tracker's own vocabulary is called on screen.
 *
 * Group keys, priorities and presets are ids and enums in the data; every place they are shown to a
 * person goes through here, so the interface has one translation of each and Persian, German and
 * Arabic get them all.
 */

/** What a group heading draws next to its name. */
export type GroupBadge =
  | { kind: 'status'; id: string; category: StatusCategory }
  | { kind: 'priority'; priority: Priority }
  | { kind: 'person'; id: string; name: string; avatarUrl: string | null }
  | { kind: 'colour'; color: string | null }

/**
 * The built-in groupings the toolbar offers, in order (DESIGN.md 2.5).
 *
 * The last four are how a project is planned rather than how work is triaged, which is also how the
 * sidebar reaches them — a project's "Components" row is this list grouped by component, so the two
 * cannot offer different things.
 */
export const GROUP_CYCLE: GroupBy[] = [
  'status',
  'priority',
  'assignee',
  'project',
  'component',
  'milestone',
  'cycle',
]

export function groupByLabel(groupBy: GroupBy): string {
  switch (groupBy) {
    case 'status':
      return t('group_status')
    case 'priority':
      return t('group_priority')
    case 'assignee':
      return t('group_assignee')
    case 'label':
      return t('group_label')
    case 'project':
      return t('group_project')
    case 'cycle':
      return t('group_cycle')
    case 'component':
      return t('group_component')
    case 'milestone':
      return t('group_milestone')
    case 'type':
      return t('group_type')
    default:
      return t('group_none')
  }
}

/**
 * An estimate, in the unit its project keeps.
 *
 * A project decides whether it estimates in points or in hours (`settings.estimation`), and every
 * issue carries the unit it was raised under — so a row asks the issue rather than assuming. The
 * whole interface said "pts" regardless, which made an hours project read as story points.
 */
export function estimateLabel(value: number, unit: EstimateUnit): string {
  return unit === 'hours' ? t('hours', { count: value }) : t('points', { count: value })
}

/** What a project estimates in; `none` means it does not, and nothing should offer to. */
export const estimateUnitOf = (project: Project | null | undefined): EstimateUnit =>
  project?.settings.estimation ?? 'points'

export function priorityLabel(priority: Priority): string {
  switch (priority) {
    case 'urgent':
      return t('priority_urgent')
    case 'high':
      return t('priority_high')
    case 'medium':
      return t('priority_medium')
    case 'low':
      return t('priority_low')
    default:
      return t('priority_none')
  }
}

/**
 * The heading for one group: what to call it, and the badge that goes in front of it.
 *
 * `null` is the group for issues that have no value for the field, and it reads differently per
 * field — "Unassigned" for people, "No cycle" for planning — which is why this is one place rather
 * than a fallback string sprinkled through the components.
 */
export function describeGroup(
  key: GroupKey,
  /** a built-in group key or `cf.<key>` */
  groupBy: string,
  cat: TrackerCatalogue,
): { label: string; badge?: GroupBadge } {
  if (groupBy === 'none') return { label: t('all_issues') }

  // A custom field's value is stored as an option id, so the heading has to ask the field what it
  // is called — otherwise a column reads `opt_7f3a` instead of `Sev 1`.
  const custom = /^cf\.(.+)$/.exec(groupBy)
  if (custom) {
    if (key === null) return { label: t('group_none') }
    return { label: cat.customValueLabel(custom[1]!, key) }
  }

  if (key === null) {
    switch (groupBy) {
      case 'assignee':
        return { label: t('unassigned') }
      case 'label':
        return { label: t('no_label') }
      case 'cycle':
        return { label: t('no_cycle') }
      case 'milestone':
        return { label: t('no_milestone') }
      case 'component':
        return { label: t('no_component') }
      default:
        return { label: t('group_none') }
    }
  }

  switch (groupBy as GroupBy) {
    case 'status': {
      const status = cat.status(key)
      return {
        label: status?.name ?? key,
        badge: { kind: 'status', id: key, category: status?.category ?? 'todo' },
      }
    }
    case 'statusCategory':
      return { label: key, badge: { kind: 'status', id: key, category: key as StatusCategory } }
    case 'priority':
      return {
        label: priorityLabel(key as Priority),
        badge: { kind: 'priority', priority: key as Priority },
      }
    case 'assignee': {
      const person = cat.person(key)
      return {
        label: person?.name ?? t('unassigned'),
        badge: { kind: 'person', id: key, name: person?.name ?? '', avatarUrl: person?.avatarUrl ?? null },
      }
    }
    case 'label': {
      const label = cat.label(key)
      return { label: label?.name ?? key, badge: { kind: 'colour', color: label?.color ?? null } }
    }
    case 'project': {
      const project = cat.project(key)
      return { label: project?.name ?? key, badge: { kind: 'colour', color: project?.color ?? null } }
    }
    case 'cycle': {
      const cycle = cat.cycle(key)
      return { label: cycle?.name ?? key }
    }
    case 'milestone': {
      const milestone = cat.milestone(key)
      return { label: milestone?.name ?? key }
    }
    case 'component': {
      // without this a components board reads `01920000-…` where a name belongs
      const component = cat.component(key)
      return { label: component?.name ?? key }
    }
    case 'type': {
      const type = cat.type(key)
      return { label: type?.name ?? key }
    }
    default:
      return { label: key }
  }
}

export function presetLabel(preset: Preset): string {
  switch (preset) {
    case 'assigned':
      return t('preset_assigned')
    case 'active':
      return t('preset_active')
    case 'backlog':
      return t('preset_backlog')
    case 'created':
      return t('preset_created')
    case 'subscribed':
      return t('preset_subscribed')
    default:
      return t('preset_all')
  }
}
