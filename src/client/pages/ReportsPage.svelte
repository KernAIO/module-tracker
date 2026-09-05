<script lang="ts">
import {
  BarChart,
  Button,
  EmptyState,
  LineChart,
  navigation,
  PageHeader,
  SegmentedControl,
  Select,
  Spinner,
  StackedAreaChart,
  session,
} from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { formatDuration } from '../index.js'
import { trackerKeys } from '../query.js'

/**
 * How the work is going.
 *
 * Five reports have had a server since the module existed and no screen, so the answer to "are we
 * going to make it" lived in the database and nowhere a person could see it.
 *
 * Each one answers a different question, so each is its own tab rather than a wall of charts:
 * burndown is about this cycle, velocity about the last several, created-versus-resolved about
 * whether the backlog is growing, and time about where the hours went.
 */
const api = getTrackerApi()

const slug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === slug))
const workspaceId = $derived(workspace?.id ?? '')

type Tab = 'burndown' | 'velocity' | 'flow' | 'cfd' | 'time'
let tab = $state<Tab>('burndown')
let selectedProject = $state<string | null>(null)

const projectsQuery = createQuery(() => ({
  queryKey: trackerKeys.projects(workspaceId),
  queryFn: () => api.projects.list({ workspaceId }),
  enabled: Boolean(workspaceId),
}))
const projects = $derived(projectsQuery.data ?? [])
const projectId = $derived(selectedProject ?? projects[0]?.id ?? '')

/** The last month, which is the span somebody means by "lately". */
const today = new Date()
const iso = (date: Date) => date.toISOString().slice(0, 10)
const to = iso(today)
const from = iso(new Date(today.getTime() - 30 * 86_400_000))

const cyclesQuery = createQuery(() => ({
  queryKey: trackerKeys.cycles(workspaceId, projectId),
  queryFn: () => api.cycles.list({ workspaceId, projectId }),
  enabled: Boolean(projectId),
}))
/** Burndown is about the cycle you are in; a finished one is history and has its own report. */
const activeCycle = $derived(
  (cyclesQuery.data ?? []).find((c) => c.status === 'active') ?? (cyclesQuery.data ?? [])[0] ?? null,
)

const cfdQuery = createQuery(() => ({
  queryKey: [...trackerKeys.projects(workspaceId), 'cfd', projectId, from, to],
  queryFn: () => api.reports.cfd({ workspaceId, projectId, from, to }),
  enabled: tab === 'cfd' && Boolean(projectId),
}))

const burndownQuery = createQuery(() => ({
  queryKey: [...trackerKeys.projects(workspaceId), 'burndown', activeCycle?.id ?? ''],
  queryFn: () => api.reports.burndown({ workspaceId, cycleId: activeCycle?.id as string }),
  enabled: tab === 'burndown' && Boolean(activeCycle?.id),
}))
const velocityQuery = createQuery(() => ({
  queryKey: [...trackerKeys.projects(workspaceId), 'velocity', projectId],
  queryFn: () => api.reports.velocity({ workspaceId, projectId, lastN: 6 }),
  enabled: tab === 'velocity' && Boolean(projectId),
}))
const flowQuery = createQuery(() => ({
  queryKey: [...trackerKeys.projects(workspaceId), 'flow', projectId, from, to],
  queryFn: () => api.reports.createdVsResolved({ workspaceId, projectId, from, to }),
  enabled: tab === 'flow' && Boolean(projectId),
}))
const timeQuery = createQuery(() => ({
  queryKey: [...trackerKeys.projects(workspaceId), 'time', projectId, from, to],
  queryFn: () => api.reports.time({ workspaceId, projectId, from, to, billableOnly: false }),
  enabled: tab === 'time' && Boolean(projectId),
}))

const shortDate = (date: string) => date.slice(5)
</script>

<svelte:head><title>{t('reports_title')} · Kern</title></svelte:head>

<!--
  A report that fails has to say so.

  Every branch below used to stop at `isPending` and `data`, so a failed query rendered the tab's
  heading, its one-line explanation and then nothing — which reads as "we looked and there is
  nothing", the one answer that is never true when the request never came back.
