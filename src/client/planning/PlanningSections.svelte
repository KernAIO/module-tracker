<script lang="ts">
import { messageLocale } from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { trackerKeys } from '../query.js'
// These two are presentational and were written for the settings screen; a project's own page
// shows the same lists, so they are imported rather than copied. They stay where they are because
// several people have that folder open.
import CycleList from '../settings/CycleList.svelte'
import { listMutation } from '../settings/mutations'
import PlanningList from '../settings/PlanningList.svelte'

/**
 * What a project plans and sorts its work by: cycles, milestones, components, versions and labels.
 *
 * One component rather than one per screen, because there are two places this belongs and they must
 * not drift: a project's own pages in the tracker, where somebody adds a component while looking at
 * the work it is for, and workspace settings, where an admin sets several projects up at once.
 *
 * The caller says which sections to show, so a page can be exactly one of them.
 */
export type PlanningSection = 'cycles' | 'milestones' | 'components' | 'versions' | 'labels'

interface Props {
  workspaceId: string
  projectId: string
  /** false hides every control and leaves the lists readable */
  editable: boolean
  /** which sections to render, in this order; all of them by default */
  only?: PlanningSection[]
}
let { workspaceId, projectId, editable, only }: Props = $props()

const api = getTrackerApi()
const queryClient = useQueryClient()

const shows = (section: PlanningSection) => !only || only.includes(section)
const on = (section: PlanningSection) => Boolean(projectId) && shows(section)

const cyclesQuery = createQuery(() => ({
  queryKey: trackerKeys.cycles(workspaceId, projectId),
  queryFn: () => api.cycles.list({ workspaceId, projectId }),
  enabled: on('cycles'),
}))
const milestonesQuery = createQuery(() => ({
  queryKey: trackerKeys.milestones(workspaceId, projectId),
  queryFn: () => api.milestones.list({ workspaceId, projectId }),
  enabled: on('milestones'),
}))
const componentsQuery = createQuery(() => ({
  queryKey: trackerKeys.components(workspaceId, projectId),
  queryFn: () => api.components.list({ workspaceId, projectId }),
  enabled: on('components'),
}))
const versionsQuery = createQuery(() => ({
  queryKey: trackerKeys.versions(workspaceId, projectId),
  queryFn: () => api.versions.list({ workspaceId, projectId }),
  enabled: on('versions'),
}))
const labelsQuery = createQuery(() => ({
  queryKey: [...trackerKeys.labels(workspaceId), projectId],
  queryFn: () => api.labels.list({ workspaceId, projectId }),
  enabled: on('labels'),
}))

/**
 * Everything a change here can be seen in: the lists themselves, and the issue queries that group
 * by what was just renamed or removed.
 */
const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: trackerKeys.projects(workspaceId) })
  void queryClient.invalidateQueries({ queryKey: trackerKeys.labels(workspaceId) })
  for (const entity of ['cycle', 'milestone', 'component', 'version', 'issue'])
    void queryClient.invalidateQueries({ queryKey: ['tracker', entity] })
}

/** A function declaration, not an arrow: an arrow's generic needs `<T,>` here, which the Svelte
 * formatter rewrites and then disagrees with itself about. */
function mutation<T>(fn: (input: T) => Promise<unknown>) {
  return listMutation(fn, refresh)
}

const addCycle = mutation((input: { name: string; startAt: string; endAt: string }) =>
  api.cycles.create({ workspaceId, projectId, ...input }),
)
const updateCycle = mutation((input: { id: string; name: string; startAt: string; endAt: string }) =>
  api.cycles.update({
    workspaceId,
    id: input.id,
    patch: { name: input.name, startAt: input.startAt, endAt: input.endAt },
  }),
)
const startCycle = mutation((id: string) => api.cycles.start({ workspaceId, id }))
/**
 * `rollToCycleId` is sent even when it is null, and that is the point: the server reads an omitted
 * key as "pick the next cycle for me" and a null as "the backlog". The screen always has an answer,
 * so it always says which.
 */
const completeCycle = mutation((input: { id: string; rollToCycleId: string | null }) =>
  api.cycles.complete({ workspaceId, ...input }),
)
const removeCycle = mutation((id: string) => api.cycles.delete({ workspaceId, id }))

const addMilestone = mutation((name: string) => api.milestones.create({ workspaceId, projectId, name }))
const renameMilestone = mutation((input: { id: string; name: string }) =>
  api.milestones.update({ workspaceId, id: input.id, patch: { name: input.name } }),
)
const removeMilestone = mutation((id: string) => api.milestones.delete({ workspaceId, id }))
const setMilestoneStatus = mutation((input: { id: string; status: 'open' | 'completed' }) =>
  api.milestones.update({ workspaceId, id: input.id, patch: { status: input.status } }),
)

const addComponent = mutation((name: string) => api.components.create({ workspaceId, projectId, name }))
const renameComponent = mutation((input: { id: string; name: string }) =>
  api.components.update({ workspaceId, id: input.id, patch: { name: input.name } }),
)
const removeComponent = mutation((id: string) => api.components.delete({ workspaceId, id }))

