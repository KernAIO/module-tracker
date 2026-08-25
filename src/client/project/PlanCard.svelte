<script lang="ts">
import { Icon } from '@kernhq/ui'
import type { Snippet } from 'svelte'

/**
 * A milestone or a cycle, as a card (DESIGN.md 3.5).
 *
 * Both are a stretch of work with a name, a window, something it is aiming at and how far along it
 * is — so they are drawn the same way, and the tone says which state it is in: blue while it is
 * running, green when it is finished, grey while it is still ahead.
 */
export type PlanTone = 'running' | 'done' | 'planned'

interface Props {
  icon: string
  tone: PlanTone
  name: string
  /** the state, in words: "In progress", "Reached", "Upcoming" */
  state: string
  /** the window or the target date, already formatted */
  when?: string | null
  goal?: string | null
  /** how much of it is finished */
  progress?: { done: number; total: number } | null
  meta?: Snippet
  actions?: Snippet
  href?: string
}
let {
  icon,
  tone,
  name,
  state,
  when = null,
  goal = null,
  progress = null,
  meta,
  actions,
  href,
}: Props = $props()

const percent = $derived(
  progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0,
)
</script>

<article class="card t-{tone}" data-testid="plan-card" data-item={name}>
  <header>
    <Icon name={icon} size={16} strokeWidth={1.7} class="flag" />
    {#if href}
      <a class="name" {href}>{name}</a>
    {:else}
      <span class="name">{name}</span>
    {/if}
    <span class="state">{state}</span>
    <span class="sp"></span>
    {#if when}<span class="when">{when}</span>{/if}
    {#if actions}<span class="acts">{@render actions()}</span>{/if}
  </header>

  {#if goal}<p class="goal">{goal}</p>{/if}

  {#if progress}
    <div class="measure">
      <div class="track"><span class="fill" style:width="{percent}%"></span></div>
      <span class="pct">{progress.done}/{progress.total} · {percent}%</span>
    </div>
  {/if}

  {#if meta}<div class="meta">{@render meta()}</div>{/if}
</article>

<style>
/* DESIGN.md 3.5 — white card, 10px radius, 16/18 padding, stacked with a 10px gap. */
.card {
  background: var(--kern-surface-raised);
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-2xl);
  padding: 16px 18px;
}
header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
header :global(.flag) {
  flex: none;
  color: var(--kern-neutral-flag);
}
.t-running header :global(.flag) {
  color: var(--kern-info-bar);
}
.t-done header :global(.flag) {
  color: var(--kern-success-chip);
}
.name {
  font-size: 15px;
  font-weight: 500;
  color: var(--kern-ink-900);
  text-decoration: none;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
a.name:hover {
  text-decoration: underline;
}
.state {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px;
  border-radius: var(--kern-r-md);
  font-size: 12px;
  background: var(--kern-surface-chip);
  color: var(--kern-ink-450);
  white-space: nowrap;
}
.t-running .state {
  background: var(--kern-info-tint);
  color: var(--kern-info);
}
.t-done .state {
  background: var(--kern-success-tint);
  color: var(--kern-success-chip);
}
.sp {
  flex: 1;
}
.when {
  flex: none;
  font-size: 12.5px;
  color: var(--kern-ink-350);
  white-space: nowrap;
}
.acts {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.goal {
  margin: 8px 0 0;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--kern-ink-500);
}
.measure {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
}
.track {
  flex: 1;
  height: 6px;
  border-radius: var(--kern-r-full);
  background: var(--kern-border-strong);
  overflow: hidden;
}
.fill {
  display: block;
  height: 100%;
  border-radius: var(--kern-r-full);
  background: var(--kern-info-bar);
  transition: width var(--kern-dur-fast) var(--kern-ease-out);
}
.t-done .fill {
  background: var(--kern-success-chip);
}
.t-planned .fill {
  background: var(--kern-ink-330);
}
.pct {
  width: 92px;
  text-align: end;
  font-size: 12.5px;
  color: var(--kern-ink-450);
  white-space: nowrap;
}
.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 12px;
}
</style>
