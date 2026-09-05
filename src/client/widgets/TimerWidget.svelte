<script lang="ts">
import type { WidgetProps } from '@kernhq/ui'
import { Button, toast } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { formatDuration } from '../index.js'

/**
 * The running timer, and the one thing you want to do with it.
 *
 * A timer you can see but not stop is worse than no timer at all, so Stop is the whole card. The
 * elapsed figure ticks locally rather than by refetching — a query every second to render a clock
 * would be absurd.
 */
let { workspaceId, workspaceSlug }: WidgetProps = $props()

const api = getTrackerApi()
const client = useQueryClient()

const query = createQuery(() => ({
  queryKey: ['tracker', 'timer', workspaceId],
  queryFn: () => api.worklogs.timers.current({ workspaceId }),
  enabled: Boolean(workspaceId),
}))

const timer = $derived(query.data?.timer ?? null)

/** `Timer` carries an issue id and nothing else, so the card asks what it is timing. */
const issue = createQuery(() => ({
  queryKey: ['tracker', 'issue', workspaceId, timer?.issueId ?? ''],
  queryFn: () => api.issues.get({ workspaceId, issueId: timer!.issueId }),
  enabled: Boolean(timer?.issueId),
}))

let now = $state(Date.now())
$effect(() => {
  if (!timer) return
  const handle = setInterval(() => (now = Date.now()), 1000)
  return () => clearInterval(handle)
})

const elapsed = $derived(
  timer ? Math.max(0, Math.floor((now - new Date(timer.startedAt).getTime()) / 1000)) : 0,
)

const stop = createMutation(() => ({
  mutationFn: () => api.worklogs.timers.stop({ workspaceId, discard: false }),
  onSuccess: () => {
    toast.success(t('widget_timer_stopped'))
    void client.invalidateQueries({ queryKey: ['tracker'] })
  },
  onError: (e: unknown) => toast.error(e instanceof Error ? e.message : t('common.error')),
}))
</script>

<div class="wrap">
  <p class="label">{t('widget_timer_title')}</p>
  {#if query.isPending}
    <p class="idle">{t('common.loading')}</p>
  {:else if query.isError}
    <!-- "No timer running" for a query that failed is a lie told to the one person who would
         notice: somebody whose clock is running and who now believes it is not. -->
    <div class="failed">
      <p class="idle">{t('common.error')}</p>
      <Button size="xs" variant="ghost" onclick={() => void query.refetch()}>{t('common.retry')}</Button>
    </div>
  {:else if !timer}
    <p class="idle">{t('widget_timer_idle')}</p>
  {:else}
    <a class="issue" href="/{workspaceSlug}/tracker?issue={timer.issueId}">
      {issue.data?.key ?? '—'}
      {#if issue.data?.title}<span class="what">{issue.data.title}</span>{/if}
    </a>
    <p class="clock">{formatDuration(elapsed)}</p>
    <Button size="sm" variant="secondary" loading={stop.isPending} onclick={() => stop.mutate()}>
      {t('widget_timer_stop')}
    </Button>
  {/if}
</div>

<style>
  .wrap {
    display: grid;
    justify-items: start;
    align-content: center;
    gap: 6px;
    height: 100%;
    padding: 14px 16px;
  }
  .label {
    font-size: 12px;
    color: var(--kern-ink-500);
  }
  .idle {
    font-size: 12.5px;
    color: var(--kern-ink-450);
  }
  .failed {
    display: grid;
    justify-items: start;
    gap: 4px;
  }
  .issue {
    display: flex;
    gap: 6px;
    align-items: baseline;
    max-width: 100%;
    font-family: var(--kern-font-mono);
    font-size: 11.5px;
    color: var(--kern-ink-450);
  }
  .what {
    font-family: var(--kern-font-sans);
    color: var(--kern-ink-600);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .clock {
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.03em;
    line-height: 1;
    color: var(--kern-ink-900);
    font-variant-numeric: tabular-nums;
  }
</style>
