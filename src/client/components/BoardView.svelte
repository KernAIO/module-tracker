<script lang="ts">
import { Icon } from '@kernhq/ui'
import { dndzone, SHADOW_ITEM_MARKER_PROPERTY_NAME } from 'svelte-dnd-action'
import { t } from '../i18n.js'
import { byRank, type Issue, type StatusInfo, statusStyle } from '../index.js'
import BoardCard from './BoardCard.svelte'
import StatusIcon from './StatusIcon.svelte'

/**
 * The board (DESIGN.md 3.3).
 *
 * One column per value of whatever the board is grouped by — a workflow status by default, or a
 * custom field's options — each headed by a 2px rule that starts as a stub of the column's colour
 * and fades to a hairline. Cards are dragged between columns with svelte-dnd-action; dropping one
 * reports the column it landed in and the neighbours it landed between, so the page can apply
 * whatever that column means and the new rank in one go.
 *
 * The board does not know what a column *is*: the page says how to read a card's column and what a
 * drop means. That is what lets the same board group by status and by Severity without a second
 * implementation.
 *
 * A WIP limit is shown as `used/limit` and turns red when a column is over it. It warns rather than
 * refuses: a hard block just makes people rename columns.
 */
export interface BoardColumnInfo {
  id: string
  name: string
  /** the colour of the header rule; a status derives one, a field option carries its own */
  color: string
  /** present only for a status column, which draws its glyph */
  status?: StatusInfo
}

interface Props {
  issues: Issue[]
  columns: BoardColumnInfo[]
  /** which column a card belongs in — the page decides, because it knows the grouping */
  columnOf: (issue: Issue) => string[]
  wipLimits?: Record<string, number | undefined>
  /** false when the viewer may not move work between statuses; cards stay readable, just not draggable */
  draggable?: boolean
  onopen: (issue: Issue) => void
  onmove: (issue: Issue, toColumnId: string, afterId: string | null, beforeId: string | null) => void
  oncreate?: (columnId: string) => void
}
let {
  issues,
  columns,
  columnOf,
  wipLimits = {},
  draggable = true,
  onopen,
  onmove,
  oncreate,
}: Props = $props()

const FLIP = 160

type Lane = { column: BoardColumnInfo; items: Issue[] }

/**
 * `$state.raw` matters here: the drag library tracks items by identity, and a deep-reactive proxy
 * hands it a different object every read, which it reads as an endless stream of changes.
 */
let lanes = $state.raw<Lane[]>([])
let dragging = $state(false)

const replaceLane = (index: number, items: Issue[]) => {
  lanes = lanes.map((lane, i) => (i === index ? { column: lane.column, items } : lane))
}

// mirror the query into local lists the drag library can reorder, but leave them alone mid-drag
$effect(() => {
  if (dragging) return
  const sorted = [...issues].sort(byRank)
  lanes = columns.map((column) => ({
    column,
    items: sorted.filter((issue) => columnOf(issue).includes(column.id)),
  }))
})

const isShadow = (issue: Issue) =>
  (issue as unknown as Record<string, unknown>)[SHADOW_ITEM_MARKER_PROPERTY_NAME] === true

function consider(index: number, event: CustomEvent<{ items: Issue[] }>) {
  dragging = true
  replaceLane(index, event.detail.items)
}

function finalize(index: number, event: CustomEvent<{ items: Issue[]; info: { id: string } }>) {
  dragging = false
  const lane = lanes[index]
  if (!lane) return
  const items = event.detail.items
  replaceLane(index, items)

  const at = items.findIndex((i) => i.id === event.detail.info.id)
  const moved = items[at]
  // the drop reports on both the source and the target lane; only the target holds the card
  if (!moved) return
  onmove(moved, lane.column.id, items[at - 1]?.id ?? null, items[at + 1]?.id ?? null)
}

const laneRule = (column: BoardColumnInfo) =>
  `linear-gradient(to var(--kern-lane-dir, right), ${column.color} 0 34px, var(--kern-border) 34px)`
</script>

<div class="kboard" data-testid="board">
  {#each lanes as lane, index (lane.column.id)}
    {@const limit = wipLimits[lane.column.id]}
    {@const over = limit !== undefined && lane.items.length > limit}
    <section class="col" data-column={lane.column.id}>
      <header class="head">
        {#if lane.column.status}
          <StatusIcon
            category={lane.column.status.category}
            statusId={lane.column.status.id}
            name={lane.column.status.name}
            size={15}
          />
        {:else}
          <!-- A field's value has no glyph of its own, so the column's colour is the whole cue. -->
          <span class="swatch" style:background={lane.column.color}></span>
        {/if}
        <h2 class="name">{lane.column.name}</h2>
        <span class="count" class:over title={over ? t('wip_exceeded') : undefined}>
          {limit === undefined ? lane.items.length : `${lane.items.length}/${limit}`}
        </span>
        <span class="sp"></span>
        {#if oncreate}
          <button
            type="button"
            class="add"
            aria-label={t('new_issue')}
            onclick={() => oncreate(lane.column.id)}
          >
            <Icon name="plus" size={13} strokeWidth={1.9} />
          </button>
        {/if}
      </header>
      <div class="rule" style:background={laneRule(lane.column)}></div>

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="stack"
        use:dndzone={{
          items: lane.items,
          flipDurationMs: FLIP,
          type: 'tracker-issues',
          dragDisabled: !draggable,
          dropTargetStyle: {},
        }}
        onconsider={(e) => consider(index, e)}
        onfinalize={(e) => finalize(index, e)}
      >
        {#each lane.items as issue (issue.id)}
          <div class="slot" class:shadow={isShadow(issue)}>
            <BoardCard {issue} {onopen} />
          </div>
        {/each}
      </div>
    </section>
  {/each}
</div>

<style>
  .kboard {
    display: flex;
    align-items: flex-start;
    gap: 20px;
    padding: 22px 28px 30px;
    overflow: auto;
    height: 100%;
  }
  :global([dir='rtl']) .kboard {
    --kern-lane-dir: left;
  }
  .col {
    width: var(--kern-board-col-w);
    flex: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 30px;
  }
  .name {
    margin: 0;
    font-size: 13.5px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--kern-ink-900);
    white-space: nowrap;
  }
  .count {
    font-family: var(--kern-font-mono);
    font-size: 11.5px;
    letter-spacing: -0.01em;
    color: var(--kern-ink-250);
  }
  .count.over {
    color: var(--kern-danger);
    font-weight: 500;
  }
  .sp {
    flex: 1;
  }
  .add {
    width: 22px;
    height: 22px;
    border-radius: var(--kern-r-md);
    display: grid;
    place-items: center;
    color: var(--kern-ink-250);
  }
  .add:hover {
    background: var(--kern-surface-hover);
    color: var(--kern-ink-900);
  }
  .swatch {
    width: 9px;
    height: 9px;
    border-radius: 3px;
    flex: none;
  }
  .rule {
    height: 2px;
    border-radius: 1px;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 14px;
    min-height: 80px;
    padding-bottom: 4px;
  }
  .slot.shadow {
    opacity: 0.35;
  }
  @media (max-width: 768px) {
    .kboard {
      padding: 16px;
      gap: 14px;
    }
  }
</style>
