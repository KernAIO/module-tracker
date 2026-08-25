<script lang="ts">
import { Button, Icon, IconButton, Input, relativeTime, session, toast } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { getTrackerCatalogue } from '../context.svelte.js'
import { t } from '../i18n.js'
import { formatDuration, type Timer, type Worklog } from '../index.js'
import { canTracker } from '../permissions.js'
import { trackerKeys } from '../query.js'
import { parseDuration } from '../time.js'

/**
 * Time spent on an issue: a running timer, and the work already logged.
 *
 * The server has had both since the module existed and nothing offered either, so `timeSpentSec`
 * on an issue could only ever be zero. A timer belongs to a person rather than to an issue —
 * starting one anywhere stops the one you had running — so the control says which issue it is on.
 */
interface Props {
  workspaceId: string
  issueId: string
  canLog: boolean
}
let { workspaceId, issueId, canLog }: Props = $props()

const api = getTrackerApi()
const cat = getTrackerCatalogue()
const queryClient = useQueryClient()

let manual = $state('')
let adding = $state(false)

const worklogsQuery = createQuery(() => ({
  queryKey: trackerKeys.worklogs(workspaceId, issueId),
  queryFn: () => api.worklogs.list({ workspaceId, issueId }),
}))
const timerQuery = createQuery(() => ({
  queryKey: trackerKeys.timer(workspaceId),
  queryFn: () => api.worklogs.timers.current({ workspaceId }),
  // A timer runs while nobody is looking, so its elapsed time has to be refreshed rather than read
  // once and left to drift.
  refetchInterval: 30_000,
}))

const worklogs = $derived(worklogsQuery.data ?? [])
const timer = $derived((timerQuery.data ?? null) as Timer | null)
const onThisIssue = $derived(timer?.issueId === issueId)
const total = $derived(worklogs.reduce((sum, w) => sum + w.durationSec, 0))

const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: trackerKeys.worklogs(workspaceId, issueId) })
  void queryClient.invalidateQueries({ queryKey: trackerKeys.timer(workspaceId) })
  void queryClient.invalidateQueries({ queryKey: trackerKeys.issue(workspaceId, issueId) })
}
const fail = (error: Error) => toast.error(error.message)

const start = createMutation(() => ({
  mutationFn: () => api.worklogs.timers.start({ workspaceId, issueId }),
  onSuccess: refresh,
  onError: fail,
}))
const stop = createMutation(() => ({
  mutationFn: (discard: boolean) => api.worklogs.timers.stop({ workspaceId, discard }),
  onSuccess: refresh,
  onError: fail,
}))
const log = createMutation(() => ({
  mutationFn: (durationSec: number) =>
    api.worklogs.create({ workspaceId, issueId, durationSec, adjustRemaining: 'auto' }),
  onSuccess: () => {
    manual = ''
    adding = false
    refresh()
  },
  onError: fail,
}))
const remove = createMutation(() => ({
  mutationFn: (id: string) => api.worklogs.delete({ workspaceId, id }),
  onSuccess: refresh,
  onError: fail,
}))

/**
 * Correcting an entry.
 *
 * `worklogs.update` existed from the start and nothing called it, so "2h" typed where "20m" was
 * meant could only be deleted and logged again — which moves the entry to now and loses the day it
 * was worked.
 */
const edit = createMutation(() => ({
  mutationFn: (input: { id: string; durationSec: number }) =>
    api.worklogs.update({ workspaceId, id: input.id, patch: { durationSec: input.durationSec } }),
  onSuccess: () => {
    editingId = null
    refresh()
  },
  onError: fail,
}))

let editingId = $state<string | null>(null)
let editDraft = $state('')
const editParsed = $derived(parseDuration(editDraft))

const startEdit = (entry: { id: string; durationSec: number }) => {
  editingId = entry.id
  editDraft = formatDuration(entry.durationSec)
}
const commitEdit = () => {
  const id = editingId
  if (!id || editParsed === null) return
  edit.mutate({ id, durationSec: editParsed })
}

const parsed = $derived(parseDuration(manual))
const elapsed = $derived(
  timer ? Math.max(0, Math.floor((Date.now() - Date.parse(timer.startedAt)) / 1000)) : 0,
)
const who = (userId: string) =>
  userId === session.user?.id ? t('time_you') : (cat.person(userId)?.name ?? '')
