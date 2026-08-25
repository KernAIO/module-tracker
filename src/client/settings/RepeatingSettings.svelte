<script lang="ts">
import {
  Badge,
  Button,
  Icon,
  IconButton,
  Input,
  navigation,
  Select,
  SettingsPage,
  SettingsSection,
  Spinner,
  session,
} from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { RecurrenceRule } from '../index.js'
import { canTracker } from '../permissions.js'
import { trackerKeys } from '../query.js'
import { describeRecurrence, type RecurrenceStrings } from '../recurrence.js'
import { listMutation } from './mutations'

/**
 * Work that comes back: issue templates, and issues that create themselves.
 *
 * Both had a server and no screen. A recurring issue in particular is something you set up once and
 * then have to trust — so what it will do is spelled out in a sentence, and when it last ran and
 * what it made are shown beside it, because a schedule you cannot check is a schedule you cannot
 * rely on.
 */
const api = getTrackerApi()
const queryClient = useQueryClient()

const slug = $derived(navigation.workspaceSlug)
const workspaceId = $derived(session.workspaces.find((w) => w.slug === slug)?.id ?? '')
const canManage = $derived(canTracker('projectManage'))

/**
 * Which project the page is on, and how a link can say so.
 *
 * `?project=<id>` is what the sidebar's project menu links to — landing on the project you clicked
 * rather than on whichever one happens to be first. An id for a project this workspace does not
 * have is ignored rather than obeyed, so a stale link opens the page instead of an empty one.
 */
let selectedProject = $state<string | null>(null)
const asked = $derived(navigation.search.project)
let newName = $state('')
let freq = $state<RecurrenceRule['freq']>('weekly')
let at = $state('09:00')

const projectsQuery = createQuery(() => ({
  queryKey: trackerKeys.projects(workspaceId),
  queryFn: () => api.projects.list({ workspaceId }),
  enabled: Boolean(workspaceId),
}))
const projects = $derived(projectsQuery.data ?? [])
const projectId = $derived(
  selectedProject ?? (asked && projects.some((p) => p.id === asked) ? asked : (projects[0]?.id ?? '')),
)

const templatesQuery = createQuery(() => ({
  queryKey: [...trackerKeys.projects(workspaceId), 'issue-templates', projectId],
  queryFn: () => api.issues.templates.list({ workspaceId, projectId }),
  enabled: Boolean(projectId),
}))
const recurringQuery = createQuery(() => ({
  queryKey: [...trackerKeys.projects(workspaceId), 'recurring', projectId],
  queryFn: () => api.issues.recurring.list({ workspaceId, projectId }),
  enabled: Boolean(projectId),
}))

const refresh = () => queryClient.invalidateQueries({ queryKey: trackerKeys.projects(workspaceId) })

const addRecurring = listMutation(
  (input: { name: string; rule: RecurrenceRule }) =>
    api.issues.recurring.create({
      workspaceId,
      projectId,
      name: input.name,
      rule: input.rule,
      defaults: { title: input.name },
    } as never),
  refresh,
)
const toggleRecurring = listMutation(
  (input: { id: string; enabled: boolean }) =>
    api.issues.recurring.update({ workspaceId, id: input.id, patch: { enabled: input.enabled } }),
  refresh,
)
const removeRecurring = listMutation(
  (id: string) => api.issues.recurring.delete({ workspaceId, id }),
  refresh,
)
const removeTemplate = listMutation((id: string) => api.issues.templates.delete({ workspaceId, id }), refresh)

/** The wording, handed to the describer so the sentence can be built and tested separately. */
const strings: RecurrenceStrings = {
  every: (unit) => t('recur_every', { unit }),
  everyN: (n, unit) => t('recur_every_n', { n, unit }),
  day: t('recur_day'),
  week: t('recur_week'),
  month: t('recur_month'),
  year: t('recur_year'),
  on: (when, days) => t('recur_on', { when, days }),
  dayOfMonth: (day) => t('recur_day_of_month', { day }),
  at: (when, time) => t('recur_at', { when, time }),
  times: (text, count) => t('recur_times', { text, count }),
  until: (text, date) => t('recur_until', { text, date }),
}

const add = () => {
  const name = newName.trim()
  if (!name) return
  addRecurring.mutate({ name, rule: { freq, interval: 1, at } as RecurrenceRule })
  newName = ''
}

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : t('repeat_never'))
</script>

