<script lang="ts">
import type { WidgetProps } from '@kernhq/ui'
import { Badge, formatCount, ProgressBar, WidgetState } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'

/**
 * How the active cycle is going.
 *
 * A progress bar rather than a burndown chart: at this size a chart is decoration, and `Cycle.stats`
 * already carries the two numbers that answer the question.
 */
let { workspaceId, workspaceSlug, settings }: WidgetProps = $props()

const api = getTrackerApi()
const projectId = $derived((settings.project as string | null) ?? null)

const query = createQuery(() => ({
  queryKey: ['tracker', 'cycle', workspaceId, 'active', projectId ?? 'all'],
  // `cycles.list` is project-scoped, and the query only runs once one is chosen — so the cast is
  // guarded by `enabled` rather than by hope.
  queryFn: () => api.cycles.list({ workspaceId, projectId: projectId as string, status: 'active' }),
  enabled: Boolean(workspaceId) && Boolean(projectId),
}))

const cycles = $derived(query.data ?? [])
</script>

<WidgetState
  pending={query.isPending}
  error={query.error}
  empty={cycles.length === 0}
  emptyTitle={projectId ? t('widget_cycle_none') : t('widget_cycle_pick_project')}
  emptyIcon="calendar"
  onRetry={() => query.refetch()}
>
  <ul>
    {#each cycles as cycle (cycle.id)}
      {@const total = cycle.stats?.total ?? 0}
      {@const done = cycle.stats?.done ?? 0}
      <li>
        <a href="/{workspaceSlug}/tracker?cycle={cycle.id}">
          <span class="top">
            <span class="name">{cycle.name}</span>
            <Badge tone="active" variant="chip">{formatCount(done)}/{formatCount(total)}</Badge>
          </span>
          <ProgressBar value={total === 0 ? 0 : Math.round((done / total) * 100)} />
        </a>
      </li>
    {/each}
  </ul>
</WidgetState>

<style>
  li {
    border-block-end: 1px solid var(--kern-border-hairline);
  }
  li:last-child {
    border-block-end: 0;
  }
  a {
    display: grid;
    gap: 7px;
    padding: 10px 14px;
    color: inherit;
  }
  a:hover {
    background: var(--kern-surface-hover);
  }
  .top {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .name {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--kern-ink-900);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
