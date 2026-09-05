<script lang="ts">
import {
  Button,
  DropdownMenu,
  formatCount,
  IconButton,
  type MenuItem,
  navigation,
  SidebarGroup,
  SidebarItem,
  SidebarPill,
  Skeleton,
  session,
} from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { Project } from '../index.js'
import {
  isTrackerTarget,
  type ProjectSection,
  projectColor,
  projectSectionHref,
  projectSettingsHref,
  projectTargets,
  type TrackerTarget,
  trackerHref,
} from '../nav.js'
import { canTracker } from '../permissions.js'
import { trackerKeys } from '../query.js'

/**
 * The workspace's projects, in the sidebar (DESIGN.md 2.3).
 *
 * A project is a heading with the ways its work is looked at underneath — its issues, and the
 * planning it actually uses. Cycles and triage appear only for the projects that turned them on:
 * a row that leads to an empty screen for most of a workspace is a row people learn to ignore.
 *
 * The rows open the project's own pages, where a component is added and a milestone marked
 * reached. What is genuinely configuration — repeating work, the project's settings — stays in the
 * menu, because those are places you go once and the rows above are places you go daily.
 */
interface Props {
  /** the sidebar's own "new project", so the dialog opens on the page you are on */
  oncreate?: () => void
}
let { oncreate }: Props = $props()

const api = getTrackerApi()

const slug = $derived(navigation.workspaceSlug)
const workspaceId = $derived(session.workspaces.find((w) => w.slug === slug)?.id ?? '')
const params = $derived(new URLSearchParams(navigation.search))
const inTracker = $derived(navigation.pathname === `/${slug}/tracker`)
const canManage = $derived(canTracker('projectManage'))

const projectsQuery = createQuery(() => ({
  queryKey: trackerKeys.projects(workspaceId),
  queryFn: () => api.projects.list({ workspaceId }),
  enabled: Boolean(workspaceId),
}))
const projects = $derived(projectsQuery.data ?? [])

/**
 * Which projects are folded away, kept on the device.
 *
 * Somebody with eight projects works in one of them; re-opening the same three headings on every
 * visit is the sort of small tax that makes a sidebar feel like it is not listening. Collapsed
 * rather than expanded is stored, so a project created later arrives open.
 */
const STORAGE_KEY = 'kern.tracker.projects.collapsed'
let collapsed = $state<string[]>(read())

function read(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function toggle(id: string) {
  collapsed = collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id]
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed))
  } catch {
    // private browsing and a full quota both land here; the fold still applies to this session
  }
}

/**
 * The rows under one project.
 *
 * Two kinds, and the difference matters: a query row narrows the issue list, a section row opens
 * the project's own page. Components, milestones and cycles are things a team makes and manages —
 * they are pages you work on, not sortings of a list.
 */
type ProjectRow = { id: string; label: string; icon: string } & (
  | { target: TrackerTarget; section?: undefined }
  | { section: ProjectSection; target?: undefined }
)

function rowsFor(project: Project): ProjectRow[] {
  const targets = projectTargets(project.id)
  return [
    { id: 'issues', label: t('nav'), icon: 'square-check-big', target: targets.issues },
    { id: 'components', label: t('planning_components'), icon: 'puzzle', section: 'components' },
    { id: 'milestones', label: t('planning_milestones'), icon: 'flag', section: 'milestones' },
    ...(project.settings.cycles.enabled
      ? [
          {
            id: 'cycles',
            label: t('planning_cycles'),
            icon: 'refresh-cw',
            section: 'cycles' as const,
          },
        ]
      : []),
    { id: 'templates', label: t('template_title'), icon: 'copy', section: 'templates' },
    ...(project.settings.triage.enabled
      ? [{ id: 'triage', label: t('triage_title'), icon: 'inbox', target: targets.triage }]
      : []),
  ]
}

/** Where a row goes, and whether the screen is already showing it. */
const hrefFor = (project: Project, row: ProjectRow) =>
  row.section ? projectSectionHref(slug, project.key, row.section) : trackerHref(slug, row.target)

