<script lang="ts">
import {
  Badge,
  Button,
  messageLocale,
  navigation,
  ProgressBar,
  Select,
  SettingsPage,
  SettingsSection,
  Spinner,
  session,
  toast,
  uploadFile,
} from '@kernhq/ui'
import { createMutation, createQuery } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { previewCsv } from '../csv.js'
import { t } from '../i18n.js'
import type { ImportJob } from '../index.js'
import { canTracker } from '../permissions.js'
import { trackerKeys } from '../query.js'

/**
 * Bringing work in from somewhere else.
 *
 * The columns are read in the browser before anything is uploaded, so the mapping screen offers the
 * file's real names and a row of its real values. Asking somebody to map "column 3" turns a
 * five-minute import into a spreadsheet-counting exercise.
 *
 * Nothing is imported until the mapping is confirmed. An import that guesses is an import somebody
 * has to undo, and there is no undo.
 */
const api = getTrackerApi()

const slug = $derived(navigation.workspaceSlug)
const workspaceId = $derived(session.workspaces.find((w) => w.slug === slug)?.id ?? '')
const canManage = $derived(canTracker('projectManage'))

/** `''` means "do not import this column", which is the safe default for every one of them. */
const DESTINATIONS = [
  { value: '', label: () => t('import_skip') },
  { value: 'title', label: () => t('import_field_title') },
  { value: 'description', label: () => t('import_field_description') },
  { value: 'status', label: () => t('import_field_status') },
  { value: 'priority', label: () => t('import_field_priority') },
  { value: 'assignee', label: () => t('import_field_assignee') },
  { value: 'labels', label: () => t('import_field_labels') },
  { value: 'due', label: () => t('import_field_due') },
  { value: 'estimate', label: () => t('import_field_estimate') },
  { value: 'key', label: () => t('import_field_key') },
]

let selectedProject = $state<string | null>(null)
let file = $state<File | null>(null)
let fileInput = $state<HTMLInputElement | null>(null)
let preview = $state<{ columns: string[]; rows: string[][] }>({ columns: [], rows: [] })
let mapping = $state<Record<string, string>>({})
let hasHeader = $state(true)
let jobId = $state<string | null>(null)

const projectsQuery = createQuery(() => ({
  queryKey: trackerKeys.projects(workspaceId),
  queryFn: () => api.projects.list({ workspaceId }),
  enabled: Boolean(workspaceId),
}))
const projects = $derived(projectsQuery.data ?? [])
const projectId = $derived(selectedProject ?? projects[0]?.id ?? '')

const fieldsQuery = createQuery(() => ({
  queryKey: trackerKeys.fields(workspaceId),
  queryFn: () => api.fields.list({ workspaceId, includeArchived: false }),
  enabled: Boolean(workspaceId),
}))

/** A column can go to a built-in field or to any custom field, by the same `cf.<key>` name KQL uses. */
const destinations = $derived([
  ...DESTINATIONS.map((d) => ({ value: d.value, label: d.label() })),
  ...(fieldsQuery.data ?? []).map((f) => ({ value: `cf.${f.key}`, label: f.name })),
])

/** Polls only while something is running: a finished import has nothing more to say. */
const jobQuery = createQuery(() => ({
  queryKey: [...trackerKeys.projects(workspaceId), 'import', jobId ?? ''],
  queryFn: () => api.imports.get({ workspaceId, id: jobId as string }),
  enabled: Boolean(jobId),
  refetchInterval: (query: { state: { data?: ImportJob } }) =>
    query.state.data && ['completed', 'failed', 'cancelled'].includes(query.state.data.status) ? false : 1500,
}))
const job = $derived((jobQuery.data ?? null) as ImportJob | null)
const running = $derived(job ? ['pending', 'running'].includes(job.status) : false)

async function chooseFile(list: FileList | null) {
  const chosen = list?.[0]
  if (!chosen) return
  file = chosen
  jobId = null
  const text = await chosen.text()
  preview = previewCsv(text, { hasHeader })
  // Nothing is mapped to begin with. A guess that lands a "Notes" column in the title is worse
  // than an empty form, because nobody re-reads a field that already looks filled in.
  mapping = {}
}

