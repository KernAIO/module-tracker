<script lang="ts">
import type { WidgetProps } from '@kernhq/ui'
import { LineChart, WidgetState } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'

/**
 * Created against resolved, over a window somebody picks.
 *
 * The dates are computed from the chosen range rather than stored, so a card left on a dashboard
 * for a month keeps meaning "the last 30 days" instead of a month that has since passed.
 */
let { workspaceId, settings }: WidgetProps = $props()

const api = getTrackerApi()
const projectId = $derived((settings.project as string | null) ?? null)
const days = $derived(Number(settings.range ?? 30))

const window = $derived.by(() => {
  const to = new Date()
  const from = new Date(to.getTime() - days * 864e5)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { from: iso(from), to: iso(to) }
})

const query = createQuery(() => ({
  queryKey: ['tracker', 'report', workspaceId, 'cvr', projectId ?? '', window.from, window.to],
  queryFn: () =>
    api.reports.createdVsResolved({
      workspaceId,
      projectId: projectId as string,
      from: window.from,
      to: window.to,
    }),
  enabled: Boolean(workspaceId) && Boolean(projectId),
}))

const points = $derived(query.data?.points ?? [])
</script>

<div class="pad">
  <WidgetState
    pending={query.isPending && Boolean(projectId)}
    error={query.error}
    empty={!projectId || points.length === 0}
    emptyTitle={projectId ? t('widget_chart_no_data') : t('widget_cycle_pick_project')}
    emptyIcon="chart-line"
    onRetry={() => query.refetch()}
  >
    <LineChart
      title={t('widget_throughput_title')}
      labels={points.map((p) => p.date)}
      series={[
        { label: t('widget_throughput_created'), values: points.map((p) => p.created), tone: 2 },
        { label: t('widget_throughput_resolved'), values: points.map((p) => p.resolved), tone: 3 },
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
