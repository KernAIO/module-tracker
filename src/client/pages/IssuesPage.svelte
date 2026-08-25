<script lang="ts">
import {
  Button,
  coreApi,
  DropdownMenu,
  EmptyState,
  keys,
  type MenuItem,
  navigation,
  PageHeader,
  Skeleton,
  session,
  Tabs,
  Toolbar,
  ToolbarButton,
  toast,
  ViewToggle,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import BoardView from '../components/BoardView.svelte'
import FilterMenu from '../components/FilterMenu.svelte'
import IssueDetailPanel from '../components/IssueDetailPanel.svelte'
import IssueListView from '../components/IssueListView.svelte'
import KqlInput from '../components/KqlInput.svelte'
import NewIssueDialog from '../components/NewIssueDialog.svelte'
import NewProjectDialog from '../components/NewProjectDialog.svelte'
import SaveViewDialog from '../components/SaveViewDialog.svelte'
import { setTrackerCatalogue, TrackerCatalogue } from '../context.svelte.js'
import type { CoreApi } from '../core-api.js'
import {
  composeKql,
  emptyFilters,
  filterCount,
  PRESETS,
  type Preset,
  type TrackerFilters,
} from '../filters.js'
import { t } from '../i18n.js'
import {
  customKqlField,
  type GroupBy,
  groupKeysOf,
  type Issue,
  type KqlField,
  SYSTEM_FIELDS,
  statusStyle,
} from '../index.js'
import { estimateLabel, GROUP_CYCLE, groupByLabel, presetLabel } from '../labels.js'
import { canTracker } from '../permissions.js'
import { trackerKeys } from '../query.js'

/**
 * The issues view: the list and the board over one query.
 *
 * What is being shown lives in the URL — the layout, the grouping, the preset, the query and the
 * open issue — so a view can be linked to, reloaded and shared, and the browser's back button
 * behaves the way people expect when they close a panel.
 */
const api = coreApi<CoreApi>()
const tracker = getTrackerApi()
const queryClient = useQueryClient()

const slug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === slug))
const workspaceId = $derived(workspace?.id ?? '')

// ---- URL-backed view state ------------------------------------------------------------------

const params = $derived(new URLSearchParams(navigation.search))
const layout = $derived(params.get('view') === 'board' ? 'board' : 'list')
const groupBy = $derived(params.get('group') ?? 'status')
const preset = $derived((params.get('preset') ?? 'all') as Preset)
const manualKql = $derived(params.get('q') ?? '')
/**
 * The saved view the page is showing, when it is one this person may change.
 *
 * Without this, refining a saved view and pressing Save quietly produced a second copy of it —
 * the URL knew which view was open and the dialog did not.
 */
const viewsQuery = createQuery(() => ({
  queryKey: trackerKeys.views(workspaceId),
  queryFn: () => tracker.views.list({ workspaceId }),
  enabled: Boolean(workspaceId),
}))
const canManageShared = $derived(canTracker('viewManageShared'))

const editingView = $derived.by(() => {
  const id = params.get('view_id')
  const view = id ? viewsQuery.data?.find((v) => v.id === id) : undefined
  if (!view || view.builtin) return null
  const mine = view.visibility === 'private' ? view.ownerId === session.user?.id : canManageShared
  return mine ? { id: view.id, name: view.name } : null
})
const openIssueKey = $derived(params.get('issue'))
/**
 * What a link may ask this page to open.
 *
 * The palette, the sidebar and any deep link all arrive as a parameter rather than reaching into
 * this component's state — which is also why raising an issue from the sidebar keeps the list that
 * was underneath it, and why the dialog closes by taking the parameter back off the URL.
 */
const newRequested = $derived(params.get('new') === '1')
const newProjectRequested = $derived(params.get('new_project') === '1')
const saveRequested = $derived(params.get('save') === '1')

let newProjectOpen = $state(false)
let savingView = $state(false)
/**
 * Creating a project was unreachable: the server has had `projects.create` since the module
 * existed and nothing in the interface called it, so every project came from seed data.
 */
const canCreateProject = $derived(canTracker('projectManage'))

function setParams(next: Record<string, string | null>) {
  /**
   * Built from `navigation` rather than the router's URL: a module cannot read `$app/state`, and
   * `replaceState` matters here — filtering a list should not fill the back button with every
   * intermediate filter somebody typed through.
   */
  const params = new URLSearchParams(navigation.search)
  for (const [key, value] of Object.entries(next)) {
    if (value === null || value === '') params.delete(key)
    else params.set(key, value)
  }
  const query = params.toString()
  void navigation.go(`${navigation.pathname}${query ? `?${query}` : ''}`, {
    replaceState: true,
    keepFocus: true,
    noScroll: true,
  })
}

