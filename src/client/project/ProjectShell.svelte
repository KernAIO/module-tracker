<script lang="ts">
import { EmptyState, PageHeader, Skeleton, session } from '@kernhq/ui'
import type { Snippet } from 'svelte'
import { t } from '../i18n.js'
import type { Project } from '../index.js'
import { projectTargets, trackerHref } from '../nav.js'

/**
 * The frame every one of a project's pages shares.
 *
 * Each of them is its own screen — components, milestones, cycles, templates — rather than tabs
 * over one, because they are different work: you come to the milestones page to see where a release
 * stands, and to the components page to name a part of the system. What they share is how you know
 * where you are, and the way back to the work itself (DESIGN.md 2.4).
 */
interface Props {
  project: Project | null
  pending: boolean
  slug: string
  /** what the URL asked for, so a stale link can say what it was looking for */
  projectKey: string
  /** the page's own title, e.g. "Milestones" */
  title: string
  /** the mono line under it: what this page counts */
  subtitle?: string | null
  /** the page's primary action, shown once the project is known */
  headerActions?: Snippet
  children: Snippet
}
let { project, pending, slug, projectKey, title, subtitle = null, headerActions, children }: Props = $props()

const workspaceName = $derived(session.workspaces.find((w) => w.slug === slug)?.name ?? '')
</script>

<svelte:head><title>{title} · {project?.name ?? ''} · Kern</title></svelte:head>

<div class="kproj">
  <PageHeader
    crumbs={[
      { label: workspaceName },
      { label: t('title'), href: `/${slug}/tracker` },
      ...(project
        ? [{ label: project.name, href: trackerHref(slug, projectTargets(project.id).issues) }]
        : []),
    ]}
    {title}
    subtitle={project ? subtitle : null}
  >
    {#snippet actions()}
      {#if project && headerActions}{@render headerActions()}{/if}
    {/snippet}
  </PageHeader>

  <div class="body">
    {#if pending}
      <div class="load">
        {#each [1, 2, 3] as row (row)}<Skeleton class="h-[76px] w-full" />{/each}
      </div>
    {:else if !project}
      <EmptyState
        icon="folder"
        title={t('project_unknown', { key: projectKey })}
        description={t('project_unknown_hint')}
      />
    {:else}
      {@render children()}
    {/if}
  </div>
</div>

<style>
.kproj {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
/* The gutters the issue list uses (DESIGN.md 2.4), and the full width with them: a project's pages
   sit in the same frame as its work, and a column capped mid-screen reads as a page that failed to
   load the rest. */
.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 28px 44px;
  width: 100%;
}
.load {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
