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
  Select,
  Textarea,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { Cycle } from '../index.js'
import { estimateLabel, estimateUnitOf } from '../labels.js'
import { projectKql, trackerHref } from '../nav.js'
import { canTracker } from '../permissions.js'
import { trackerKeys } from '../query.js'
import { useRouteProject } from './context.svelte.js'
import PlanCard from './PlanCard.svelte'
import ProjectShell from './ProjectShell.svelte'

/**
 * A project's cycles — the sprint, whatever a team calls it.
 *
 * A cycle is a name and a window, and the window is the whole point, so it is drawn as the same card
 * a milestone is: dates, what it is for, and how much of it is done. The two moves that advance it —
 * starting it, and closing it — are the reason the screen exists.
 *
 * Completing asks where unfinished work goes rather than deciding quietly. Leaving a cycle is the
 * one moment a team looks at what did not get done, and moving it somewhere they did not choose is
 * how work disappears.
 */
const api = getTrackerApi()
const queryClient = useQueryClient()

const at = useRouteProject()
const slug = $derived(at.slug)
const workspaceId = $derived(at.workspaceId)
const projectId = $derived(at.projectId)
const canManage = $derived(canTracker('projectManage'))
const unit = $derived(estimateUnitOf(at.project))

const cyclesQuery = createQuery(() => ({
  queryKey: trackerKeys.cycles(workspaceId, projectId),
  queryFn: () => api.cycles.list({ workspaceId, projectId }),
  enabled: Boolean(projectId),
}))
const cycles = $derived(cyclesQuery.data ?? [])
const active = $derived(cycles.find((cycle) => cycle.status === 'active') ?? null)

const invalidate = () => {
  void queryClient.invalidateQueries({ queryKey: ['tracker', 'cycle'] })
  void queryClient.invalidateQueries({ queryKey: ['tracker', 'issue'] })
}
const fail = (error: Error) => toast.error(error.message)

let editing = $state<Cycle | null>(null)
let creating = $state(false)
let draftName = $state('')
let draftStart = $state('')
let draftEnd = $state('')
let draftGoal = $state('')
/** Closing a cycle names where the unfinished work goes before it happens. */
let closing = $state<Cycle | null>(null)
let rollTo = $state<string>('')
let confirming = $state<Cycle | null>(null)

/** `<input type="date">` wants `YYYY-MM-DD` in local time; an ISO timestamp's UTC date can be the
 * day before. */
const dateValue = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const open = (cycle: Cycle | null) => {
  editing = cycle
  creating = cycle === null
  draftName = cycle?.name ?? ''
  draftGoal = cycle?.goal ?? ''
  draftStart = cycle ? dateValue(cycle.startAt) : ''
  draftEnd = cycle ? dateValue(cycle.endAt) : ''
}
const close = () => {
  editing = null
  creating = false
}

const iso = (day: string, endOfDay = false) =>
  new Date(`${day}T${endOfDay ? '23:59:59' : '00:00:00'}`).toISOString()

const save = createMutation(() => ({
  mutationFn: () => {
    const body = {
      name: draftName.trim(),
      goal: draftGoal.trim() || null,
      startAt: iso(draftStart),
      endAt: iso(draftEnd, true),
    }
    return editing
      ? api.cycles.update({ workspaceId, id: editing.id, patch: body })
      : api.cycles.create({ workspaceId, projectId, ...body })
  },
  onSuccess: () => {
    close()
    invalidate()
  },
  onError: fail,
}))

const start = createMutation(() => ({
  mutationFn: (id: string) => api.cycles.start({ workspaceId, id }),
  onSuccess: invalidate,
  onError: fail,
}))

/**
 * `rollToCycleId` is sent even when it is null, and that is the point: the server reads an omitted
 * key as "pick the next cycle for me" and a null as "the backlog". The screen always has an answer,
 * so it always says which.
 */
const complete = createMutation(() => ({
  mutationFn: () =>
    api.cycles.complete({
      workspaceId,
      id: closing?.id as string,
      rollToCycleId: rollTo || null,
    }),
  onSuccess: () => {
    closing = null
    invalidate()
  },
  onError: fail,
}))

