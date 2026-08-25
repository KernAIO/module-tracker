<script lang="ts">
import { navigation, SidebarGroup, SidebarItem } from '@kernhq/ui'
import { t } from '../i18n.js'
import { isTrackerTarget, type TrackerTarget, trackerHref } from '../nav.js'
import SidebarProjects from './SidebarProjects.svelte'
import SidebarViews from './SidebarViews.svelte'

/**
 * The tracker, in the application sidebar (DESIGN.md 2.3).
 *
 * The rail switches modules and the sidebar holds the one you are in, so this is the tracker's own
 * navigation: what you look at, the queries somebody named, and the projects with the ways each of
 * them is planned. Every row is a link to a query the issues screen reads out of the URL — no row
 * puts the page into a state that cannot be linked to, shared or gone back from.
 *
 * The control strip above it is `TrackerControls`, contributed separately so the shell can place
 * the two independently.
 */
interface Props {
  workspaceSlug: string
}
let { workspaceSlug }: Props = $props()

const slug = $derived(workspaceSlug)
const params = $derived(new URLSearchParams(navigation.search))
const inTracker = $derived(navigation.pathname === `/${slug}/tracker`)

/** Saving a view or making a project is a parameter on the page you are on, not a jump elsewhere. */
function ask(flag: string) {
  /**
   * Built from `navigation` rather than the router's URL object: a module cannot read `$app/state`,
   * and it does not need an absolute URL to ask the shell to go somewhere.
   */
  const path = inTracker ? navigation.pathname : `/${workspaceSlug}/tracker`
  const params = new URLSearchParams(inTracker ? navigation.search : {})
  params.set(flag, '1')
  void navigation.go(`${path}?${params.toString()}`, { keepFocus: true, noScroll: true })
}

/** How the whole workspace's work is looked at, before any one project's. */
const rows: { id: string; label: () => string; icon: string; target: TrackerTarget }[] = [
  { id: 'mine', label: () => t('cmd_my_issues'), icon: 'circle-user', target: { preset: 'assigned' } },
  { id: 'all', label: () => t('all_issues'), icon: 'square-check-big', target: {} },
  {
    id: 'projects',
    label: () => t('all_projects'),
    icon: 'layout-grid',
    target: { group: 'project' },
  },
]
</script>

<div class="tsb">
  <SidebarGroup title={t('title')}>
    {#each rows as row (row.id)}
      <SidebarItem
        label={row.label()}
        icon={row.icon}
        href={trackerHref(slug, row.target)}
        active={inTracker && isTrackerTarget(params, row.target)}
        data-testid="tracker-nav-{row.id}"
      />
    {/each}
    <SidebarItem
      label={t('reports_title')}
      icon="chart-line"
      href="/{slug}/tracker/reports"
      active={navigation.pathname === `/${slug}/tracker/reports`}
    />
  </SidebarGroup>

  <SidebarViews onsave={() => ask('save')} />
  <SidebarProjects oncreate={() => ask('new_project')} />
</div>

<style>
.tsb {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
/* DESIGN.md 2.3 control strip: the primary action takes the row, the menu takes what is left. */
.controls {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 12px 4px;
  flex: none;
}
.controls :global(.cta) {
  flex: 1;
  min-width: 0;
  height: 34px;
}
</style>
