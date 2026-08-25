<script lang="ts">
import { EmptyState } from '@kernhq/ui'
import { getTrackerCatalogue } from '../context.svelte.js'
import { t } from '../i18n.js'
import { type GroupBy, type GroupKey, groupIssues, type Issue } from '../index.js'
import { describeGroup } from '../labels.js'
import GroupHeader from './GroupHeader.svelte'
import IssueRow from './IssueRow.svelte'

/**
 * The issues list (DESIGN.md 3.2).
 *
 * Group headings sit flush under the toolbar and stick while you scroll; empty groups are hidden.
 * Rows are real buttons, so tabbing and screen readers work without any extra wiring, and the page
 * forwards j/k/x/Enter here through `handleKey` so the keyboard works before anything has focus.
 */
interface Props {
  issues: Issue[]
  /** a built-in group key or `cf.<key>` */
  groupBy: string
  selection: Set<string>
  loading?: boolean
  onopen: (issue: Issue) => void
  onselect: (issue: Issue) => void
  oncreate?: (groupKey: GroupKey) => void
}
let { issues, groupBy, selection, loading = false, onopen, onselect, oncreate }: Props = $props()

const cat = getTrackerCatalogue()

let collapsed = $state<string[]>([])
let cursor = $state(0)
let listEl = $state<HTMLDivElement | null>(null)

const groups = $derived(
  groupIssues(issues, groupBy, {
    statusOrder: cat.statusOrder,
    statusCategory: cat.statusCategory,
    order: (_by, key) => {
      const i = cat.projects.findIndex((p) => p.id === key)
      return i < 0 ? 500 : i
    },
  }),
)

const keyId = (key: GroupKey) => key ?? '__none__'
const isCollapsed = (key: GroupKey) => collapsed.includes(keyId(key))

/** Rows in visual order, so the cursor moves the way the eye does. */
const visible = $derived(groups.filter((g) => !isCollapsed(g.key)).flatMap((g) => g.items))
const indexOf = $derived(new Map(visible.map((issue, i) => [issue.id, i])))

function toggleGroup(key: GroupKey) {
  const id = keyId(key)
  collapsed = collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id]
}

function move(delta: number) {
  if (visible.length === 0) return
  cursor = Math.max(0, Math.min(visible.length - 1, cursor + delta))
  const key = visible[cursor]?.key
  // rows are looked up by key rather than held in an array of refs: groups collapse and the query
  // changes underneath the cursor, and a stale ref would focus a row that is no longer there
  if (key) listEl?.querySelector<HTMLButtonElement>(`[data-issue-key="${CSS.escape(key)}"]`)?.focus()
}

/**
 * Page-level keys for the list. Returns true when the event was consumed, so the page can leave
 * everything else alone.
 */
export function handleKey(event: KeyboardEvent): boolean {
  const current = visible[cursor]
  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      move(1)
      return true
    case 'k':
    case 'ArrowUp':
      move(-1)
      return true
    case 'x':
      if (!current) return false
      onselect(current)
      return true
    case 'Enter':
      if (!current) return false
      onopen(current)
      return true
    default:
      return false
  }
}

// keep the cursor inside the list when filtering or grouping changes the rows underneath it
$effect(() => {
  if (cursor > visible.length - 1) cursor = Math.max(0, visible.length - 1)
})
</script>

<div class="klist" bind:this={listEl}>
  {#if groups.length === 0}
    <div class="empty">
      <EmptyState
        icon="square-check-big"
        title={loading ? t('common.loading') : t('empty_title')}
        description={loading ? undefined : t('empty_body')}
      />
    </div>
  {:else}
    {#each groups as group (keyId(group.key))}
      {@const described = describeGroup(group.key, groupBy, cat)}
      <section>
        <GroupHeader
          label={described.label}
          badge={described.badge}
          count={group.items.length}
          estimate={group.estimate}
          open={!isCollapsed(group.key)}
          onToggle={() => toggleGroup(group.key)}
          onAdd={oncreate ? () => oncreate(group.key) : undefined}
        />
        {#if !isCollapsed(group.key)}
          {#each group.items as issue (issue.id)}
            {@const index = indexOf.get(issue.id) ?? 0}
            <IssueRow
              {issue}
              selected={selection.has(issue.id)}
              active={index === cursor}
              onopen={(i) => {
                cursor = index
                onopen(i)
              }}
              ontoggle={(i) => {
                cursor = index
                onselect(i)
              }}
            />
          {/each}
        {/if}
      </section>
    {/each}
  {/if}
</div>

<style>
  .klist {
    padding-bottom: 40px;
  }
  .empty {
    padding: 40px 28px;
  }
</style>