const isCurrent = (project: Project, row: ProjectRow) =>
  row.section
    ? navigation.pathname === projectSectionHref(slug, project.key, row.section)
    : inTracker && isTrackerTarget(params, row.target)

const menuFor = (project: Project): MenuItem[] => [
  ...(canTracker('create')
    ? [
        {
          type: 'item' as const,
          id: 'new-issue',
          label: t('new_issue'),
          icon: 'plus',
          // the list it filters stays underneath, and the dialog opens on that project
          href: `${trackerHref(slug, projectTargets(project.id).issues)}&new=1&project=${project.id}`,
        },
      ]
    : []),
  ...(canManage
    ? [
        { type: 'separator' as const },
        {
          type: 'item' as const,
          id: 'repeating',
          label: t('settings_repeating'),
          icon: 'refresh-cw',
          href: projectSettingsHref(slug, 'repeating', project.id),
        },
        {
          type: 'item' as const,
          id: 'settings',
          label: t('project_settings'),
          icon: 'settings',
          href: projectSettingsHref(slug, 'projects', project.id),
        },
      ]
    : []),
]
</script>

<SidebarGroup title={t('projects_yours')} count={projects.length || null}>
  {#snippet trailing()}
    {#if canManage}
      <IconButton
        icon="plus"
        label={t('project_new')}
        size={22}
        onclick={() => oncreate?.()}
        data-testid="sidebar-new-project"
      />
    {/if}
  {/snippet}

  {#if projectsQuery.isPending}
    <div class="loading">
      {#each [1, 2, 3] as row (row)}<Skeleton class="h-[26px] w-full" />{/each}
    </div>
  {:else if projectsQuery.isError}
    <!-- Not `projects_empty_hint`: the sidebar is on every screen, so telling somebody with a
         dozen projects to "make the first one" is the whole product looking empty at once. -->
    <div class="failed">
      <p>{t('projects_failed')}</p>
      <Button size="xs" variant="ghost" onclick={() => void projectsQuery.refetch()}>
        {t('common.retry')}
      </Button>
    </div>
  {:else if !projects.length}
    <p class="none">{t('projects_empty_hint')}</p>
  {:else}
    {#each projects as project (project.id)}
      {@const open = !collapsed.includes(project.id)}
      {@const menu = menuFor(project)}
      <div class="prow">
        <SidebarPill
          label={project.name}
          color={projectColor(project)}
          aria-expanded={open}
          onclick={() => toggle(project.id)}
          title="{project.key} · {project.name}"
          data-testid="sidebar-project"
          data-project={project.key}
        />
        {#if menu.length}
          <DropdownMenu items={menu} align="end">
            {#snippet trigger(props)}
              <IconButton
                {...props}
                icon="ellipsis"
                size={22}
                class="pmenu"
                label={t('project_actions', { name: project.name })}
              />
            {/snippet}
          </DropdownMenu>
        {/if}
      </div>
      {#if open}
        {#each rowsFor(project) as row (row.id)}
          <SidebarItem
            label={row.label}
            icon={row.icon}
            indent={1}
            href={hrefFor(project, row)}
            active={isCurrent(project, row)}
            badge={row.id === 'issues' && project.openIssueCount ? formatCount(project.openIssueCount) : null}
            data-testid="project-{row.id}"
            data-project={project.key}
          />
        {/each}
      {/if}
    {/each}
  {/if}
</SidebarGroup>

<style>
/* The pill hugs its name (DESIGN.md 2.3) and the menu sits at the row's end regardless. */
.prow {
  display: flex;
  align-items: center;
  gap: 4px;
}
.prow :global(.kspill) {
  min-width: 0;
  max-width: calc(100% - 26px);
}
.prow :global(.pmenu) {
  margin-inline-start: auto;
}
/* A sidebar has no room for an illustrated empty state; one quiet line says the same thing. */
.none {
  margin: 2px 10px 6px;
  font-size: 12.5px;
  color: var(--kern-ink-330);
}
.failed {
  display: grid;
  justify-items: start;
  gap: 4px;
  margin: 2px 10px 6px;
  font-size: 12.5px;
  color: var(--kern-ink-600);
}
.failed p {
  margin: 0;
}
.loading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 2px;
}
</style>