// what this person may do here; the server checks again, this only keeps the interface honest
const canCreate = $derived(canTracker('create'))
const canTransition = $derived(canTracker('transition'))
const canEdit = $derived(canTracker('edit'))
const canBulkEdit = $derived(canTracker('bulkEdit'))

let filters = $state<TrackerFilters>(emptyFilters())
let selection = $state<string[]>([])
let creating = $state(false)
let createDefaults = $state<{ projectId?: string; statusId?: string }>({})
let listView = $state<ReturnType<typeof IssueListView> | null>(null)

// ---- reference data -------------------------------------------------------------------------

const catalogue = new TrackerCatalogue()
setTrackerCatalogue(catalogue)

const enabled = $derived(Boolean(workspaceId))

const projectsQuery = createQuery(() => ({
  queryKey: trackerKeys.projects(workspaceId),
  queryFn: () => tracker.projects.list({ workspaceId }),
  enabled,
}))
const statusesQuery = createQuery(() => ({
  queryKey: trackerKeys.statuses(workspaceId),
  queryFn: () => tracker.workflows.statuses({ workspaceId }),
  enabled,
}))
const typesQuery = createQuery(() => ({
  queryKey: trackerKeys.types(workspaceId),
  queryFn: () => tracker.types.list({ workspaceId }),
  enabled,
}))
const labelsQuery = createQuery(() => ({
  queryKey: trackerKeys.labels(workspaceId),
  queryFn: () => tracker.labels.list({ workspaceId }),
  enabled,
}))
const fieldsQuery = createQuery(() => ({
  queryKey: trackerKeys.fields(workspaceId),
  queryFn: () => tracker.fields.list({ workspaceId }),
  enabled,
}))
const membersQuery = createQuery(() => ({
  queryKey: keys.members(workspaceId),
  queryFn: () => api.workspaces.members.list({ workspaceId }),
  enabled,
}))

const projects = $derived(projectsQuery.data ?? [])

// planning data is per project, so ask for every project the workspace has and flatten
const cyclesQuery = createQuery(() => ({
  queryKey: trackerKeys.cycles(workspaceId, null),
  queryFn: async () =>
    (await Promise.all(projects.map((p) => tracker.cycles.list({ workspaceId, projectId: p.id })))).flat(),
  enabled: enabled && projects.length > 0,
}))
const milestonesQuery = createQuery(() => ({
  queryKey: trackerKeys.milestones(workspaceId, null),
  queryFn: async () =>
    (
      await Promise.all(projects.map((p) => tracker.milestones.list({ workspaceId, projectId: p.id })))
    ).flat(),
  enabled: enabled && projects.length > 0,
}))
const componentsQuery = createQuery(() => ({
  queryKey: trackerKeys.components(workspaceId, null),
  queryFn: async () =>
    (
      await Promise.all(projects.map((p) => tracker.components.list({ workspaceId, projectId: p.id })))
    ).flat(),
  enabled: enabled && projects.length > 0,
}))

$effect(() => {
  catalogue.projects = projects
})
$effect(() => {
  catalogue.statuses = statusesQuery.data ?? []
})
$effect(() => {
  catalogue.types = typesQuery.data ?? []
})
$effect(() => {
  catalogue.labels = labelsQuery.data ?? []
})
$effect(() => {
  catalogue.components = componentsQuery.data ?? []
})
$effect(() => {
  catalogue.fields = fieldsQuery.data ?? []
})
$effect(() => {
  catalogue.cycles = cyclesQuery.data ?? []
})
$effect(() => {
  catalogue.milestones = milestonesQuery.data ?? []
})
$effect(() => {
  // A member with no display name still has to be pickable, so fall back to the address rather
  // than rendering an assignee row with nothing in it.
  catalogue.people = (membersQuery.data?.items ?? []).map((member) => ({
    id: member.user.id,
    name: member.user.name ?? member.user.email,
    avatarUrl: member.user.avatarUrl ?? null,
  }))
})

/** System fields plus this workspace's custom fields, for the query box's validation. */
const kqlFields = $derived<KqlField[]>([
  ...SYSTEM_FIELDS,
  ...(fieldsQuery.data ?? []).map((f) => customKqlField(f.key, f.type, f.name)),
])

// ---- the query ------------------------------------------------------------------------------

const effectiveKql = $derived(composeKql(preset, filters, manualKql))

