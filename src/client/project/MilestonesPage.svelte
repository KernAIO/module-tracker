<script lang="ts">
import {
  Button,
  Dialog,
  DropdownMenu,
  EmptyState,
  IconButton,
  Input,
  type MenuItem,
  messageLocale,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { Milestone } from '../index.js'
import { projectKql, trackerHref } from '../nav.js'
import { canTracker } from '../permissions.js'
import { trackerKeys } from '../query.js'
import { useRouteProject } from './context.svelte.js'
import PlanCard from './PlanCard.svelte'
import ProjectShell from './ProjectShell.svelte'

/**
 * A project's milestones (DESIGN.md 3.5).
 *
 * What a stretch of work is aiming at, and how far along it is — a date, a goal in a sentence, and
 * the count of what is done against what is in it. The date is the point of a milestone and the
 * settings screen never offered one, so every milestone in the workspace was undated until now.
 *
 * A milestone opens as the work inside it: the card is a heading, the issues are the thing.
 */
const api = getTrackerApi()
const queryClient = useQueryClient()

const at = useRouteProject()
const slug = $derived(at.slug)
const workspaceId = $derived(at.workspaceId)
const projectId = $derived(at.projectId)
const canManage = $derived(canTracker('projectManage'))
const milestonesQuery = createQuery(() => ({
  queryKey: trackerKeys.milestones(workspaceId, projectId),
  queryFn: () => api.milestones.list({ workspaceId, projectId }),
  enabled: Boolean(projectId),
}))
const milestones = $derived(milestonesQuery.data ?? [])
const openCount = $derived(milestones.filter((ms) => ms.status !== 'completed').length)

const invalidate = () => {
  void queryClient.invalidateQueries({ queryKey: ['tracker', 'milestone'] })
  void queryClient.invalidateQueries({ queryKey: ['tracker', 'issue'] })
}
const fail = (error: Error) => toast.error(error.message)

/** One dialog for making and for correcting: the fields are the same, and so is what they mean. */
let editing = $state<Milestone | null>(null)
let creating = $state(false)
let draftName = $state('')
let draftDate = $state('')
let draftGoal = $state('')
/** Named on screen before it happens, never straight off a menu. */
let confirming = $state<Milestone | null>(null)

const open = (milestone: Milestone | null) => {
  editing = milestone
  creating = milestone === null
  draftName = milestone?.name ?? ''
  draftDate = milestone?.targetDate ?? ''
  draftGoal = milestone?.description ?? ''
}
const close = () => {
  editing = null
  creating = false
}

const save = createMutation(() => ({
  mutationFn: () => {
    const patch = {
      name: draftName.trim(),
      targetDate: draftDate || null,
      description: draftGoal.trim() || null,
    }
    return editing
      ? api.milestones.update({ workspaceId, id: editing.id, patch })
      : api.milestones.create({ workspaceId, projectId, ...patch })
  },
  onSuccess: () => {
    close()
    invalidate()
  },
  onError: fail,
}))

const setStatus = createMutation(() => ({
  mutationFn: (input: { id: string; status: 'open' | 'completed' }) =>
    api.milestones.update({ workspaceId, id: input.id, patch: { status: input.status } }),
  onSuccess: invalidate,
  onError: fail,
}))

const remove = createMutation(() => ({
  mutationFn: (id: string) => api.milestones.delete({ workspaceId, id }),
  onSuccess: () => {
    confirming = null
    invalidate()
  },
  onError: fail,
}))

const dateFormat = $derived(
  new Intl.DateTimeFormat(messageLocale(), { day: 'numeric', month: 'short', year: 'numeric' }),
)
const when = (milestone: Milestone) =>
  milestone.targetDate ? dateFormat.format(new Date(milestone.targetDate)) : t('milestone_no_date')

const toneOf = (milestone: Milestone) =>
  milestone.status === 'completed' ? 'done' : milestone.stats.done > 0 ? 'running' : 'planned'
const stateOf = (milestone: Milestone) =>
  milestone.status === 'completed'
    ? t('milestone_completed')
    : milestone.stats.done > 0
      ? t('cycle_active')
      : t('cycle_upcoming')

/** The work in one milestone, as the query the issue list already understands. */
const issuesHref = (milestone: Milestone) =>
  trackerHref(slug, { q: `${projectKql(projectId)} and milestone = ${JSON.stringify(milestone.id)}` })

const menuFor = (milestone: Milestone): MenuItem[] => [
  {
    type: 'item',
    id: 'issues',
    label: t('milestone_issues'),
    icon: 'list',
    href: issuesHref(milestone),
  },
  ...(canManage
    ? [
        { type: 'separator' as const },
        {
          type: 'item' as const,
          id: 'edit',
          label: t('common.edit'),
          icon: 'pencil',
          onSelect: () => open(milestone),
        },
        {
          type: 'item' as const,
          id: 'status',
          label: milestone.status === 'completed' ? t('milestone_reopen') : t('milestone_complete'),
          icon: milestone.status === 'completed' ? 'rotate-ccw' : 'check',
          onSelect: () =>
            setStatus.mutate({
              id: milestone.id,
              status: milestone.status === 'completed' ? 'open' : 'completed',
            }),
        },
        {
          type: 'item' as const,
          id: 'delete',
          label: t('common.delete'),
          icon: 'trash-2',
          danger: true,
          onSelect: () => (confirming = milestone),
        },
      ]
    : []),
]
</script>

<ProjectShell
  project={at.project}
  pending={at.pending}
  {slug}
  projectKey={at.projectKey}
  title={t('planning_milestones')}
  subtitle={t('milestones_count', { open: openCount, total: milestones.length })}
>
  {#snippet headerActions()}
    {#if canManage}
      <Button size="sm" icon="plus" onclick={() => open(null)} data-testid="milestone-new">
        {t('milestone_new')}
      </Button>
    {/if}
  {/snippet}

  {#snippet children()}
    {#if milestonesQuery.isPending}
      <p class="quiet">{t('common.loading')}</p>
    {:else if !milestones.length}
      <EmptyState
        icon="flag"
        title={t('planning_milestones_empty')}
        description={t('planning_milestones_hint')}
      >
        {#snippet actions()}
          {#if canManage}
            <Button size="sm" icon="plus" onclick={() => open(null)}>{t('milestone_new')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div class="cards">
        {#each milestones as milestone (milestone.id)}
          <PlanCard
            icon="flag"
            tone={toneOf(milestone)}
            name={milestone.name}
            href={issuesHref(milestone)}
            state={stateOf(milestone)}
            when={when(milestone)}
            goal={milestone.description}
            progress={{ done: milestone.stats.done, total: milestone.stats.total }}
          >
            {#snippet actions()}
              <DropdownMenu items={menuFor(milestone)} align="end">
                {#snippet trigger(props)}
                  <IconButton
                    {...props}
                    icon="ellipsis"
                    size={26}
                    label={t('milestone_actions', { name: milestone.name })}
                  />
                {/snippet}
              </DropdownMenu>
            {/snippet}
          </PlanCard>
        {/each}
      </div>
    {/if}
  {/snippet}
</ProjectShell>

<Dialog
  open={creating || editing !== null}
  title={editing ? t('milestone_edit') : t('milestone_new')}
  size="sm"
  onOpenChange={(next: boolean) => {
    if (!next) close()
  }}
>
  <div class="form">
    <label class="row">
      <span class="lbl">{t('project_name')}</span>
      <Input bind:value={draftName} data-testid="milestone-name" />
    </label>
    <label class="row">
      <span class="lbl">{t('milestone_date')}</span>
      <!-- A date input, because a milestone without one is a wish. -->
      <input class="date" type="date" bind:value={draftDate} data-testid="milestone-date" />
    </label>
    <label class="row">
      <span class="lbl">{t('milestone_goal')}</span>
      <Textarea bind:value={draftGoal} rows={3} data-testid="milestone-goal" />
    </label>
  </div>

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={close}>{t('common.cancel')}</Button>
    <Button
      size="sm"
      disabled={!draftName.trim()}
      loading={save.isPending}
      onclick={() => save.mutate()}
      data-testid="milestone-save"
    >
      {t('common.save')}
    </Button>
  {/snippet}
</Dialog>

<Dialog
  open={confirming !== null}
  title={t('planning_remove', { name: confirming?.name ?? '' })}
  size="sm"
  onOpenChange={(next: boolean) => {
    if (!next) confirming = null
  }}
>
  <p class="body">{t('planning_remove_body', { name: confirming?.name ?? '' })}</p>

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={() => (confirming = null)}>{t('common.cancel')}</Button>
    <Button
      size="sm"
      variant="danger"
      loading={remove.isPending}
      onclick={() => confirming && remove.mutate(confirming.id)}
      data-testid="milestone-delete-confirm"
    >
      {t('common.delete')}
    </Button>
  {/snippet}
</Dialog>

<style>
.cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.quiet {
  margin: 0;
  font-size: 13px;
  color: var(--kern-ink-400);
}
.form {
  display: grid;
  gap: 12px;
}
.row {
  display: grid;
  gap: 4px;
}
.lbl {
  font-size: 12px;
  color: var(--kern-ink-550);
}
/* The one native control the kit does not wrap; it borrows the input's shape. */
.date {
  /* the whole field opens a picker; a date input does not take free text, so it is not a caret */
  cursor: pointer;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--kern-border-strong);
  border-radius: var(--kern-r-lg);
  background: var(--kern-surface-raised);
  color: var(--kern-ink-800);
  font: inherit;
  font-size: 13.5px;
}
.date:focus-visible {
  outline: none;
  border-color: var(--kern-accent);
  box-shadow: 0 0 0 3px var(--kern-ring);
}
.body {
  margin: 0;
  font-size: 13px;
}
</style>
