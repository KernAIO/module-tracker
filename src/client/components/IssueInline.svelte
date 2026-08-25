<script lang="ts">
import { navigation, Skeleton, session } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { statusStyle } from '../index.js'
import { trackerKeys } from '../query.js'
import StatusIcon from './StatusIcon.svelte'

/**
 * How an issue appears when another module refers to one: a chat message that mentions KRN-12, a
 * document that embeds it, a search result. Registered as the tracker's object presenter, so those
 * surfaces do not need to know anything about issues beyond the id.
 */
interface Props {
  /** issue id or key */
  id: string
  workspaceId?: string
}
let { id, workspaceId }: Props = $props()

const api = getTrackerApi()
const slug = $derived(navigation.workspaceSlug)
const wsId = $derived(workspaceId ?? session.workspaces.find((w) => w.slug === slug)?.id ?? '')
const isKey = $derived(/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(id))

const issueQuery = createQuery(() => ({
  queryKey: trackerKeys.issue(wsId, id),
  queryFn: () =>
    isKey
      ? api.issues.getByKey({ workspaceId: wsId, key: id })
      : api.issues.get({ workspaceId: wsId, issueId: id }),
  enabled: Boolean(wsId),
}))
const issue = $derived(issueQuery.data ?? null)
</script>

{#if !issue}
  <span class="kinline loading"><Skeleton class="h-[14px] w-[140px]" /></span>
{:else}
  <a class="kinline" href="/{slug}/tracker?issue={issue.key}" style:--tint={statusStyle(issue.statusCategory, issue.statusId).tint}>
    <StatusIcon category={issue.statusCategory} statusId={issue.statusId} size={14} />
    <span class="key">{issue.key}</span>
    <span class="title">{issue.title}</span>
  </a>
{/if}

<style>
  .kinline {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: 2px 7px;
    border-radius: var(--kern-r-md);
    background: var(--tint, var(--kern-surface-chip));
    font-size: 12.5px;
    color: var(--kern-ink-800);
    vertical-align: baseline;
  }
  .kinline:hover {
    color: var(--kern-ink-900);
  }
  .key {
    font-family: var(--kern-font-mono);
    font-size: 11.5px;
    letter-spacing: -0.01em;
    color: var(--kern-ink-350);
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 28ch;
  }
</style>
