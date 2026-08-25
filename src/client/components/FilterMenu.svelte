<script lang="ts">
import { DropdownMenu, type MenuItem, ToolbarButton } from '@kernhq/ui'
import { getTrackerCatalogue } from '../context.svelte.js'
import type { TrackerFilters } from '../filters.js'
import { t } from '../i18n.js'
import { PRIORITY_GROUP_ORDER, type Priority } from '../index.js'
import { priorityLabel } from '../labels.js'

/**
 * The toolbar's Filter menu (DESIGN.md 2.5).
 *
 * Each section is a set of checkboxes over the workspace's own data, and the result is turned into
 * KQL by `filters.ts`, so what the menu builds and what someone types in the query box are the same
 * language and can be read side by side.
 */
interface Props {
  filters: TrackerFilters
  onchange: (next: TrackerFilters) => void
}
let { filters, onchange }: Props = $props()

const cat = getTrackerCatalogue()

function toggle<K extends keyof TrackerFilters>(key: K, value: string) {
  const current = filters[key] as string[]
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
  onchange({ ...filters, [key]: next })
}

const items = $derived<MenuItem[]>([
  { type: 'label' as const, label: t('group_project') },
  ...cat.projects.map((p) => ({
    type: 'checkbox' as const,
    id: `p-${p.id}`,
    label: p.name,
    checked: filters.projectIds.includes(p.id),
    onCheckedChange: () => toggle('projectIds', p.id),
  })),
  { type: 'separator' as const },
  { type: 'label' as const, label: t('group_status') },
  ...cat.statuses.map((s) => ({
    type: 'checkbox' as const,
    id: `s-${s.id}`,
    label: s.name,
    checked: filters.statusIds.includes(s.id),
    onCheckedChange: () => toggle('statusIds', s.id),
  })),
  { type: 'separator' as const },
  { type: 'label' as const, label: t('group_priority') },
  ...PRIORITY_GROUP_ORDER.map((p: Priority) => ({
    type: 'checkbox' as const,
    id: `pr-${p}`,
    label: priorityLabel(p),
    checked: filters.priorities.includes(p),
    onCheckedChange: () => toggle('priorities', p),
  })),
  { type: 'separator' as const },
  { type: 'label' as const, label: t('group_assignee') },
  ...cat.people.map((person) => ({
    type: 'checkbox' as const,
    id: `a-${person.id}`,
    label: person.name,
    avatar: { id: person.id, name: person.name, src: person.avatarUrl },
    checked: filters.assigneeIds.includes(person.id),
    onCheckedChange: () => toggle('assigneeIds', person.id),
  })),
  { type: 'separator' as const },
  { type: 'label' as const, label: t('group_label') },
  ...cat.labels.map((label) => ({
    type: 'checkbox' as const,
    id: `l-${label.id}`,
    label: label.name,
    checked: filters.labelIds.includes(label.id),
    onCheckedChange: () => toggle('labelIds', label.id),
  })),
])
</script>

<DropdownMenu {items} align="start" class="kfilter-menu">
  {#snippet trigger(props)}
    <!-- the count belongs to the active-filter chip next to this button, not on the button itself -->
    <ToolbarButton {...props} icon="filter" data-testid="filter-button">{t('filter')}</ToolbarButton>
  {/snippet}
</DropdownMenu>

<style>
  :global(.kfilter-menu) {
    max-height: 60vh;
    overflow-y: auto;
  }
</style>