const issuesQuery = createQuery(() => ({
  queryKey: trackerKeys.issues(workspaceId, `${effectiveKql}|${layout}`),
  queryFn: () =>
    tracker.issues.query({
      workspaceId,
      kql: effectiveKql,
      limit: 500,
      include: { total: true, groupCounts: false, full: true },
    }),
  enabled,
}))

const issues = $derived(issuesQuery.data?.items ?? [])
const totalPoints = $derived(issues.reduce((sum, issue) => sum + (issue.estimate ?? 0), 0))

const activeCycle = $derived(catalogue.activeCycle)
const cycleProgress = $derived(
  activeCycle && activeCycle.stats.estimateTotal > 0
    ? Math.round((activeCycle.stats.estimateDone / activeCycle.stats.estimateTotal) * 100)
    : null,
)

const subtitle = $derived(
  [
    activeCycle ? activeCycle.name : presetLabel(preset),
    t('issues_count', { count: issues.length }),
    totalPoints > 0 ? estimateLabel(totalPoints, catalogue.estimateUnit) : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · '),
)

// ---- mutations ------------------------------------------------------------------------------

const moveIssue = createMutation(() => ({
  mutationFn: async (input: {
    issue: Issue
    toColumnId: string
    afterId: string | null
    beforeId: string | null
  }) => {
    // What a drop *means* depends on the grouping: into a status column it is a transition, into a
    // custom field's column it sets that field. The board reports the column and stays out of it.
    if (boardField) {
      const key = boardField.key
      const current = input.issue.custom?.[key]
      const many = boardField.type === 'multiselect' || boardField.type === 'multiuser'
      const next = many
        ? [...new Set([...(Array.isArray(current) ? (current as string[]) : []), input.toColumnId])]
        : input.toColumnId
      if (JSON.stringify(current ?? null) !== JSON.stringify(next))
        await tracker.issues.update({
          workspaceId,
          issueId: input.issue.id,
          patch: { custom: { [key]: next } },
        })
    } else if (input.issue.statusId !== input.toColumnId) {
      const toStatusId = input.toColumnId
      const available = await tracker.issues.transitions.available({
        workspaceId,
        issueId: input.issue.id,
      })
      const target = available.find((tr) => tr.toStatusId === toStatusId && tr.allowed)
      if (!target) throw new Error(t('transition_blocked', { status: toStatusId }))
      await tracker.issues.transitions.apply({
        workspaceId,
        issueId: input.issue.id,
        transitionId: target.id,
      })
    }
    await tracker.issues.rank({
      workspaceId,
      issueId: input.issue.id,
      afterId: input.afterId ?? undefined,
      beforeId: input.beforeId ?? undefined,
    })
  },
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tracker', 'issue'] }),
  onError: (error: Error) => {
    toast.error(error.message)
    void queryClient.invalidateQueries({ queryKey: ['tracker', 'issue'] })
  },
}))

const bulkPriority = createMutation(() => ({
  mutationFn: (priority: Issue['priority']) =>
    tracker.issues.bulkUpdate({ workspaceId, ids: selection, patch: { priority } }),
  onSuccess: () => {
    toast.success(t('bulk_done', { count: selection.length }))
    selection = []
    void queryClient.invalidateQueries({ queryKey: ['tracker', 'issue'] })
  },
  onError: (error: Error) => toast.error(error.message),
}))

// ---- interactions ---------------------------------------------------------------------------

function open(issue: Issue) {
  setParams({ issue: issue.key })
}

function toggleSelect(issue: Issue) {
  selection = selection.includes(issue.id)
    ? selection.filter((id) => id !== issue.id)
    : [...selection, issue.id]
}

function startCreate(defaults: { projectId?: string; statusId?: string } = {}) {
  createDefaults = { projectId: defaults.projectId ?? projects[0]?.id, statusId: defaults.statusId }
  creating = true
}

/** Only fields with a bounded set of values make sensible columns. */
const GROUPABLE_TYPES = new Set(['select', 'multiselect', 'label', 'user', 'multiuser', 'checkbox'])
const groupableFields = $derived((fieldsQuery.data ?? []).filter((f) => GROUPABLE_TYPES.has(f.type)))

/**
 * What a board or list can be grouped by: the built-in keys, then the workspace's custom fields.
 *
 * A menu rather than the cycle button this replaced — the set is open-ended now, and cycling
 * through a workspace's twelve fields to reach the thirteenth is not a control.
 */
const groupMenu = $derived<MenuItem[]>([
  ...GROUP_CYCLE.map((key) => ({
    type: 'checkbox' as const,
    id: key,
    label: groupByLabel(key),
    checked: groupBy === key,
    onCheckedChange: () => setParams({ group: key === 'status' ? null : key }),
  })),
  ...(groupableFields.length ? [{ type: 'separator' as const, id: 'custom' } as MenuItem] : []),
  ...groupableFields.map((field) => ({
    type: 'checkbox' as const,
    id: `cf.${field.key}`,
    label: field.name,
    checked: groupBy === `cf.${field.key}`,
    onCheckedChange: () => setParams({ group: `cf.${field.key}` }),
  })),
])

/** The custom field the board is grouped by, if any. */
const boardField = $derived.by(() => {
  const custom = /^cf\.(.+)$/.exec(groupBy)
  return custom ? (catalogue.field(custom[1]) ?? null) : null
})

/**
 * The board's columns. A status board takes the workflow's statuses; a field board takes the
 * field's options, so the columns are exactly the values somebody may choose.
 */
const boardColumns = $derived.by(() =>
  boardField
    ? boardField.options
        .filter((o) => !o.archived)
        .map((o) => ({ id: o.id, name: o.label, color: o.color ?? 'var(--kern-ink-330)' }))
    : catalogue.statuses.map((status) => ({
        id: status.id,
        name: status.name,
        color: statusStyle(status.category, status.id, status.name).color,
        status,
      })),
)

/** The heading for the current grouping, whether it is built in or a field somebody added. */
const currentGroupLabel = $derived.by(() => {
  const custom = /^cf\.(.+)$/.exec(groupBy)
  if (!custom) return groupByLabel(groupBy as GroupBy)
  return catalogue.field(custom[1])?.name ?? groupBy
})

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return Boolean(el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName ?? '')))
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
  if (creating) return
  if (event.key === 'c' && canCreate) {
    event.preventDefault()
    startCreate()
    return
  }
  if (event.key === 'Escape' && openIssueKey) {
    event.preventDefault()
    setParams({ issue: null })
    return
  }
  if (layout === 'list' && listView?.handleKey(event)) event.preventDefault()
}