</script>

<section class="time" data-testid="issue-time">
  <div class="thead">
    <span class="kern-sublabel">{t('time_title')}</span>
    {#if total > 0}<span class="total">{formatDuration(total)}</span>{/if}
  </div>

  {#if canLog}
    <div class="row">
      {#if onThisIssue}
        <Button size="sm" onclick={() => stop.mutate(false)} data-testid="timer-stop">
          <Icon name="clock" size={13} strokeWidth={1.9} />
          {t('time_stop', { elapsed: formatDuration(elapsed) })}
        </Button>
        <Button size="sm" variant="ghost" onclick={() => stop.mutate(true)}>
          {t('time_discard')}
        </Button>
      {:else}
        <Button size="sm" variant="secondary" onclick={() => start.mutate()} data-testid="timer-start">
          <Icon name="clock" size={13} strokeWidth={1.9} />
          {t('time_start')}
        </Button>
        {#if timer}
          <!-- A timer belongs to a person, so starting one here stops the one running elsewhere. -->
          <span class="elsewhere">{t('time_running_elsewhere')}</span>
        {/if}
      {/if}

      {#if adding}
        <Input
          bind:value={manual}
          placeholder={t('time_placeholder')}
          data-testid="time-amount"
          onkeydown={(e: KeyboardEvent) => {
            if (e.key === 'Enter' && parsed) log.mutate(parsed)
            if (e.key === 'Escape') adding = false
          }}
        />
        <Button size="sm" disabled={!parsed} onclick={() => parsed && log.mutate(parsed)} data-testid="time-log">
          {t('time_log')}
        </Button>
      {:else}
        <button type="button" class="manual" onclick={() => (adding = true)}>
          {t('time_log_manually')}
        </button>
      {/if}
    </div>
  {/if}

  {#if worklogs.length}
    <ul class="logs">
      {#each worklogs as entry (entry.id)}
        <li>
          {#if editingId === entry.id}
            <input
              class="edur"
              value={editDraft}
              aria-label={t('time_edit')}
              data-testid="worklog-edit"
              oninput={(e) => (editDraft = e.currentTarget.value)}
              onblur={commitEdit}
              onkeydown={(e) => {
                if (e.key === 'Enter') commitEdit()
                if (e.key === 'Escape') editingId = null
              }}
            />
          {:else if canLog && entry.userId === session.user?.id}
            <button
              type="button"
              class="dur edit"
              title={t('time_edit')}
              onclick={() => startEdit(entry)}
              data-testid="worklog-duration"
            >
              {formatDuration(entry.durationSec)}
            </button>
          {:else}
            <span class="dur">{formatDuration(entry.durationSec)}</span>
          {/if}
          <span class="by">{who(entry.userId)}</span>
          <time datetime={entry.startedAt}>{relativeTime(entry.startedAt)}</time>
          {#if entry.note}<span class="note">{entry.note}</span>{/if}
          {#if canLog && entry.userId === session.user?.id}
            <IconButton
              icon="x"
              size={22}
              label={t('time_remove')}
              onclick={() => remove.mutate(entry.id)}
            />
          {/if}
        </li>
      {/each}
    </ul>
  {:else if !canLog}
    <p class="empty">{t('time_empty')}</p>
  {/if}
</section>

<style>
.time {
  margin-top: 16px;
}
.thead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.edit {
  padding: 1px 4px;
  margin-inline-start: -4px;
  border: 0;
  border-radius: var(--kern-r-sm);
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.edit:hover {
  background: var(--kern-surface-hover);
}
.edur {
  width: 72px;
  padding: 1px 4px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-sm);
  background: var(--kern-surface);
  color: inherit;
  font: inherit;
}
.total {
  font-size: 13px;
  font-weight: 600;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.manual,
.elsewhere {
  border: 0;
  background: none;
  color: var(--kern-ink-350);
  font: inherit;
  font-size: 12px;
  padding: 2px 4px;
}
.manual {
  cursor: pointer;
}
.manual:hover {
  color: var(--kern-ink-900);
}
.logs {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.logs li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}
.dur {
  font-weight: 600;
  min-width: 42px;
}
.by {
  color: var(--kern-ink-550);
}
.note,
time {
  color: var(--kern-ink-350);
}
.empty {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--kern-ink-350);
}
</style>
