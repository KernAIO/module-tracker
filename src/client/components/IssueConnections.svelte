<script lang="ts">
import { DropdownMenu, Icon, IconButton, type MenuItem, toast } from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getTrackerApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { Issue, RelationType, StatusCategory } from '../index.js'
import { trackerKeys } from '../query.js'
import IssuePicker from './IssuePicker.svelte'
import StatusIcon from './StatusIcon.svelte'

/**
 * What an issue is connected to: its children, other issues, and pages elsewhere.
 *
 * Three servers with no interface until now. They share one shape — list, add, remove — so they
 * share one component rather than three that drift apart.
 */
interface Props {
  workspaceId: string
  issue: Issue
  canEdit: boolean
  onopen: (key: string) => void
}
let { workspaceId, issue, canEdit, onopen }: Props = $props()

const api = getTrackerApi()
const queryClient = useQueryClient()

type Adding = 'child' | 'relation' | 'link' | null
let adding = $state<Adding>(null)
let relationType = $state<RelationType>('blocks')
let linkUrl = $state('')
let linkTitle = $state('')

const RELATION_LABELS: Record<RelationType, () => string> = {
  blocks: () => t('relation_blocks'),
  blocked_by: () => t('relation_blocked_by'),
  relates: () => t('relation_relates'),
  duplicates: () => t('relation_duplicates'),
  duplicated_by: () => t('relation_duplicated_by'),
  clones: () => t('relation_clones'),
  cloned_by: () => t('relation_cloned_by'),
}

const relationsQuery = createQuery(() => ({
  queryKey: trackerKeys.relations(workspaceId, issue.id),
  queryFn: () => api.issues.relations.list({ workspaceId, issueId: issue.id }),
}))
const linksQuery = createQuery(() => ({
  queryKey: trackerKeys.links(workspaceId, issue.id),
  queryFn: () => api.issues.links.list({ workspaceId, issueId: issue.id }),
}))
const childrenQuery = createQuery(() => ({
  queryKey: trackerKeys.children(workspaceId, issue.id),
  queryFn: () =>
    api.issues.query({
      workspaceId,
      kql: `parent = "${issue.key}"`,
      limit: 100,
      includeArchived: false,
      include: { total: false, groupCounts: false, full: false },
    }),
}))

const relations = $derived(relationsQuery.data ?? [])
const links = $derived(linksQuery.data ?? [])
const children = $derived(childrenQuery.data?.items ?? [])
/** Never offer an issue that is already connected, nor the issue itself. */
const connectedIds = $derived([
  issue.id,
  ...(issue.parentId ? [issue.parentId] : []),
  ...relations.map((r) => r.issue.id),
  ...children.map((c) => c.id),
])

const invalidate = (keys: readonly (readonly unknown[])[]) => {
  for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey })
}
const fail = (error: Error) => toast.error(error.message)

const addRelation = createMutation(() => ({
  mutationFn: (targetIssueId: string) =>
    api.issues.relations.create({ workspaceId, issueId: issue.id, type: relationType, targetIssueId }),
  onSuccess: () => {
    adding = null
    invalidate([trackerKeys.relations(workspaceId, issue.id), trackerKeys.issue(workspaceId, issue.id)])
  },
  onError: fail,
}))

const removeRelation = createMutation(() => ({
  mutationFn: (relationId: string) => api.issues.relations.delete({ workspaceId, relationId }),
  onSuccess: () =>
    invalidate([trackerKeys.relations(workspaceId, issue.id), trackerKeys.issue(workspaceId, issue.id)]),
  onError: fail,
}))

const addChild = createMutation(() => ({
  mutationFn: (childId: string) =>
    api.issues.update({ workspaceId, issueId: childId, patch: { parentId: issue.id } }),
  onSuccess: () => {
    adding = null
    invalidate([trackerKeys.children(workspaceId, issue.id)])
  },
  onError: fail,
}))

const removeChild = createMutation(() => ({
  mutationFn: (childId: string) =>
    api.issues.update({ workspaceId, issueId: childId, patch: { parentId: null } }),
  onSuccess: () => invalidate([trackerKeys.children(workspaceId, issue.id)]),
  onError: fail,
}))

const addLink = createMutation(() => ({
  mutationFn: () =>
    api.issues.links.add({
      workspaceId,
      issueId: issue.id,
      url: linkUrl.trim(),
      ...(linkTitle.trim() ? { title: linkTitle.trim() } : {}),
      kind: 'generic',
    }),
  onSuccess: () => {
    adding = null
    linkUrl = ''
    linkTitle = ''
    invalidate([trackerKeys.links(workspaceId, issue.id)])
  },
  onError: fail,
}))

const removeLink = createMutation(() => ({
  mutationFn: (linkId: string) => api.issues.links.remove({ workspaceId, linkId }),
  onSuccess: () => invalidate([trackerKeys.links(workspaceId, issue.id)]),
  onError: fail,
}))

const relationMenu = $derived<MenuItem[]>(
  (Object.keys(RELATION_LABELS) as RelationType[]).map((type) => ({
    type: 'item' as const,
    id: type,
    label: RELATION_LABELS[type](),
    onSelect: () => {
      relationType = type
      adding = 'relation'
    },
  })),
)

/** Relations read better grouped by kind than as one undifferentiated list. */
const relationGroups = $derived.by(() => {
  const groups = new Map<RelationType, typeof relations>()
  for (const relation of relations)
    groups.set(relation.type, [...(groups.get(relation.type) ?? []), relation])
  return [...groups.entries()]
})