<SettingsPage title={t('settings_repeating')} description={t('settings_repeating_hint')}>
  {#if projectsQuery.isPending}
    <SettingsSection><div class="state"><Spinner /></div></SettingsSection>
  {:else if !projects.length}
    <SettingsSection><p class="state">{t('settings_planning_no_projects')}</p></SettingsSection>
  {:else}
    <SettingsSection title={t('settings_planning_project')}>
      <Select
        value={projectId}
        options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
        onValueChange={(v: string) => (selectedProject = v)}
      />
    </SettingsSection>

    <SettingsSection title={t('repeat_title')} description={t('repeat_hint')}>
      {#if recurringQuery.isPending}
        <div class="state"><Spinner /></div>
      {:else}
        <ul class="rows" data-testid="recurring-list">
          {#each recurringQuery.data ?? [] as entry (entry.id)}
            <li>
              <div class="what">
                <span class="name">{entry.name}</span>
                <span class="rule">{describeRecurrence(entry.rule, strings)}</span>
                <span class="ran">
                  {t('repeat_last_run', { when: when(entry.lastRunAt) })}
                  · {t('repeat_next_run', { when: when(entry.nextRunAt) })}
                  · {t('repeat_made', { count: entry.runCount })}
                </span>
              </div>
              {#if !entry.enabled}<Badge>{t('repeat_paused')}</Badge>{/if}
              {#if canManage}
                <!-- A verb rather than a switch: "Pause" says what will happen, where a toggle
                     asks somebody to work out which way is on. -->
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={() => toggleRecurring.mutate({ id: entry.id, enabled: !entry.enabled })}
                  data-testid="recurring-toggle"
                >
                  {entry.enabled ? t('repeat_pause') : t('repeat_resume')}
                </Button>
                <IconButton
                  icon="x"
                  size={22}
                  label={t('planning_remove', { name: entry.name })}
                  onclick={() => removeRecurring.mutate(entry.id)}
                />
              {/if}
            </li>
          {:else}
            <li class="empty">{t('repeat_empty')}</li>
          {/each}
        </ul>

        {#if canManage}
          <div class="add">
            <Input bind:value={newName} placeholder={t('repeat_name')} data-testid="recurring-name" />
            <Select
              value={freq}
              options={[
                { value: 'daily', label: t('recur_day') },
                { value: 'weekly', label: t('recur_week') },
                { value: 'monthly', label: t('recur_month') },
              ]}
              onValueChange={(v: string) => (freq = v as RecurrenceRule['freq'])}
            />
            <Input bind:value={at} type="time" aria-label={t('repeat_at')} />
            <Button size="sm" disabled={!newName.trim()} onclick={add} data-testid="recurring-add">
              {t('common.add')}
            </Button>
          </div>
          <p class="note">{t('repeat_note')}</p>
        {/if}
      {/if}
    </SettingsSection>

    <SettingsSection title={t('template_title')} description={t('template_hint')}>
      {#if templatesQuery.isPending}
        <div class="state"><Spinner /></div>
      {:else}
        <ul class="rows" data-testid="template-list">
          {#each templatesQuery.data ?? [] as template (template.id)}
            <li>
              <div class="what">
                <span class="name">{template.name}</span>
                {#if template.description}<span class="rule">{template.description}</span>{/if}
                {#if template.subItems.length}
                  <span class="ran">{t('template_subitems', { count: template.subItems.length })}</span>
                {/if}
              </div>
              {#if canManage}
                <IconButton
                  icon="x"
                  size={22}
                  label={t('planning_remove', { name: template.name })}
                  onclick={() => removeTemplate.mutate(template.id)}
                />
              {/if}
            </li>
          {:else}
            <li class="empty">
              <Icon name="bookmark" size={13} strokeWidth={1.8} />
              {t('template_empty')}
            </li>
          {/each}
        </ul>
      {/if}
    </SettingsSection>
  {/if}
</SettingsPage>

<style>
.state {
  display: grid;
  place-items: center;
  padding: 24px;
  font-size: 13px;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.rows li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--kern-border-hairline);
}
.rows li:last-child {
  border-bottom: 0;
}
.what {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}
.name {
  font-size: 13px;
  color: var(--kern-ink-800);
}
.rule {
  font-size: 12.5px;
  color: var(--kern-ink-550);
}
.ran {
  font-size: 11.5px;
  color: var(--kern-ink-400);
}
.empty {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--kern-ink-400);
}
.add {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.note {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--kern-ink-400);
}
</style>