-->
{#snippet failed(retry: () => void)}
  <div class="state">
    <EmptyState compact icon="triangle-alert" title={t('error_title')} description={t('report_failed')}>
      {#snippet actions()}
        <Button size="sm" variant="secondary" onclick={retry}>{t('common.retry')}</Button>
      {/snippet}
    </EmptyState>
  </div>
{/snippet}

<div class="reports">
  <PageHeader
    crumbs={[{ label: workspace?.name ?? '' }, { label: t('title'), href: `/${slug}/tracker` }]}
    title={t('reports_title')}
    subtitle={t('reports_subtitle')}
  />

  {#if projectsQuery.isPending}
    <div class="state"><Spinner /></div>
  {:else if projectsQuery.isError}
    <div class="state">
      <EmptyState icon="triangle-alert" title={t('error_title')} description={t('projects_failed')}>
        {#snippet actions()}
          <Button size="sm" variant="secondary" onclick={() => void projectsQuery.refetch()}>
            {t('common.retry')}
          </Button>
        {/snippet}
      </EmptyState>
    </div>
  {:else if !projects.length}
    <EmptyState icon="diamond" title={t('reports_no_projects')} />
  {:else}
    <div class="controls">
      <SegmentedControl
        items={[
          { value: 'burndown', label: t('report_burndown') },
          { value: 'velocity', label: t('report_velocity') },
          { value: 'flow', label: t('report_flow') },
          { value: 'cfd', label: t('report_cfd') },
          { value: 'time', label: t('report_time') },
        ]}
        value={tab}
        onValueChange={(v: string) => (tab = v as Tab)}
      />
      <Select
        value={projectId}
        options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
        onValueChange={(v: string) => (selectedProject = v)}
      />
    </div>

    <section class="panel" data-testid="report-{tab}">
      {#if tab === 'burndown'}
        <h2>{t('report_burndown')}</h2>
        <p class="what">{t('report_burndown_hint')}</p>
        <!-- The cycle list is what decides "no cycle yet", so its own failure has to be told
             apart from an answer of none. -->
        {#if cyclesQuery.isError}
          {@render failed(() => void cyclesQuery.refetch())}
        {:else if cyclesQuery.isPending}
          <div class="state"><Spinner /></div>
        {:else if !activeCycle}
          <p class="empty">{t('report_no_cycle')}</p>
        {:else if burndownQuery.isError}
          {@render failed(() => void burndownQuery.refetch())}
        {:else if burndownQuery.isPending}
          <div class="state"><Spinner /></div>
        {:else if burndownQuery.data}
          <LineChart
            title={t('report_burndown')}
            labels={burndownQuery.data.points.map((p) => shortDate(p.date))}
            series={[
              {
                label: t('report_remaining'),
                values: burndownQuery.data.points.map((p) => p.remaining),
                tone: 1,
              },
              {
                label: t('report_ideal'),
                values: burndownQuery.data.points.map((p) => p.ideal),
                tone: 2,
                dashed: true,
              },
            ]}
          />
        {/if}
      {:else if tab === 'velocity'}
        <h2>{t('report_velocity')}</h2>
        <p class="what">{t('report_velocity_hint')}</p>
        {#if velocityQuery.isError}
          {@render failed(() => void velocityQuery.refetch())}
        {:else if velocityQuery.isPending}
          <div class="state"><Spinner /></div>
        {:else if velocityQuery.data}
          <BarChart
            title={t('report_velocity')}
            labels={velocityQuery.data.cycles.map((c) => c.cycle.name)}
            series={[
              {
                label: t('report_committed'),
                values: velocityQuery.data.cycles.map((c) => c.committed),
                tone: 2,
              },
              {
                label: t('report_completed'),
                values: velocityQuery.data.cycles.map((c) => c.completed),
                tone: 3,
              },
            ]}
          />
          <p class="figure">
            {t('report_average', { value: Math.round(velocityQuery.data.average) })}
          </p>
        {/if}
      {:else if tab === 'flow'}
        <h2>{t('report_flow')}</h2>
        <p class="what">{t('report_flow_hint')}</p>
        {#if flowQuery.isError}
          {@render failed(() => void flowQuery.refetch())}
        {:else if flowQuery.isPending}
          <div class="state"><Spinner /></div>
        {:else if flowQuery.data}
          <!-- Two charts, not three lines on one: a few issues a day and a backlog of forty share
               no useful axis, and putting them together flattens the pair that answers the
               question into a line along the floor. -->
          <LineChart
            title={t('report_flow')}
            labels={flowQuery.data.points.map((p) => shortDate(p.date))}
            series={[
              {
                label: t('report_created'),
                values: flowQuery.data.points.map((p) => p.created),
                tone: 1,
              },
              {
                label: t('report_resolved'),
                values: flowQuery.data.points.map((p) => p.resolved),
                tone: 3,
              },
            ]}
          />
          <h3>{t('report_still_open')}</h3>
          <LineChart
            title={t('report_still_open')}
            height={110}
            labels={flowQuery.data.points.map((p) => shortDate(p.date))}
            series={[
              {
                label: t('report_still_open'),
                values: flowQuery.data.points.map((p) => p.openTotal),
                tone: 4,
              },
            ]}
          />
        {/if}
      {:else if tab === 'cfd'}
        <h2>{t('report_cfd')}</h2>
        <p class="what">{t('report_cfd_hint')}</p>
        {#if cfdQuery.isError}
          {@render failed(() => void cfdQuery.refetch())}
        {:else if cfdQuery.isPending}
          <div class="state"><Spinner /></div>
        {:else if cfdQuery.data}
          <StackedAreaChart
            title={t('report_cfd')}
            labels={cfdQuery.data.points.map((p) => shortDate(p.date))}
            series={cfdQuery.data.statuses.map((status, i) => ({
              label: status.name,
              values: cfdQuery.data.points.map((p) => p.counts[status.id] ?? 0),
              // Five chart tones and any number of statuses: they cycle rather than run out.
              tone: ((i % 5) + 1) as 1 | 2 | 3 | 4 | 5,
            }))}
          />
        {/if}
      {:else}
        <h2>{t('report_time')}</h2>
        <p class="what">{t('report_time_hint')}</p>
        {#if timeQuery.isError}
          {@render failed(() => void timeQuery.refetch())}
        {:else if timeQuery.isPending}
          <div class="state"><Spinner /></div>
        {:else if timeQuery.data}
          {@const report = timeQuery.data}
          <p class="figure">
            {t('report_time_total', {
              total: formatDuration(report.totalSec),
              billable: formatDuration(report.billableSec),
            })}
          </p>
          {#if report.byIssue.length}
            <table class="times">
              <thead>
                <tr>
                  <th scope="col">{t('report_issue')}</th>
                  <th scope="col" class="num">{t('report_logged')}</th>
                  <th scope="col" class="num">{t('report_estimated')}</th>
                </tr>
              </thead>
              <tbody>
                {#each report.byIssue as row (row.issueId)}
                  <tr>
                    <td>
                      <a href={`/${slug}/tracker?issue=${row.issueKey}`}>
                        <span class="ikey">{row.issueKey}</span>
                        {row.title}
                      </a>
                    </td>
                    <td class="num">{formatDuration(row.durationSec)}</td>
                    <td class="num">
                      {row.originalEstimateSec === null
                        ? '—'
                        : formatDuration(row.originalEstimateSec)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {:else}
            <p class="empty">{t('common.no_data')}</p>
          {/if}
        {/if}
      {/if}
    </section>
  {/if}
</div>

<style>
.reports {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding-bottom: 40px;
}
.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 0 var(--kern-gutter, 24px);
}
.panel {
  margin: 14px var(--kern-gutter, 24px) 0;
  padding: 16px 18px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-card);
  background: var(--kern-surface);
}
h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
h3 {
  margin: 16px 0 0;
  font-size: 14px;
  font-weight: 600;
}
.what {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: var(--kern-ink-400);
}
.figure {
  margin: 10px 0 0;
  font-size: 13px;
}
.state {
  display: grid;
  place-items: center;
  padding: 32px;
}
.empty {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--kern-ink-350);
}
.times {
  width: 100%;
  margin-top: 10px;
  border-collapse: collapse;
  font-size: 13px;
}
.times th,
.times td {
  padding: 6px 4px;
  border-bottom: 1px solid var(--kern-border-hairline);
  text-align: start;
}
.times .num {
  text-align: end;
  font-variant-numeric: tabular-nums;
}
.times a {
  color: inherit;
  text-decoration: none;
}
.times a:hover {
  text-decoration: underline;
}
.ikey {
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
  color: var(--kern-ink-400);
}
</style>
