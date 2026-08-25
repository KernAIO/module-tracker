<script lang="ts">
import type { MenuItem, WidgetProps } from '@kernhq/ui'
import { DropdownMenu, formatDate, Icon, settingsScope, toast, WidgetState } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import PriorityGlyph from '../components/PriorityGlyph.svelte'
import StatusIcon from '../components/StatusIcon.svelte'
import { type Preset, presetKql } from '../filters.js'
import { t } from '../i18n.js'
import { dueTone } from '../index.js'

/**
 * Work items, filtered by whatever this instance was configured with.
 *
 * One widget rather than six. `issues.query` takes a KQL string and is what every view, board and
 * report already runs through, so "assigned to me", "due soon", "in review" and any saved view are
 * the same card with a different setting — which is also why placing it twice showing two different
 * things is free.
 */
let { workspaceId, workspaceSlug, settings, editing }: WidgetProps = $props()

const api = getTrackerApi()
const client = useQueryClient()

const preset = $derived((settings.preset as Preset | 'triage') ?? 'assigned')
const view = $derived((settings.view as string | null) ?? null)
const limit = $derived(Number(settings.limit ?? 8))

const views = createQuery(() => ({
  queryKey: ['tracker', 'view', workspaceId],
  queryFn: () => api.views.list({ workspaceId }),
  enabled: Boolean(view),
}))

/** A saved view wins over the preset: picking one is a more specific instruction. */
const kql = $derived.by(() => {
  if (view) {
    const found = (views.data ?? []).find((v) => v.id === view)
    if (found) return found.kql ?? ''
  }
  // `triage` is this widget's own, not one of the tracker page's presets: the page reaches triage
  // through its intake screen, and there is no shared KQL for it.
  if (preset === 'triage') return 'statusCategory = triage'
  return presetKql(preset as Preset)
})

const query = createQuery(() => ({
  // The settings are in the key. Without that, changing the project or the preset leaves the key
  // untouched, TanStack serves the cached page, and the setting looks broken on a warm cache.
  queryKey: ['tracker', 'issue', workspaceId, 'widget', settingsScope(settings), kql],
  queryFn: () =>
    api.issues.query({
      workspaceId,
      kql,
      limit,
      orderBy: [{ field: 'updatedAt', dir: 'desc' }],
    }),
  enabled: Boolean(workspaceId) && (!view || views.isSuccess),
}))

const issues = $derived(query.data?.items ?? [])

/**
 * An issue carries a `statusId`, not a status. The tracker page resolves ids through a catalogue it
 * publishes as context, which a dashboard widget is not inside — so it fetches the one list it
 * needs. It is small, cached, and shared with every other tracker widget on the board.
 */
const statuses = createQuery(() => ({
  queryKey: ['tracker', 'status', workspaceId],
  queryFn: () => api.workflows.statuses({ workspaceId }),
  enabled: Boolean(workspaceId),
}))
const statusOf = (id: string) => (statuses.data ?? []).find((s) => s.id === id)

/** Transitions are fetched when the menu opens, not per row up front: one request, not eight. */
let openFor = $state<string | null>(null)
const transitions = createQuery(() => ({
  queryKey: ['tracker', 'issue', workspaceId, 'transitions', openFor],
  queryFn: () => api.issues.transitions.available({ workspaceId, issueId: openFor! }),
  enabled: Boolean(openFor),
}))

const apply = createMutation(() => ({
  mutationFn: (input: { issueId: string; transitionId: string }) =>
    api.issues.transitions.apply({ workspaceId, ...input }),
  onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['tracker', 'issue'] })
  },
  onError: (e: unknown) => toast.error(e instanceof Error ? e.message : t('common.error')),
}))

function menuFor(issueId: string): MenuItem[] {
  if (transitions.isPending) return [{ label: t('common.loading'), disabled: true }]
  const list = transitions.data ?? []
  if (list.length === 0) return [{ label: t('widget_no_transitions'), disabled: true }]
  return list
    .filter((tr) => !tr.hidden)
    .map((tr) => ({
      label: tr.name,
      // A blocked move is shown with its reason rather than hidden: knowing why you cannot move an
      // issue is the useful half, and it is what `reasons` is for.
      disabled: !tr.allowed,
      hint: tr.allowed ? undefined : tr.reasons.map((r) => r.message).join(' · ') || undefined,
      onSelect: () => apply.mutate({ issueId, transitionId: tr.id }),
    }))
}
</script>

<WidgetState
  pending={query.isPending || statuses.isPending}
  error={query.error}
  empty={issues.length === 0}
  emptyTitle={t('empty_title')}
  emptyIcon="square-check-big"
  onRetry={() => query.refetch()}
>
  <ul>
    {#each issues as issue (issue.id)}
      {@const status = statusOf(issue.statusId)}
      <li>
        <a class="row" href="/{workspaceSlug}/tracker?issue={issue.id}">
          <PriorityGlyph priority={issue.priority} size={14} />
          <span class="key">{issue.key}</span>
          <StatusIcon
            category={status?.category ?? 'todo'}
            statusId={issue.statusId}
            name={status?.name ?? null}
            size={14}
          />
          <span class="title">{issue.title}</span>
          {#if issue.dueDate}
            <time class="due {dueTone(issue.dueDate)}" datetime={issue.dueDate}>
              {formatDate(issue.dueDate, { month: 'short', day: 'numeric' })}
            </time>
          {/if}
        </a>
        {#if !editing}
          <span class="act">
            <DropdownMenu
              items={menuFor(issue.id)}
              onOpenChange={(o) => (openFor = o ? issue.id : null)}
            >
              {#snippet trigger(props)}
                <button {...props} type="button" aria-label={t('change_status_widget')}>
                  <Icon name="ellipsis" size={14} />
                </button>
              {/snippet}
            </DropdownMenu>
          </span>
        {/if}
      </li>
    {/each}
  </ul>
</WidgetState>

<style>
  li {
    position: relative;
    border-block-end: 1px solid var(--kern-border-hairline);
  }
  li:last-child {
    border-block-end: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    color: inherit;
  }
  li:hover .row {
    background: var(--kern-surface-hover);
  }
  .key {
    flex-shrink: 0;
    font-family: var(--kern-font-mono);
    font-size: 11.5px;
    color: var(--kern-ink-400);
  }
  .title {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--kern-ink-800);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .due {
    flex-shrink: 0;
    font-family: var(--kern-font-mono);
    font-size: 11px;
    color: var(--kern-ink-400);
  }
  .due:global(.hot) {
    color: var(--kern-danger);
  }
  .act {
    position: absolute;
    inset-block: 0;
    inset-inline-end: 8px;
    display: none;
    align-items: center;
  }
  li:hover .act,
  .act:focus-within {
    display: flex;
  }
  .act button {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: var(--kern-r-sm);
    border: 1px solid var(--kern-border);
    background: var(--kern-surface-raised);
    color: var(--kern-ink-600);
  }
  .act button:hover {
    color: var(--kern-ink-900);
  }
</style>
