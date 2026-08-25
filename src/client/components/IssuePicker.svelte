<script lang="ts">
import { Spinner } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { Issue } from '../index.js'
import { trackerKeys } from '../query.js'
import StatusIcon from './StatusIcon.svelte'

/**
 * Find an issue by key or title.
 *
 * Searching goes through KQL (`text ~ "…"`), the same reader the query box uses, so what is
 * matchable here is exactly what is matchable there — one search behaviour, not two.
 */
interface Props {
  workspaceId: string
  projectId?: string | null
  /** never offer these — an issue cannot block or parent itself */
  exclude?: string[]
  placeholder?: string
  onpick: (issue: Issue) => void
  oncancel?: () => void
}
let { workspaceId, projectId = null, exclude = [], placeholder, onpick, oncancel }: Props = $props()

let term = $state('')
let active = $state(0)
let box = $state<HTMLInputElement | null>(null)

/** Quote for KQL: a title with a `"` in it must not end the string early. */
const quoted = $derived(term.trim().replace(/["\\]/g, '\\$&'))

const results = createQuery(() => ({
  queryKey: trackerKeys.issues(workspaceId, `picker:${projectId ?? 'all'}:${quoted}`),
  queryFn: () =>
    api.issues.query({
      workspaceId,
      kql: `text ~ "${quoted}"`,
      ...(projectId ? { projectIds: [projectId] } : {}),
      limit: 8,
      includeArchived: false,
      include: { total: false, groupCounts: false, full: false },
    }),
  enabled: quoted.length >= 2,
}))

const api = getTrackerApi()
const excluded = $derived(new Set(exclude))
const items = $derived((results.data?.items ?? []).filter((i) => !excluded.has(i.id)))

function onkeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    active = items.length ? (active + 1) % items.length : 0
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    active = items.length ? (active - 1 + items.length) % items.length : 0
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const chosen = items[active]
    if (chosen) onpick(chosen)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    oncancel?.()
  }
}

$effect(() => {
  box?.focus()
})
</script>

<div class="picker">
  <input
    bind:this={box}
    bind:value={term}
    type="search"
    placeholder={placeholder ?? t('pick_issue')}
    aria-label={placeholder ?? t('pick_issue')}
    data-testid="issue-picker"
    {onkeydown}
    oninput={() => (active = 0)}
  />
  {#if quoted.length >= 2}
    <ul class="results" role="listbox">
      {#if results.isPending}
        <li class="state"><Spinner size={14} /></li>
      {:else if !items.length}
        <li class="state">{t('pick_issue_none')}</li>
      {:else}
        {#each items as issue, i (issue.id)}
          <li>
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              class:active={i === active}
              onclick={() => onpick(issue)}
              onmouseenter={() => (active = i)}
            >
              <StatusIcon category={issue.statusCategory} statusId={issue.statusId} size={13} />
              <span class="ikey">{issue.key}</span>
              <span class="ititle">{issue.title}</span>
            </button>
          </li>
        {/each}
      {/if}
    </ul>
  {/if}
</div>

<style>
.picker {
  position: relative;
}
input {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-sm);
  background: var(--kern-surface);
  color: inherit;
  font: inherit;
  font-size: 13px;
}
input:focus-visible {
  outline: none;
  border-color: var(--kern-accent);
  box-shadow: none;
}
.results {
  position: absolute;
  inset-inline: 0;
  top: calc(100% + 4px);
  z-index: 20;
  max-height: 220px;
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-sm);
  background: var(--kern-surface);
  box-shadow: var(--kern-shadow-popover);
}
.results button {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: var(--kern-r-sm);
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: start;
  cursor: pointer;
}
.results button.active {
  background: var(--kern-surface-active);
}
.ikey {
  font-family: var(--kern-font-mono);
  font-size: 12px;
  color: var(--kern-ink-350);
}
.ititle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.state {
  padding: 6px;
  font-size: 12px;
  color: var(--kern-ink-350);
}
</style>
