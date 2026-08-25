<script lang="ts">
import type { WidgetProps } from '@kernhq/ui'
import { BarChart, WidgetState } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'

/**
 * Completed work per cycle.
 *
 * `reports.velocity` is project-scoped, so the query waits until a project is chosen rather than
 * guessing one — and the empty state says which setting is missing instead of showing nothing.
 */
let { workspaceId, settings }: WidgetProps = $props()

const api = getTrackerApi()
const projectId = $derived((settings.project as string | null) ?? null)
const lastN = $derived(Number(settings.lastN ?? 6))

const query = createQuery(() => ({
  queryKey: ['tracker', 'report', workspaceId, 'velocity', projectId ?? '', lastN],
  queryFn: () => api.reports.velocity({ workspaceId, projectId: projectId as string, lastN }),
  enabled: Boolean(workspaceId) && Boolean(projectId),
}))

const cycles = $derived(query.data?.cycles ?? [])
</script>

<div class="pad">
  <WidgetState
    pending={query.isPending && Boolean(projectId)}
    error={query.error}
    empty={!projectId || cycles.length === 0}
    emptyTitle={projectId ? t('widget_chart_no_data') : t('widget_cycle_pick_project')}
    emptyIcon="chart-column"
    onRetry={() => query.refetch()}
  >
    <BarChart
      title={t('widget_velocity_title')}
      labels={cycles.map((c) => c.cycle.name)}
      series={[
        { label: t('widget_velocity_committed'), values: cycles.map((c) => c.committed), tone: 2 },
        { label: t('widget_velocity_completed'), values: cycles.map((c) => c.completed), tone: 1 },
      ]}
      height={140}
    />
  </WidgetState>
</div>

<style>
  .pad {
    padding: 10px 14px 14px;
    height: 100%;
  }
</style>
