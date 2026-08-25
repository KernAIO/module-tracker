<script lang="ts">
import { Button, DropdownMenu, IconButton, type MenuItem, navigation } from '@kernhq/ui'
import { t } from '../i18n.js'
import { canTracker } from '../permissions.js'

/**
 * The tracker's control strip.
 *
 * A module that owns the sidebar owns the row above it: the shell's ⌘K box steps aside so this can
 * sit where a "New issue" button belongs, rather than being stacked under a second search field.
 * Split out of `TrackerSidebar` so the shell can place the two independently.
 */
interface Props {
  workspaceSlug: string
}
let { workspaceSlug }: Props = $props()

const inTracker = $derived(navigation.pathname === `/${workspaceSlug}/tracker`)
const canCreate = $derived(canTracker('create'))
const canManageProjects = $derived(canTracker('projectManage'))

/**
 * Opening a dialog is a parameter on the page you are on, not a jump to a blank one: raising an
 * issue from a filtered list keeps that list underneath.
 */
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

const createMenu = $derived<MenuItem[]>([
  ...(canCreate
    ? [
        {
          type: 'item' as const,
          id: 'issue',
          label: t('new_issue'),
          icon: 'square-check-big',
          shortcut: ['c'],
          onSelect: () => ask('new'),
        },
      ]
    : []),
  ...(canManageProjects
    ? [
        {
          type: 'item' as const,
          id: 'project',
          label: t('project_new'),
          icon: 'folder',
          onSelect: () => ask('new_project'),
        },
        {
          type: 'item' as const,
          id: 'import',
          label: t('settings_import'),
          icon: 'upload',
          href: `/${workspaceSlug}/settings/tracker/import`,
        },
      ]
    : []),
])
</script>

{#if canCreate || canManageProjects}
  <div class="controls">
    <Button
      icon="plus"
      rounded="xl"
      class="cta"
      onclick={() => ask(canCreate ? 'new' : 'new_project')}
      data-testid="sidebar-new-issue"
    >
      {canCreate ? t('new_issue') : t('project_new')}
    </Button>
    {#if createMenu.length > 1}
      <DropdownMenu items={createMenu} align="end">
        {#snippet trigger(props)}
          <IconButton
            {...props}
            icon="chevron-down"
            label={t('create_more')}
            size={34}
            radius={9}
            variant="outline"
            data-testid="sidebar-create-menu"
          />
        {/snippet}
      </DropdownMenu>
    {/if}
  </div>
{/if}

<style>
  .controls {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .controls :global(.cta) {
    flex: 1;
  }
</style>