const start = createMutation(() => ({
  mutationFn: async () => {
    const uploaded = await uploadFile({
      workspaceId,
      file: file as File,
      name: (file as File).name,
      mimeType: 'text/csv',
    })
    const columns: Record<string, string> = {}
    for (const [column, destination] of Object.entries(mapping))
      if (destination) columns[column] = destination
    return api.imports.start({
      workspaceId,
      projectId,
      source: 'csv',
      fileId: uploaded.id,
      mapping: { columns, hasHeader, delimiter: ',' },
    } as never)
  },
  onSuccess: (created: ImportJob) => {
    jobId = created.id
  },
  onError: (error: Error) => toast.error(error.message),
}))

const cancel = createMutation(() => ({
  mutationFn: () => api.imports.cancel({ workspaceId, id: jobId as string }),
  onError: (error: Error) => toast.error(error.message),
}))

/**
 * What was imported before.
 *
 * An import is the one thing here that happens to a project rather than in front of you: it runs,
 * you navigate away, and afterwards the only question is what it did. `imports.list` answered that
 * from the start and nothing asked it, so leaving the page lost the outcome for good.
 */
const historyQuery = createQuery(() => ({
  queryKey: [...trackerKeys.projects(workspaceId), 'imports', projectId],
  queryFn: () => api.imports.list({ workspaceId, projectId }),
  enabled: Boolean(projectId),
}))
/** Newest first: the one somebody is looking for is almost always the last one. */
const history = $derived(
  [...(historyQuery.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
)

const STATUS_LABELS: Record<string, () => string> = {
  pending: () => t('import_pending'),
  running: () => t('import_running'),
  completed: () => t('import_completed'),
  failed: () => t('import_failed'),
  cancelled: () => t('import_cancelled'),
}
const statusLabel = (status: string) => STATUS_LABELS[status]?.() ?? status
const when = new Intl.DateTimeFormat(messageLocale(), { dateStyle: 'medium', timeStyle: 'short' })

/** A title is the one thing an issue cannot be created without. */
const mappedTitle = $derived(Object.values(mapping).includes('title'))
const canStart = $derived(Boolean(file) && mappedTitle && canManage && !running)
</script>

<SettingsPage title={t('settings_import')} description={t('settings_import_hint')}>
  {#if projectsQuery.isPending}
    <SettingsSection><div class="state"><Spinner /></div></SettingsSection>
  {:else if projectsQuery.isError}
    <SettingsSection>
      <div class="state">
        <p>{t('projects_failed')}</p>
        <Button size="sm" variant="ghost" onclick={() => void projectsQuery.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    </SettingsSection>
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

    <SettingsSection title={t('import_file')} description={t('import_file_hint')}>
      <!-- The native file control cannot be styled and read as "Choose File  No file chosen" in
           the browser's own font; the input stays for the browser and the tests, the button is
           what people see. -->
      <div class="pick">
        <input
          bind:this={fileInput}
          class="sr-only"
          type="file"
          accept=".csv,text/csv"
          aria-label={t('import_file')}
          data-testid="import-file"
          tabindex="-1"
          onchange={(e) => {
            void chooseFile(e.currentTarget.files)
          }}
        />
        <Button variant="secondary" icon="upload" onclick={() => fileInput?.click()}>
          {file ? t('import_choose_another') : t('import_choose')}
        </Button>
        <span class="picked">{file ? file.name : t('import_no_file')}</span>
      </div>
      <label class="check">
        <input
          type="checkbox"
          checked={hasHeader}
          onchange={async (e) => {
            hasHeader = e.currentTarget.checked
            if (file) preview = previewCsv(await file.text(), { hasHeader })
          }}
        />
        {t('import_has_header')}
      </label>
    </SettingsSection>

    {#if preview.columns.length}
      <SettingsSection title={t('import_mapping')} description={t('import_mapping_hint')}>
        <table class="map" data-testid="import-mapping">
          <thead>
            <tr>
              <th scope="col">{t('import_column')}</th>
              <th scope="col">{t('import_example')}</th>
              <th scope="col">{t('import_goes_to')}</th>
            </tr>
          </thead>
          <tbody>
            {#each preview.columns as column, i (column + i)}
              <tr>
                <th scope="row">{column}</th>
                <td class="example">{preview.rows[0]?.[i] ?? ''}</td>
                <td>
                  <Select
                    value={mapping[column] ?? ''}
                    options={destinations}
                    onValueChange={(v: string) => (mapping = { ...mapping, [column]: v })}
                  />
                </td>
              </tr>
            {/each}
          </tbody>
        </table>

        {#if !mappedTitle}
          <p class="warn" data-testid="needs-title">{t('import_needs_title')}</p>
        {/if}

        {#snippet footer()}
          <Button
            size="sm"
            disabled={!canStart}
            loading={start.isPending}
            onclick={() => start.mutate()}
            data-testid="import-start"
          >
            {t('import_start')}
          </Button>
        {/snippet}
      </SettingsSection>
    {/if}

    {#if job}
      <SettingsSection title={t('import_progress')}>
        <div class="jrow" data-testid="import-job">
          <Badge tone={job.status === 'failed' ? 'danger' : undefined}>{statusLabel(job.status)}</Badge>
          <span class="counts">
            {t('import_counts', {
              created: job.progress.created,
              processed: job.progress.processed,
              total: job.progress.total,
              failed: job.progress.failed,
            })}
          </span>
          {#if running}
            <Button size="sm" variant="ghost" onclick={() => cancel.mutate()}>{t('common.cancel')}</Button>
          {/if}
        </div>
        <ProgressBar
          value={job.progress.total ? (job.progress.processed / job.progress.total) * 100 : 0}
        />
        {#if job.errors.length}
          <ul class="errors">
            {#each job.errors.slice(0, 20) as problem, i (problem.message + i)}
              <li>
                {#if problem.row !== null}<span class="row">{t('import_row', { row: problem.row })}</span>{/if}
                {problem.message}
              </li>
            {/each}
          </ul>
          {#if job.errors.length > 20}
            <p class="note">{t('import_more_errors', { count: job.errors.length - 20 })}</p>
          {/if}
        {/if}
      </SettingsSection>
    {/if}

    {#if history.length}
      <SettingsSection title={t('import_history')} description={t('import_history_hint')}>
        <ul class="history" data-testid="import-history">
          {#each history as past (past.id)}
            <li>
              <button type="button" onclick={() => (jobId = past.id)} data-testid="import-history-row">
                <Badge tone={past.status === 'failed' ? 'danger' : undefined}>
                  {statusLabel(past.status)}
                </Badge>
                <span class="hwhen">{when.format(new Date(past.createdAt))}</span>
                <span class="counts">
                  {t('import_counts', {
                    created: past.progress.created,
                    processed: past.progress.processed,
                    total: past.progress.total,
                    failed: past.progress.failed,
                  })}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </SettingsSection>
    {/if}
  {/if}
</SettingsPage>

<style>
.history {
  list-style: none;
  margin: 0;
  padding: 0;
}
.history button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.history button:hover .hwhen {
  color: var(--kern-ink-700);
}
.hwhen {
  flex: 1;
  font-size: 12.5px;
  color: var(--kern-ink-550);
}
.state {
  display: grid;
  place-items: center;
  gap: 8px;
  padding: 24px;
  font-size: 13px;
}
.pick {
  display: flex;
  align-items: center;
  gap: 10px;
}
.picked {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--kern-ink-550);
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 13px;
}
.map {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.map th,
.map td {
  padding: 6px 8px 6px 0;
  border-bottom: 1px solid var(--kern-border-hairline);
  text-align: start;
  vertical-align: middle;
}
.map thead th {
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--kern-ink-400);
}
.example {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--kern-ink-450, var(--kern-ink-400));
}
.warn {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--kern-warning);
}
.jrow {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.counts {
  flex: 1;
  font-size: 13px;
}
.errors {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12.5px;
  color: var(--kern-danger);
}
.errors .row {
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
  margin-inline-end: 6px;
}
.note {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--kern-ink-400);
}
</style>
