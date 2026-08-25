/**
 * Query keys for the tracker.
 *
 * Same convention as the core keys in `$lib/query`: `[module, entity, ...scope]`. The realtime
 * gateway sends `{module, entity, id}` for every change, so a tracker event invalidates exactly the
 * lists and panels that depend on it instead of refetching the whole page.
 */
export const trackerKeys = {
  projects: (workspaceId: string) => ['tracker', 'project', workspaceId] as const,
  project: (workspaceId: string, projectId: string) =>
    ['tracker', 'project', workspaceId, projectId] as const,
  statuses: (workspaceId: string) => ['tracker', 'status', workspaceId] as const,
  types: (workspaceId: string) => ['tracker', 'type', workspaceId] as const,
  labels: (workspaceId: string) => ['tracker', 'label', workspaceId] as const,
  fields: (workspaceId: string) => ['tracker', 'field', workspaceId] as const,
  cycles: (workspaceId: string, projectId: string | null) =>
    ['tracker', 'cycle', workspaceId, projectId ?? 'all'] as const,
  milestones: (workspaceId: string, projectId: string | null) =>
    ['tracker', 'milestone', workspaceId, projectId ?? 'all'] as const,
  components: (workspaceId: string, projectId: string | null) =>
    ['tracker', 'component', workspaceId, projectId ?? 'all'] as const,
  versions: (workspaceId: string, projectId: string | null) =>
    ['tracker', 'version', workspaceId, projectId ?? 'all'] as const,
  /** a project's issue templates: what somebody raises again and again */
  issueTemplates: (workspaceId: string, projectId: string | null) =>
    ['tracker', 'issue-template', workspaceId, projectId ?? 'all'] as const,
  views: (workspaceId: string) => ['tracker', 'view', workspaceId] as const,
  worklogs: (workspaceId: string, issueId: string) => ['tracker', 'worklog', workspaceId, issueId] as const,
  /** the caller's running timer, which is theirs rather than any issue's */
  timer: (workspaceId: string) => ['tracker', 'timer', workspaceId] as const,
  /** one entry per distinct query: the KQL string and ordering are the scope */
  issues: (workspaceId: string, scope: string) => ['tracker', 'issue', workspaceId, scope] as const,
  issue: (workspaceId: string, issueId: string) => ['tracker', 'issue', workspaceId, issueId] as const,
  comments: (workspaceId: string, issueId: string) => ['tracker', 'comment', workspaceId, issueId] as const,
  attachments: (workspaceId: string, issueId: string) =>
    ['tracker', 'attachment', workspaceId, issueId] as const,
  relations: (workspaceId: string, issueId: string) => ['tracker', 'relation', workspaceId, issueId] as const,
  links: (workspaceId: string, issueId: string) => ['tracker', 'link', workspaceId, issueId] as const,
  approvals: (workspaceId: string, issueId: string) => ['tracker', 'approval', workspaceId, issueId] as const,
  /** an issue's sub-issues — an issue query, but keyed to the parent it hangs off */
  children: (workspaceId: string, issueId: string) =>
    ['tracker', 'issue', workspaceId, 'children', issueId] as const,
  history: (workspaceId: string, issueId: string) => ['tracker', 'history', workspaceId, issueId] as const,
  transitions: (workspaceId: string, issueId: string) =>
    ['tracker', 'transition', workspaceId, issueId] as const,
  kqlFields: (workspaceId: string) => ['tracker', 'kql-field', workspaceId] as const,
  /** the resolved field layout of one work item type in one project */
  layout: (workspaceId: string, typeId: string, projectId: string | null) =>
    ['tracker', 'type', workspaceId, 'layout', typeId, projectId ?? 'none'] as const,
}