const selected = $derived(new Set(selection))

// the palette and the sidebar navigate here with a parameter rather than reaching into this state
$effect(() => {
  if (newRequested && !creating) {
    // `?new=1&project=<id>` raises the issue in the project the link came from
    startCreate({ projectId: params.get('project') ?? undefined })
    setParams({ new: null, project: null })
  }
})
$effect(() => {
  if (newProjectRequested && !newProjectOpen) {
    newProjectOpen = true
    setParams({ new_project: null })
  }
})
$effect(() => {
  if (saveRequested && !savingView) {
    savingView = true
    setParams({ save: null })
  }
})
</script>

<svelte:head><title>{t('title')} · Kern</title></svelte:head>
<svelte:window onkeydown={onWindowKeydown} />

<div class="ktracker">
  <PageHeader
    crumbs={[{ label: workspace?.name ?? '' }, { label: t('title') }]}
    title={t('title')}
    {subtitle}
    measure={cycleProgress}
  >
    {#snippet actions()}
      {#if canCreateProject}
        <Button size="sm" variant="secondary" onclick={() => (newProjectOpen = true)} data-testid="new-project">
          {t('project_new')}
        </Button>
      {/if}
    {/snippet}
  </PageHeader>

  <Toolbar>
    <ViewToggle
      items={[
        { value: 'list', icon: 'list', label: t('view_list') },
        { value: 'board', icon: 'columns-3', label: t('view_board') },
      ]}
      value={layout}
      onValueChange={(value) => setParams({ view: value === 'board' ? 'board' : null })}
    />
    <span class="divider"></span>

    <FilterMenu {filters} onchange={(next) => (filters = next)} />

    <!-- Both views group now, so the control is not the list's alone. -->
    <DropdownMenu items={groupMenu} align="start">
        {#snippet trigger(props)}
          <ToolbarButton {...props} prefix={t('group_by')} data-testid="group-by">
            {currentGroupLabel}
          </ToolbarButton>
      {/snippet}
    </DropdownMenu>

    {#if canCreate}
      <ToolbarButton onclick={() => (savingView = true)} data-testid="save-view">
        {t('view_save')}
      </ToolbarButton>
    {/if}

    {#if filterCount(filters) > 0}
      <ToolbarButton active onClear={() => (filters = emptyFilters())}>
        {t('filter_count', { count: filterCount(filters) })}
      </ToolbarButton>
    {/if}

    <KqlInput value={manualKql} fields={kqlFields} onapply={(kql) => setParams({ q: kql })} />

    {#snippet end()}
      <Tabs
        variant="underline"
        items={PRESETS.map((p) => ({ value: p, label: presetLabel(p) }))}
        value={preset}
        onValueChange={(value) => setParams({ preset: value === 'all' ? null : value })}
        label={t('presets')}
      />
    {/snippet}
  </Toolbar>

  <div class="body" class:board={layout === 'board'}>
    {#if issuesQuery.isPending}
      <div class="skeleton" aria-busy="true" aria-label={t('common.loading')}>
        {#each [1, 2, 3, 4, 5, 6, 7, 8] as row (row)}
          <div class="srow">
            <Skeleton class="h-[15px] w-[15px] rounded-[4px]" />
            <Skeleton class="h-[11px] w-[52px]" />
            <Skeleton class="h-[15px] w-[15px] rounded-[4px]" />
            <Skeleton class="h-[11px] w-[42%]" />
          </div>
        {/each}
      </div>
    {:else if issuesQuery.isError}
      <div class="state">
        <EmptyState icon="triangle-alert" title={t('error_title')} description={t('error_body')}>
          {#snippet actions()}
            <Button size="sm" variant="secondary" onclick={() => issuesQuery.refetch()}>{t('common.retry')}</Button>
          {/snippet}
        </EmptyState>
      </div>
    {:else if layout === 'board'}
      <BoardView
        {issues}
        columns={boardColumns}
        columnOf={(issue) => groupKeysOf(issue, groupBy).filter((k): k is string => k !== null)}
        wipLimits={boardField ? {} : { in_progress: 5, in_review: 3 }}
        draggable={boardField ? canEdit : canTransition}
        onopen={open}
        onmove={(issue, toColumnId, afterId, beforeId) =>
          moveIssue.mutate({ issue, toColumnId, afterId, beforeId })}
        oncreate={canCreate && !boardField ? (statusId) => startCreate({ statusId }) : undefined}
      />
    {:else}
      <IssueListView
        bind:this={listView}
        {issues}
        {groupBy}
        selection={selected}
        loading={issuesQuery.isFetching}
        onopen={open}
        onselect={toggleSelect}
        oncreate={canCreate ? () => startCreate() : undefined}
      />
    {/if}
  </div>

  {#if selection.length > 0}
    <div class="bulk" role="status">
      <span>{t('selected', { count: selection.length })}</span>
      {#if canBulkEdit}
        <span class="bdiv"></span>
        <button type="button" onclick={() => bulkPriority.mutate('urgent')}>
          {t('bulk_urgent')}
        </button>
      {/if}
      <span class="bdiv"></span>
      <button type="button" onclick={() => (selection = [])}>{t('common.close')}</button>
    </div>
  {/if}

  <SaveViewDialog
    open={savingView}
    {workspaceId}
    kql={manualKql}
    layout={layout === 'board' ? 'board' : 'list'}
    {groupBy}
    editing={editingView}
    onclose={() => (savingView = false)}
  />

  <NewProjectDialog
    open={newProjectOpen}
    {workspaceId}
    onclose={() => (newProjectOpen = false)}
    oncreated={(key) => toast.success(t('project_created', { key }))}
  />

  <IssueDetailPanel
    {workspaceId}
    issueKey={openIssueKey}
    onclose={() => setParams({ issue: null })}
    onopenissue={(key) => setParams({ issue: key })}
  />
</div>

<NewIssueDialog
  bind:open={creating}
  {workspaceId}
  defaults={createDefaults}
  oncreated={(issue) => setParams({ issue: issue.key })}
/>

<style>
  .ktracker {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: var(--kern-surface);
  }
  .divider {
    width: 1px;
    height: 18px;
    margin: 0 4px;
    background: var(--kern-border);
    flex: none;
    align-self: center;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  /* the board is its own scroller in both directions, so the page must not add a second one */
  .body.board {
    overflow: hidden;
  }
  .skeleton {
    display: flex;
    flex-direction: column;
  }
  .srow {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 40px;
    padding: 0 16px;
    border-bottom: 1px solid var(--kern-border-hairline);
  }
  .state {
    padding: 40px 28px;
  }
  .bulk {
    position: absolute;
    bottom: 20px;
    inset-inline-start: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 16px;
    border-radius: var(--kern-r-lg);
    background: var(--kern-ink-900);
    color: var(--kern-ink-inverse);
    font-size: 13px;
    box-shadow: var(--kern-shadow-toast);
    z-index: 30;
    animation: kfade 0.14s ease-out;
  }
  :global([dir='rtl']) .bulk {
    transform: translateX(50%);
  }
  .bulk button {
    color: inherit;
  }
  .bulk button:hover {
    opacity: 0.75;
  }
  .bdiv {
    width: 1px;
    height: 16px;
    background: rgb(255 255 255 / 0.2);
  }
</style>
