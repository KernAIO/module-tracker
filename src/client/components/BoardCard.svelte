<script lang="ts">
import { Avatar, Icon, realtime } from '@kernhq/ui'
import { getTrackerCatalogue } from '../context.svelte.js'
import { t } from '../i18n.js'
import { formatDuration, type Issue } from '../index.js'
import { estimateLabel, priorityLabel } from '../labels.js'
import DueDate from './DueDate.svelte'
import PriorityGlyph from './PriorityGlyph.svelte'
import StatusIcon from './StatusIcon.svelte'

/**
 * A board card (DESIGN.md 3.3): status and key on top with the assignee on the far side, the title,
 * a row of chips for the properties worth seeing without opening anything, and a footer of numbers.
 * The comment count disappears when there are no comments rather than showing a zero.
 */
interface Props {
  issue: Issue
  onopen: (issue: Issue) => void
}
let { issue, onopen }: Props = $props()

const cat = getTrackerCatalogue()
const project = $derived(cat.project(issue.projectId))
const status = $derived(cat.status(issue.statusId))
const milestone = $derived(cat.milestone(issue.milestoneId))
const assignee = $derived(cat.person(issue.assigneeIds[0]))
const online = $derived(assignee ? realtime.online.has(assignee.id) : false)
</script>

<article class="kcard" data-testid="board-card" data-issue-key={issue.key}>
  <button type="button" class="body" onclick={() => onopen(issue)}>
    <span class="top">
      <StatusIcon
        category={issue.statusCategory}
        statusId={issue.statusId}
        name={status?.name}
        size={15}
        label={status?.name}
      />
      <span class="key">{issue.key}</span>
      <span class="sp"></span>
      {#if assignee}
        <span class="dot" class:on={online}></span>
        <Avatar name={assignee.name} src={assignee.avatarUrl} id={assignee.id} size={22} />
      {/if}
    </span>

    <span class="title">{issue.title}</span>

    <span class="chips">
      {#if issue.priority !== 'none'}
        <span class="chip pri" title={priorityLabel(issue.priority)}>
          <PriorityGlyph priority={issue.priority} size={14} />
        </span>
      {/if}
      {#if project}
        <span class="chip">
          <Icon name="diamond" size={12} strokeWidth={1.7} />
          <span class="chip-t">{project.name}</span>
        </span>
      {/if}
      {#if milestone}
        <span class="chip">
          <Icon name="flag" size={12} strokeWidth={1.7} />
          <span class="chip-t">{milestone.name}</span>
        </span>
      {/if}
      {#if issue.dueDate}
        <span class="chip"><DueDate date={issue.dueDate} /></span>
      {/if}
    </span>
  </button>

  <footer class="foot">
    <span class="stat"><Icon name="clock" size={13} strokeWidth={1.6} />{formatDuration(issue.timeSpentSec)}</span>
    {#if issue.estimate !== null}
      <span class="stat">{estimateLabel(issue.estimate, issue.estimateUnit)}</span>
    {/if}
    <span class="sp"></span>
    {#if issue.commentCount > 0}
      <span class="stat">
        <Icon name="message-circle" size={13} strokeWidth={1.6} />{issue.commentCount}
      </span>
    {/if}
  </footer>
</article>

<style>
  .kcard {
    background: var(--kern-surface-raised);
    border: 1px solid var(--kern-border);
    border-radius: var(--kern-r-card);
    overflow: hidden;
    transition: border-color 80ms;
  }
  .kcard:hover {
    border-color: var(--kern-border-hover);
  }
  .body {
    display: block;
    width: 100%;
    padding: 13px 14px 14px;
    text-align: start;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .key {
    font-family: var(--kern-font-mono);
    font-size: 11.5px;
    letter-spacing: -0.01em;
    color: var(--kern-ink-250);
  }
  .sp {
    flex: 1;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: var(--kern-r-full);
    background: var(--kern-success);
    opacity: 0;
    flex: none;
  }
  .dot.on {
    opacity: 1;
  }
  .title {
    display: block;
    margin-top: 9px;
    font-size: 14px;
    line-height: 1.42;
    letter-spacing: -0.005em;
    color: var(--kern-ink-900);
    text-wrap: pretty;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 10px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 8px;
    border-radius: var(--kern-r-md);
    background: var(--kern-surface-chip);
    color: var(--kern-ink-580);
    font-size: 12.5px;
    white-space: nowrap;
  }
  .chip.pri {
    padding: 0 7px;
  }
  .chip-t {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 38px;
    padding: 0 14px;
    border-top: 1px solid var(--kern-surface-chip);
    font-family: var(--kern-font-mono);
    font-size: 11.5px;
    letter-spacing: -0.01em;
    color: var(--kern-ink-300);
  }
  .stat {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
</style>
