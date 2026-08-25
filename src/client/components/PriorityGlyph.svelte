<script lang="ts">
import { PRIORITY_BAR_GEOMETRY, type Priority, priorityBars } from '../index.js'

/**
 * The priority glyph (DESIGN.md 3.0): three rising bars, lit from the left. Urgent inverts into a
 * filled red box so it reads at a glance in a dense list; everything else is drawn on the paper.
 */
interface Props {
  priority: Priority
  size?: number
  label?: string | null
}
let { priority, size = 16, label = null }: Props = $props()
const bars = $derived(priorityBars(priority))
const urgent = $derived(priority === 'urgent')
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  class="kpg"
  role={label ? 'img' : 'presentation'}
  aria-label={label ?? undefined}
  aria-hidden={label ? undefined : 'true'}
>
  {#if urgent}
    <rect x="0" y="0" width="16" height="16" rx="4" fill="var(--kern-danger)" />
  {/if}
  {#each PRIORITY_BAR_GEOMETRY as bar, i (bar.x)}
    <rect
      x={bar.x}
      y={bar.y}
      width="3"
      height={bar.height}
      rx="1"
      fill={urgent
        ? 'var(--kern-ink-inverse)'
        : bars[i]
          ? 'var(--kern-ink-580)'
          : 'var(--kern-priority-off)'}
    />
  {/each}
</svg>

<style>
  .kpg {
    flex: none;
    display: block;
  }
</style>