const isHttp = $derived(/^https?:\/\/\S+$/i.test(linkUrl.trim()))
</script>

{#snippet issueLine(
  key: string,
  title: string,
  statusId: string,
  category: StatusCategory,
  remove?: () => void,
)}
  <li>
    <button type="button" class="line" onclick={() => onopen(key)}>
      <StatusIcon {category} {statusId} size={13} />
      <span class="ikey">{key}</span>
      <span class="ititle">{title}</span>
    </button>
    {#if remove && canEdit}
      <IconButton icon="x" size={22} label={t('connection_remove')} onclick={remove} />
    {/if}
  </li>
{/snippet}

<section class="connections">
  <!-- sub-issues -->
  <div class="block">
    <div class="bhead">
      <span class="kern-sublabel">{t('subissues')}</span>
      {#if canEdit}
        <IconButton
          icon="plus"
          size={22}
          label={t('subissue_add')}
          onclick={() => (adding = adding === 'child' ? null : 'child')}
        />
      {/if}
    </div>
    {#if adding === 'child'}
      <IssuePicker
        {workspaceId}
        projectId={issue.projectId}
        exclude={connectedIds}
        placeholder={t('subissue_add')}
        onpick={(picked) => addChild.mutate(picked.id)}
        oncancel={() => (adding = null)}
      />
    {/if}
    {#if children.length}
      <ul>
        {#each children as child (child.id)}
          {@render issueLine(child.key, child.title, child.statusId, child.statusCategory, () =>
            removeChild.mutate(child.id),
          )}
        {/each}
      </ul>
    {:else if adding !== 'child'}
      <p class="empty">{t('subissues_empty')}</p>
    {/if}
  </div>

  <!-- relations -->
  <div class="block">
    <div class="bhead">
      <span class="kern-sublabel">{t('relations')}</span>
      {#if canEdit}
        <DropdownMenu items={relationMenu} align="end">
          {#snippet trigger(props)}
            <IconButton {...props} icon="plus" size={22} label={t('relation_add')} />
          {/snippet}
        </DropdownMenu>
      {/if}
    </div>
    {#if adding === 'relation'}
      <p class="picking">{RELATION_LABELS[relationType]()}</p>
      <IssuePicker
        {workspaceId}
        exclude={connectedIds}
        placeholder={t('relation_add')}
        onpick={(picked) => addRelation.mutate(picked.id)}
        oncancel={() => (adding = null)}
      />
    {/if}
    {#if relationGroups.length}
      {#each relationGroups as [type, group] (type)}
        <p class="gname">{RELATION_LABELS[type]()}</p>
        <ul>
          {#each group as relation (relation.id)}
            {@render issueLine(
              relation.issue.key,
              relation.issue.title,
              relation.issue.statusId,
              relation.issue.statusCategory,
              () => removeRelation.mutate(relation.id),
            )}
          {/each}
        </ul>
      {/each}
    {:else if adding !== 'relation'}
      <p class="empty">{t('relations_empty')}</p>
    {/if}
  </div>

  <!-- external links -->
  <div class="block">
    <div class="bhead">
      <span class="kern-sublabel">{t('links')}</span>
      {#if canEdit}
        <IconButton
          icon="link"
          size={22}
          label={t('link_add')}
          onclick={() => (adding = adding === 'link' ? null : 'link')}
        />
      {/if}
    </div>
    {#if adding === 'link'}
      <form
        class="linkform"
        onsubmit={(e) => {
          e.preventDefault()
          if (isHttp) addLink.mutate()
        }}
      >
        <input
          bind:value={linkUrl}
          type="url"
          placeholder="https://"
          aria-label={t('link_url')}
          data-testid="link-url"
        />
        <input bind:value={linkTitle} type="text" placeholder={t('link_title')} aria-label={t('link_title')} />
        <div class="row">
          <button type="submit" disabled={!isHttp}>{t('common.add')}</button>
          <button type="button" onclick={() => (adding = null)}>{t('common.cancel')}</button>
        </div>
      </form>
    {/if}
    {#if links.length}
      <ul>
        {#each links as link (link.id)}
          <li>
            <a class="line" href={link.url} target="_blank" rel="noreferrer noopener">
              <Icon name="external-link" size={13} strokeWidth={1.8} />
              <span class="ititle">{link.title || link.url}</span>
            </a>
            {#if canEdit}
              <IconButton
                icon="x"
                size={22}
                label={t('connection_remove')}
                onclick={() => removeLink.mutate(link.id)}
              />
            {/if}
          </li>
        {/each}
      </ul>
    {:else if adding !== 'link'}
      <p class="empty">{t('links_empty')}</p>
    {/if}
  </div>
</section>

<style>
.connections {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 16px;
}
.bhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
ul {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
li {
  display: flex;
  align-items: center;
  gap: 4px;
}
.line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  margin-inline-start: -6px;
  border: 0;
  border-radius: var(--kern-r-sm);
  background: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: start;
  text-decoration: none;
  cursor: pointer;
}
.line:hover {
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
.gname,
.picking {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--kern-ink-350);
}
.empty {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--kern-ink-350);
}
.linkform {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
.linkform input {
  padding: 5px 8px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-sm);
  background: var(--kern-surface);
  color: inherit;
  font: inherit;
  font-size: 13px;
}
.linkform input:focus-visible {
  outline: none;
  border-color: var(--kern-accent);
  box-shadow: none;
}
.row {
  display: flex;
  gap: 6px;
}
.row button {
  padding: 3px 10px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-sm);
  background: var(--kern-surface);
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.row button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