const addVersion = mutation((name: string) => api.versions.create({ workspaceId, projectId, name }))
const renameVersion = mutation((input: { id: string; name: string }) =>
  api.versions.update({ workspaceId, id: input.id, patch: { name: input.name } }),
)
const removeVersion = mutation((id: string) => api.versions.delete({ workspaceId, id }))
const releaseVersion = mutation((input: { id: string; released: boolean }) =>
  api.versions.release({ workspaceId, ...input }),
)

const addLabel = mutation((name: string) => api.labels.create({ workspaceId, projectId, name }))
const renameLabel = mutation((input: { id: string; name: string }) =>
  api.labels.update({ workspaceId, id: input.id, patch: { name: input.name } }),
)
const removeLabel = mutation((id: string) => api.labels.delete({ workspaceId, id }))

const dateFormat = $derived(new Intl.DateTimeFormat(messageLocale(), { day: 'numeric', month: 'short' }))

const milestones = $derived(
  (milestonesQuery.data ?? []).map((ms) => ({
    id: ms.id,
    name: ms.name,
    badge: ms.status === 'completed' ? t('milestone_completed') : null,
    note: [
      ms.targetDate ? dateFormat.format(new Date(ms.targetDate)) : null,
      t('planning_done_of', { done: ms.stats.done, total: ms.stats.total }),
    ]
      .filter(Boolean)
      .join(' · '),
  })),
)
const openMilestoneIds = $derived(
  new Set((milestonesQuery.data ?? []).filter((ms) => ms.status !== 'completed').map((ms) => ms.id)),
)
const components = $derived(
  (componentsQuery.data ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    note: t('planning_issue_count', { count: c.issueCount }),
  })),
)
const versions = $derived(
  (versionsQuery.data ?? []).map((v) => ({
    id: v.id,
    name: v.name,
    badge: v.status === 'released' ? t('version_released') : null,
    note: t('planning_done_of', { done: v.stats.done, total: v.stats.total }),
  })),
)
const labels = $derived((labelsQuery.data ?? []).map((l) => ({ id: l.id, name: l.name, color: l.color })))
const releasedIds = $derived(
  new Set((versionsQuery.data ?? []).filter((v) => v.status === 'released').map((v) => v.id)),
)
</script>

{#if shows('cycles')}
  <CycleList
    cycles={cyclesQuery.data ?? []}
    loading={cyclesQuery.isPending}
    {editable}
    oncreate={(input) => addCycle.mutate(input)}
    onupdate={(input) => updateCycle.mutate(input)}
    onstart={(id) => startCycle.mutate(id)}
    oncomplete={(input) => completeCycle.mutate(input)}
    onremove={(id) => removeCycle.mutate(id)}
  />
{/if}

{#if shows('milestones')}
  <PlanningList
    title={t('planning_milestones')}
    description={t('planning_milestones_hint')}
    items={milestones}
    loading={milestonesQuery.isPending}
    {editable}
    addLabel={t('planning_milestone_add')}
    emptyLabel={t('planning_milestones_empty')}
    onadd={(name) => addMilestone.mutate(name)}
    onrename={(id, name) => renameMilestone.mutate({ id, name })}
    onremove={(id) => removeMilestone.mutate(id)}
    rowAction={{
      label: (item) =>
        openMilestoneIds.has(item.id) ? t('milestone_complete') : t('milestone_reopen'),
      run: (item) =>
        setMilestoneStatus.mutate({
          id: item.id,
          status: openMilestoneIds.has(item.id) ? 'completed' : 'open',
        }),
    }}
  />
{/if}

{#if shows('components')}
  <PlanningList
    title={t('planning_components')}
    description={t('planning_components_hint')}
    items={components}
    loading={componentsQuery.isPending}
    {editable}
    addLabel={t('planning_component_add')}
    emptyLabel={t('planning_components_empty')}
    onadd={(name) => addComponent.mutate(name)}
    onrename={(id, name) => renameComponent.mutate({ id, name })}
    onremove={(id) => removeComponent.mutate(id)}
  />
{/if}

{#if shows('versions')}
  <PlanningList
    title={t('planning_versions')}
    description={t('planning_versions_hint')}
    items={versions}
    loading={versionsQuery.isPending}
    {editable}
    addLabel={t('planning_version_add')}
    emptyLabel={t('planning_versions_empty')}
    onadd={(name) => addVersion.mutate(name)}
    onrename={(id, name) => renameVersion.mutate({ id, name })}
    onremove={(id) => removeVersion.mutate(id)}
    rowAction={{
      label: (item) =>
        releasedIds.has(item.id) ? t('version_unrelease') : t('version_release'),
      run: (item) => releaseVersion.mutate({ id: item.id, released: !releasedIds.has(item.id) }),
    }}
  />
{/if}

{#if shows('labels')}
  <PlanningList
    title={t('planning_labels')}
    description={t('planning_labels_hint')}
    items={labels}
    loading={labelsQuery.isPending}
    {editable}
    addLabel={t('planning_label_add')}
    emptyLabel={t('planning_labels_empty')}
    onadd={(name) => addLabel.mutate(name)}
    onrename={(id, name) => renameLabel.mutate({ id, name })}
    onremove={(id) => removeLabel.mutate(id)}
  />
{/if}