const remove = createMutation(() => ({
  mutationFn: (id: string) => api.cycles.delete({ workspaceId, id }),
  onSuccess: () => {
    confirming = null
    invalidate()
  },
  onError: fail,
}))

/** One range, formatted as one: `formatRange` collapses the parts two dates share, and reads the
 * right way round under `dir="rtl"`. */
const rangeFormat = $derived(new Intl.DateTimeFormat(messageLocale(), { day: 'numeric', month: 'short' }))
const when = (cycle: Cycle) => rangeFormat.formatRange(new Date(cycle.startAt), new Date(cycle.endAt))

const toneOf = (cycle: Cycle) =>
  cycle.status === 'active' ? 'running' : cycle.status === 'completed' ? 'done' : 'planned'
const stateOf = (cycle: Cycle) =>
  cycle.status === 'active'
    ? t('cycle_active')
    : cycle.status === 'completed'
      ? t('cycle_completed')
      : t('cycle_upcoming')

const issuesHref = (cycle: Cycle) =>
  trackerHref(slug, { q: `${projectKql(projectId)} and cycle = ${JSON.stringify(cycle.id)}` })

/** Where unfinished work can go: any cycle that has not run yet, or the backlog. */
const rollOptions = $derived([
  { value: '', label: t('cycle_roll_backlog') },
  ...cycles
    .filter((cycle) => cycle.status === 'upcoming' && cycle.id !== closing?.id)
    .map((cycle) => ({ value: cycle.id, label: cycle.name })),
])

