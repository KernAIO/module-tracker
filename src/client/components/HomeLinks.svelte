<script lang="ts">
import { navigation, SidebarGroup, SidebarItem } from '@kernhq/ui'
import { t } from '../i18n.js'
import { trackerHref } from '../nav.js'

/**
 * What the tracker puts on the home sidebar.
 *
 * These three rows lived in the application layout, which meant a workspace with the tracker
 * switched off still saw them and still linked into it. They are the tracker's presets — real
 * queries the issues screen reads out of the URL — so they belong to the tracker, and appear only
 * when it is enabled and the reader may see issues.
 */
interface Props {
  workspaceSlug: string
}
let { workspaceSlug }: Props = $props()

const params = $derived(new URLSearchParams(navigation.search))
const inTracker = $derived(navigation.pathname === `/${workspaceSlug}/tracker`)

const rows = [
  { preset: 'assigned', icon: 'circle-user', label: () => t('preset_assigned') },
  { preset: 'created', icon: 'square-pen', label: () => t('preset_created') },
  { preset: 'subscribed', icon: 'eye', label: () => t('preset_subscribed') },
] as const
</script>

<SidebarGroup title={t('title')}>
  {#each rows as row (row.preset)}
    <SidebarItem
      label={row.label()}
      icon={row.icon}
      href={trackerHref(workspaceSlug, { preset: row.preset })}
      active={inTracker && params.get('preset') === row.preset}
    />
  {/each}
</SidebarGroup>
