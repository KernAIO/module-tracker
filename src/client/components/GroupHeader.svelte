<script lang="ts">
import { Avatar, Icon } from '@kernhq/ui'
import { getTrackerCatalogue } from '../context.svelte.js'
import { t } from '../i18n.js'
import type { StatusCategory } from '../index.js'
import type { GroupBadge } from '../labels.js'
import { estimateLabel } from '../labels.js'
import PriorityGlyph from './PriorityGlyph.svelte'
import StatusIcon from './StatusIcon.svelte'

/**
 * The heading above each group of issues (DESIGN.md 3.2).
 *
 * The caret is a filled triangle that points right when the group is closed and down when it is
 * open; the badge to its left is whatever the list is grouped by, so grouping by status shows the
 * status glyph and grouping by assignee shows a face.
 */
interface Props {
  label: string
  count: number
  estimate?: number | null
  open?: boolean
  badge?: GroupBadge
  onToggle: () => void
  onAdd?: () => void
}
let { label, count, estimate = null, open = true, badge, onToggle, onAdd }: Props = $props()

/** The unit a sum of estimates is said in, which belongs to the projects in view. */
const cat = getTrackerCatalogue()
</script>

<div class="kgh">
  <button type="button" class="head" aria-expanded={open} onclick={onToggle}>
    <svg class="caret" class:open width="9" height="9" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5l9 7-9 7z" fill="currentColor" />
    </svg>
    {#if badge?.kind === 'status'}
      <StatusIcon category={badge.category as StatusCategory} statusId={badge.id} name={label} size={16} />
    {:else if badge?.kind === 'priority'}
      <PriorityGlyph priority={badge.priority} size={16} />
    {:else if badge?.kind === 'person'}
      <Avatar name={badge.name} src={badge.avatarUrl} id={badge.id} size={16} />
    {:else if badge?.kind === 'colour'}
      <span class="swatch" style:background={badge.color ?? 'var(--kern-ink-330)'}></span>
    {/if}
    <span class="name">{label}</span>
    <span class="count">{count}</span>
  </button>
  <span class="sp"></span>
  {#if estimate !== null && estimate > 0}
    <span class="count">{estimateLabel(estimate, cat.estimateUnit)}</span>
  {/if}
  {#if onAdd}
    <button type="button" class="add" aria-label={t('new_issue')} onclick={onAdd}>
      <Icon name="plus" size={13} strokeWidth={1.9} />
    </button>
  {/if}
</div>

<style>
  .kgh {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 42px;
    padding: 0 28px;
    border-bottom: 1px solid var(--kern-border);
    background: var(--kern-surface-header);
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    text-align: start;
  }
  .caret {
    color: var(--kern-ink-350);
    flex: none;
    transition: transform 0.14s;
  }
  .caret.open {
    transform: rotate(90deg);
  }
  :global([dir='rtl']) .caret {
    transform: rotate(180deg);
  }
  :global([dir='rtl']) .caret.open {
    transform: rotate(90deg);
  }
  .swatch {
    width: 14px;
    height: 14px;
    border-radius: var(--kern-r-xs);
    flex: none;
  }
  .name {
    font-size: 13.5px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--kern-ink-900);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count {
    font-family: var(--kern-font-mono);
    font-size: 11.5px;
    letter-spacing: -0.01em;
    color: var(--kern-ink-250);
    white-space: nowrap;
  }
  .sp {
    flex: 1;
  }
  .add {
    width: 22px;
    height: 22px;
    border-radius: var(--kern-r-sm);
    display: grid;
    place-items: center;
    color: var(--kern-ink-400);
    flex: none;
  }
  .add:hover {
    background: var(--kern-ghost-hover-dark);
  }
  @media (max-width: 768px) {
    .kgh {
      padding: 0 16px;
    }
  }
</style>
