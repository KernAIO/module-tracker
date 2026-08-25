import type { Project } from './index.js'

/**
 * Where the tracker's sidebar sends you.
 *
 * Every row in the sidebar is a link to a query, not a mode the page is put into: the issues screen
 * reads what it shows from the URL, so "the components of Marketing" is `q` plus `group` and
 * nothing else — it can be linked to, opened in a second tab and gone back from. Built here rather
 * than inline so the row that produces a URL and the row that decides it is the current one cannot
 * drift apart.
 *
 * Project ids rather than keys: `project` compiles to a uuid column, and KQL reads an unquoted
 * value starting with a digit as a number.
 */
export const projectKql = (projectId: string): string => `project = ${JSON.stringify(projectId)}`

export interface TrackerTarget {
  /** the KQL the row asks for, or '' for none */
  q?: string
  /** the grouping, or undefined for the default (status) */
  group?: string
  preset?: string
}

/** A tracker link, with only the parameters the target actually needs. */
export function trackerHref(workspaceSlug: string, target: TrackerTarget = {}): string {
  const params = new URLSearchParams()
  if (target.preset) params.set('preset', target.preset)
  if (target.q) params.set('q', target.q)
  if (target.group) params.set('group', target.group)
  const query = params.toString()
  return `/${workspaceSlug}/tracker${query ? `?${query}` : ''}`
}

/** Whether the screen is showing exactly what this row asks for. */
export function isTrackerTarget(params: URLSearchParams, target: TrackerTarget = {}): boolean {
  // a saved view is its own row: while one is open no plain row is the current one
  if (params.get('view_id')) return false
  return (
    (params.get('preset') ?? '') === (target.preset ?? '') &&
    (params.get('q') ?? '') === (target.q ?? '') &&
    (params.get('group') ?? '') === (target.group ?? '')
  )
}

/**
 * A project's work, as queries.
 *
 * The groupings stay because the pages link into them — a component is worth opening as "the issues
 * in it" once you are looking at the component itself — but they are not what the sidebar's
 * Components row does any more: that opens the page where components are made.
 */
export const projectTargets = (projectId: string) => ({
  issues: { q: projectKql(projectId) } satisfies TrackerTarget,
  byComponent: { q: projectKql(projectId), group: 'component' } satisfies TrackerTarget,
  byMilestone: { q: projectKql(projectId), group: 'milestone' } satisfies TrackerTarget,
  byCycle: { q: projectKql(projectId), group: 'cycle' } satisfies TrackerTarget,
  triage: { q: `${projectKql(projectId)} and triage = true` } satisfies TrackerTarget,
})

/**
 * A project's own pages, addressed by key.
 *
 * Components, milestones, cycles and templates are things a team makes, so each is a page rather
 * than a grouping of the issue list: `/tracker/projects/KRN/components` is where you add one.
 */
export const PROJECT_SECTIONS = ['components', 'milestones', 'cycles', 'templates'] as const
export type ProjectSection = (typeof PROJECT_SECTIONS)[number]

export const isProjectSection = (value: string | undefined): value is ProjectSection =>
  PROJECT_SECTIONS.includes((value ?? '') as ProjectSection)

export const projectSectionHref = (
  workspaceSlug: string,
  projectKey: string,
  section: ProjectSection,
): string => `/${workspaceSlug}/tracker/projects/${encodeURIComponent(projectKey)}/${section}`

/** Settings pages take the project in the URL, so a menu can land on the one you clicked. */
export const projectSettingsHref = (workspaceSlug: string, page: string, projectId: string): string =>
  `/${workspaceSlug}/settings/tracker/${page}?project=${encodeURIComponent(projectId)}`

/** A project's colour square falls back to the neutral the design system uses for "no colour". */
export const projectColor = (project: Project): string => project.color ?? 'var(--kern-ink-330)'
