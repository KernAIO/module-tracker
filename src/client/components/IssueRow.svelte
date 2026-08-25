<script lang="ts">
import { Avatar, AvatarStack, Icon } from '@kernhq/ui'
import { getTrackerCatalogue } from '../context.svelte.js'
import { t } from '../i18n.js'
import type { Issue } from '../index.js'
import { estimateLabel } from '../labels.js'
import DueDate from './DueDate.svelte'
import PriorityGlyph from './PriorityGlyph.svelte'
import StatusIcon from './StatusIcon.svelte'

/**
 * One row of the issues list (DESIGN.md 3.2).
 *
 * The grid is fixed so every row lines up down the page: priority, key, status, title, project,
 * estimate, due date, assignee. Selecting swaps the priority cell for a tick, which keeps the
 * columns from shifting when you multi-select.
 */
interface Props {
  issue: Issue
  selected?: boolean
  active?: boolean
  onopen: (issue: Issue) => void
  ontoggle: (issue: Issue, event: MouseEvent | KeyboardEvent) => void
}
let { issue, selected = false, active = false, onopen, ontoggle }: Props = $props()

const cat = getTrackerCatalogue()
const project = $derived(cat.project(issue.projectId))
const status = $derived(cat.status(issue.statusId))
const assignees = $derived(issue.assigneeIds.map((id) => cat.person(id)).filter((p) => p !== undefined))
</script>

<button
  type="button"
  class="krow"
  class:selected
  class:active
  data-testid="issue-row"
  data-issue-key={issue.key}
  aria-current={active ? 'true' : undefined}
  onclick={(e) => (e.metaKey || e.ctrlKey || e.shiftKey ? ontoggle(issue, e) : onopen(issue))}
>
  <span class="cell mark">
    {#if selected}
      <Icon name="check" size={14} strokeWidth={2} />
    {:else}
      <PriorityGlyph priority={issue.priority} size={15} />
    {/if}
  </span>

  <span class="cell key">{issue.key}</span>

  <span class="cell st">
    <StatusIcon
      category={issue.statusCategory}
      statusId={issue.statusId}
      name={status?.name}
      size={15}
      label={status?.name}
    />
  </span>

  <span class="cell title">{issue.title}</span>

  {#if project}
    <span class="cell chip">{project.name}</span>
  {:else}
    <span class="cell"></span>
  {/if}

  <span class="cell est">
    {#if issue.estimate !== null}{estimateLabel(issue.estimate, issue.estimateUnit)}{/if}
  </span>

  <span class="cell due">
    {#if issue.dueDate}<DueDate date={issue.dueDate} />{/if}
  </span>

  <span class="cell people">
    {#if assignees.length === 1}
      <Avatar name={assignees[0]?.name} src={assignees[0]?.avatarUrl} id={assignees[0]?.id} size={22} />
    {:else if assignees.length > 1}
      <AvatarStack people={assignees} size={22} max={2} />
    {/if}
  </span>
</button>

<style>
  .krow {
    display: grid;
    /* the last column is 24px for one avatar and grows for a stack, rather than overlapping the due date */
    grid-template-columns: 18px 62px 18px minmax(0, 1fr) auto auto auto minmax(24px, auto);
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 40px;
    padding: 0 16px;
    border-bottom: 1px solid var(--kern-border-hairline);
    text-align: start;
    transition: background-color 80ms;
  }
  .krow:hover {
    background: var(--kern-surface-raised);
  }
  /* the keyboard cursor is only drawn while the list has focus, so the list has no extra resting state */
  .krow:focus-visible {
    outline: none;
    background: var(--kern-surface-raised);
    box-shadow: inset 2px 0 0 var(--kern-accent);
  }
  :global([dir='rtl']) .krow:focus-visible {
    box-shadow: inset -2px 0 0 var(--kern-accent);
  }
  .krow.selected {
    background: var(--kern-accent-tint);
  }
  .cell {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .mark {
    justify-content: center;
    color: var(--kern-accent-deep);
  }
  .key {
    font-family: var(--kern-font-mono);
    letter-spacing: -0.01em;
    font-size: 13px;
    color: var(--kern-ink-350);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .title {
    font-size: 14px;
    color: var(--kern-ink-800);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
  }
  .chip {
    font-size: 12px;
    padding: 3px 9px;
    border-radius: var(--kern-r-md);
    background: var(--kern-surface-chip);
    color: var(--kern-ink-520);
    white-space: nowrap;
  }
  .est,
  .due {
    font-size: 12.5px;
    color: var(--kern-ink-350);
    white-space: nowrap;
  }
  .people {
    justify-content: flex-end;
  }
  @media (max-width: 768px) {
    .krow {
      grid-template-columns: 18px 58px minmax(0, 1fr) auto minmax(24px, auto);
      padding: 0 12px;
    }
    .st,
    .chip,
    .est {
      display: none;
    }
  }
</style>
