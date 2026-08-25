<script lang="ts">
import {
  Button,
  navigation,
  Select,
  SettingsPage,
  SettingsSection,
  Spinner,
  session,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { canTracker } from '../permissions.js'
import PlanningSections from '../planning/PlanningSections.svelte'
import { trackerKeys } from '../query.js'

/**
 * What a project plans and sorts its work by: cycles, milestones, components, versions and labels.
 *
 * All five have had a server since the module existed and no screen at all, so a project could only
 * ever use what its template happened to seed — and cycles, which no template seeds, meant the
 * sprint progress bar in the issue header had nothing to measure and never appeared. They are
 * project-scoped, which is why this page starts by asking which project — the other tracker
 * settings are workspace wide and do not.
 *
 * The lists themselves live in `PlanningSections`, because a project's own pages in the tracker show
 * exactly the same ones: this screen is for setting several projects up at once, that one is for
 * adding a component while looking at the work it is for.
 */
const api = getTrackerApi()

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
let selectedId = $state<string | null>(null)
const asked = $derived(navigation.search.project)

const projectsQuery = createQuery(() => ({
  queryKey: trackerKeys.projects(workspaceId),
  queryFn: () => api.projects.list({ workspaceId }),
  enabled: Boolean(workspaceId),
}))
const projects = $derived(projectsQuery.data ?? [])
const projectId = $derived(
  selectedId ?? (asked && projects.some((p) => p.id === asked) ? asked : (projects[0]?.id ?? '')),
)

/**
 * The intake link.
 *
 * `setIntake` returns the token and nothing else stores it, so the page keeps what it was handed.
 * Turning intake off returns `null`, which is the same thing as "there is no link" — the form then
 * says it is unavailable rather than accepting requests nobody reads.
 */
let intakeToken = $state<string | null>(null)
const intakeUrl = $derived(
  intakeToken ? `${typeof location === 'undefined' ? '' : location.origin}/request/${intakeToken}` : '',
)

const setIntake = createMutation(() => ({
  mutationFn: (input: { enabled: boolean; rotate: boolean }) =>
    api.projects.setIntake({ workspaceId, projectId, ...input }),
  onSuccess: (result: { token: string | null }) => {
    intakeToken = result.token
    toast.success(result.token ? t('intake_opened') : t('intake_closed'))
  },
  onError: (error: Error) => toast.error(error.message),
}))

/** Switching project drops the link: it belonged to the project that was showing. */
$effect(() => {
  void projectId
  intakeToken = null
})

const copyLink = async () => {
  try {
    await navigator.clipboard.writeText(intakeUrl)
    toast.success(t('intake_copied'))
  } catch {
    // A denied clipboard is not a failure worth an error: the link is on screen to select.
    toast.info(t('intake_copy_manually'))
  }
}
</script>

<SettingsPage title={t('settings_planning')} description={t('settings_planning_hint')}>
  {#if projectsQuery.isPending}
    <SettingsSection><div class="state"><Spinner /></div></SettingsSection>
  {:else if !projects.length}
    <SettingsSection>
      <p class="state">{t('settings_planning_no_projects')}</p>
    </SettingsSection>
  {:else}
    <SettingsSection title={t('settings_planning_project')}>
      <Select
        value={projectId}
        options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
        onValueChange={(v: string) => (selectedId = v)}
      />
    </SettingsSection>

    <SettingsSection title={t('intake_title')} description={t('intake_hint')}>
      {#if intakeToken}
        <p class="intake-link">
          <code data-testid="intake-link">{intakeUrl}</code>
        </p>
        <div class="row">
          <Button size="sm" variant="ghost" onclick={() => copyLink()} data-testid="intake-copy">
            {t('intake_copy')}
          </Button>
          <Button size="sm" variant="ghost" onclick={() => setIntake.mutate({ enabled: true, rotate: true })}>
            {t('intake_rotate')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onclick={() => setIntake.mutate({ enabled: false, rotate: false })}
            data-testid="intake-close"
          >
            {t('intake_close')}
          </Button>
        </div>
        <p class="note">{t('intake_rotate_hint')}</p>
      {:else}
        <Button
          size="sm"
          disabled={!canManage}
          loading={setIntake.isPending}
          onclick={() => setIntake.mutate({ enabled: true, rotate: false })}
          data-testid="intake-open"
        >
          {t('intake_open')}
        </Button>
      {/if}
    </SettingsSection>

    <SettingsSection>
      <PlanningSections {workspaceId} {projectId} editable={canManage} />
    </SettingsSection>
  {/if}
</SettingsPage>

<style>
.intake-link {
  margin: 0 0 8px;
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.intake-link code {
  font-family: var(--kern-font-mono);
}
.row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.note {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--kern-ink-400);
}
.state {
  display: grid;
  place-items: center;
  padding: 24px;
  font-size: 13px;
}
</style>