const menuFor = (cycle: Cycle): MenuItem[] => [
  { type: 'item', id: 'issues', label: t('cycle_issues'), icon: 'list', href: issuesHref(cycle) },
  ...(canManage
    ? [
        { type: 'separator' as const },
        ...(cycle.status === 'upcoming'
          ? [
              {
                type: 'item' as const,
                id: 'start',
                label: t('cycle_start'),
                icon: 'play',
                // one cycle runs at a time; the server refuses a second and says so
                disabled: Boolean(active),
                onSelect: () => start.mutate(cycle.id),
              },
            ]
          : []),
        ...(cycle.status === 'active'
          ? [
              {
                type: 'item' as const,
                id: 'complete',
                label: t('cycle_complete'),
                icon: 'check',
                onSelect: () => {
                  closing = cycle
                  rollTo = ''
                },
              },
            ]
          : []),
        {
          type: 'item' as const,
          id: 'edit',
          label: t('common.edit'),
          icon: 'pencil',
          onSelect: () => open(cycle),
        },
        {
          type: 'item' as const,
          id: 'delete',
          label: t('common.delete'),
          icon: 'trash-2',
          danger: true,
          onSelect: () => (confirming = cycle),
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
  title={t('planning_cycles')}
  subtitle={active ? t('cycle_running', { name: active.name }) : t('cycle_none_running')}
>
  {#snippet headerActions()}
    {#if canManage}
      <Button size="sm" icon="plus" onclick={() => open(null)} data-testid="cycle-new">
        {t('cycle_new')}
      </Button>
    {/if}
  {/snippet}

  {#snippet children()}
    {#if cyclesQuery.isPending}
      <p class="quiet">{t('common.loading')}</p>
    {:else if !cycles.length}
      <EmptyState
        icon="refresh-cw"
        title={t('planning_cycles_empty')}
        description={t('planning_cycles_hint')}
      >
        {#snippet actions()}
          {#if canManage}
            <Button size="sm" icon="plus" onclick={() => open(null)}>{t('cycle_new')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div class="cards">
        {#each cycles as cycle (cycle.id)}
          <PlanCard
            icon="refresh-cw"
            tone={toneOf(cycle)}
            name={cycle.name}
            href={issuesHref(cycle)}
            state={stateOf(cycle)}
            when={when(cycle)}
            goal={cycle.goal}
            progress={{ done: cycle.stats.done, total: cycle.stats.total }}
          >
            {#snippet meta()}
              {#if cycle.stats.estimateTotal > 0}
                <!-- In whatever this project estimates in, not always points. -->
                <span class="chip">
                  {t('cycle_estimate', {
                    done: estimateLabel(cycle.stats.estimateDone, unit),
                    total: estimateLabel(cycle.stats.estimateTotal, unit),
                  })}
                </span>
              {/if}
              {#if cycle.carryOverCount > 0}
                <span class="chip">{t('cycle_carried', { count: cycle.carryOverCount })}</span>
              {/if}
            {/snippet}
            {#snippet actions()}
              {#if canManage && cycle.status === 'upcoming'}
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={Boolean(active)}
                  onclick={() => start.mutate(cycle.id)}
                  data-testid="cycle-start"
                >
                  {t('cycle_start')}
                </Button>
              {:else if canManage && cycle.status === 'active'}
                <Button
                  size="xs"
                  variant="secondary"
                  onclick={() => {
                    closing = cycle
                    rollTo = ''
                  }}
                  data-testid="cycle-complete"
                >
                  {t('cycle_complete')}
                </Button>
              {/if}
              <DropdownMenu items={menuFor(cycle)} align="end">
                {#snippet trigger(props)}
                  <IconButton
                    {...props}
                    icon="ellipsis"
                    size={26}
                    label={t('cycle_actions', { name: cycle.name })}
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
  title={editing ? t('cycle_edit') : t('cycle_new')}
  size="sm"
  onOpenChange={(next: boolean) => {
    if (!next) close()
  }}
>
  <div class="form">
    <label class="frow">
      <span class="lbl">{t('project_name')}</span>
      <Input bind:value={draftName} data-testid="cycle-name" />
    </label>
    <div class="pair">
      <label class="frow">
        <span class="lbl">{t('cycle_starts')}</span>
        <input class="date" type="date" bind:value={draftStart} data-testid="cycle-start-date" />
      </label>
      <label class="frow">
        <span class="lbl">{t('cycle_ends')}</span>
        <input class="date" type="date" bind:value={draftEnd} data-testid="cycle-end-date" />
      </label>
    </div>
    {#if draftStart && draftEnd && draftEnd < draftStart}
      <p class="warn">{t('cycle_range_error')}</p>
    {/if}
    <label class="frow">
      <span class="lbl">{t('milestone_goal')}</span>
      <Textarea bind:value={draftGoal} rows={2} data-testid="cycle-goal" />
    </label>
  </div>

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={close}>{t('common.cancel')}</Button>
    <Button
      size="sm"
      disabled={!draftName.trim() || !draftStart || !draftEnd || draftEnd < draftStart}
      loading={save.isPending}
      onclick={() => save.mutate()}
      data-testid="cycle-save"
    >
      {t('common.save')}
    </Button>
  {/snippet}
</Dialog>

<Dialog
  open={closing !== null}
  title={t('cycle_complete')}
  size="sm"
  onOpenChange={(next: boolean) => {
    if (!next) closing = null
  }}
>
  <p class="body">{t('cycle_complete_body', { name: closing?.name ?? '' })}</p>
  <div class="frow">
    <span class="lbl">{t('cycle_roll_backlog')}</span>
    <Select value={rollTo} options={rollOptions} onValueChange={(value: string) => (rollTo = value)} />
  </div>

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={() => (closing = null)}>{t('common.cancel')}</Button>
    <Button
      size="sm"
      loading={complete.isPending}
      onclick={() => complete.mutate()}
      data-testid="cycle-complete-confirm"
    >
      {t('cycle_complete')}
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
      data-testid="cycle-delete-confirm"
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
.chip {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 9px;
  border-radius: var(--kern-r-md);
  background: var(--kern-surface-chip);
  color: var(--kern-ink-500);
  font-size: 12px;
  white-space: nowrap;
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
.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.frow {
  display: grid;
  gap: 4px;
}
.lbl {
  font-size: 12px;
  color: var(--kern-ink-550);
}
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
.warn {
  margin: 0;
  font-size: 12.5px;
  color: var(--kern-danger);
}
.body {
  margin: 0 0 12px;
  font-size: 13px;
}
</style>
